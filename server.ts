// bb-plugin-diffui-bb — the Diffui plugin backend.
//
// Follows the canonical recipe in jjcm/bb docs/diffui-plugin-author-notes.md:
// - settings: Diffui API key (secret), base URL, and the bb project that
//   "Build with bb" dispatches land in.
// - background service "diffui-bridge": the cloud-relay inbound shape (§3.2)
//   — holds an outbound websocket to the Diffui server; build.request frames
//   run the §2 recipe (attachments.upload → threads.spawn with an agent-only
//   brief → threads.open).
// - HTTP POST /build: the direct-browser inbound shape (§3.1) — token auth
//   with experimental_cors for the Diffui web origins (needs bb with
//   jjcm/bb#6, SDK 0.4.9; older hosts simply ignore the option and the web
//   app falls back to the relay).
// - rpc + realtime for the frontend (app.tsx): canvas list, native canvas
//   view, and in-bb Build with bb.
// - agent tools proxied through Diffui's hosted MCP so canvas staging (one
//   prompt node per prompt, one image per slot) stays server-side.
// - @diffui mentions, `bb diffui` CLI, and the status-back loop
//   (thread.idle/failed → Diffui, the slack-bot reply shape).
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DiffuiClient,
  firstJsonBlock,
  fullResBrandImageUrl,
  fullResUrlForThumbUrl,
  thumbUrlForFileUrl,
  type DiffuiCanvasSummary,
  type DiffuiToolCallResult,
} from "./lib/diffui-client.js";
import { parseBuildRequest, runBridge, type BridgeBuildRequest, type BridgeBuildResult } from "./lib/bridge.js";
import { dispatchBuildRequest, type BuildDispatchDeps, type BuildSpawnRecord } from "./lib/build-dispatch.js";
import { CanvasWatchHub } from "./lib/canvas-watch.js";
import { BbFileStore } from "./lib/bb-files.js";

const PLUGIN_VERSION = "0.2.0";
const DEFAULT_BASE_URL = "https://diffui.ai";
const CONFIGURE_HINT =
  "Set apiKey (Diffui → Settings → API keys) with `bb plugin config diffui-bb`, then `bb plugin reload diffui-bb`.";

/** kv key for the status-back loop: thread → the build it implements. */
const spawnRecordKey = (threadId: string) => `bb-thread:${threadId}`;

const canvasDocImageSchema = z.object({
  id: z.string(),
  imageId: z.string(),
  status: z.string(),
  partial: z.boolean(),
  thumbUrl: z.string(),
  fullUrl: z.string(),
});

const canvasDocNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(["prompt", "image"]),
  name: z.string(),
  prompt: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  stackIndex: z.number(),
  generating: z.boolean(),
  images: z.array(canvasDocImageSchema),
});

const canvasRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  agentTarget: z.string(),
  updatedAt: z.string(),
  thumbnails: z.array(z.string()),
  coverThumbnail: z.string(),
  // The size Diffui generated the cover at, so the browse grid can reserve the
  // exact box instead of measuring the decoded image.
  coverThumbnailWidth: z.number(),
  coverThumbnailHeight: z.number(),
  canvasUrl: z.string(),
  /** True when this file is already one of bb's own (a thread row exists). */
  inBb: z.boolean(),
});

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      configured: z.boolean(),
      baseUrl: z.string(),
      bridgeConnected: z.boolean(),
      email: z.string(),
      buildProjectId: z.string(),
    }),
  },
  // Files that belong to bb: created here, or explicitly opened into bb. This
  // is what the sidebar lists as threads — never the whole Diffui account.
  listCanvases: {
    input: z.null(),
    output: z.object({ canvases: z.array(canvasRowSchema) }),
  },
  // Every canvas on the Diffui account, for the browse grid you pick from.
  // Opening one adopts it into bb (see openCanvas).
  browseCanvases: {
    input: z.null(),
    output: z.object({ canvases: z.array(canvasRowSchema) }),
  },
  // Adopt a Diffui file into bb, so it lists as a thread from now on.
  openCanvas: {
    input: z.object({ projectId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  // Drop a file from bb's sidebar. It stays in Diffui, untouched.
  forgetCanvas: {
    input: z.object({ projectId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  // The embed credentials the in-bb canvas mounts with: it loads Diffui's own
  // canvas element and talks to Diffui directly (bearer key, credentials
  // omitted), which is why the key crosses to the renderer over this local rpc.
  canvasSession: {
    input: z.null(),
    output: z.object({ baseUrl: z.string(), apiKey: z.string() }),
  },
  createCanvas: {
    // No title required: a canvas starts Untitled and names itself once
    // designs are generated.
    input: z.object({ title: z.string().max(255).optional() }).nullish(),
    output: z.object({ projectId: z.string(), canvasUrl: z.string() }),
  },
  // The FULL canvas document (geometry + stacks + edges + viewport +
  // comments) — what the native in-bb canvas surface renders.
  getCanvas: {
    input: z.object({ projectId: z.string() }),
    output: z.object({
      projectId: z.string(),
      title: z.string(),
      canvasUrl: z.string(),
      version: z.number(),
      viewport: z.object({ x: z.number(), y: z.number(), scale: z.number() }),
      nodes: z.array(canvasDocNodeSchema),
      edges: z.array(z.object({ id: z.string(), fromNodeId: z.string(), toNodeId: z.string() })),
      comments: z.array(
        z.object({ id: z.string(), x: z.number(), y: z.number(), text: z.string(), authorName: z.string() }),
      ),
    }),
  },
  // Hold Diffui's project-watch websocket open for this canvas and forward
  // its events over bb realtime ("canvas" channel) — push, never polling.
  watchCanvas: {
    input: z.object({ projectId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  buildFromCanvas: {
    input: z.object({
      projectId: z.string(),
      imageIds: z.array(z.string()).min(1).max(8),
      bundleName: z.string().optional(),
    }),
    output: z.object({
      threadId: z.string(),
      threadTitle: z.string(),
      bbProjectName: z.string(),
    }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "Diffui API key",
      description: "Create one at Diffui → Settings → API keys (starts with dui_).",
      secret: true,
    },
    baseUrl: {
      type: "string",
      label: "Diffui base URL",
      description: "Only change this for a self-hosted or local Diffui.",
      default: DEFAULT_BASE_URL,
    },
    project: {
      type: "project",
      label: "Project for Build with bb",
      description:
        "Threads spawned by Build with bb land here. Unset falls back to your most recently active project.",
    },
  });

  let bridgeConnected = false;
  // The client the canvas-watch hub dials with; refreshed on every settings
  // read so a re-keyed install reconnects with the new credentials.
  let watchClient: DiffuiClient | null = null;

  async function clientFromSettings(): Promise<DiffuiClient | null> {
    const current = await settings.get();
    const apiKey = (current.apiKey ?? "").trim();
    if (apiKey === "") {
      watchClient = null;
      return null;
    }
    const client = new DiffuiClient({ baseUrl: current.baseUrl || DEFAULT_BASE_URL, apiKey });
    watchClient = client;
    return client;
  }

  async function requireClient(): Promise<DiffuiClient> {
    const client = await clientFromSettings();
    if (client === null) throw new Error(`Diffui is not configured. ${CONFIGURE_HINT}`);
    return client;
  }

  // ---------------------------------------------------------------------
  // bb's own files. The sidebar lists these as threads; the browse grid
  // lists the whole Diffui account so one can be adopted from it.
  // ---------------------------------------------------------------------

  let fileStore: BbFileStore | null = null;
  function bbFiles(): BbFileStore {
    if (fileStore === null) fileStore = new BbFileStore(bb.storage);
    return fileStore;
  }

  type CanvasRowOut = z.infer<typeof canvasRowSchema>;

  function canvasRow(canvas: DiffuiCanvasSummary, tracked: ReadonlySet<string>): CanvasRowOut {
    return {
      id: canvas.id,
      title: canvas.title,
      agentTarget: canvas.agentTarget,
      updatedAt: canvas.updatedAt,
      thumbnails: canvas.thumbnails,
      coverThumbnail: canvas.coverThumbnail,
      coverThumbnailWidth: canvas.coverThumbnailWidth,
      coverThumbnailHeight: canvas.coverThumbnailHeight,
      canvasUrl: canvas.canvasUrl,
      inBb: tracked.has(canvas.id),
    };
  }

  /**
   * bb's files, in bb's order, with live titles.
   *
   * A tracked file that the Diffui listing does not carry (deleted there, or
   * simply older than the page it returns) keeps its remembered title instead of
   * vanishing from the sidebar: only forgetCanvas removes a row.
   */
  async function bbFileRows(): Promise<CanvasRowOut[]> {
    const store = bbFiles();
    const files = store.list();
    if (files.length === 0) return [];
    const client = await clientFromSettings();
    const byId = new Map<string, DiffuiCanvasSummary>();
    if (client !== null) {
      for (const canvas of await client.listCanvases().catch(() => [])) byId.set(canvas.id, canvas);
    }
    const tracked = new Set(files.map((file) => file.projectId));
    return files.map((file) => {
      const canvas = byId.get(file.projectId);
      if (canvas === undefined) {
        return {
          id: file.projectId,
          title: file.title || "Untitled",
          agentTarget: "bb",
          updatedAt: new Date(file.addedAt).toISOString(),
          thumbnails: [],
          coverThumbnail: "",
          coverThumbnailWidth: 0,
          coverThumbnailHeight: 0,
          canvasUrl: client?.canvasUrl(file.projectId) ?? "",
          inBb: true,
        };
      }
      // A canvas names itself after its first designs; that rename is what the
      // thread row follows, so cache it as the row's title from now on.
      if (canvas.title !== "" && canvas.title !== file.title) store.rename(file.projectId, canvas.title);
      return canvasRow(canvas, tracked);
    });
  }

  const initial = await settings.get();
  if ((initial.apiKey ?? "").trim() === "") {
    bb.status.needsConfiguration(CONFIGURE_HINT);
  }

  // ---------------------------------------------------------------------
  // Live canvas events: hold Diffui's project-watch websocket per open
  // canvas and forward everything over bb realtime — the same push stream
  // the Diffui web canvas rides. "canvases" is a debounced list-refresh
  // hint (titles rename themselves after generations; thumbnails land).
  // ---------------------------------------------------------------------

  let canvasesHintTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleCanvasesHint(projectId: string) {
    if (canvasesHintTimer !== null) return;
    canvasesHintTimer = setTimeout(() => {
      canvasesHintTimer = null;
      bb.realtime.publish("canvases", { projectId });
    }, 400);
  }

  const watchHub = new CanvasWatchHub({
    watchUrl(projectId) {
      if (watchClient === null) throw new Error(`Diffui is not configured. ${CONFIGURE_HINT}`);
      return watchClient.watchUrl(projectId);
    },
    log: bb.log,
    onEvent(projectId, event) {
      bb.realtime.publish("canvas", { projectId, event });
      const type = String(event.type ?? "");
      if (
        type === "canvas_state" ||
        type === "canvas_image" ||
        type === "canvas_generation_done" ||
        type === "canvas_thumbnail"
      ) {
        scheduleCanvasesHint(projectId);
      }
    },
  });

  settings.onChange(() => {
    // New key or base URL: drop every held socket; the next watchCanvas call
    // reconnects with fresh credentials.
    for (const projectId of watchHub.watchedProjectIds()) watchHub.close(projectId);
    watchClient = null;
  });

  // ---------------------------------------------------------------------
  // Build with bb: the §2 recipe, shared by every inbound shape.
  // ---------------------------------------------------------------------

  function dispatchDeps(): BuildDispatchDeps {
    return {
      configuredProjectId: async () => (await settings.get()).project ?? "",
      listProjects: async () => {
        const projects = await bb.sdk.projects.list();
        return (projects as Array<{ id: string; name: string; kind: string; updatedAt: number }>) ?? [];
      },
      async fetchImageBytes(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`image fetch failed (${response.status})`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { bytes, mimeType: response.headers.get("content-type") ?? "image/webp" };
      },
      async uploadAttachment(args) {
        const uploaded = await bb.sdk.projects.attachments.upload({
          projectId: args.projectId,
          clientFile: args.bytes,
          filename: args.filename,
          mimeType: args.mimeType,
        });
        return { path: uploaded.path };
      },
      spawnThread: async (args) => {
        const thread = await bb.sdk.threads.spawn(args);
        return { id: thread.id, title: thread.title };
      },
      openThread: async (threadId) => {
        await bb.sdk.threads.open({ threadId, file: null });
      },
      recordSpawn: async (threadId, record) => {
        await bb.storage.kv.set(spawnRecordKey(threadId), record);
      },
      log: bb.log,
      publish: (channel, payload) => bb.realtime.publish(channel, payload),
    };
  }

  async function spawnBuildThread(request: BridgeBuildRequest): Promise<BridgeBuildResult> {
    return dispatchBuildRequest(dispatchDeps(), request);
  }

  // ---------------------------------------------------------------------
  // Inbound shape §3.1 — direct browser call from the Diffui web app.
  // Token auth + experimental_cors (jjcm/bb#6, SDK 0.4.9). On a host without
  // the option (≤0.4.8) the extra key is ignored: the route still exists for
  // non-browser callers, and the web app falls back to the relay below.
  // ---------------------------------------------------------------------

  const corsOrigins = diffuiCorsOrigins(initial.baseUrl || DEFAULT_BASE_URL);
  bb.http.route(
    "POST",
    "/build",
    async (context) => {
      const raw = await context.req.json().catch(() => null);
      const request = parseBuildRequest({ type: "build.request", requestId: "http", ...(raw ?? {}) });
      if (request === null) {
        return context.json({ ok: false, error: "expected { build, canvas } payload" }, 400);
      }
      const result = await spawnBuildThread(request);
      return context.json(result, result.ok ? 200 : 422);
    },
    // Cast keeps the plugin compiling against SDK 0.4.8 declarations while
    // hosts with jjcm/bb#6 (0.4.9) validate and honor the CORS declaration.
    { auth: "token", experimental_cors: { origins: corsOrigins } } as { auth: "token" },
  );

  // ---------------------------------------------------------------------
  // Inbound shape §3.2 — the cloud relay (slack-bot Socket-Mode shape).
  // ---------------------------------------------------------------------

  bb.background.service("diffui-bridge", {
    async start(signal) {
      const client = await clientFromSettings();
      if (client === null) {
        // Loaded-but-unconfigured is a first-class state; the bridge simply
        // stays down until the key is saved and the plugin reloaded.
        bb.status.needsConfiguration(CONFIGURE_HINT);
        return;
      }
      // Pairing (§3.1): hand the Diffui account this machine's direct build
      // endpoint + plugin token so the web app can try the CORS path first
      // and fall back to this relay.
      let localEndpoint: { url: string; token: string } | null = null;
      try {
        const token = await bb.sdk.plugins.token({ pluginId: bb.pluginId });
        localEndpoint = {
          url: `${bb.server.loopbackBaseUrl}/api/v1/plugins/${bb.pluginId}/http/build`,
          token: token.token,
        };
      } catch (error) {
        bb.log.warn(`plugin token unavailable, direct build path disabled: ${error instanceof Error ? error.message : String(error)}`);
      }
      await runBridge(
        {
          url: client.bridgeUrl(),
          log: bb.log,
          instance: { name: hostLabel(), pluginVersion: PLUGIN_VERSION },
          localEndpoint,
          onStateChange(connected) {
            bridgeConnected = connected;
            bb.realtime.publish("bridge", { connected });
          },
          onBuildRequest: spawnBuildThread,
        },
        signal,
      );
    },
  });

  // ---------------------------------------------------------------------
  // Status back to Diffui (§4): thread.idle/failed on spawned threads.
  // ---------------------------------------------------------------------

  async function reportBuildStatus(threadId: string, status: "idle" | "failed", summary: string | null) {
    const record = await bb.storage.kv.get<BuildSpawnRecord>(spawnRecordKey(threadId));
    if (record === undefined) return;
    const client = await clientFromSettings();
    if (client === null) return;
    try {
      await client.api("/api/bb/build-status", {
        method: "POST",
        body: JSON.stringify({
          build_id: record.buildId,
          thread_id: threadId,
          status,
          summary: summary ?? "",
        }),
      });
    } catch (error) {
      bb.log.warn(`build status report failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // One report per spawned thread: the first settle is "the build landed";
    // later turns in the same thread are ordinary work, not build status.
    await bb.storage.kv.delete(spawnRecordKey(threadId));
  }

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    await reportBuildStatus(thread.id, "idle", lastAssistantText);
  });
  bb.events.on("thread.failed", async ({ thread, error }) => {
    await reportBuildStatus(thread.id, "failed", error);
  });

  // ---------------------------------------------------------------------
  // RPC for the frontend (nav panel + thread panel canvas).
  // ---------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    status: async () => {
      const current = await settings.get();
      const client = await clientFromSettings();
      let email = "";
      if (client !== null) {
        try {
          email = (await client.me()).email;
        } catch {
          email = "";
        }
      }
      return {
        configured: client !== null,
        baseUrl: current.baseUrl || DEFAULT_BASE_URL,
        bridgeConnected,
        email,
        buildProjectId: (current.project ?? "").trim(),
      };
    },
    listCanvases: async () => ({ canvases: await bbFileRows() }),
    browseCanvases: async () => {
      const client = await requireClient();
      const tracked = bbFiles().trackedIds();
      return { canvases: (await client.listCanvases()).map((canvas) => canvasRow(canvas, tracked)) };
    },
    openCanvas: async (input) => {
      const client = await requireClient();
      const store = bbFiles();
      // Read the title through Diffui so a freshly adopted row paints with the
      // file's real name rather than waiting for the next list refresh.
      let title = "";
      try {
        title = (await client.canvasDocument(input.projectId)).title;
      } catch {
        title = "";
      }
      store.track(input.projectId, { source: "opened", title });
      bb.realtime.publish("canvases", { projectId: input.projectId });
      return { ok: true };
    },
    forgetCanvas: async (input) => {
      bbFiles().forget(input.projectId);
      watchHub.close(input.projectId);
      bb.realtime.publish("canvases", { projectId: input.projectId });
      return { ok: true };
    },
    canvasSession: async () => {
      const current = await settings.get();
      const apiKey = (current.apiKey ?? "").trim();
      if (apiKey === "") throw new Error(`Diffui is not configured. ${CONFIGURE_HINT}`);
      return { baseUrl: (current.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""), apiKey };
    },
    createCanvas: async (input) => {
      const client = await requireClient();
      const created = await client.createCanvas({ title: input?.title ?? "" });
      bbFiles().track(created.projectId, { source: "created", title: input?.title ?? "" });
      return created;
    },
    getCanvas: async (input) => {
      const client = await requireClient();
      const document = await client.canvasDocument(input.projectId);
      return {
        projectId: document.projectId,
        title: document.title,
        canvasUrl: document.canvasUrl,
        version: document.version,
        viewport: document.doc.viewport,
        nodes: document.doc.nodes,
        edges: document.doc.edges,
        comments: document.doc.comments,
      };
    },
    watchCanvas: async (input) => {
      await requireClient();
      watchHub.watch(input.projectId);
      return { ok: true };
    },
    buildFromCanvas: async (input) => {
      const client = await requireClient();
      const payload = await client.buildPackageForImages({
        projectId: input.projectId,
        imageIds: input.imageIds,
        bundleName: input.bundleName ?? "",
      });
      const request = parseBuildRequest({ type: "build.request", requestId: "panel", ...payload });
      if (request === null) throw new Error("diffui returned an unusable build payload");
      const result = await spawnBuildThread(request);
      if (!result.ok || result.thread === undefined) {
        throw new Error(result.error ?? "bb could not start the build");
      }
      return {
        threadId: result.thread.id,
        threadTitle: result.thread.title,
        bbProjectName: result.bbProject?.name ?? "",
      };
    },
  });

  // ---------------------------------------------------------------------
  // Agent tools — thin proxies over Diffui's hosted MCP workflow tools.
  // ---------------------------------------------------------------------

  function toolResult(result: DiffuiToolCallResult) {
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  }

  bb.agents.registerTool({
    name: "diffui_create_canvas",
    description:
      "Create a new named Diffui canvas for this bb project and return its URL. " +
      "Use once per design effort; put related screens on the same canvas.",
    instructions:
      "diffui_create_canvas starts a design session: create ONE canvas per effort, share its canvasUrl with the user, " +
      "then call diffui_generate_options once per screen against the same project_id.",
    parameters: z.object({
      title: z.string().max(255).describe("Human name for the canvas, e.g. 'Checkout redesign'."),
      orientation: z.enum(["landscape", "portrait"]).optional().describe("Default landscape."),
    }),
    async execute(params) {
      const client = await requireClient();
      const created = await client.createCanvas({
        title: params.title,
        ...(params.orientation !== undefined ? { orientation: params.orientation } : {}),
      });
      // Created from inside bb, so it is one of bb's files: it lists as a thread.
      bbFiles().track(created.projectId, { source: "created", title: params.title });
      bb.realtime.publish("canvases", { projectId: created.projectId });
      return {
        content: [
          {
            type: "text",
            text:
              `Created Diffui canvas "${params.title}" (project_id ${created.projectId}).\n` +
              `Open it here: ${created.canvasUrl}\n` +
              `Generate design options with diffui_generate_options { project_id: "${created.projectId}", prompt: "…" }.`,
          },
        ],
      };
    },
  });

  bb.agents.registerTool({
    name: "diffui_generate_options",
    description:
      "Generate UI design options on a Diffui canvas. One call = one prompt = one new prompt node whose images each " +
      "keep that single prompt; call again on the same project_id for more screens. Blocks until rendered (1–5 min).",
    instructions:
      "diffui_generate_options keeps every image node 1:1 with a single prompt: never concatenate multiple screens " +
      "into one prompt — call the tool once per screen, always with the same project_id so related designs stay in " +
      "one named project. Pass brand_id when the user has a brand.",
    experimental_statusLabels: {
      pending: "Rendering Diffui options…",
      completed: "Rendered Diffui options",
    },
    parameters: z.object({
      project_id: z.string().describe("Canvas project id from diffui_create_canvas."),
      prompt: z.string().describe("Visual design prompt for ONE screen (subject + layout + style + palette)."),
      count: z.number().int().min(1).max(8).optional().describe("Options to render (default 4)."),
      brand_id: z.string().optional().describe("Diffui brand to keep the options on-brand."),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
    }),
    async execute(params, ctx) {
      const client = await requireClient();
      const args: Record<string, unknown> = {
        project_id: params.project_id,
        prompt: params.prompt,
        count: params.count ?? 4,
        timeout_seconds: 240,
      };
      if (params.brand_id !== undefined) args.brand_id = params.brand_id;
      if (params.width !== undefined) args.width = params.width;
      if (params.height !== undefined) args.height = params.height;
      return toolResult(await client.mcpToolCall("generate_options", args, ctx.signal));
    },
  });

  bb.agents.registerTool({
    name: "diffui_get_canvas",
    description:
      "Read a Diffui canvas: nodes, prompts, and per-image ids/status. Use it to pick which rendered option to " +
      "implement or to check on a generation still rendering.",
    parameters: z.object({
      project_id: z.string(),
      full: z.boolean().optional().describe("Return the raw canvas state instead of the summary."),
    }),
    async execute(params, ctx) {
      const client = await requireClient();
      const args: Record<string, unknown> = { project_id: params.project_id };
      if (params.full === true) args.full = true;
      return toolResult(await client.mcpToolCall("get_canvas_state", args, ctx.signal));
    },
  });

  bb.agents.registerTool({
    name: "diffui_create_build_link",
    description:
      "Mint implementation instructions (markdown + full-res design images + brand context) for chosen Diffui images. " +
      "Fetch the returned buildUrl and follow it to implement the design in this workspace.",
    parameters: z.object({
      bundle_name: z.string().optional(),
      pages: z
        .array(
          z.object({
            image_id: z.string().describe("Image id from diffui_get_canvas / diffui_generate_options."),
            name: z.string().describe("Page name, e.g. 'Checkout'."),
            original_prompt: z.string().optional(),
            brand_id: z.string().optional(),
          }),
        )
        .min(1),
    }),
    async execute(params, ctx) {
      const client = await requireClient();
      return toolResult(
        await client.mcpToolCall(
          "create_build_link",
          {
            ...(params.bundle_name !== undefined ? { bundle_name: params.bundle_name } : {}),
            pages: params.pages,
          },
          ctx.signal,
        ),
      );
    },
  });

  // ---------------------------------------------------------------------
  // @diffui mentions: canvases and brands as send-time context.
  // ---------------------------------------------------------------------

  bb.ui.registerMentionProvider({
    id: "diffui",
    label: "Diffui",
    async search(ctx) {
      const client = await clientFromSettings();
      if (client === null) return [];
      const query = ctx.query.trim().toLowerCase();
      const [canvases, brands] = await Promise.all([
        client.listCanvases().catch(() => []),
        client.listBrands().catch(() => []),
      ]);
      const canvasItems = canvases
        .filter((canvas) => query === "" || canvas.title.toLowerCase().includes(query))
        .slice(0, 6)
        .map((canvas) => ({
          id: `canvas:${canvas.id}`,
          title: canvas.title,
          subtitle: canvas.agentTarget === "bb" ? "Diffui canvas · for bb" : "Diffui canvas",
        }));
      const brandItems = brands
        .filter((brand) => query === "" || brand.name.toLowerCase().includes(query))
        .slice(0, 4)
        .map((brand) => ({
          id: `brand:${brand.id}`,
          title: brand.name,
          subtitle: `Diffui brand · ${brand.readyCount} reference${brand.readyCount === 1 ? "" : "s"}`,
        }));
      return [...canvasItems, ...brandItems];
    },
    async resolve(itemId) {
      const client = await requireClient();
      const [kind, id] = itemId.split(":", 2);
      if (kind === "canvas" && id !== undefined) {
        return { context: await canvasMentionContext(client, id) };
      }
      if (kind === "brand" && id !== undefined) {
        return { context: await brandMentionContext(client, id) };
      }
      throw new Error(`unknown diffui mention ${itemId}`);
    },
  });

  async function canvasMentionContext(client: DiffuiClient, projectId: string): Promise<string> {
    const state = await client.mcpToolCall("get_canvas_state", { project_id: projectId });
    const summary = firstJsonBlock(state);
    const lines = [
      `Diffui canvas ${client.canvasUrl(projectId)} (project_id ${projectId}).`,
      "Node summary (each prompt node carries exactly one prompt; its images are rendered options):",
      "```json",
      JSON.stringify(summary ?? { projectId }, null, 2),
      "```",
      "Use diffui_get_canvas for fresh state (including image content), and diffui_create_build_link with chosen image ids to implement.",
    ];
    return lines.join("\n");
  }

  async function brandMentionContext(client: DiffuiClient, brandId: string): Promise<string> {
    const { brand, images } = await client.brandDetail(brandId);
    const name = typeof brand.name === "string" ? brand.name : "Untitled brand";
    const lines = [`Diffui brand "${name}" (brand_id ${brandId}).`];
    for (const key of ["tagline", "industry", "personality", "notes"] as const) {
      const value = brand[key];
      if (typeof value === "string" && value.trim() !== "") lines.push(`${key}: ${value.trim()}`);
    }
    // The guideline board must stay full resolution — fine print and type
    // specimens live there, and a thumb would hand the agent mush.
    const guidelines = images.filter((image) => image.role === "guideline");
    for (const guideline of guidelines) {
      const url = fullResBrandImageUrl(guideline);
      if (url !== "") lines.push(`Brand guideline (full resolution): ${client.absoluteUrl(url)}`);
    }
    const designMd = brand.design_md;
    if (typeof designMd === "string" && designMd.trim() !== "") {
      lines.push("", "Design notes:", designMd.trim());
    }
    lines.push("", `Pass brand_id "${brandId}" to diffui_generate_options to stay on-brand.`);
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------
  // CLI: bb diffui status | canvases | new <title>
  // ---------------------------------------------------------------------

  bb.cli.register({
    name: "diffui",
    summary: "Diffui canvases from the terminal",
    commands: [
      { name: "status", summary: "Connection + bridge state", usage: "bb diffui status" },
      { name: "canvases", summary: "List your Diffui canvases", usage: "bb diffui canvases" },
      { name: "new", summary: "Create a canvas for bb", usage: "bb diffui new <title>" },
    ],
    async run(argv) {
      const [command, ...rest] = argv;
      try {
        if (command === "status" || command === undefined) {
          const client = await clientFromSettings();
          if (client === null) return { exitCode: 1, stderr: `not configured — ${CONFIGURE_HINT}\n` };
          const me = await client.me();
          return {
            exitCode: 0,
            stdout: `signed in as ${me.email}\nbridge ${bridgeConnected ? "connected" : "not connected"}\n`,
          };
        }
        if (command === "canvases") {
          const client = await requireClient();
          const canvases = await client.listCanvases();
          const lines = canvases.map((canvas) => `${canvas.id}  ${canvas.title}  ${canvas.canvasUrl}`);
          return { exitCode: 0, stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "no canvases yet\n" };
        }
        if (command === "new") {
          const title = rest.join(" ").trim();
          if (title === "") return { exitCode: 1, stderr: "usage: bb diffui new <title>\n" };
          const client = await requireClient();
          const created = await client.createCanvas({ title });
          return { exitCode: 0, stdout: `${created.canvasUrl}\n` };
        }
        return { exitCode: 1, stderr: `unknown command "${command}" — try status, canvases, or new\n` };
      } catch (error) {
        return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
      }
    },
  });

  bb.onDispose(() => {
    if (canvasesHintTimer !== null) clearTimeout(canvasesHintTimer);
    watchHub.closeAll();
    bb.log.info("diffui plugin disposed");
  });
}

/** Exact CORS origins for the direct build route: the Diffui production
 * origins plus the configured base URL's origin (self-hosted / localhost). */
export function diffuiCorsOrigins(baseUrl: string): string[] {
  const origins = new Set<string>(["https://diffui.ai", "https://www.diffui.ai"]);
  try {
    origins.add(new URL(baseUrl).origin);
  } catch {
    // Malformed setting: production origins alone still stand.
  }
  return [...origins];
}

function hostLabel(): string {
  try {
    return process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? "bb";
  } catch {
    return "bb";
  }
}

// Re-exported so tests and the panel share one URL policy.
export { fullResUrlForThumbUrl, thumbUrlForFileUrl };

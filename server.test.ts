import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";

const BASE = "https://diffui.test";

type FetchHandler = (url: string, init: RequestInit) => { status?: number; body: unknown } | null;

function stubFetch(handler: FetchHandler) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const result = handler(url, init);
      if (result === null) throw new Error(`unexpected fetch ${url}`);
      return new Response(JSON.stringify(result.body), {
        status: result.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

async function loadConfiguredHost(): Promise<FakePluginHost> {
  const host = createFakePluginHost({
    pluginId: "diffui-bb",
    settings: { apiKey: "dui_test_key", baseUrl: BASE },
  });
  await plugin(host.bb);
  return host;
}

describe("registrations", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("all surfaces register: rpc, tools, mention provider, cli, http route, bridge service", async () => {
    const host = await loadConfiguredHost();
    const regs = host.harness.inspection.registrations;
    expect(regs.rpcMethods.sort()).toEqual([
      "browseCanvases",
      "buildFromCanvas",
      "canvasSession",
      "createCanvas",
      "forgetCanvas",
      "getCanvas",
      "listCanvases",
      "openCanvas",
      "status",
      "watchCanvas",
    ]);
    expect(regs.agentTools.map((tool) => tool.name).sort()).toEqual([
      "diffui_create_build_link",
      "diffui_create_canvas",
      "diffui_generate_options",
      "diffui_get_canvas",
    ]);
    expect(regs.mentionProviders.map((provider) => provider.id)).toEqual(["diffui"]);
    expect(regs.cli?.name).toBe("diffui");
    expect(regs.services.map((service) => service.name)).toEqual(["diffui-bridge"]);
    // The direct-browser build route (author notes §3.1): token auth so the
    // Diffui web app can call it cross-origin once bb ships per-route CORS.
    const buildRoute = regs.httpRoutes.find((route) => route.path === "/build");
    expect(buildRoute).toMatchObject({ method: "POST", auth: "token" });
    // Both settle events feed the status-back loop.
    expect(regs.threadEventHandlers["thread.idle"]).toBeGreaterThan(0);
    expect(regs.threadEventHandlers["thread.failed"]).toBeGreaterThan(0);
    await host.harness.lifecycle.dispose();
  });

  test("an unconfigured install reports needs-configuration instead of failing", async () => {
    const host = createFakePluginHost({ pluginId: "diffui-bb" });
    await plugin(host.bb);
    expect(host.harness.inspection.needsConfigurationMessages.join(" ")).toContain("bb plugin config diffui-bb");
    await host.harness.lifecycle.dispose();
  });
});

describe("rpc", () => {
  let host: FakePluginHost;
  beforeEach(async () => {
    host = await loadConfiguredHost();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await host.harness.lifecycle.dispose();
  });

  test("createCanvas posts a bb-target canvas with the given title", async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    stubFetch((url, init) => {
      if (url === `${BASE}/api/projects` && init.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return { body: { project: { id: "proj-123" } } };
      }
      return null;
    });
    const created = (await host.harness.behavior.callRpc("createCanvas", { title: "Checkout flow" })) as {
      projectId: string;
      canvasUrl: string;
    };
    expect(created).toEqual({ projectId: "proj-123", canvasUrl: `${BASE}/app/canvas/proj-123` });
    expect(posts[0]!.body).toMatchObject({ type: "canvas", agentTarget: "bb", title: "Checkout flow" });
  });

  test("createCanvas never requires a title: an empty call creates an Untitled canvas", async () => {
    const posts: Array<Record<string, unknown>> = [];
    stubFetch((url, init) => {
      if (url === `${BASE}/api/projects` && init.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return { body: { project: { id: "proj-untitled" } } };
      }
      return null;
    });
    const created = (await host.harness.behavior.callRpc("createCanvas", {})) as { projectId: string };
    expect(created.projectId).toBe("proj-untitled");
    expect(posts[0]).toMatchObject({ type: "canvas", agentTarget: "bb", title: "" });
  });

  test("getCanvas returns the FULL canvas document: geometry, stacks, edges, viewport", async () => {
    stubFetch((url) => {
      if (url === `${BASE}/api/projects/proj-1`) {
        return { body: { project: { id: "proj-1", name: "Storefront checkout" } } };
      }
      if (url === `${BASE}/api/projects/proj-1/canvas`) {
        return {
          body: {
            canvas: {
              version: 7,
              state: {
                version: 1,
                viewport: { x: 40, y: -12, scale: 0.5 },
                nodes: [
                  {
                    id: "prompt-1",
                    kind: "prompt",
                    name: "Landing",
                    x: -720,
                    y: -512,
                    width: 1440,
                    height: 1024,
                    prompt: "hero section",
                    stack_index: 1,
                    images: [
                      {
                        id: "slot-1",
                        image_url: "/files/generations/proj-1/img1.png",
                        status: "ready",
                        metadata_json: JSON.stringify({ imageId: "img-1" }),
                      },
                      { id: "slot-2", status: "loading" },
                    ],
                  },
                ],
                edges: [{ id: "edge-1", from_node_id: "prompt-1", to_node_id: "prompt-2" }],
              },
            },
          },
        };
      }
      return null;
    });
    const document = (await host.harness.behavior.callRpc("getCanvas", { projectId: "proj-1" })) as {
      title: string;
      version: number;
      viewport: { x: number; y: number; scale: number };
      nodes: Array<{ id: string; x: number; width: number; stackIndex: number; generating: boolean; images: Array<Record<string, unknown>> }>;
      edges: Array<{ fromNodeId: string; toNodeId: string }>;
    };
    expect(document.title).toBe("Storefront checkout");
    expect(document.version).toBe(7);
    expect(document.viewport).toEqual({ x: 40, y: -12, scale: 0.5 });
    expect(document.nodes[0]).toMatchObject({ id: "prompt-1", x: -720, width: 1440, stackIndex: 1, generating: true });
    // Display URLs stay on the webp rungs — never .png.
    expect(document.nodes[0]!.images[0]).toMatchObject({
      imageId: "img-1",
      thumbUrl: `${BASE}/files/generations/proj-1/img1_thumb.webp`,
      fullUrl: `${BASE}/files/generations/proj-1/img1.webp`,
    });
    expect(document.edges[0]).toEqual({ id: "edge-1", fromNodeId: "prompt-1", toNodeId: "prompt-2" });
  });

  function stubAccountListing() {
    stubFetch((url) => {
      if (url.startsWith(`${BASE}/api/projects?`)) {
        return {
          body: {
            generations: [
              {
                id: "canvas-1",
                title: "Checkout",
                file_type: "canvas",
                agent_target: "bb",
                updated_at: "2026-08-19T00:00:00Z",
                thumbnails: ["/files/generations/canvas-1/img_thumb.webp"],
                cover_thumbnail: "/files/canvas-thumbnails/canvas-1/thumbnail_thumb.webp",
                cover_thumbnail_width: 1312,
                cover_thumbnail_height: 640,
              },
              {
                id: "canvas-2",
                title: "Someone else's brand work",
                file_type: "canvas",
                updated_at: "2026-08-18T00:00:00Z",
                thumbnails: [],
                cover_thumbnail: "",
              },
              { id: "gen-1", title: "Classic", file_type: "generation", thumbnails: [] },
            ],
          },
        };
      }
      if (url === `${BASE}/api/projects/canvas-2`) {
        return { body: { project: { id: "canvas-2", name: "Someone else's brand work" } } };
      }
      if (url === `${BASE}/api/projects/canvas-2/canvas`) {
        return { body: { canvas: { version: 1, state: { nodes: [] } } } };
      }
      return null;
    });
  }

  test("browseCanvases returns canvas files only, with absolute thumbs, generated cover size, and canvas urls", async () => {
    stubAccountListing();
    const result = (await host.harness.behavior.callRpc("browseCanvases")) as {
      canvases: Array<Record<string, unknown>>;
    };
    expect(result.canvases.map((canvas) => canvas.id)).toEqual(["canvas-1", "canvas-2"]);
    expect(result.canvases[0]).toMatchObject({
      id: "canvas-1",
      agentTarget: "bb",
      thumbnails: [`${BASE}/files/generations/canvas-1/img_thumb.webp`],
      coverThumbnail: `${BASE}/files/canvas-thumbnails/canvas-1/thumbnail_thumb.webp`,
      // The size Diffui rendered the cover at, so the grid reserves that exact
      // box instead of measuring the decoded image.
      coverThumbnailWidth: 1312,
      coverThumbnailHeight: 640,
      canvasUrl: `${BASE}/app/canvas/canvas-1`,
      inBb: false,
    });
  });

  test("listCanvases starts empty: a Diffui account's files are not bb threads", async () => {
    stubAccountListing();
    const result = (await host.harness.behavior.callRpc("listCanvases")) as { canvases: unknown[] };
    expect(result.canvases).toEqual([]);
  });

  test("a canvas created in bb becomes a bb file, and only that one lists", async () => {
    stubFetch((url, init) => {
      if (url === `${BASE}/api/projects` && init.method === "POST") {
        return { body: { project: { id: "canvas-1" } } };
      }
      if (url.startsWith(`${BASE}/api/projects?`)) {
        return {
          body: {
            generations: [
              { id: "canvas-1", title: "Checkout", file_type: "canvas", thumbnails: [] },
              { id: "canvas-2", title: "Not bb's", file_type: "canvas", thumbnails: [] },
            ],
          },
        };
      }
      return null;
    });
    await host.harness.behavior.callRpc("createCanvas", { title: "Checkout" });
    const result = (await host.harness.behavior.callRpc("listCanvases")) as {
      canvases: Array<Record<string, unknown>>;
    };
    expect(result.canvases.map((canvas) => canvas.id)).toEqual(["canvas-1"]);
    expect(result.canvases[0]).toMatchObject({ title: "Checkout", inBb: true });
  });

  test("openCanvas adopts a file from the browse grid, and forgetCanvas drops it again", async () => {
    stubAccountListing();
    await host.harness.behavior.callRpc("openCanvas", { projectId: "canvas-2" });
    const adopted = (await host.harness.behavior.callRpc("listCanvases")) as {
      canvases: Array<Record<string, unknown>>;
    };
    expect(adopted.canvases.map((canvas) => canvas.id)).toEqual(["canvas-2"]);
    // The browse grid marks it, so the same file is not offered as new.
    const browse = (await host.harness.behavior.callRpc("browseCanvases")) as {
      canvases: Array<Record<string, unknown>>;
    };
    expect(browse.canvases.find((canvas) => canvas.id === "canvas-2")).toMatchObject({ inBb: true });

    await host.harness.behavior.callRpc("forgetCanvas", { projectId: "canvas-2" });
    const forgotten = (await host.harness.behavior.callRpc("listCanvases")) as { canvases: unknown[] };
    expect(forgotten.canvases).toEqual([]);
  });

  test("a bb file's thread title follows the name the canvas gives itself", async () => {
    let title = "Untitled";
    stubFetch((url, init) => {
      if (url === `${BASE}/api/projects` && init.method === "POST") {
        return { body: { project: { id: "canvas-1" } } };
      }
      if (url.startsWith(`${BASE}/api/projects?`)) {
        return { body: { generations: [{ id: "canvas-1", title, file_type: "canvas", thumbnails: [] }] } };
      }
      return null;
    });
    await host.harness.behavior.callRpc("createCanvas", {});
    const before = (await host.harness.behavior.callRpc("listCanvases")) as {
      canvases: Array<Record<string, unknown>>;
    };
    expect(before.canvases[0]).toMatchObject({ title: "Untitled" });

    title = "Coffee subscription";
    const after = (await host.harness.behavior.callRpc("listCanvases")) as {
      canvases: Array<Record<string, unknown>>;
    };
    expect(after.canvases[0]).toMatchObject({ title: "Coffee subscription" });
  });

  test("a bb file Diffui's listing no longer carries keeps its remembered title", async () => {
    let listed = true;
    stubFetch((url, init) => {
      if (url === `${BASE}/api/projects` && init.method === "POST") {
        return { body: { project: { id: "canvas-1" } } };
      }
      if (url.startsWith(`${BASE}/api/projects?`)) {
        return {
          body: {
            generations: listed ? [{ id: "canvas-1", title: "Checkout", file_type: "canvas", thumbnails: [] }] : [],
          },
        };
      }
      return null;
    });
    await host.harness.behavior.callRpc("createCanvas", { title: "Checkout" });
    await host.harness.behavior.callRpc("listCanvases");
    listed = false;
    const result = (await host.harness.behavior.callRpc("listCanvases")) as {
      canvases: Array<Record<string, unknown>>;
    };
    expect(result.canvases).toHaveLength(1);
    expect(result.canvases[0]).toMatchObject({ id: "canvas-1", title: "Checkout", inBb: true });
  });

  test("canvasSession hands the in-bb canvas the embed credentials it mounts with", async () => {
    const session = (await host.harness.behavior.callRpc("canvasSession")) as {
      baseUrl: string;
      apiKey: string;
    };
    expect(session).toEqual({ baseUrl: BASE, apiKey: "dui_test_key" });
  });
});

describe("agent tools", () => {
  let host: FakePluginHost;
  beforeEach(async () => {
    host = await loadConfiguredHost();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await host.harness.lifecycle.dispose();
  });

  test("diffui_generate_options proxies to the hosted MCP with the 1:1 defaults", async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubFetch((url, init) => {
      if (url === `${BASE}/mcp`) {
        const body = JSON.parse(String(init.body)) as { params: { name: string; arguments: Record<string, unknown> } };
        calls.push(body.params.arguments);
        expect(body.params.name).toBe("generate_options");
        return {
          body: {
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [
                { type: "text", text: "Rendered 4 options." },
                { type: "image", data: "aGk=", mimeType: "image/webp" },
              ],
            },
          },
        };
      }
      return null;
    });
    const result = await host.harness.behavior.callAgentTool("diffui_generate_options", {
      project_id: "proj-123",
      prompt: "hero section, dark, bold headline",
    });
    expect(calls[0]).toMatchObject({ project_id: "proj-123", count: 4, timeout_seconds: 240 });
    expect(typeof result).not.toBe("string");
    const parts = (result as { content: Array<{ type: string }> }).content;
    expect(parts.map((part) => part.type)).toEqual(["text", "image"]);
  });

  test("the generate tool teaches the one-prompt-per-node rule", async () => {
    const tool = host.harness.inspection.registrations.agentTools.find(
      (candidate) => candidate.name === "diffui_generate_options",
    );
    expect(tool?.instructions).toContain("1:1");
    expect(tool?.instructions).toContain("once per screen");
    expect(tool?.instructions).toContain("same project_id");
  });
});

describe("@diffui mentions", () => {
  let host: FakePluginHost;
  beforeEach(async () => {
    host = await loadConfiguredHost();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await host.harness.lifecycle.dispose();
  });

  test("search mixes canvases and brands; resolve hands brands full-res guidelines", async () => {
    stubFetch((url) => {
      if (url.startsWith(`${BASE}/api/projects?`)) {
        return {
          body: {
            generations: [
              { id: "canvas-1", title: "Checkout", file_type: "canvas", agent_target: "bb", thumbnails: [] },
            ],
          },
        };
      }
      if (url === `${BASE}/api/brands`) {
        return { body: { brands: [{ id: "brand-1", name: "Acme", image_count: 6, ready_count: 5 }] } };
      }
      if (url === `${BASE}/api/brands/brand-1`) {
        return {
          body: {
            brand: { id: "brand-1", name: "Acme", tagline: "Ship faster", design_md: "# Tokens" },
            images: [
              {
                id: "img-g",
                role: "guideline",
                display_file_url: "/files/brands/brand-1/guide_thumb.webp",
                display_full_file_url: "/files/brands/brand-1/guide.webp",
              },
            ],
          },
        };
      }
      return null;
    });
    const provider = host.harness.inspection.registrations.mentionProviders[0]!;
    const items = await provider.search({ trigger: "@", query: "", projectId: null, threadId: null });
    expect(items.map((item) => item.id)).toEqual(["canvas:canvas-1", "brand:brand-1"]);

    const resolved = await provider.resolve("brand:brand-1");
    expect(resolved.context).toContain('Diffui brand "Acme"');
    expect(resolved.context).toContain(`${BASE}/files/brands/brand-1/guide.webp`);
    expect(resolved.context).not.toContain("guide_thumb.webp");
    expect(resolved.context).toContain("# Tokens");
  });
});

describe("cli", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("bb diffui new creates a canvas and prints its url", async () => {
    const host = await loadConfiguredHost();
    stubFetch((url, init) => {
      if (url === `${BASE}/api/projects` && init.method === "POST") {
        return { body: { project: { id: "proj-9" } } };
      }
      return null;
    });
    const result = await host.harness.behavior.runCli(["new", "Landing page"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(`${BASE}/app/canvas/proj-9`);
    await host.harness.lifecycle.dispose();
  });

  test("bb diffui status without a key explains configuration", async () => {
    const host = createFakePluginHost({ pluginId: "diffui-bb" });
    await plugin(host.bb);
    const result = await host.harness.behavior.runCli(["status"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bb plugin config diffui-bb");
    await host.harness.lifecycle.dispose();
  });
});

describe("direct build route + status loop", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("POST /build runs the recipe: upload → spawn → open, and acks the thread", async () => {
    const host = await loadConfiguredHost();
    const spawnCalls: unknown[] = [];
    host.harness.inspection.sdk.stub("projects.list", () => [
      { id: "proj-bb", name: "storefront", kind: "standard", updatedAt: 5 },
    ]);
    host.harness.inspection.sdk.stub("projects.attachments.upload", (args: { filename: string }) => ({
      type: "localImage",
      path: `attachments/${args.filename}`,
      name: args.filename,
      sizeBytes: 3,
    }));
    host.harness.inspection.sdk.stub("threads.spawn", (args: { title: string }) => {
      spawnCalls.push(args);
      return { id: "thr_http", title: args.title };
    });
    host.harness.inspection.sdk.stub("threads.open", () => ({ delivered: 1 }));
    stubFetch((url) => {
      if (url === `${BASE}/image/Checkout.webp?authToken=tok`) {
        return { body: {} }; // bytes fetched via arrayBuffer below
      }
      return null;
    });
    // fetchImageBytes reads arrayBuffer; the JSON stub above suffices since
    // Response.arrayBuffer works on any body.
    const response = await host.harness.behavior.fetchHttp("POST", "/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        build: {
          buildId: "build-9",
          bundleName: "Checkout",
          buildUrl: `${BASE}/build/Checkout.md?authToken=tok`,
          pages: [
            { name: "Checkout", slug: "Checkout", prompt: "clean checkout", imageUrl: `${BASE}/image/Checkout.webp?authToken=tok` },
          ],
          brands: [],
        },
        canvas: { projectId: "proj-1", title: "Checkout flow", url: `${BASE}/app/canvas/proj-1` },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; thread: { id: string } };
    expect(body.ok).toBe(true);
    expect(body.thread.id).toBe("thr_http");
    expect(spawnCalls).toHaveLength(1);
    const spawnedInput = (spawnCalls[0] as { input: Array<{ type: string; visibility?: string }> }).input;
    expect(spawnedInput.some((part) => part.type === "localImage")).toBe(true);
    expect(spawnedInput.at(-1)).toMatchObject({ visibility: "agent-only" });
    await host.harness.lifecycle.dispose();
  });

  test("thread.idle on a spawned build reports status back to Diffui once", async () => {
    const host = await loadConfiguredHost();
    host.harness.inspection.sdk.stub("projects.list", () => [
      { id: "proj-bb", name: "storefront", kind: "standard", updatedAt: 5 },
    ]);
    host.harness.inspection.sdk.stub("projects.attachments.upload", () => ({
      type: "localImage",
      path: "attachments/a.webp",
      name: "a.webp",
      sizeBytes: 3,
    }));
    host.harness.inspection.sdk.stub("threads.spawn", () => ({ id: "thr_loop", title: "Diffui: Checkout" }));
    host.harness.inspection.sdk.stub("threads.open", () => ({ delivered: 0 }));
    const statusPosts: Array<Record<string, unknown>> = [];
    stubFetch((url, init) => {
      if (url === `${BASE}/api/bb/build-status`) {
        statusPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return { body: { ok: true } };
      }
      if (url.startsWith(`${BASE}/image/`)) return { body: {} };
      return null;
    });
    const response = await host.harness.behavior.fetchHttp("POST", "/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        build: {
          buildId: "build-loop",
          bundleName: "Checkout",
          buildUrl: `${BASE}/build/Checkout.md?authToken=tok`,
          pages: [],
          brands: [],
        },
        canvas: { projectId: "proj-1", title: "Checkout flow", url: "" },
      }),
    });
    expect(response.status).toBe(200);

    const { makeThreadResponse } = await import("@get-bb/plugin-sdk/testing");
    const thread = makeThreadResponse({ id: "thr_loop" });
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "done" });
    expect(statusPosts).toHaveLength(1);
    expect(statusPosts[0]).toMatchObject({ build_id: "build-loop", thread_id: "thr_loop", status: "idle" });

    // A second idle on the same thread is ordinary work, not build status.
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "more" });
    expect(statusPosts).toHaveLength(1);
    await host.harness.lifecycle.dispose();
  });
});

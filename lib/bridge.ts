// The Build-with-bb relay. bb has no public URL, so this service dials OUT to
// the Diffui server (GET /api/bb/bridge, authenticated with the Diffui API
// key) and holds the websocket open. When someone right-clicks a canvas
// selection in Diffui and picks "Build with bb", the server pushes a
// `build.request` frame down this socket; the plugin spawns a bb thread in the
// configured project and answers `build.result` so the canvas can toast the
// outcome. Message handling is separated from the socket loop so tests can
// drive it without a server.

export interface BridgeBuildPage {
  name: string;
  slug: string;
  prompt: string;
  /** Tokenized full-res webp URL, fetchable by the spawned thread's provider. */
  imageUrl: string;
}

export interface BridgeBuildRequest {
  requestId: string;
  build: {
    buildId: string;
    bundleName: string;
    /** Tokenized markdown link with the full implementation instructions. */
    buildUrl: string;
    pages: BridgeBuildPage[];
    brands: Array<{ id: string; name: string }>;
  };
  canvas: {
    projectId: string;
    title: string;
    url: string;
  };
}

export interface BridgeBuildResult {
  ok: boolean;
  error?: string;
  thread?: { id: string; title: string };
  bbProject?: { id: string; name: string };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Parse one incoming bridge frame into a build request; null for anything else. */
export function parseBuildRequest(raw: unknown): BridgeBuildRequest | null {
  let message: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (raw !== null && typeof raw === "object") {
    message = raw as Record<string, unknown>;
  } else {
    return null;
  }
  if (asString(message.type) !== "build.request") return null;
  const requestId = asString(message.requestId);
  if (requestId === "") return null;
  const build = (message.build ?? {}) as Record<string, unknown>;
  const canvas = (message.canvas ?? {}) as Record<string, unknown>;
  const pages: BridgeBuildPage[] = [];
  for (const rawPage of Array.isArray(build.pages) ? build.pages : []) {
    const page = (rawPage ?? {}) as Record<string, unknown>;
    pages.push({
      name: asString(page.name) || "design",
      slug: asString(page.slug),
      prompt: asString(page.prompt),
      imageUrl: asString(page.imageUrl),
    });
  }
  const brands: Array<{ id: string; name: string }> = [];
  for (const rawBrand of Array.isArray(build.brands) ? build.brands : []) {
    const brand = (rawBrand ?? {}) as Record<string, unknown>;
    if (asString(brand.id) !== "" || asString(brand.name) !== "") {
      brands.push({ id: asString(brand.id), name: asString(brand.name) });
    }
  }
  return {
    requestId,
    build: {
      buildId: asString(build.buildId),
      bundleName: asString(build.bundleName) || "design",
      buildUrl: asString(build.buildUrl),
      pages,
      brands,
    },
    canvas: {
      projectId: asString(canvas.projectId),
      title: asString(canvas.title),
      url: asString(canvas.url),
    },
  };
}

/**
 * The thread prompt for one dispatched build. The tokenized build link is the
 * source of truth (full instructions + asset APIs); the per-page prompts and
 * the canvas link ride along so the thread reads well to the human too.
 */
export function buildThreadPrompt(request: BridgeBuildRequest): string {
  const { build, canvas } = request;
  const lines: string[] = [
    `Implement the Diffui design "${build.bundleName}" in this project.`,
    "",
    `Follow the build instructions exactly: ${build.buildUrl}`,
    "",
  ];
  if (build.pages.length > 0) {
    lines.push(build.pages.length === 1 ? "Design:" : "Designs:");
    for (const page of build.pages) {
      const prompt = page.prompt !== "" ? ` — ${page.prompt}` : "";
      lines.push(`- ${page.name}${prompt}`);
    }
    lines.push("");
  }
  if (build.brands.length > 0) {
    lines.push(`Brand context: ${build.brands.map((brand) => brand.name).join(", ")} (details are in the build instructions).`);
    lines.push("");
  }
  if (canvas.url !== "") {
    lines.push(`Source canvas: ${canvas.title !== "" ? `${canvas.title} — ` : ""}${canvas.url}`);
  }
  return lines.join("\n").trim();
}

/** Thread title for one dispatched build: "Diffui: {bundle}". */
export function buildThreadTitle(request: BridgeBuildRequest): string {
  return `Diffui: ${request.build.bundleName}`.slice(0, 120);
}

export interface BridgeSocketDeps {
  /** wss:// URL with the access token attached (DiffuiClient.bridgeUrl()). */
  url: string;
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  /** Spawn the bb thread for one request and describe what was spawned. */
  onBuildRequest(request: BridgeBuildRequest): Promise<BridgeBuildResult>;
  /** Connection-state pushes for the frontend (realtime "bridge" channel). */
  onStateChange?(connected: boolean): void;
  /** Instance metadata reported in the plugin's hello frame. */
  instance: { name: string; pluginVersion: string };
  /**
   * Pairing for the direct-browser build path (author notes §3.1): this bb's
   * plugin build route + per-plugin token, pushed to the user's Diffui
   * account so the web app can try `fetch(127.0.0.1…)` before the relay.
   */
  localEndpoint?: { url: string; token: string } | null;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * Hold the bridge open until `signal` aborts, reconnecting with capped
 * exponential backoff. Never throws: a broken Diffui deployment must degrade
 * to "bridge offline", not crash-loop the plugin host.
 */
export async function runBridge(deps: BridgeSocketDeps, signal: AbortSignal): Promise<void> {
  let backoffMs = RECONNECT_MIN_MS;
  while (!signal.aborted) {
    const connectedAt = Date.now();
    try {
      await connectOnce(deps, signal);
      backoffMs = RECONNECT_MIN_MS;
    } catch (error) {
      // A connection that lived a while earns a fresh backoff.
      if (Date.now() - connectedAt > 30_000) backoffMs = RECONNECT_MIN_MS;
      deps.log.warn(`diffui bridge disconnected: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (signal.aborted) break;
    await sleep(backoffMs, signal);
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function connectOnce(deps: BridgeSocketDeps, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(deps.url);
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      deps.onStateChange?.(false);
      if (error !== null) reject(error);
      else resolve();
    };
    const onAbort = () => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      finish(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("open", () => {
      deps.log.info("diffui bridge connected");
      deps.onStateChange?.(true);
      socket.send(
        JSON.stringify({
          type: "hello",
          instance: deps.instance,
          ...(deps.localEndpoint != null ? { localEndpoint: deps.localEndpoint } : {}),
        }),
      );
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      const data = typeof event.data === "string" ? event.data : "";
      const request = parseBuildRequest(data);
      if (request === null) return;
      void handleBuildRequest(deps, socket, request);
    });
    socket.addEventListener("error", () => {
      finish(new Error("bridge socket error"));
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      finish(signal.aborted ? null : new Error(`bridge closed (${event.code})`));
    });
  });
}

async function handleBuildRequest(deps: BridgeSocketDeps, socket: WebSocket, request: BridgeBuildRequest): Promise<void> {
  let result: BridgeBuildResult;
  try {
    result = await deps.onBuildRequest(request);
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const frame = {
    type: "build.result",
    requestId: request.requestId,
    ok: result.ok,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.thread !== undefined ? { thread: result.thread } : {}),
    ...(result.bbProject !== undefined ? { bbProject: result.bbProject } : {}),
  };
  try {
    socket.send(JSON.stringify(frame));
  } catch (error) {
    deps.log.warn(`diffui bridge could not ack build ${request.requestId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

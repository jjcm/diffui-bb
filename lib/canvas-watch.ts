// Live canvas updates for the in-bb canvas surface: the plugin server holds
// Diffui's project-watch websocket (GET /api/projects/{id}/watch) open for the
// canvases bb has on screen and forwards every event over bb realtime — the
// same push channel the Diffui web canvas rides, never polling. Sockets are
// kept per project with a small LRU cap and capped-backoff reconnects, and the
// whole hub closes on plugin dispose.

export interface CanvasWatchDeps {
  /** wss:// URL for one project's watch socket (token already attached). */
  watchUrl(projectId: string): string;
  /** Forward one parsed watch event to the frontend. */
  onEvent(projectId: string, event: Record<string, unknown>): void;
  log: { info(message: string): void; warn(message: string): void };
  /** Most sockets held open at once; the least-recently-watched closes first. */
  maxSockets?: number;
}

const WATCH_RECONNECT_MIN_MS = 1_000;
const WATCH_RECONNECT_MAX_MS = 30_000;
const DEFAULT_MAX_SOCKETS = 4;

interface WatchEntry {
  projectId: string;
  controller: AbortController;
  lastTouched: number;
  done: Promise<void>;
}

export class CanvasWatchHub {
  private readonly deps: CanvasWatchDeps;
  private readonly entries = new Map<string, WatchEntry>();
  private closed = false;

  constructor(deps: CanvasWatchDeps) {
    this.deps = deps;
  }

  /** Ensure a live watch for this canvas (opening one or refreshing the LRU). */
  watch(projectId: string): void {
    const id = projectId.trim();
    if (id === "" || this.closed) return;
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      existing.lastTouched = Date.now();
      return;
    }
    const controller = new AbortController();
    const entry: WatchEntry = {
      projectId: id,
      controller,
      lastTouched: Date.now(),
      done: this.run(id, controller.signal),
    };
    this.entries.set(id, entry);
    this.evictOverCap();
  }

  watchedProjectIds(): string[] {
    return [...this.entries.keys()];
  }

  close(projectId: string): void {
    const entry = this.entries.get(projectId.trim());
    if (entry === undefined) return;
    this.entries.delete(entry.projectId);
    entry.controller.abort();
  }

  closeAll(): void {
    this.closed = true;
    for (const entry of this.entries.values()) entry.controller.abort();
    this.entries.clear();
  }

  private evictOverCap(): void {
    const cap = Math.max(1, this.deps.maxSockets ?? DEFAULT_MAX_SOCKETS);
    while (this.entries.size > cap) {
      let oldest: WatchEntry | null = null;
      for (const entry of this.entries.values()) {
        if (oldest === null || entry.lastTouched < oldest.lastTouched) oldest = entry;
      }
      if (oldest === null) return;
      this.deps.log.info(`canvas watch evicted ${oldest.projectId} (over ${cap}-socket cap)`);
      this.close(oldest.projectId);
    }
  }

  private async run(projectId: string, signal: AbortSignal): Promise<void> {
    let backoffMs = WATCH_RECONNECT_MIN_MS;
    while (!signal.aborted) {
      const connectedAt = Date.now();
      try {
        await this.connectOnce(projectId, signal);
        backoffMs = WATCH_RECONNECT_MIN_MS;
      } catch (error) {
        if (Date.now() - connectedAt > 30_000) backoffMs = WATCH_RECONNECT_MIN_MS;
        this.deps.log.warn(
          `canvas watch ${projectId} disconnected: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (signal.aborted) break;
      await sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, WATCH_RECONNECT_MAX_MS);
    }
  }

  private connectOnce(projectId: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.deps.watchUrl(projectId));
      let settled = false;
      const finish = (error: Error | null) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
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
        this.deps.log.info(`canvas watch connected: ${projectId}`);
      });
      socket.addEventListener("message", (event: MessageEvent) => {
        const data = typeof event.data === "string" ? event.data : "";
        if (data === "") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
        this.deps.onEvent(projectId, parsed as Record<string, unknown>);
      });
      socket.addEventListener("error", () => finish(new Error("watch socket error")));
      socket.addEventListener("close", (event: CloseEvent) => {
        finish(signal.aborted ? null : new Error(`watch closed (${event.code})`));
      });
    });
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

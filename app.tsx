// bb-plugin-diffui-bb — the frontend bundle.
//
// Three surfaces, all native plugin React (no iframe anywhere):
//
// - A "Diffui" sidebar page (nav panel) at /plugins/diffui-bb/canvas. Its root
//   is a browse grid of the Diffui account — fixed-aspect cards sized from the
//   generated cover, like Diffui's own browse. Opening one adopts it into bb and
//   shows THE DIFFUI CANVAS at subPath "<projectId>": the product
//   `<diffui-canvas-workspace>` element, imported at runtime from the
//   configured Diffui origin and repainted with bb's theme tokens.
//   See canvas/diffui-canvas-element.ts.
// - The same canvas beside any thread via the "Diffui canvas" panel action.
// - bb's files as THREADS: the sidebar thread list is wrapped so the canvases
//   created in bb (or explicitly opened into bb) appear as palette-icon thread
//   rows above bb's own list — never the whole Diffui account.
//
// The panel owns no title bar of its own: bb's nav pages sit under a host-owned
// title bar that the plugin SDK gives no way to collapse, so the plugin's
// controls are contributed INTO that bar through `headerContent` and only one
// bar is ever on screen.
//
// Compiled by `bb plugin build`; react and @get-bb/plugin-sdk/app are provided
// by the bb app at load time.
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import { ensureBbCanvasTheme } from "./canvas/bb-canvas-theme.js";
import { ensurePanelStyles } from "./canvas/bb-panel-styles.js";
import {
  mountDiffuiCanvas,
  watchHostTheme,
  type DiffuiCanvasElement,
  type DiffuiEmbedSession,
} from "./canvas/diffui-canvas-element.js";
import {
  BROWSE_CARD_MAX_PX,
  BROWSE_CARD_MIN_PX,
  thumbAspectRatioCss,
  thumbSourceForSlot,
} from "./lib/thumb-layout.js";

interface CanvasRow {
  id: string;
  title: string;
  agentTarget: string;
  updatedAt: string;
  thumbnails: string[];
  coverThumbnail: string;
  coverThumbnailWidth: number;
  coverThumbnailHeight: number;
  canvasUrl: string;
  inBb: boolean;
}

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One delayed retry for transient boot/reconnect races — not a poll. */
async function withOneRetry<T>(run: () => Promise<T>, delayMs = 1200): Promise<T> {
  try {
    return await run();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return run();
  }
}

/**
 * A stable handle to the rpc client. `useRpc()` may hand back a fresh object per
 * render, and an effect that mounts the canvas must not re-run for that — it
 * would tear the canvas down and rebuild it mid-session.
 */
function useRpcRef(): { current: Rpc } {
  const rpc = useRpc<typeof rpcContract>();
  const ref = useRef<Rpc>(rpc);
  ref.current = rpc;
  return ref;
}

// ---------------------------------------------------------------------------
// Shared module state: which canvas is on screen, so the thread rows and the
// header can both follow it without prop-drilling across slots.
// ---------------------------------------------------------------------------

const activeCanvasListeners = new Set<(id: string) => void>();
let activeCanvasId = "";
function setActiveCanvasId(id: string): void {
  if (activeCanvasId === id) return;
  activeCanvasId = id;
  for (const listener of activeCanvasListeners) listener(id);
}
function useActiveCanvasId(): string {
  const [id, setId] = useState(activeCanvasId);
  useEffect(() => {
    activeCanvasListeners.add(setId);
    return () => {
      activeCanvasListeners.delete(setId);
    };
  }, []);
  return id;
}

// ---------------------------------------------------------------------------
// Icons. The palette mark is the same lucide "Palette" glyph bb renders for
// this plugin's sidebar row, inlined so thread rows carry the identical icon.
// The canvas's own tool rail is not drawn here at all: it is Diffui's, with
// Diffui's SVGs, and only its colours are retuned (canvas/bb-canvas-theme.ts).
// ---------------------------------------------------------------------------

function PaletteIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The in-bb canvas: Diffui's own canvas element, mounted.
// ---------------------------------------------------------------------------

function DiffuiCanvasSurface({ projectId }: { projectId: string }) {
  ensurePanelStyles();
  const rpcRef = useRpcRef();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const elementRef = useRef<DiffuiCanvasElement | null>(null);
  const [status, setStatus] = useState("Opening canvas…");

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (host === null) return;
    void (async () => {
      try {
        const session: DiffuiEmbedSession = await withOneRetry(() => rpcRef.current.call("canvasSession"));
        if (cancelled) return;
        // Diffui's colour tokens, expressed in bb's — injected before the
        // element mounts so the canvas never paints in Diffui's palette first.
        ensureBbCanvasTheme(session.baseUrl);
        const element = await mountDiffuiCanvas(host, projectId, session);
        if (cancelled) {
          element.remove();
          return;
        }
        elementRef.current = element;
        setStatus("");
        // Reaching a canvas in bb is an explicit open, so it becomes one of
        // bb's files and lists as a thread from here on.
        void rpcRef.current.call("openCanvas", { projectId }).catch(() => undefined);
      } catch (error) {
        if (!cancelled) setStatus(errorText(error));
      }
    })();
    return () => {
      cancelled = true;
      elementRef.current?.remove();
      elementRef.current = null;
    };
  }, [projectId, rpcRef]);

  useEffect(() => watchHostTheme(() => elementRef.current), []);

  return (
    <div className="dfbb-canvas-shell">
      <div ref={hostRef} className="dfbb-canvas-host">
        {status !== "" ? <p className="dfbb-canvas-status">{status}</p> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browse grid: every canvas on the Diffui account, in cards whose box is the
// generated cover's own ratio. Opening one brings it into bb.
// ---------------------------------------------------------------------------

const BrowseCard = memo(function BrowseCard({
  canvas,
  slotPx,
  onOpen,
}: {
  canvas: CanvasRow;
  slotPx: number;
  onOpen: (id: string) => void;
}) {
  const aspectRatio = thumbAspectRatioCss(canvas.coverThumbnailWidth, canvas.coverThumbnailHeight);
  const cover = canvas.coverThumbnail;
  const tiles = canvas.thumbnails.slice(0, 4);
  const coverSource = thumbSourceForSlot(cover, slotPx);
  // Four-up tiles each occupy half the card, so they need half the rung.
  const tileSource = (url: string) => thumbSourceForSlot(url, slotPx / 2);
  return (
    <button type="button" className="dfbb-card" onClick={() => onOpen(canvas.id)}>
      <div className="dfbb-card-cover" style={{ aspectRatio }}>
        {cover !== "" ? (
          <img
            className="dfbb-card-cover-img"
            src={cover}
            {...(coverSource.srcSet !== "" ? { srcSet: coverSource.srcSet, sizes: coverSource.sizes } : {})}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : tiles.length > 0 ? (
          <div className="dfbb-card-tiles">
            {tiles.map((url) => {
              const source = tileSource(url);
              return (
                <img
                  key={url}
                  className="dfbb-card-tile"
                  src={url}
                  {...(source.srcSet !== "" ? { srcSet: source.srcSet, sizes: source.sizes } : {})}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              );
            })}
          </div>
        ) : (
          <div className="dfbb-card-empty">empty canvas</div>
        )}
      </div>
      <div className="dfbb-card-meta">
        <span className="dfbb-card-title">{canvas.title}</span>
        {canvas.inBb ? <span className="dfbb-card-badge">in bb</span> : null}
        <span className="dfbb-card-when">{timeAgo(canvas.updatedAt)}</span>
      </div>
    </button>
  );
});

/** Rendered width of one grid column, so the thumb rung can honour the ≥2× floor. */
function useGridSlotPx(ref: { current: HTMLElement | null }): number {
  const [slotPx, setSlotPx] = useState(BROWSE_CARD_MIN_PX);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const card = element.querySelector<HTMLElement>(".dfbb-card");
      const width = card?.getBoundingClientRect().width ?? 0;
      const next = Math.round(Math.min(BROWSE_CARD_MAX_PX, Math.max(BROWSE_CARD_MIN_PX, width)));
      setSlotPx((previous) => (previous === next ? previous : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return slotPx;
}

function BrowseGrid({ canvases, onOpen }: { canvases: CanvasRow[]; onOpen: (id: string) => void }) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const slotPx = useGridSlotPx(gridRef);
  return (
    <div
      ref={gridRef}
      className="dfbb-grid"
      style={
        {
          "--dfbb-card-min": `${BROWSE_CARD_MIN_PX}px`,
          "--dfbb-card-max": `${BROWSE_CARD_MAX_PX}px`,
        } as Record<string, string>
      }
    >
      {canvases.map((canvas) => (
        <BrowseCard key={canvas.id} canvas={canvas} slotPx={slotPx} onOpen={onOpen} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The nav panel: browse at the root, the canvas at a subPath.
// ---------------------------------------------------------------------------

function canvasIdFromSubPath(subPath: string): string {
  return subPath.split("/")[0] ?? "";
}

function DiffuiPanel({ subPath }: { subPath: string }) {
  ensurePanelStyles();
  const rpcRef = useRpcRef();
  const navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [canvases, setCanvases] = useState<CanvasRow[] | null>(null);
  const [error, setError] = useState("");

  const openCanvasId = canvasIdFromSubPath(subPath);
  useEffect(() => {
    setActiveCanvasId(openCanvasId);
    return () => setActiveCanvasId("");
  }, [openCanvasId]);

  const refresh = useCallback(() => {
    void withOneRetry(() => rpcRef.current.call("status"))
      .then((next) => {
        setConfigured(next.configured);
        if (!next.configured) {
          setCanvases([]);
          return;
        }
        return rpcRef.current.call("browseCanvases").then((result) => {
          setCanvases(result.canvases);
          setError("");
        });
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, [rpcRef]);

  useEffect(() => {
    if (openCanvasId === "") refresh();
  }, [openCanvasId, refresh]);

  useEffect(() => {
    if (connection === "connected" && openCanvasId === "") refresh();
  }, [connection, openCanvasId, refresh]);

  useRealtime("canvases", () => {
    if (openCanvasId === "") refresh();
  });

  if (openCanvasId !== "") return <DiffuiCanvasSurface projectId={openCanvasId} />;

  if (configured === false) {
    return (
      <div className="dfbb-panel">
        <div className="dfbb-panel-body">
          <p className="dfbb-panel-note" style={{ color: "var(--foreground)", fontWeight: 500 }}>
            Connect Diffui
          </p>
          <p className="dfbb-panel-note">
            Create an API key at Diffui → Settings → API keys, save it with{" "}
            <code>bb plugin config diffui-bb</code>, then <code>bb plugin reload diffui-bb</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="dfbb-panel">
      <div className="dfbb-panel-body">
        {error !== "" ? <p className="dfbb-panel-error">{error}</p> : null}
        {canvases === null ? (
          <p className="dfbb-panel-note">Loading canvases…</p>
        ) : canvases.length === 0 ? (
          <p className="dfbb-panel-note">No canvases yet — create one and start designing.</p>
        ) : (
          <BrowseGrid
            canvases={canvases}
            onOpen={(id) => navigate.toPluginPanel("canvas", { subPath: id })}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel's contribution to bb's title bar.
//
// bb owns one title bar per nav page and the SDK exposes no way to hide, merge,
// or full-bleed past it (there is no hideHeader / chrome / fullBleed option on
// PluginNavPanelRegistration — only this `headerContent` slot on the right of
// the host's bar). So the plugin ships no bar of its own and puts its controls
// here instead: one bar, bb's, with the plugin's actions in it.
// ---------------------------------------------------------------------------

function DiffuiPanelHeader({ subPath }: { subPath: string }) {
  ensurePanelStyles();
  const rpcRef = useRpcRef();
  const navigate = useBbNavigate();
  const [creating, setCreating] = useState(false);
  const [canvasUrl, setCanvasUrl] = useState("");
  const openCanvasId = canvasIdFromSubPath(subPath);

  useEffect(() => {
    if (openCanvasId === "") {
      setCanvasUrl("");
      return;
    }
    let cancelled = false;
    void rpcRef.current
      .call("getCanvas", { projectId: openCanvasId })
      .then((document) => {
        if (!cancelled) setCanvasUrl(document.canvasUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [openCanvasId, rpcRef]);

  const createCanvas = useCallback(() => {
    if (creating) return;
    setCreating(true);
    void rpcRef.current
      .call("createCanvas", {})
      .then((created) => navigate.toPluginPanel("canvas", { subPath: created.projectId }))
      .catch(() => undefined)
      .finally(() => setCreating(false));
  }, [creating, navigate, rpcRef]);

  if (openCanvasId !== "") {
    return (
      <div className="dfbb-header">
        <button
          type="button"
          className="dfbb-header-btn"
          onClick={() => navigate.toPluginPanel("canvas")}
        >
          <BackIcon />
          Canvases
        </button>
        {canvasUrl !== "" ? (
          <a className="dfbb-header-link" href={canvasUrl} target="_blank" rel="noreferrer">
            Open in Diffui ↗
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div className="dfbb-header">
      <button type="button" className="dfbb-header-btn" disabled={creating} onClick={createCanvas}>
        <PlusIcon />
        {creating ? "Creating…" : "New canvas"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// bb's files as threads. Only canvases created in bb, or explicitly opened
// into bb, get a row — a Diffui account's other files stay in Diffui.
// ---------------------------------------------------------------------------

interface ThreadListProps {
  activeThreadId: string | null;
  activeProjectId: string | null;
  isCompactViewport: boolean;
  onNavigate: () => void;
  searchQuery: string;
  experimental_Original: ComponentType;
}

function DiffuiThreadList({ searchQuery, onNavigate, experimental_Original: Original }: ThreadListProps) {
  ensurePanelStyles();
  const rpcRef = useRpcRef();
  const navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();
  const [files, setFiles] = useState<CanvasRow[]>([]);
  const activeId = useActiveCanvasId();

  const refresh = useCallback(() => {
    void withOneRetry(() => rpcRef.current.call("listCanvases"))
      .then((result) => setFiles(result.canvases))
      .catch(() => undefined); // keep the last known rows on a transient failure
  }, [rpcRef]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (connection === "connected") refresh();
  }, [connection, refresh]);

  useRealtime("canvases", () => refresh());

  const query = searchQuery.trim().toLowerCase();
  const rows = useMemo(
    () => files.filter((file) => query === "" || file.title.toLowerCase().includes(query)),
    [files, query],
  );

  return (
    <div className="dfbb-threads">
      {rows.length > 0 ? (
        <div className="dfbb-threads-own">
          <p className="dfbb-threads-label">Diffui</p>
          <ul className="dfbb-threads-list">
            {rows.map((file) => (
              <li key={file.id}>
                <button
                  type="button"
                  className="dfbb-thread-row"
                  data-active={file.id === activeId ? "true" : "false"}
                  onClick={() => {
                    navigate.toPluginPanel("canvas", { subPath: file.id });
                    onNavigate();
                  }}
                >
                  <span className="dfbb-thread-icon">
                    <PaletteIcon />
                  </span>
                  <span className="dfbb-thread-title">{file.title}</span>
                  <span className="dfbb-thread-when">{timeAgo(file.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="dfbb-threads-rest">
        <Original />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread panel: the same Diffui canvas beside a thread.
// ---------------------------------------------------------------------------

function DiffuiThreadPanel({ params }: { threadId: string; params: unknown }) {
  const canvasId =
    params !== null && typeof params === "object" && typeof (params as { canvasId?: unknown }).canvasId === "string"
      ? (params as { canvasId: string }).canvasId
      : "";
  if (canvasId === "") {
    return (
      <div className="dfbb-panel">
        <div className="dfbb-panel-body">
          <p className="dfbb-panel-note">No Diffui canvas linked to this thread yet.</p>
        </div>
      </div>
    );
  }
  return <DiffuiCanvasSurface projectId={canvasId} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "diffui",
    title: "Diffui",
    icon: "Palette",
    path: "canvas",
    component: DiffuiPanel,
    headerContent: DiffuiPanelHeader,
  });
  app.slots.threadPanelAction({
    id: "diffui-canvas",
    title: "Diffui canvas",
    icon: "Palette",
    layout: "flush",
    component: DiffuiThreadPanel,
  });
  app.slots.experimental_threadList({
    id: "diffui-files",
    title: "Diffui files as threads",
    description:
      "Lists the canvases created in bb (or opened into bb) as palette-icon threads named after the file, above bb's thread list.",
    component: DiffuiThreadList,
  });
});

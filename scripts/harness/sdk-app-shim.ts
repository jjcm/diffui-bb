// Dev-harness stand-in for `@get-bb/plugin-sdk/app`, aliased in by
// scripts/e2e-harness.ts. It lets the REAL app.tsx render in a plain
// browser page against the REAL plugin backend (running under the SDK's fake
// host): useRpc proxies to that host's rpc handlers over /panel-rpc, and
// useRealtime rides a server-sent-events bridge over the fake host's
// realtime signals. Only the surfaces app.tsx touches are implemented; this
// file never ships in the plugin bundle.
import { createElement, useEffect, useState, type ComponentType, type ReactNode } from "react";

type NavListener = (subPath: string) => void;
const navListeners = new Set<NavListener>();

export function harnessNavigate(subPath: string): void {
  window.history.replaceState(null, "", `#${subPath}`);
  for (const listener of navListeners) listener(subPath);
}

export function harnessSubPath(): string {
  return window.location.hash.replace(/^#/, "");
}

export function onHarnessNavigate(listener: NavListener): () => void {
  navListeners.add(listener);
  return () => navListeners.delete(listener);
}

interface ThreadListProps {
  activeThreadId: string | null;
  activeProjectId: string | null;
  isCompactViewport: boolean;
  onNavigate: () => void;
  searchQuery: string;
  experimental_Original: ComponentType;
}

interface Registration {
  navPanels: Array<{
    id: string;
    title: string;
    path: string;
    component: ComponentType<{ subPath: string }>;
    /** Rendered by the HOST inside its own title bar (bb owns that bar). */
    headerContent?: ComponentType<{ subPath: string }>;
  }>;
  threadPanelActions: Array<{ id: string; title: string; component: ComponentType<{ threadId: string; params: unknown }> }>;
  threadLists: Array<{ id: string; title: string; component: ComponentType<ThreadListProps> }>;
}

export const harnessRegistrations: Registration = { navPanels: [], threadPanelActions: [], threadLists: [] };

export function definePluginApp(setup: (app: unknown) => void): { setup: (app: unknown) => void } {
  const collector = {
    slots: {
      navPanel(reg: Registration["navPanels"][number]) {
        harnessRegistrations.navPanels.push(reg);
      },
      threadPanelAction(reg: Registration["threadPanelActions"][number]) {
        harnessRegistrations.threadPanelActions.push(reg);
      },
      experimental_threadList(reg: Registration["threadLists"][number]) {
        harnessRegistrations.threadLists.push(reg);
      },
      homepageSection() {},
      settingsSection() {},
      experimental_newThreadPanelAction() {},
      pendingInteraction() {},
      sidebarFooterAction() {},
      experimental_threadHeaderAction() {},
      fileOpener() {},
      messageDirective() {},
      messageAction() {},
    },
    composer: { customize() {} },
    contentScripts: { register() {} },
  };
  setup(collector);
  return { setup };
}

export function useRpc<T = unknown>(): { call(method: string, input?: unknown): Promise<T> } {
  return {
    async call(method: string, input?: unknown) {
      const response = await fetch(`/panel-rpc/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input ?? null),
      });
      const body = (await response.json()) as { ok: boolean; result?: unknown; error?: { message?: string } };
      if (!body.ok) throw new Error(body.error?.message ?? "rpc failed");
      return body.result as T;
    },
  } as never;
}

// The realtime bridge: one EventSource over /panel-realtime, fanned out to
// per-channel handlers — the harness's stand-in for bb's realtime websocket.
type RealtimeHandler = (payload: unknown) => void;
const realtimeHandlers = new Map<string, Set<RealtimeHandler>>();
let realtimeSource: EventSource | null = null;

function ensureRealtimeSource(): void {
  if (realtimeSource !== null || typeof window === "undefined") return;
  realtimeSource = new EventSource("/panel-realtime");
  realtimeSource.onmessage = (event) => {
    let frame: { channel?: string; payload?: unknown } | null = null;
    try {
      frame = JSON.parse(event.data as string) as { channel?: string; payload?: unknown };
    } catch {
      return;
    }
    if (frame === null || typeof frame.channel !== "string") return;
    for (const handler of realtimeHandlers.get(frame.channel) ?? []) handler(frame.payload ?? null);
  };
}

export function useRealtime(channel: string, handler: (payload: unknown) => void): void {
  useEffect(() => {
    ensureRealtimeSource();
    let handlers = realtimeHandlers.get(channel);
    if (handlers === undefined) {
      handlers = new Set();
      realtimeHandlers.set(channel, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }, [channel, handler]);
}

export function useRealtimeConnectionState(): "connected" {
  return "connected";
}

export function useSettings(): { values: Record<string, string | boolean> | undefined; isLoading: boolean } {
  return { values: {}, isLoading: false };
}

export function useBbContext(): { projectId: string | null; threadId: string | null } {
  return { projectId: null, threadId: null };
}

export function useBbNavigate() {
  return {
    toThread(threadId: string) {
      const banner = document.getElementById("harness-banner");
      if (banner !== null) {
        banner.textContent = `bb would navigate to thread ${threadId} (useBbNavigate().toThread)`;
        banner.style.display = "block";
      }
    },
    toProject() {},
    toPluginPanel(_path: string, options?: { subPath?: string }) {
      harnessNavigate(options?.subPath ?? "");
    },
    toCompose() {},
    openThreadPanel() {
      return false;
    },
  };
}

export function useComposer(): Record<string, unknown> {
  return {};
}

export function useComposerView(): Record<string, unknown> {
  return {};
}

export function experimental_useSidebarThreads(): { status: string; threads: never[]; projects: never[] } {
  return { status: "ready", threads: [], projects: [] };
}

export function experimental_useSidebarThreadActions(): Record<string, unknown> {
  return {};
}

export const ThreadChat: ComponentType<{ threadId: string }> = () => null;
export const Markdown: ComponentType<{ content: string }> = ({ content }) => createElement("pre", null, content);
export const experimental_NewThreadComposer: ComponentType = () => null;

/** Panel root used by entry.tsx: renders the registered navPanel with live subPath. */
export function HarnessPanelHost({ children }: { children?: ReactNode }): ReactNode {
  const [subPath, setSubPath] = useState(harnessSubPath());
  useEffect(() => onHarnessNavigate(setSubPath), []);
  const panel = harnessRegistrations.navPanels[0];
  if (panel === undefined) return createElement("p", null, "no navPanel registered");
  return createElement(
    "div",
    { style: { height: "100%", minHeight: 0, display: "flex", flexDirection: "column" } },
    children,
    createElement(panel.component, { subPath }),
  );
}

/**
 * The plugin's contribution to the HOST's title bar, mounted into the shell's
 * one `#titlebar`. bb owns that bar and the SDK offers no way to hide it, so
 * this is where a plugin's page-level controls belong — and why the panel
 * itself ships no second bar.
 */
export function HarnessHeaderContentHost(): ReactNode {
  const [subPath, setSubPath] = useState(harnessSubPath());
  useEffect(() => onHarnessNavigate(setSubPath), []);
  const panel = harnessRegistrations.navPanels[0];
  const Header = panel?.headerContent;
  if (Header === undefined) return null;
  return createElement(Header, { subPath });
}

/** Stand-in for bb's own thread list, delegated to by the plugin's wrapper. */
function HarnessOriginalThreadList(): ReactNode {
  const rows = [
    { id: "thr_1", title: "Fix checkout tax rounding", when: "2h" },
    { id: "thr_2", title: "Diffui: Storefront checkout", when: "1d" },
  ];
  return createElement(
    "ul",
    { style: { listStyle: "none", margin: 0, padding: "2px 8px", display: "flex", flexDirection: "column", gap: 1 } },
    rows.map((row) =>
      createElement(
        "li",
        { key: row.id },
        createElement(
          "button",
          {
            type: "button",
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              height: 30,
              padding: "0 8px",
              border: 0,
              borderRadius: 7,
              background: "transparent",
              color: "var(--foreground)",
              font: "inherit",
              fontSize: 13,
              textAlign: "left",
              cursor: "pointer",
            },
          },
          createElement("span", { style: { color: "var(--muted-foreground)", fontSize: 12 } }, "◇"),
          createElement(
            "span",
            {
              style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
            },
            row.title,
          ),
          createElement("span", { style: { color: "var(--muted-foreground)", fontSize: 10 } }, row.when),
        ),
      ),
    ),
  );
}

/** Sidebar Threads area used by entry.tsx: renders the plugin's registered
 * thread-list replacement (files as threads) around bb's own list. */
export function HarnessThreadListHost(): ReactNode {
  const registration = harnessRegistrations.threadLists[0];
  if (registration === undefined) return createElement(HarnessOriginalThreadList);
  return createElement(registration.component, {
    activeThreadId: null,
    activeProjectId: null,
    isCompactViewport: false,
    onNavigate: () => undefined,
    searchQuery: "",
    experimental_Original: HarnessOriginalThreadList as ComponentType,
  });
}

// Diffui's real canvas, running inside bb — from the copy in this repository.
//
// `<diffui-canvas-workspace>` is a plain custom element with its own shadow DOM
// — nothing about it is React or Diffui-page specific — so bb mounts the SAME
// module the Diffui app runs rather than an imitation of it. That module and
// its whole import graph live here, under `canvas/diffui/`, mirrored file for
// file from Diffui's frontend (canvas/README.md). Hit-testing, pan/zoom, the
// tool rail, double-click, context menus, noodles, option stacks, comments,
// prompt editing, generation, undo, collab — all of it is Diffui's own code,
// bundled into the plugin. No iframe, no re-implementation, and no frontend
// asset fetched from a Diffui origin: the plugin talks to Diffui over its API
// only (JSON, files, websockets).
//
// The import below is a static specifier, so `bb plugin build` bundles the
// canvas into the plugin's app bundle; being an `import()` still defers the
// module's evaluation to the first mount, which is what lets the embed globals
// be assigned first.
//
// Those globals are Diffui's embed contract (its `embed-bridge.js`), and they
// are about the API and nothing else: with `window.DIFFUI_EMBED` set the
// element sends `Authorization: Bearer <api key>` with `credentials: "omit"`
// to `DIFFUI_API_BASE`, and puts the same key on the `access_token` query
// parameter of its websockets. `window.DIFFUI_BB_HOST` is not among them —
// upstream reads it to keep "Build with bb" off diffui.ai, and this copy only
// ever runs in bb, so it says so directly (see the patch set in
// scripts/diffui-canvas-bb-patches.mjs).

import { hostThemeName } from "./bb-canvas-theme.js";

/** The methods bb calls on the element. Everything else stays internal. */
export interface DiffuiCanvasElement extends HTMLElement {
  openProject(projectId: string): Promise<unknown>;
  refreshTheme?(): void;
}

export interface DiffuiEmbedSession {
  /** Diffui origin, e.g. "http://localhost:3040". Used for API calls only. */
  baseUrl: string;
  /** A `dui_…` API key. */
  apiKey: string;
}

interface EmbedWindow extends Window {
  DIFFUI_EMBED?: boolean;
  DIFFUI_API_BASE?: string;
  DIFFUI_API_KEY?: string;
}

const ELEMENT_NAME = "diffui-canvas-workspace";

let loadPromise: Promise<void> | null = null;

/**
 * Puts the embed contract in place and evaluates the canvas once per page.
 *
 * Re-entrant: later calls reuse the same promise, and a re-keyed install just
 * updates the globals the element reads on its next request.
 */
export async function loadDiffuiCanvas(session: DiffuiEmbedSession): Promise<void> {
  const view = window as EmbedWindow;
  view.DIFFUI_EMBED = true;
  view.DIFFUI_API_BASE = session.baseUrl.replace(/\/+$/, "");
  view.DIFFUI_API_KEY = session.apiKey;
  // The canvas reads the app theme off the document root. Mirroring bb's
  // resolved mode there is what keeps the few places its shadow CSS keys on
  // `data-theme` (an inline SVG stroke, a checkmark glyph) on the right side of
  // the light/dark split — the colours themselves ride the tokens.
  document.documentElement.dataset.appTheme = hostThemeName();
  if (loadPromise === null) {
    loadPromise = (async () => {
      // Diffui's canvas, from canvas/diffui/. Deferred to here so the globals
      // above are already set when the module evaluates: it reads them while
      // it does.
      await import("./diffui-bb/vendored-canvas.js");
      await customElements.whenDefined(ELEMENT_NAME);
    })().catch((error: unknown) => {
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}

/** Creates the element and opens one canvas on it. */
export async function mountDiffuiCanvas(
  container: HTMLElement,
  projectId: string,
  session: DiffuiEmbedSession,
): Promise<DiffuiCanvasElement> {
  await loadDiffuiCanvas(session);
  const element = document.createElement(ELEMENT_NAME) as DiffuiCanvasElement;
  container.appendChild(element);
  await element.openProject(projectId);
  return element;
}

/**
 * Follows bb's light/dark switch. bb retunes its own tokens without touching
 * this document's `data-app-theme`, so the mirror is refreshed and the element
 * is asked to re-resolve the colours its 2D context paints with.
 */
export function watchHostTheme(element: () => DiffuiCanvasElement | null): () => void {
  if (typeof document === "undefined") return () => undefined;
  const apply = () => {
    const theme = hostThemeName();
    if (document.documentElement.dataset.appTheme !== theme) {
      document.documentElement.dataset.appTheme = theme;
    }
    element()?.refreshTheme?.();
  };
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "data-mode", "style"],
  });
  const media = window.matchMedia?.("(prefers-color-scheme: light)");
  media?.addEventListener("change", apply);
  return () => {
    observer.disconnect();
    media?.removeEventListener("change", apply);
  };
}

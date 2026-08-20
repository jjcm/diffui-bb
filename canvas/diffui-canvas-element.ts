// Diffui's real canvas, running inside bb.
//
// `<diffui-canvas-workspace>` is a plain custom element with its own shadow DOM
// — nothing about it is React or Diffui-page specific — so bb mounts the SAME
// module the Diffui app serves rather than an imitation of it. The module is
// dynamically imported AT RUNTIME from the configured Diffui origin
// (`session.baseUrl`, i.e. DIFFUI_API_BASE): this repository carries no copy of
// Diffui frontend source, no vendored snapshot to drift, no simplified
// re-implementation, and no iframe. Hit-testing, pan/zoom, the tool rail,
// double-click, context menus, noodles, option stacks, comments, prompt
// editing, generation, undo, collab — all of it is the Diffui instance's own
// code, at whatever version that instance is running. (Diffui serves its
// frontend modules with bearer-only CORS for exactly this, so the import
// resolves cross-origin from a bb plugin page.)
//
// The element already supports being embedded (Diffui's embed-bridge.js): with
// `window.DIFFUI_EMBED` set it sends `Authorization: Bearer <api key>` with
// `credentials: "omit"` to `DIFFUI_API_BASE`, and puts the same key on the
// `access_token` query parameter of its websockets. That is why the globals are
// assigned BEFORE the dynamic import: the module reads them while it evaluates.
// `window.DIFFUI_BB_HOST` is part of the same contract — Diffui's canvas hides
// "Build with bb" unless the page hosting it declares itself a bb host, so the
// action stays plugin-only and never appears in the Diffui web app itself.

import { hostThemeName } from "./bb-canvas-theme.js";

/** The methods bb calls on the element. Everything else stays internal. */
export interface DiffuiCanvasElement extends HTMLElement {
  openProject(projectId: string): Promise<unknown>;
  refreshTheme?(): void;
}

export interface DiffuiEmbedSession {
  /** Diffui origin, e.g. "http://localhost:3040". */
  baseUrl: string;
  /** A `dui_…` API key. */
  apiKey: string;
}

interface EmbedWindow extends Window {
  DIFFUI_EMBED?: boolean;
  DIFFUI_BB_HOST?: boolean;
  DIFFUI_API_BASE?: string;
  DIFFUI_API_KEY?: string;
}

const ELEMENT_NAME = "diffui-canvas-workspace";

/** The product canvas module, on the Diffui origin that serves it. */
export const CANVAS_MODULE_PATH = "/app/components/diffui-canvas-workspace.js";

/** The module URL the plugin imports for a given Diffui origin. */
export function canvasModuleUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${CANVAS_MODULE_PATH}`;
}

let loadPromise: Promise<void> | null = null;

/**
 * Puts the embed contract in place and loads the canvas module once per page.
 *
 * Re-entrant: later calls reuse the same promise, and a re-keyed install just
 * updates the globals the element reads on its next request. A custom element
 * can only be defined once per page, so the first origin to load wins — bb
 * configures exactly one Diffui instance, which makes that a non-event.
 */
export async function loadDiffuiCanvas(session: DiffuiEmbedSession): Promise<void> {
  const view = window as EmbedWindow;
  view.DIFFUI_EMBED = true;
  // Before the module evaluates, so "Build with bb" is offered in bb and
  // nowhere else. Diffui's canvas checks this global when deciding whether the
  // context menus carry the action at all.
  view.DIFFUI_BB_HOST = true;
  view.DIFFUI_API_BASE = session.baseUrl.replace(/\/+$/, "");
  view.DIFFUI_API_KEY = session.apiKey;
  // The canvas reads the app theme off the document root. Mirroring bb's
  // resolved mode there is what keeps the few places its shadow CSS keys on
  // `data-theme` (an inline SVG stroke, a checkmark glyph) on the right side of
  // the light/dark split — the colours themselves ride the tokens.
  document.documentElement.dataset.appTheme = hostThemeName();
  if (loadPromise === null) {
    loadPromise = (async () => {
      // The Diffui product canvas, imported as-is from the configured Diffui
      // origin. The specifier is a runtime value, so esbuild leaves the import
      // in place instead of trying to bundle it — the module (and its own
      // relative import graph) always comes from the server it talks to.
      await import(/* @vite-ignore */ canvasModuleUrl(session.baseUrl));
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

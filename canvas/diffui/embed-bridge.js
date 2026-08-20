/** Cursor / IDE embed: API key auth and parent-frame messaging. */

import { bbCanvasAsset } from "../diffui-bb/canvas-assets.js";

export function isCanvasEmbedPath(pathname = window.location.pathname) {
  const p = pathname.replace(/\/+$/, "") || "/";
  return /\/canvas\/[^/]+\/embed$/.test(p) || /\/app\/canvas\/[^/]+\/embed$/.test(p);
}

export function initEmbedGlobals() {
  if (!isCanvasEmbedPath()) return false;
  window.DIFFUI_EMBED = true;
  document.body.dataset.diffuiEmbed = "true";
  const nav = document.getElementById("appNav");
  if (nav) nav.style.display = "none";
  document.body.style.margin = "0";
  return true;
}

export function resolveEmbedApiUrl(path) {
  const base = String(window.DIFFUI_API_BASE || window.location.origin).replace(/\/+$/, "");
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Server-relative asset path (`/files/...`, `/app/assets/...`) as the embedder must
 * request it.
 *
 * Only an embed rewrites anything. An embedded canvas is mounted in the HOST's page —
 * a bb plugin panel, an IDE webview — so its document base is the host's origin and a
 * relative path would resolve there instead of at Diffui. In the Diffui app itself the
 * path is already correct and is returned untouched, which keeps relative URLs (and
 * their cache keys) exactly as they are today.
 */
export function resolveEmbedAssetUrl(path) {
  const p = String(path ?? "").trim();
  // bb: the canvas's own sprites are vendored into the plugin bundle, so they
  // resolve to a data URL and never become a request to the Diffui origin.
  // Everything else (/files/..., API paths) still resolves against the API
  // base below.
  const bundled = bbCanvasAsset(p);
  if (bundled !== "") return bundled;
  if (p === "" || typeof window === "undefined" || window.DIFFUI_EMBED !== true) return p;
  if (!p.startsWith("/") || p.startsWith("//")) return p;
  const base = String(window.DIFFUI_API_BASE || "").replace(/\/+$/, "");
  return base === "" ? p : `${base}${p}`;
}

export function embedFetchHeaders(extra = {}) {
  const headers = { "Content-Type": "application/json", ...extra };
  const key = String(window.DIFFUI_API_KEY || "").trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export function wireEmbedParentBridge(workspace) {
  if (!window.DIFFUI_EMBED || !workspace) return;
  let configured = false;
  const openWhenReady = () => {
    const projectId = String(window.DIFFUI_EMBED_PROJECT_ID || "").trim();
    if (!configured || !projectId) return;
    workspace.openProject?.(projectId).catch(() => null);
  };

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    const type = String(data.type || "");
    if (type === "diffui:configure") {
      if (data.apiBaseUrl) window.DIFFUI_API_BASE = String(data.apiBaseUrl).replace(/\/+$/, "");
      if (data.apiKey) window.DIFFUI_API_KEY = String(data.apiKey);
      if (data.projectId) window.DIFFUI_EMBED_PROJECT_ID = String(data.projectId);
      configured = true;
      openWhenReady();
      return;
    }
    if (type === "diffui:apply-ops") {
      workspace.applyEmbedOps?.(data.ops || []);
      return;
    }
    if (type === "diffui:agent-cursor") {
      workspace.setAgentCursor?.(String(data.agentId || "agent"), Number(data.x) || 0, Number(data.y) || 0, {
        label: data.label,
        color: data.color,
      });
      return;
    }
    if (type === "diffui:request-state-snapshot") {
      const state = workspace.getCanvasStateSnapshot?.();
      if (state && window.parent !== window) {
        window.parent.postMessage({ type: "diffui:state-snapshot", state }, "*");
      }
    }
  });

  const notifyReady = () => {
    if (window.parent !== window) {
      window.parent.postMessage({ type: "diffui:canvas-ready" }, "*");
    }
  };
  if (workspace.isConnected) notifyReady();
  else workspace.addEventListener("connected", notifyReady, { once: true });
  customElements.whenDefined("diffui-canvas-workspace").then(() => notifyReady());
}

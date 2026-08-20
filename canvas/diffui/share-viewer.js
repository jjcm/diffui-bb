/**
 * Signed-out viewing of a canvas opened through a public "anyone with the link
 * can view" share link.
 *
 * There is no session cookie in this state: the `?share=` token is the only
 * credential the visitor has, so it must ride along on every canvas API call
 * (as a header) and every websocket handshake (as a query parameter, since
 * WebSocket cannot send headers). The server re-validates the token on each
 * request and only ever grants read-only access to the token's own project.
 */

import { stripAppPrefix } from "./router.js";

export const SHARE_TOKEN_HEADER = "X-Diffui-Share-Token";

const VIEWER_NAME_STORAGE_PREFIX = "diffui.share.viewerName:";

let shareToken = "";
let viewerName = "";

/**
 * The presence name is remembered per token for the tab so re-validating the
 * link (e.g. after an abandoned sign-in) does not rename the viewer mid-session.
 */
function storedViewerName(token) {
  try {
    return String(sessionStorage.getItem(VIEWER_NAME_STORAGE_PREFIX + token) || "").trim();
  } catch {
    return "";
  }
}

function storeViewerName(token, name) {
  try {
    sessionStorage.setItem(VIEWER_NAME_STORAGE_PREFIX + token, name);
  } catch {
    // Private browsing modes can reject sessionStorage; the name is cosmetic.
  }
}

/** The `?share=` token when the URL is a canvas board link, else "". */
export function publicShareTokenFromLocation(
  pathname = window.location.pathname,
  search = window.location.search,
) {
  const p = stripAppPrefix(pathname);
  if (!/^\/canvas\/[^/]+$/.test(p)) return "";
  return String(new URLSearchParams(search || "").get("share") || "").trim();
}

/**
 * Enter anonymous share-viewer mode. The presence name comes from the server so
 * every anonymous viewer of a board is named consistently with the others.
 */
export function setPublicShareViewer({ token, name } = {}) {
  const nextToken = String(token || "").trim();
  if (!nextToken) {
    clearPublicShareViewer();
    return;
  }
  shareToken = nextToken;
  viewerName = storedViewerName(nextToken) || String(name || "").trim() || "Anonymous viewer";
  storeViewerName(nextToken, viewerName);
  // The collab awareness payload reads these globals, so an anonymous viewer
  // joins presence under the generated name with no account id or avatar.
  delete window.DIFFUI_USER_ID;
  delete window.DIFFUI_USER_AVATAR;
  window.DIFFUI_USER_NAME = viewerName;
  window.DIFFUI_SHARE_VIEWER = true;
}

export function clearPublicShareViewer() {
  if (shareToken) delete window.DIFFUI_USER_NAME;
  shareToken = "";
  viewerName = "";
  delete window.DIFFUI_SHARE_VIEWER;
}

export function isPublicShareViewer() {
  return !!shareToken;
}

export function publicShareToken() {
  return shareToken;
}

export function publicShareViewerName() {
  return viewerName;
}

/** Adds the share token header to a fetch header bag when in viewer mode. */
export function publicShareFetchHeaders(headers = {}) {
  if (!shareToken) return headers;
  return { ...headers, [SHARE_TOKEN_HEADER]: shareToken };
}

/** Adds `share=<token>` to a websocket URL when in viewer mode. */
export function withPublicShareParam(url) {
  if (!shareToken) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}share=${encodeURIComponent(shareToken)}`;
}

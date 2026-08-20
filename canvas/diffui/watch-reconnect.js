/**
 * Shared reconnect logic for /watch websocket connections.
 *
 * - Exponential backoff with jitter for transient disconnects
 * - Auth probe on failed handshake to detect expired sessions
 * - Terminal auth failure stops further reconnects
 */

/**
 * Compute reconnect delay with exponential backoff and ±25 % jitter.
 * Starts at ~1 s, doubles each attempt, caps at 30 s.
 */
export function reconnectDelay(attempt) {
  const base = Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 5)));
  const jitter = base * 0.25 * (2 * Math.random() - 1);
  return Math.max(500, Math.round(base + jitter));
}

/**
 * Returns true when the close event looks like a rejected WebSocket
 * handshake (HTTP 401/403 before upgrade).  Browsers surface these as
 * code 1006 + wasClean: false with no reason text.
 */
export function looksLikeAuthClose(closeEvent) {
  return !!closeEvent && closeEvent.code === 1006 && !closeEvent.wasClean;
}

/**
 * Probe `/api/me` to check whether the session cookie is still valid.
 * Returns `true` if authenticated, `false` on 401/403.
 * Network errors are treated as transient (returns `true`).
 */
export async function isSessionValid() {
  try {
    const res = await fetch("/api/me", { credentials: "include" });
    return res.ok;
  } catch {
    return true;
  }
}

/**
 * Dispatch a global event so app.js (and anyone else) can clean up auth
 * state when a watch socket discovers the session has expired.
 */
export function notifySessionExpired() {
  window.dispatchEvent(new CustomEvent("diffui-session-expired"));
}

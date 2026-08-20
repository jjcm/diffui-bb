/**
 * First-party UI click telemetry: the browser half.
 *
 * `trackUIClick` is called from the user-intent boundary in components (a tool
 * chosen, a menu item picked, a toolbar icon clicked) and must never be able to
 * affect them. It queues into `UITelemetryQueue` and returns; nothing here
 * awaits, throws, or touches the UI. Flushes happen when a batch fills, on a
 * timer, and on pagehide.
 *
 * This is diffui's own product telemetry, not ad tracking, so it is not gated
 * on cookie consent — the same contract `analytics.js` page views follow (see
 * docs/consent_and_tracking.md). What makes that defensible is the payload:
 * `ui-telemetry-queue.js` allows a closed set of event names and property keys,
 * and the server re-checks both, so prompt text, image data, and emails have no
 * path into this stream.
 */

import { UITelemetryQueue, UI_TELEMETRY_EVENTS } from "./ui-telemetry-queue.js";

export { UI_TELEMETRY_EVENTS };

const ENDPOINT = "/api/analytics/ui-clicks";

/** How often a partially filled queue is flushed anyway. */
const FLUSH_INTERVAL_MS = 5000;

const queue = new UITelemetryQueue();

let flushTimer = 0;
let installed = false;
let flushing = false;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    flush();
  }, FLUSH_INTERVAL_MS);
}

/**
 * Send one batch.
 *
 * `sendBeacon` is used while the page is going away because it is the only
 * transport the browser guarantees to finish; everywhere else `fetch` is used
 * so a failed batch can be requeued, which a beacon cannot report.
 */
function send(events, useBeacon) {
  const body = JSON.stringify({ events });
  if (useBeacon && navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon(ENDPOINT, blob)) return Promise.resolve(true);
  }
  return fetch(ENDPOINT, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  })
    .then((response) => response.ok)
    .catch(() => false);
}

/**
 * Flush queued events.
 *
 * @param {object} options
 * @param {boolean} options.final drain everything with a beacon; used on pagehide.
 */
export function flush({ final = false } = {}) {
  if (flushing && !final) return Promise.resolve();
  const events = queue.takeBatch(final);
  if (!events.length) return Promise.resolve();
  if (final) {
    send(events, true);
    return Promise.resolve();
  }
  flushing = true;
  return send(events, false)
    .then((ok) => {
      if (!ok) queue.requeue(events);
    })
    .finally(() => {
      flushing = false;
    });
}

/**
 * Record one interaction. Safe to call from anywhere: it never throws and
 * never blocks.
 *
 * @param {string} name one of UI_TELEMETRY_EVENTS.
 * @param {object} options
 * @param {string} options.target the surface acted on (tool id, menu id, toolbar id).
 * @param {string} options.action the item or verb within that surface.
 * @param {string} options.projectId the canvas project, when there is one.
 * @param {object} options.props allowlisted enum/id/count properties.
 */
export function trackUIClick(name, options = {}) {
  try {
    if (!queue.add(name, options)) return;
    installUITelemetry();
    if (queue.shouldFlush()) flush();
    else scheduleFlush();
  } catch {
    // Telemetry must never surface in the product.
  }
}

/**
 * Install the page-lifecycle flush handlers. Called automatically on the first
 * tracked event, so importing this module costs nothing.
 */
export function installUITelemetry() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  // pagehide is the reliable teardown signal (bfcache included); the hidden
  // visibility change additionally covers a tab switch on mobile, where the
  // page may never fire pagehide before being discarded.
  window.addEventListener("pagehide", () => flush({ final: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush({ final: true });
  });
}

/** Queue counters, for debugging a session in the console. */
export function uiTelemetryStats() {
  return { queued: queue.size, dropped: queue.dropped, deduped: queue.deduped };
}

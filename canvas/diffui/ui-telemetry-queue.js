/**
 * The batching rules behind first-party UI click telemetry.
 *
 * Kept pure — no timers, no fetch, no DOM — so the parts that decide what is
 * worth sending can be tested without a browser. `ui-telemetry.js` owns the
 * timers and the transport and drives this queue.
 *
 * Three rules, in the order they matter:
 *
 * 1. Never grow without bound. A canvas left open all day must not turn a
 *    dropped network into a memory leak, so the queue has a hard cap and sheds
 *    its *oldest* events when full: recent interaction is what anyone will look
 *    at, and the alternative — refusing new events — would silently freeze the
 *    stream at whatever was queued when the network died.
 * 2. Collapse trivial double-fires. A pointerdown that also fires a click, or a
 *    hotkey held down, should not read as two intentional uses.
 * 3. Flush on size so a busy session reaches the server in near real time,
 *    while `ui-telemetry.js` also flushes on an interval and on pagehide so a
 *    quiet session is not lost.
 */

/** Events per flush. Small enough that a sendBeacon payload stays well inside the ingest body limit. */
export const UI_TELEMETRY_BATCH_SIZE = 25;

/** Hard cap on queued events. Beyond this the oldest are dropped. */
export const UI_TELEMETRY_MAX_QUEUE = 200;

/** Identical events closer together than this are treated as one. */
export const UI_TELEMETRY_DEDUPE_MS = 250;

/** Event names the server allowlists. Anything else is dropped before it is queued. */
export const UI_TELEMETRY_EVENTS = Object.freeze({
  CANVAS_TOOL_SELECT: "canvas_tool_select",
  CANVAS_TOOL_USE: "canvas_tool_use",
  CONTEXT_MENU_OPEN: "context_menu_open",
  CONTEXT_MENU_ITEM_CLICK: "context_menu_item_click",
  NODE_TOOLBAR_CLICK: "node_toolbar_click",
});

const KNOWN_EVENT_NAMES = new Set(Object.values(UI_TELEMETRY_EVENTS));

/** Property keys the server keeps. Others are dropped here so they never leave the browser. */
export const UI_TELEMETRY_PROP_KEYS = Object.freeze([
  "source",
  "outcome",
  "node_type",
  "tool",
  "selection_size",
]);

const ALLOWED_PROP_KEYS = new Set(UI_TELEMETRY_PROP_KEYS);

function isUUID(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

/** Keep only allowlisted keys with scalar values, so no free text can be queued. */
function cleanProps(props) {
  if (!props || typeof props !== "object") return null;
  const clean = {};
  for (const key of Object.keys(props)) {
    if (!ALLOWED_PROP_KEYS.has(key)) continue;
    const value = props[key];
    if (typeof value === "string" && value) clean[key] = value;
    else if (typeof value === "boolean") clean[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) clean[key] = Math.trunc(value);
  }
  return Object.keys(clean).length ? clean : null;
}

/** The identity a double-fire would repeat. Timestamps are deliberately excluded. */
function dedupeKey(event) {
  return [
    event.name,
    event.target || "",
    event.action || "",
    event.project_id || "",
    JSON.stringify(event.props || null),
  ].join("|");
}

export class UITelemetryQueue {
  /**
   * @param {object} options
   * @param {() => number} options.now epoch milliseconds; injected so tests control time.
   * @param {number} options.batchSize events per flush.
   * @param {number} options.maxQueue hard cap before the oldest are shed.
   * @param {number} options.dedupeMs window in which an identical event is a double-fire.
   */
  constructor({
    now = () => Date.now(),
    batchSize = UI_TELEMETRY_BATCH_SIZE,
    maxQueue = UI_TELEMETRY_MAX_QUEUE,
    dedupeMs = UI_TELEMETRY_DEDUPE_MS,
  } = {}) {
    this._now = now;
    this._batchSize = batchSize;
    this._maxQueue = maxQueue;
    this._dedupeMs = dedupeMs;
    this._events = [];
    this._lastSeen = new Map();
    this._dropped = 0;
    this._deduped = 0;
  }

  get size() {
    return this._events.length;
  }

  /** Events shed because the queue was full, for diagnostics. */
  get dropped() {
    return this._dropped;
  }

  /** Events collapsed as double-fires, for diagnostics. */
  get deduped() {
    return this._deduped;
  }

  /**
   * Queue one interaction.
   *
   * @returns {boolean} whether it was queued (false means unknown, duplicate, or unusable).
   */
  add(name, { target = "", action = "", projectId = "", props = null } = {}) {
    if (!KNOWN_EVENT_NAMES.has(name) || !action) return false;
    const event = {
      name,
      target: String(target || ""),
      action: String(action),
      ts: this._now(),
    };
    if (isUUID(projectId)) event.project_id = projectId;
    const cleaned = cleanProps(props);
    if (cleaned) event.props = cleaned;

    const key = dedupeKey(event);
    const last = this._lastSeen.get(key);
    if (last !== undefined && event.ts - last < this._dedupeMs) {
      this._deduped += 1;
      return false;
    }
    this._lastSeen.set(key, event.ts);
    this._pruneDedupeMemory(event.ts);

    this._events.push(event);
    while (this._events.length > this._maxQueue) {
      this._events.shift();
      this._dropped += 1;
    }
    return true;
  }

  /** Whether enough has piled up to be worth a request. */
  shouldFlush() {
    return this._events.length >= this._batchSize;
  }

  /**
   * Remove and return the next batch, oldest first.
   *
   * @param {boolean} all take everything rather than one batch (used on pagehide).
   */
  takeBatch(all = false) {
    if (!this._events.length) return [];
    const count = all ? this._events.length : Math.min(this._batchSize, this._events.length);
    return this._events.splice(0, count);
  }

  /**
   * Put a failed batch back at the front so the next flush retries it.
   *
   * The cap still wins, and it still sheds the oldest — which is the batch just
   * requeued. That is deliberate: a queue this full means the network is gone,
   * and at that point the interactions happening now are worth more than a
   * retry of the ones that already failed.
   */
  requeue(events) {
    if (!Array.isArray(events) || !events.length) return;
    this._events.unshift(...events);
    while (this._events.length > this._maxQueue) {
      this._events.shift();
      this._dropped += 1;
    }
  }

  /** Forget dedupe keys older than the window so the map cannot grow unbounded. */
  _pruneDedupeMemory(now) {
    if (this._lastSeen.size < 256) return;
    for (const [key, seen] of this._lastSeen) {
      if (now - seen >= this._dedupeMs) this._lastSeen.delete(key);
    }
  }
}

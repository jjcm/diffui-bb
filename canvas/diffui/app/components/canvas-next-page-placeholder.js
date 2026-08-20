/**
 * Placeholder typewriter for prompt nodes dragged off an image node's output
 * handle (`<diffui-canvas-workspace>`).
 *
 * A brand new fork node has nothing in it, so instead of the static "Describe
 * the UI you want..." copy it cycles the pages you would navigate to from the
 * screen it is connected to. Only `textarea.placeholder` is ever written; the
 * value belongs to the user.
 *
 * Timings are intentionally small and tunable: erase a little faster than we
 * type, then sit on the finished suggestion long enough to read it.
 */

export const NEXT_PAGE_PLACEHOLDER_TIMINGS = Object.freeze({
  /** Per character while erasing the text that is already there. */
  backspaceMs: 14,
  /** Per character while typing a suggestion out. */
  typeMs: 18,
  /** How long a fully typed suggestion stays up before the next one. */
  holdMs: 2200,
});

/** Longest a single suggestion may be before it is cut down for the placeholder. */
const MAX_SUGGESTION_LENGTH = 160;

/** How many suggestions the cycle runs through before looping. */
export const NEXT_PAGE_PLACEHOLDER_SUGGESTION_COUNT = 5;

/**
 * Coerce an API payload into placeholder-ready strings: non-strings dropped,
 * whitespace collapsed, duplicates removed, list capped.
 */
export function normalizeNextPageSuggestions(values, limit = NEXT_PAGE_PLACEHOLDER_SUGGESTION_COUNT) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== "string") continue;
    const suggestion = value.replace(/\s+/g, " ").trim().slice(0, MAX_SUGGESTION_LENGTH);
    if (!suggestion) continue;
    const key = suggestion.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(suggestion);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Erases whatever placeholder is showing, types the next suggestion, holds it,
 * and repeats forever. The textarea is resolved through `getTextarea` on every
 * tick so a prompt box that gets culled and rebuilt keeps animating, and a
 * removed node stops the cycle.
 */
export class NextPagePlaceholderCycle {
  constructor({ getTextarea, defaultText = "", suggestions = [], timings, shouldStop, schedule, cancel } = {}) {
    this._getTextarea = typeof getTextarea === "function" ? getTextarea : () => null;
    this._defaultText = String(defaultText || "");
    this._suggestions = normalizeNextPageSuggestions(suggestions);
    this._timings = { ...NEXT_PAGE_PLACEHOLDER_TIMINGS, ...(timings || {}) };
    this._shouldStop = typeof shouldStop === "function" ? shouldStop : () => false;
    this._schedule = typeof schedule === "function" ? schedule : (fn, ms) => window.setTimeout(fn, ms);
    this._cancel = typeof cancel === "function" ? cancel : (handle) => window.clearTimeout(handle);
    this._timer = 0;
    this._running = false;
    this._index = 0;
  }

  get running() {
    return this._running;
  }

  get suggestions() {
    return this._suggestions.slice();
  }

  /** Returns true when the cycle actually took over a textarea. */
  start() {
    if (this._running || !this._suggestions.length) return false;
    if (!this._textarea()) return false;
    this._running = true;
    this._index = 0;
    this._erase();
    return this._running;
  }

  /** Stops the cycle and puts the default placeholder back. */
  stop() {
    if (this._timer) this._cancel(this._timer);
    this._timer = 0;
    if (!this._running) return;
    this._running = false;
    const textarea = this._getTextarea();
    if (textarea) textarea.placeholder = this._defaultText;
  }

  _textarea() {
    const textarea = this._getTextarea();
    if (!textarea) return null;
    if (textarea.isConnected === false) return null;
    return textarea;
  }

  _step(delay, run) {
    this._timer = this._schedule(() => {
      this._timer = 0;
      if (!this._running) return;
      if (this._shouldStop()) {
        this.stop();
        return;
      }
      const textarea = this._textarea();
      if (!textarea) {
        this.stop();
        return;
      }
      run(textarea);
    }, delay);
  }

  _erase() {
    const textarea = this._textarea();
    if (!textarea) {
      this.stop();
      return;
    }
    const current = String(textarea.placeholder || "");
    if (!current) {
      this._type();
      return;
    }
    this._step(this._timings.backspaceMs, (target) => {
      target.placeholder = String(target.placeholder || "").slice(0, -1);
      this._erase();
    });
  }

  _type() {
    const textarea = this._textarea();
    if (!textarea) {
      this.stop();
      return;
    }
    const suggestion = this._suggestions[this._index] || "";
    const current = String(textarea.placeholder || "");
    if (current.length >= suggestion.length) {
      this._step(this._timings.holdMs, () => {
        this._index = (this._index + 1) % this._suggestions.length;
        this._erase();
      });
      return;
    }
    this._step(this._timings.typeMs, (target) => {
      target.placeholder = suggestion.slice(0, String(target.placeholder || "").length + 1);
      this._type();
    });
  }
}

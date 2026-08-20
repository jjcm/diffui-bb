/**
 * Serialisation and retry policy for `PUT /api/projects/{id}/canvas`.
 *
 * The canvas is one JSON document behind a compare-and-set on `version`
 * (see docs/canvas_concurrency.md). Two things used to make that check fail far
 * more often than it had to:
 *
 * - The tab fired saves concurrently. `_saveState()` was called directly from
 *   generate, click-prompt and prompt-suggestions on top of the debounced
 *   autosave, so two PUTs could be in flight carrying the same `baseVersion`.
 *   The second one always lost, and it lost to *this same tab*.
 * - A lost race was retried exactly once. While a generation worker commits
 *   images the version moves on every commit, so the retry frequently landed on
 *   a version that had already moved again and surfaced the 409 to the caller —
 *   which is how double-click ended up recording
 *   `clickPromptStatus: "canvas_version_conflict"`.
 *
 * `CanvasSaveQueue` fixes the first: one save at a time, and everything asked
 * for while a save is running collapses into a single follow-up save (the
 * document is written whole, so the follow-up subsumes every request that
 * arrived during the run). `canvasSaveRetryDelayMs` fixes the second: a bounded
 * backoff with jitter, so overlapping writers stagger rather than colliding
 * again on the same tick.
 */

/** How many times one logical save re-reads, rebases and writes again. */
export const CANVAS_SAVE_ATTEMPTS = 5;

const RETRY_BASE_MS = 60;
const RETRY_MAX_MS = 800;

/**
 * Backoff before retry `attempt` (1 = the first retry after the initial write).
 *
 * Exponential up to RETRY_MAX_MS, then jittered across the lower half of the
 * window: two tabs that conflicted on the same version must not wake together.
 */
export function canvasSaveRetryDelayMs(attempt, random = Math.random) {
  const step = Math.max(1, Math.floor(Number(attempt) || 1));
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (step - 1));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/**
 * Runs one async save at a time and coalesces concurrent requests.
 *
 * `run()` resolves once a save that reflects the caller's state has completed:
 * if nothing is in flight the caller's own run, otherwise the single follow-up
 * run scheduled after the current one. A failed run rejects only the callers
 * waiting on it; the queue stays usable.
 */
export class CanvasSaveQueue {
  /** @param {() => Promise<any>} perform writes the current document. */
  constructor(perform) {
    this._perform = perform;
    this._running = null;
    this._pending = null;
  }

  /** True while a save is in flight. */
  get busy() {
    return this._running !== null;
  }

  run() {
    if (!this._running) {
      this._running = this._drain();
      return this._running;
    }
    // A follow-up is already queued; every caller that arrives during this run
    // wants the same thing — the document as it stands when the run starts.
    if (!this._pending) {
      this._pending = this._running.catch(() => null).then(() => {
        this._pending = null;
        this._running = this._drain();
        return this._running;
      });
    }
    return this._pending;
  }

  async _drain() {
    try {
      return await this._perform();
    } finally {
      this._running = null;
    }
  }
}

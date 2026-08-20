/**
 * Copy and hover timing for the canvas left-toolbar tooltips.
 *
 * The bubble waits out a deliberate hover before it appears, but once one has
 * been on screen the group stays "warm" for a moment so sweeping across the
 * tools reads their names instantly. Leaving the cluster keeps the last bubble
 * up briefly instead of snapping it away.
 */

export const TOOL_TOOLTIP_SHOW_DELAY_MS = 1500;
export const TOOL_TOOLTIP_INSTANT_FOLLOW_MS = 2000;
export const TOOL_TOOLTIP_HIDE_DELAY_MS = 1500;

/** Keyed by toolbar button id, in the order the buttons sit in the sidebar. */
export const CANVAS_TOOL_TOOLTIPS = Object.freeze({
  toolRect: Object.freeze({ name: "Rectangle", hotkey: "R" }),
  toolFind: Object.freeze({ name: "Find", hotkey: "F" }),
  toolMove: Object.freeze({ name: "Pointer", hotkey: "V" }),
  toolEdit: Object.freeze({ name: "Edit", hotkey: "E" }),
  toolDuplicate: Object.freeze({ name: "Duplicate", hotkey: "D" }),
  toolComment: Object.freeze({ name: "Comment", hotkey: "C" }),
});

export class ToolTooltipScheduler {
  constructor({
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    onShow = () => {},
    onHide = () => {},
    showDelayMs = TOOL_TOOLTIP_SHOW_DELAY_MS,
    instantFollowMs = TOOL_TOOLTIP_INSTANT_FOLLOW_MS,
    hideDelayMs = TOOL_TOOLTIP_HIDE_DELAY_MS,
  } = {}) {
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._onShow = onShow;
    this._onHide = onHide;
    this.showDelayMs = showDelayMs;
    this.instantFollowMs = instantFollowMs;
    this.hideDelayMs = hideDelayMs;
    this.visibleToolId = "";
    this.pendingToolId = "";
    this._timer = 0;
    this._timerKind = "";
    this._hiddenAt = -Infinity;
  }

  get visible() {
    return this.visibleToolId !== "";
  }

  /** True while a hover should skip the delay because a bubble was just up. */
  get warm() {
    return this.visible || this._now() - this._hiddenAt < this.instantFollowMs;
  }

  hover(toolId) {
    const id = String(toolId || "");
    if (!id) return;
    if (this.visibleToolId === id) {
      this._cancelTimer();
      return;
    }
    if (this._timerKind === "show" && this.pendingToolId === id) return;
    const warm = this.warm;
    this._cancelTimer();
    if (warm) {
      this._show(id);
      return;
    }
    this.pendingToolId = id;
    this._timerKind = "show";
    this._timer = this._setTimer(() => {
      this._timer = 0;
      this._timerKind = "";
      this._show(id);
    }, this.showDelayMs);
  }

  /** The pointer left the whole tool cluster; moving between tools does not. */
  leave() {
    this._cancelTimer();
    if (!this.visible) return;
    this._timerKind = "hide";
    this._timer = this._setTimer(() => {
      this._timer = 0;
      this._timerKind = "";
      this._hide();
    }, this.hideDelayMs);
  }

  /** Clicking a tool, typing, or losing the window drops the bubble at once. */
  dismiss() {
    this._cancelTimer();
    this._hide();
  }

  destroy() {
    this._cancelTimer();
    this.visibleToolId = "";
  }

  _show(id) {
    this.pendingToolId = "";
    if (this.visibleToolId === id) return;
    this.visibleToolId = id;
    this._onShow(id);
  }

  _hide() {
    this.pendingToolId = "";
    if (!this.visible) return;
    const id = this.visibleToolId;
    this.visibleToolId = "";
    this._hiddenAt = this._now();
    this._onHide(id);
  }

  _cancelTimer() {
    if (this._timer) this._clearTimer(this._timer);
    this._timer = 0;
    this._timerKind = "";
    this.pendingToolId = "";
  }
}

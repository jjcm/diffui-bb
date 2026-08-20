/**
 * Figma-style tooltip bubble for the canvas toolbar: tool name in bright text,
 * hotkey dimmed beside it, and a small beak pointing back at the sidebar icon.
 * The canvas workspace owns the timing (see canvas-tool-tooltips.js) and only
 * tells this element what to say and where to sit.
 */

const FADE_OUT_MS = 120;

const template = document.createElement("template");
template.innerHTML = `
  <style>
    :host {
      position: absolute;
      display: block;
      z-index: 5;
      pointer-events: none;
      opacity: 0;
      transform: translateY(-50%);
      transition: opacity 90ms ease;
      /* Slightly lifted off the editor's floating surfaces so the bubble reads as
         chrome rather than a panel, in either theme. */
      --tooltip-bg: color-mix(in srgb, var(--canvas-panel-solid) 92%, var(--canvas-text));
    }
    :host([hidden]) {
      display: none;
    }
    :host([data-visible="true"]) {
      opacity: 1;
    }
    .bubble {
      position: relative;
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 5px 8px;
      border-radius: 3px;
      background: var(--tooltip-bg);
      box-shadow: var(--canvas-panel-shadow);
      font-family: inherit;
      font-size: 11px;
      line-height: 1.2;
      white-space: nowrap;
    }
    .beak {
      position: absolute;
      left: -2px;
      top: 50%;
      width: 6px;
      height: 6px;
      border-radius: 1px;
      background: var(--tooltip-bg);
      transform: translateY(-50%) rotate(45deg);
    }
    .name {
      color: var(--canvas-text-strong);
      font-weight: 600;
    }
    .hotkey {
      color: var(--canvas-text-faint);
      font-weight: 400;
    }
    .hotkey[hidden] {
      display: none;
    }
  </style>
  <div class="bubble">
    <span class="beak" aria-hidden="true"></span>
    <span class="name" id="name"></span>
    <span class="hotkey" id="hotkey" hidden></span>
  </div>
`;

class DiffuiCanvasToolTooltip extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).appendChild(template.content.cloneNode(true));
    this._nameEl = this.shadowRoot.getElementById("name");
    this._hotkeyEl = this.shadowRoot.getElementById("hotkey");
    this._showFrame = 0;
    this._hideTimer = 0;
  }

  connectedCallback() {
    if (!this.hasAttribute("role")) this.setAttribute("role", "tooltip");
    // Buttons carry their own aria-label, so the bubble is decoration only.
    this.setAttribute("aria-hidden", "true");
    if (!this.dataset.visible) this.dataset.visible = "false";
  }

  disconnectedCallback() {
    this._clearTimers();
  }

  setTool({ name = "", hotkey = "" } = {}) {
    const label = String(name || "");
    const key = String(hotkey || "");
    if (this._nameEl.textContent !== label) this._nameEl.textContent = label;
    if (this._hotkeyEl.textContent !== key) this._hotkeyEl.textContent = key;
    this._hotkeyEl.hidden = !key;
  }

  /** Coordinates are relative to the toolbar the bubble is anchored inside. */
  showAt(left, top) {
    this.style.left = `${Math.round(left)}px`;
    this.style.top = `${Math.round(top)}px`;
    this._clearTimers();
    this.hidden = false;
    // A frame between display and opacity lets the fade-in actually run.
    this._showFrame = requestAnimationFrame(() => {
      this._showFrame = 0;
      this.dataset.visible = "true";
    });
  }

  hide() {
    this._clearTimers();
    this.dataset.visible = "false";
    this._hideTimer = window.setTimeout(() => {
      this._hideTimer = 0;
      this.hidden = true;
    }, FADE_OUT_MS);
  }

  _clearTimers() {
    if (this._showFrame) cancelAnimationFrame(this._showFrame);
    this._showFrame = 0;
    if (this._hideTimer) window.clearTimeout(this._hideTimer);
    this._hideTimer = 0;
  }
}

customElements.define("diffui-canvas-tool-tooltip", DiffuiCanvasToolTooltip);

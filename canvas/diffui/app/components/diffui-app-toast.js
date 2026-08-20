const template = document.createElement("template");
template.innerHTML = `
  <style>
    :host {
      position: fixed;
      left: 50%;
      bottom: 24px;
      transform: translate(-50%, 8px);
      z-index: 10050;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.16s ease, transform 0.16s ease;
    }
    :host([data-visible="true"]) {
      opacity: 1;
      transform: translate(-50%, 0);
      pointer-events: auto;
    }
    /* Surface and foreground both come from theme tokens: a fixed dark background with themed
       text paints dark-on-dark in light mode, which reads as an empty bar. */
    .toast {
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: min(420px, calc(100vw - 32px));
      padding: 10px 14px;
      border: 1px solid var(--border2);
      /* A one-line bar, so it takes the control radius rather than the window one. */
      border-radius: var(--radius-sm, 4px);
      background: var(--panel);
      color: var(--text);
      /* Same stacked, per-theme elevation as the popover menus: a flat black blur reads far
         heavier on the light palette than on the dark one. */
      box-shadow: var(
        --menu-shadow,
        0 0 0 1px rgba(0, 0, 0, 0.22),
        0 4px 12px rgba(0, 0, 0, 0.2),
        0 14px 28px rgba(0, 0, 0, 0.22)
      );
      font-size: 12px;
      line-height: 1.45;
    }
    .icon {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      color: var(--muted);
    }
    /* The tone tints the border and the icon; the message stays --text so it always contrasts. */
    :host([data-tone="error"]) .toast {
      border-color: color-mix(in srgb, var(--danger) 55%, var(--border2));
    }
    :host([data-tone="error"]) .icon {
      color: var(--danger);
    }
    :host([data-tone="success"]) .toast {
      border-color: color-mix(in srgb, var(--success) 55%, var(--border2));
    }
    :host([data-tone="success"]) .icon {
      color: var(--success);
    }
    .message {
      flex: 1 1 auto;
      min-width: 0;
    }
  </style>
  <div class="toast" role="status" aria-live="polite">
    <span class="icon" id="icon" aria-hidden="true"></span>
    <span class="message" id="message"></span>
  </div>
`;

function warningIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("class", "icon");
  svg.innerHTML =
    '<path d="M8 1.5L14.5 13.5H1.5L8 1.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 6V9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="11.25" r="0.75" fill="currentColor"/>';
  return svg;
}

function checkIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("class", "icon");
  svg.innerHTML = '<path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>';
  return svg;
}

export class DiffuiAppToast extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this._timer = null;
  }

  show(text, { tone = "error", durationMs = 5200 } = {}) {
    const message = String(text || "").trim();
    if (!message) {
      this.hide();
      return;
    }
    window.clearTimeout(this._timer);
    const messageEl = this.shadowRoot.getElementById("message");
    const iconEl = this.shadowRoot.getElementById("icon");
    if (messageEl) messageEl.textContent = message;
    if (iconEl) iconEl.replaceChildren(tone === "success" ? checkIcon() : warningIcon());
    this.dataset.tone = tone;
    this.dataset.visible = "true";
    this._timer = window.setTimeout(() => this.hide(), Math.max(1200, durationMs));
  }

  hide() {
    window.clearTimeout(this._timer);
    this._timer = null;
    this.dataset.visible = "false";
  }
}

customElements.define("diffui-app-toast", DiffuiAppToast);

let toastEl = null;

export function ensureAppToast() {
  if (toastEl?.isConnected) return toastEl;
  toastEl = document.querySelector("diffui-app-toast");
  if (toastEl) return toastEl;
  toastEl = document.createElement("diffui-app-toast");
  document.body.appendChild(toastEl);
  return toastEl;
}

export function showAppToast(text, opts = {}) {
  ensureAppToast().show(text, opts);
}

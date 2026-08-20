import DiffuiComponent from "./diffui-component.js";

export class DiffuiButton extends DiffuiComponent {
  static get observedAttributes() {
    return ["state", "disabled", "sharp", "subtle", "outline", "danger"];
  }

  constructor() {
    super();
    this._eventsBound = false;
    this._dashTimer = null;
    this._dashOffset = 0;
    this._themeObserver = null;
    this._render();
  }

  connectedCallback() {
    this._render();
    this._bindThemeSync();
    if (!this._eventsBound) {
      this._eventsBound = true;
      this.shadowRoot?.addEventListener("click", (event) => this._handleClick(event));
    }
    if (this.state === "in-progress") {
      this._startInProgressAnimation();
    }
  }

  disconnectedCallback() {
    this._stopInProgressAnimation();
    this._themeObserver?.disconnect();
    this._themeObserver = null;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    switch (name) {
      case "state":
        this._handleStateChange(newValue);
        if (newValue === "in-progress") this._startInProgressAnimation();
        else this._stopInProgressAnimation();
        break;
      case "disabled":
        this._syncDisabled();
        break;
      case "sharp":
        break;
      default:
        break;
    }
  }

  get state() {
    return this.getAttribute("state") || "default";
  }

  set state(value) {
    if (!value || value === "default") this.removeAttribute("state");
    else this.setAttribute("state", String(value));
  }

  css() {
    return `
      :host {
        display: inline-block;
        position: relative;
        --height: 32px;
        --button-width: auto;
        width: var(--button-width);
      }
      button {
        width: var(--button-width);
        box-sizing: border-box;
        height: calc(var(--height) - 1px);
        color: #FFF;
        padding: var(--padding-top, 0) var(--padding-x, 10px) var(--padding-bottom, 0);
        position: relative;
        display: inline-flex;
        align-items: var(--align-items, center);
        justify-content: var(--justify-content, center);
        gap: var(--gap, 8px);
        cursor: pointer;
        text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.25);
        font-family: var(--font-mono);
        font-size: var(--font-size, 12px);
        font-weight: var(--font-weight, 400);
        font-style: normal;
        line-height: normal;
        border: 1px solid rgba(255, 255, 255, 0.19);
        border-radius: var(--radius-sm, 4px);
        background: linear-gradient(90deg, rgba(255, 106, 0, 0.20) 0%, rgba(255, 204, 0, 0.20) 100%);
        box-shadow: var(--box-shadow, 1px 1px 0 0 rgba(255, 106, 0, 0.30), 0 4px 4px 0 rgba(0, 0, 0, 0.25));
        white-space: nowrap;
      }
      :host([data-theme="light"]:not([subtle]):not([outline]):not([danger]):not([disabled])) button {
        border: 1px solid rgba(173, 120, 0, 0.40);
        background: linear-gradient(90deg, rgba(204, 154, 19, 0.55) 0%, rgba(232, 197, 107, 0.49) 100%);
        box-shadow: var(--box-shadow, 1px 1px 0 0 rgba(255, 189, 240, 0.47), 0 4px 4px 0 rgb(82 56 0 / 19%));
        color: var(--text, #1a1c1e);
        text-shadow: -1px -1px 0 rgba(255, 255, 255, 0.25);
      }
      :host([subtle]) #decoration {
        display: none !important;
      }
      :host([subtle]) button {
        color: var(--text, #FFF);
        border-color: var(--border, rgba(255, 255, 255, 0.16));
        background: rgba(255, 255, 255, 0.03);
        box-shadow: none;
        text-shadow: none;
      }
      :host([subtle]) button:hover,
      :host([subtle]) button:focus-visible {
        border-color: var(--gold, #d4a640);
        background: rgba(212, 166, 64, 0.1);
        box-shadow: none;
      }
      :host([subtle]) button:active {
        border-color: var(--gold, #d4a640);
        background: rgba(212, 166, 64, 0.14);
        box-shadow: none;
        transform: none;
      }
      :host([outline]) button {
        color: #FFCC00;
        border-color: rgba(255, 204, 0, 0.55);
        background: transparent;
        box-shadow: none;
        text-shadow: none;
      }
      :host([outline]) button:hover {
        background: rgba(255, 204, 0, 0.08);
        border-color: rgba(255, 204, 0, 0.8);
      }
      :host([outline]) ::slotted(svg) {
        color: #FFCC00;
      }
      /* Bright gold is a 2:1 label on a light surface, so the light theme drops to
         the darker --brand-gold and keeps the wash proportional. */
      :host([data-theme="light"][outline]) button {
        color: var(--brand-gold);
        border-color: color-mix(in srgb, var(--brand-gold) 50%, transparent);
      }
      :host([data-theme="light"][outline]) button:hover {
        background: color-mix(in srgb, var(--brand-gold) 10%, transparent);
        border-color: var(--brand-gold);
      }
      :host([data-theme="light"][outline]) ::slotted(svg) {
        color: var(--brand-gold);
      }
      :host([danger]) button {
        color: #FF6B5C;
        border-color: #510C00;
        background: rgba(81, 12, 0, 0.16);
        box-shadow: none;
        text-shadow: none;
      }
      :host([danger]) button:hover {
        border-color: #7B1B0A;
        background: rgba(81, 12, 0, 0.24);
      }
      :host([danger]) ::slotted(svg) {
        color: #FF6B5C;
      }
      :host([data-theme="light"][danger]) button {
        color: var(--danger);
        border-color: color-mix(in srgb, var(--danger) 45%, transparent);
        background: color-mix(in srgb, var(--danger) 8%, transparent);
      }
      :host([data-theme="light"][danger]) button:hover {
        border-color: var(--danger);
        background: color-mix(in srgb, var(--danger) 14%, transparent);
      }
      :host([data-theme="light"][danger]) ::slotted(svg) {
        color: var(--danger);
      }
      :host([disabled]) button {
        cursor: not-allowed;
        box-shadow: none;
        text-shadow: none;
        color: rgba(255, 255, 255, 0.52);
        border-color: rgba(255, 255, 255, 0.1);
        background: linear-gradient(90deg, rgba(128, 128, 128, 0.18) 0%, rgba(128, 128, 128, 0.18) 100%);
        filter: grayscale(1) saturate(0) contrast(0.72);
      }
      :host([data-theme="light"][disabled]) button {
        color: rgba(26, 28, 30, 0.42);
        border-color: rgba(26, 28, 30, 0.14);
        background: rgba(26, 28, 30, 0.06);
        filter: none;
      }
      :host([disabled]) #decoration {
        display: none !important;
      }
      ::slotted(svg),
      ::slotted(img) {
        position: static;
        width: var(--icon-size, 12px);
        height: var(--icon-size, 12px);
        flex: 0 0 auto;
      }
      ::slotted(img) {
        display: block;
        object-fit: contain;
      }
      ::slotted(span) {
        line-height: 1;
      }
      :host([sharp]) button {
        border-radius: 0;
      }
      button:active {
        box-shadow: 0 2px 2px 0 rgba(0, 0, 0, 0.25);
        transform: translate(1px, 1px);
      }
      :host([disabled]) button:active {
        box-shadow: none;
        transform: none;
      }
      :host([state="selected"]) .button {
        /* TODO: selected styles */
      }
      :host([state="in-progress"]) .button {
        /* TODO: in-progress styles */
      }
      :host([state="pressed"]) .button {
        /* TODO: pressed styles */
      }
      
      :host(:active) #decoration {
        display: block;
        top: -1px;
        left: -1px;
        width: calc(100% + 4px);
        height: calc(100% + 4px);
      }

      :host(:active) .line {
        display: none;
      }

      #decoration {
        position: absolute;
        top: -2px;
        left: -2px;
        width: calc(100% + 5px);
        height: calc(100% + 5px);
        pointer-events: none;
        z-index: 1;
        display: none;
      }
      
      .corner::before {
        content: "";
        position: absolute;
        top: 0;
        left: 0;
        width: 4px;
        height: 1px;
        background: #FF6A00;
        opacity: 0.2;
      }
      .corner::after {
        content: "";
        position: absolute;
        bottom: 0;
        left: 0;
        width: 1px;
        height: 4px;
        background: #FF6A00;
        opacity: 0.2;
      }

      .corner {
        position: absolute;
        width: 4px;
        height: 4px;
      }

      #nw {
        left: 0;
        top: 0;
        transform: rotate(0deg);
      }
      #ne {
        right: 0;
        top: 0;
        transform: rotate(90deg);
      }
      #se {
        right: 0;
        bottom: 0;
        transform: rotate(180deg);
      }
      #sw { 
        left: 0;
        bottom: 0;
        transform: rotate(270deg);
      }

      .line {
        position: absolute;
        background-repeat: repeat;
        background-size: 8px 8px;
        opacity: 0.2;
        --dash-offset: 0px;
      }

      .line.horizontal {
        height: 1px;
        background-image: linear-gradient(
          90deg,
          #FF6A00 0px,
          #FF6A00 4px,
          transparent 4px,
          transparent 8px
        );
        background-position: var(--dash-offset) 0;
      }

      .line.vertical {
        width: 1px;
        background-image: linear-gradient(
          180deg,
          #FF6A00 0px,
          #FF6A00 4px,
          transparent 4px,
          transparent 8px
        );
        background-position: 0 var(--dash-offset);
      }

      :host([state="in-progress"]) #decoration {
        display: block;
      }

      #north {
        top: 0;
        left: 6px;
        width: calc(100% - 12px);
        background-position: var(--dash-offset) 0;
      }
      #south {
        bottom: 0;
        left: 6px;
        width: calc(100% - 12px);
        background-position: calc(var(--dash-offset) * -1) 0;
      }
      #east {
        right: 0;
        top: 6px;
        height: calc(100% - 12px);
        background-position: 0 var(--dash-offset);
      }
      #west {
        left: 0;
        top: 6px;
        height: calc(100% - 12px);
        background-position: 0 calc(var(--dash-offset) * -1);
      }
    `;
  }

  html() {
    return `
      <div id="decoration">
        <div id="nw" class="corner"></div>
        <div id="ne" class="corner"></div>
        <div id="sw" class="corner"></div>
        <div id="se" class="corner"></div>
        <div id="north" class="line horizontal"></div>
        <div id="south" class="line horizontal"></div>
        <div id="east" class="line vertical"></div>
        <div id="west" class="line vertical"></div>
      </div>
      <button type="button" data-state="${this.state}">
        <slot></slot>
      </button>
    `;
  }

  _render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `<style>${this.css()}</style>${this.html()}`;
    this._syncDisabled();
  }

  _syncDisabled() {
    const button = this.shadowRoot?.querySelector("button");
    if (!button) return;
    button.disabled = this.hasAttribute("disabled");
  }

  _themeHosts() {
    const hosts = [];
    let node = this;
    for (;;) {
      const root = node.getRootNode();
      if (!(root instanceof ShadowRoot) || !root.host) break;
      hosts.push(root.host);
      node = root.host;
    }
    return hosts;
  }

  _findThemeAncestor() {
    for (const host of this._themeHosts()) {
      if (host.hasAttribute("data-theme")) return host.getAttribute("data-theme");
    }
    const docTheme =
      document.documentElement.getAttribute("data-theme") ||
      document.documentElement.getAttribute("data-app-theme");
    if (docTheme === "light" || docTheme === "dark") return docTheme;
    return null;
  }

  _syncInheritedTheme() {
    const theme = this._findThemeAncestor();
    const current = this.getAttribute("data-theme");
    if (theme) {
      if (current !== theme) this.setAttribute("data-theme", theme);
      return;
    }
    if (current) this.removeAttribute("data-theme");
  }

  _bindThemeSync() {
    this._syncInheritedTheme();
    this._themeObserver?.disconnect();
    const hosts = this._themeHosts();
    this._themeObserver = new MutationObserver(() => this._syncInheritedTheme());
    for (const host of hosts) {
      this._themeObserver.observe(host, { attributes: true, attributeFilter: ["data-theme"] });
    }
    this._themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-app-theme"],
    });
  }

  _handleStateChange() {
    this._render();
  }

  _handleClick(event) {
    if (this.hasAttribute("disabled")) return;
    if (!this.hasAttribute("async")) return;
    const button = event.target?.closest?.("button");
    if (!button) return;
    this.state = "in-progress";
  }

  _startInProgressAnimation() {
    if (this._dashTimer) return;
    const update = () => {
      this._dashOffset = (this._dashOffset + 2) % 8;
      this._applyDashOffset();
    };
    this._applyDashOffset();
    this._dashTimer = setInterval(update, 500);
  }

  _stopInProgressAnimation() {
    if (this._dashTimer) {
      clearInterval(this._dashTimer);
      this._dashTimer = null;
    }
    this._dashOffset = 0;
    this._applyDashOffset();
  }

  _applyDashOffset() {
    const lines = this.shadowRoot?.querySelectorAll(".line");
    if (!lines) return;
    lines.forEach((line) => {
      line.style.setProperty("--dash-offset", `${this._dashOffset}px`);
    });
  }
}

if (!customElements.get("diffui-button")) {
  customElements.define("diffui-button", DiffuiButton);
}

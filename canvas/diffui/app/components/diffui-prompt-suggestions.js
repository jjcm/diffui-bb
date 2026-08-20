const template = document.createElement("template");
template.innerHTML = `
  <style>
    :host {
      position: absolute;
      left: 50%;
      bottom: 45px;
      width: min(560px, calc(100% - 24px));
      z-index: 7;
      display: flex;
      justify-content: center;
      pointer-events: auto;
      transform: translateX(-50%);
    }
    :host([hidden]) {
      display: none;
    }
    :host([data-visible="false"]) {
      pointer-events: none;
    }
    .suggestions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 6px;
      max-width: 100%;
      pointer-events: auto;
      opacity: 1;
      transform: translateY(0);
      transition: opacity 140ms ease, transform 180ms cubic-bezier(.2, .8, .2, 1);
    }
    :host([data-visible="false"]) .suggestions {
      opacity: 0;
      transform: translateY(6px);
      pointer-events: none;
    }
    .pill {
      min-width: 0;
      max-width: 160px;
      height: 26px;
      padding: 0 10px;
      border: 1px solid var(--canvas-rim);
      border-radius: 999px;
      background: var(--canvas-panel);
      color: var(--canvas-text);
      box-shadow: var(--canvas-shadow-soft), inset 0 1px 0 var(--canvas-hairline);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 400;
      line-height: 1;
      opacity: 0.6;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pill:hover {
      border-color: var(--canvas-accent-rim);
      background: var(--canvas-accent-wash);
      color: var(--canvas-text-strong);
      opacity: 1;
    }
    .pill:active {
      border-color: var(--canvas-accent-line);
      background: var(--canvas-accent-wash-strong);
      color: var(--canvas-text-strong);
      opacity: 1;
    }
    .pill:focus-visible {
      outline: 2px solid var(--canvas-accent-line);
      outline-offset: 2px;
      opacity: 1;
    }
  </style>
  <div class="suggestions" aria-label="Website prompt suggestions"></div>
`;

export class DiffuiPromptSuggestions extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this.shadowRoot.querySelector(".suggestions")?.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    this._suggestions = [];
  }

  connectedCallback() {
    if (!this.dataset.visible) this.dataset.visible = "false";
  }

  set suggestions(value) {
    this.setSuggestions(value);
  }

  get suggestions() {
    return this._suggestions.slice();
  }

  setSuggestions(value) {
    const next = Array.isArray(value)
      ? value
          .map((item) => ({
            label: String(item?.label || "").trim(),
            prompt: String(item?.prompt || "").trim(),
          }))
          .filter((item) => item.label && item.prompt)
      : [];
    const currentKey = JSON.stringify(this._suggestions);
    const nextKey = JSON.stringify(next);
    if (!next.length) {
      this.dataset.visible = "false";
      if (!this._suggestions.length) this.hidden = true;
      return;
    }
    this.hidden = false;
    this.dataset.visible = "true";
    if (currentKey === nextKey) return;
    this._suggestions = next;
    this._patchPills();
  }

  _patchPills() {
    const wrap = this.shadowRoot.querySelector(".suggestions");
    if (!wrap) return;
    while (wrap.children.length > this._suggestions.length) {
      wrap.lastElementChild.remove();
    }
    this._suggestions.forEach((item, index) => {
      let button = wrap.children[index];
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "pill";
        button.addEventListener("click", () => {
          const suggestion = this._suggestions[index];
          if (!suggestion) return;
          this.dispatchEvent(new CustomEvent("diffui-prompt-suggestion:select", {
            detail: { ...suggestion },
            bubbles: true,
            composed: true,
          }));
        });
        wrap.appendChild(button);
      }
      if (button.textContent !== item.label) button.textContent = item.label;
      if (button.title !== item.prompt) button.title = item.prompt;
    });
  }
}

customElements.define("diffui-prompt-suggestions", DiffuiPromptSuggestions);

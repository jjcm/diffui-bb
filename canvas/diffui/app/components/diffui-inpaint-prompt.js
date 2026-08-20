import "./diffui-button.js";
import { MAX_PROMPT_LENGTH } from "../../prompt-limits.js";

// Strokes ride on currentColor so the button can theme the icon (.thumbRemove).
const REF_REMOVE_SVG = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M5.25 5.25l5.5 5.5M10.75 5.25l-5.5 5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

const template = document.createElement("template");
template.innerHTML = `
  <style>
    :host {
      position: absolute;
      display: block;
      width: min(600px, calc(100vw - 80px));
      color: var(--text);
      font-family: var(--font);
      pointer-events: auto;
      z-index: 8;
    }
    :host([hidden]) { display: none; }
    .panel {
      border-radius: 8px;
      background: var(--canvas-panel);
      box-shadow: var(--canvas-panel-shadow);
      padding: 8px;
      box-sizing: border-box;
      backdrop-filter: blur(18px);
    }
    .inputWrap {
      position: relative;
    }
    textarea {
      width: 100%;
      min-height: 120px;
      max-height: 280px;
      resize: vertical;
      border: 1px solid var(--canvas-rim);
      border-radius: 6px;
      outline: 0;
      background: var(--canvas-field);
      color: var(--text);
      font: inherit;
      font-size: 14px;
      line-height: 1.35;
      padding: 18px 20px;
      box-sizing: border-box;
    }
    .inputWrap[data-has-thumbs="true"] textarea {
      padding-bottom: 86px;
    }
    textarea:focus {
      border-color: var(--canvas-accent-line);
      box-shadow: 0 0 0 1px var(--canvas-accent-wash-strong);
    }
    .thumbs {
      position: absolute;
      left: 12px;
      right: 12px;
      bottom: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-height: 0;
      pointer-events: auto;
    }
    .inputWrap[data-has-thumbs="false"] .thumbs {
      display: none;
    }
    .thumb {
      position: relative;
      width: 56px;
      height: 56px;
      border: 1px solid var(--canvas-rim);
      border-radius: 6px;
      overflow: hidden;
      background: var(--canvas-fill);
    }
    .thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .thumbRemove {
      display: none;
      position: absolute;
      top: 0;
      right: 0;
      width: 24px;
      height: 24px;
      box-sizing: border-box;
      margin: 0;
      padding: 4px;
      border: 0;
      border-radius: 0;
      background: none;
      color: var(--canvas-danger);
      cursor: pointer;
    }
    .thumbRemove svg {
      display: block;
      width: 16px;
      height: 16px;
    }
    .thumb:hover .thumbRemove,
    .thumb:focus-within .thumbRemove {
      display: block;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 0;
      margin-top: 4px;
    }
    .spacer { flex: 1; }
    input[type="file"] { display: none; }
    diffui-button {
      --height: 29px;
    }
    .iconButton {
      width: 28px;
      height: 28px;
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      border: 0;
      background: none;
      color: var(--muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      opacity: 0.82;
    }
    .iconButton:hover {
      color: var(--text);
      opacity: 1;
    }
    .iconButton svg {
      display: block;
      width: 20px;
      height: 20px;
    }
    .iconButton svg [fill="white"] {
      fill: currentColor;
    }
    .iconButton svg [stroke="white"] {
      stroke: currentColor;
    }
  </style>
  <div class="panel">
    <div class="inputWrap" id="inputWrap" data-has-thumbs="false">
      <textarea id="prompt" maxlength="${MAX_PROMPT_LENGTH}" placeholder="Describe your edit..."></textarea>
      <div class="thumbs" id="thumbs"></div>
    </div>
    <div class="actions">
      <button class="iconButton" id="copyBtn" type="button" title="Copy selection" aria-label="Copy selection"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="4" y="3" width="9" height="1" fill="white"/><rect x="4" y="4" width="1" height="10" fill="white"/><path d="M16 5V17H6V5H16ZM7 16H15V6H7V16Z" fill="white"/></svg></button>
      <button class="iconButton" id="popoutBtn" type="button" title="Pop out" aria-label="Pop out"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M15.5 12.5L18 10L15.5 7.5" stroke="white" stroke-linecap="square"/><path d="M18 10L9 10" stroke="white" stroke-linejoin="round"/><path d="M14 6H13V4H5V16H13V14H14V17H4V3H14V6Z" fill="white"/></svg></button>
      <button class="iconButton" id="addBtn" type="button" title="Add image" aria-label="Add image"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" stroke="white"/><path d="M2.5 15L7 11.5L10 13.5L14 10L17.5 12.5" stroke="white"/><circle cx="6.5" cy="7.5" r="1.5" fill="white"/></svg></button>
      <span class="spacer"></span>
      <diffui-button id="generateBtn" type="button" state="default">Generate</diffui-button>
    </div>
    <input id="fileInput" type="file" accept="image/*" multiple />
  </div>
`;

export class DiffuiInpaintPrompt extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this._contextImages = [];
  }

  connectedCallback() {
    const prompt = this.shadowRoot.getElementById("prompt");
    const files = this.shadowRoot.getElementById("fileInput");
    this.shadowRoot.getElementById("copyBtn")?.addEventListener("click", () => this._emit("copy"));
    this.shadowRoot.getElementById("popoutBtn")?.addEventListener("click", () => this._emit("popout"));
    this.shadowRoot.getElementById("addBtn")?.addEventListener("click", () => files?.click());
    this.shadowRoot.getElementById("generateBtn")?.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("diffui-inpaint:generate", {
        bubbles: true,
        composed: true,
        detail: { prompt: this.value },
      }));
    });
    files?.addEventListener("change", () => {
      const selected = Array.from(files.files || []);
      files.value = "";
      this._emitFiles(selected);
    });
    prompt?.addEventListener("input", () => {
      this.dispatchEvent(new CustomEvent("diffui-inpaint:input", {
        bubbles: true,
        composed: true,
        detail: { prompt: this.value },
      }));
    });
    prompt?.addEventListener("paste", (event) => {
      const pasted = this._imageFilesFromClipboard(event.clipboardData);
      if (!pasted.length) return;
      event.preventDefault();
      event.stopPropagation();
      this._emitFiles(pasted);
    });
    this.addEventListener("pointerdown", (event) => event.stopPropagation());
  }

  get value() {
    return String(this.shadowRoot.getElementById("prompt")?.value || "");
  }

  set value(next) {
    const prompt = this.shadowRoot.getElementById("prompt");
    if (!prompt) return;
    const value = String(next || "").slice(0, MAX_PROMPT_LENGTH);
    if (prompt.value !== value) prompt.value = value;
  }

  focusPrompt() {
    this.shadowRoot.getElementById("prompt")?.focus();
  }

  setLoading(loading) {
    const generate = this.shadowRoot.getElementById("generateBtn");
    if (generate) generate.toggleAttribute("disabled", !!loading);
  }

  setContextImages(images = []) {
    this._contextImages = Array.isArray(images) ? images : [];
    const thumbs = this.shadowRoot.getElementById("thumbs");
    const inputWrap = this.shadowRoot.getElementById("inputWrap");
    if (inputWrap) inputWrap.dataset.hasThumbs = this._contextImages.length ? "true" : "false";
    if (!thumbs) return;
    const ids = new Set(this._contextImages.map((image) => String(image.id || image.url || "")));
    Array.from(thumbs.querySelectorAll(".thumb")).forEach((thumb) => {
      if (!ids.has(thumb.dataset.id || "")) thumb.remove();
    });
    this._contextImages.forEach((image, index) => {
      const id = String(image.id || image.url || index);
      let thumb = thumbs.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!thumb) {
        thumb = document.createElement("div");
        thumb.className = "thumb";
        thumb.dataset.id = id;
        const img = document.createElement("img");
        img.alt = "";
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "thumbRemove";
        remove.setAttribute("aria-label", "Remove image");
        remove.innerHTML = REF_REMOVE_SVG;
        remove.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.dispatchEvent(new CustomEvent("diffui-inpaint:remove-file", {
            bubbles: true,
            composed: true,
            detail: { id: thumb.dataset.id || "" },
          }));
        });
        thumb.appendChild(img);
        thumb.appendChild(remove);
        thumbs.appendChild(thumb);
      }
      const img = thumb.querySelector("img");
      if (img && image.url && img.getAttribute("src") !== image.url) img.src = image.url;
    });
  }

  _emit(action) {
    this.dispatchEvent(new CustomEvent(`diffui-inpaint:${action}`, { bubbles: true, composed: true }));
  }

  _emitFiles(files) {
    const images = files.filter((file) => file?.type?.startsWith("image/") || /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(file?.name || ""));
    if (!images.length) return;
    this.dispatchEvent(new CustomEvent("diffui-inpaint:add-files", {
      bubbles: true,
      composed: true,
      detail: { files: images },
    }));
  }

  _imageFilesFromClipboard(clipboardData) {
    return Array.from(clipboardData?.items || [])
      .filter((item) => item.type?.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
  }
}

customElements.define("diffui-inpaint-prompt", DiffuiInpaintPrompt);

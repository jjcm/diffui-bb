import "./diffui-button.js";

const template = document.createElement("template");
template.innerHTML = `
  <style>
    :host {
      display: block;
      position: absolute;
      width: 36px;
      min-height: 36px;
      transform: translate(-18px, -18px);
      pointer-events: auto;
      color: var(--text);
      font-family: var(--font, system-ui, sans-serif);
    }
    .marker {
      position: relative;
      width: 36px;
      height: 36px;
      border: 0;
      border-radius: 50%;
      background: var(--canvas-fill);
      box-shadow: var(--canvas-drop-shadow);
      cursor: pointer;
      padding: 0;
    }
    .avatar,
    .replyAvatar {
      overflow: hidden;
      border-radius: 50%;
      background: var(--avatar-color, linear-gradient(135deg, #d4a640, #6aa0ff));
      color: #080a0e;
      display: grid;
      place-items: center;
      font-weight: 700;
      text-transform: uppercase;
      user-select: none;
    }
    .avatar {
      position: absolute;
      inset: 0;
      font-size: 14px;
    }
    .replyAvatar {
      width: 28px;
      height: 28px;
      flex: 0 0 auto;
      font-size: 12px;
    }
    .avatar img,
    .replyAvatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      pointer-events: none;
      user-select: none;
    }
    .badge {
      position: absolute;
      right: -3px;
      top: -5px;
      min-width: 19px;
      height: 19px;
      padding: 0 5px;
      box-sizing: border-box;
      border: 1px solid var(--canvas-pin-ring);
      border-radius: 999px;
      background: var(--canvas-accent);
      color: var(--canvas-accent-contrast);
      display: grid;
      place-items: center;
      box-shadow: var(--canvas-shadow-marker);
      font: 700 11px/1 var(--font, system-ui, sans-serif);
    }
    .badge[hidden] {
      display: none;
    }
    .card {
      display: none;
      position: absolute;
      left: 48px;
      top: -8px;
      width: 370px;
      box-sizing: border-box;
      gap: 14px;
      padding: 12px;
      border-radius: 14px;
      background: var(--canvas-panel);
      box-shadow: var(--canvas-panel-shadow);
      backdrop-filter: blur(10px);
    }
    :host([data-expanded="true"]) .card {
      display: grid;
    }
    .threadHead,
    .messageRow {
      display: flex;
      gap: 10px;
      min-width: 0;
    }
    .threadMain,
    .messageMain {
      min-width: 0;
      flex: 1;
    }
    .threadTop,
    .messageTop {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .author {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--canvas-text);
      font-weight: 700;
      font-size: 12px;
    }
    .time {
      flex: 0 0 auto;
      color: var(--canvas-text-faint);
      font-size: 11px;
    }
    .iconActions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
    }
    .iconAction {
      width: 26px;
      height: 26px;
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--canvas-text-faint);
      cursor: pointer;
      padding: 0;
    }
    .iconAction:hover {
      background: var(--canvas-fill-hover);
      color: var(--canvas-text);
    }
    .iconAction[hidden] {
      display: none;
    }
    .body {
      color: var(--canvas-text);
      font-size: 13px;
      line-height: 1.45;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      margin-top: 4px;
    }
    .messages {
      display: grid;
      gap: 12px;
      max-height: 220px;
      overflow: auto;
    }
    .reply {
      display: flex;
      align-items: flex-start;
      gap: 14px;
    }
    textarea {
      box-sizing: border-box;
      width: 100%;
      min-height: 42px;
      max-height: 120px;
      resize: vertical;
      border: 1px solid var(--canvas-rim);
      border-radius: 8px;
      background: var(--canvas-field);
      color: var(--canvas-text);
      outline: 0;
      padding: 10px 12px;
      font: 13px/1.35 var(--font, system-ui, sans-serif);
    }
    textarea:focus {
      border-color: var(--canvas-accent-line);
    }
  </style>
  <button class="marker" id="marker" type="button" aria-label="Open comment">
    <span class="avatar" id="markerAvatar"></span>
    <span class="badge" id="markerBadge" hidden>0</span>
  </button>
  <div class="card">
    <div class="threadHead">
      <span class="replyAvatar" id="headAvatar"></span>
      <div class="threadMain">
        <div class="threadTop">
          <span class="author" id="headAuthor"></span>
          <span class="time" id="headTime"></span>
          <span style="flex:1"></span>
          <div class="iconActions">
            <button class="iconAction" id="resolveBtn" type="button" title="Resolve" aria-label="Resolve" hidden>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.2 8.15L6.7 10.65L11.8 5.35" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <button class="iconAction" id="deleteBtn" type="button" title="Delete" aria-label="Delete" hidden>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 5L11 11M11 5L5 11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            </button>
            <button class="iconAction" id="closeBtn" type="button" title="Close" aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 5L11 11M11 5L5 11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            </button>
          </div>
        </div>
        <div class="body" id="headBody"></div>
      </div>
    </div>
    <div class="messages" id="messages"></div>
    <div class="reply">
      <span class="replyAvatar" id="replyAvatar"></span>
      <textarea id="replyInput" rows="1" maxlength="1200" placeholder="Add a reply..."></textarea>
    </div>
  </div>
`;

export class DiffuiCanvasComment extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this._commentId = "";
    this._canReply = false;
    this._markerDownPoint = null;
    this.shadowRoot.getElementById("marker")?.addEventListener("click", (event) => this._onMarkerClick(event));
    this.shadowRoot.getElementById("marker")?.addEventListener("pointerdown", (event) => this._onMarkerPointerDown(event));
    this.shadowRoot.getElementById("closeBtn")?.addEventListener("click", () => this._setExpanded(false));
    this.shadowRoot.getElementById("deleteBtn")?.addEventListener("click", () => this._emit("delete"));
    this.shadowRoot.getElementById("resolveBtn")?.addEventListener("click", () => this._emit("resolve"));
    this.shadowRoot.getElementById("replyInput")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this._reply();
      }
    });
    this.addEventListener("pointerdown", (event) => event.stopPropagation());
    this.addEventListener("dblclick", (event) => event.stopPropagation());
    this.addEventListener("contextmenu", (event) => event.stopPropagation());
  }

  setComment(comment, options = {}) {
    this._commentId = String(comment?.id || "");
    const replies = Array.isArray(comment?.replies) ? comment.replies : [];
    this.shadowRoot.getElementById("headAuthor").textContent = String(comment?.authorName || "User").slice(0, 48);
    this.shadowRoot.getElementById("headTime").textContent = formatRelativeTime(comment?.createdAt);
    this.shadowRoot.getElementById("headBody").textContent = String(comment?.body || "");
    this._setAvatar(this.shadowRoot.getElementById("markerAvatar"), comment?.authorAvatarUrl, comment?.authorName, comment?.authorColor);
    this._setAvatar(this.shadowRoot.getElementById("headAvatar"), comment?.authorAvatarUrl, comment?.authorName, comment?.authorColor);
    this._setAvatar(
      this.shadowRoot.getElementById("replyAvatar"),
      options.currentUserAvatarUrl || window.DIFFUI_USER_AVATAR || "",
      options.currentUserName || window.DIFFUI_USER_NAME || "You",
      options.currentUserColor || window.DIFFUI_COLLAB_COLOR || "",
    );
    const markerBadge = this.shadowRoot.getElementById("markerBadge");
    if (markerBadge) {
      markerBadge.textContent = String(replies.length);
      markerBadge.hidden = replies.length <= 0;
    }
    this._patchMessages(comment);
    this.setPermissions(options);
  }

  setPermissions(options = {}) {
    this._canReply = !!options.canReply;
    const replyInput = this.shadowRoot.getElementById("replyInput");
    const deleteBtn = this.shadowRoot.getElementById("deleteBtn");
    const resolveBtn = this.shadowRoot.getElementById("resolveBtn");
    if (replyInput) replyInput.disabled = !this._canReply;
    if (deleteBtn) deleteBtn.hidden = true;
    if (resolveBtn) resolveBtn.hidden = !options.canResolve;
  }

  focusReply(initialValue = "") {
    this._setExpanded(true, { notify: true });
    const input = this.shadowRoot.getElementById("replyInput");
    if (!input) return;
    input.value = String(initialValue || "");
    input.focus();
  }

  close() {
    this._setExpanded(false);
  }

  _patchMessages(comment) {
    const messages = this.shadowRoot.getElementById("messages");
    if (!messages) return;
    const wanted = new Set();
    const entries = Array.isArray(comment?.replies) ? comment.replies : [];
    entries.forEach((entry) => {
      const id = String(entry?.id || "");
      if (!id) return;
      wanted.add(id);
      let row = messages.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
      if (!row) {
        row = document.createElement("div");
        row.className = "messageRow";
        row.dataset.messageId = id;
        const avatar = document.createElement("span");
        avatar.className = "replyAvatar";
        const main = document.createElement("div");
        main.className = "messageMain";
        const top = document.createElement("div");
        top.className = "messageTop";
        const author = document.createElement("span");
        author.className = "author";
        const time = document.createElement("span");
        time.className = "time";
        const body = document.createElement("div");
        body.className = "body";
        top.append(author, time);
        main.append(top, body);
        row.append(avatar, main);
        messages.appendChild(row);
      }
      this._setAvatar(row.querySelector(".replyAvatar"), entry.authorAvatarUrl, entry.authorName, entry.authorColor);
      row.querySelector(".author").textContent = String(entry.authorName || "User").slice(0, 48);
      row.querySelector(".time").textContent = formatRelativeTime(entry.createdAt);
      row.querySelector(".body").textContent = String(entry.body || "");
    });
    messages.querySelectorAll("[data-message-id]").forEach((row) => {
      if (!wanted.has(row.dataset.messageId || "")) row.remove();
    });
  }

  _reply() {
    if (!this._canReply) return;
    const input = this.shadowRoot.getElementById("replyInput");
    const body = String(input?.value || "").trim();
    if (!body) return;
    if (input) input.value = "";
    this._emit("reply", { body });
  }

  _onMarkerPointerDown(event) {
    if (event.button !== 0) return;
    this._markerDownPoint = { x: event.clientX, y: event.clientY };
    this._emit("drag-start", { pointerEvent: event });
  }

  _onMarkerClick(event) {
    const point = this._markerDownPoint;
    this._markerDownPoint = null;
    if (point && Math.hypot(event.clientX - point.x, event.clientY - point.y) >= 3) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    this._setExpanded(true, { notify: true });
  }

  _setExpanded(expanded, options = {}) {
    this.dataset.expanded = expanded ? "true" : "false";
    if (expanded && options.notify) this._emit("open");
  }

  _setAvatar(target, avatarUrl, name, color = "") {
    if (!target) return;
    const url = String(avatarUrl || "").trim();
    const img = target.querySelector(":scope > img");
    if (url) {
      target.style.removeProperty("--avatar-color");
      if (img?.dataset.avatarUrl === url) return;
      if (img) img.remove();
      {
        target.textContent = "";
        const nextImg = document.createElement("img");
        nextImg.alt = "";
        nextImg.draggable = false;
        nextImg.dataset.avatarUrl = url;
        nextImg.src = url;
        target.appendChild(nextImg);
      }
      return;
    }
    if (img) img.remove();
    const fallback = String(color || "").trim();
    if (fallback) target.style.setProperty("--avatar-color", fallback);
    else target.style.removeProperty("--avatar-color");
    const initials = initialsForName(name);
    if (target.textContent !== initials) target.textContent = initials;
  }

  _emit(action, detail = {}) {
    this.dispatchEvent(new CustomEvent("diffui-comment:" + action, {
      bubbles: true,
      composed: true,
      detail: { commentId: this._commentId, ...detail },
    }));
  }
}

function initialsForName(name) {
  const words = String(name || "User").trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] || "").join("");
  return (letters || "U").toUpperCase();
}

function formatRelativeTime(value) {
  const ts = Number(value) || Date.now();
  const delta = Math.max(0, Date.now() - ts);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "now";
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`;
  if (delta < day) return `${Math.floor(delta / hour)}h ago`;
  return `${Math.floor(delta / day)}d ago`;
}

customElements.define("diffui-canvas-comment", DiffuiCanvasComment);

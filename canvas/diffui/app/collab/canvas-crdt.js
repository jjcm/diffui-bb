import * as Y from "../vendor/yjs.bundle.mjs";
import * as collabProtocol from "./collab-protocol.js";

const CANVAS_MAP_KEY = "state";

/**
 * Binds a Yjs document to canvas JSON state.
 */
export class CanvasCRDT {
  constructor() {
    this.doc = new Y.Doc();
    this.map = this.doc.getMap("canvas");
    this._localOrigin = "local";
    this._remoteOrigin = "remote";
    this._onStateChange = null;
    this._observer = (event) => {
      if (!this._onStateChange) return;
      const origin = event?.transaction?.origin === this._localOrigin
        ? this._localOrigin
        : this._remoteOrigin;
      if (origin !== this._remoteOrigin) return;
      this._onStateChange(this.getState(), origin);
    };
    this.map.observe(this._observer);
    this.doc.on("update", this._handleDocUpdate.bind(this));
    this._provider = null;
    this._pendingLocal = false;
  }

  setProvider(provider) {
    this._provider = provider;
  }

  onStateChange(fn) {
    this._onStateChange = fn;
  }

  getState() {
    const value = this.map.get(CANVAS_MAP_KEY);
    if (value == null || value === "") return null;
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    // Legacy docs may have stored a Y.Map; normalize to plain JSON.
    if (typeof value?.toJSON === "function") {
      try {
        const json = value.toJSON();
        return typeof json === "string" ? JSON.parse(json) : json;
      } catch {
        return null;
      }
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  }

  setState(state, origin = this._localOrigin) {
    const prev = this._onStateChange;
    if (origin === this._remoteOrigin) {
      this._onStateChange = null;
    }
    const raw = typeof state === "string" ? state : JSON.stringify(state);
    this.doc.transact(() => {
      this.map.set(CANVAS_MAP_KEY, raw);
    }, origin);
    this._onStateChange = prev;
  }

  encodeBootstrapUpdate() {
    return Y.encodeStateAsUpdate(this.doc);
  }

  applyRemoteUpdate(updateBytes, origin = this._remoteOrigin) {
    Y.applyUpdate(this.doc, updateBytes, origin);
  }

  _handleDocUpdate(update, origin) {
    if (origin === this._remoteOrigin) return;
    if (!this._provider || this._provider.readOnly) return;
    this._provider.sendUpdate(update);
  }

  destroy() {
    this.map.unobserve(this._observer);
    this.doc.destroy();
    this._provider = null;
  }
}

export { collabProtocol };

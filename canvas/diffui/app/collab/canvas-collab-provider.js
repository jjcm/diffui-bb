import {
  MsgAccessLost,
  MsgAwareness,
  MsgBootstrap,
  MsgServerAck,
  MsgServerBootstrap,
  MsgServerUpdate,
  MsgSync,
  encodeAwareness,
  encodeSyncUpdate,
  extractSequencedPayload,
  extractSyncUpdate,
  parseFrame,
} from "./collab-protocol.js";
import { reconnectDelay, looksLikeAuthClose, isSessionValid, notifySessionExpired } from "../../watch-reconnect.js";
const SNAPSHOT_IDLE_MS = 12000;
const SNAPSHOT_UPDATE_THRESHOLD = 80;

/**
 * WebSocket transport for canvas CRDT sync and awareness.
 */
export class CanvasCollabProvider {
  constructor({ projectId, apiFetch, getWsUrl, readOnly = false }) {
    this.projectId = projectId;
    this.apiFetch = apiFetch;
    this.getWsUrl = getWsUrl;
    this.readOnly = readOnly;
    this.crdt = null;
    this._ws = null;
    this._reconnectAttempt = 0;
    this._reconnectTimer = 0;
    this._lastCloseEvent = null;
    this._snapshotTimer = 0;
    this._updatesSinceSnapshot = 0;
    this._appliedServerSeq = 0;
    this._pendingAppliedServerSeqs = new Set();
    this._snapshotInFlight = false;
    this._connected = false;
    this._onRemoteUpdate = null;
    this._onAwareness = null;
    this._onConnectionChange = null;
    this._onAccessLost = null;
    this._onDocReady = null;
    this._awarenessPayload = new Uint8Array(0);
    this._docReady = false;
    this._openReadyTimer = 0;
  }

  attach(crdt) {
    this.crdt = crdt;
    crdt.setProvider(this);
  }

  onRemoteUpdate(fn) {
    this._onRemoteUpdate = fn;
  }

  onAwareness(fn) {
    this._onAwareness = fn;
  }

  onConnectionChange(fn) {
    this._onConnectionChange = fn;
  }

  onAccessLost(fn) {
    this._onAccessLost = fn;
  }

  onDocReady(fn) {
    this._onDocReady = fn;
  }

  isDocReady() {
    return this._docReady;
  }

  connect() {
    this.disconnect(false);
    const url = this.getWsUrl(this.projectId);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this._ws = ws;
    ws.addEventListener("open", () => {
      if (this._ws !== ws) return;
      this._reconnectAttempt = 0;
      this._lastCloseEvent = null;
      this._connected = true;
      this._docReady = false;
      this._onConnectionChange?.(true);
      if (this._awarenessPayload.length) {
        this._send(this._wrapAwareness(this._awarenessPayload));
      }
      window.clearTimeout(this._openReadyTimer);
      this._openReadyTimer = window.setTimeout(() => this._markDocReady(), 400);
    });
    ws.addEventListener("message", (event) => {
      const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : null;
      if (data) this._handleFrame(data);
    });
    ws.addEventListener("close", (event) => {
      if (this._ws !== ws) return;
      this._connected = false;
      this._lastCloseEvent = event;
      this._onConnectionChange?.(false);
      this._scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      try { ws.close(); } catch { /* ignore */ }
    });
  }

  disconnect(clearReconnect = true) {
    if (clearReconnect) {
      window.clearTimeout(this._reconnectTimer);
      this._reconnectTimer = 0;
    }
    window.clearTimeout(this._openReadyTimer);
    this._openReadyTimer = 0;
    this._docReady = false;
    window.clearTimeout(this._snapshotTimer);
    this._snapshotTimer = 0;
    if (this._ws) {
      try { this._ws.close(); } catch { /* ignore */ }
    }
    this._ws = null;
    this._connected = false;
  }

  sendUpdate(updateBytes) {
    if (this.readOnly || !this._connected) return;
    this._send(encodeSyncUpdate(updateBytes));
    this._updatesSinceSnapshot += 1;
    this._scheduleSnapshotIfNeeded();
  }

  setAwareness(payloadBytes) {
    this._awarenessPayload = payloadBytes instanceof Uint8Array ? payloadBytes : new Uint8Array(payloadBytes || []);
    if (this._connected) {
      this._send(this._wrapAwareness(this._awarenessPayload));
    }
  }

  async persistSnapshot() {
    if (!this.crdt || this.readOnly || !this.projectId) return;
    if (this._snapshotInFlight) return;
    this._snapshotInFlight = true;
    const includedUpdates = this._updatesSinceSnapshot;
    const includedServerSeq = this._appliedServerSeq;
    const snapshot = this.crdt.encodeBootstrapUpdate();
    const body = {
      snapshotBase64: bytesToBase64(snapshot),
      seq: includedServerSeq,
    };
    try {
      await this.apiFetch(`/api/projects/${encodeURIComponent(this.projectId)}/canvas/crdt/snapshot`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      this._updatesSinceSnapshot = Math.max(0, this._updatesSinceSnapshot - includedUpdates);
    } finally {
      this._snapshotInFlight = false;
      this._scheduleSnapshotIfNeeded();
    }
  }

  _wrapAwareness(payload) {
    return encodeAwareness(payload);
  }

  _send(data) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(data);
  }

  _handleFrame(data) {
    const frame = parseFrame(data);
    if (!frame) return;
    if (frame.type === MsgAccessLost) {
      this._onAccessLost?.();
      this.disconnect();
      return;
    }
    if (frame.type === MsgBootstrap && this.crdt) {
      this.crdt.applyRemoteUpdate(frame.payload);
      this._markDocReady();
      this._onRemoteUpdate?.(this.crdt.getState());
      return;
    }
    if (frame.type === MsgServerAck) {
      const sequenced = extractSequencedPayload(frame);
      if (sequenced) this._markUpdateSeqApplied(sequenced.seq);
      return;
    }
    if ((frame.type === MsgServerBootstrap || frame.type === MsgServerUpdate) && this.crdt) {
      const sequenced = extractSequencedPayload(frame);
      if (!sequenced) return;
      if (sequenced.payload.length) {
        this.crdt.applyRemoteUpdate(sequenced.payload);
      }
      if (frame.type === MsgServerBootstrap) {
        this._markBootstrapSeqApplied(sequenced.seq);
      } else {
        this._markUpdateSeqApplied(sequenced.seq);
      }
      this._onRemoteUpdate?.(this.crdt.getState());
      return;
    }
    if (frame.type === MsgAwareness) {
      this._onAwareness?.(frame.payload);
      return;
    }
    if (frame.type === MsgSync) {
      const update = extractSyncUpdate(frame);
      if (update && this.crdt) {
        this.crdt.applyRemoteUpdate(update);
        this._markDocReady();
        this._onRemoteUpdate?.(this.crdt.getState());
      }
    }
  }

  _markDocReady() {
    if (this._docReady) return;
    this._docReady = true;
    window.clearTimeout(this._openReadyTimer);
    this._openReadyTimer = 0;
    this._onDocReady?.();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const delay = reconnectDelay(this._reconnectAttempt);
    this._reconnectAttempt += 1;
    this._reconnectTimer = window.setTimeout(async () => {
      this._reconnectTimer = 0;
      if (looksLikeAuthClose(this._lastCloseEvent) && !window.DIFFUI_EMBED && !window.DIFFUI_SHARE_VIEWER) {
        if (!(await isSessionValid())) {
          notifySessionExpired();
          return;
        }
      }
      if (this.projectId) this.connect();
    }, delay);
  }

  _markBootstrapSeqApplied(seq) {
    if (!Number.isSafeInteger(seq) || seq < 0) return;
    this._appliedServerSeq = Math.max(this._appliedServerSeq, seq);
    this._drainAppliedServerSeqs();
  }

  _markUpdateSeqApplied(seq) {
    if (!Number.isSafeInteger(seq) || seq <= 0 || seq <= this._appliedServerSeq) return;
    this._pendingAppliedServerSeqs.add(seq);
    this._drainAppliedServerSeqs();
  }

  _drainAppliedServerSeqs() {
    let next = this._appliedServerSeq + 1;
    while (this._pendingAppliedServerSeqs.has(next)) {
      this._pendingAppliedServerSeqs.delete(next);
      this._appliedServerSeq = next;
      next += 1;
    }
  }

  _scheduleSnapshotIfNeeded() {
    if (this.readOnly || this._snapshotInFlight) return;
    if (this._updatesSinceSnapshot < SNAPSHOT_UPDATE_THRESHOLD) return;
    window.clearTimeout(this._snapshotTimer);
    this._snapshotTimer = window.setTimeout(() => {
      this._snapshotTimer = 0;
      if (!this._connected || this._updatesSinceSnapshot < SNAPSHOT_UPDATE_THRESHOLD) return;
      this.persistSnapshot().catch(() => null);
    }, SNAPSHOT_IDLE_MS);
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

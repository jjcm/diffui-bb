/** Wire protocol constants (must match backend/internal/collab/protocol.go). */
export const MsgSync = 0;
export const MsgAwareness = 1;
export const MsgAccessLost = 2;
export const MsgBootstrap = 3;
export const MsgServerUpdate = 4;
export const MsgServerBootstrap = 5;
export const MsgServerAck = 6;

export const SyncStep1 = 0;
export const SyncStep2 = 1;
export const SyncUpdate = 2;

export function encodeSyncUpdate(updateBytes) {
  const frame = new Uint8Array(2 + updateBytes.length);
  frame[0] = MsgSync;
  frame[1] = SyncUpdate;
  frame.set(updateBytes, 2);
  return frame;
}

export function encodeAwareness(payloadBytes) {
  const frame = new Uint8Array(1 + payloadBytes.length);
  frame[0] = MsgAwareness;
  frame.set(payloadBytes, 1);
  return frame;
}

export function parseFrame(data) {
  if (!(data instanceof Uint8Array) || data.length === 0) return null;
  const type = data[0];
  return { type, payload: data.slice(1) };
}

export function extractSyncUpdate(frame) {
  if (!frame || frame.type !== MsgSync) return null;
  if (frame.payload.length < 1 || frame.payload[0] !== SyncUpdate) return null;
  return frame.payload.slice(1);
}

export function extractSequencedPayload(frame) {
  if (!frame || (frame.type !== MsgServerUpdate && frame.type !== MsgServerBootstrap && frame.type !== MsgServerAck)) return null;
  if (frame.payload.length < 8) return null;
  const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
  const seq = Number(view.getBigUint64(0));
  if (!Number.isSafeInteger(seq)) return null;
  return {
    seq,
    payload: frame.payload.slice(8),
  };
}

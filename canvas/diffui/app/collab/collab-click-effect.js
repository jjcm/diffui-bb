/**
 * Double-click loupe relay.
 *
 * The loupe (thumbnail lift) is a one-shot animation, so it rides along in the
 * ephemeral awareness payload under `session.effect` rather than in the CRDT
 * document. Positions travel in world coordinates because every client renders
 * with its own viewport.
 */

export const CLICK_EFFECT_KIND_THUMBNAIL = "thumbnail";

/** How long a relayed effect id is remembered so a duplicate frame cannot replay it. */
export const CLICK_EFFECT_SEEN_TTL_MS = 30000;

function finitePoint(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Builds the `session.effect` blob for a loupe the local user just triggered.
 * Returns null when the effect cannot be described well enough to replay.
 */
export function buildClickEffectAwareness({
  effectId,
  sourceNodeId = "",
  imageUrl = "",
  origin,
  destination,
  click = null,
  tilt = 0,
  at = Date.now(),
} = {}) {
  const id = String(effectId || "").trim();
  const originPoint = finitePoint(origin);
  const destinationPoint = finitePoint(destination);
  if (!id || !originPoint || !destinationPoint) return null;
  return {
    id,
    kind: CLICK_EFFECT_KIND_THUMBNAIL,
    nodeId: String(sourceNodeId || ""),
    imageUrl: String(imageUrl || ""),
    origin: originPoint,
    destination: destinationPoint,
    imageX: finiteNumber(click?.imageX),
    imageY: finiteNumber(click?.imageY),
    imageWidth: finiteNumber(click?.imageWidth),
    imageHeight: finiteNumber(click?.imageHeight),
    tilt: finiteNumber(tilt),
    at: finiteNumber(at, Date.now()),
  };
}

/**
 * Reads a peer's `session.effect`, returning the descriptor to animate or null.
 *
 * Drops the local client's own frames (the originator already played the loupe
 * when it double-clicked) and any effect id already handled, which is what keeps
 * a resent awareness payload from animating the same double-click twice. Pass a
 * Map as `seen` to enable that bookkeeping.
 */
export function readClickEffectAwareness(payload, { selfClientId = "", seen = null, now = Date.now() } = {}) {
  const effect = payload?.session?.effect;
  if (!effect || effect.kind !== CLICK_EFFECT_KIND_THUMBNAIL) return null;
  const clientId = String(payload?.id || "");
  if (!clientId) return null;
  if (selfClientId && clientId === String(selfClientId)) return null;
  const id = String(effect.id || "").trim();
  if (!id) return null;
  const origin = finitePoint(effect.origin);
  const destination = finitePoint(effect.destination);
  if (!origin || !destination) return null;
  if (seen) {
    if (seen.has(id)) return null;
    seen.set(id, now);
    pruneSeenClickEffects(seen, now);
  }
  return {
    id,
    clientId,
    nodeId: String(effect.nodeId || ""),
    imageUrl: String(effect.imageUrl || ""),
    origin,
    destination,
    click: {
      imageX: finiteNumber(effect.imageX),
      imageY: finiteNumber(effect.imageY),
      imageWidth: finiteNumber(effect.imageWidth),
      imageHeight: finiteNumber(effect.imageHeight),
    },
    tilt: finiteNumber(effect.tilt),
  };
}

export function pruneSeenClickEffects(seen, now = Date.now(), ttlMs = CLICK_EFFECT_SEEN_TTL_MS) {
  if (!seen) return;
  for (const [id, seenAt] of seen) {
    if (now - seenAt > ttlMs) seen.delete(id);
  }
}

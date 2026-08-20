/** Diffui brand palette — one color per collab client session. */
export const DIFFUI_COLLAB_COLORS = [
  "#C38B23",
  "#AA5F52",
  "#8F3222",
  "#BC9B30",
  "#236B42",
  "#1D4C1E",
  "#556C52",
  "#ACA15E",
  "#753B00",
];

const CLIENT_COLOR_KEY = "diffui.collab.clientColor";

export function pickRandomCollabColor() {
  return DIFFUI_COLLAB_COLORS[Math.floor(Math.random() * DIFFUI_COLLAB_COLORS.length)];
}

/** Stable random color for this browser tab; persisted in sessionStorage. */
export function getOrCreateClientCollabColor() {
  try {
    let color = sessionStorage.getItem(CLIENT_COLOR_KEY);
    if (color && DIFFUI_COLLAB_COLORS.includes(color)) return color;
    color = pickRandomCollabColor();
    sessionStorage.setItem(CLIENT_COLOR_KEY, color);
    return color;
  } catch {
    return pickRandomCollabColor();
  }
}

/** Deterministic palette pick when a peer has no color in awareness yet. */
export function collabColorFromId(id) {
  let hash = 0;
  const text = String(id || "");
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return DIFFUI_COLLAB_COLORS[Math.abs(hash) % DIFFUI_COLLAB_COLORS.length];
}

export function resolveCollabColor(color, fallbackId) {
  const picked = String(color || "").trim();
  if (picked && DIFFUI_COLLAB_COLORS.includes(picked)) return picked;
  if (picked && /^#[0-9a-fA-F]{6}$/.test(picked)) return picked;
  return collabColorFromId(fallbackId);
}

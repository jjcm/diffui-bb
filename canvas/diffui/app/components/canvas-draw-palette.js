/**
 * Colours for the half of the canvas that is painted into the 2D context
 * (`<canvas id="canvas">`): the grid, connection wires, node rectangles,
 * connector handles, analysis badges and the drag/collab affordances.
 *
 * CSS custom properties cannot reach a 2D context, so these mirror the
 * `--canvas-*` tokens in styles.css by hand. Keep the two in step: a colour that
 * exists in only one of them is a light-mode hole waiting to happen.
 *
 * Pure and DOM-free so the canvas workspace stays a thin layer over it and the
 * ramps can be asserted without a browser.
 */

export const CANVAS_THEME_DARK = "dark";
export const CANVAS_THEME_LIGHT = "light";

const DARK = Object.freeze({
  gridLine: "rgba(255,255,255,0.05)",
  /** Connection wires between nodes. */
  edge: "rgba(212,166,64,0.72)",
  edgeCustomFacets: "rgba(212,166,64,0.95)",
  edgeSelected: "#f5d36c",
  /** The rectangle a node occupies, before its image is drawn into it. */
  nodeRim: "rgba(255,255,255,0.18)",
  nodeRimSelected: "#d4a640",
  nodeFill: "rgba(18,20,24,0.72)",
  nodeFillWithImage: "rgba(17,22,29,0.18)",
  nodeSkeleton: "rgba(255,255,255,0.08)",
  nodeLabel: "rgba(255,255,255,0.7)",
  nodeLabelSelected: "#f5d36c",
  /** Input / output connector pills either side of a node. */
  handleFill: "rgba(7,9,12,0.72)",
  handleRim: "rgba(255,255,255,0.22)",
  handleGlyph: "rgba(255,255,255,0.68)",
  /** Prompt-analysis badge in a node's top-right corner. */
  badgeFill: "rgba(7,9,12,0.86)",
  badgeRim: "rgba(255,255,255,0.18)",
  badgeSpinner: "#d4a640",
  badgeDone: "#22c55e",
  badgeError: "#ff5c5c",
  /** Move-snap alignment guides. */
  snapGuide: "rgba(255, 82, 82, 0.58)",
  /** Aspect guides drawn while resizing; the alpha varies per guide. */
  resizeGuideRgb: "212, 166, 64",
  resizeTarget: "#695425",
  resizeTargetLabel: "rgba(212, 166, 64, 0.9)",
  /** Wire being dragged out of an output port, and its landing preview. */
  portWire: "#d4a640",
  portPreviewRim: "rgba(212,166,64,0.92)",
  portPreviewFill: "rgba(212,166,64,0.06)",
  /** Thumbnail-lift effect played when an option is pulled into a stack. */
  liftGlow: "rgba(83,172,255,0.78)",
  liftFill: "rgba(83,172,255,0.16)",
  liftPlaceholder: "rgba(212,166,64,0.82)",
  liftRim: "rgba(255,255,255,0.9)",
  liftArc: "rgba(212,166,64,0.74)",
  /** Agent / collaborator cursors. The label stays dark in both themes so it
      reads against whatever imagery it lands on. */
  cursorOutline: "rgba(255,255,255,0.9)",
  cursorLabelFill: "rgba(10,12,16,0.92)",
  cursorLabelText: "#fff",
});

const LIGHT = Object.freeze({
  ...DARK,
  gridLine: "rgba(26,28,30,0.07)",
  edge: "rgba(155,113,48,0.75)",
  edgeCustomFacets: "rgba(155,113,48,0.95)",
  edgeSelected: "#7c5a20",
  nodeRim: "rgba(26,28,30,0.18)",
  nodeRimSelected: "#9b7130",
  nodeFill: "rgba(255,255,255,0.78)",
  nodeFillWithImage: "rgba(255,255,255,0.45)",
  nodeSkeleton: "rgba(26,28,30,0.1)",
  nodeLabel: "rgba(26,28,30,0.68)",
  nodeLabelSelected: "#7c5a20",
  handleFill: "rgba(255,255,255,0.9)",
  handleRim: "rgba(26,28,30,0.26)",
  handleGlyph: "rgba(26,28,30,0.62)",
  badgeFill: "rgba(255,255,255,0.94)",
  badgeRim: "rgba(26,28,30,0.2)",
  badgeSpinner: "#9b7130",
  badgeDone: "#2f6a59",
  badgeError: "#c9503c",
  snapGuide: "rgba(201, 80, 60, 0.62)",
  resizeGuideRgb: "155, 113, 48",
  resizeTarget: "#7e6428",
  resizeTargetLabel: "rgba(155, 113, 48, 0.9)",
  portWire: "#9b7130",
  portPreviewRim: "rgba(155,113,48,0.92)",
  portPreviewFill: "rgba(155,113,48,0.08)",
  liftGlow: "rgba(31,111,208,0.6)",
  liftFill: "rgba(31,111,208,0.16)",
  liftPlaceholder: "rgba(155,113,48,0.82)",
  liftRim: "rgba(255,255,255,0.95)",
  liftArc: "rgba(155,113,48,0.8)",
});

/** Every colour the 2D drawing code may ask for, by name. */
export const CANVAS_DRAW_COLOR_KEYS = Object.freeze(Object.keys(DARK));

/**
 * The palette for a theme name. Anything other than "light" is dark, which keeps
 * a missing or not-yet-applied `data-app-theme` on the dark default.
 */
export function canvasDrawPalette(theme) {
  return theme === CANVAS_THEME_LIGHT ? LIGHT : DARK;
}

/** CSS custom property an embedder can set to retune one drawn colour. */
export function canvasDrawColorVar(key) {
  return `--canvas-draw-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * The palette as an element actually sees it: the theme ramp above, with any
 * `--canvas-draw-*` custom property in scope layered on top.
 *
 * Diffui defines none of those properties, so every key falls through to the ramp
 * and the app draws exactly as it always has. An embedder that restyles the canvas
 * onto its own theme (the bb plugin) sets them beside the `--canvas-*` tokens, and
 * this is what carries those colours into the 2D context — which cannot read custom
 * properties itself.
 *
 * Resolved once per mount and per theme change, never per frame: `getComputedStyle`
 * is a layout read and the draw loop runs on every pan.
 */
export function resolveCanvasDrawPalette(theme, element) {
  const base = canvasDrawPalette(theme);
  const view = element?.ownerDocument?.defaultView;
  if (!element?.isConnected || !view?.getComputedStyle) return base;
  const computed = view.getComputedStyle(element);
  let overrides = null;
  for (const key of CANVAS_DRAW_COLOR_KEYS) {
    const value = computed.getPropertyValue(canvasDrawColorVar(key)).trim();
    if (value === "") continue;
    if (overrides === null) overrides = {};
    overrides[key] = value;
  }
  return overrides === null ? base : Object.freeze({ ...base, ...overrides });
}

/** "light" when the document is in the light app theme, otherwise "dark". */
export function canvasThemeFromRoot(root) {
  const value = root?.getAttribute?.("data-app-theme") || root?.getAttribute?.("data-theme") || "";
  return value === CANVAS_THEME_LIGHT ? CANVAS_THEME_LIGHT : CANVAS_THEME_DARK;
}

// How the canvas bb shows differs from Diffui's: its colours.
//
// `<diffui-canvas-workspace>` is Diffui's element, mirrored into this
// repository and mounted as-is (see diffui-canvas-element.ts). Every colour it
// paints — in shadow CSS and in the 2D context — comes from a custom property,
// so restyling it onto bb's theme is a matter of redefining those properties on
// the element that hosts it. Nothing below changes layout, geometry,
// behaviour, or the tool rail's icons; it is a palette and nothing else.
//
// Two families are defined here:
//
// - `--canvas-*` (plus the handful of shared app tokens the canvas reads:
//   `--text`, `--muted`, `--panel`, `--menu-*`, …) drive the shadow CSS.
// - `--canvas-draw-*` drive the half of the canvas painted into the 2D context
//   (grid, connection noodles, node rects, connector pills, badges). A 2D
//   context cannot read custom properties, so Diffui's canvas-draw-palette.js
//   resolves these at mount and on every theme change.
//
// Everything is expressed as `color-mix()` over bb's own host tokens
// (`--background`, `--foreground`, `--surface-recessed`, `--border`, `--ring`,
// `--muted-foreground`, `--state-hover`, `--destructive`), so one definition
// covers bb's light and dark themes and follows a live theme switch. Each host
// token carries a fallback so a bb build that renames one still renders.

/** bb host tokens, with a fallback each, as the mixes below refer to them. */
const HOST = {
  background: "var(--background, #ffffff)",
  foreground: "var(--foreground, #1a1c1e)",
  muted: "var(--muted-foreground, #6b7280)",
  recessed: "var(--surface-recessed, #f3f4f6)",
  border: "var(--border, rgba(120, 120, 120, 0.24))",
  ring: "var(--ring, #5c6cf0)",
  hover: "var(--state-hover, rgba(120, 120, 120, 0.1))",
  destructive: "var(--destructive, #c9503c)",
} as const;

/** `color-mix` of one host token into transparency — the alpha ramps. */
function alpha(token: string, percent: number): string {
  return `color-mix(in srgb, ${token} ${percent}%, transparent)`;
}

/** `color-mix` of two host tokens — the surface ramps. */
function blend(token: string, percent: number, into: string): string {
  return `color-mix(in srgb, ${token} ${percent}%, ${into})`;
}

/**
 * The `--canvas-draw-*` names Diffui's canvas-draw-palette.js reads, keyed by
 * the palette key it overrides. Kept as a map (not a loop over the palette
 * module) so the plugin bundle does not import Diffui's palette just to list
 * key names, and so a unit test can assert the two sets match.
 */
export const BB_CANVAS_DRAW_COLORS: Readonly<Record<string, string>> = Object.freeze({
  gridLine: alpha(HOST.foreground, 7),
  edge: alpha(HOST.ring, 70),
  edgeCustomFacets: alpha(HOST.ring, 92),
  edgeSelected: HOST.ring,
  nodeRim: alpha(HOST.foreground, 18),
  nodeRimSelected: HOST.ring,
  nodeFill: blend(HOST.recessed, 82, "transparent"),
  nodeFillWithImage: alpha(HOST.recessed, 30),
  nodeSkeleton: alpha(HOST.foreground, 9),
  nodeLabel: HOST.muted,
  nodeLabelSelected: HOST.ring,
  handleFill: blend(HOST.background, 88, "transparent"),
  handleRim: alpha(HOST.foreground, 24),
  handleGlyph: HOST.muted,
  badgeFill: blend(HOST.background, 92, "transparent"),
  badgeRim: alpha(HOST.foreground, 18),
  badgeSpinner: HOST.ring,
  badgeDone: HOST.ring,
  badgeError: HOST.destructive,
  snapGuide: alpha(HOST.destructive, 60),
  // A raw "r, g, b" triple: the resize guides compose their own alphas around
  // it, so it cannot be a color-mix(). bb exposes no numeric channels, so the
  // guides keep Diffui's neutral gold triple.
  resizeGuideRgb: "148, 148, 160",
  resizeTarget: alpha(HOST.foreground, 45),
  resizeTargetLabel: HOST.muted,
  portWire: HOST.ring,
  portPreviewRim: alpha(HOST.ring, 92),
  portPreviewFill: alpha(HOST.ring, 8),
  liftGlow: alpha(HOST.ring, 70),
  liftFill: alpha(HOST.ring, 16),
  liftPlaceholder: alpha(HOST.ring, 82),
  liftRim: "rgba(255, 255, 255, 0.9)",
  liftArc: alpha(HOST.ring, 74),
  cursorOutline: "rgba(255, 255, 255, 0.9)",
  cursorLabelFill: blend(HOST.foreground, 92, "transparent"),
  cursorLabelText: HOST.background,
});

function drawColorVar(key: string): string {
  return `--canvas-draw-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** The `--canvas-draw-*` block, one declaration per drawn colour. */
function drawColorDeclarations(): string {
  return Object.entries(BB_CANVAS_DRAW_COLORS)
    .map(([key, value]) => `  ${drawColorVar(key)}: ${value};`)
    .join("\n");
}

/**
 * The token layer. Scoped to `.dfbb-canvas-host` so it can only ever repaint
 * the mounted canvas — it never leaks into bb's own chrome.
 */
export function bbCanvasThemeCss(): string {
  return `
.dfbb-canvas-host {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: ${HOST.recessed};

  /* Shared app tokens the canvas and its satellite components read. */
  --text: ${HOST.foreground};
  --muted: ${HOST.muted};
  --panel: ${HOST.background};
  --panel2: ${HOST.recessed};
  --border2: ${alpha(HOST.foreground, 18)};
  --sidebar-hover: ${HOST.hover};
  --surface-soft: ${alpha(HOST.foreground, 5)};
  --surface-soft-text: ${HOST.muted};
  --surface-soft-border: ${alpha(HOST.foreground, 16)};
  --danger: ${HOST.destructive};
  --success: ${HOST.ring};
  --brand-gold: ${HOST.ring};
  --gold: ${HOST.ring};
  --accent: ${HOST.ring};
  --tooltip-bg: ${blend(HOST.foreground, 92, "transparent")};

  /* The editor plane and its chrome. */
  --canvas-dot-grid-image: radial-gradient(${alpha(HOST.foreground, 10)} 1px, transparent 1px);
  --canvas-dot-grid-size: 16px 16px;
  --canvas-topbar: ${HOST.background};
  --canvas-shell: ${HOST.recessed};
  --canvas-plane: ${HOST.recessed};
  --canvas-grid-line: ${alpha(HOST.foreground, 7)};
  --canvas-hairline: ${alpha(HOST.foreground, 9)};
  --canvas-rim: ${HOST.border};
  --canvas-rim-strong: ${alpha(HOST.foreground, 24)};
  --canvas-fill: ${alpha(HOST.foreground, 5)};
  --canvas-fill-hover: ${HOST.hover};
  --canvas-fill-active: ${alpha(HOST.foreground, 14)};

  /* Text ramp. */
  --canvas-text-strong: ${HOST.foreground};
  --canvas-text: ${alpha(HOST.foreground, 92)};
  --canvas-text-soft: ${HOST.muted};
  --canvas-text-faint: ${alpha(HOST.muted, 72)};
  --canvas-text-dim: ${alpha(HOST.muted, 48)};

  /* Floating surfaces: menus, inspector, find box, tooltips. */
  --canvas-panel: ${blend(HOST.background, 97, "transparent")};
  --canvas-panel-solid: ${HOST.background};
  --canvas-panel-shadow:
    0 0 0 1px ${alpha(HOST.foreground, 12)},
    0 4px 12px ${alpha(HOST.foreground, 12)},
    0 18px 50px ${alpha(HOST.foreground, 16)};
  --canvas-frame-shadow:
    0 0 0 1px ${alpha(HOST.foreground, 8)},
    0 18px 70px ${alpha(HOST.foreground, 14)};
  --canvas-drop-shadow: 0 10px 22px ${alpha(HOST.foreground, 14)};
  --canvas-shadow-soft: 0 3px 24px ${alpha(HOST.foreground, 8)};
  --canvas-shadow-lift: 0 18px 50px ${alpha(HOST.foreground, 18)};
  --canvas-shadow-pop: 0 16px 46px ${alpha(HOST.foreground, 16)};
  --canvas-shadow-side: 8px 0 34px ${alpha(HOST.foreground, 14)};
  --canvas-shadow-marker: 0 1px 8px ${alpha(HOST.foreground, 20)};
  --canvas-stack-shadow: 0 10px 20px ${alpha(HOST.foreground, 14)};
  --canvas-pin-ring: ${alpha(HOST.background, 78)};

  /* Fields, wells, veils and node bodies. */
  --canvas-field: ${blend(HOST.background, 92, "transparent")};
  --canvas-well: ${alpha(HOST.foreground, 7)};
  --canvas-veil: ${blend(HOST.recessed, 78, "transparent")};
  --canvas-handle-surface: ${blend(HOST.background, 88, "transparent")};
  --canvas-node-fill: ${blend(HOST.recessed, 82, "transparent")};
  --canvas-node-fill-image: ${alpha(HOST.recessed, 30)};
  --canvas-node-rim: ${alpha(HOST.foreground, 18)};
  --canvas-skeleton: ${alpha(HOST.foreground, 9)};
  --canvas-skeleton-sweep: ${alpha(HOST.foreground, 15)};
  --canvas-loading-surface: linear-gradient(135deg, ${blend(HOST.recessed, 96, "transparent")}, ${blend(HOST.hover, 88, "transparent")});
  --canvas-scrim: ${alpha(HOST.foreground, 46)};

  /* Accent chrome: bb's ring stands in for Diffui's gold. */
  --canvas-accent: ${HOST.ring};
  --canvas-accent-strong: ${blend(HOST.ring, 82, HOST.foreground)};
  --canvas-accent-bright: ${HOST.ring};
  --canvas-accent-bold: ${HOST.ring};
  --canvas-accent-contrast: ${HOST.background};
  --canvas-accent-line: ${alpha(HOST.ring, 72)};
  --canvas-accent-rim: ${alpha(HOST.ring, 55)};
  --canvas-accent-wash-soft: ${alpha(HOST.ring, 7)};
  --canvas-accent-wash: ${alpha(HOST.ring, 14)};
  --canvas-accent-wash-strong: ${alpha(HOST.ring, 22)};

  /* Selected / active chrome — the tool rail's pressed state included. Only
     the colours change here: the rail keeps Diffui's own SVGs and layout. */
  --canvas-active-wash: ${alpha(HOST.ring, 16)};
  --canvas-active-rim: ${alpha(HOST.ring, 55)};
  --canvas-active-shadow: 0 1px 3px ${alpha(HOST.foreground, 12)};
  --canvas-active-text: ${HOST.ring};

  /* Image-level selection and crops. */
  --canvas-select: ${HOST.ring};
  --canvas-select-wash: ${alpha(HOST.ring, 12)};
  --canvas-select-wash-soft: ${alpha(HOST.ring, 5)};
  --canvas-select-glow: ${alpha(HOST.ring, 26)};
  /* Resize handles keep a white ring in every theme: they sit on artwork,
     which can be any colour at all. */
  --canvas-select-ring: rgba(255, 255, 255, 0.9);

  --canvas-danger: ${HOST.destructive};
  --canvas-danger-rim: ${alpha(HOST.destructive, 50)};
  --canvas-danger-surface: ${blend(HOST.destructive, 8, HOST.background)};
  --canvas-snap-guide: ${alpha(HOST.destructive, 58)};

  /* Small chips that float on artwork. */
  --canvas-chip: ${blend(HOST.background, 82, "transparent")};
  --canvas-chip-hover: ${blend(HOST.background, 90, "transparent")};
  --canvas-chip-active: ${HOST.background};
  --canvas-chip-text: ${HOST.foreground};

${drawColorDeclarations()}
}

.dfbb-canvas-host diffui-canvas-workspace {
  flex: 1;
  min-height: 0;
  min-width: 0;
}
`;
}

const STYLE_ID = "diffui-bb-canvas-theme";

/** Injects the token layer. Idempotent per document. */
export function ensureBbCanvasTheme(): void {
  if (typeof document === "undefined") return;
  const existing = document.getElementById(STYLE_ID);
  const css = bbCanvasThemeCss();
  if (existing !== null) {
    if (existing.textContent !== css) existing.textContent = css;
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * bb's resolved light/dark mode, from the class or attribute its shell sets.
 * Falls back to the OS preference so a host that marks neither still lands on
 * the right ramp.
 */
export function hostThemeName(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  const root = document.documentElement;
  if (root.classList.contains("dark")) return "dark";
  if (root.classList.contains("light")) return "light";
  const attribute = (root.getAttribute("data-theme") ?? root.getAttribute("data-mode") ?? "").toLowerCase();
  if (attribute === "dark" || attribute === "light") return attribute;
  const scheme = getComputedStyle(root).colorScheme.trim().toLowerCase();
  if (scheme === "dark" || scheme === "light") return scheme;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

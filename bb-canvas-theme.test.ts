// The contract behind "the canvas is Diffui's, with bb's colours".
//
// bb mounts Diffui's own `<diffui-canvas-workspace>` — imported at runtime from
// the configured Diffui origin, never vendored into this repository — so the
// only thing the plugin may change about it is colour.
//
// Two layers of tests:
//
// - Standalone (always run): the token layer is structurally sound — every
//   drawn colour is expressed in bb's host tokens, everything is scoped to the
//   canvas mount, no Diffui hue is hardcoded, the cursor sprites resolve at the
//   Diffui origin, and the module loader never reaches into a Diffui checkout.
// - Drift checks (run when DIFFUI_REPO points at a jjcm/diffui checkout): read
//   the ACTUAL Diffui frontend and assert the layer covers every colour token
//   that canvas asks for — in shadow CSS and in the 2D context — so a new
//   token upstream cannot silently fall back to a Diffui hue inside bb.
//   Example: DIFFUI_REPO=~/src/diffui npm test

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { BB_CANVAS_DRAW_COLORS, bbCanvasThemeCss } from "./canvas/bb-canvas-theme.js";
import { CANVAS_MODULE_PATH, canvasModuleUrl } from "./canvas/diffui-canvas-element.js";

const pluginRoot = dirname(fileURLToPath(import.meta.url));

const diffuiRepo = process.env.DIFFUI_REPO === undefined ? "" : resolve(process.env.DIFFUI_REPO);
const frontendComponents = diffuiRepo === "" ? "" : join(diffuiRepo, "frontend/app/components");
const hasDiffuiCheckout = frontendComponents !== "" && existsSync(frontendComponents);

/** Every source file whose shadow CSS renders inside the mounted canvas. */
const CANVAS_SOURCES = [
  "diffui-canvas-workspace.js",
  "diffui-canvas-comment.js",
  "diffui-canvas-tool-tooltip.js",
  "diffui-inpaint-prompt.js",
  "diffui-prompt-suggestions.js",
  "diffui-button.js",
];

const THEME_CSS = bbCanvasThemeCss("https://diffui.test");

function canvasTokensReferencedByDiffui(): string[] {
  const tokens = new Set<string>();
  for (const file of CANVAS_SOURCES) {
    const source = readFileSync(join(frontendComponents, file), "utf8");
    for (const match of source.matchAll(/var\((--canvas-[a-z0-9-]+)/g)) {
      tokens.add(match[1]!);
    }
  }
  return [...tokens].sort();
}

describe("canvas module loading", () => {
  test("imports the product canvas from the Diffui origin, not from a checkout", () => {
    // The plugin lives in its own repository now. The one way it may obtain
    // the canvas is a runtime import from the configured Diffui origin — a
    // relative path into a jjcm/diffui working tree must never come back, and
    // no vendored copy of the workspace module may exist here.
    const loader = readFileSync(join(pluginRoot, "canvas/diffui-canvas-element.ts"), "utf8");
    expect(loader).not.toContain("../frontend/");
    expect(loader).toContain('CANVAS_MODULE_PATH = "/app/components/diffui-canvas-workspace.js"');
    expect(existsSync(join(pluginRoot, "canvas/diffui-canvas-workspace.js"))).toBe(false);
  });

  test("resolves the module URL on the session's Diffui origin", () => {
    expect(canvasModuleUrl("https://diffui.test")).toBe(
      `https://diffui.test${CANVAS_MODULE_PATH}`,
    );
    expect(canvasModuleUrl("http://localhost:3040///")).toBe(
      `http://localhost:3040${CANVAS_MODULE_PATH}`,
    );
  });
});

describe("bb canvas token layer", () => {
  test("every colour derives from a bb host token, so it follows bb's theme", () => {
    // The exceptions are the two colours Diffui deliberately keeps fixed in
    // both themes because they land on artwork, not on the canvas plane.
    const fixed = new Set(["liftRim", "cursorOutline", "resizeGuideRgb"]);
    for (const [key, value] of Object.entries(BB_CANVAS_DRAW_COLORS)) {
      if (fixed.has(key)) continue;
      expect(value, `${key} should be expressed in bb's tokens`).toMatch(/var\(--/);
    }
  });

  test("emits a --canvas-draw-* declaration per drawn colour, in the name the canvas resolves", () => {
    for (const key of Object.keys(BB_CANVAS_DRAW_COLORS)) {
      const variable = `--canvas-draw-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      expect(THEME_CSS).toContain(`${variable}:`);
    }
  });

  test("carries no Diffui app or landing colour of its own", () => {
    // Diffui's canvas gold / select blue, and the app's panel ramps: none of
    // them may appear in the bb layer.
    for (const hex of ["#d4a640", "#f5d36c", "#ffcc00", "#53acff", "#0b0d10", "#0f1318", "#e6edf3"]) {
      expect(THEME_CSS.toLowerCase()).not.toContain(hex);
    }
  });

  test("scopes itself to the canvas mount, so bb's own chrome is untouched", () => {
    for (const block of THEME_CSS.split("}")) {
      const selector = block.split("{")[0]?.trim() ?? "";
      if (selector === "") continue;
      expect(selector).toMatch(/^\.dfbb-canvas-host/);
    }
  });

  test("points the canvas cursor sprites at the Diffui origin they ship from", () => {
    expect(THEME_CSS).toContain('url("https://diffui.test/app/assets/canvas-cursor-pointer.png")');
    expect(THEME_CSS).toContain('url("https://diffui.test/app/assets/comment-cursor.png")');
  });

  test("leaves the tool rail's own geometry and icons alone", () => {
    // The rail is Diffui's markup. The layer may retune its colours (through
    // the active/fill/text tokens) but must never restyle the buttons or the
    // SVGs inside them.
    for (const selector of [".toolBtn", ".leftTools", ".toolCluster", "svg", "path"]) {
      expect(THEME_CSS).not.toContain(selector);
    }
  });
});

describe.skipIf(!hasDiffuiCheckout)("drift against the Diffui frontend (DIFFUI_REPO)", () => {
  test("defines every --canvas-* token Diffui's canvas reads", () => {
    const referenced = canvasTokensReferencedByDiffui();
    // Guard against the scan silently finding nothing (a moved file, a renamed
    // token prefix) and this passing vacuously.
    expect(referenced.length).toBeGreaterThan(40);
    expect(referenced.filter((token) => !THEME_CSS.includes(`${token}:`))).toEqual([]);
  });

  test("covers every colour Diffui's 2D drawing code asks for", async () => {
    const palette = (await import(
      pathToFileURL(join(frontendComponents, "canvas-draw-palette.js")).href
    )) as { CANVAS_DRAW_COLOR_KEYS: readonly string[] };
    expect(Object.keys(BB_CANVAS_DRAW_COLORS).sort()).toEqual(
      [...palette.CANVAS_DRAW_COLOR_KEYS].sort(),
    );
  });
});

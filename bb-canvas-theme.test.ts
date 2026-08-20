// The contract behind "the canvas is Diffui's, with bb's colours".
//
// bb mounts Diffui's own `<diffui-canvas-workspace>` — the copy of it in
// canvas/diffui/, bundled into the plugin — so the only thing the plugin may
// change about it is colour.
//
// Two layers of tests:
//
// - The token layer is structurally sound: every drawn colour is expressed in
//   bb's host tokens, everything is scoped to the canvas mount, no Diffui hue
//   is hardcoded, and the cursor sprites come from the bundle rather than a
//   Diffui origin.
// - Drift: the layer covers every colour token the ACTUAL canvas asks for — in
//   shadow CSS and in the 2D context — so a token that arrives with the next
//   `npm run vendor:canvas` cannot silently fall back to a Diffui hue inside
//   bb. These read the vendored canvas, so they always run; point DIFFUI_REPO
//   at a jjcm/diffui checkout to run them against that instead, ahead of a
//   re-vendor.
//   Example: DIFFUI_REPO=~/src/diffui npm test

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { BB_CANVAS_DRAW_COLORS, bbCanvasThemeCss } from "./canvas/bb-canvas-theme.js";

const pluginRoot = dirname(fileURLToPath(import.meta.url));
const vendoredComponents = join(pluginRoot, "canvas/diffui/app/components");

const diffuiRepo = process.env.DIFFUI_REPO === undefined ? "" : resolve(process.env.DIFFUI_REPO);
const checkoutComponents = diffuiRepo === "" ? "" : join(diffuiRepo, "frontend/app/components");
const canvasComponents =
  checkoutComponents !== "" && existsSync(checkoutComponents) ? checkoutComponents : vendoredComponents;

/** Every source file whose shadow CSS renders inside the mounted canvas. */
const CANVAS_SOURCES = [
  "diffui-canvas-workspace.js",
  "diffui-canvas-comment.js",
  "diffui-canvas-tool-tooltip.js",
  "diffui-inpaint-prompt.js",
  "diffui-prompt-suggestions.js",
  "diffui-button.js",
];

const THEME_CSS = bbCanvasThemeCss();

function canvasTokensReferencedByDiffui(): string[] {
  const tokens = new Set<string>();
  for (const file of CANVAS_SOURCES) {
    const source = readFileSync(join(canvasComponents, file), "utf8");
    for (const match of source.matchAll(/var\((--canvas-[a-z0-9-]+)/g)) {
      tokens.add(match[1]!);
    }
  }
  return [...tokens].sort();
}

describe("canvas module loading", () => {
  test("mounts the copy of the canvas in this repository, never a remote module", () => {
    // The plugin is self-contained: the canvas is bundled from canvas/diffui/,
    // and no build of this loader may reach a Diffui origin for frontend code.
    const loader = readFileSync(join(pluginRoot, "canvas/diffui-canvas-element.ts"), "utf8");
    expect(loader).toContain('await import("./diffui-bb/vendored-canvas.js")');
    expect(loader).not.toMatch(/import\([^)]*(baseUrl|API_BASE|https?:)/i);
    expect(loader).not.toContain("/app/components/diffui-canvas-workspace.js");
    expect(existsSync(join(vendoredComponents, "diffui-canvas-workspace.js"))).toBe(true);
  });

  test("keeps the embed globals it sets to the API contract", () => {
    const loader = readFileSync(join(pluginRoot, "canvas/diffui-canvas-element.ts"), "utf8");
    for (const global of ["DIFFUI_EMBED", "DIFFUI_API_BASE", "DIFFUI_API_KEY"]) {
      expect(loader).toContain(`view.${global} =`);
    }
    // Build with bb is unconditional in this copy (see the patch set), so the
    // gating global is gone rather than set-and-ignored.
    expect(loader).not.toContain("view.DIFFUI_BB_HOST");
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

  test("restyles nothing but colour: no sprite, geometry or asset URL of its own", () => {
    // The cursor sprites belong to the canvas and are bundled with it
    // (canvas-vendor.test.ts); this layer has no business naming them.
    expect(THEME_CSS).not.toContain("url(");
    expect(THEME_CSS).not.toContain("/app/assets/");
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

describe("drift against Diffui's canvas", () => {
  test("defines every --canvas-* colour token the canvas reads", () => {
    // Everything except --canvas-cursor-*: those are the canvas's own sprites,
    // which it declares on itself from the bundle (canvas-vendor.test.ts).
    const referenced = canvasTokensReferencedByDiffui().filter(
      (token) => !token.startsWith("--canvas-cursor-"),
    );
    // Guard against the scan silently finding nothing (a moved file, a renamed
    // token prefix) and this passing vacuously.
    expect(referenced.length).toBeGreaterThan(40);
    expect(referenced.filter((token) => !THEME_CSS.includes(`${token}:`))).toEqual([]);
  });

  test("covers every colour the canvas's 2D drawing code asks for", async () => {
    const palette = (await import(
      pathToFileURL(join(canvasComponents, "canvas-draw-palette.js")).href
    )) as { CANVAS_DRAW_COLOR_KEYS: readonly string[] };
    expect(Object.keys(BB_CANVAS_DRAW_COLORS).sort()).toEqual(
      [...palette.CANVAS_DRAW_COLOR_KEYS].sort(),
    );
  });
});

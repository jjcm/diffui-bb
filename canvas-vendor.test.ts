// The copy of Diffui's canvas in canvas/diffui/ is the canvas bb runs, so
// these are the guards on the copy itself:
//
// - it is what the vendor script wrote (MANIFEST.json hashes every file), so a
//   hand-edit to a vendored module shows up as a failing test instead of as a
//   difference nobody can see;
// - every difference from upstream is one of the recorded bb patches;
// - it is self-contained: no module reaches a Diffui origin for frontend code
//   or sprites, and every sprite it draws is bundled.
//
// Regenerating the copy: `npm run vendor:canvas` (see canvas/README.md).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { BB_CANVAS_PATCHES } from "./scripts/diffui-canvas-bb-patches.mjs";
import { BB_CANVAS_ASSETS, bbCanvasAsset } from "./canvas/diffui-bb/canvas-assets.js";

const pluginRoot = dirname(fileURLToPath(import.meta.url));
const vendorRoot = join(pluginRoot, "canvas/diffui");

interface Manifest {
  source: { kind: string };
  entry: string;
  modules: Record<string, { upstreamSha256: string; sha256: string; patches?: string[] }>;
  assets: Record<string, { sha256: string; bytes: number }>;
}

const manifest = JSON.parse(readFileSync(join(vendorRoot, "MANIFEST.json"), "utf8")) as Manifest;

function vendoredFiles(directory = vendorRoot): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...vendoredFiles(path));
    else if (entry !== "MANIFEST.json") found.push(relative(vendorRoot, path).split(sep).join("/"));
  }
  return found.sort();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(join(vendorRoot, path))).digest("hex");
}

describe("the vendored canvas", () => {
  test("is exactly the module graph the manifest records", () => {
    expect(vendoredFiles()).toEqual(Object.keys(manifest.modules).sort());
    for (const [file, entry] of Object.entries(manifest.modules)) {
      expect(sha256(file), `${file} does not match MANIFEST.json`).toBe(entry.sha256);
    }
  });

  test("carries the whole canvas, not just its entry point", () => {
    expect(manifest.entry).toBe("/app/components/diffui-canvas-workspace.js");
    // The workspace element, the satellites it composes, the collab layer, the
    // canvas engine and the CRDT vendor bundle — the graph esbuild bundles.
    for (const file of [
      "app/components/diffui-canvas-workspace.js",
      "app/components/diffui-canvas-comment.js",
      "app/components/diffui-inpaint-prompt.js",
      "app/components/canvas-draw-palette.js",
      "app/collab/canvas-collab-provider.js",
      "app/wasm/diffui_canvas.js",
      "app/vendor/yjs.bundle.mjs",
      "embed-bridge.js",
      "image-urls.js",
    ]) {
      expect(Object.keys(manifest.modules)).toContain(file);
    }
    expect(Object.keys(manifest.modules).length).toBeGreaterThan(30);
  });

  test("differs from upstream only by the recorded bb patches", () => {
    const patchedFiles = new Set(BB_CANVAS_PATCHES.map((patch) => patch.file));
    for (const [file, entry] of Object.entries(manifest.modules)) {
      const patched = entry.sha256 !== entry.upstreamSha256;
      expect(patched, `${file} is ${patched ? "" : "not "}modified`).toBe(patchedFiles.has(file));
      expect(entry.patches !== undefined).toBe(patched);
    }
    for (const patch of BB_CANVAS_PATCHES) {
      const source = readFileSync(join(vendorRoot, patch.file), "utf8");
      expect(source, `${patch.file}: ${patch.why}`).toContain(patch.replace);
    }
  });

  test("makes Build with bb unconditional, so no host global gates it", () => {
    const workspace = readFileSync(join(vendorRoot, "app/components/diffui-canvas-workspace.js"), "utf8");
    expect(workspace).toContain("_bbHost() {\n    return true;\n  }");
    expect(workspace).not.toContain("window.DIFFUI_BB_HOST ===");
    expect(workspace).toContain('data-action="build-with-bb"');
  });

  test("Build with bb emits the copy-for-agent prompt instead of spawning via the relay", () => {
    const workspace = readFileSync(join(vendorRoot, "app/components/diffui-canvas-workspace.js"), "utf8");
    expect(workspace).toContain('diffui-canvas:build-with-bb');
    expect(workspace).toContain("this._agentCopyText(buildUrl)");
    expect(workspace).toContain('/api/agent-build-link');
  });

  test("stackAdd plus icon uses currentColor so it follows bb chip-text tokens", () => {
    const workspace = readFileSync(join(vendorRoot, "app/components/diffui-canvas-workspace.js"), "utf8");
    const fn = workspace.slice(workspace.indexOf("function stackPlusIcon()"), workspace.indexOf("function nextFrame()"));
    expect(fn).toContain('setAttribute("fill", "currentColor")');
    expect(fn).not.toContain('setAttribute("fill", "black")');
    expect(workspace).toContain(".stackAdd svg rect {\n      fill: currentColor;");
  });

  test("never reaches a Diffui origin for frontend code", () => {
    for (const file of vendoredFiles()) {
      const source = readFileSync(join(vendorRoot, file), "utf8");
      // Prose in a comment may cite a URL (the SVG namespace, a spec); code may
      // not go and get anything from Diffui.
      expect(source, `${file} points at a Diffui origin`).not.toMatch(/https?:\/\/[a-z0-9.-]*diffui/i);
      expect(source, `${file} imports off-origin`).not.toMatch(/(?:from|import\s*\(\s*)["']https?:/);
    }
  });
});

describe("the bundled sprites", () => {
  test("cover every asset the vendored canvas asks for by name", () => {
    const asked = new Set<string>();
    for (const file of vendoredFiles()) {
      const source = readFileSync(join(vendorRoot, file), "utf8");
      for (const match of source.matchAll(/\/app\/assets\/[A-Za-z0-9._/-]+/g)) {
        if (/\.[a-z0-9]+$/i.test(match[0])) asked.add(match[0]);
      }
    }
    expect(asked.size).toBeGreaterThan(0);
    for (const path of asked) {
      expect(bbCanvasAsset(path), `${path} is not bundled`).toMatch(/^data:image\//);
    }
  });

  test("include one collab cursor per brand colour", () => {
    const colors = readFileSync(join(vendorRoot, "app/collab/collab-colors.js"), "utf8");
    const hexes = [...colors.matchAll(/#([0-9A-Fa-f]{6})/g)].map((match) => match[1]!.toUpperCase());
    expect(hexes.length).toBeGreaterThan(0);
    for (const hex of hexes) {
      expect(bbCanvasAsset(`/app/assets/collab-cursors/${hex}.png`)).toMatch(/^data:image\/png;base64,/);
    }
  });

  test("are the bytes the manifest hashed", () => {
    expect(Object.keys(BB_CANVAS_ASSETS).sort()).toEqual(Object.keys(manifest.assets).sort());
    for (const [path, entry] of Object.entries(manifest.assets)) {
      const base64 = BB_CANVAS_ASSETS[path]!.split(",")[1]!;
      const bytes = Buffer.from(base64, "base64");
      expect(bytes.length).toBe(entry.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    }
  });

  test("are what every --canvas-cursor-* token resolves to", () => {
    // Upstream's `:host` block points these at /app/assets/…, which in a bb
    // page would resolve against bb's own origin and 404. Patched, each one
    // asks the embed bridge, which answers with the bundled sprite.
    const workspace = readFileSync(join(vendorRoot, "app/components/diffui-canvas-workspace.js"), "utf8");
    const declarations = [...workspace.matchAll(/(--canvas-cursor-[a-z-]+):([^;]+);/g)];
    expect(declarations.length).toBe(3);
    for (const [, token, value] of declarations) {
      expect(value, `${token} is not bundled`).toContain('resolveEmbedAssetUrl("/app/assets/');
      const path = value.match(/resolveEmbedAssetUrl\("([^"]+)"\)/)![1]!;
      expect(bbCanvasAsset(path)).toMatch(/^data:image\/png;base64,/);
    }
  });
});

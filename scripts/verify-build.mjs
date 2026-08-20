// Mirrors what `bb plugin build` does with its pinned esbuild toolchain
// (github.com/get-bb/bb packages/plugin-build) closely enough to catch a
// bundling break in CI without a bb install:
//
// - server bundle: ESM, platform node, target node22, externals
//   @get-bb/plugin-sdk + better-sqlite3 (node builtins auto-external) — so
//   zod and lib/ must bundle from this package's own dependencies.
// - app bundle: ESM, platform browser, target es2022, with react, the
//   react jsx runtimes, @get-bb/plugin-sdk/app, and the host-shimmed portal
//   packages marked external (bb maps them onto globalThis.__bbPluginRuntime).
//
// It then checks the app bundle for the property that makes this plugin
// self-contained: Diffui's canvas is IN it (canvas/diffui/, mounted by
// canvas/diffui-canvas-element.ts), and nothing in it goes to a Diffui origin
// for frontend code.
//
// Output lands in dist-verify/ (never committed); `bb plugin build` remains
// the real packaging path.
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "dist-verify");

const APP_SHIMS = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@get-bb/plugin-sdk/app",
  "@pierre/diffs",
  "@pierre/diffs/react",
  "@radix-ui/react-alert-dialog",
  "@radix-ui/react-context-menu",
  "@radix-ui/react-dialog",
  "@radix-ui/react-dropdown-menu",
  "@radix-ui/react-hover-card",
  "@radix-ui/react-menubar",
  "@radix-ui/react-navigation-menu",
  "@radix-ui/react-popover",
  "@radix-ui/react-select",
  "@radix-ui/react-tooltip",
  "sonner",
  "vaul",
];

await rm(outDir, { recursive: true, force: true });

await build({
  entryPoints: [join(root, "server.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: join(outDir, "server.js"),
  external: ["@get-bb/plugin-sdk", "better-sqlite3"],
  logLevel: "error",
});
console.log("server bundle ok (dist-verify/server.js)");

const app = await build({
  entryPoints: [join(root, "app.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  outfile: join(outDir, "app.js"),
  external: APP_SHIMS,
  logLevel: "error",
  write: false,
});
const appBundle = app.outputFiles[0].text;
console.log(`app bundle ok (${Math.round(appBundle.length / 1024)} KB)`);

// Diffui's canvas is in the bundle: the custom element, the engine behind it,
// the collab layer, and the sprites it draws.
const MUST_CONTAIN = [
  ['customElements.define("diffui-canvas-workspace"', "the canvas custom element"],
  ["new CanvasEngine(", "the canvas engine"],
  ["CanvasCollabProvider", "the collab layer"],
  ["data:image/png;base64,", "the bundled cursor sprites"],
];
for (const [needle, what] of MUST_CONTAIN) {
  if (!appBundle.includes(needle)) {
    throw new Error(`app bundle is missing ${what} (${needle})`);
  }
}

// …and nothing in it fetches frontend code or assets from a Diffui origin. The
// canvas module path is the specific regression this guards: the plugin used
// to `import()` it off `DIFFUI_API_BASE` at runtime.
// A server-relative specifier for the canvas module: what the plugin used to
// join onto DIFFUI_API_BASE and import. esbuild's own path comments name the
// vendored file too, hence the leading quote.
const MUST_NOT_MATCH = [
  [
    /["'`]\/app\/components\/diffui-canvas-workspace\.js/,
    "the canvas module as a server-relative specifier (it used to be imported off DIFFUI_API_BASE)",
  ],
  [/url\(["']?\/app\/assets\//, "a cursor sprite requested from whatever origin serves the page"],
  [/import\s*\(\s*["'`]https?:/, "a module imported from a remote origin at runtime"],
  [/import\s*\(\s*[^)]*API_BASE/, "a module imported from the Diffui API base at runtime"],
];
for (const [pattern, what] of MUST_NOT_MATCH) {
  const match = appBundle.match(pattern);
  if (match !== null) {
    throw new Error(`app bundle contains ${what}: ${JSON.stringify(match[0])}`);
  }
}
console.log("app bundle carries Diffui's canvas and imports no remote module");

await rm(outDir, { recursive: true, force: true });
console.log("bb plugin build contract verified");

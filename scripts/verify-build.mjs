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

await build({
  entryPoints: [join(root, "app.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  outfile: join(outDir, "app.js"),
  external: APP_SHIMS,
  logLevel: "error",
});
console.log("app bundle ok (dist-verify/app.js)");

await rm(outDir, { recursive: true, force: true });
console.log("bb plugin build contract verified");

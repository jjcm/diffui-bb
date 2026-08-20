// Snapshots Diffui's real canvas into this repository.
//
// The plugin ships the product canvas rather than importing it from a Diffui
// origin at runtime (see canvas/README.md). This script produces that copy:
// it walks the ACTUAL module graph of
// `/app/components/diffui-canvas-workspace.js` with esbuild's resolver — so
// the file list is the one esbuild would bundle, not a regex guess — writes
// every module verbatim under `canvas/diffui/`, inlines the sprites the canvas
// draws into `canvas/diffui-bb/canvas-assets.js`, applies the bb patch set
// (scripts/diffui-canvas-bb-patches.mjs), and records all of it in
// `canvas/diffui/MANIFEST.json`.
//
// Two sources, same graph:
//
//   node scripts/vendor-diffui-canvas.mjs --repo jjcm/diffui --ref main
//       Reads frontend/ out of the private repository through `gh` (the
//       canonical source; needs a token that can see jjcm/diffui).
//   node scripts/vendor-diffui-canvas.mjs --origin https://diffui.ai
//       Reads the same unbundled ES modules from a running Diffui, which
//       serves frontend/ as-is. Use when gh cannot reach the repository.
//
// `--check` re-fetches upstream and diffs it against the committed snapshot
// without writing anything: it fails when upstream moved, and prints which
// files drifted.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { applyBbCanvasPatches, BB_CANVAS_PATCHES } from "./diffui-canvas-bb-patches.mjs";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** The custom element bb mounts, and the root of everything vendored. */
const ENTRY = "/app/components/diffui-canvas-workspace.js";
/** Where frontend/ lives inside jjcm/diffui. */
const REPO_PREFIX = "frontend";
const OUT_DIR = join(root, "canvas/diffui");
const ASSETS_MODULE = join(root, "canvas/diffui-bb/canvas-assets.js");
const NAMESPACE = "diffui-upstream";

const MIME_TYPES = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

function parseArgs(argv) {
  const args = { origin: "", repo: "", ref: "main", check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--origin") (args.origin = String(value ?? "")), (index += 1);
    else if (flag === "--repo") (args.repo = String(value ?? "")), (index += 1);
    else if (flag === "--ref") (args.ref = String(value ?? "")), (index += 1);
    else if (flag === "--check") args.check = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (args.origin === "" && args.repo === "") args.origin = "https://diffui.ai";
  if (args.origin !== "" && args.repo !== "") {
    throw new Error("--origin and --repo are alternative sources; pass one");
  }
  return args;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Reads one frontend path (`/app/...`) out of jjcm/diffui through `gh`. */
function githubSource(repo, ref) {
  return {
    describe: async () => {
      const { stdout } = await execFileAsync("gh", ["api", `repos/${repo}/commits/${ref}`, "--jq", ".sha"]);
      return { kind: "github", repo, ref, commit: stdout.trim() };
    },
    read: async (path) => {
      const url = `repos/${repo}/contents/${REPO_PREFIX}${path}?ref=${encodeURIComponent(ref)}`;
      try {
        const { stdout } = await execFileAsync(
          "gh",
          ["api", "-H", "Accept: application/vnd.github.raw", url],
          { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
        );
        return stdout;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`gh could not read ${REPO_PREFIX}${path} from ${repo}@${ref}: ${detail}`);
      }
    },
  };
}

/**
 * Reads one frontend path off a running Diffui.
 *
 * Diffui serves frontend/ unbundled, so a module fetched here is the repository
 * file. A missing path falls through to the app's HTML shell, which is why the
 * response is checked for markup rather than trusted on status alone.
 */
function originSource(origin) {
  const base = origin.replace(/\/+$/, "");
  return {
    describe: async () => ({ kind: "origin", origin: base }),
    read: async (path) => {
      const response = await fetch(`${base}${path}`);
      if (!response.ok) throw new Error(`${base}${path} responded ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      const isModule = /\.(js|mjs)$/.test(path);
      if (isModule && /^\s*(<!doctype|<html)/i.test(body.subarray(0, 64).toString("utf8"))) {
        throw new Error(
          `${base}${path} served the app HTML shell, so that module does not exist upstream`,
        );
      }
      return body;
    },
  };
}

/**
 * Walks the module graph with esbuild and returns every file it reaches.
 *
 * esbuild does the resolving, so the result is the real import graph:
 * specifiers inside comments and strings cannot pull a file in, and a
 * specifier esbuild cannot resolve fails the run instead of being skipped.
 */
async function collectModules(source) {
  /** @type {Map<string, Buffer>} */
  const modules = new Map();
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    plugins: [
      {
        name: "diffui-upstream",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point") return { path: ENTRY, namespace: NAMESPACE };
            if (args.namespace !== NAMESPACE) return null;
            const specifier = args.path;
            if (/^(https?:)?\/\//.test(specifier) || specifier.startsWith("data:")) {
              return {
                errors: [{ text: `${args.importer} imports off-origin ${specifier}` }],
              };
            }
            if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
              return {
                errors: [
                  {
                    text:
                      `${args.importer} imports the bare specifier ${specifier}. ` +
                      `Diffui's frontend has no package resolution, so vendoring it needs a decision.`,
                  },
                ],
              };
            }
            const path = specifier.startsWith("/")
              ? specifier
              : posix.normalize(posix.join(posix.dirname(args.importer), specifier));
            return { path, namespace: NAMESPACE };
          });
          pluginBuild.onLoad({ filter: /.*/, namespace: NAMESPACE }, async (args) => {
            const cached = modules.get(args.path);
            if (cached !== undefined) return { contents: cached, loader: "js" };
            const contents = await source.read(args.path);
            modules.set(args.path, contents);
            return { contents, loader: "js" };
          });
        },
      },
    ],
  });
  return modules;
}

/**
 * Every `/app/assets/...` sprite the vendored modules reach for.
 *
 * The literal paths come out of the sources; the collab cursors are one file
 * per brand colour behind a template literal, so they are expanded from the
 * colour list itself.
 */
function assetPaths(modules) {
  const paths = new Set();
  for (const contents of modules.values()) {
    const text = contents.toString("utf8");
    for (const match of text.matchAll(/\/app\/assets\/[A-Za-z0-9._\-/]+/g)) {
      const path = match[0];
      if (/\.[a-z0-9]+$/i.test(path)) paths.add(path);
    }
  }
  const colors = modules.get("/app/collab/collab-colors.js");
  if (colors !== undefined) {
    const list = colors.toString("utf8").match(/DIFFUI_COLLAB_COLORS\s*=\s*\[([^\]]+)\]/);
    const hexes = list === null ? [] : [...list[1].matchAll(/#([0-9A-Fa-f]{6})/g)].map((m) => m[1].toUpperCase());
    if (hexes.length === 0) {
      throw new Error("could not read DIFFUI_COLLAB_COLORS: the collab cursor sprites would be missed");
    }
    for (const hex of hexes) paths.add(`/app/assets/collab-cursors/${hex}.png`);
  }
  return [...paths].sort();
}

function dataUrl(path, bytes) {
  const extension = path.slice(path.lastIndexOf("."));
  const mime = MIME_TYPES[extension];
  if (mime === undefined) throw new Error(`no mime type for ${path}`);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function assetsModuleSource(assets) {
  const entries = [...assets.entries()]
    .map(([path, { url }]) => `  ${JSON.stringify(path)}: ${JSON.stringify(url)},`)
    .join("\n");
  return `// GENERATED by scripts/vendor-diffui-canvas.mjs — do not edit by hand.
//
// The sprites Diffui's canvas draws, inlined so the copy of that canvas in
// this repository paints without a request to a Diffui origin: the pointer,
// duplicate and comment cursors, and one collab cursor per brand colour.
// Regenerate with the vendor script; the hashes are in
// canvas/diffui/MANIFEST.json.

/** Server-relative asset path → data URL. */
export const BB_CANVAS_ASSETS = Object.freeze({
${entries}
});

/**
 * The bundled sprite for a Diffui asset path, or "" when the path is not one
 * (which is every API path — those still resolve against DIFFUI_API_BASE).
 */
export function bbCanvasAsset(path) {
  const key = String(path ?? "").trim();
  return Object.prototype.hasOwnProperty.call(BB_CANVAS_ASSETS, key) ? BB_CANVAS_ASSETS[key] : "";
}
`;
}

/** Snapshot-relative path ("/app/x.js" → "app/x.js"). */
function outPath(modulePath) {
  return modulePath.replace(/^\/+/, "");
}

/** Fails when the written tree does not resolve and parse as a module graph. */
async function verifyTree() {
  await build({
    entryPoints: [join(OUT_DIR, outPath(ENTRY))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "error",
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = args.repo === "" ? originSource(args.origin) : githubSource(args.repo, args.ref);
  const description = await source.describe();

  const modules = await collectModules(source);
  if (!modules.has(ENTRY)) throw new Error(`the graph walk never loaded ${ENTRY}`);

  const assets = new Map();
  for (const path of assetPaths(modules)) {
    const bytes = await source.read(path);
    assets.set(path, { url: dataUrl(path, bytes), sha256: sha256(bytes), bytes: bytes.length });
  }

  /** @type {Record<string, { upstreamSha256: string, sha256: string, patches?: string[] }>} */
  const manifestModules = {};
  /** @type {Map<string, Buffer>} */
  const vendored = new Map();
  for (const [path, contents] of [...modules].sort(([a], [b]) => a.localeCompare(b))) {
    const file = outPath(path);
    const upstream = contents.toString("utf8");
    const { source: patched, applied } = applyBbCanvasPatches(file, upstream);
    const bytes = Buffer.from(patched, "utf8");
    vendored.set(file, bytes);
    manifestModules[file] = {
      upstreamSha256: sha256(contents),
      sha256: sha256(bytes),
      ...(applied.length > 0 ? { patches: applied } : {}),
    };
  }

  const unmatched = BB_CANVAS_PATCHES.filter((patch) => !vendored.has(patch.file));
  if (unmatched.length > 0) {
    throw new Error(
      `bb patches target files that are not in the graph: ${unmatched.map((p) => p.file).join(", ")}`,
    );
  }

  const manifest = {
    note:
      "Diffui's canvas, vendored. Regenerate with scripts/vendor-diffui-canvas.mjs; " +
      "every difference from upstream is in scripts/diffui-canvas-bb-patches.mjs.",
    source: { ...description, fetchedAt: new Date().toISOString() },
    entry: ENTRY,
    modules: manifestModules,
    assets: Object.fromEntries(
      [...assets].map(([path, asset]) => [path, { sha256: asset.sha256, bytes: asset.bytes }]),
    ),
  };

  if (args.check) {
    const drifted = [];
    for (const [file, bytes] of vendored) {
      const committed = await readFile(join(OUT_DIR, file)).catch(() => null);
      if (committed === null || !committed.equals(bytes)) drifted.push(file);
    }
    const committedAssets = await readFile(ASSETS_MODULE, "utf8").catch(() => "");
    if (committedAssets !== assetsModuleSource(assets)) drifted.push("canvas/diffui-bb/canvas-assets.js");
    if (drifted.length > 0) {
      console.error(`upstream moved; re-run the vendor script. Drifted:\n  ${drifted.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`snapshot matches upstream (${vendored.size} modules, ${assets.size} assets)`);
    return;
  }

  await rm(OUT_DIR, { recursive: true, force: true });
  for (const [file, bytes] of vendored) {
    const destination = join(OUT_DIR, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  await mkdir(dirname(ASSETS_MODULE), { recursive: true });
  await writeFile(ASSETS_MODULE, assetsModuleSource(assets));
  await writeFile(join(OUT_DIR, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  await verifyTree();

  const bytes = [...vendored.values()].reduce((total, buffer) => total + buffer.length, 0);
  console.log(
    `vendored ${vendored.size} modules (${Math.round(bytes / 1024)} KB) and ` +
      `${assets.size} sprites from ${JSON.stringify(description)}`,
  );
}

await main();

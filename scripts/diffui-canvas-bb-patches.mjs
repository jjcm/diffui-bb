// Every difference between Diffui's canvas and the copy in this repository.
//
// `canvas/diffui/` is a byte-for-byte mirror of Diffui's frontend module graph
// except for the edits below, which `scripts/vendor-diffui-canvas.mjs` applies
// while snapshotting and records in `canvas/diffui/MANIFEST.json`. Each `find`
// must match its file exactly once or the vendor run fails — so an upstream
// rewrite surfaces as a failed snapshot instead of a silently dropped patch.
//
// Two reasons a patch may exist, and no others:
//
// 1. Self-containment. This copy must not fetch frontend assets from a Diffui
//    origin; the cursor sprites it draws ship inside the plugin bundle instead
//    (`canvas/diffui-bb/canvas-assets.js`, generated from the same snapshot).
// 2. bb-specific behaviour. This copy only ever runs inside the bb plugin, so
//    the checks Diffui needs to keep bb-only features out of diffui.ai are
//    dead weight here.

/** @typedef {{ file: string, why: string, find: string, replace: string }} BbCanvasPatch */

/** @type {readonly BbCanvasPatch[]} */
export const BB_CANVAS_PATCHES = Object.freeze([
  {
    file: "embed-bridge.js",
    why: "self-containment: /app/assets/* resolve to the sprites bundled with this copy",
    find: `export function resolveEmbedAssetUrl(path) {
  const p = String(path ?? "").trim();`,
    replace: `export function resolveEmbedAssetUrl(path) {
  const p = String(path ?? "").trim();
  // bb: the canvas's own sprites are vendored into the plugin bundle, so they
  // resolve to a data URL and never become a request to the Diffui origin.
  // Everything else (/files/..., API paths) still resolves against the API
  // base below.
  const bundled = bbCanvasAsset(p);
  if (bundled !== "") return bundled;`,
  },
  {
    file: "embed-bridge.js",
    why: "self-containment: import for the bundled sprite lookup above",
    find: `/** Cursor / IDE embed: API key auth and parent-frame messaging. */`,
    replace: `/** Cursor / IDE embed: API key auth and parent-frame messaging. */

import { bbCanvasAsset } from "../diffui-bb/canvas-assets.js";`,
  },
  {
    file: "app/collab/collab-cursor.js",
    why: "self-containment: collab cursor sprites are bundled, and upstream never routed them through the embed bridge",
    find: `import { DIFFUI_COLLAB_COLORS, resolveCollabColor } from "./collab-colors.js";`,
    replace: `import { DIFFUI_COLLAB_COLORS, resolveCollabColor } from "./collab-colors.js";
import { resolveEmbedAssetUrl } from "../../embed-bridge.js";`,
  },
  {
    file: "app/collab/collab-cursor.js",
    why: "self-containment: same, at the two return sites",
    find: `  if (!DIFFUI_COLLAB_COLORS.some((entry) => entry.replace(/^#/, "").toUpperCase() === hex)) {
    return \`/app/assets/collab-cursors/236B42.png\`;
  }
  return \`/app/assets/collab-cursors/\${hex}.png\`;`,
    replace: `  if (!DIFFUI_COLLAB_COLORS.some((entry) => entry.replace(/^#/, "").toUpperCase() === hex)) {
    return resolveEmbedAssetUrl(\`/app/assets/collab-cursors/236B42.png\`);
  }
  return resolveEmbedAssetUrl(\`/app/assets/collab-cursors/\${hex}.png\`);`,
  },
  {
    file: "app/components/diffui-canvas-workspace.js",
    why: "self-containment: the three cursor sprites the element declares on itself",
    find: `      --canvas-cursor-default: image-set(url("/app/assets/canvas-cursor-pointer.png") 2x) 9 9, default;
      --canvas-cursor-duplicate: image-set(url("/app/assets/canvas-cursor-duplicate.png") 2x) 9 9, ew-resize;
      --canvas-cursor-comment: image-set(url("/app/assets/comment-cursor.png") 2x) 2 2, copy;`,
    replace: `      /* bb: the sprites ship inside this copy of the canvas, so they paint from
         the bundle instead of being fetched from whatever origin serves the
         page. This block is inside a template literal, and resolveEmbedAssetUrl
         answers with the bundled data URL. */
      --canvas-cursor-default: image-set(url("\${resolveEmbedAssetUrl("/app/assets/canvas-cursor-pointer.png")}") 2x) 9 9, default;
      --canvas-cursor-duplicate: image-set(url("\${resolveEmbedAssetUrl("/app/assets/canvas-cursor-duplicate.png")}") 2x) 9 9, ew-resize;
      --canvas-cursor-comment: image-set(url("\${resolveEmbedAssetUrl("/app/assets/comment-cursor.png")}") 2x) 2 2, copy;`,
  },
  {
    file: "app/components/diffui-canvas-workspace.js",
    why: "bb behaviour: the note above the availability rule, which described the global that is gone",
    find: `  // "Build with bb" belongs to the bb plugin, not to diffui.com: the plugin
  // sets DIFFUI_BB_HOST before it imports this module, and nothing else does.
  // Inside that host it shows on canvases created for bb always (offline
  // clicks explain themselves), and on any other canvas once a bridge is live.`,
    replace: `  // "Build with bb" belongs to the bb plugin, not to diffui.com — and this
  // copy of the canvas is the plugin's, so the host is a given. It shows on
  // canvases created for bb always (offline clicks explain themselves), and on
  // any other canvas once a bridge is live.`,
  },
  {
    file: "app/components/diffui-canvas-workspace.js",
    why: 'bb behaviour: this copy only runs in bb, so "Build with bb" needs no DIFFUI_BB_HOST global',
    find: `  // True only when this canvas is running inside the bb plugin.
  _bbHost() {
    return typeof window !== "undefined" && window.DIFFUI_BB_HOST === true;
  }`,
    replace: `  // True only when this canvas is running inside the bb plugin. Upstream reads
  // window.DIFFUI_BB_HOST here because diffui.ai serves the same module to
  // everyone; this copy ships inside the plugin and has no other host, so the
  // answer is always yes and bb-only actions need no global to switch them on.
  _bbHost() {
    return true;
  }`,
  },
  {
    file: "app/components/diffui-canvas-workspace.js",
    why: "bb behaviour: Build with bb opens a new thread prefilled with the Copy for agent prompt",
    find: `  // Sends the selected designs into the user's bb. Preferred transport is the
  // plugin's direct build route on localhost (token auth + per-route CORS —
  // needs bb with getbb.app's experimental_cors, jjcm/bb#6); anything short of
  // a readable success falls back to the server-side bridge relay, and a
  // downed bridge falls back again to putting the same prompt on the
  // clipboard that Copy for agent would.
  async _buildNodesWithBb(nodes) {
    const pages = this._agentBuildPagesFromNodes(nodes);
    if (!pages.length) throw new Error("Build with bb unavailable");
    this._setStatus("Sending to bb…");
    const body = {
      bundle_name: this._agentBundleNameFromNodes(nodes),
      pages,
      project_id: this._projectId,
      project_title: this._projectFileTitle,
    };
    const direct = await this._buildWithBbDirect(body);
    if (direct) {
      this._announceBbBuild(direct);
      return;
    }
    let res;
    try {
      res = await this._api("/api/bb/build", { method: "POST", body: JSON.stringify(body) });
    } catch (error) {
      const fallbackUrl = String(error?.data?.buildUrl || "").trim();
      if (fallbackUrl && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(this._agentCopyText(fallbackUrl));
        const reason = error?.data?.error === "bb_bridge_offline"
          ? "bb isn't connected"
          : "bb didn't answer";
        this._setStatus("Copied prompt for agent");
        this._showToast(\`\${reason} — copied build prompt instead\`);
        this._refreshBbBridgeStatus().catch(() => null);
        return;
      }
      throw new Error(error?.data?.message || error.message || "Build with bb failed");
    }
    this._announceBbBuild(res);
  }`,
    replace: `  // Sends the selected designs into bb as a new thread whose composer is
  // prefilled with the same prompt Copy for agent puts on the clipboard.
  // The plugin frontend listens for diffui-canvas:build-with-bb and calls
  // useBbNavigate().toCompose({ initialPrompt }).
  async _buildNodesWithBb(nodes) {
    const pages = this._agentBuildPagesFromNodes(nodes);
    if (!pages.length) throw new Error("Build with bb unavailable");
    this._setStatus("Sending to bb…");
    const res = await this._api("/api/agent-build-link", {
      method: "POST",
      body: JSON.stringify({
        bundle_name: this._agentBundleNameFromNodes(nodes),
        pages,
      }),
    });
    const buildUrl = String(res?.buildUrl || "").trim();
    if (!buildUrl) throw new Error("Build with bb unavailable");
    const prompt = this._agentCopyText(buildUrl);
    this.dispatchEvent(
      new CustomEvent("diffui-canvas:build-with-bb", {
        bubbles: true,
        composed: true,
        detail: { prompt, buildUrl },
      }),
    );
    this._setStatus("Opening in bb");
    this._showToast("Opening new thread");
  }`,
  },
  {
    file: "app/components/diffui-canvas-workspace.js",
    why: "bb behaviour: .stackAdd plus icon follows --canvas-chip-text instead of a hardcoded black fill",
    find: `    .stackAdd svg {
      width: 7px;
      height: 7px;
    }`,
    replace: `    .stackAdd svg {
      width: 7px;
      height: 7px;
      fill: currentColor;
    }
    .stackAdd svg rect {
      fill: currentColor;
    }`,
  },
  {
    file: "app/components/diffui-canvas-workspace.js",
    why: "bb behaviour: stackPlusIcon paints with currentColor so the plus tracks the chip text token",
    find: `  horizontal.setAttribute("fill", "black");
  const vertical = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  vertical.setAttribute("x", "4");
  vertical.setAttribute("width", "7");
  vertical.setAttribute("height", "1");
  vertical.setAttribute("transform", "rotate(90 4 0)");
  vertical.setAttribute("fill", "black");`,
    replace: `  horizontal.setAttribute("fill", "currentColor");
  const vertical = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  vertical.setAttribute("x", "4");
  vertical.setAttribute("width", "7");
  vertical.setAttribute("height", "1");
  vertical.setAttribute("transform", "rotate(90 4 0)");
  vertical.setAttribute("fill", "currentColor");`,
  },
]);

/**
 * Applies the patches for one vendored file.
 *
 * @param {string} file Snapshot-relative path, e.g. "embed-bridge.js".
 * @param {string} source Upstream contents.
 * @returns {{ source: string, applied: string[] }}
 */
export function applyBbCanvasPatches(file, source) {
  let next = source;
  const applied = [];
  for (const patch of BB_CANVAS_PATCHES) {
    if (patch.file !== file) continue;
    const occurrences = next.split(patch.find).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `bb patch for ${file} matched ${occurrences} times (expected 1): ${patch.why}\n` +
          `Upstream moved under the patch. Re-read the new source and update ` +
          `scripts/diffui-canvas-bb-patches.mjs.`,
      );
    }
    next = next.replace(patch.find, patch.replace);
    applied.push(patch.why);
  }
  return { source: next, applied };
}

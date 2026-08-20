# The canvas bb shows is Diffui's canvas

Not a port, not an imitation, not an iframe: `canvas/diffui/` is Diffui's own
frontend module graph, mirrored file for file into this repository and bundled
into the plugin. `diffui-canvas-element.ts` mounts it:

```ts
await import("./diffui-bb/vendored-canvas.js"); // → canvas/diffui/app/components/diffui-canvas-workspace.js
```

`<diffui-canvas-workspace>` is a plain custom element with its own shadow DOM,
so bb can create one and hand it a project id. Everything the canvas does is
that module's code — the tool rail and its SVGs, hit-testing, pan and zoom,
double-click, context menus (including **Build with bb**), option stacks,
noodles, comments, prompt editing, generation, undo, collab.

The plugin used to `import()` that module from the configured Diffui origin at
runtime. It does not any more. A cross-origin module graph is slower, needs
CORS on every JS file, and leaves nothing to change for bb. **The only traffic
to a Diffui server is now API traffic**: JSON, files and websockets, all under
the same bearer embed contract (`DIFFUI_EMBED`, `DIFFUI_API_BASE`,
`DIFFUI_API_KEY`, `credentials: "omit"`).

## What is in the copy

`canvas/diffui/` is the graph esbuild resolves from
`/app/components/diffui-canvas-workspace.js` — 36 modules and ~1.1 MB: the
workspace element, the satellites it composes (`diffui-canvas-comment`,
`diffui-inpaint-prompt`, `diffui-prompt-suggestions`, `diffui-button`,
`diffui-canvas-tool-tooltip`), the canvas engine (`app/wasm/diffui_canvas.js`),
the collab layer and its yjs bundle (`app/vendor/yjs.bundle.mjs`), and the
shared modules the canvas reaches for (`embed-bridge.js`, `image-urls.js`,
`wallet.js`, `ui-telemetry.js`, …).

`canvas/diffui-bb/` is what bb adds around it, and only that:

| File | What it is |
| --- | --- |
| `vendored-canvas.js` | the single edge from the plugin's TypeScript into the mirror |
| `canvas-assets.js` | generated: the sprites the canvas draws (three cursors, one collab cursor per brand colour), inlined as data URLs so nothing is fetched from a Diffui origin |

`canvas/diffui/MANIFEST.json` records the source, the entry, a SHA-256 per
module (upstream and as vendored) and a SHA-256 per sprite.
`canvas-vendor.test.ts` re-checks all of it, so a hand-edit inside the mirror
fails the suite instead of drifting quietly.

## Refreshing the copy

```
npm run vendor:canvas -- --repo jjcm/diffui --ref main   # canonical: reads frontend/ through gh
npm run vendor:canvas -- --origin https://diffui.ai      # same modules, from a running Diffui
npm run vendor:canvas:check                              # has upstream moved?
```

`scripts/vendor-diffui-canvas.mjs` walks the graph with **esbuild's own
resolver**, so the file list is the one a bundler would produce: a specifier in
a comment cannot pull a file in, and a specifier that does not resolve fails the
run. Diffui serves `frontend/` as unbundled ES modules, which is why the
`--origin` source yields the same bytes as the repository; `--repo` is the
canonical source and needs a token that can read the private jjcm/diffui.

## The patches: everything this copy changes

`scripts/diffui-canvas-bb-patches.mjs` is the complete list, and each entry has
to match its file exactly once or the vendor run fails — so an upstream rewrite
surfaces as a failed snapshot, never as a silently dropped patch.

- **Sprites** (`embed-bridge.js`, `app/collab/collab-cursor.js`,
  `app/components/diffui-canvas-workspace.js`): `resolveEmbedAssetUrl` answers
  `/app/assets/…` from the bundle, so the pointer, duplicate, comment and collab
  cursors paint without a request. Everything else it resolves — `/files/…`, API
  paths — still goes to `DIFFUI_API_BASE`.
- **Build with bb** (`app/components/diffui-canvas-workspace.js`): `_bbHost()`
  returns `true`. Upstream reads `window.DIFFUI_BB_HOST` to keep the action off
  diffui.ai; this copy ships inside the plugin and has no other host, so it says
  so directly and the loader sets no such global.

This is the copy bb runs, so bb-specific canvas work belongs here — a change to
the canvas for bb is a patch entry and a re-vendor, not a change to jjcm/diffui.

## The other difference: colour

Every colour the canvas paints comes from a custom property, so restyling it is
a matter of redefining those properties on the element that hosts it.
`bb-canvas-theme.ts` does exactly that and nothing else — no sprite, no
geometry, no URL:

| Family | Drives | How bb defines it |
| --- | --- | --- |
| `--canvas-*` (plus `--text`, `--muted`, `--panel`, `--menu-*`, …) | the shadow CSS: plane, rims, text ramp, panels, node bodies, the tool rail's hover and pressed states | `color-mix()` over bb's host tokens |
| `--canvas-draw-*` | the half painted into the 2D context: grid, noodles, node rects, connector pills, badges, guides | same, resolved by Diffui's `canvas-draw-palette.js` at mount and on theme change (a 2D context cannot read custom properties) |
| `--canvas-cursor-*` | the cursor sprites | not bb's business: the canvas declares them from its own bundled sprites |

Because every value is a mix of `--background` / `--foreground` /
`--surface-recessed` / `--border` / `--ring` / `--muted-foreground` /
`--state-hover` / `--destructive`, one definition covers bb's light and dark
themes and follows a live theme switch (`watchHostTheme`).

`bb-canvas-theme.test.ts` asserts the layer's structure and reads the **actual**
canvas — the vendored one, so the drift checks always run — failing if the
canvas gains a `--canvas-*` token this layer does not define or a drawn colour
it does not cover. Point `DIFFUI_REPO` at a jjcm/diffui checkout to run those
checks against a working tree ahead of a re-vendor. It also asserts the layer
never restyles `.toolBtn`, `.leftTools`, an `svg`, or a `path`: the rail is
Diffui's, and only its colours change.

## What the copy still needs from a Diffui server

All of it is API, and all of it is what the plugin authenticates with a `dui_…`
key:

1. **Embed globals** (Diffui's `embed-bridge.js`): with `window.DIFFUI_EMBED`
   set the element sends `Authorization: Bearer <key>` with
   `credentials: "omit"` to `DIFFUI_API_BASE` and puts the same key on the
   `access_token` query parameter of its websockets. The loader assigns the
   globals **before** the dynamic import, because the canvas module reads them
   while it evaluates — and because the specifier is local, `bb plugin build`
   bundles the module while `import()` still defers its evaluation to the first
   mount.
2. **CORS on the API and the file origin** for a bearer-authenticated caller. No
   `Allow-Credentials`, so a session cookie can never ride a cross-origin call —
   the API key is the only way in. Frontend module CORS no longer matters to
   this plugin; nothing here loads frontend code from Diffui.
3. **Absolute asset URLs when embedded** (`resolveEmbedAssetUrl`): the host
   page's document base is not Diffui, so `/files/...` has to be resolved
   against `DIFFUI_API_BASE`.
4. **`--canvas-draw-*` resolution** in `canvas-draw-palette.js`: the theme ramp
   with any of those properties in scope layered on top. Diffui defines none of
   them, so the app draws exactly as it always has.

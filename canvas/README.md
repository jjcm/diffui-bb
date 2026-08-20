# The canvas bb shows is Diffui's canvas

Not a port, not a vendored copy, not an iframe. `diffui-canvas-element.ts`
imports the product module **at runtime, from the Diffui origin the plugin is
configured against**:

```ts
await import(`${session.baseUrl}/app/components/diffui-canvas-workspace.js`);
```

`<diffui-canvas-workspace>` is a plain custom element with its own shadow DOM,
so bb can create one and hand it a project id. Everything the canvas does is
that module's code — the tool rail and its SVGs, hit-testing, pan and zoom,
double-click, context menus (including Diffui's own **Build with bb**), option
stacks, noodles, comments, prompt editing, generation, undo, collab. There is
no second implementation to drift from it, no snapshot of it in this
repository, and the canvas is always at the version the configured Diffui
instance serves — a change to the app's canvas is a change to bb's canvas.

The specifier is a runtime value, so `bb plugin build`'s esbuild pass leaves
the dynamic import in place instead of trying to bundle Diffui into the plugin.

## The one difference: colour

Every colour the canvas paints comes from a custom property, so restyling it is
a matter of redefining those properties on the element that hosts it.
`bb-canvas-theme.ts` does exactly that and nothing else:

| Family | Drives | How bb defines it |
| --- | --- | --- |
| `--canvas-*` (plus `--text`, `--muted`, `--panel`, `--menu-*`, …) | the shadow CSS: plane, rims, text ramp, panels, node bodies, the tool rail's hover and pressed states | `color-mix()` over bb's host tokens |
| `--canvas-draw-*` | the half painted into the 2D context: grid, noodles, node rects, connector pills, badges, guides | same, resolved by Diffui's `canvas-draw-palette.js` at mount and on theme change (a 2D context cannot read custom properties) |
| `--canvas-cursor-*` | the cursor sprites, which ship with Diffui | absolutized to the Diffui origin |

Because every value is a mix of `--background` / `--foreground` /
`--surface-recessed` / `--border` / `--ring` / `--muted-foreground` /
`--state-hover` / `--destructive`, one definition covers bb's light and dark
themes and follows a live theme switch (`watchHostTheme`).

`bb-canvas-theme.test.ts` asserts the layer's structure standalone, and — when
`DIFFUI_REPO` points at a jjcm/diffui checkout — reads the **actual** Diffui
frontend and fails if the canvas gains a `--canvas-*` token this layer does not
define, or a drawn colour it does not cover — so a new colour upstream cannot
silently fall back to a Diffui hue inside bb. It also asserts the layer never
restyles `.toolBtn`, `.leftTools`, an `svg`, or a `path`: the rail is Diffui's,
and only its colours change.

## What makes the product canvas embeddable

These are Diffui product APIs, and they live in jjcm/diffui (they are what this
plugin runs against, not code in this repository):

1. **Embed globals** (Diffui's `embed-bridge.js`): with `window.DIFFUI_EMBED`
   set the element sends `Authorization: Bearer <key>` with
   `credentials: "omit"` to `DIFFUI_API_BASE` and puts the key on the
   `access_token` query parameter of its websockets. The loader assigns the
   globals **before** the dynamic import, because the canvas module reads them
   while it evaluates. `window.DIFFUI_BB_HOST = true` rides along and is what
   makes Diffui's canvas offer **Build with bb** — the action is hidden
   everywhere that global is absent, so it stays plugin-only.
2. **CORS on the API, the file origin, and the frontend modules**
   (`backend/internal/http/embed_cors.go` in jjcm/diffui) for a
   bearer-authenticated caller. No `Allow-Credentials`, so a session cookie can
   never ride a cross-origin call — the API key is the only way in. The module
   routes being CORS-readable is what lets this plugin `import()` the workspace
   (and its relative import graph) cross-origin from a bb plugin page.
3. **Absolute asset URLs when embedded** (`resolveEmbedAssetUrl`): the host
   page's document base is not Diffui, so `/files/...` and `/app/assets/...`
   have to be resolved against `DIFFUI_API_BASE`.
4. **`--canvas-draw-*` resolution** in `canvas-draw-palette.js`: the theme ramp
   with any of those properties in scope layered on top. Diffui defines none of
   them, so the app draws exactly as it always has.

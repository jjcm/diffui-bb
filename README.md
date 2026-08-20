# bb-plugin-diffui-bb

Design in [Diffui](https://diffui.ai), build in [bb](https://getbb.app).
Built against the canonical recipe in jjcm/bb's
`docs/diffui-plugin-author-notes.md` (see [jjcm/bb#6](https://github.com/jjcm/bb/pull/6)).

This is the plugin's home repository. It used to live in the Diffui monorepo at
`jjcm/diffui:extensions/diffui-bb`; it no longer does, and it carries **no
Diffui frontend source**. The canvas bb shows is loaded at runtime from the
Diffui instance the plugin is configured against (see below).

- **Diffui's canvas, in bb** — the "Diffui" sidebar page (nav panel, plugin
  React, no iframe) opens a canvas at `/plugins/diffui-bb/canvas/<canvasId>`
  by mounting **Diffui's own `<diffui-canvas-workspace>` element**, dynamically
  imported at runtime from the configured Diffui origin
  (`baseUrl` / `DIFFUI_API_BASE`). Not a copy and not a re-implementation: the
  tool rail and its icons, hit-testing, pan/zoom, double-click, context menus,
  option stacks, noodles, comments, prompt editing, generation, undo and
  collab are that element's code, running here — at whatever version your
  Diffui instance serves. The only thing bb changes is **colour**:
  `canvas/bb-canvas-theme.ts` redefines Diffui's `--canvas-*` tokens (and the
  `--canvas-draw-*` set the 2D context resolves) in terms of bb's host tokens,
  so the canvas follows bb's light and dark themes. The same canvas opens
  beside any thread via the "Diffui canvas" panel action.
  See [canvas/README.md](./canvas/README.md).
- **The panel's browse grid** lists the whole Diffui account so you can pick a
  file to work on in bb. Each card's box is the generated cover's own ratio
  (`cover_thumbnail_width/height`, the snapshot renderer's 1312×640), with the
  cover `contain`ed and four-up tiles `cover`ed — the same shape Diffui's own
  browse grid uses — and a thumbnail rung ladder that keeps every card at or
  above Diffui's ≥2× device-pixel floor.
- **bb's files as threads** — the sidebar thread list is wrapped
  (`app.slots.experimental_threadList`) and lists **only the canvases that
  belong to bb**: created here (New canvas, or `diffui_create_canvas`) or
  explicitly opened into bb from the browse grid. A Diffui account's other
  files stay in Diffui. Rows carry the plugin's palette icon and the file's
  name, following along when a file names itself after its first designs.
  Membership lives in the plugin's own SQLite database
  (`bb.storage.database()`, `lib/bb-files.ts`) — no Diffui schema change.
  Creating a canvas never asks for a name (Untitled until designs exist).
- **One title bar** — bb owns the title bar on a nav page and the SDK gives no
  way to hide or merge it, so the plugin draws none of its own and puts
  Canvases / Open in Diffui / New canvas into bb's bar through
  `navPanel.headerContent`. See [BB_SDK_GAPS.md](./BB_SDK_GAPS.md).
- **Build with bb from the Diffui canvas** — right-click a design on a canvas
  mounted in bb. The action is plugin-only: this loader sets
  `window.DIFFUI_BB_HOST = true` before the canvas module loads, and Diffui
  hides "Build with bb" unless the hosting page declares that. Preferred
  transport is a direct browser call to this plugin's `POST /build` token
  route (declared CORS origins — needs bb with jjcm/bb#6); until that ships,
  the plugin's outbound relay websocket does the work, and a downed relay
  degrades to the Copy-for-agent clipboard. Every inbound shape ends the same
  way: fetch design bytes → `bb.sdk.projects.attachments.upload` →
  `bb.sdk.threads.spawn` (visible brief + `localImage` refs + agent-only
  structured brief) → `bb.sdk.threads.open`.
- **Agent tools** — `diffui_create_canvas`, `diffui_generate_options` (one
  prompt node per prompt; every image node stays 1:1 with a single prompt),
  `diffui_get_canvas`, `diffui_create_build_link`.
- **`@diffui` mentions** — attach a canvas summary or a brand
  (full-resolution guideline board included) as agent context on any message.
- **Status back to Diffui** — when a spawned build thread settles
  (`thread.idle` / `thread.failed`), the canvas that dispatched it gets a
  toast over its live watch socket.
- **`bb diffui` CLI** — `status`, `canvases`, `new <title>`.

## Requirements

- bb `>= 0.38` with `@get-bb/plugin-sdk >= 0.4.8` (the direct browser build
  route additionally wants the per-route CORS from jjcm/bb#6 / SDK 0.4.9).
- A Diffui instance to talk to (diffui.ai or self-hosted) and an API key
  (`dui_…`). The instance must serve its frontend modules with the embed CORS
  headers — any Diffui newer than the plugin's move to this repository does.

## Install

From this repository's git URL (the plugin is the repository root; its
`.bb/plugins.json` names it `diffui-bb`):

```
bb plugin install https://github.com/jjcm/diffui-bb
bb plugin install git:https://github.com/jjcm/diffui-bb --plugin diffui-bb
```

or from a local checkout while developing:

```
bb plugin install path:/path/to/diffui-bb
```

Git installs build `dist/` on the bb server with its pinned toolchain — no
local npm needed. For `path:` development installs run `npm install` once in
this directory first.

## Configure

1. In Diffui: Settings → API keys → create a key (`dui_…`).
2. `bb plugin config diffui-bb` — set `apiKey` (secret), optionally `baseUrl`
   (self-hosted/local Diffui) and `project` (where Build-with-bb threads
   land; defaults to your most recently active project).
3. `bb plugin reload diffui-bb`.

The plugin reports `needs-configuration` until the key is saved. No secrets
live in this repository; the key is stored by bb's settings store (0600 file
under the bb data dir), and the per-plugin token never leaves your machine
except to your own Diffui account for pairing.

## How the plugin talks to a Diffui instance

Everything rides the configured origin (`baseUrl`, default `https://diffui.ai`)
and the API key:

- **Server side** (`server.ts`, `lib/diffui-client.ts`): plain HTTPS calls to
  Diffui's `/api` with `Authorization: Bearer <apiKey>`, plus the outbound
  relay websocket (`GET /api/bb/bridge`).
- **In the panel**: the canvas is Diffui's own module, imported at runtime
  from `<baseUrl>/app/components/diffui-canvas-workspace.js`
  (`canvas/diffui-canvas-element.ts`). Before the import, the loader sets the
  embed globals — `DIFFUI_EMBED`, `DIFFUI_BB_HOST`, `DIFFUI_API_BASE`,
  `DIFFUI_API_KEY` — so the element authenticates every request with the
  bearer key (`credentials: "omit"`, never a cookie) and resolves its assets
  against the Diffui origin. Diffui serves its `/api`, `/files/`, and frontend
  module routes with bearer-only CORS (no `Allow-Credentials`) for exactly
  this embedding.

## How Build with bb reaches your machine

Two sanctioned inbound shapes (author notes §3), tried in order by the Diffui
canvas:

1. **Direct browser call** — the plugin registers
   `POST /api/v1/plugins/diffui-bb/http/build` (token auth) with
   `experimental_cors` for the Diffui origins, and pairs by pushing
   `{ loopback build URL, plugin token }` to your Diffui account over the
   relay hello. The canvas then POSTs the build payload straight to
   localhost. Requires bb with jjcm/bb#6 (SDK 0.4.9); older hosts ignore the
   CORS declaration and the browser falls through to:
2. **Cloud relay** — a background service dials out to the Diffui server and
   holds a websocket open (`GET /api/bb/bridge`, authenticated with your API
   key); "Build with bb" rides it as a `build.request` frame and the ack
   carries the spawned thread back to the canvas toast.

Threads spawned either way are attributed (`origin: plugin`,
`originPluginId: diffui-bb`) and focused in every bb window via
`threads.open`.

## Develop

```
npm install
npm run typecheck    # tsc --noEmit
npm test             # vitest (fake plugin host from @get-bb/plugin-sdk/testing)
npm run verify-build # mirrors bb plugin build's esbuild contract
bb plugin build      # the real packaging path (needs bb >= 0.38)
```

`npm test` is standalone. To additionally run the theme drift checks against a
Diffui checkout (every `--canvas-*` token and drawn colour the product canvas
reads must be covered by `canvas/bb-canvas-theme.ts`):

```
DIFFUI_REPO=/path/to/jjcm/diffui npm test
```

What bb core could still add: see [BB_SDK_GAPS.md](./BB_SDK_GAPS.md) — after
jjcm/bb#6, the answer is "nothing blocking".

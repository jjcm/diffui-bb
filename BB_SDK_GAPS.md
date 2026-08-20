# bb plugin SDK: what this integration needed vs. what it called

Verdict (matching the bb-side review in
[jjcm/bb#6](https://github.com/jjcm/bb/pull/6) and its canonical
`docs/diffui-plugin-author-notes.md`): **today's `@get-bb/plugin-sdk` covers
the whole product except one browser transport gap and one layout
restriction.** The transport gap is implemented in jjcm/bb#6; the layout
restriction is a deliberate host rule this plugin now works within. Everything
else in this plugin is call-the-SDK-as-shipped.

## Host restriction: a nav page cannot merge with, or hide, bb's title bar

- **Wanted:** one bar when a canvas is open. A canvas surface wants the full
  height of the page, and a plugin drawing its own title strip under bb's leaves
  two stacked bars with the same file name in them.
- **What the SDK offers:** nothing that hides or collapses the host bar.
  `PluginNavPanelRegistration` (SDK 0.4.8, `bb-plugin-sdk-app.d.ts`) is
  `{ id, title, icon, path, component, experimental_fixedTabs?,
  experimental_sidebarAccessory?, headerContent? }`. There is no `hideHeader`,
  `chrome`, `fullBleed`, `titleBar`, or `layout` option on it — `layout:
  "flush" | "padded"` exists only on **thread panel** tabs
  (`PluginThreadPanelActionRegistration`), not on nav pages. bb owns the bar
  and the SPA route under it.
- **What this plugin does instead:** ships no bar of its own and contributes its
  page-level controls to bb's bar through
  **`headerContent`** — "Canvases" (back), "Open in Diffui ↗", and "New canvas"
  render inside the host's single title bar. One bar, and the canvas gets the
  rest of the page.
- **What bb could add** (if the collapsed look is wanted): an opt-in
  `chrome: "none" | "bar"` (or `experimental_fullBleed: true`) on
  `PluginNavPanelRegistration`, with the page then responsible for its own
  back affordance. Not required for this plugin to ship.

## The one core gap: per-route CORS for plugin HTTP routes

- **Needed:** the Diffui *web app*'s "Build with bb" button POSTs the build
  payload straight to the local bb plugin route
  (`http://127.0.0.1:<port>/api/v1/plugins/diffui-bb/http/build`, token auth).
  Token/`none` routes were already reachable from any origin, but the global
  CORS middleware only reflected local bb app origins and swallowed OPTIONS
  preflights — a page on diffui.ai could fire blind writes and never read a
  response (not even a 401).
- **Implemented in jjcm/bb#6 (SDK 0.4.8 → 0.4.9):**
  `bb.http.route(..., { auth: "token", experimental_cors: { origins } })` —
  token/`none` routes only, exact origins, max 16, preflights host-owned,
  response headers stamped including readable 401s (so Diffui can render
  "reconnect to bb").
- **This plugin already registers the route with the declaration** (typed
  cast against the published 0.4.8 declarations; hosts without #6 ignore the
  option). Until #6 ships in a bb release, the web app's direct path fails
  its preflight and falls back to the relay automatically; nothing else
  depends on it. Local plugin pages inside bb never needed CORS.

## Everything else: shipped SDK, and where this plugin calls it

| Product need | SDK call (see author notes §) |
| --- | --- |
| Native Diffui canvas page in bb (no iframe) | `app.slots.navPanel` route `/plugins/diffui-bb/canvas/*`, `subPath` per canvas, `useBbNavigate().toPluginPanel` (§1) — `app.tsx` |
| Page controls in bb's one title bar | `navPanel.headerContent` — `app.tsx` (`DiffuiPanelHeader`) |
| Canvas beside a thread | `app.slots.threadPanelAction` with `layout: "flush"` + JSON `params` (§1) — `app.tsx` |
| Which Diffui files are bb's own | `bb.storage.database()` + `bb.storage.migrate` — `lib/bb-files.ts`. Diffui's schema is untouched: bb's sidebar lists only the files this table knows about. |
| Build with bb → thread in the current project | `bb.sdk.projects.attachments.upload` → `threads.spawn` with visible text + `localImage` refs + a `visibility: "agent-only"` structured brief + `environment: { type: "project-default" }` (§2) — `lib/build-dispatch.ts` |
| Focus bb on the new thread | frontend `useBbNavigate().toThread`; backend `bb.sdk.threads.open({ threadId, file: null })` broadcast (§2) |
| Inbound from the Diffui web app | direct CORS route (§3.1, above) with the cloud-relay `bb.background.service` websocket as fallback (§3.2, the slack-bot Socket-Mode shape) — `lib/bridge.ts` |
| Pairing the direct path | `bb.sdk.plugins.token({ pluginId })` + `bb.server.loopbackBaseUrl`, pushed to the user's Diffui account over the relay hello (§3.1) |
| @-mention canvases/brands | `bb.ui.registerMentionProvider` (§4) |
| Agent pulls canvas images mid-thread | `bb.agents.registerTool` returning MCP-style image content parts (§4) |
| Thread ↔ canvas deep links | `bb.storage.kv` mapping recorded at spawn (§4) |
| Build status back to Diffui | `bb.events.on("thread.idle" \| "thread.failed")` → Diffui `/api/bb/build-status` (§4) |
| Secrets / target-project setting | `bb.settings.define` with `secret: true` and `type: "project"` |

## Deferred by bb core on purpose (not blocking, noted in #6)

- Mention `resolve` returning image content parts (text-only today) — the
  `diffui_get_canvas` agent tool covers pixels.
- `Access-Control-Allow-Private-Network` preflight header — Chromium is
  moving to user-permission Local Network Access prompts; the direct path
  falls back to the relay when the browser declines loopback.
- A `bb://` desktop protocol for closed-app handoff — separate design work;
  `threads.open` covers the running-app case.

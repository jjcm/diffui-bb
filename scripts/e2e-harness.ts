// E2E dev harness: runs the REAL plugin (server.ts) under the SDK's fake
// plugin host against a live Diffui server, standing in for the bb desktop
// that cloud VMs cannot run. It exists for manual end-to-end demos and
// screenshots; it never ships with the plugin.
//
// What is real here: the plugin's bridge client, dispatch recipe
// (attachments → spawn input shapes → status loop), rpc handlers, and the
// app.tsx panel (served at /panel, bundled with a thin @get-bb/plugin-sdk/app
// shim). What is faked: bb.sdk itself (threads/projects/attachments/token
// stubs that log), and the host's per-route CORS from jjcm/bb#6, which the
// local listener mirrors so the Diffui web app can exercise the direct path.
//
//   DIFFUI_BASE_URL=http://localhost:3040 DIFFUI_API_KEY=dui_… \
//     npx esbuild scripts/e2e-harness.ts --bundle --format=esm --platform=node \
//       --target=node22 --packages=external --outfile=/tmp/e2e-harness.mjs \
//   && node /tmp/e2e-harness.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

const baseUrl = process.env.DIFFUI_BASE_URL ?? "http://localhost:3040";
const apiKey = process.env.DIFFUI_API_KEY ?? "";
if (apiKey === "") {
  console.error("DIFFUI_API_KEY required");
  process.exit(1);
}

const HARNESS_PORT = 38886;
const PLUGIN_TOKEN = "bbp_demo_token";
const BB_PROJECT = { id: "proj_storefront", name: "storefront", kind: "standard", updatedAt: Date.now() };
// The plugin repository root. The harness bundles to /tmp and is run from the
// repository checkout, so the working directory is the reliable anchor.
const rootDir = process.cwd();

const log = (line: string) => console.log(`[harness] ${line}`);

let spawnSeq = 0;
const host = createFakePluginHost({
  pluginId: "diffui-bb",
  loopbackBaseUrl: `http://127.0.0.1:${HARNESS_PORT}`,
  settings: { apiKey, baseUrl },
  sdk: {
    projects: {
      list: () => [BB_PROJECT],
      attachments: {
        upload: (args: { projectId: string; filename?: string }) => {
          log(`bb.sdk.projects.attachments.upload → ${args.projectId}/${args.filename ?? "file"}`);
          return {
            type: "localImage",
            path: `attachments/${args.filename ?? "design.webp"}`,
            name: args.filename ?? "design.webp",
            sizeBytes: 1,
          };
        },
      },
    },
    plugins: {
      token: () => ({ ok: true, token: PLUGIN_TOKEN }),
    },
    threads: {
      spawn: (args: { title?: string; projectId: string; input: unknown[] }) => {
        const id = `thr_demo_${++spawnSeq}`;
        console.log("[bb] threads.spawn:");
        console.log(JSON.stringify(args, null, 2));
        // Simulate the build thread settling a little later so the status
        // loop (thread.idle → Diffui → canvas toast) shows on the demo.
        setTimeout(() => {
          void host.harness.behavior
            .emitThreadEvent("thread.idle", {
              thread: makeThreadResponse({ id }),
              lastAssistantText: "Implemented the design and opened a PR.",
            })
            .then(() => log(`thread ${id} idled → status reported to Diffui`));
        }, 12_000);
        return { id, title: args.title ?? null };
      },
      open: (args: { threadId: string }) => {
        log(`bb.sdk.threads.open → focusing every bb window on ${args.threadId}`);
        return { delivered: 1 };
      },
    },
  },
});

await plugin(host.bb);
log("real plugin loaded under the fake host");

// Realtime bridge for the /panel page: flush the fake host's recorded
// bb.realtime.publish signals to SSE clients. (The interval is a dev-harness
// convenience only — in a real bb host these ride its realtime websocket.)
const sseClients = new Set<import("node:http").ServerResponse>();
let flushedSignals = 0;
setInterval(() => {
  const signals = host.harness.inspection.realtimeSignals;
  while (flushedSignals < signals.length) {
    const signal = signals[flushedSignals++]!;
    const frame = `data: ${JSON.stringify({ channel: signal.channel, payload: signal.payload })}\n\n`;
    for (const client of sseClients) client.write(frame);
  }
}, 250).unref();

// The bridge (relay inbound shape §3.2) — real plugin code dialing out.
const bridge = host.harness.behavior.runService("diffui-bridge");
process.on("SIGINT", () => bridge.controller.abort());
process.on("SIGTERM", () => bridge.controller.abort());

// Bundle the REAL app.tsx for the /panel page.
const panelBundle = await build({
  entryPoints: [join(rootDir, "scripts/harness/entry.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  write: false,
  alias: { "@get-bb/plugin-sdk/app": join(rootDir, "scripts/harness/sdk-app-shim.ts") },
});
const panelJs = panelBundle.outputFiles[0]!.text;
const panelHtml = readFileSync(join(rootDir, "scripts/harness/panel.html"), "utf8");

// Mirrors the jjcm/bb#6 host behavior for this plugin's declared origins:
// answer the preflight and stamp ACAO on actual responses (including 401).
const diffuiOrigin = new URL(baseUrl).origin;
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": diffuiOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-bb-plugin-token",
    Vary: "Origin",
  };
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${HARNESS_PORT}`);
  const wirePath = "/api/v1/plugins/diffui-bb/http/build";
  if (url.pathname === wirePath && request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }
  if (url.pathname === wirePath && request.method === "POST") {
    if (request.headers["x-bb-plugin-token"] !== PLUGIN_TOKEN) {
      response.writeHead(401, { "Content-Type": "application/json", ...corsHeaders() });
      response.end(JSON.stringify({ ok: false, error: "invalid plugin token" }));
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      log("direct build received on the plugin's /build token route (author notes §3.1)");
      void host.harness.behavior
        .fetchHttp("POST", "/build", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        })
        .then(async (routeResponse) => {
          const payload = await routeResponse.text();
          response.writeHead(routeResponse.status, { "Content-Type": "application/json", ...corsHeaders() });
          response.end(payload);
        });
    });
    return;
  }
  if (url.pathname === "/panel" || url.pathname === "/panel/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(panelHtml);
    return;
  }
  if (url.pathname === "/panel.js") {
    // no-store: every harness restart rebundles the real app.tsx; a cached
    // bundle silently demos stale plugin code.
    response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    response.end(panelJs);
    return;
  }
  if (url.pathname === "/panel-realtime") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(": connected\n\n");
    sseClients.add(response);
    request.on("close", () => sseClients.delete(response));
    return;
  }
  if (url.pathname.startsWith("/panel-rpc/") && request.method === "POST") {
    const method = url.pathname.slice("/panel-rpc/".length);
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      let input: unknown = null;
      try {
        input = body === "" ? null : JSON.parse(body);
      } catch {
        input = null;
      }
      host.harness.behavior
        .callRpc(method, input)
        .then((result) => {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: true, result }));
        })
        .catch((error: unknown) => {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } }),
          );
        });
    });
    return;
  }
  response.writeHead(404);
  response.end("not found");
});

server.listen(HARNESS_PORT, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${HARNESS_PORT} (plugin wire + /panel dev page)`);
  log(`bridging to ${baseUrl} as the diffui-bb plugin…`);
});

await bridge.done;
server.close();

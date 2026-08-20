// Turns one "Build with bb" request into one spawned bb thread, following the
// canonical recipe in jjcm/bb docs/diffui-plugin-author-notes.md §2:
//
//   fetch design bytes server-side → bb.sdk.projects.attachments.upload →
//   bb.sdk.threads.spawn({ input: [visible text, localImage refs,
//   agent-only structured brief], environment }) → bb.sdk.threads.open
//
// Pulled out of server.ts so the project-resolution and spawn-shape rules are
// unit-testable without a websocket or a live bb server.
import { buildThreadPrompt, buildThreadTitle, type BridgeBuildRequest, type BridgeBuildResult } from "./bridge.js";

/** How many pages of one dispatched build ride the thread input as images. */
export const MAX_INLINE_BUILD_IMAGES = 4;

export interface BuildDispatchProject {
  id: string;
  name: string;
  kind: string;
  updatedAt: number;
}

export type BuildThreadInput =
  | { type: "text"; text: string; mentions: []; visibility?: "agent-only" }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

export interface BuildDispatchDeps {
  /** The plugin's `project` setting, "" when unset. */
  configuredProjectId(): Promise<string>;
  listProjects(): Promise<BuildDispatchProject[]>;
  /** Server-side fetch of one tokenized design image (no CORS in Node). */
  fetchImageBytes(url: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  /** bb.sdk.projects.attachments.upload — bytes become a localImage ref. */
  uploadAttachment(args: {
    projectId: string;
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
  }): Promise<{ path: string }>;
  spawnThread(args: {
    projectId: string;
    title: string;
    input: BuildThreadInput[];
    environment: { type: "project-default" };
  }): Promise<{ id: string; title: string | null }>;
  /** bb.sdk.threads.open — broadcasts thread-open so bb windows navigate. */
  openThread(threadId: string): Promise<void>;
  /** Remember threadId → build for the status-back loop and deep links. */
  recordSpawn(threadId: string, record: BuildSpawnRecord): Promise<void>;
  log: { info(message: string): void; warn(message: string): void };
  publish(channel: string, payload: unknown): void;
}

/** What the status-back loop needs to tell Diffui when the thread settles. */
export interface BuildSpawnRecord {
  buildId: string;
  bundleName: string;
  canvasProjectId: string;
  canvasUrl: string;
}

/**
 * The bb project a dispatched build lands in: the configured setting wins
 * (even when stale — failing with the server's own message beats silently
 * building somewhere else), then the most recently active standard project,
 * then whatever exists at all.
 */
export async function resolveBuildProject(deps: BuildDispatchDeps): Promise<BuildDispatchProject | null> {
  const configured = (await deps.configuredProjectId()).trim();
  const projects = await deps.listProjects();
  if (configured !== "") {
    const match = projects.find((project) => project.id === configured);
    return match ?? { id: configured, name: configured, kind: "standard", updatedAt: 0 };
  }
  const standard = projects
    .filter((project) => project.kind !== "personal")
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return standard[0] ?? projects[0] ?? null;
}

function pageFilename(slug: string, index: number, mimeType: string): string {
  const base = slug !== "" ? slug : `design-${index + 1}`;
  const extension = mimeType === "image/png" ? "png" : "webp";
  return `diffui-${base}.${extension}`.toLowerCase();
}

/** The agent-only structured brief (author notes §2): everything the agent
 * needs verbatim, hidden from the user-facing transcript. */
export function buildAgentBrief(request: BridgeBuildRequest, attachmentPaths: Array<string | null>): string {
  return JSON.stringify({
    kind: "diffui.build",
    buildId: request.build.buildId,
    bundleName: request.build.bundleName,
    buildInstructionsUrl: request.build.buildUrl,
    canvas: request.canvas,
    brands: request.build.brands,
    pages: request.build.pages.map((page, index) => ({
      name: page.name,
      prompt: page.prompt,
      imageUrl: page.imageUrl,
      attachmentPath: attachmentPaths[index] ?? null,
    })),
  });
}

/**
 * Thread input per the recipe: a human-readable brief, one localImage ref per
 * design (uploaded into the target project; remote-URL fallback when an
 * upload fails), and the agent-only structured brief.
 */
export async function buildThreadInputWithAttachments(
  deps: BuildDispatchDeps,
  request: BridgeBuildRequest,
  targetProjectId: string,
): Promise<BuildThreadInput[]> {
  const input: BuildThreadInput[] = [{ type: "text", text: buildThreadPrompt(request), mentions: [] }];
  const attachmentPaths: Array<string | null> = [];
  for (const [index, page] of request.build.pages.entries()) {
    if (index >= MAX_INLINE_BUILD_IMAGES || page.imageUrl === "") {
      attachmentPaths.push(null);
      continue;
    }
    try {
      const image = await deps.fetchImageBytes(page.imageUrl);
      const uploaded = await deps.uploadAttachment({
        projectId: targetProjectId,
        bytes: image.bytes,
        filename: pageFilename(page.slug, index, image.mimeType),
        mimeType: image.mimeType,
      });
      input.push({ type: "localImage", path: uploaded.path });
      attachmentPaths.push(uploaded.path);
    } catch (error) {
      // The tokenized URL still works for the provider; prefer a degraded
      // remote ref over failing the whole dispatch.
      deps.log.warn(
        `diffui build image upload failed (${page.name}): ${error instanceof Error ? error.message : String(error)}`,
      );
      input.push({ type: "image", url: page.imageUrl });
      attachmentPaths.push(null);
    }
  }
  input.push({
    type: "text",
    text: buildAgentBrief(request, attachmentPaths),
    mentions: [],
    visibility: "agent-only",
  });
  return input;
}

export async function dispatchBuildRequest(
  deps: BuildDispatchDeps,
  request: BridgeBuildRequest,
): Promise<BridgeBuildResult> {
  const target = await resolveBuildProject(deps);
  if (target === null) {
    return { ok: false, error: "No bb project to build in — create one in bb or set the plugin's project setting." };
  }
  const title = buildThreadTitle(request);
  const input = await buildThreadInputWithAttachments(deps, request, target.id);
  const thread = await deps.spawnThread({
    projectId: target.id,
    title,
    input,
    // Author notes §2: let the server apply compose-screen policy rather than
    // re-deriving worktree defaulting here. In-bb flows that know a live
    // environment can spawn richer shapes through their own rpc.
    environment: { type: "project-default" },
  });
  await deps.recordSpawn(thread.id, {
    buildId: request.build.buildId,
    bundleName: request.build.bundleName,
    canvasProjectId: request.canvas.projectId,
    canvasUrl: request.canvas.url,
  });
  deps.log.info(`build "${request.build.bundleName}" → thread ${thread.id} in ${target.name}`);
  deps.publish("builds", {
    threadId: thread.id,
    title,
    bundleName: request.build.bundleName,
    canvasUrl: request.canvas.url,
  });
  try {
    // Focus every connected bb window on the new thread (author notes §2).
    await deps.openThread(thread.id);
  } catch (error) {
    deps.log.warn(`thread-open broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    ok: true,
    thread: { id: thread.id, title: thread.title ?? title },
    bbProject: { id: target.id, name: target.name },
  };
}

import { describe, expect, test } from "vitest";
import { parseBuildRequest, buildThreadPrompt, buildThreadTitle } from "./lib/bridge.js";
import {
  buildAgentBrief,
  buildThreadInputWithAttachments,
  dispatchBuildRequest,
  resolveBuildProject,
  MAX_INLINE_BUILD_IMAGES,
  type BuildDispatchDeps,
  type BuildDispatchProject,
} from "./lib/build-dispatch.js";
import { fullResBrandImageUrl, fullResUrlForThumbUrl, thumbUrlForFileUrl } from "./lib/diffui-client.js";
import { diffuiCorsOrigins } from "./server.js";

const request = parseBuildRequest(
  JSON.stringify({
    type: "build.request",
    requestId: "req-1",
    build: {
      buildId: "build-1",
      bundleName: "Checkout",
      buildUrl: "https://diffui.ai/build/Checkout.md?authToken=tok",
      pages: [
        {
          name: "Checkout",
          slug: "Checkout",
          prompt: "a clean checkout page",
          imageUrl: "https://diffui.ai/image/Checkout.webp?authToken=tok",
        },
      ],
      brands: [{ id: "brand-1", name: "Acme" }],
    },
    canvas: { projectId: "proj-1", title: "Checkout flow", url: "https://diffui.ai/app/canvas/proj-1" },
  }),
)!;

const projects: BuildDispatchProject[] = [
  { id: "personal", name: "Personal", kind: "personal", updatedAt: 900 },
  { id: "older", name: "Older", kind: "standard", updatedAt: 100 },
  { id: "newer", name: "Newer", kind: "standard", updatedAt: 500 },
];

function makeDeps(overrides: Partial<BuildDispatchDeps> = {}): BuildDispatchDeps & {
  spawned: unknown[];
  uploaded: unknown[];
  opened: string[];
  recorded: Array<{ threadId: string; record: unknown }>;
  published: Array<{ channel: string; payload: unknown }>;
} {
  const spawned: unknown[] = [];
  const uploaded: unknown[] = [];
  const opened: string[] = [];
  const recorded: Array<{ threadId: string; record: unknown }> = [];
  const published: Array<{ channel: string; payload: unknown }> = [];
  return {
    spawned,
    uploaded,
    opened,
    recorded,
    published,
    configuredProjectId: async () => "",
    listProjects: async () => projects,
    fetchImageBytes: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/webp" }),
    uploadAttachment: async (args) => {
      uploaded.push(args);
      return { path: `attachments/${args.filename}` };
    },
    spawnThread: async (args) => {
      spawned.push(args);
      return { id: "thr_9", title: args.title };
    },
    openThread: async (threadId) => {
      opened.push(threadId);
    },
    recordSpawn: async (threadId, record) => {
      recorded.push({ threadId, record });
    },
    log: { info: () => {}, warn: () => {} },
    publish: (channel, payload) => published.push({ channel, payload }),
    ...overrides,
  };
}

describe("parseBuildRequest", () => {
  test("parses a full build.request frame", () => {
    expect(request.requestId).toBe("req-1");
    expect(request.build.pages).toHaveLength(1);
    expect(request.build.pages[0]!.imageUrl).toContain("authToken=tok");
    expect(request.build.brands[0]!.name).toBe("Acme");
    expect(request.canvas.url).toBe("https://diffui.ai/app/canvas/proj-1");
  });

  test("ignores frames that are not build requests", () => {
    expect(parseBuildRequest(JSON.stringify({ type: "hello" }))).toBeNull();
    expect(parseBuildRequest("not json")).toBeNull();
    expect(parseBuildRequest(JSON.stringify({ type: "build.request" }))).toBeNull(); // no requestId
  });

  test("accepts the HTTP-route object form (direct browser path)", () => {
    const fromHttp = parseBuildRequest({
      type: "build.request",
      requestId: "http",
      build: { buildId: "b", bundleName: "Hero", buildUrl: "https://x/y.md", pages: [], brands: [] },
      canvas: { projectId: "p", title: "t", url: "" },
    });
    expect(fromHttp?.build.bundleName).toBe("Hero");
  });
});

describe("thread content", () => {
  test("prompt carries the build link, page prompts, brand, and canvas link", () => {
    const prompt = buildThreadPrompt(request);
    expect(prompt).toContain("https://diffui.ai/build/Checkout.md?authToken=tok");
    expect(prompt).toContain("Checkout — a clean checkout page");
    expect(prompt).toContain("Acme");
    expect(prompt).toContain("https://diffui.ai/app/canvas/proj-1");
  });

  test("title names the bundle", () => {
    expect(buildThreadTitle(request)).toBe("Diffui: Checkout");
  });

  test("input follows the author-notes recipe: text, localImage refs, agent-only brief", async () => {
    const deps = makeDeps();
    const input = await buildThreadInputWithAttachments(deps, request, "proj-bb");
    expect(input[0]).toMatchObject({ type: "text" });
    expect(input[1]).toEqual({ type: "localImage", path: "attachments/diffui-checkout.webp" });
    const brief = input[input.length - 1]!;
    expect(brief).toMatchObject({ type: "text", visibility: "agent-only" });
    const parsed = JSON.parse((brief as { text: string }).text) as Record<string, unknown>;
    expect(parsed.kind).toBe("diffui.build");
    expect(parsed.buildInstructionsUrl).toBe("https://diffui.ai/build/Checkout.md?authToken=tok");
    expect(deps.uploaded[0]).toMatchObject({ projectId: "proj-bb", mimeType: "image/webp" });
  });

  test("a failed upload degrades to the tokenized remote image url", async () => {
    const deps = makeDeps({
      uploadAttachment: async () => {
        throw new Error("attachment too large");
      },
    });
    const input = await buildThreadInputWithAttachments(deps, request, "proj-bb");
    expect(input[1]).toEqual({ type: "image", url: "https://diffui.ai/image/Checkout.webp?authToken=tok" });
    const brief = JSON.parse((input[input.length - 1] as { text: string }).text) as {
      pages: Array<{ attachmentPath: string | null }>;
    };
    expect(brief.pages[0]!.attachmentPath).toBeNull();
  });

  test("inline images are capped", async () => {
    const manyPages = {
      ...request,
      build: {
        ...request.build,
        pages: Array.from({ length: 9 }, (_, i) => ({
          name: `p${i}`,
          slug: `p${i}`,
          prompt: "",
          imageUrl: `https://diffui.ai/image/p${i}.webp?authToken=tok`,
        })),
      },
    };
    const input = await buildThreadInputWithAttachments(makeDeps(), manyPages, "proj-bb");
    // 1 visible text + capped images + 1 agent-only brief.
    expect(input).toHaveLength(1 + MAX_INLINE_BUILD_IMAGES + 1);
  });

  test("agent brief pairs pages with their attachment paths", () => {
    const brief = JSON.parse(buildAgentBrief(request, ["attachments/a.webp"])) as {
      pages: Array<{ name: string; attachmentPath: string | null }>;
    };
    expect(brief.pages[0]).toMatchObject({ name: "Checkout", attachmentPath: "attachments/a.webp" });
  });
});

describe("resolveBuildProject", () => {
  const deps = (configured: string, list: BuildDispatchProject[] = projects) =>
    makeDeps({ configuredProjectId: async () => configured, listProjects: async () => list });

  test("configured project wins", async () => {
    expect(await resolveBuildProject(deps("older"))).toMatchObject({ id: "older", name: "Older" });
  });

  test("a stale configured id still targets that id", async () => {
    expect(await resolveBuildProject(deps("ghost"))).toMatchObject({ id: "ghost" });
  });

  test("falls back to the most recently active standard project", async () => {
    expect(await resolveBuildProject(deps(""))).toMatchObject({ id: "newer" });
  });

  test("personal-only accounts still get a target", async () => {
    expect(await resolveBuildProject(deps("", [projects[0]!]))).toMatchObject({ id: "personal" });
  });

  test("no projects at all means no target", async () => {
    expect(await resolveBuildProject(deps("", []))).toBeNull();
  });
});

describe("dispatchBuildRequest", () => {
  test("spawns, records the mapping, focuses bb, and reports the thread", async () => {
    const deps = makeDeps({
      configuredProjectId: async () => "proj-bb",
      listProjects: async () => [{ id: "proj-bb", name: "storefront", kind: "standard", updatedAt: 1 }],
    });
    const result = await dispatchBuildRequest(deps, request);
    expect(result.ok).toBe(true);
    expect(result.thread).toEqual({ id: "thr_9", title: "Diffui: Checkout" });
    expect(result.bbProject).toEqual({ id: "proj-bb", name: "storefront" });
    expect(deps.spawned[0]).toMatchObject({
      projectId: "proj-bb",
      title: "Diffui: Checkout",
      environment: { type: "project-default" },
    });
    expect(deps.opened).toEqual(["thr_9"]);
    expect(deps.recorded[0]).toMatchObject({
      threadId: "thr_9",
      record: { buildId: "build-1", canvasProjectId: "proj-1" },
    });
    expect(deps.published[0]).toMatchObject({ channel: "builds" });
  });

  test("no project reports a friendly error instead of throwing", async () => {
    const deps = makeDeps({
      configuredProjectId: async () => "",
      listProjects: async () => [],
      spawnThread: async () => {
        throw new Error("must not spawn");
      },
    });
    const result = await dispatchBuildRequest(deps, request);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No bb project");
  });
});

describe("image url rules", () => {
  test("thumb rungs and PNGs map up to the full-res webp", () => {
    expect(fullResUrlForThumbUrl("/files/generations/g/i_thumb.webp")).toBe("/files/generations/g/i.webp");
    expect(fullResUrlForThumbUrl("/files/generations/g/i_thumb_xl.webp")).toBe("/files/generations/g/i.webp");
    expect(fullResUrlForThumbUrl("/files/generations/g/i.png")).toBe("/files/generations/g/i.webp");
    expect(fullResUrlForThumbUrl("/files/generations/g/i.webp")).toBe("/files/generations/g/i.webp");
  });

  test("any generation file url maps to the 512px thumb rung for grids", () => {
    expect(thumbUrlForFileUrl("/files/generations/g/i.png")).toBe("/files/generations/g/i_thumb.webp");
    expect(thumbUrlForFileUrl("/files/generations/g/i.webp")).toBe("/files/generations/g/i_thumb.webp");
    expect(thumbUrlForFileUrl("/files/generations/g/i_thumb.webp")).toBe("/files/generations/g/i_thumb.webp");
    // Non-generation URLs pass through untouched.
    expect(thumbUrlForFileUrl("/files/brands/b/logo.png")).toBe("/files/brands/b/logo.png");
  });

  test("brand guideline images resolve to full resolution, never a thumb", () => {
    expect(
      fullResBrandImageUrl({
        display_file_url: "/files/brands/b/guide_thumb.webp",
        display_full_file_url: "/files/brands/b/guide.webp",
      }),
    ).toBe("/files/brands/b/guide.webp");
    // Older payloads without the full-res field map the thumb up.
    expect(fullResBrandImageUrl({ display_file_url: "/files/brands/b/guide_thumb.webp" })).toBe(
      "/files/brands/b/guide.webp",
    );
    // A PNG original whose WebP does not exist yet passes through untouched.
    expect(fullResBrandImageUrl({ file_url: "/files/brands/b/guide.png" })).toBe("/files/brands/b/guide.png");
  });
});

describe("cors origins for the direct build route", () => {
  test("production origins plus the configured base url, exact and deduped", () => {
    expect(diffuiCorsOrigins("https://diffui.ai")).toEqual(["https://diffui.ai", "https://www.diffui.ai"]);
    expect(diffuiCorsOrigins("http://localhost:3040")).toContain("http://localhost:3040");
    expect(diffuiCorsOrigins("not a url")).toEqual(["https://diffui.ai", "https://www.diffui.ai"]);
  });
});

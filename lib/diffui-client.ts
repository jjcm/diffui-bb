// The one Diffui client every plugin surface shares: plain REST for lists and
// creates, and a passthrough to Diffui's hosted MCP (POST /mcp, JSON-RPC) for
// the workflow tools whose canvas staging lives server-side — generate_options
// keeps its "one prompt node per prompt, one image per slot" layout there, so
// this plugin never re-implements canvas geometry.

import { parseCanvasState, type CanvasDoc } from "./canvas-doc.js";

export interface DiffuiConfig {
  /** e.g. "https://diffui.ai" (no trailing slash required). */
  baseUrl: string;
  /** A `dui_…` API key from Diffui → Settings → API keys. */
  apiKey: string;
}

export interface DiffuiCanvasSummary {
  id: string;
  title: string;
  fileType: string;
  /** "bb" when the canvas was created for bb; "" otherwise. */
  agentTarget: string;
  updatedAt: string;
  /** Absolute `_thumb.webp` URLs (512px rung) for grid previews. */
  thumbnails: string[];
  coverThumbnail: string;
  /**
   * The size Diffui rendered the cover at (the canvas snapshot renderer's
   * 1312×640). A browse grid reserves this exact ratio, so cards never reflow
   * or distort while their bytes are still in flight.
   */
  coverThumbnailWidth: number;
  coverThumbnailHeight: number;
  canvasUrl: string;
}

export interface DiffuiBrandSummary {
  id: string;
  name: string;
  imageCount: number;
  readyCount: number;
}

export interface DiffuiCanvasDocument {
  projectId: string;
  title: string;
  canvasUrl: string;
  version: number;
  doc: CanvasDoc;
}

/** MCP-style content part, the same shape bb agent tools return. */
export type DiffuiContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface DiffuiToolCallResult {
  content: DiffuiContentPart[];
  isError: boolean;
}

const THUMB_SUFFIXES = ["_thumb_sm.webp", "_thumb_md.webp", "_thumb.webp", "_thumb_xl.webp"];

/**
 * Full-resolution WebP for any generation-thumbnail rung. Diffui's product
 * rule: never hand a user (or an agent) a `.png` under /files/generations/,
 * and never let a thumb stand in where full resolution is expected.
 */
export function fullResUrlForThumbUrl(url: string): string {
  const u = String(url ?? "").trim();
  for (const suffix of THUMB_SUFFIXES) {
    if (u.endsWith(suffix)) return `${u.slice(0, -suffix.length)}.webp`;
  }
  if (u.includes("/files/generations/") && u.toLowerCase().endsWith(".png")) {
    return `${u.slice(0, -4)}.webp`;
  }
  return u;
}

/**
 * 512px `_thumb.webp` rung for a generation file URL (PNG canonical, full
 * WebP, or an existing rung). Grid slots must render it at ≤256 CSS px to
 * keep Diffui's ≥2× device-pixel rule.
 */
export function thumbUrlForFileUrl(url: string): string {
  const u = String(url ?? "").trim();
  if (!u.includes("/files/generations/")) return u;
  const lower = u.toLowerCase();
  if (lower.endsWith("_thumb.webp")) return u;
  for (const suffix of THUMB_SUFFIXES) {
    if (lower.endsWith(suffix)) return `${u.slice(0, -suffix.length)}_thumb.webp`;
  }
  if (lower.endsWith(".png")) return `${u.slice(0, -4)}_thumb.webp`;
  if (lower.endsWith(".webp")) return `${u.slice(0, -5)}_thumb.webp`;
  return u;
}

/**
 * Full-resolution URL for a brand image payload. Guideline boards must never
 * render (or be handed to an agent) downscaled — fine print and type specimens
 * live there. Prefers the payload's own full-res field, then maps any thumb
 * rung up to its `.webp` sibling; a PNG/JPEG original whose WebP does not
 * exist yet passes through untouched.
 */
export function fullResBrandImageUrl(image: Record<string, unknown> | null | undefined): string {
  if (!image || typeof image !== "object") return "";
  const pick = (key: string): string => {
    const value = image[key];
    return typeof value === "string" ? value.trim() : "";
  };
  const picked = pick("display_full_file_url") || pick("file_url") || pick("display_file_url");
  return fullResUrlForThumbUrl(picked);
}

function trimBase(baseUrl: string): string {
  return String(baseUrl ?? "").trim().replace(/\/+$/, "");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class DiffuiRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DiffuiRequestError";
    this.status = status;
  }
}

export class DiffuiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private mcpRequestSeq = 0;

  constructor(config: DiffuiConfig) {
    this.baseUrl = trimBase(config.baseUrl);
    this.apiKey = config.apiKey.trim();
  }

  /** Absolute URL for a server-relative path like `/files/...` or `/app/...`. */
  absoluteUrl(path: string): string {
    const p = String(path ?? "").trim();
    if (p === "" || /^https?:\/\//i.test(p)) return p;
    return this.baseUrl + (p.startsWith("/") ? p : `/${p}`);
  }

  canvasUrl(projectId: string): string {
    return `${this.baseUrl}/app/canvas/${encodeURIComponent(projectId)}`;
  }

  bridgeUrl(): string {
    // Node's standards-based WebSocket cannot send an Authorization header, so
    // the key rides the `access_token` query parameter the Diffui API treats
    // as a bearer equivalent.
    const ws = this.baseUrl.replace(/^http/i, "ws");
    return `${ws}/api/bb/bridge?access_token=${encodeURIComponent(this.apiKey)}`;
  }

  /** Project-watch websocket URL — the live event stream one canvas rides. */
  watchUrl(projectId: string): string {
    const ws = this.baseUrl.replace(/^http/i, "ws");
    return `${ws}/api/projects/${encodeURIComponent(projectId)}/watch?access_token=${encodeURIComponent(this.apiKey)}`;
  }

  /** Display URL pair (thumb rung + full-res webp) for one generation file URL. */
  displayUrls = (fileUrl: string): { thumbUrl: string; fullUrl: string } => {
    return {
      thumbUrl: this.absoluteUrl(thumbUrlForFileUrl(fileUrl)),
      fullUrl: this.absoluteUrl(fullResUrlForThumbUrl(fileUrl)),
    };
  };

  async api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers ?? {});
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(this.baseUrl + path, { ...init, headers });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = asString(body.error) || `diffui request failed (${response.status})`;
      throw new DiffuiRequestError(response.status, message);
    }
    return body as T;
  }

  async me(): Promise<{ email: string }> {
    const body = await this.api<{ user?: { email?: string } }>("/api/me");
    return { email: asString(body.user?.email) };
  }

  async listCanvases(limit = 60): Promise<DiffuiCanvasSummary[]> {
    const body = await this.api<{ generations?: Array<Record<string, unknown>> }>(
      `/api/projects?limit=${limit}&order=updated`,
    );
    const rows = Array.isArray(body.generations) ? body.generations : [];
    return rows
      .filter((row) => asString(row.file_type) === "canvas")
      .map((row) => {
        const thumbnails = (Array.isArray(row.thumbnails) ? row.thumbnails : [])
          .map((t) => this.absoluteUrl(asString(t)))
          .filter((t) => t !== "");
        return {
          id: asString(row.id),
          title: asString(row.title) || asString(row.display_name) || "Untitled",
          fileType: asString(row.file_type),
          agentTarget: asString(row.agent_target),
          updatedAt: asString(row.updated_at),
          thumbnails,
          coverThumbnail: this.absoluteUrl(asString(row.cover_thumbnail)),
          coverThumbnailWidth: Number(row.cover_thumbnail_width ?? 0) || 0,
          coverThumbnailHeight: Number(row.cover_thumbnail_height ?? 0) || 0,
          canvasUrl: this.canvasUrl(asString(row.id)),
        };
      });
  }

  async createCanvas(options: { title?: string; orientation?: "landscape" | "portrait" } = {}): Promise<{
    projectId: string;
    canvasUrl: string;
  }> {
    const body = await this.api<{ project?: { id?: string } }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        type: "canvas",
        orientation: options.orientation === "portrait" ? "portrait" : "landscape",
        agentTarget: "bb",
        title: (options.title ?? "").trim(),
      }),
    });
    const projectId = asString(body.project?.id);
    if (projectId === "") throw new Error("diffui returned no project id");
    return { projectId, canvasUrl: this.canvasUrl(projectId) };
  }

  async listBrands(): Promise<DiffuiBrandSummary[]> {
    const body = await this.api<{ brands?: Array<Record<string, unknown>> }>("/api/brands");
    const rows = Array.isArray(body.brands) ? body.brands : [];
    return rows.map((row) => ({
      id: asString(row.id),
      name: asString(row.name) || "Untitled brand",
      imageCount: Number(row.image_count ?? 0) || 0,
      readyCount: Number(row.ready_count ?? 0) || 0,
    }));
  }

  async brandDetail(brandId: string): Promise<{ brand: Record<string, unknown>; images: Array<Record<string, unknown>> }> {
    const body = await this.api<{ brand?: Record<string, unknown>; images?: Array<Record<string, unknown>> }>(
      `/api/brands/${encodeURIComponent(brandId)}`,
    );
    return { brand: body.brand ?? {}, images: Array.isArray(body.images) ? body.images : [] };
  }

  /**
   * The FULL canvas document for one project — the same state blob the Diffui
   * web canvas loads, normalized for the native in-bb canvas surface: node
   * geometry, prompts, option stacks (thumb/full display URLs, never PNG),
   * edges, viewport, and comments.
   */
  async canvasDocument(projectId: string): Promise<DiffuiCanvasDocument> {
    const [projectBody, canvasBody] = await Promise.all([
      this.api<{ project?: Record<string, unknown> }>(`/api/projects/${encodeURIComponent(projectId)}`),
      this.api<{ canvas?: { state?: unknown; stateJson?: string; version?: number } }>(
        `/api/projects/${encodeURIComponent(projectId)}/canvas`,
      ),
    ]);
    const title = asString(projectBody.project?.name) || asString(projectBody.project?.display_name) || "Untitled";
    let state: unknown = canvasBody.canvas?.state;
    if ((state === undefined || state === null) && typeof canvasBody.canvas?.stateJson === "string") {
      try {
        state = JSON.parse(canvasBody.canvas.stateJson) as unknown;
      } catch {
        state = undefined;
      }
    }
    return {
      projectId,
      title,
      canvasUrl: this.canvasUrl(projectId),
      version: Number(canvasBody.canvas?.version) || 0,
      doc: parseCanvasState(state, this.displayUrls),
    };
  }

  /**
   * Mint a Build-with-bb payload for chosen images on one canvas — the same
   * `{ build, canvas }` shape the bridge relay dispatches, produced by the
   * Diffui server so slugs, tokens, and brand context stay in one place.
   */
  async buildPackageForImages(args: {
    projectId: string;
    imageIds: string[];
    bundleName: string;
  }): Promise<Record<string, unknown>> {
    const document = await this.canvasDocument(args.projectId);
    const pages = args.imageIds.map((imageId) => {
      const node = document.doc.nodes.find((candidate) => candidate.images.some((image) => image.imageId === imageId));
      return {
        image_id: imageId,
        name: node?.name || "design",
        original_prompt: node?.prompt ?? "",
      };
    });
    return this.api<Record<string, unknown>>("/api/bb/build-package", {
      method: "POST",
      body: JSON.stringify({
        bundle_name: args.bundleName,
        project_id: args.projectId,
        project_title: document.title,
        pages,
      }),
    });
  }

  /**
   * Call one of Diffui's hosted MCP tools over plain JSON-RPC. Without an
   * `Accept: text/event-stream` header the server answers a single JSON body,
   * so no SSE parsing is needed. Long generations block until rendered or the
   * tool's own timeout — pass `timeout_seconds` in `args` to bound it.
   */
  async mcpToolCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DiffuiToolCallResult> {
    const requestId = ++this.mcpRequestSeq;
    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      ...(signal !== undefined ? { signal } : {}),
    });
    const body = (await response.json().catch(() => ({}))) as {
      result?: { content?: Array<Record<string, unknown>>; isError?: boolean };
      error?: { message?: string };
    };
    if (!response.ok || body.error !== undefined) {
      const message = asString(body.error?.message) || `diffui mcp call failed (${response.status})`;
      throw new DiffuiRequestError(response.status, message);
    }
    const content: DiffuiContentPart[] = [];
    for (const part of body.result?.content ?? []) {
      const type = asString(part.type);
      if (type === "text" && asString(part.text) !== "") {
        content.push({ type: "text", text: asString(part.text) });
      } else if (type === "image" && asString(part.data) !== "") {
        content.push({ type: "image", data: asString(part.data), mimeType: asString(part.mimeType) || "image/webp" });
      }
    }
    return { content, isError: body.result?.isError === true };
  }
}

/** First JSON object found in a tool result's text blocks, or null. */
export function firstJsonBlock(result: DiffuiToolCallResult): Record<string, unknown> | null {
  for (const part of result.content) {
    if (part.type !== "text") continue;
    const text = part.text.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON after all — keep scanning.
    }
  }
  return null;
}

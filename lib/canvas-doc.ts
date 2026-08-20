// The canvas document model the in-bb canvas renders: the SAME state blob the
// Diffui web canvas loads (GET /api/projects/{id}/canvas → canvas.state),
// normalized into plain data the plugin React surface can draw natively —
// prompt/image nodes with their option stacks, edges (noodles), viewport, and
// comments. Pure and DOM-free so parsing and the watch-event patches can be
// unit-tested without a browser or a server.

export interface CanvasDocImage {
  /** Slot id inside the node's images[] (the id generation events target). */
  id: string;
  /** Generation image id from the slot's metadata; "" for pastes/uploads. */
  imageId: string;
  /** "ready" | "loading" | "error" | "" (no url yet). */
  status: string;
  /** True while a streamed partial frame is showing for this slot. */
  partial: boolean;
  /** Display URLs (never .png): 512px thumb rung and full-res webp. */
  thumbUrl: string;
  fullUrl: string;
}

export interface CanvasDocNode {
  id: string;
  kind: "prompt" | "image";
  name: string;
  prompt: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Which option of the stack is on top. */
  stackIndex: number;
  /** True while a generation is rendering into this node. */
  generating: boolean;
  images: CanvasDocImage[];
}

export interface CanvasDocEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface CanvasDocViewport {
  x: number;
  y: number;
  scale: number;
}

export interface CanvasDocComment {
  id: string;
  x: number;
  y: number;
  text: string;
  authorName: string;
}

export interface CanvasDoc {
  viewport: CanvasDocViewport;
  nodes: CanvasDocNode[];
  edges: CanvasDocEdge[];
  comments: CanvasDocComment[];
}

/** Maps a raw generation file URL onto the display pair the UI may show. */
export type CanvasDisplayUrls = (fileUrl: string) => { thumbUrl: string; fullUrl: string };

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeParse(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseImage(raw: unknown, display: CanvasDisplayUrls): CanvasDocImage | null {
  const image = (raw ?? {}) as Record<string, unknown>;
  const fileUrl = asString(image.image_url) || asString(image.imageUrl);
  const metadata = safeParse(asString(image.metadata_json) || asString(image.metadataJson));
  const id = asString(image.id) || fileUrl;
  if (id === "" && fileUrl === "") return null;
  const status = asString(image.status) || (fileUrl !== "" ? "ready" : "");
  const urls = fileUrl !== "" ? display(fileUrl) : { thumbUrl: "", fullUrl: "" };
  return {
    id,
    imageId: asString(metadata.imageId) || asString(metadata.image_id) || asString(image.imageId) || asString(image.image_id),
    status,
    partial: metadata.partial === true,
    thumbUrl: urls.thumbUrl,
    fullUrl: urls.fullUrl,
  };
}

function parseNode(raw: unknown, display: CanvasDisplayUrls): CanvasDocNode | null {
  const node = (raw ?? {}) as Record<string, unknown>;
  const id = asString(node.id);
  if (id === "") return null;
  const kind = asString(node.kind) === "image" ? "image" : "prompt";
  const images: CanvasDocImage[] = [];
  if (Array.isArray(node.images)) {
    for (const rawImage of node.images) {
      const image = parseImage(rawImage, display);
      if (image !== null) images.push(image);
    }
  } else if (kind === "image") {
    const single = parseImage(
      { id, image_url: asString(node.image_url) || asString(node.imageUrl), status: asString(node.status), metadata_json: node.metadata_json },
      display,
    );
    if (single !== null) images.push(single);
  }
  const rawStack = Number((node.stack_index as number | undefined) ?? (node.stackIndex as number | undefined) ?? 0);
  return {
    id,
    kind,
    name: asString(node.name) || (kind === "image" ? "Image" : "Prompt"),
    prompt: asString(node.prompt),
    x: asNumber(node.x),
    y: asNumber(node.y),
    width: Math.max(1, asNumber(node.width, 1440)),
    height: Math.max(1, asNumber(node.height, 1024)),
    stackIndex: Number.isFinite(rawStack) ? Math.max(0, Math.round(rawStack)) : 0,
    generating: images.some((image) => image.status === "loading"),
    images,
  };
}

/** Normalize one raw canvas state blob (already JSON-parsed) into a doc. */
export function parseCanvasState(state: unknown, display: CanvasDisplayUrls): CanvasDoc {
  const root = (state ?? {}) as Record<string, unknown>;
  const viewportRaw = (root.viewport ?? {}) as Record<string, unknown>;
  const nodes: CanvasDocNode[] = [];
  for (const rawNode of Array.isArray(root.nodes) ? root.nodes : []) {
    const node = parseNode(rawNode, display);
    if (node !== null) nodes.push(node);
  }
  const edges: CanvasDocEdge[] = [];
  for (const rawEdge of Array.isArray(root.edges) ? root.edges : []) {
    const edge = (rawEdge ?? {}) as Record<string, unknown>;
    const fromNodeId = asString(edge.from_node_id) || asString(edge.fromNodeId);
    const toNodeId = asString(edge.to_node_id) || asString(edge.toNodeId);
    if (fromNodeId === "" || toNodeId === "") continue;
    edges.push({ id: asString(edge.id) || `${fromNodeId}->${toNodeId}`, fromNodeId, toNodeId });
  }
  const comments: CanvasDocComment[] = [];
  for (const rawComment of Array.isArray(root.comments) ? root.comments : []) {
    const comment = (rawComment ?? {}) as Record<string, unknown>;
    const text = asString(comment.text) || asString(comment.body);
    if (text === "") continue;
    comments.push({
      id: asString(comment.id) || `comment-${comments.length}`,
      x: asNumber(comment.x),
      y: asNumber(comment.y),
      text,
      authorName: asString(comment.authorName) || asString(comment.author_name) || asString(comment.author),
    });
  }
  return {
    viewport: {
      x: asNumber(viewportRaw.x),
      y: asNumber(viewportRaw.y),
      scale: Math.max(0.01, asNumber(viewportRaw.scale, 1)),
    },
    nodes,
    edges,
    comments,
  };
}

/** The raw state carried by a `canvas_state` watch event, or null. */
export function canvasStateFromWatchEvent(event: Record<string, unknown>): unknown | null {
  const canvas = (event.canvas ?? null) as Record<string, unknown> | null;
  if (canvas === null || typeof canvas !== "object") return null;
  if (canvas.state !== undefined && canvas.state !== null) return canvas.state;
  const rawJson = asString(canvas.stateJson);
  if (rawJson !== "") {
    try {
      return JSON.parse(rawJson) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Apply one project-watch event to the doc, patching only the slot/node the
 * event names (the same surgical updates the Diffui canvas makes — never a
 * whole-tree rebuild). Returns the same doc instance when nothing changed.
 */
export function applyCanvasWatchEvent(doc: CanvasDoc, event: Record<string, unknown>, display: CanvasDisplayUrls): CanvasDoc {
  const type = asString(event.type);
  if (type === "canvas_state") {
    const state = canvasStateFromWatchEvent(event);
    return state !== null ? parseCanvasState(state, display) : doc;
  }
  if (type === "canvas_image" || type === "canvas_image_partial") {
    const nodeId = asString(event.promptNodeId) || asString(event.nodeId);
    const slotId = asString(event.slotNodeId);
    const node = doc.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) return doc;
    const isPartial = type === "canvas_image_partial";
    const imagePayload = (event.image ?? {}) as Record<string, unknown>;
    const fileUrl = isPartial
      ? asString(event.imageUrl)
      : asString(imagePayload.image_url) || asString(imagePayload.imageUrl) || asString(imagePayload.url);
    if (fileUrl === "") return doc;
    const urls = display(fileUrl);
    const slotIndex = node.images.findIndex((image) => image.id === slotId);
    const nextImage: CanvasDocImage = {
      id: slotId || asString(imagePayload.id) || fileUrl,
      imageId: isPartial
        ? (slotIndex >= 0 ? node.images[slotIndex]!.imageId : "")
        : asString(imagePayload.id) || (slotIndex >= 0 ? node.images[slotIndex]!.imageId : ""),
      status: isPartial ? "loading" : "ready",
      partial: isPartial,
      thumbUrl: isPartial ? urls.fullUrl : urls.thumbUrl,
      fullUrl: urls.fullUrl,
    };
    const images = slotIndex >= 0
      ? node.images.map((image, index) => (index === slotIndex ? nextImage : image))
      : [...node.images, nextImage];
    return replaceNode(doc, nodeId, { images, generating: images.some((image) => image.status === "loading") });
  }
  if (type === "canvas_generation_started") {
    const nodeId = asString(event.nodeId);
    if (doc.nodes.some((node) => node.id === nodeId)) {
      return replaceNode(doc, nodeId, { generating: true });
    }
    return doc;
  }
  if (type === "canvas_generation_done" || type === "canvas_generation_error" || type === "canvas_inpaint_done") {
    const nodeId = asString(event.nodeId);
    const node = doc.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) return doc;
    return replaceNode(doc, nodeId, {
      generating: false,
      images: node.images.map((image) =>
        image.status === "loading" && !image.partial ? image : { ...image, status: image.thumbUrl !== "" ? "ready" : image.status, partial: false },
      ),
    });
  }
  return doc;
}

function replaceNode(doc: CanvasDoc, nodeId: string, patch: Partial<CanvasDocNode>): CanvasDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
  };
}

/** World-space bounding box of every node (with the node cards' chrome ignored). */
export function canvasContentBounds(nodes: readonly CanvasDocNode[]): { x: number; y: number; width: number; height: number } | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Viewport that fits the whole node graph into a view, centered, with a
 * screen-space margin — how the in-bb canvas frames a document on open.
 * Never zooms past 100%.
 */
export function fitCanvasViewport(
  nodes: readonly CanvasDocNode[],
  viewWidth: number,
  viewHeight: number,
  marginPx = 48,
): CanvasDocViewport {
  const bounds = canvasContentBounds(nodes);
  if (bounds === null || viewWidth <= 0 || viewHeight <= 0) return { x: 0, y: 0, scale: 1 };
  const usableWidth = Math.max(1, viewWidth - marginPx * 2);
  const usableHeight = Math.max(1, viewHeight - marginPx * 2);
  const scale = Math.min(1, usableWidth / Math.max(1, bounds.width), usableHeight / Math.max(1, bounds.height));
  return {
    x: (viewWidth - bounds.width * scale) / 2 - bounds.x * scale,
    y: (viewHeight - bounds.height * scale) / 2 - bounds.y * scale,
    scale,
  };
}

/** The stack option that is on top for a node, clamped like the web canvas. */
export function activeImageIndex(node: Pick<CanvasDocNode, "stackIndex" | "images">): number {
  const ready = node.images.filter((image) => image.thumbUrl !== "");
  if (ready.length === 0) return 0;
  return Math.max(0, Math.min(ready.length - 1, node.stackIndex));
}

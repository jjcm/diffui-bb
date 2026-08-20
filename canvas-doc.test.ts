import { describe, expect, test } from "vitest";
import {
  activeImageIndex,
  applyCanvasWatchEvent,
  canvasContentBounds,
  canvasStateFromWatchEvent,
  fitCanvasViewport,
  parseCanvasState,
  type CanvasDoc,
} from "./lib/canvas-doc.js";

const display = (fileUrl: string) => ({
  thumbUrl: `thumb:${fileUrl}`,
  fullUrl: `full:${fileUrl}`,
});

const state = {
  version: 1,
  viewport: { x: 10, y: 20, scale: 0.75 },
  nodes: [
    {
      id: "prompt-1",
      kind: "prompt",
      name: "Landing",
      x: 0,
      y: 0,
      width: 1440,
      height: 1024,
      prompt: "hero",
      stack_index: 2,
      images: [
        { id: "slot-1", image_url: "/a.png", status: "ready", metadata_json: JSON.stringify({ imageId: "img-a" }) },
        { id: "slot-2", image_url: "", status: "loading" },
      ],
    },
    {
      id: "image-1",
      kind: "image",
      x: 2000,
      y: 100,
      width: 800,
      height: 600,
      image_url: "/paste.png",
    },
  ],
  edges: [{ id: "edge-1", from_node_id: "prompt-1", to_node_id: "image-1" }],
  comments: [{ id: "c1", x: 5, y: 6, text: "love this", authorName: "Jacob" }],
};

describe("parseCanvasState", () => {
  test("normalizes nodes, stacks, edges, viewport, and comments from the web canvas blob", () => {
    const doc = parseCanvasState(state, display);
    expect(doc.viewport).toEqual({ x: 10, y: 20, scale: 0.75 });
    expect(doc.nodes).toHaveLength(2);
    const prompt = doc.nodes[0]!;
    expect(prompt).toMatchObject({ id: "prompt-1", kind: "prompt", name: "Landing", stackIndex: 2, generating: true });
    expect(prompt.images[0]).toMatchObject({ id: "slot-1", imageId: "img-a", status: "ready", thumbUrl: "thumb:/a.png" });
    // A standalone image node becomes a single-image stack.
    const image = doc.nodes[1]!;
    expect(image.kind).toBe("image");
    expect(image.images).toHaveLength(1);
    expect(image.images[0]!.fullUrl).toBe("full:/paste.png");
    expect(doc.edges).toEqual([{ id: "edge-1", fromNodeId: "prompt-1", toNodeId: "image-1" }]);
    expect(doc.comments[0]).toMatchObject({ id: "c1", text: "love this", authorName: "Jacob" });
  });

  test("tolerates camelCase edge endpoints and missing ids", () => {
    const doc = parseCanvasState(
      { nodes: [], edges: [{ fromNodeId: "a", toNodeId: "b" }] },
      display,
    );
    expect(doc.edges).toEqual([{ id: "a->b", fromNodeId: "a", toNodeId: "b" }]);
  });
});

describe("applyCanvasWatchEvent", () => {
  const doc = (): CanvasDoc => parseCanvasState(state, display);

  test("canvas_image patches exactly the named slot to ready", () => {
    const before = doc();
    const next = applyCanvasWatchEvent(
      before,
      {
        type: "canvas_image",
        promptNodeId: "prompt-1",
        slotNodeId: "slot-2",
        image: { id: "img-b", image_url: "/b.png" },
      },
      display,
    );
    const node = next.nodes[0]!;
    expect(node.images[1]).toMatchObject({ id: "slot-2", imageId: "img-b", status: "ready", thumbUrl: "thumb:/b.png" });
    expect(node.generating).toBe(false);
    // Surgical patch: the untouched slot and the untouched node keep their
    // identity, so memoized React nodes skip re-rendering entirely.
    expect(node.images[0]).toBe(before.nodes[0]!.images[0]);
    expect(next.nodes[1]).toBe(before.nodes[1]);
  });

  test("canvas_image_partial shows the partial frame but keeps the slot loading", () => {
    const next = applyCanvasWatchEvent(
      doc(),
      {
        type: "canvas_image_partial",
        promptNodeId: "prompt-1",
        slotNodeId: "slot-2",
        imageUrl: "/partial.webp",
      },
      display,
    );
    expect(next.nodes[0]!.images[1]).toMatchObject({ status: "loading", partial: true, fullUrl: "full:/partial.webp" });
    expect(next.nodes[0]!.generating).toBe(true);
  });

  test("generation started/done toggle the node flag; unknown events are no-ops", () => {
    const started = applyCanvasWatchEvent(doc(), { type: "canvas_generation_started", nodeId: "prompt-1" }, display);
    expect(started.nodes[0]!.generating).toBe(true);
    const done = applyCanvasWatchEvent(started, { type: "canvas_generation_done", nodeId: "prompt-1" }, display);
    expect(done.nodes[0]!.generating).toBe(false);
    const untouched = applyCanvasWatchEvent(done, { type: "wallet_update" }, display);
    expect(untouched).toBe(done);
  });

  test("canvas_state replaces the whole doc from the event's canvas payload", () => {
    const event = {
      type: "canvas_state",
      canvas: { stateJson: JSON.stringify({ nodes: [{ id: "n1", kind: "prompt", x: 1, y: 2, width: 10, height: 10 }] }) },
    };
    expect(canvasStateFromWatchEvent(event)).not.toBeNull();
    const next = applyCanvasWatchEvent(doc(), event, display);
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]!.id).toBe("n1");
  });
});

describe("viewport fitting", () => {
  test("bounds cover every node", () => {
    const doc = parseCanvasState(state, display);
    expect(canvasContentBounds(doc.nodes)).toEqual({ x: 0, y: 0, width: 2800, height: 1024 });
  });

  test("fit centers content and never zooms past 100%", () => {
    const doc = parseCanvasState(state, display);
    const viewport = fitCanvasViewport(doc.nodes, 1400, 900, 50);
    expect(viewport.scale).toBeLessThanOrEqual(1);
    expect(viewport.scale).toBeCloseTo(1300 / 2800, 5);
    // Horizontal margins split evenly.
    expect(viewport.x).toBeCloseTo((1400 - 2800 * viewport.scale) / 2, 5);
    // Tiny content is framed at 100%, not blown up.
    const small = fitCanvasViewport(
      [{ ...doc.nodes[0]!, x: 0, y: 0, width: 100, height: 80 }],
      1400,
      900,
      50,
    );
    expect(small.scale).toBe(1);
  });
});

describe("activeImageIndex", () => {
  test("clamps to the ready images like the web canvas", () => {
    const node = parseCanvasState(state, display).nodes[0]!;
    // stackIndex 2 but only one ready image → clamps to 0.
    expect(activeImageIndex(node)).toBe(0);
    expect(activeImageIndex({ ...node, stackIndex: 0 })).toBe(0);
  });
});

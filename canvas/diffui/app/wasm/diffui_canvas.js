// wasm-pack output placeholder for local environments without Rust tooling.
// The public API matches the Rust `CanvasEngine` exports in `wasm/diffui-canvas`.

const MAX_PROMPT_DIMENSION = 2048;
const MAX_GENERATION_ASPECT_RATIO = 3;
const MIN_GENERATION_PIXELS = 655360;
const GENERATED_IMAGE_DIMENSION_MULTIPLE = 16;

export default async function init() {
  return true;
}

export function snap_dimension(value) {
  return snap16(value);
}

export class CanvasEngine {
  constructor() {
    this.state = emptyState();
    this.undoStack = [];
    this.redoStack = [];
    this.historyTransaction = null;
  }

  load(json) {
    this.state = normalizeState(JSON.parse(json || "{}"));
    this.undoStack = [];
    this.redoStack = [];
    this.historyTransaction = null;
  }

  serialize() {
    return JSON.stringify(this.state);
  }

  set_viewport(x, y, scale) {
    this.state.viewport.x = Number(x) || 0;
    this.state.viewport.y = Number(y) || 0;
    this.state.viewport.scale = Math.max(0.05, Math.min(8, Number(scale) || 1));
  }

  screen_to_world(sx, sy) {
    const scale = Math.max(0.0001, this.state.viewport.scale || 1);
    return JSON.stringify({
      x: (Number(sx) - this.state.viewport.x) / scale,
      y: (Number(sy) - this.state.viewport.y) / scale,
    });
  }

  add_node(nodeJson) {
    this._snapshot();
    const node = normalizeNode(JSON.parse(nodeJson || "{}"));
    this.state.nodes.push(node);
    this.redoStack = [];
  }

  add_edge(edgeJson) {
    this._snapshot();
    const edge = JSON.parse(edgeJson || "{}");
    this.state.edges = this.state.edges.filter((existing) => existing.id !== edge.id);
    this.state.edges.push(edge);
    this.redoStack = [];
  }

  patch_node(id, patchJson) {
    this._snapshot();
    const node = this.state.nodes.find((item) => item.id === id);
    if (!node) return;
    const patch = JSON.parse(patchJson || "{}");
    if (Number.isFinite(Number(patch.x))) node.x = Number(patch.x);
    if (Number.isFinite(Number(patch.y))) node.y = Number(patch.y);
    if (Number.isFinite(Number(patch.width))) node.width = snap16(Number(patch.width));
    if (Number.isFinite(Number(patch.height))) node.height = snap16(Number(patch.height));
    if (typeof patch.name === "string") node.name = patch.name;
    if (typeof patch.prompt === "string") node.prompt = patch.prompt;
    if (typeof patch.status === "string") node.status = patch.status;
    if (typeof patch.imageUrl === "string") node.image_url = patch.imageUrl;
    if (typeof patch.image_url === "string") node.image_url = patch.image_url;
    if (typeof patch.metadataJson === "string") node.metadata_json = patch.metadataJson;
    if (typeof patch.metadata_json === "string") node.metadata_json = patch.metadata_json;
    if (Array.isArray(patch.images)) node.images = patch.images;
    if (Number.isFinite(Number(patch.stackIndex))) node.stack_index = Math.max(0, Math.round(Number(patch.stackIndex)));
    if (Number.isFinite(Number(patch.stack_index))) node.stack_index = Math.max(0, Math.round(Number(patch.stack_index)));
    normalizeNode(node);
    this.redoStack = [];
  }

  delete_selected() {
    this._snapshot();
    const selected = new Set(this.state.nodes.filter((node) => node.selected).map((node) => node.id));
    const selectedEdges = new Set(this.state.edges.filter((edge) => edge.selected).map((edge) => edge.id));
    this.state.nodes = this.state.nodes.filter((node) => !selected.has(node.id));
    this.state.edges = this.state.edges.filter((edge) => {
      return !selectedEdges.has(edge.id) && !selected.has(edge.from_node_id) && !selected.has(edge.to_node_id);
    });
    this.redoStack = [];
  }

  select_at(x, y, append) {
    const hit = this.hit_test(x, y) || "";
    if (!append) {
      this.state.nodes.forEach((node) => (node.selected = false));
      this.state.edges.forEach((edge) => (edge.selected = false));
    }
    if (hit) {
      const node = this.state.nodes.find((item) => item.id === hit);
      if (node) node.selected = true;
    }
    return hit;
  }

  hit_test(x, y) {
    for (let index = this.state.nodes.length - 1; index >= 0; index -= 1) {
      const node = this.state.nodes[index];
      if (x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height) {
        return node.id;
      }
    }
    return undefined;
  }

  selected_json() {
    return JSON.stringify(this.state.nodes.filter((node) => node.selected));
  }

  move_selected(dx, dy) {
    this._snapshot();
    this.state.nodes.forEach((node) => {
      if (!node.selected) return;
      node.x += Number(dx) || 0;
      node.y += Number(dy) || 0;
    });
    this.redoStack = [];
  }

  /**
   * Nudge selected nodes one step in draw/hit order.
   * delta < 0 → toward bottom (earlier in array); delta > 0 → toward top.
   * Returns true when the order changed.
   */
  nudge_selected_z(delta) {
    const nodes = this.state.nodes;
    if (!nodes.some((node) => node.selected)) return false;
    const dir = Number(delta) < 0 ? -1 : 1;
    let changed = false;
    this._snapshot();
    if (dir < 0) {
      for (let index = 1; index < nodes.length; index += 1) {
        if (nodes[index].selected && !nodes[index - 1].selected) {
          const tmp = nodes[index - 1];
          nodes[index - 1] = nodes[index];
          nodes[index] = tmp;
          changed = true;
        }
      }
    } else {
      for (let index = nodes.length - 2; index >= 0; index -= 1) {
        if (nodes[index].selected && !nodes[index + 1].selected) {
          const tmp = nodes[index + 1];
          nodes[index + 1] = nodes[index];
          nodes[index] = tmp;
          changed = true;
        }
      }
    }
    if (!changed) {
      if (this.historyTransaction === null) this.undoStack.pop();
      return false;
    }
    this.redoStack = [];
    return true;
  }

  align_selected(mode) {
    this._snapshot();
    const selected = this.state.nodes.filter((node) => node.selected);
    if (selected.length < 2) return;
    const minX = Math.min(...selected.map((node) => node.x));
    const maxX = Math.max(...selected.map((node) => node.x + node.width));
    const minY = Math.min(...selected.map((node) => node.y));
    const maxY = Math.max(...selected.map((node) => node.y + node.height));
    selected.forEach((node) => {
      if (mode === "left") node.x = minX;
      if (mode === "right") node.x = maxX - node.width;
      if (mode === "top") node.y = minY;
      if (mode === "bottom") node.y = maxY - node.height;
      if (mode === "center-x") node.x = minX + (maxX - minX - node.width) / 2;
      if (mode === "center-y") node.y = minY + (maxY - minY - node.height) / 2;
    });
    this.redoStack = [];
  }

  distribute_selected(axis) {
    this._snapshot();
    const selected = this.state.nodes.filter((node) => node.selected);
    if (selected.length < 3) return;
    selected.sort((a, b) => (axis === "y" ? a.y - b.y : a.x - b.x));
    const first = axis === "y" ? selected[0].y : selected[0].x;
    const last = axis === "y" ? selected[selected.length - 1].y : selected[selected.length - 1].x;
    const step = (last - first) / (selected.length - 1);
    selected.forEach((node, index) => {
      if (axis === "y") node.y = first + step * index;
      else node.x = first + step * index;
    });
    this.redoStack = [];
  }

  duplicate_selected(suffix) {
    this._snapshot();
    const originals = this.state.nodes.filter((node) => node.selected).map((node) => ({ ...node }));
    this.state.nodes.forEach((node) => (node.selected = false));
    const duplicated = originals.map((node) =>
      normalizeNode({
        ...node,
        id: `${node.id}${suffix}`,
        name: `${node.name || "Node"} copy`,
        x: node.x + 32,
        y: node.y + 32,
        selected: true,
      }),
    );
    this.state.nodes.push(...duplicated);
    this.redoStack = [];
    return JSON.stringify(duplicated);
  }

  begin_history_transaction() {
    if (this.historyTransaction === null) this.historyTransaction = this.serialize();
  }

  commit_history_transaction() {
    if (this.historyTransaction === null) return false;
    const snapshot = this.historyTransaction;
    this.historyTransaction = null;
    if (snapshot === this.serialize()) return false;
    this._pushUndoSnapshot(snapshot);
    this.redoStack = [];
    return true;
  }

  undo() {
    this.historyTransaction = null;
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.redoStack.push(this.serialize());
    this.state = normalizeState(JSON.parse(previous));
    return true;
  }

  redo() {
    this.historyTransaction = null;
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.serialize());
    this.state = normalizeState(JSON.parse(next));
    return true;
  }

  _snapshot() {
    if (this.historyTransaction !== null) return;
    this._pushUndoSnapshot(this.serialize());
  }

  _pushUndoSnapshot(snapshot) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > 100) this.undoStack.shift();
  }
}

function emptyState() {
  return {
    version: 1,
    viewport: { x: 0, y: 0, scale: 1 },
    nodes: [],
    edges: [],
    comments: [],
  };
}

function normalizeState(state) {
  const next = state && typeof state === "object" ? state : emptyState();
  return {
    ...next,
    version: Number(next.version) || 1,
    viewport: {
      x: Number(next.viewport?.x) || 0,
      y: Number(next.viewport?.y) || 0,
      scale: Math.max(0.05, Math.min(8, Number(next.viewport?.scale) || 1)),
    },
    nodes: Array.isArray(next.nodes) ? next.nodes.map((node) => normalizeNode(node, { preserveImageDimensions: true })) : [],
    edges: Array.isArray(next.edges) ? next.edges.map((edge) => normalizeEdge(edge)) : [],
    comments: Array.isArray(next.comments) ? next.comments : [],
  };
}

function normalizeNode(node, options = {}) {
  node.id = String(node.id || "");
  node.kind = String(node.kind || "prompt");
  node.name = String(node.name || "Node");
  node.x = Number(node.x) || 0;
  node.y = Number(node.y) || 0;
  if (node.kind === "image") {
    const normalizeDimension = options.preserveImageDimensions ? preserveDimension : snap16;
    node.width = Math.max(16, normalizeDimension(Number(node.width) || 256));
    node.height = Math.max(16, normalizeDimension(Number(node.height) || 256));
  } else {
    const size = constrainGeneratedSize(Number(node.width) || 256, Number(node.height) || 256);
    node.width = size.width;
    node.height = size.height;
  }
  node.selected = !!node.selected;
  node.status = String(node.status || "");
  node.image_url = String(node.image_url || node.imageUrl || "");
  node.prompt = String(node.prompt || "");
  node.metadata_json = String(node.metadata_json || node.metadataJson || "");
  return node;
}

function preserveDimension(value) {
  return Number(value) || 16;
}

function normalizeEdge(edge) {
  edge.id = String(edge.id || "");
  edge.kind = String(edge.kind || "prompt_input");
  edge.from_node_id = String(edge.from_node_id || edge.fromNodeId || "");
  edge.to_node_id = String(edge.to_node_id || edge.toNodeId || "");
  edge.selected = !!edge.selected;
  return edge;
}

function snap16(value) {
  return Math.max(16, Math.round((Number(value) || 16) / 16) * 16);
}

function ceil16(value) {
  return Math.min(
    MAX_PROMPT_DIMENSION,
    Math.max(
      GENERATED_IMAGE_DIMENSION_MULTIPLE,
      Math.ceil((Number(value) || GENERATED_IMAGE_DIMENSION_MULTIPLE) / GENERATED_IMAGE_DIMENSION_MULTIPLE) * GENERATED_IMAGE_DIMENSION_MULTIPLE,
    ),
  );
}

function fitWithinMaxDimension(width, height, maxDimension) {
  const safeWidth = Math.max(1, Number(width) || maxDimension);
  const safeHeight = Math.max(1, Number(height) || maxDimension);
  const scale = Math.min(1, maxDimension / safeWidth, maxDimension / safeHeight);
  return {
    width: Math.round(safeWidth * scale),
    height: Math.round(safeHeight * scale),
  };
}

function constrainGeneratedSize(width, height) {
  const fitted = fitWithinMaxDimension(width, height, MAX_PROMPT_DIMENSION);
  let w = Math.max(GENERATED_IMAGE_DIMENSION_MULTIPLE, Math.min(MAX_PROMPT_DIMENSION, snap16(fitted.width)));
  let h = Math.max(GENERATED_IMAGE_DIMENSION_MULTIPLE, Math.min(MAX_PROMPT_DIMENSION, snap16(fitted.height)));
  if (w > h * MAX_GENERATION_ASPECT_RATIO) {
    h = ceil16(w / MAX_GENERATION_ASPECT_RATIO);
  } else if (h > w * MAX_GENERATION_ASPECT_RATIO) {
    w = ceil16(h / MAX_GENERATION_ASPECT_RATIO);
  }
  if (w * h < MIN_GENERATION_PIXELS) {
    const scale = Math.sqrt(MIN_GENERATION_PIXELS / Math.max(1, w * h));
    w = ceil16(w * scale);
    h = ceil16(h * scale);
  }
  if (w > h * MAX_GENERATION_ASPECT_RATIO) {
    h = ceil16(w / MAX_GENERATION_ASPECT_RATIO);
  } else if (h > w * MAX_GENERATION_ASPECT_RATIO) {
    w = ceil16(h / MAX_GENERATION_ASPECT_RATIO);
  }
  return { width: w, height: h };
}

function parseObject(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function imageUrl(image) {
  return String(image?.image_url || image?.imageUrl || "").trim();
}

function imagePending(image) {
  if (String(image?.status || "").toLowerCase() !== "loading") return false;
  const metadata = parseObject(image?.metadata_json || image?.metadataJson);
  if (metadata.partial === true) return true;
  // An in-flight inpaint slot carries the source image URL as the backdrop for
  // the pixel-edit treatment; that URL is not a result, so the slot is still
  // pending. Completion rewrites source to "generation" with an imageId.
  if (metadata.source === "inpaint") return true;
  return !imageUrl(image);
}

/**
 * Drop the loading slots a failed generation request left behind.
 *
 * Those slots never receive an image, so leaving them in place makes
 * reconcileCommittedGenerationImages report stillPending forever and the node
 * spins with no way out. Removing them lets the node settle into its error state
 * with a retry. Only slots from this generation request are touched: committed
 * images, inpaint slots, and slots from a newer request all survive. An empty
 * requestId drops every pending generation slot on the node.
 *
 * @returns {{ images: object[], removed: number }}
 */
export function withoutFailedGenerationSlots(localImages = [], requestId = "") {
  const images = [];
  let removed = 0;
  for (const image of Array.isArray(localImages) ? localImages : []) {
    const metadata = parseObject(image?.metadata_json || image?.metadataJson);
    const failedSlot = String(image?.status || "").toLowerCase() === "loading"
      && metadata.source === "generation"
      && (!requestId || String(metadata.requestId || "") === String(requestId));
    if (failedSlot) {
      removed += 1;
      continue;
    }
    images.push(image);
  }
  return { images, removed };
}

/**
 * Pick out the nodes, edges, and in-flight slots that exist on the server but
 * not locally.
 *
 * An open canvas used to ignore server nodes it did not already know about, and
 * then save its own document over them — which deleted prompt nodes an MCP agent
 * had just staged and orphaned the images those nodes were generating. Adopting
 * unknown nodes keeps this tab a superset of what the server holds, so its next
 * save cannot drop someone else's work.
 *
 * `pendingSlots` covers the same hazard one level down: when the agent stages
 * onto a node this tab already has, only the loading slots are new, and a save
 * that omits them strands the images being rendered into them. Committed slots
 * are left to reconcileCommittedGenerationImages.
 *
 * Edges come along only when they hang off an adopted node and both endpoints
 * are present afterwards, so no dangling edge is introduced.
 *
 * @returns {{ nodes: object[], edges: object[], pendingSlots: {nodeId: string, images: object[]}[] }}
 */
export function remoteCanvasAdditions({
  localNodes = [],
  localEdges = [],
  remoteNodes = [],
  remoteEdges = [],
  normalizeImageUrl = (url) => url,
} = {}) {
  const nodeId = (node) => String(node?.id || "").trim();
  const localNodesById = new Map(
    (Array.isArray(localNodes) ? localNodes : [])
      .filter((node) => nodeId(node))
      .map((node) => [nodeId(node), node]),
  );
  const localNodeIds = new Set(localNodesById.keys());
  const adoptedIds = new Set();
  const nodes = [];
  const pendingSlots = [];
  for (const remote of Array.isArray(remoteNodes) ? remoteNodes : []) {
    const id = nodeId(remote);
    if (!id || adoptedIds.has(id)) continue;
    if (localNodeIds.has(id)) {
      const images = pendingRemoteSlots(localNodesById.get(id), remote);
      if (images.length) pendingSlots.push({ nodeId: id, images });
      continue;
    }
    nodes.push(adoptRemoteNode(remote, normalizeImageUrl));
    adoptedIds.add(id);
  }

  const knownNodeIds = new Set([...localNodeIds, ...adoptedIds]);
  const localEdgeIds = new Set(
    (Array.isArray(localEdges) ? localEdges : []).map((edge) => String(edge?.id || "").trim()).filter(Boolean),
  );
  const edges = [];
  for (const edge of Array.isArray(remoteEdges) ? remoteEdges : []) {
    const id = String(edge?.id || "").trim();
    if (!id || localEdgeIds.has(id)) continue;
    const from = String(edge?.from_node_id || edge?.fromNodeId || "").trim();
    const to = String(edge?.to_node_id || edge?.toNodeId || "").trim();
    if (!adoptedIds.has(from) && !adoptedIds.has(to)) continue;
    if (!knownNodeIds.has(from) || !knownNodeIds.has(to)) continue;
    edges.push(edge);
  }
  return { nodes, edges, pendingSlots };
}

// pendingRemoteSlots returns the still-rendering slot entries a known node has
// on the server but not in this tab.
function pendingRemoteSlots(localNode, remoteNode) {
  const remoteImages = Array.isArray(remoteNode?.images) ? remoteNode.images : [];
  if (!remoteImages.length) return [];
  const localIds = new Set(
    (Array.isArray(localNode?.images) ? localNode.images : [])
      .map((image) => String(image?.id || "").trim())
      .filter(Boolean),
  );
  return remoteImages.filter((image) => {
    const id = String(image?.id || "").trim();
    if (!id || localIds.has(id)) return false;
    return String(image?.status || "").toLowerCase() === "loading" && !imageUrl(image);
  });
}

function adoptRemoteNode(remote, normalizeImageUrl) {
  const node = { ...remote };
  // Selection belongs to whoever made it, not to this tab.
  delete node.selected;
  const url = String(node.image_url || node.imageUrl || "").trim();
  if (url) {
    node.image_url = normalizeImageUrl(url);
    delete node.imageUrl;
  }
  const images = Array.isArray(node.images) ? node.images : [];
  if (images.length) {
    node.images = images.map((image) => {
      const imageSrc = String(image?.image_url || image?.imageUrl || "").trim();
      if (!imageSrc) return image;
      const next = { ...image, image_url: normalizeImageUrl(imageSrc) };
      delete next.imageUrl;
      return next;
    });
  }
  return node;
}

export function reconcileCommittedGenerationImages({
  localImages = [],
  serverImages = [],
  nodeMetadata = {},
  active = false,
  reconcileGenerationState = false,
  resolveImageUrl = imageUrl,
} = {}) {
  const images = (Array.isArray(localImages) ? localImages : []).map((image) => {
    if (imagePending(image)) return image;
    if (image?.status === "loading" && imageUrl(image)) {
      return { ...image, status: "ready" };
    }
    return image;
  });
  let changed = false;
  if (images.some((image, index) => image !== localImages[index])) changed = true;

  for (const serverImage of Array.isArray(serverImages) ? serverImages : []) {
    const resolvedUrl = String(resolveImageUrl(serverImage) || "").trim();
    const metadataRaw = String(serverImage?.metadata_json || serverImage?.metadataJson || "");
    const metadata = parseObject(metadataRaw);
    if (!resolvedUrl || !metadata.imageId) continue;

    const localIndex = images.findIndex((image) => image.id === serverImage.id);
    const committedImage = {
      ...serverImage,
      status: "ready",
      image_url: resolvedUrl,
      metadata_json: metadataRaw || JSON.stringify(metadata),
    };
    if (localIndex < 0) {
      images.push(committedImage);
      changed = true;
      continue;
    }

    const localMetadata = parseObject(images[localIndex]?.metadata_json || images[localIndex]?.metadataJson);
    if (imageUrl(images[localIndex]) === resolvedUrl
      && localMetadata.imageId === metadata.imageId
      && images[localIndex].status === "ready") continue;
    images[localIndex] = { ...images[localIndex], ...committedImage };
    changed = true;
  }

  const stillPending = images.some(imagePending);
  const metadata = { ...parseObject(nodeMetadata) };
  if (reconcileGenerationState && !active && !stillPending) {
    delete metadata.generating;
    delete metadata.generationRequestId;
  }
  const metadataChanged = JSON.stringify(metadata) !== JSON.stringify(parseObject(nodeMetadata));

  return { images, metadata, changed: changed || metadataChanged, stillPending };
}

/**
 * Find the generation requests a node is still waiting on that nothing is
 * running any more.
 *
 * A node holds loading slots and `generating: true` from the moment the client
 * stages them, before `POST /canvas/generate` is even sent. If that request
 * never reaches the server — the save in front of it lost a compare-and-set, the
 * tab was closed mid-request — nothing ever clears them: no canvas_image, no
 * canvas_generation_error, and reconcileCommittedGenerationImages sees pending
 * slots and keeps the node spinning for good.
 *
 * The project socket's generation_jobs_snapshot names every job actually queued
 * or running, so a request missing from it is finished or was never started. Age
 * is required as well, because the snapshot is taken at connect time and a
 * generation enqueued in that same moment may not be in it yet. A slot with no
 * `startedAt` predates that stamp, which means it has been sitting there across
 * at least one release — old by definition.
 *
 * @returns {{ nodeId: string, requestId: string }[]}
 */
export function abandonedGenerationRequests({
  nodes = [],
  liveRequestIds = new Set(),
  now = 0,
  staleAfterMs = 10 * 60 * 1000,
} = {}) {
  const live = liveRequestIds instanceof Set ? liveRequestIds : new Set(liveRequestIds || []);
  const abandoned = [];
  const seen = new Set();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const nodeId = String(node?.id || "");
    if (!nodeId) continue;
    for (const image of Array.isArray(node?.images) ? node.images : []) {
      if (!imagePending(image)) continue;
      const metadata = parseObject(image?.metadata_json || image?.metadataJson);
      if (metadata.source !== "generation") continue;
      const requestId = String(metadata.requestId || "");
      if (live.has(requestId)) continue;
      const startedAt = Number(metadata.startedAt || 0);
      if (startedAt > 0 && now - startedAt < staleAfterMs) continue;
      const key = `${nodeId} ${requestId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      abandoned.push({ nodeId, requestId });
    }
  }
  return abandoned;
}

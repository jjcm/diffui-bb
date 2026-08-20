/**
 * A pasted or dropped image lands on the canvas from the clipboard bytes, before
 * the asset upload has finished. These helpers own the two metadata shapes that
 * hand-off needs: the placeholder while the upload is in flight, and the merge
 * that swaps in the stored asset once it lands.
 */

/** Node name while a pasted image is uploading or being analyzed. */
export const PASTE_ANALYZING_NAME = "Analyzing...";

/**
 * Metadata for the node drawn straight from the clipboard. The upload and the
 * analysis that follows it share one spinner, so the node starts `processing`
 * even when the clipboard payload already carried an expanded JSON.
 */
export function pendingUploadMetadata(base = {}) {
  return { ...base, analysisStatus: "processing", uploadPending: true };
}

/**
 * Fold an uploaded asset into a node that is already on the canvas: the stored
 * file URL, the asset id analysis events match on, and whatever analysis state
 * the upload response already carried.
 */
export function uploadedAssetNodeUpdate({
  nodeMetadata = {},
  images = [],
  asset = null,
  analysis = {},
  fallbackName = "Pasted image",
} = {}) {
  const fileUrl = String(asset?.fileUrl || asset?.file_url || "");
  const assetId = String(asset?.id || "");
  // The placeholder status was this client's, not the asset's: drop it so an
  // asset that skipped analysis does not leave the node spinning.
  const merge = (base) => {
    const next = { ...base, assetId };
    delete next.uploadPending;
    delete next.analysisStatus;
    return { ...next, ...analysis };
  };
  const metadata = merge(nodeMetadata);
  const nextImages = images.map((image, index) => {
    if (index !== 0) return image;
    const imageMetadata = merge(parseJson(image?.metadata_json) || {});
    return {
      ...image,
      image_url: fileUrl || image?.image_url || "",
      status: "ready",
      metadata_json: JSON.stringify(imageMetadata),
    };
  });
  const name = metadata.analysisStatus === "processing"
    ? PASTE_ANALYZING_NAME
    : String(asset?.name || fallbackName || "Pasted image");
  return { fileUrl, assetId, name, metadataJson: JSON.stringify(metadata), images: nextImages };
}

/**
 * Drop the nodes whose bytes are still uploading. They point at an object URL
 * only this tab can resolve, so neither the stored document nor a peer may see
 * them; the upload adds them back with the stored URL when it lands.
 */
export function withoutPendingUploadNodes(state) {
  const nodes = Array.isArray(state?.nodes) ? state.nodes : null;
  if (!nodes) return state;
  const pending = new Set(nodes.filter(isPendingUploadNode).map((node) => node.id));
  if (!pending.size) return state;
  const edgeEnd = (edge, snake, camel) => String(edge?.[snake] ?? edge?.[camel] ?? "");
  return {
    ...state,
    nodes: nodes.filter((node) => !pending.has(node.id)),
    edges: Array.isArray(state.edges)
      ? state.edges.filter(
        (edge) => !pending.has(edgeEnd(edge, "from_node_id", "fromNodeId"))
          && !pending.has(edgeEnd(edge, "to_node_id", "toNodeId")),
      )
      : state.edges,
  };
}

function isPendingUploadNode(node) {
  return !!(parseJson(node?.metadata_json) || {}).uploadPending;
}

function parseJson(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Collab single flight for canvas generation.
 *
 * Every edit client on a board receives the same project events over the project WebSocket, so any
 * client-side reaction that ends in `POST /canvas/generate` runs once per connected client for a
 * single user action: N jobs, N sets of images, N wallet debits. These helpers decide which client
 * owns an action, and how a client whose request the server folded away rejoins the winning job.
 */

/**
 * Whether this client should send the generate that follows a click-prompt suggestion.
 *
 * `canvas_click_prompt_ready` lands on every edit client and each one types the suggested prompt
 * into the node; only the client whose double-click started the request may also generate from it.
 * An event with no initiator (an API caller, or a client that did not identify itself) leaves every
 * client generating, and the server's single flight collapses those back into one job.
 */
export function shouldAutoGenerateClickPrompt({ initiatorClientId = "", localClientId = "" } = {}) {
  const initiator = String(initiatorClientId || "").trim();
  if (!initiator) return true;
  return initiator === String(localClientId || "").trim();
}

/**
 * Read a `/canvas/generate` response the server coalesced into a job another client had already
 * started for the same action. Returns the winning job's node and slot ids so the caller can drop
 * the placeholders it reserved for a request that will never run, or null when this request won
 * the race and owns its own job.
 */
export function coalescedGeneration(response, requestId) {
  if (!response || response.coalesced !== true) return null;
  const winner = String(response.requestId || "").trim();
  if (!winner || winner === String(requestId || "").trim()) return null;
  return {
    requestId: winner,
    nodeId: String(response.nodeId || "").trim(),
    slotNodeIds: Array.isArray(response.slotNodeIds)
      ? response.slotNodeIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [],
  };
}

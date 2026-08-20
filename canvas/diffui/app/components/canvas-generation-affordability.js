/**
 * Wallet affordability math for canvas generation.
 *
 * The server picks a generator at random per slot and debits that generator's
 * price when the image commits, so the only safe plan is the priciest active
 * generator (`GET /api/generation/pricing` → `max_option_price_cents`). Queueing
 * a slot the wallet cannot cover at that price fails mid-generation, after the
 * cheaper slots have already spent the balance.
 *
 * @param {object} input
 * @param {number} input.requestedCount   Options the user asked for.
 * @param {number} input.walletCents      Live wallet balance.
 * @param {number} input.priceCents       Highest active generator price per option.
 * @param {boolean} [input.isAdmin]       Admins are debited but never blocked on balance.
 * @param {boolean} [input.hasWallet]     False when the balance is unknown (embed, signed out).
 * @returns {{ count: number, blocked: number, clamped: boolean, limited: boolean }}
 *   count is what to queue, blocked is what the wallet cannot cover, clamped marks
 *   any wallet-driven reduction, and limited marks a clamp that still queues work.
 */
export function affordableOptionCount({
  requestedCount = 0,
  walletCents = 0,
  priceCents = 0,
  isAdmin = false,
  hasWallet = true,
} = {}) {
  const requested = Math.max(0, Math.floor(Number(requestedCount) || 0));
  const unclamped = { count: requested, blocked: 0, clamped: false, limited: false };
  if (!requested || isAdmin || !hasWallet) return unclamped;

  const price = Number(priceCents);
  // No usable price (pricing lookup failed, or no active generator) means we
  // cannot plan; let the request through and let the server be the backstop.
  if (!Number.isFinite(price) || price <= 0) return unclamped;

  const balance = Number(walletCents);
  if (!Number.isFinite(balance)) return unclamped;

  const affordable = Math.max(0, Math.floor(balance / price));
  const count = Math.min(requested, affordable);
  return {
    count,
    blocked: requested - count,
    clamped: count < requested,
    limited: count > 0 && count < requested,
  };
}

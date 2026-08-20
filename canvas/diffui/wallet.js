import { showAppToast } from "./app/components/diffui-app-toast.js";

let currentUser = null;

export function setCurrentUser(user) {
  currentUser = user || null;
  if (user?.id) {
    window.DIFFUI_USER_ID = String(user.id);
    const name = String(user.display_name || user.displayName || user.email || "").trim();
    window.DIFFUI_USER_NAME = name || "User";
    const avatar = String(user.avatar_url || user.avatarUrl || "").trim();
    if (avatar) window.DIFFUI_USER_AVATAR = avatar;
    else delete window.DIFFUI_USER_AVATAR;
  } else {
    delete window.DIFFUI_USER_ID;
    delete window.DIFFUI_USER_NAME;
    delete window.DIFFUI_USER_AVATAR;
  }
}

export function getCurrentUser() {
  return currentUser;
}

export function isWalletDepleted(user = currentUser) {
  if (!user || user.is_admin) return false;
  return Number(user.wallet_cents || 0) <= 0;
}

function walletErrorCode(error) {
  const code = String(error?.error || error?.message || error || "").trim();
  if (code === "wallet_depleted" || code === "insufficient_wallet") return code;
  if (code.includes("insufficient_wallet")) return "insufficient_wallet";
  return "";
}

export function isWalletBillingError(error) {
  return !!walletErrorCode(error);
}

function toastMessageForWalletError(code, source = "wallet") {
  if (code === "insufficient_wallet") {
    return "Not enough credits for this generation. Top up your wallet to continue.";
  }
  switch (source) {
    case "new-generation":
      return "Your wallet is empty. Add funds before starting a new generation.";
    case "new-canvas":
      return "Your wallet is empty. Add funds before creating a canvas.";
    case "page":
      return "Your wallet is empty. Add funds before creating another page.";
    case "build":
      return "Your wallet is empty. Add funds before building this app.";
    case "duplicate-generation":
      return "Your wallet is empty. Add funds before duplicating this project.";
    case "canvas-generation":
      return "Your wallet is empty. Add funds before generating on the canvas.";
    default:
      return "Your wallet is empty. Top up to continue generating.";
  }
}

/**
 * @param {string} source
 * @param {unknown} error
 * @param {{ forceNudge?: boolean, message?: string }} options
 *   forceNudge shows the top-up nudge even when the wallet still holds a balance
 *   too small to cover the request; message replaces the default toast copy when
 *   the caller can say something more specific (how much of the request it can
 *   still afford, say).
 */
export function notifyInsufficientCredits(source = "wallet", error = "wallet_depleted", { forceNudge = false, message = "" } = {}) {
  const code = walletErrorCode(error) || "wallet_depleted";
  showAppToast(String(message || "").trim() || toastMessageForWalletError(code, source), { tone: "error" });
  if (forceNudge || code === "wallet_depleted" || isWalletDepleted()) {
    window.dispatchEvent(
      new CustomEvent("diffui:wallet-depleted", {
        detail: { source, error: code },
      }),
    );
  }
}

export function guardWalletAction(source = "wallet") {
  if (!isWalletDepleted()) return true;
  notifyInsufficientCredits(source);
  return false;
}

/** @deprecated use notifyInsufficientCredits */
export function notifyWalletDepleted(source = "wallet") {
  notifyInsufficientCredits(source);
}

export async function handleWalletGuardResponse(response, source = "wallet", refreshUser = null) {
  if (!response || response.status !== 402) return false;
  const data = await response.clone().json().catch(() => ({}));
  const code = walletErrorCode(data);
  if (!code) return false;
  notifyInsufficientCredits(source, code);
  if (typeof refreshUser === "function") {
    await refreshUser().catch(() => null);
  }
  return true;
}

export function applyWalletBalance(walletCents, { workspaceId = "", subscription = null } = {}) {
  const cents = Number(walletCents) || 0;
  const ws = String(workspaceId || "").trim();
  if (!ws) {
    if (!currentUser) return;
    if (Number(currentUser.wallet_cents || 0) !== cents) {
      currentUser = { ...currentUser, wallet_cents: cents };
      setCurrentUser(currentUser);
    }
  }
  document.getElementById("appNav")?.setWalletCents?.(cents, { workspaceId: ws });
  window.dispatchEvent(
    new CustomEvent("diffui:wallet-balance", {
      detail: { wallet_cents: cents, workspace_id: ws, subscription },
    }),
  );
}

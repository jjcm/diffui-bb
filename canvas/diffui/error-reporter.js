const recentReports = new Map();
let globalHandlersInstalled = false;

const ERROR_NAME_TOKEN_RE = /^[A-Za-z0-9_.-]+$/;
const ERROR_NAME_NON_SLUG_RE = /[^a-z0-9]+/g;
const ERROR_NAME_MIN_LEN = 2;
const ERROR_NAME_MAX_LEN = 120;
const ERROR_NAME_SLUG_WORDS = 6;
const ERROR_NAME_SLUG_MAX_LEN = 60;
const ERROR_NAME_TOKEN_TRIM_CHARS = `"'()[]{}<>.,`;

/**
 * Every native JS error carries name "Error", so forwarding it verbatim buckets thousands of
 * unrelated failures under one useless analytics name.
 */
export function isGenericErrorName(name) {
  const trimmed = String(name ?? "").trim();
  return trimmed === "" || trimmed.toLowerCase() === "error";
}

/** True when a value is already a slug-like token such as `project_websocket_closed_1006`. */
export function isErrorNameToken(value) {
  const token = String(value ?? "").trim();
  return token.length >= ERROR_NAME_MIN_LEN && token.length <= ERROR_NAME_MAX_LEN && ERROR_NAME_TOKEN_RE.test(token);
}

function trimEdgeChars(value, chars) {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start++;
  while (end > start && chars.includes(value[end - 1])) end--;
  return value.slice(start, end);
}

function errorNameSlug(message) {
  const slug = String(message ?? "")
    .trim()
    .toLowerCase()
    .replace(ERROR_NAME_NON_SLUG_RE, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) return "error";
  let words = slug.split("_").slice(0, ERROR_NAME_SLUG_WORDS).join("_");
  if (words.length > ERROR_NAME_SLUG_MAX_LEN) {
    words = words.slice(0, ERROR_NAME_SLUG_MAX_LEN).replace(/^_+|_+$/g, "");
  }
  return words || "error";
}

/**
 * Mirrors `generation.DeriveErrorName` in the backend so a browser report and a backend report of
 * the same cause land in the same bucket: keep the leading token when it is slug-like, otherwise
 * sanitize the whole message rather than settling for the generic "error".
 */
export function deriveErrorNameFromMessage(message) {
  const msg = String(message ?? "").trim();
  if (!msg) return "error";
  let token = msg;
  const boundary = token.search(/[:\n\t ]/);
  if (boundary > 0) token = token.slice(0, boundary);
  token = trimEdgeChars(token, ERROR_NAME_TOKEN_TRIM_CHARS);
  if (isErrorNameToken(token)) return token;
  return errorNameSlug(msg);
}

/**
 * Resolves the analytics bucket for a report. Real JS error names (TypeError, DOMException) and
 * caller-supplied names are kept; a generic name falls through to a slug-like message
 * (`project_websocket_closed_1006`), then the reporting operation, then the message itself.
 */
export function resolveErrorName({ errorName = "", name = "", operation = "", message = "" } = {}) {
  if (!isGenericErrorName(errorName)) return String(errorName).trim();
  if (!isGenericErrorName(name)) return String(name).trim();
  const text = String(message ?? "").trim();
  if (isErrorNameToken(text)) return deriveErrorNameFromMessage(text);
  const op = String(operation ?? "").trim();
  if (op) {
    const fromOperation = deriveErrorNameFromMessage(op);
    if (!isGenericErrorName(fromOperation)) return fromOperation;
  }
  return deriveErrorNameFromMessage(text);
}

function normalizeErrorLike(reason) {
  if (reason instanceof Error) {
    return {
      name: reason.name || "Error",
      message: reason.message || String(reason),
      stack: reason.stack || "",
      requestId: reason.requestId || reason.request_id || "",
      httpStatus: Number.isFinite(reason.status) ? reason.status : 0,
    };
  }
  if (typeof reason === "string") {
    return { name: "Error", message: reason, stack: "", requestId: "", httpStatus: 0 };
  }
  if (reason && typeof reason === "object") {
    const name = String(reason.name || reason.error_name || "Error");
    const message = String(reason.message || reason.error || JSON.stringify(reason));
    const stack = typeof reason.stack === "string" ? reason.stack : "";
    const requestId = typeof reason.requestId === "string" ? reason.requestId : typeof reason.request_id === "string" ? reason.request_id : "";
    const httpStatus = Number.isFinite(reason.status) ? Number(reason.status) : Number.isFinite(reason.httpStatus) ? Number(reason.httpStatus) : 0;
    return { name, message, stack, requestId, httpStatus };
  }
  return { name: "Error", message: String(reason ?? "unknown_error"), stack: "", requestId: "", httpStatus: 0 };
}

function buildPayload(reason, context = {}) {
  const normalized = normalizeErrorLike(reason);
  const metadata = {
    route: context.route || window.location.pathname,
    href: window.location.href,
    component: context.component || "",
    operation: context.operation || "",
    stage: context.stage || "",
    view: context.view || "",
    ws_client_id: context.wsClientId || "",
    browser_language: navigator.language || "",
    browser_online: navigator.onLine,
    ...context.metadata,
  };
  Object.keys(metadata).forEach((key) => {
    const value = metadata[key];
    if (value === "" || value == null) delete metadata[key];
  });
  return {
    source: "frontend",
    category: context.category || "client",
    severity: context.severity || "error",
    error_name: resolveErrorName({
      errorName: context.errorName,
      name: normalized.name,
      operation: context.operation,
      message: context.message || normalized.message,
    }),
    message: context.message || normalized.message || "unknown_error",
    stack: context.stack || normalized.stack || "",
    request_id: context.requestId || normalized.requestId || "",
    http_status: context.httpStatus || normalized.httpStatus || 0,
    http_method: context.httpMethod || "",
    http_path: context.httpPath || "",
    project_id: context.projectId || "",
    page_id: context.pageId || "",
    generation_id: context.generationId || "",
    brand_id: context.brandId || "",
    metadata,
  };
}

function dedupeKey(payload) {
  return [
    payload.category,
    payload.error_name,
    payload.message,
    payload.project_id,
    payload.page_id,
    payload.metadata?.operation || "",
    payload.metadata?.component || "",
  ].join("|");
}

function shouldSend(payload) {
  const key = dedupeKey(payload);
  const now = Date.now();
  const last = recentReports.get(key) || 0;
  if (now - last < 5000) return false;
  recentReports.set(key, now);
  return true;
}

export function reportError(reason, context = {}) {
  const payload = buildPayload(reason, context);
  if (!shouldSend(payload)) return Promise.resolve();
  return fetch("/api/error-events", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => null);
}

export function reportMessage(message, context = {}) {
  return reportError(new Error(String(message || "unknown_error")), context);
}

export function installGlobalErrorHandlers(getContext = () => ({})) {
  if (globalHandlersInstalled) return;
  globalHandlersInstalled = true;
  window.addEventListener("error", (event) => {
    const context = getContext() || {};
    reportError(event.error || event.message || "window_error", {
      ...context,
      category: "window_error",
      metadata: {
        ...context.metadata,
        filename: event.filename || "",
        lineno: event.lineno || 0,
        colno: event.colno || 0,
      },
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const context = getContext() || {};
    reportError(event.reason || "unhandled_rejection", {
      ...context,
      category: "unhandled_rejection",
    });
  });
}

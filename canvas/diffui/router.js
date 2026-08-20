/** Pathname-based app sections (server falls back to index.html for these). */

export const APP_ROOT = "/app";

export function normalizeAppPath(pathname) {
  const p = (pathname || "/").replace(/\/+$/, "") || "/";
  return p;
}

export function isAppPath(pathname) {
  const p = normalizeAppPath(pathname);
  return p === APP_ROOT || p.startsWith(`${APP_ROOT}/`);
}

export function stripAppPrefix(pathname) {
  const p = normalizeAppPath(pathname);
  if (p === APP_ROOT) return "/";
  if (p.startsWith(`${APP_ROOT}/`)) return p.slice(APP_ROOT.length) || "/";
  return p;
}

export function appPath(pathname = "/") {
  const p = normalizeAppPath(pathname);
  if (p === "/") return APP_ROOT;
  if (p.startsWith(`${APP_ROOT}/`) || p === APP_ROOT) return p;
  return `${APP_ROOT}${p}`;
}

const KNOWN_TOP = new Set([
  "/app",
  "/app/creator",
  "/app/projects",
  "/app/canvas",
  "/app/brands",
  "/app/teams/new",
  "/app/teams/settings",
  "/app/teams/settings/general",
  "/app/teams/settings/billing",
  "/app/teams/settings/usage",
  "/app/teams/settings/members",
  "/app/account",
  "/app/account/profile",
  "/app/account/api",
  "/app/account/billing",
  "/app/account/usage",
  "/app/account/referral",
  "/app/api",
  "/app/billing",
  "/app/settings",
  "/app/settings/account",
  "/app/settings/api",
  "/app/settings/billing",
  "/app/settings/usage",
  "/app/settings/referral",
  "/app/admin",
  "/app/admin/analytics",
  "/app/admin/funnel",
  "/app/admin/segments",
  "/app/admin/attribution",
  "/app/admin/retention",
  "/app/admin/analytics-keys",
  "/app/admin/invites",
  "/app/admin/generators",
  "/app/admin/users",
  "/app/admin/mcp",
]);

/** Team creation lives on its own route so the browse sidebar stays put while the form is open. */
const CREATE_TEAM_SUBPATH = "/teams/new";
export const CREATE_TEAM_PATH = `${APP_ROOT}${CREATE_TEAM_SUBPATH}`;

/**
 * Team and account settings that slide in over the space sidebar. They keep the browse page (and
 * its sidebar) mounted, so they get routes of their own rather than reusing /app/settings — those
 * full-page settings views still answer their URLs for deep links.
 */
const TEAM_SETTINGS_SUBPATH = "/teams/settings";
export const TEAM_SETTINGS_PATH = `${APP_ROOT}${TEAM_SETTINGS_SUBPATH}`;
export const TEAM_SETTINGS_SECTIONS = ["general", "billing", "usage", "members"];

const ACCOUNT_SETTINGS_SUBPATH = "/account";
export const ACCOUNT_SETTINGS_PATH = `${APP_ROOT}${ACCOUNT_SETTINGS_SUBPATH}`;
export const ACCOUNT_SETTINGS_SECTIONS = ["profile", "api", "billing", "usage", "referral"];

/** Shared parser for `<base>` (=> first section) and `<base>/<section>` routes. */
function sectionFromSubpath(pathname, subpath, sections) {
  const p = stripAppPrefix(pathname);
  if (p === subpath) return sections[0];
  if (!p.startsWith(`${subpath}/`)) return "";
  const rest = p.slice(subpath.length + 1);
  if (!rest || rest.includes("/")) return "";
  return sections.includes(rest) ? rest : "";
}

/** "" when the path is not a team settings route. */
export function teamSettingsSectionFromPath(pathname) {
  return sectionFromSubpath(pathname, TEAM_SETTINGS_SUBPATH, TEAM_SETTINGS_SECTIONS);
}

export function teamSettingsSectionToPath(section) {
  const next = TEAM_SETTINGS_SECTIONS.includes(section) ? section : TEAM_SETTINGS_SECTIONS[0];
  return next === TEAM_SETTINGS_SECTIONS[0] ? TEAM_SETTINGS_PATH : `${TEAM_SETTINGS_PATH}/${next}`;
}

/** "" when the path is not an account settings route. */
export function accountSettingsSectionFromPath(pathname) {
  return sectionFromSubpath(pathname, ACCOUNT_SETTINGS_SUBPATH, ACCOUNT_SETTINGS_SECTIONS);
}

export function accountSettingsSectionToPath(section) {
  const next = ACCOUNT_SETTINGS_SECTIONS.includes(section) ? section : ACCOUNT_SETTINGS_SECTIONS[0];
  return next === ACCOUNT_SETTINGS_SECTIONS[0] ? ACCOUNT_SETTINGS_PATH : `${ACCOUNT_SETTINGS_PATH}/${next}`;
}
/** Ordered list of admin sections. First entry is the default for /admin. */
export const ADMIN_SECTIONS = [
  "overview",
  "analytics",
  "funnel",
  "segments",
  "attribution",
  "retention",
  "analytics-keys",
  "invites",
  "generators",
  "users",
  "mcp",
];

/** Canonical URL path for a given admin section. */
export function adminSectionToPath(section) {
  if (!section || section === "overview") return "/app/admin";
  if (ADMIN_SECTIONS.includes(section)) return `/app/admin/${section}`;
  return "/app/admin";
}

/** Parse the admin sub-section from a pathname. Returns "overview" for /admin. */
export function adminSectionFromPath(pathname) {
  const p = stripAppPrefix(pathname);
  if (p === "/admin") return "overview";
  if (!p.startsWith("/admin/")) return "";
  const rest = p.slice("/admin/".length);
  if (!rest || rest.includes("/")) return "";
  return ADMIN_SECTIONS.includes(rest) ? rest : "";
}

/** Brand detail URLs: `/brands/<id>` (single path segment, no nested slashes). */
export function pathBrandIdFromPath(pathname) {
  const p = stripAppPrefix(pathname);
  if (p === "/brands") return "";
  if (!p.startsWith("/brands/")) return "";
  const rest = p.slice("/brands/".length);
  if (!rest || rest.includes("/")) return "";
  return rest;
}

/** Virtual personal-space folder for files the user has a collaborator grant on. */
export const SHARED_WITH_ME_FOLDER_ID = "shared-with-me";

/**
 * Projects browse URLs encode the active team and folder so they can be linked
 * and walked with back/forward:
 *   /app/projects
 *   /app/projects/f/:folderId
 *   /app/projects/t/:workspaceId
 *   /app/projects/t/:workspaceId/f/:folderId
 * Recents is the path with no folder segment. Personal space has no /t/ segment.
 * Returns null when the path is not a projects browse URL.
 */
export function projectsBrowseFromPath(pathname) {
  const p = stripAppPrefix(pathname);
  if (p === "/projects") {
    return { workspaceId: "", folderId: "" };
  }
  if (!p.startsWith("/projects/")) return null;
  const parts = p.slice("/projects/".length).split("/").filter(Boolean);
  const id = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  if (parts.length === 2 && parts[0] === "f" && parts[1]) {
    return { workspaceId: "", folderId: id(parts[1]) };
  }
  if (parts.length === 2 && parts[0] === "t" && parts[1]) {
    return { workspaceId: id(parts[1]), folderId: "" };
  }
  if (parts.length === 4 && parts[0] === "t" && parts[1] && parts[2] === "f" && parts[3]) {
    return { workspaceId: id(parts[1]), folderId: id(parts[3]) };
  }
  return null;
}

export function projectsBrowseToPath({ workspaceId = "", folderId = "" } = {}) {
  const ws = String(workspaceId || "").trim();
  const folder = String(folderId || "").trim();
  if (ws && folder) return appPath(`/projects/t/${encodeURIComponent(ws)}/f/${encodeURIComponent(folder)}`);
  if (ws) return appPath(`/projects/t/${encodeURIComponent(ws)}`);
  if (folder) return appPath(`/projects/f/${encodeURIComponent(folder)}`);
  return appPath("/projects");
}

/**
 * Canvas crumb for a file's folder. The team/space name is not shown — the
 * switcher already identifies the space. Unfiled files use Recents.
 */
export function projectsLocationLabel(loc = {}, _personalLabel = "Files") {
  const folderName = String(loc.folderName || "").trim();
  if (folderName) return folderName;
  return "Recents";
}

export function settingsSectionFromPath(pathname) {
  const p = stripAppPrefix(pathname);
  if (p === "/settings/account" || p === "/settings") return "account";
  if (p === "/settings/api" || p === "/api") return "api";
  if (p === "/settings/billing" || p === "/billing") return "billing";
  if (p === "/settings/usage") return "usage";
  if (p === "/settings/referral") return "referral";
  return "";
}

/**
 * Map URL pathname to a view id: landing | auth | generations | creator | brands | api | billing | admin
 */
export function pathToView(pathname, isAuthed, isAdmin) {
  const normalized = normalizeAppPath(pathname);
  const p = stripAppPrefix(pathname);
  if (normalized === "/") return "landing";
  if (normalized === "/pricing") return "pricing";
  if (normalized.startsWith("/brand/")) return "brandShare";
  if (normalized === "/editor") return "editor";
  if (normalized === "/test2") return "test2";
  if (!isAuthed) {
    return isAppPath(normalized) ? "auth" : "landing";
  }
  if (p.startsWith("/generation/")) {
    const parts = p.split("/").filter(Boolean);
    if (parts.length >= 3 && parts[2] === "wizard") return "wizard";
    return "creator";
  }
  if (/^\/canvas\/[^/]+\/embed$/.test(p)) return "canvasEmbed";
  if (p.startsWith("/canvas/")) return "canvas";
  if (projectsBrowseFromPath(pathname) || p === "/projects" || p === "/generations" || p === "/creator") return "generations";
  if (p === "/brands" || pathBrandIdFromPath(pathname)) return "brands";
  if (p === CREATE_TEAM_SUBPATH) return "createTeam";
  if (teamSettingsSectionFromPath(pathname)) return "teamSettings";
  if (accountSettingsSectionFromPath(pathname)) return "accountSettings";
  if (settingsSectionFromPath(pathname) === "account") return "profile";
  if (settingsSectionFromPath(pathname) === "api") return "api";
  if (settingsSectionFromPath(pathname) === "billing") return "billing";
  if (settingsSectionFromPath(pathname) === "usage") return "usage";
  if (settingsSectionFromPath(pathname) === "referral") return "referral";
  if (p === "/admin" || (p.startsWith("/admin/") && adminSectionFromPath(pathname))) {
    return isAdmin ? "admin" : "generations";
  }
  if (p === "/" || normalized === APP_ROOT) return "generations";
  if (!KNOWN_TOP.has(normalized)) return "generations";
  return "generations";
}

/** Canonical path for a primary app view (auth/landing stays on /). */
export function viewToPath(view) {
  switch (view) {
    case "generations":
      return "/app/projects";
    case "brands":
      return "/app/brands";
    case "createTeam":
      return CREATE_TEAM_PATH;
    case "teamSettings":
      return TEAM_SETTINGS_PATH;
    case "accountSettings":
      return ACCOUNT_SETTINGS_PATH;
    case "creator":
      return "/app/projects";
    case "canvas":
      return "/app/projects";
    case "api":
      return "/app/settings/api";
    case "profile":
      return "/app/settings";
    case "billing":
      return "/app/settings/billing";
    case "usage":
      return "/app/settings/usage";
    case "referral":
      return "/app/settings/referral";
    case "admin":
      return "/app/admin";
    case "landing":
      return "/";
    case "pricing":
      return "/pricing";
    case "editor":
      return "/editor";
    case "test2":
      return "/test2";
    case "auth":
      return "/app";
    default:
      return "/app";
  }
}

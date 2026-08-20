/**
 * Generation images: canonical PNG on disk and in API `file_url`.
 * User-facing URLs under `/files/generations/` must use `.webp` (full) or `_thumb.webp` (grids).
 *
 * Both public helpers finish by handing the URL to `resolveEmbedAssetUrl`, which is a no-op
 * in the Diffui app and only absolutizes for an embedded canvas, whose document base is the
 * host page rather than Diffui.
 */
import { resolveEmbedAssetUrl } from "./embed-bridge.js";

/** Full-res WebP URL for a generation `file_url` (PNG, full WebP, or thumb WebP). */
export function displayUrlForGenerationFileUrl(fileUrl) {
  const u = String(fileUrl || "").trim();
  if (!u.includes("/files/generations/")) return u;
  const lower = u.toLowerCase();
  if (lower.endsWith(".png")) return resolveEmbedAssetUrl(`${u.slice(0, -4)}.webp`);
  if (lower.endsWith("_thumb.webp")) {
    return resolveEmbedAssetUrl(`${u.slice(0, -"_thumb.webp".length)}.webp`);
  }
  return resolveEmbedAssetUrl(u);
}

/** Thumbnail WebP URL for grids and small previews. */
export function thumbnailUrlForGenerationFileUrl(fileUrl) {
  const u = String(fileUrl || "").trim();
  if (!u.includes("/files/generations/")) return u;
  const lower = u.toLowerCase();
  if (lower.endsWith(".png")) return resolveEmbedAssetUrl(`${u.slice(0, -4)}_thumb.webp`);
  if (lower.endsWith("_thumb.webp")) return resolveEmbedAssetUrl(u);
  if (lower.endsWith(".webp")) return resolveEmbedAssetUrl(`${u.slice(0, -5)}_thumb.webp`);
  return resolveEmbedAssetUrl(u);
}

/**
 * Thumbnail rungs the origin materializes on demand, so they can be referenced blindly.
 * The base `_thumb.webp` is 512px — that is what every consumer without a srcset gets,
 * including the canvas surfaces — and the rest are built beside it.
 */
export const THUMB_RUNGS = [
  { w: 128, suffix: "_thumb_sm.webp" },
  { w: 256, suffix: "_thumb_md.webp" },
  { w: 512, suffix: "_thumb.webp" },
  { w: 1024, suffix: "_thumb_xl.webp" },
];

/**
 * Hard product rule: a thumbnail must be served a source at least this many times the
 * CSS size of the box it renders in, so retina screens get real pixels. This overrides
 * byte-saving — a rung that would only just cover the 1x slot is not allowed.
 */
export const THUMB_MIN_SCALE = 2;

/**
 * The smallest rung that satisfies THUMB_MIN_SCALE for a slot, or null when even the
 * largest rung is too small (the caller must then use the full-resolution asset).
 */
export function thumbRungForSlot(slotCssPx) {
  const floor = Math.ceil(slotCssPx * THUMB_MIN_SCALE);
  return THUMB_RUNGS.find((r) => r.w >= floor) || null;
}

/**
 * Builds the srcset for a `{base}_thumb.webp` URL. Candidates are capped at `maxRungW`
 * so a 2x display cannot escalate past the rung the slot actually needs. Returns "" for
 * any URL that is not a thumb derivative.
 */
export function thumbLadderSrcset(url, maxRungW = 1024) {
  const u = String(url || "").trim();
  if (!u.endsWith("_thumb.webp")) return "";
  const base = u.slice(0, -"_thumb.webp".length);
  return THUMB_RUNGS.filter((r) => r.w <= maxRungW)
    .map((r) => `${base}${r.suffix} ${r.w}w`)
    .join(", ");
}

/**
 * Maps any rung of the ladder back to the full-resolution WebP beside it. A thumb only
 * exists once the WebP derivatives were written, so `{base}.webp` is always there too.
 * Anything that is not a rung is returned untouched — in particular a PNG or JPEG brand
 * asset, whose WebP sibling may not exist yet.
 */
export function fullResUrlForThumbUrl(url) {
  const u = String(url || "").trim();
  for (const rung of THUMB_RUNGS) {
    if (u.endsWith(rung.suffix)) return `${u.slice(0, -rung.suffix.length)}.webp`;
  }
  return u;
}

/**
 * Full-resolution URL for a brand image payload, for the surfaces that must never render a
 * downscaled source: the guideline board preview, fullscreen, and download.
 *
 * The payload shape varies by endpoint (detail rows carry `display_full_file_url`, list rows
 * and older sockets only carry a thumb), so a thumb URL is mapped up to its full-resolution
 * sibling rather than trusted as-is. That is what makes "always full resolution" a property
 * of the URL, not of whichever payload happened to arrive.
 */
export function fullResBrandImageUrl(image) {
  if (!image || typeof image !== "object") return "";
  const full = image.display_full_file_url ?? image.displayFullFileUrl;
  const file = image.file_url ?? image.fileUrl;
  const thumb = image.display_file_url ?? image.displayFileUrl;
  const picked = String((full && String(full).trim()) || file || thumb || "").trim();
  return fullResUrlForThumbUrl(picked);
}

const LARGEST_RUNG_W = THUMB_RUNGS[THUMB_RUNGS.length - 1].w;

/**
 * The rung ceiling offered for a slot: the rung that satisfies the floor, and no larger.
 *
 * That rung is already >= 2x the CSS box, so a 2x display renders it at 1:1 device pixels
 * or better and has nothing to gain from stepping up. Letting a 2x display take the next
 * rung would quadruple the bytes of a dense grid for no visible difference.
 */
export function thumbRungCapForSlot(slotCssPx) {
  const needed = thumbRungForSlot(slotCssPx);
  return needed ? needed.w : LARGEST_RUNG_W;
}

/**
 * Points an img at a thumb URL with the ladder applied for a slot of `slotCssPx`.
 *
 * `sizes` is declared as THUMB_MIN_SCALE x the slot rather than the slot itself, which is
 * what pulls a >=2x source at 1x instead of a rung that merely covers the 1x box. Smaller
 * rungs stay in the srcset so a narrower rendering of the same slot can still use them.
 *
 * A reused img must never keep a stale `srcset` (it outranks `src`) when the URL is not a
 * thumb derivative — e.g. the PNG-until-WebP fallback — so the attributes are cleared.
 */
export function applyThumbLadder(img, url, slotCssPx) {
  if (!img) return;
  const srcset = thumbLadderSrcset(url, thumbRungCapForSlot(slotCssPx));
  if (srcset) {
    img.srcset = srcset;
    img.sizes = `${Math.ceil(slotCssPx * THUMB_MIN_SCALE)}px`;
  } else {
    clearThumbLadder(img);
  }
}

/**
 * Strips any ladder from an img, for the slots that must render exactly their `src`.
 * `srcset` outranks `src`, so an img reused from a laddered state (a different brand, a
 * different role) would otherwise keep selecting the old thumbnail.
 */
export function clearThumbLadder(img) {
  if (!img) return;
  img.removeAttribute("srcset");
  img.removeAttribute("sizes");
}

/**
 * Next URL to try when a generation WebP fails to load — thumb ↔ full WebP only (never PNG).
 * Works with absolute resolved `img.src`.
 */
export function webpFallbackForGenerationImageUrl(url) {
  const u = String(url || "").trim();
  const q = u.indexOf("?");
  const base = q >= 0 ? u.slice(0, q) : u;
  const hash = base.indexOf("#");
  const pathOnly = hash >= 0 ? base.slice(0, hash) : base;
  if (!pathOnly.includes("/files/generations/")) return "";
  const lower = pathOnly.toLowerCase();
  if (lower.endsWith("_thumb.webp")) {
    return `${pathOnly.slice(0, -"_thumb.webp".length)}.webp${q >= 0 ? u.slice(q) : ""}`;
  }
  if (lower.endsWith(".webp")) {
    return `${pathOnly.slice(0, -5)}_thumb.webp${q >= 0 ? u.slice(q) : ""}`;
  }
  return "";
}

/** Wire error fallback: alternate WebP size once; do not fall back to PNG. */
export function wireGenerationDisplayImgFallback(img) {
  if (!img) return;
  img.addEventListener(
    "error",
    () => {
      const fb = webpFallbackForGenerationImageUrl(img.src);
      if (fb && img.src !== fb) img.src = fb;
    },
    { once: true },
  );
}

export function wireGenerationThumbImgFallback(img, thumbUrl) {
  if (!img || typeof thumbUrl !== "string") return;
  if (!thumbUrl.includes("/files/generations/") || !thumbUrl.endsWith("_thumb.webp")) return;
  wireGenerationDisplayImgFallback(img);
}

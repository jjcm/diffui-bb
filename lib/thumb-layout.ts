// Browse-grid thumbnail sizing, matched to Diffui's own.
//
// A canvas cover is rendered by Diffui at a FIXED size (the snapshot renderer's
// 1312×640, reported per row as `cover_thumbnail_width/height`), so the card box
// is that exact ratio from the first paint — never a ratio measured from the
// decoded image, and never a fluid one. A measured ratio means every card is the
// wrong shape until its bytes arrive and then reflows; a guessed one distorts.
//
// Inside the fixed box the cover is `contain`ed and the four-up tiles are
// `cover`ed, which is exactly what `.projectCoverImage` / `.generationCardThumb`
// do in the Diffui app, so a canvas that is not precisely 1312×640 is letterboxed
// rather than cropped or stretched.
//
// Pure math, so the sizing contract — including Diffui's hard ≥2× device-pixel
// floor for thumbnail rungs — is testable without a DOM.

/** Size Diffui renders a canvas cover snapshot at, if a row does not say. */
export const GENERATED_CANVAS_THUMB_WIDTH = 1312;
export const GENERATED_CANVAS_THUMB_HEIGHT = 640;

/**
 * Thumbnail rungs the file origin materializes on demand (generation images and
 * canvas covers alike), so they can be referenced blindly.
 */
export const THUMB_RUNGS: ReadonlyArray<{ w: number; suffix: string }> = Object.freeze([
  { w: 128, suffix: "_thumb_sm.webp" },
  { w: 256, suffix: "_thumb_md.webp" },
  { w: 512, suffix: "_thumb.webp" },
  { w: 1024, suffix: "_thumb_xl.webp" },
]);

/**
 * Diffui's product rule: a thumbnail is served a source at least this many
 * times the CSS size of its box, so retina screens get real pixels. It
 * outranks byte-saving — a rung that merely covers the 1× slot is not allowed.
 */
export const THUMB_MIN_SCALE = 2;

/** Browse grid track bounds (CSS px). Cards fill the panel between these. */
export const BROWSE_CARD_MIN_PX = 216;
export const BROWSE_CARD_MAX_PX = 420;

const LARGEST_RUNG_W = THUMB_RUNGS[THUMB_RUNGS.length - 1]!.w;

/**
 * Aspect ratio (width / height) of the box a cover renders in: the generated
 * thumbnail's own, so the grid reserves the right shape before any image loads.
 */
export function thumbAspectRatio(width?: number, height?: number): number {
  const w = Number(width);
  const h = Number(height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return w / h;
  return GENERATED_CANVAS_THUMB_WIDTH / GENERATED_CANVAS_THUMB_HEIGHT;
}

/** CSS `aspect-ratio` value for that box, as the browser wants it written. */
export function thumbAspectRatioCss(width?: number, height?: number): string {
  const w = Number(width);
  const h = Number(height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return `${w} / ${h}`;
  return `${GENERATED_CANVAS_THUMB_WIDTH} / ${GENERATED_CANVAS_THUMB_HEIGHT}`;
}

/** Smallest rung that satisfies the ≥2× floor for a slot, or null if none does. */
export function thumbRungForSlot(slotCssPx: number): { w: number; suffix: string } | null {
  const floor = Math.ceil(Math.max(0, slotCssPx) * THUMB_MIN_SCALE);
  return THUMB_RUNGS.find((rung) => rung.w >= floor) ?? null;
}

/**
 * The rung ceiling offered for a slot: the one that satisfies the floor, and no
 * larger. That rung is already ≥2× the box, so a 2× display renders it at 1:1
 * device pixels or better and has nothing to gain from stepping up — while a
 * denser grid would pay four times the bytes for no visible difference.
 */
export function thumbRungCapForSlot(slotCssPx: number): number {
  return thumbRungForSlot(slotCssPx)?.w ?? LARGEST_RUNG_W;
}

/**
 * `srcset` for a `{base}_thumb.webp` URL, capped at `maxRungW`. Returns "" for
 * any URL that is not a thumb derivative (a PNG-until-WebP brand asset, say),
 * whose `src` must then stand alone.
 */
export function thumbLadderSrcset(url: string, maxRungW: number = LARGEST_RUNG_W): string {
  const u = String(url ?? "").trim();
  if (!u.endsWith("_thumb.webp")) return "";
  const base = u.slice(0, -"_thumb.webp".length);
  return THUMB_RUNGS.filter((rung) => rung.w <= maxRungW)
    .map((rung) => `${base}${rung.suffix} ${rung.w}w`)
    .join(", ");
}

export interface ThumbSource {
  /** `srcset`, or "" when the URL has no ladder. */
  srcSet: string;
  /** `sizes`, declared at the ≥2× floor so 1× displays still pull a 2× rung. */
  sizes: string;
}

/** `srcset`/`sizes` pair for a thumb URL rendered in a `slotCssPx`-wide box. */
export function thumbSourceForSlot(url: string, slotCssPx: number): ThumbSource {
  const srcSet = thumbLadderSrcset(url, thumbRungCapForSlot(slotCssPx));
  return { srcSet, sizes: srcSet === "" ? "" : `${Math.ceil(slotCssPx * THUMB_MIN_SCALE)}px` };
}

import { describe, expect, test } from "vitest";
import {
  BROWSE_CARD_MAX_PX,
  GENERATED_CANVAS_THUMB_HEIGHT,
  GENERATED_CANVAS_THUMB_WIDTH,
  THUMB_MIN_SCALE,
  thumbAspectRatio,
  thumbAspectRatioCss,
  thumbLadderSrcset,
  thumbRungCapForSlot,
  thumbSourceForSlot,
} from "./lib/thumb-layout.js";

describe("thumbAspectRatio", () => {
  test("is the generated thumbnail's own ratio, not a measured or fluid one", () => {
    expect(thumbAspectRatio(1312, 640)).toBeCloseTo(1312 / 640, 6);
    expect(thumbAspectRatioCss(1312, 640)).toBe("1312 / 640");
  });

  test("falls back to the canvas snapshot size when a row reports none", () => {
    const fallback = GENERATED_CANVAS_THUMB_WIDTH / GENERATED_CANVAS_THUMB_HEIGHT;
    expect(thumbAspectRatio(undefined, undefined)).toBeCloseTo(fallback, 6);
    expect(thumbAspectRatio(0, 0)).toBeCloseTo(fallback, 6);
    expect(thumbAspectRatio(Number.NaN, 640)).toBeCloseTo(fallback, 6);
    expect(thumbAspectRatioCss(0, 0)).toBe(
      `${GENERATED_CANVAS_THUMB_WIDTH} / ${GENERATED_CANVAS_THUMB_HEIGHT}`,
    );
  });

  test("honours a row that reports a different generated size", () => {
    expect(thumbAspectRatioCss(1024, 1024)).toBe("1024 / 1024");
    expect(thumbAspectRatio(1024, 1024)).toBe(1);
  });
});

describe("the ≥2× thumbnail floor", () => {
  test("a slot is offered the smallest rung that covers it twice over", () => {
    expect(thumbRungCapForSlot(60)).toBe(128);
    expect(thumbRungCapForSlot(120)).toBe(256);
    expect(thumbRungCapForSlot(220)).toBe(512);
    expect(thumbRungCapForSlot(320)).toBe(1024);
  });

  test("the widest browse card still clears the floor", () => {
    expect(thumbRungCapForSlot(BROWSE_CARD_MAX_PX)).toBeGreaterThanOrEqual(
      BROWSE_CARD_MAX_PX * THUMB_MIN_SCALE,
    );
  });

  test("sizes is declared at the floor so a 1× display pulls a 2× rung", () => {
    const source = thumbSourceForSlot("https://d/x/img_thumb.webp", 220);
    expect(source.sizes).toBe("440px");
    expect(source.srcSet).toContain("img_thumb.webp 512w");
    expect(source.srcSet).not.toContain("_thumb_xl.webp");
  });

  test("a URL with no ladder gets no srcset, so src stands alone", () => {
    expect(thumbLadderSrcset("https://d/x/logo.png")).toBe("");
    expect(thumbSourceForSlot("https://d/x/logo.png", 220)).toEqual({ srcSet: "", sizes: "" });
  });

  test("the ladder is built from the thumb base, never from a PNG", () => {
    expect(thumbLadderSrcset("https://d/c/thumbnail_thumb.webp", 256)).toBe(
      "https://d/c/thumbnail_thumb_sm.webp 128w, https://d/c/thumbnail_thumb_md.webp 256w",
    );
  });
});

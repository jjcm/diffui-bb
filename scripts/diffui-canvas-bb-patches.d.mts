/** Hand-written declaration so the tests can read the patch set. */

export interface BbCanvasPatch {
  /** Snapshot-relative path under `canvas/diffui/`. */
  file: string;
  why: string;
  find: string;
  replace: string;
}

export declare const BB_CANVAS_PATCHES: readonly BbCanvasPatch[];

export declare function applyBbCanvasPatches(
  file: string,
  source: string,
): { source: string; applied: string[] };

/** Hand-written declaration for the generated `canvas-assets.js`. */

/** Server-relative Diffui asset path → the data URL bundled for it. */
export declare const BB_CANVAS_ASSETS: Readonly<Record<string, string>>;

/**
 * The bundled sprite for a Diffui asset path, or `""` when the path is not one
 * (every API path, which still resolves against `DIFFUI_API_BASE`).
 */
export declare function bbCanvasAsset(path: string): string;

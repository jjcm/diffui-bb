// Layout for the plugin's own chrome: the browse grid and the canvas mount.
// Colours ride bb's host tokens; nothing here styles the canvas itself (that is
// bb-canvas-theme.ts, which only redefines Diffui's colour tokens).

/**
 * Browse cards keep the shape Diffui's own browse grid uses: a fixed-ratio box
 * from the generated cover size, the cover `contain`ed inside it, and four-up
 * tiles `cover`ed — so a canvas that is not exactly the snapshot size is
 * letterboxed rather than cropped or stretched.
 */
export const PANEL_CSS = `
.dfbb-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.dfbb-panel-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; }
.dfbb-panel-note { margin: 0; padding: 8px 2px; font-size: 13px; color: var(--muted-foreground); }
.dfbb-panel-error { margin: 0 0 8px; font-size: 12px; color: var(--destructive); }

.dfbb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--dfbb-card-min), 1fr));
  gap: 16px;
  align-content: start;
}
.dfbb-card { display: block; width: 100%; max-width: var(--dfbb-card-max); padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dfbb-card-cover {
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-recessed);
  box-sizing: border-box;
}
.dfbb-card:hover .dfbb-card-cover { border-color: var(--ring); }
.dfbb-card-cover-img { display: block; width: 100%; height: 100%; object-fit: contain; }
.dfbb-card-tiles { display: grid; grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(2, 1fr); gap: 2px; padding: 2px; width: 100%; height: 100%; box-sizing: border-box; }
.dfbb-card-tile { width: 100%; height: 100%; object-fit: cover; display: block; }
.dfbb-card-empty { display: grid; place-items: center; width: 100%; height: 100%; font-size: 12px; color: var(--muted-foreground); }
.dfbb-card-meta { display: flex; align-items: baseline; gap: 6px; padding: 6px 2px 0; }
.dfbb-card-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.dfbb-card-when { flex-shrink: 0; font-size: 11px; color: var(--muted-foreground); }
.dfbb-card-badge { flex-shrink: 0; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }

.dfbb-header { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dfbb-header-btn { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--foreground); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
.dfbb-header-btn:hover { background: var(--state-hover); }
.dfbb-header-btn[disabled] { opacity: 0.5; cursor: default; }
.dfbb-header-link { font-size: 12px; color: var(--muted-foreground); text-decoration: none; white-space: nowrap; }
.dfbb-header-link:hover { color: var(--foreground); }

.dfbb-canvas-shell { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.dfbb-canvas-status { position: absolute; inset: 0; display: grid; place-items: center; font-size: 13px; color: var(--muted-foreground); pointer-events: none; }

.dfbb-threads { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.dfbb-threads-own { flex-shrink: 0; padding: 4px 8px 2px; }
.dfbb-threads-label { margin: 0; padding: 2px 8px 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted-foreground); }
.dfbb-threads-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.dfbb-thread-row { display: flex; align-items: center; gap: 8px; width: 100%; height: 30px; padding: 0 8px; border: 0; border-radius: 7px; background: transparent; color: var(--foreground); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.dfbb-thread-row:hover { background: var(--state-hover); }
.dfbb-thread-row[data-active="true"] { background: var(--state-hover); }
.dfbb-thread-icon { flex-shrink: 0; display: inline-flex; color: var(--muted-foreground); }
.dfbb-thread-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dfbb-thread-when { flex-shrink: 0; font-size: 10px; color: var(--muted-foreground); }
.dfbb-threads-rest { flex: 1; min-height: 0; }
`;

const STYLE_ID = "diffui-bb-panel-styles";

export function ensurePanelStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);
}

// The one way into the vendored canvas.
//
// `canvas/diffui/` mirrors Diffui's frontend file for file (canvas/README.md),
// and importing this module evaluates that graph: it defines
// `<diffui-canvas-workspace>` and the satellite elements it composes. Routing
// every importer through here keeps a single edge from the plugin's own code
// into the mirror, and gives that edge a hand-written declaration
// (`vendored-canvas.d.ts`) so the mirror needs no TypeScript settings of its
// own — it stays plain JavaScript, exactly as Diffui wrote it.
import "../diffui/app/components/diffui-canvas-workspace.js";

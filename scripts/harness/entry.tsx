// Dev-harness page entry: mounts the REAL plugin app (app.tsx) inside a
// bb-like shell so its surfaces can be exercised (and screenshotted) in a
// plain browser when no bb desktop is available. Real component code, real
// plugin backend (fake host in e2e-harness.ts), real Diffui data — including
// the sidebar thread-list replacement (Diffui files as threads).
import { createRoot } from "react-dom/client";
import { HarnessHeaderContentHost, HarnessPanelHost, HarnessThreadListHost } from "./sdk-app-shim.js";
import "../../app.js";

const mount = document.getElementById("root");
if (mount !== null) {
  createRoot(mount).render(<HarnessPanelHost />);
}

const railThreads = document.getElementById("railThreads");
if (railThreads !== null) {
  createRoot(railThreads).render(<HarnessThreadListHost />);
}

// The host's title bar — one bar, with the plugin's controls in it.
const headerSlot = document.getElementById("titlebarPluginContent");
if (headerSlot !== null) {
  createRoot(headerSlot).render(<HarnessHeaderContentHost />);
}

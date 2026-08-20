---
name: diffui-design
description: Design UI in Diffui before implementing it in this workspace. Use when the user asks to design, mock up, or explore visual directions for a page/screen, or references a Diffui canvas or brand.
---

# Designing with Diffui from bb

Diffui renders UI designs from diffusion output onto an infinite canvas. This
plugin's tools drive it without leaving bb.

## Workflow

1. `diffui_create_canvas { title }` — one canvas per design effort. Share the
   returned `canvasUrl` with the user so they can watch options render and
   arrange the board.
2. `diffui_generate_options { project_id, prompt, brand_id? }` — one call per
   screen. **Each image node stays 1:1 with a single prompt**: never combine
   two screens into one prompt; call the tool again with the same
   `project_id` instead, so related screens stay in one named project as
   separate single-prompt nodes.
3. Wait for the user to pick an option (or pick per their instruction), then
   `diffui_create_build_link { pages: [{ image_id, name, original_prompt }] }`
   and fetch the returned `buildUrl` markdown. Follow it exactly — it carries
   full-resolution design images, brand context, and asset-generation APIs.
4. Implement in the current workspace.

## Rules

- Prompts describe what you want (subject + layout + style + palette). No
  negative prompts. Tie hex colors to specific elements.
- Pass `brand_id` whenever the user has a Diffui brand (see `@diffui`
  mentions); do not freestyle over an established brand.
- Generation blocks 1–5 minutes. If a call times out, `diffui_get_canvas`
  shows per-image status — do not re-generate while slots are still loading.
- The user can also push designs to you: "Build with bb" on the Diffui canvas
  spawns a thread here with the same build link. Treat that thread's
  instructions as chosen designs — skip straight to implementing.

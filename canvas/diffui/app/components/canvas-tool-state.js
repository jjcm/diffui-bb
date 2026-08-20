/**
 * Tool identities and the two decisions the canvas toolbar makes about them:
 * which buttons look active, and what a finished rectangle drag turns into.
 *
 * Both are pure so the canvas workspace (`<diffui-canvas-workspace>`) can stay a
 * thin layer over them and the rules can be tested without a DOM.
 */

export const TOOL_RECT = "rect";
export const TOOL_FIND = "find";
export const TOOL_POINTER = "pointer";
export const TOOL_COMMENT = "comment";
/** Rectangle, restricted to selections that land on an image, that opens the edit dialog. */
export const TOOL_EDIT = "edit";
/** Pointer with alt-duplicate latched on, so drags copy instead of move. */
export const TOOL_DUPLICATE = "duplicate";

export const TOOL_STATUS_LABELS = Object.freeze({
  [TOOL_RECT]: "Rectangle tool",
  [TOOL_FIND]: "Find tool",
  [TOOL_POINTER]: "Pointer tool",
  [TOOL_COMMENT]: "Comment tool",
  [TOOL_EDIT]: "Edit tool",
  [TOOL_DUPLICATE]: "Duplicate tool",
});

/** Tools whose buttons and hotkeys need canvas edit rights. */
export const EDIT_ONLY_TOOLS = Object.freeze([TOOL_RECT, TOOL_EDIT, TOOL_DUPLICATE]);

/** Toolbar button id per tool, in the order the buttons sit in the sidebar. */
export const TOOL_BUTTON_IDS = Object.freeze({
  [TOOL_RECT]: "toolRect",
  [TOOL_FIND]: "toolFind",
  [TOOL_POINTER]: "toolMove",
  [TOOL_EDIT]: "toolEdit",
  [TOOL_DUPLICATE]: "toolDuplicate",
  [TOOL_COMMENT]: "toolComment",
});

/**
 * Which toolbar button reads as active, by button id.
 *
 * Holding Alt with the pointer selected hands the active look to Duplicate,
 * because that is the drag Alt produces; releasing it hands it back to the
 * pointer. The selected tool itself never changes, so picking Duplicate outright
 * still keeps it lit with Alt up.
 */
export function toolButtonActiveStates(selectedTool, altKeyHeld = false) {
  const highlighted = selectedTool === TOOL_POINTER && altKeyHeld ? TOOL_DUPLICATE : selectedTool;
  const states = {};
  for (const [tool, buttonId] of Object.entries(TOOL_BUTTON_IDS)) {
    states[buttonId] = highlighted === tool;
  }
  return states;
}

/** Drag distance, in world units, above which a rectangle is a box and not a click. */
export const DRAW_RECT_MIN_SIZE = 12;

/** Clamp the rectangle to the image under it and open the edit dialog. */
export const DRAW_RECT_EDIT_IMAGE = "edit-image";
/** Turn the rectangle into a new prompt node. */
export const DRAW_RECT_PROMPT = "prompt";
/** Drop a default-sized prompt node where the click landed. */
export const DRAW_RECT_CLICK_PROMPT = "click-prompt";
export const DRAW_RECT_NOTHING = "nothing";

/**
 * What a finished `draw-rect` drag should do.
 *
 * `majorityImageId` is the image the rectangle mostly covers, `targetImageId` the
 * one it is currently attached to, and `imagesOnly` marks an edit-tool drag:
 * those may only ever become an image edit, so a rectangle that misses every
 * image does nothing instead of leaving a stray prompt node behind.
 */
export function drawRectOutcome({
  width = 0,
  height = 0,
  majorityImageId = "",
  targetImageId = "",
  imagesOnly = false,
} = {}) {
  if (width > DRAW_RECT_MIN_SIZE && height > DRAW_RECT_MIN_SIZE) {
    if (majorityImageId) return DRAW_RECT_EDIT_IMAGE;
    return imagesOnly ? DRAW_RECT_NOTHING : DRAW_RECT_PROMPT;
  }
  if (targetImageId || imagesOnly) return DRAW_RECT_NOTHING;
  return DRAW_RECT_CLICK_PROMPT;
}

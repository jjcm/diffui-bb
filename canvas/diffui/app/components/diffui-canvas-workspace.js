import initCanvasWasm, { CanvasEngine, snap_dimension } from "../wasm/diffui_canvas.js";
import { displayUrlForGenerationFileUrl } from "../../image-urls.js";
import { clampPromptText, MAX_PROMPT_LENGTH } from "../../prompt-limits.js";
import { reportError } from "../../error-reporter.js";
import { reconnectDelay, looksLikeAuthClose, isSessionValid, notifySessionExpired } from "../../watch-reconnect.js";
import { abandonedGenerationRequests, reconcileCommittedGenerationImages, remoteCanvasAdditions, withoutFailedGenerationSlots } from "./canvas-generation-reconcile.js";
import { NextPagePlaceholderCycle, NEXT_PAGE_PLACEHOLDER_SUGGESTION_COUNT, normalizeNextPageSuggestions } from "./canvas-next-page-placeholder.js";
import { CANVAS_COACH_PROMPT_EXAMPLES } from "./canvas-coach-steps.js";
import { PASTE_ANALYZING_NAME, pendingUploadMetadata, uploadedAssetNodeUpdate, withoutPendingUploadNodes } from "./canvas-paste-node.js";
import { affordableOptionCount } from "./canvas-generation-affordability.js";
import { coalescedGeneration, shouldAutoGenerateClickPrompt } from "./canvas-generate-single-flight.js";
import { CANVAS_SAVE_ATTEMPTS, CanvasSaveQueue, canvasSaveRetryDelayMs } from "./canvas-save-queue.js";
import { getCurrentUser, isWalletBillingError, notifyInsufficientCredits } from "../../wallet.js";
import "./diffui-inpaint-prompt.js";
import "./diffui-prompt-suggestions.js";
import "./diffui-canvas-comment.js";
import "./diffui-button.js";
import "./diffui-canvas-tool-tooltip.js";
import { CANVAS_TOOL_TOOLTIPS, ToolTooltipScheduler } from "./canvas-tool-tooltips.js";
import { canvasDrawPalette, canvasThemeFromRoot, resolveCanvasDrawPalette } from "./canvas-draw-palette.js";
import { trackUIClick, UI_TELEMETRY_EVENTS } from "../../ui-telemetry.js";
import {
  DRAW_RECT_CLICK_PROMPT,
  DRAW_RECT_EDIT_IMAGE,
  DRAW_RECT_NOTHING,
  DRAW_RECT_PROMPT,
  drawRectOutcome,
  EDIT_ONLY_TOOLS,
  TOOL_COMMENT,
  TOOL_DUPLICATE,
  TOOL_EDIT,
  TOOL_FIND,
  TOOL_POINTER,
  TOOL_RECT,
  TOOL_STATUS_LABELS,
  toolButtonActiveStates,
} from "./canvas-tool-state.js";
import { embedFetchHeaders, resolveEmbedApiUrl, resolveEmbedAssetUrl } from "../../embed-bridge.js";
import {
  isPublicShareViewer,
  publicShareFetchHeaders,
  publicShareTokenFromLocation,
  withPublicShareParam,
} from "../../share-viewer.js";
import { CanvasCRDT } from "../collab/canvas-crdt.js";
import { CanvasCollabProvider } from "../collab/canvas-collab-provider.js";
import {
  collabColorFromId,
  getOrCreateClientCollabColor,
  resolveCollabColor,
} from "../collab/collab-colors.js";
import { drawCollabCursor, drawCollabCursorLabel, drawCollabChatBubble } from "../collab/collab-cursor.js";
import { buildClickEffectAwareness, readClickEffectAwareness } from "../collab/collab-click-effect.js";

/** Breathing room between a tool button and its tooltip beak. */
const TOOL_TOOLTIP_GAP_PX = 8;
const DEFAULT_PROMPT_WIDTH = 1440;
const DEFAULT_PROMPT_HEIGHT = 1024;
const MAX_PROMPT_DIMENSION = 2048;
const MAX_GENERATION_ASPECT_RATIO = 3;
const MIN_GENERATION_PIXELS = 655360;
const GENERATED_IMAGE_DIMENSION_MULTIPLE = 16;
const DIFFUI_CLIPBOARD_MARKER = "diffui:image-node";
const DIFFUI_CLIPBOARD_MIME = "web application/x-diffui-image-node";
const DEFAULT_EDGE_INPUT_FACETS = Object.freeze({
  pixels: true,
  subjects: true,
  composition: true,
  style: true,
  theme: true,
  palette: true,
});
const EDGE_INPUT_FACET_KEYS = Object.freeze(Object.keys(DEFAULT_EDGE_INPUT_FACETS));
const PROMPT_BRAND_RANDOMIZE = "__randomize__";
const PROMPT_BRAND_RANDOMIZE_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><polyline points="16 3 21 3 21 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="4" y1="20" x2="21" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="21 16 21 21 16 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="15" y1="15" x2="21" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="4" y1="4" x2="9" y2="9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CANVAS_POINTER_CURSOR_URL = "/app/assets/canvas-cursor-pointer.png";
/** Onboarding coach demos are drawn as a half-visible ghost of the real gesture. */
const CANVAS_COACH_DEMO_ALPHA = 0.5;
/** Empty canvas the coach pans into view past an output handle, for the fork demo to drag into. */
const CANVAS_COACH_FORK_LANE_PX = 320;
const COLLAB_TAB_INACTIVITY_MS = 5 * 60 * 1000;
const CANVAS_POINTER_CURSOR_HOTSPOT = { x: 9, y: 9 };
const CURSOR_CHAT_MAX_LEN = 280;
const CURSOR_CHAT_POSTED_TTL_MS = 5000;
const CURSOR_CHAT_FADE_MS = 1500;
/** Generator prices only change from Admin, so a short cache keeps the clamp off the click path. */
const OPTION_PRICE_TTL_MS = 5 * 60 * 1000;
const canvasPointerCursorImage = new Image();
canvasPointerCursorImage.src = resolveEmbedAssetUrl(CANVAS_POINTER_CURSOR_URL);
canvasPointerCursorImage.addEventListener("load", () => {
  document.querySelectorAll("diffui-canvas-workspace").forEach((el) => {
    if (typeof el._draw === "function") el._draw();
  });
});
const PROMPT_RESOLUTION_GROUPS = [
  {
    heading: "UI",
    sections: [
      {
        heading: "Web UI",
        icon: "desktop",
        options: [
          { label: "Landscape", icon: "desktop", width: 2048, height: 1440 },
          { label: "Portrait", icon: "laptop", width: 1440, height: 2048 },
          { label: "Tablet Portrait", icon: "tablet", width: 1536, height: 2048 },
          { label: "Tablet Landscape", icon: "tablet-landscape", width: 2048, height: 1536 },
        ],
      },
      {
        heading: "Mobile UI",
        icon: "phone",
        options: [
          { label: "Mobile Portrait", icon: "phone", width: 1152, height: 2048 },
          { label: "Mobile Landscape", icon: "phone-landscape", width: 2048, height: 1152 },
        ],
      },
    ],
  },
  {
    heading: "Ads",
    icon: "ads",
    options: [
      { label: "X Post", icon: "x", aspect: "16:9", width: 2048, height: 1152 },
      { label: "LinkedIn Post", icon: "linkedin", aspect: "1:1", width: 1440, height: 1440 },
      { label: "Instagram Story", icon: "instagram", aspect: "9:16", width: 1152, height: 2048 },
      { label: "Instagram Post", icon: "instagram", aspect: "1:1", width: 1440, height: 1440 },
      { label: "Instagram Portrait", icon: "instagram", aspect: "4:5", width: 1440, height: 1800 },
      { label: "Facebook Video", icon: "facebook", aspect: "9:16", width: 1152, height: 2048 },
      { label: "Facebook Post", icon: "facebook", aspect: "1:1", width: 1440, height: 1440 },
      { label: "YouTube Thumb", icon: "youtube", aspect: "16:9", width: 2048, height: 1152 },
    ],
  },
  {
    heading: "Aspect Ratios",
    icon: "ratio-square",
    options: [
      { label: "Tall Portrait", icon: "ratio-9-16", aspect: "9:16", width: 1152, height: 2048 },
      { label: "Portrait", icon: "ratio-4-5", aspect: "4:5", width: 1440, height: 1800 },
      { label: "Square", icon: "ratio-square", aspect: "1:1", width: 1440, height: 1440 },
      { label: "Boxy Landscape", icon: "ratio-4-3", aspect: "4:3", width: 2048, height: 1536 },
      { label: "Landscape", icon: "ratio-5-4", aspect: "5:4", width: 1800, height: 1440 },
      { label: "Wide Landscape", icon: "ratio-16-9", aspect: "16:9", width: 2048, height: 1152 },
    ],
    custom: true,
  },
];
const PROMPT_INPUT_HIT_RADIUS = 34;
const PROMPT_INPUT_PLACEMENT_CLEARANCE_PX = 20;
const PROMPT_INPUT_PROMPT_GAP_PX = 80;
const MIN_PROMPT_SUGGESTION_SCREEN_WIDTH = 350;
/** Vertical gap between stacked inputs; must exceed 2× clearance so padded overlap checks don't reject sibling slots. */
const PROMPT_INPUT_STACK_VERTICAL_GAP_PX = 2 * PROMPT_INPUT_PLACEMENT_CLEARANCE_PX + 8;
const MIN_UI_SCREEN_WIDTH = 200;
const MIN_UI_SCREEN_HEIGHT = 100;
const CANVAS_CONTAINER_RADIUS = 2;
const NODE_IMAGE_RADIUS = 11;
const NODE_LEFT_CONNECTOR_WIDTH = 11;
const NODE_RIGHT_CONNECTOR_WIDTH = 11;
const NODE_HEADER_HEIGHT = 32;
const NODE_OUT_HANDLE_HEIGHT = 60;
const NODE_IN_HANDLE_HEIGHT = 60;
/** Cap for cubic noodle handles (screen px). Long connections keep this look. */
const NOODLE_HANDLE_MAX_PX = 80;
/** Filled cap at each noodle endpoint (screen px). Drawn under the IO handles. */
const NOODLE_END_RADIUS_PX = 2;
/** Handle length as a fraction of endpoint distance, so close nodes do not bulge. */
const NOODLE_HANDLE_DIST_FACTOR = 0.45;
const NODE_STAGE_GAP = 14;
const STACK_LAYER_OFFSET = 18;
const MAX_NODE_IMAGES = 20;
const CANVAS_NODE_CHAIN_GAP = 200;
const CLICK_EFFECT_THUMBNAIL = "thumbnail";
const CLICK_EFFECT_THUMBNAIL_DURATION = 940;
const MIN_VIEWPORT_SCALE = 0.08;
const MAX_VIEWPORT_SCALE = 6;
/** Screen inset from canvas edges when fitting a world rect into the viewport (all sides). */
const VIEWPORT_FIT_MARGIN_PX = 20;
/** Extra breathing room around the seed prompt on a fresh blank canvas. */
const INITIAL_VIEWPORT_FIT_MARGIN_PX = 56;
const WHEEL_DELTA_LINE_MODE = 1;
const WHEEL_DELTA_PAGE_MODE = 2;
const WHEEL_LINE_HEIGHT = 16;
const WHEEL_PAGE_HEIGHT = 800;
const WHEEL_ZOOM_INTENSITY = 0.0018;
const TRACKPAD_PINCH_ZOOM_MULTIPLIER = 6;
const MAX_WHEEL_ZOOM_DELTA = 120;
const MOVE_SNAP_SCREEN_THRESHOLD = 8;
const ALT_DUPLICATE_DRAG_THRESHOLD_PX = 5;
const RESIZE_ASPECT_SNAP_SCREEN_THRESHOLD = 10;
const RESIZE_RESOLUTION_SNAP_SCREEN_THRESHOLD = 18;
const RESIZE_ASPECT_GUIDES = [
  { label: "2:1", width: 2, height: 1 },
  { label: "16:9", width: 16, height: 9 },
  { label: "4:3", width: 4, height: 3 },
  { label: "1:1", width: 1, height: 1 },
  { label: "3:4", width: 3, height: 4 },
  { label: "9:16", width: 9, height: 16 },
  { label: "1:2", width: 1, height: 2 },
];
const RESIZE_ASPECT_RESOLUTIONS = {
  "2:1": ["1600x800", "2048x1024"],
  "16:9": ["1536x864", "2048x1152"],
  "4:3": ["1408x1056", "1600x1200", "2048x1536"],
  "1:1": ["1024x1024", "1440x1440", "2048x2048"],
  "3:4": ["1056x1408", "1200x1600", "1536x2048"],
  "9:16": ["864x1536", "1152x2048"],
  "1:2": ["800x1600", "1024x2048"],
};
const PROMPT_SUGGESTION_COUNT = 3;
const PROMPT_PLACEHOLDER_DEFAULT = "Describe the UI you want...";
/**
 * A prompt node forked off an image keeps the default placeholder for at least
 * this long, so a fast suggestions response does not yank the copy away before
 * anyone has read it.
 */
const NEXT_PAGE_PLACEHOLDER_MIN_HOLD_MS = 500;
/** Used when the multimodal next-page endpoint is empty or unreachable so a
 *  freshly forked prompt still gets a typewriter cycle to read. */
const NEXT_PAGE_PLACEHOLDER_FALLBACKS = Object.freeze([
  "A pricing page for this product",
  "An about page in the same style",
  "A features page that expands on this screen",
  "A blog index that matches this brand",
  "A contact page with a simple form",
]);
const WEBSITE_PROMPT_STARTERS = [
  {
    label: "Museum Launch",
    prompt: "Create a homepage for a new contemporary art museum. It should feel editorial, spacious, and culturally confident. It should feature exhibition previews.",
  },
  {
    label: "Solar Homes",
    prompt: "Create a website for a residential solar installer. It should feel bright, practical, and trustworthy. It should feature a savings calculator.",
  },
  {
    label: "Indie Bakery",
    prompt: "Create a warm website for an independent neighborhood bakery. It should feel handmade, inviting, and polished enough for online ordering. It should feature daily specials.",
  },
  {
    label: "Architecture Studio",
    prompt: "Create a portfolio website for a residential architecture studio. It should feel minimalist, image-led, and quietly premium. It should feature project case studies.",
  },
  {
    label: "Climate Journal",
    prompt: "Create an editorial website for a climate research journal. It should feel serious, readable, and modern. It should feature data explainers.",
  },
  {
    label: "Ceramic Shop",
    prompt: "Create an ecommerce website for a small ceramic homeware brand. It should feel calm, tactile, and elegant. It should feature product collections.",
  },
  {
    label: "Jazz Festival",
    prompt: "Create a website for a city jazz festival. It should feel expressive, rhythmic, and easy to scan. It should feature the festival lineup.",
  },
  {
    label: "Trail Lodge",
    prompt: "Create a booking website for a mountain trail lodge. It should feel grounded, outdoorsy, and atmospheric. It should feature guided hikes.",
  },
  {
    label: "Legal Collective",
    prompt: "Create a website for a public-interest legal collective. It should feel humane, clear, and trustworthy. It should feature intake guidance.",
  },
  {
    label: "Fashion Archive",
    prompt: "Create a browsing website for an online fashion archive. It should feel archival, elegant, and contemporary. It should feature designer timelines.",
  },
  {
    label: "Tablet Auction",
    prompt: "Create a cyberpunk auction site listing for a tablet. It should feel futuristic, microglyphic, and sleek. It should feature a bid button.",
  },
  {
    label: "Hotel Room",
    prompt: "Create a booking detail page for a boutique hotel room. It should feel serene, polished, and quietly luxurious. It should feature room availability.",
  },
  {
    label: "Album Release",
    prompt: "Create a landing page for an experimental musician's new album. It should feel moody, immersive, and cinematic. It should feature a track preview.",
  },
  {
    label: "Chef Profile",
    prompt: "Create a chef profile page for a farm-to-table restaurant. It should feel earthy, refined, and personal. It should feature signature dishes.",
  },
  {
    label: "Gallery Exhibit",
    prompt: "Create an exhibit detail page for a photography gallery. It should feel minimal, focused, and museum-grade. It should feature artist notes.",
  },
  {
    label: "Bike Product",
    prompt: "Create a product detail page for an electric cargo bike. It should feel practical, durable, and modern. It should feature range specs.",
  },
  {
    label: "Conference Schedule",
    prompt: "Create a schedule page for an AI policy conference. It should feel organized, intelligent, and civic. It should feature session filters.",
  },
  {
    label: "Wine Club",
    prompt: "Create a membership page for a natural wine club. It should feel organic, tasteful, and convivial. It should feature subscription tiers.",
  },
  {
    label: "Book Essay",
    prompt: "Create an essay page for an independent literary magazine. It should feel thoughtful, typographic, and quietly dramatic. It should feature pull quotes.",
  },
  {
    label: "Rental Listing",
    prompt: "Create a property listing page for a desert vacation rental. It should feel sunlit, architectural, and calm. It should feature booking dates.",
  },
  {
    label: "Spa Services",
    prompt: "Create a services page for a mineral spa. It should feel restorative, quiet, and refined. It should feature treatment packages.",
  },
  {
    label: "Watch Drop",
    prompt: "Create a product launch page for a limited-run mechanical watch. It should feel precise, collectible, and cinematic. It should feature a waitlist button.",
  },
  {
    label: "Record Store",
    prompt: "Create a browsing website for an independent record store. It should feel analog, energetic, and curated. It should feature staff picks.",
  },
  {
    label: "Theater Tickets",
    prompt: "Create a seating selection page for a historic theater. It should feel dramatic, elegant, and easy to understand. It should feature seat availability.",
  },
  {
    label: "Coffee Roaster",
    prompt: "Create a subscription page for a small-batch coffee roaster. It should feel warm, aromatic, and craft-focused. It should feature roast preferences.",
  },
  {
    label: "Wedding Venue",
    prompt: "Create a venue detail page for a countryside wedding barn. It should feel romantic, airy, and polished. It should feature package pricing.",
  },
  {
    label: "Design Conference",
    prompt: "Create a speaker lineup page for a design conference. It should feel bold, cultural, and highly organized. It should feature speaker cards.",
  },
  {
    label: "Fitness Class",
    prompt: "Create a class detail page for a boutique fitness studio. It should feel kinetic, clean, and motivating. It should feature a reserve button.",
  },
  {
    label: "Antique Listing",
    prompt: "Create a marketplace listing page for an antique writing desk. It should feel storied, tactile, and trustworthy. It should feature provenance notes.",
  },
  {
    label: "Film Festival",
    prompt: "Create a film detail page for an independent film festival. It should feel cinematic, selective, and immersive. It should feature screening times.",
  },
  {
    label: "Flower Delivery",
    prompt: "Create a checkout page for a local flower delivery website. It should feel fresh, graceful, and reassuring. It should feature delivery date selection.",
  },
  {
    label: "Surf Camp",
    prompt: "Create a trip detail page for a coastal surf camp. It should feel sunlit, adventurous, and relaxed. It should feature weekly itineraries.",
  },
  {
    label: "Robotics Lab",
    prompt: "Create a research project page for a university robotics lab. It should feel technical, precise, and academic. It should feature project milestones.",
  },
  {
    label: "Sneaker Raffle",
    prompt: "Create a raffle entry page for a limited sneaker release. It should feel streetwise, crisp, and high-energy. It should feature an enter raffle button.",
  },
  {
    label: "Recipe Page",
    prompt: "Create a recipe detail page for a seasonal cooking website. It should feel generous, practical, and appetizing. It should feature step-by-step instructions.",
  },
  {
    label: "Donor Campaign",
    prompt: "Create a donation page for a public library campaign. It should feel civic, hopeful, and transparent. It should feature donation tiers.",
  },
  {
    label: "Wellness Retreat",
    prompt: "Create a retreat itinerary page for a desert wellness weekend. It should feel calm, spacious, and elemental. It should feature the daily schedule.",
  },
  {
    label: "Furniture Product",
    prompt: "Create a product detail page for a modular sofa. It should feel tactile, domestic, and modern. It should feature fabric swatches.",
  },
  {
    label: "Artist Shop",
    prompt: "Create a print shop page for an independent illustrator. It should feel playful, personal, and collectible. It should feature edition sizes.",
  },
  {
    label: "Brewery Tour",
    prompt: "Create a booking page for a neighborhood brewery tour. It should feel friendly, local, and lively. It should feature tour times.",
  },
  {
    label: "Course Catalog",
    prompt: "Create a course catalog page for a creative writing school. It should feel literary, organized, and welcoming. It should feature course filters.",
  },
  {
    label: "Skincare Routine",
    prompt: "Create a routine builder page for a botanical skincare brand. It should feel clean, gentle, and premium. It should feature skin type selection.",
  },
  {
    label: "Podcast Episode",
    prompt: "Create an episode page for an investigative podcast. It should feel immersive, journalistic, and tense. It should feature an audio player.",
  },
  {
    label: "Vintage Camera",
    prompt: "Create a product listing page for a vintage film camera. It should feel archival, precise, and collector-friendly. It should feature condition details.",
  },
  {
    label: "Ski Pass",
    prompt: "Create a pass comparison page for a mountain ski resort. It should feel crisp, alpine, and easy to compare. It should feature pass tiers.",
  },
  {
    label: "Garden Guide",
    prompt: "Create a planting guide page for an urban gardening website. It should feel fresh, instructive, and cheerful. It should feature seasonal tips.",
  },
  {
    label: "Charity Impact",
    prompt: "Create an impact report page for a clean water nonprofit. It should feel transparent, human, and optimistic. It should feature impact metrics.",
  },
  {
    label: "Craft Market",
    prompt: "Create a vendor directory page for a weekend craft market. It should feel handmade, bright, and easy to browse. It should feature category filters.",
  },
  {
    label: "Perfume Product",
    prompt: "Create a product detail page for a niche perfume. It should feel sensual, mysterious, and elegant. It should feature scent notes.",
  },
  {
    label: "Museum Tickets",
    prompt: "Create a ticket selection page for a science museum. It should feel clear, family-friendly, and efficient. It should feature admission times.",
  },
  {
    label: "Startup Careers",
    prompt: "Create a careers page for a robotics startup. It should feel ambitious, technical, and human. It should feature open roles.",
  },
  {
    label: "Yoga Schedule",
    prompt: "Create a class schedule page for a neighborhood yoga studio. It should feel calm, balanced, and approachable. It should feature instructor filters.",
  },
  {
    label: "Book Product",
    prompt: "Create a product page for a new hardcover cookbook. It should feel rich, editorial, and appetizing. It should feature sample recipes.",
  },
  {
    label: "Art Auction",
    prompt: "Create an auction lot page for a contemporary sculpture. It should feel gallery-grade, precise, and exclusive. It should feature bidding history.",
  },
  {
    label: "Pet Adoption",
    prompt: "Create an adoption profile page for an animal shelter. It should feel warm, caring, and easy to act on. It should feature adoption requirements.",
  },
  {
    label: "Newsletter Archive",
    prompt: "Create an archive page for a strategy newsletter. It should feel sharp, readable, and subscription-worthy. It should feature topic tags.",
  },
  {
    label: "Restaurant Menu",
    prompt: "Create a menu page for a modern coastal restaurant. It should feel fresh, refined, and relaxed. It should feature seasonal dishes.",
  },
  {
    label: "Travel Guide",
    prompt: "Create a city guide page for independent travelers. It should feel editorial, useful, and locally informed. It should feature neighborhood sections.",
  },
  {
    label: "Hardware Docs",
    prompt: "Create a documentation landing page for an open-source hardware kit. It should feel technical, clean, and approachable. It should feature setup steps.",
  },
  {
    label: "Gallery Shop",
    prompt: "Create a gift shop category page for a design museum. It should feel curated, clever, and refined. It should feature product filters.",
  },
  {
    label: "Marathon Signup",
    prompt: "Create a registration page for a city marathon. It should feel energetic, civic, and clear. It should feature race categories.",
  },
  {
    label: "Watch Repair",
    prompt: "Create a service detail page for a watch repair atelier. It should feel meticulous, heritage-rich, and trustworthy. It should feature repair estimates.",
  },
  {
    label: "Kids Workshop",
    prompt: "Create a workshop detail page for a children's art studio. It should feel bright, playful, and parent-friendly. It should feature age ranges.",
  },
  {
    label: "Cyber Course",
    prompt: "Create a lesson page for a cybersecurity training website. It should feel focused, technical, and high-contrast. It should feature a progress marker.",
  },
  {
    label: "Observatory Visit",
    prompt: "Create a visit planning page for a public observatory. It should feel cosmic, educational, and clear. It should feature viewing times.",
  },
  {
    label: "Tailor Booking",
    prompt: "Create an appointment page for a bespoke tailor. It should feel precise, elegant, and personal. It should feature fitting options.",
  },
  {
    label: "Music Venue",
    prompt: "Create an event listing page for an underground music venue. It should feel nocturnal, gritty, and kinetic. It should feature ticket status.",
  },
  {
    label: "Farm CSA",
    prompt: "Create a signup page for a community-supported farm share. It should feel earthy, seasonal, and friendly. It should feature box sizes.",
  },
  {
    label: "Game Guide",
    prompt: "Create a strategy guide page for a fantasy tabletop game. It should feel illustrated, tactical, and immersive. It should feature character builds.",
  },
  {
    label: "Clinic Service",
    prompt: "Create a service detail page for a neighborhood health clinic. It should feel calm, accessible, and reassuring. It should feature appointment booking.",
  },
];

const template = document.createElement("template");
template.innerHTML = `
  <style>
    :host([data-embed="true"]) {
      height: 100vh;
    }
    :host {
      display: block;
      height: calc(100vh - 44px);
      min-height: 0;
      /* Editor chrome follows the app theme through the --canvas-* tokens in
         styles.css. Nothing in here may hardcode a white or black rgba: the same
         rule has to read on the dark plane and on the light one. */
      background: var(--canvas-shell);
      color: var(--text);
      font-family: var(--font);
      outline: 0;
      /* bb: the sprites ship inside this copy of the canvas, so they paint from
         the bundle instead of being fetched from whatever origin serves the
         page. This block is inside a template literal, and resolveEmbedAssetUrl
         answers with the bundled data URL. */
      --canvas-cursor-default: image-set(url("${resolveEmbedAssetUrl("/app/assets/canvas-cursor-pointer.png")}") 2x) 9 9, default;
      --canvas-cursor-duplicate: image-set(url("${resolveEmbedAssetUrl("/app/assets/canvas-cursor-duplicate.png")}") 2x) 9 9, ew-resize;
      --canvas-cursor-comment: image-set(url("${resolveEmbedAssetUrl("/app/assets/comment-cursor.png")}") 2x) 2 2, copy;
    }
    .workspace {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    .canvasFrame {
      position: absolute;
      inset: 12px 12px 12px 45px;
      width: calc(100% - 57px);
      height: calc(100% - 24px);
      border-radius: 11px;
      overflow: hidden;
      background: var(--canvas-plane);
      box-shadow: var(--canvas-frame-shadow);
      z-index: 2;
    }
    #canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      cursor: crosshair;
      background: var(--canvas-plane);
      border-radius: inherit;
    }
    :host([data-tool="pointer"]) #canvas {
      cursor: var(--canvas-cursor-default);
    }
    :host([data-tool="comment"]) #canvas {
      cursor: var(--canvas-cursor-comment);
    }
    :host([data-tool="comment"]) .promptBox {
      cursor: var(--canvas-cursor-comment);
    }
    :host([data-tool="pointer"][data-alt-duplicate-hover="true"]) #canvas {
      cursor: var(--canvas-cursor-duplicate);
    }
    :host([data-space-pan="true"]) #canvas {
      cursor: grab;
    }
    :host([data-panning="true"]) #canvas {
      cursor: grabbing;
    }
    .leftTools {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 44px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 12px 0;
      z-index: 4;
    }
    /* The tool buttons form their own hover group: the tooltip only hides once
       the pointer leaves this cluster, not when it crosses between buttons. */
    .toolCluster {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }
    .leftTools .toolBtn#toolFileSettings {
      margin-top: auto;
    }
    .toolBtn,
    .findBox button {
      font: inherit;
      border: 1px solid var(--canvas-rim);
      color: var(--text);
      background: var(--canvas-fill);
      cursor: pointer;
    }
    :where(.promptBox) button {
      font: inherit;
      border: 0;
      color: var(--text);
      background: transparent;
      cursor: pointer;
    }
    .toolBtn {
      width: 34px;
      height: 34px;
      display: inline-grid;
      place-items: center;
      border-radius: 1px;
      padding: 0;
      background: transparent;
      border-color: transparent;
      color: var(--canvas-text-soft);
    }
    .toolBtn svg {
      display: block;
    }
    .toolBtn[data-active="true"] {
      background: var(--canvas-active-wash);
      border-color: var(--canvas-active-rim);
      color: var(--canvas-active-text);
    }
    .toolBtn:hover {
      background: var(--canvas-fill-hover);
      border-color: var(--canvas-rim);
      color: var(--canvas-text-strong);
    }
    .inspector[hidden],
    .findBox[hidden] {
      display: none;
    }
    /* .toolBtn sets display, which would otherwise beat the UA rule for [hidden]
       and leave edit tools on screen for view-only and anonymous viewers. */
    .toolBtn[hidden] {
      display: none;
    }
    .promptLayer {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 5;
    }
    .commentLayer {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 8;
    }
    .commentComposer {
      position: absolute;
      left: 0;
      top: 0;
      z-index: 21;
      width: min(280px, calc(100% - 32px));
      pointer-events: auto;
      display: none;
      padding: 8px;
      border: 1px solid var(--canvas-rim);
      border-radius: 8px;
      background: var(--canvas-panel);
      box-shadow: var(--canvas-shadow-pop);
      backdrop-filter: blur(10px);
    }
    .commentComposer[data-open="true"] {
      display: grid;
      gap: 7px;
    }
    .commentComposer::before {
      content: "";
      position: absolute;
      left: -8px;
      top: 12px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--canvas-accent);
      box-shadow: 0 0 0 1px var(--canvas-pin-ring), var(--canvas-drop-shadow);
    }
    .commentComposer textarea {
      box-sizing: border-box;
      width: 100%;
      min-height: 74px;
      max-height: 150px;
      resize: vertical;
      border: 1px solid var(--canvas-rim);
      border-radius: 6px;
      background: var(--canvas-fill-hover);
      color: var(--canvas-text-strong);
      outline: 0;
      padding: 8px 9px;
      font: 12px/1.35 var(--font);
    }
    .commentComposer textarea:focus {
      border-color: var(--canvas-accent-line);
    }
    .commentComposerActions {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
    }
    .commentComposerActions diffui-button {
      --height: 26px;
      --padding-x: 8px;
    }
    .collabCursorCanvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      pointer-events: none;
      z-index: 6;
      background: transparent;
      border-radius: inherit;
    }
    .selectionLayer {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 6;
    }
    .effectCanvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      pointer-events: none;
      z-index: 6;
      background: transparent;
      border-radius: inherit;
    }
    .selectionRect {
      position: absolute;
      box-sizing: border-box;
      pointer-events: none;
    }
    .selectionRect[data-kind="outer"] {
      border: 1px dashed var(--canvas-accent);
      background: var(--canvas-accent-wash-soft);
    }
    .selectionRect[data-kind="outer"][data-target="image"] {
      border-color: var(--canvas-select);
      background: var(--canvas-select-wash);
    }
    .selectionRect[data-kind="inner"] {
      border: 2px solid var(--canvas-select);
      background: var(--canvas-select-wash-soft);
    }
    .selectionRect[data-kind="prompt-preview"] {
      border: 2px solid var(--canvas-accent);
      background: var(--canvas-accent-wash-soft);
    }
    .collabRectLayer {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 4;
    }
    .selectionRect.collabPeerRect {
      pointer-events: none;
    }
    .selectionRect.collabPeerRect[data-kind="outer"] {
      border: 1px dashed var(--peer-color, var(--canvas-accent));
      background: var(--canvas-accent-wash-soft);
    }
    .selectionRect.collabPeerRect[data-kind="outer"][data-target="image"] {
      background: var(--canvas-select-wash);
    }
    .selectionRect.collabPeerRect[data-kind="inner"] {
      border: 2px solid var(--peer-color, var(--canvas-select));
      background: var(--canvas-select-wash-soft);
    }
    .selectionRect.collabPeerRect[data-kind="prompt-preview"] {
      border: 2px dashed var(--peer-color, var(--canvas-accent));
      background: var(--canvas-accent-wash-soft);
    }
    .selectionRect.collabPeerRect[data-kind="inpaint-crop"] {
      border: 2px dashed var(--peer-color, var(--canvas-select));
      background: var(--canvas-select-wash-soft);
      box-shadow: 0 0 0 1px var(--canvas-rim-strong);
    }
    .selectionDim {
      position: absolute;
      pointer-events: none;
      background: var(--canvas-scrim);
      backdrop-filter: saturate(0.85);
    }
    .selectionDimSvg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: visible;
    }
    .selectionDimSvg path {
      fill: var(--canvas-scrim);
    }
    .selectionShell {
      position: absolute;
      box-sizing: border-box;
      pointer-events: none;
    }
    .selectionShell .selectionRect[data-kind="inpaint"] {
      inset: 0;
      width: 100%;
      height: 100%;
    }
    .selectionRect[data-kind="inpaint"] {
      border: 1px dashed var(--canvas-select);
      background: var(--canvas-select-wash-soft);
      box-shadow: 0 0 0 1px var(--canvas-rim-strong), 0 0 22px var(--canvas-select-glow);
    }
    .selectionHandle {
      position: absolute;
      width: 9px;
      height: 9px;
      box-sizing: border-box;
      border: 1px solid var(--canvas-select-ring);
      background: var(--canvas-select);
      box-shadow: var(--canvas-shadow-marker);
      pointer-events: auto;
    }
    .selectionShell[data-generating="true"] .selectionHandle,
    .selectionShell[data-generating="true"] .selectionEdge {
      display: none !important;
      pointer-events: none !important;
    }
    .selectionEdge {
      position: absolute;
      pointer-events: auto;
      background: transparent;
    }
    .selectionEdge[data-handle="n"],
    .selectionEdge[data-handle="s"] {
      left: 0;
      right: 0;
      height: 10px;
      transform: translateY(-50%);
      cursor: ns-resize;
    }
    .selectionEdge[data-handle="n"] {
      top: 0;
    }
    .selectionEdge[data-handle="s"] {
      bottom: 0;
      transform: translateY(50%);
    }
    .selectionEdge[data-handle="e"],
    .selectionEdge[data-handle="w"] {
      top: 0;
      bottom: 0;
      width: 10px;
      transform: translateX(-50%);
      cursor: ew-resize;
    }
    .selectionEdge[data-handle="e"] {
      right: 0;
      transform: translateX(50%);
    }
    .selectionEdge[data-handle="w"] {
      left: 0;
    }
    .selectionHandle[data-handle="nw"],
    .selectionHandle[data-handle="ne"] {
      top: 0;
    }
    .selectionHandle[data-handle="se"],
    .selectionHandle[data-handle="sw"] {
      top: 100%;
    }
    .selectionHandle[data-handle="nw"],
    .selectionHandle[data-handle="sw"] {
      left: 0;
    }
    .selectionHandle[data-handle="ne"],
    .selectionHandle[data-handle="se"] {
      left: 100%;
    }
    .selectionHandle[data-handle="nw"] {
      transform: translate(-4px, -4px);
    }
    .selectionHandle[data-handle="ne"] {
      transform: translate(-5px, -4px);
    }
    .selectionHandle[data-handle="se"] {
      transform: translate(-5px, -5px);
    }
    .selectionHandle[data-handle="sw"] {
      transform: translate(-4px, -5px);
    }
    .selectionHandle[data-handle="ne"],
    .selectionHandle[data-handle="sw"] {
      cursor: nesw-resize;
    }
    .selectionHandle[data-handle="nw"],
    .selectionHandle[data-handle="se"] {
      cursor: nwse-resize;
    }
    diffui-inpaint-prompt {
      position: absolute;
      z-index: 7;
    }
    .promptBox {
      position: absolute;
      top: 0;
      left: 0;
      will-change: transform;
      display: grid;
      grid-template-columns: var(--node-stage-width, 1fr);
      grid-template-rows: var(--node-stage-height, 1fr);
      pointer-events: auto;
      box-sizing: border-box;
      cursor: text;
    }
    :host([data-space-pan="true"]) .promptBox {
      pointer-events: none;
    }
    :host([data-tool="pointer"]) .promptBox {
      cursor: var(--canvas-cursor-default);
    }
    :host([data-tool="rect"]) .promptBox[data-has-image="true"],
    :host([data-tool="edit"]) .promptBox[data-has-image="true"] {
      cursor: crosshair;
    }
    .promptBox[data-analysis-processing="true"] {
      cursor: wait;
    }
    :host([data-tool="pointer"]) .promptBox[data-alt-duplicate-hover-target="true"] {
      cursor: var(--canvas-cursor-duplicate);
    }
    .nodeHeader {
      position: absolute;
      left: 0;
      bottom: calc(100% + 8px);
      display: flex;
      align-items: center;
      min-width: 0;
      width: var(--node-stage-width, 100%);
      height: var(--node-header-height, 16px);
      border: 1px solid transparent;
      border-radius: 2px 2px 0 0;
      background: transparent;
      box-shadow: none;
      box-sizing: border-box;
      transition: height 180ms ease, background 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
    }
    .promptBox[data-selected="true"] .nodeHeader {
      border-color: var(--canvas-active-rim);
      background: var(--canvas-active-wash);
      box-shadow: var(--canvas-active-shadow);
    }
    .nodeTitle {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 0 14px;
      color: var(--canvas-text);
      font-size: 13px;
      line-height: 1;
    }
    .nodeTitleInput {
      flex: 1;
      min-width: 0;
      box-sizing: border-box;
      height: 26px;
      margin: 0 64px 0 2px;
      padding: 0 12px;
      border: 1px solid var(--canvas-accent-line);
      border-radius: 0;
      outline: 0;
      background: var(--canvas-field);
      color: var(--canvas-text-strong);
      font: inherit;
      font-size: 13px;
      line-height: 1;
    }
    .nodeHeader[data-renaming="true"] .nodeHeaderActions {
      opacity: 0;
      pointer-events: none;
    }
    .nodeHeaderActions {
      display: flex;
      align-items: center;
      gap: 2px;
      padding-right: 4px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 120ms ease;
    }
    .promptBox[data-selected="true"] .nodeHeaderActions {
      opacity: 1;
      pointer-events: auto;
    }
    .promptBox[data-low-detail="true"] .nodeHeaderActions {
      display: none;
    }
    .promptBox[data-analysis-processing="true"] .nodeHeaderActions,
    .promptBox[data-analysis-processing="true"] .nodeOutput {
      display: none;
    }
    .nodeIconBtn {
      width: 24px;
      height: 24px;
      display: inline-grid;
      place-items: center;
      padding: 0;
      border: 0 !important;
      outline: 0 !important;
      border-radius: 6px;
      background: transparent !important;
      color: var(--canvas-text-soft);
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
    }
    .nodeIconBtn svg {
      width: 16px;
      height: 16px;
      stroke-width: 2;
    }
    .nodeIconBtn:hover {
      color: var(--canvas-text-strong);
      background: var(--canvas-fill-hover) !important;
    }
    .nodeIconBtn:active {
      background: var(--canvas-fill-active) !important;
    }
    .nodeIconBtn:focus,
    .nodeIconBtn:focus-visible {
      outline: 0;
    }
    .nodeResizeHandle {
      position: absolute;
      right: 28px;
      bottom: -6px;
      width: 14px;
      height: 14px;
      box-sizing: border-box;
      border: 0 solid var(--canvas-accent);
      border-right-width: 3px;
      border-bottom-width: 3px;
      border-radius: 0 0 14px 0;
      opacity: 0;
      pointer-events: none;
      cursor: nwse-resize;
      transition:
        right 100ms ease-out,
        bottom 100ms ease-out,
        width 100ms ease-out,
        height 100ms ease-out,
        border-width 100ms ease-in,
        border-radius 100ms ease,
        opacity 100ms ease;
    }
    .promptBox[data-selected="true"][data-has-image="false"] .nodeResizeHandle,
    .promptBox:hover[data-has-image="false"] .nodeResizeHandle {
      opacity: 0.5;
      pointer-events: auto;
    }
    .promptBox[data-selected="true"][data-has-image="false"] .nodeResizeHandle:hover,
    .promptBox:hover[data-has-image="false"] .nodeResizeHandle:hover {
      opacity: 0.9;
    }
    .promptBox[data-selected="true"][data-has-image="false"] .nodeResizeHandle:active,
    .promptBox:hover[data-has-image="false"] .nodeResizeHandle:active {
      opacity: 1;
    }
    .promptBox[data-generating="true"] .nodeResizeHandle {
      opacity: 0;
      pointer-events: none;
    }
    .promptBox[data-resize-target-snap="true"] .nodeResizeHandle {
      right: 29px;
      bottom: -5px;
      width: 4px;
      height: 4px;
      border-width: 4px;
      border-radius: 4px;
      opacity: 1;
    }
    .promptBox[data-inpaint-generating="true"] .nodeResizeHandle {
      display: none !important;
      pointer-events: none !important;
    }
    .nodeInput {
      position: absolute;
      top: 0;
      right: calc(100% + var(--node-input-gap, 0px));
      min-width: 0;
      height: var(--node-stage-height, 100%);
      border: 1px solid var(--canvas-rim);
      border-radius: 5px 0 0 5px;
      background: transparent;
      box-sizing: border-box;
      overflow: visible;
      opacity: 1;
      width: var(--node-input-width, 0px);
      transition: width 180ms ease, opacity 160ms ease, border-color 160ms ease;
    }
    .nodeInput {
      border-color: transparent;
    }
    .nodeInputHandle,
    .nodeOutputHandle {
      position: absolute;
      display: grid;
      place-items: center;
      border: 1px solid var(--canvas-rim-strong);
      background: var(--canvas-handle-surface);
      color: var(--canvas-text-soft);
      font-size: 12px;
      line-height: 1;
      box-sizing: border-box;
      opacity: 0;
      pointer-events: none;
      transition: opacity 120ms ease, border-color 160ms ease, background 160ms ease, color 160ms ease;
    }
    .promptBox[data-input-visible="true"] .nodeInputHandle,
    .promptBox[data-output-visible="true"] .nodeOutputHandle {
      opacity: 1;
    }
    .nodeInputHandle {
      left: -8px;
      top: 50%;
      width: 11px;
      height: 60px;
      border-radius: 999px;
      transform: translateY(-50%);
    }
    .nodeInputHandle svg,
    .nodeOutputHandle svg {
      width: 5px;
      height: 7px;
      transform: translateX(1px);
    }
    .nodeInputHandle path,
    .nodeOutputHandle path {
      stroke: currentColor;
    }
    .nodeOutputHandle {
      left: calc(100% + var(--node-output-gap, 8px));
      top: 50%;
      width: 11px;
      height: 60px;
      border-radius: 999px;
      transform: translateY(-50%);
      cursor: crosshair;
      transition: left 180ms ease, opacity 120ms ease, border-color 160ms ease, background 160ms ease, color 160ms ease;
    }
    .promptBox[data-output-visible="true"] .nodeOutputHandle {
      pointer-events: auto;
    }
    .nodeOutputHandle:hover {
      border-color: var(--canvas-accent);
      background: var(--canvas-accent);
      color: var(--canvas-accent-contrast);
    }
    .nodeStage {
      grid-column: 1;
      grid-row: 1;
      position: relative;
      width: var(--node-stage-width, 100%);
      height: var(--node-stage-height, 100%);
      min-width: 0;
      min-height: 0;
      overflow: visible;
      border-radius: var(--radius-lg, 11px);
    }
    .promptEditor {
      position: absolute;
      inset: 0;
      border: 1px solid var(--canvas-accent-rim);
      border-radius: var(--radius-lg, 11px);
      background: var(--canvas-field);
      box-sizing: border-box;
      box-shadow: inset 0 0 0 1px var(--canvas-hairline);
    }
    .promptFileDropOverlay {
      position: absolute;
      inset: 0;
      z-index: 25;
      display: none;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 16px;
      border-radius: var(--radius-lg, 11px);
      pointer-events: none;
      box-sizing: border-box;
      background: var(--canvas-accent-wash);
      border: 2px dashed var(--canvas-accent);
      box-shadow: inset 0 0 0 1px var(--canvas-hairline);
      color: var(--canvas-text-strong);
      font-size: 13px;
      font-weight: 750;
      letter-spacing: 0.02em;
      line-height: 1.35;
    }
    .promptEditor.promptEditorFileDragHover .promptFileDropOverlay {
      display: flex;
    }
    .promptEditor.promptEditorFileDragHover textarea {
      opacity: 0.38;
    }
    .promptBox textarea {
      position: absolute;
      top: 10px;
      right: 10px;
      bottom: 42px;
      left: 10px;
      width: auto;
      height: auto;
      min-width: 0;
      min-height: 0;
      box-sizing: border-box;
      resize: none;
      border: 1px solid var(--canvas-rim);
      border-radius: 8px;
      outline: 0;
      background: var(--canvas-field);
      color: var(--text);
      font: inherit;
      font-size: 13px;
      line-height: 1.35;
      padding: 10px;
      cursor: text;
      transition:
        top 180ms cubic-bezier(.2, .8, .2, 1),
        bottom 180ms cubic-bezier(.2, .8, .2, 1);
    }
    /* Make room for the generation error banner instead of covering the prompt. */
    .promptBox[data-generation-error="true"] textarea {
      top: 52px;
    }
    .promptEditor[data-has-suggestions="true"] textarea {
      bottom: 82px;
    }
    .promptActions {
      position: absolute;
      left: 10px;
      right: 10px;
      bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 8px;
    }
    .promptActions > button:last-child {
      margin-left: auto;
    }
    .generateWrap {
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      z-index: 6;
      display: inline-flex;
      align-items: center;
      pointer-events: auto;
    }
    .plungerSlide {
      position: relative;
      display: inline-flex;
      align-items: center;
      will-change: transform;
      touch-action: none;
    }
    .promptBox .generateBtn {
      position: relative;
      z-index: 2;
      height: 26px;
      border: 1px solid var(--canvas-rim);
      border-radius: 7px;
      background: var(--canvas-fill);
      color: var(--text);
      /* 6px + 1px bar + 2px gap + 1px bar + 6px before label */
      padding: 0 9px 0 16px;
      font-size: 12px;
      font-weight: 800;
      white-space: nowrap;
      box-shadow: var(--canvas-shadow-soft), inset 0 1px 0 var(--canvas-hairline);
    }
    .promptBox .generateBtn:disabled,
    .promptBox .generateBtn[disabled] {
      opacity: 0.4;
      cursor: default;
      pointer-events: none;
      border-color: var(--canvas-hairline);
      background: var(--canvas-fill);
      color: var(--canvas-text-faint);
      box-shadow: none;
    }
    .promptBox .generateBtn:disabled::before,
    .promptBox .generateBtn:disabled::after,
    .promptBox .generateBtn[disabled]::before,
    .promptBox .generateBtn[disabled]::after {
      background: var(--canvas-fill-hover);
      box-shadow: none;
    }
    .promptBox .generateBtn::before,
    .promptBox .generateBtn::after {
      content: "";
      position: absolute;
      top: 50%;
      width: 1px;
      height: 10px;
      margin-top: -5px;
      border-radius: 0.5px;
      background: var(--canvas-fill-active);
      pointer-events: none;
    }
    .promptBox .generateBtn::before {
      left: 6px;
    }
    .promptBox .generateBtn::after {
      left: 9px;
    }
    .promptBox .generateBtn:hover,
    .promptBox .generateBtn:active,
    .generateWrap[data-plunging="true"] .generateBtn {
      border-color: var(--canvas-accent-rim);
      background: var(--canvas-accent-wash);
      color: var(--canvas-text-strong);
    }
    :host([data-theme="light"]) .promptBox .generateBtn:hover,
    :host([data-theme="light"]) .promptBox .generateBtn:active,
    :host([data-theme="light"]) .generateWrap[data-plunging="true"] .generateBtn {
      border-color: rgba(173, 120, 0, 0.40);
      background: linear-gradient(90deg, rgba(204, 154, 19, 0.55) 0%, rgba(232, 197, 107, 0.49) 100%);
      box-shadow: 1px 1px 0 0 rgba(255, 189, 240, 0.47), 0 4px 4px 0 rgb(82 56 0 / 19%);
      color: var(--text, #1a1c1e);
      text-shadow: -1px -1px 0 rgba(255, 255, 255, 0.25);
    }
    .promptBox .generateBtn:hover::before,
    .promptBox .generateBtn:hover::after,
    .promptBox .generateBtn:active::before,
    .promptBox .generateBtn:active::after {
      background: var(--canvas-accent);
    }
    .generateWrap[data-plunging="true"] .generateBtn {
      cursor: grabbing;
    }
    .generateWrap[data-plunging="true"] .generateBtn::before,
    .generateWrap[data-plunging="true"] .generateBtn::after {
      background: rgba(255, 204, 80, 0.95);
      box-shadow: 0 0 6px rgba(255,170,40,0.45);
    }
    .plungerBars {
      position: absolute;
      left: 100%;
      top: 50%;
      transform: translateY(-50%);
      margin-left: 4px;
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 4px;
      height: 22px;
      pointer-events: none;
    }
    .plungerBar {
      width: 4px;
      height: 22px;
      border-radius: 2px;
      background: linear-gradient(180deg, #ffcc00, #ff8a00);
      box-shadow: 0 0 8px rgba(255,170,40,0.45);
      transform: scaleY(0);
      transform-origin: center center;
      transition: transform 140ms cubic-bezier(.34, 1.56, .64, 1);
    }
    .plungerBar[data-grown="true"] {
      transform: scaleY(1);
    }
    .promptMentionMenu {
      position: absolute;
      left: var(--mention-menu-left, 10px);
      top: var(--mention-menu-top, 46px);
      z-index: 30;
      width: min(300px, calc(100% - 20px));
      max-height: 188px;
      padding: var(--menu-padding, 6px);
      border-radius: var(--menu-radius, 8px);
      background: var(--canvas-panel);
      box-shadow: var(--canvas-panel-shadow);
      overflow: auto;
    }
    .promptMentionMenu[hidden] {
      display: none;
    }
    .promptMentionOption {
      width: 100%;
      height: 30px;
      min-height: 30px;
      display: flex;
      align-items: center;
      min-width: 0;
      padding: 0 9px;
      border: 1px solid transparent;
      border-radius: var(--menu-row-radius, 4px);
      background: transparent;
      color: var(--canvas-text);
      font: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      box-sizing: border-box;
    }
    .promptMentionOption:hover {
      color: var(--canvas-text-strong);
    }
    .promptBox button.promptMentionOption[data-active="true"] {
      border-color: var(--canvas-accent-line);
      background: var(--canvas-accent-wash);
      color: var(--canvas-accent-strong);
    }
    .promptMentionOptionName {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 400;
    }
    .promptMentionOptionName strong {
      color: inherit;
      font-weight: 850;
    }
    .promptResolutionControl {
      position: relative;
      min-width: 0;
      max-width: min(230px, 100%);
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--muted);
    }
    .promptBrandControl {
      position: relative;
      display: none;
      min-width: 60px;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--muted);
    }
    .promptBrandControl[data-visible="true"] {
      display: block;
    }
    .promptBrandButton {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 8px;
      min-width: 60px;
      max-width: 190px;
      height: 26px;
      padding: 0 8px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: var(--muted);
      font: inherit;
      font-family: var(--font-mono);
      font-size: 10px;
      cursor: pointer;
    }
    .promptBrandButton:hover,
    .promptBrandControl[data-open="true"] .promptBrandButton {
      background: var(--canvas-fill);
      color: var(--canvas-accent);
    }
    .promptBrandLogo {
      width: 22px;
      height: 22px;
      flex: 0 0 22px;
      display: grid;
      place-items: center;
      border-radius: 4px;
      background: var(--canvas-fill);
      color: var(--canvas-text-faint);
      overflow: hidden;
      font-size: 10px;
      line-height: 1;
    }
    .promptBrandLogo img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
    }
    .promptBrandLogo[data-empty="true"] {
      display: none;
    }
    .promptBrandName {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: left;
    }
    .promptBrandMenu {
      position: absolute;
      left: 0;
      top: calc(100% + 5px);
      z-index: 20;
      width: 250px;
      padding: 10px 0;
      border-radius: var(--menu-radius, 8px);
      background: var(--canvas-panel);
      box-shadow: var(--canvas-panel-shadow);
    }
    .promptBrandMenu[hidden] {
      display: none;
    }
    .promptBrandOption {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr) 14px;
      align-items: center;
      gap: 9px;
      width: 100%;
      height: 34px;
      padding: 0 12px;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--canvas-text-soft);
      font: inherit;
      font-size: 11px;
      text-align: left;
      cursor: pointer;
    }
    .promptBrandOption[data-has-logo="false"] {
      grid-template-columns: minmax(0, 1fr) 14px;
    }
    .promptBrandOption:hover,
    .promptBrandOption[data-selected="true"] {
      color: var(--canvas-accent);
      background: var(--canvas-accent-wash-soft);
    }
    .promptBrandOption[data-selected="true"] {
      background: var(--canvas-accent-wash);
    }
    .promptBrandOption:not([data-selected="true"]) .promptResolutionMark {
      opacity: 0;
    }
    .promptResolutionButton {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 132px;
      height: 26px;
      padding: 0 8px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: var(--muted);
      font: inherit;
      font-family: var(--font-mono);
      font-size: 10px;
      cursor: pointer;
    }
    .promptResolutionButton:hover,
    .promptResolutionControl[data-open="true"] .promptResolutionButton {
      background: var(--canvas-fill);
      color: var(--canvas-accent);
    }
    .promptResolutionButtonSize {
      color: var(--muted);
    }
    .promptResolutionButton:hover .promptResolutionButtonSize,
    .promptResolutionControl[data-open="true"] .promptResolutionButtonSize {
      color: currentColor;
    }
    .promptResolutionMenu {
      position: absolute;
      left: 0;
      top: calc(100% + 5px);
      z-index: 20;
      width: 882px;
      box-sizing: border-box;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      border-radius: var(--menu-radius, 8px);
      background: var(--canvas-panel);
      box-shadow: var(--canvas-panel-shadow);
      overflow: hidden;
    }
    .promptResolutionMenu[hidden],
    .promptResolutionCustom[hidden],
    .promptResolutionControl[data-custom="true"] .promptResolutionButton {
      display: none;
    }
    .promptResolutionColumn {
      min-width: 0;
      padding: 13px 0;
    }
    .promptResolutionColumn + .promptResolutionColumn {
      border-left: 1px solid var(--canvas-rim);
    }
    .promptResolutionHeading {
      padding: 0 12px 6px;
      color: var(--canvas-text-dim);
      display: flex;
      align-items: center;
      gap: 9px;
      font-family: var(--font);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.07em;
      text-transform: uppercase;
    }
    .promptResolutionGroup + .promptResolutionGroup {
      margin-top: 13px;
    }
    .promptResolutionHeadingIcon,
    .promptResolutionIcon {
      width: 24px;
      height: 24px;
      display: inline-grid;
      place-items: center;
      flex: 0 0 24px;
    }
    .promptResolutionHeadingIcon {
      color: var(--canvas-accent);
    }
    .promptResolutionIcon {
      color: var(--canvas-text-soft);
    }
    .promptResolutionHeadingIcon svg,
    .promptResolutionIcon svg {
      display: block;
      width: 24px;
      height: 24px;
    }
    .promptResolutionIcon[data-icon="instagram"] svg,
    .promptResolutionIcon[data-icon="x"] svg {
      width: 14px;
      height: 14px;
    }
    .promptResolutionCustomRow {
      margin-top: 13px;
      padding-top: 11px;
      border-top: 1px solid var(--canvas-hairline);
    }
    .promptResolutionOption,
    .promptResolutionCustomTrigger {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr) auto 14px;
      align-items: center;
      gap: 9px;
      width: 100%;
      min-height: 34px;
      padding: 0 12px;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--canvas-text-soft);
      font: inherit;
      font-family: var(--font-mono);
      font-size: 11px;
      text-align: left;
      cursor: pointer;
    }
    .promptResolutionOption:hover,
    .promptResolutionCustomTrigger:hover {
      color: var(--canvas-accent);
      background: var(--canvas-accent-wash-soft);
    }
    .promptResolutionOption[data-selected="true"] {
      color: var(--canvas-accent);
      background: var(--canvas-accent-wash);
    }
    .promptResolutionCustomTrigger[data-selected="true"] {
      color: var(--canvas-accent);
      background: var(--canvas-accent-wash);
    }
    .promptResolutionMark {
      color: var(--canvas-accent);
      display: inline-grid;
      place-items: center;
      width: 14px;
      height: 14px;
      justify-self: end;
    }
    .promptResolutionMark svg {
      display: block;
      width: 9px;
      height: 7px;
    }
    .promptResolutionMark path {
      stroke: currentColor;
    }
    .promptResolutionOption:not([data-selected="true"]) .promptResolutionMark {
      opacity: 0;
    }
    .promptResolutionName {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--font);
      font-size: 12px;
    }
    .promptResolutionAspect {
      color: var(--canvas-text-faint);
      font-family: var(--font);
      font-size: 12px;
    }
    .promptResolutionSize {
      color: var(--muted);
      font-family: var(--font-mono);
      opacity: 0.5;
    }
    .promptResolutionOption:hover .promptResolutionSize,
    .promptResolutionCustomTrigger:hover .promptResolutionSize,
    .promptResolutionOption[data-selected="true"] .promptResolutionSize,
    .promptResolutionCustomTrigger[data-selected="true"] .promptResolutionSize {
      color: currentColor;
    }
    .promptResolutionCustomTrigger .promptResolutionMark {
      opacity: 0.7;
      outline: 1px dashed currentColor;
      outline-offset: -3px;
      width: 12px;
      height: 12px;
      justify-self: center;
    }
    .promptResolutionCustomTrigger[data-selected="true"] .promptResolutionMark {
      outline: 0;
      opacity: 1;
    }
    .promptResolutionCustom {
      display: flex;
      align-items: center;
      gap: 5px;
      height: 26px;
    }
    .promptResolutionCustom input {
      width: 58px;
      height: 26px;
      box-sizing: border-box;
      border: 1px solid var(--canvas-rim);
      border-radius: 7px;
      outline: 0;
      background: var(--canvas-field);
      color: var(--text);
      font: inherit;
      font-family: var(--font-mono);
      font-size: 10px;
      padding: 0 7px;
      appearance: textfield;
    }
    .promptResolutionCustom input::-webkit-outer-spin-button,
    .promptResolutionCustom input::-webkit-inner-spin-button {
      margin: 0;
      appearance: none;
    }
    .promptResolutionCustom input:focus {
      border-color: var(--canvas-accent);
      color: var(--canvas-accent);
    }
    .promptResolutionCustom span {
      color: var(--muted);
    }
    .promptBox[data-low-detail="true"]:not([data-has-image="true"]) textarea,
    .promptBox[data-low-detail="true"]:not([data-has-image="true"]) .promptActions {
      display: none;
    }
    .promptBox[data-click-prompt-state="typing"] textarea {
      display: block !important;
    }
    .promptBox[data-click-prompt-state="typing"] .promptActions {
      display: none;
    }
    .nodeStack {
      position: absolute;
      inset: 0;
      border-radius: var(--radius-lg, 11px);
    }
    .nodeStack[hidden],
    .nodeLoading[hidden],
    .promptEditor[hidden] {
      display: none;
    }
    .stackFrame {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border-radius: var(--radius-lg, 11px);
      transition: transform 180ms ease, opacity 180ms ease;
      box-sizing: border-box;
      box-shadow: var(--canvas-stack-shadow);
      background: var(--canvas-plane);
      pointer-events: none;
    }
    .stackFrame::after {
      content: "";
      position: absolute;
      inset: 0;
      border: 1px solid var(--canvas-rim-strong);
      border-radius: inherit;
      pointer-events: none;
      transition: opacity 180ms ease;
    }
    .stackFrameMedia {
      position: absolute;
      inset: 0;
      border-radius: inherit;
      overflow: hidden;
      transition: opacity 180ms ease;
    }
    .stackFrameLayer {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
      border-radius: inherit;
      transform-origin: center center;
    }
    .stackFramePartial {
      z-index: 2;
    }
    .stackFrameFinal {
      z-index: 1;
    }
    .stackFrame[data-analysis-mute="true"] .stackFrameFinal {
      filter: grayscale(50%) brightness(0.86);
    }
    .stackFrame[data-loading="true"] {
      overflow: hidden;
      background: var(--canvas-loading-surface);
    }
    .stackFrame[data-processing-state="processing-unavailable"] .stackFrameMedia {
      visibility: hidden;
    }
    .stackFrame[data-partial="true"] .stackFramePartial {
      filter: blur(4px);
      transform: scale(1.02);
      opacity: 1;
    }
    .stackFrame[data-partial="true"] .stackFrameFinal,
    .stackFrame[data-partial-reveal="pending"] .stackFrameFinal {
      filter: blur(4px);
      transform: scale(1.02);
      opacity: 0;
    }
    .stackFrame[data-partial-reveal="active"]:has(.stackFramePartial) .stackFramePartial {
      animation: diffuiCanvasStackPartialRevealPartial 560ms ease forwards;
    }
    .stackFrame[data-partial-reveal="active"]:has(.stackFramePartial) .stackFrameFinal {
      animation: diffuiCanvasStackPartialRevealFinal 560ms ease forwards;
    }
    .inpaintProgressTreatment,
    .inpaintProgressMask {
      position: absolute;
      display: none;
      box-sizing: border-box;
      border-radius: 0;
      overflow: hidden;
      pointer-events: none;
    }
    .inpaintProgressTreatment {
      z-index: 5;
      display: none;
      grid-template-columns: repeat(var(--pixel-columns, 1), var(--pixel-size, 64px));
      grid-template-rows: repeat(var(--pixel-rows, 1), var(--pixel-size, 64px));
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.10);
    }
    .inpaintProgressTreatment::after {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 2;
      background: var(--canvas-accent);
      opacity: 0.2;
      pointer-events: none;
    }
    .inpaintProgressTreatmentPixel {
      position: relative;
      z-index: 1;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      background: rgba(255,255,255,var(--pixel-tint, 0.015));
      backdrop-filter:
        blur(var(--pixel-blur-min, 0px))
        grayscale(var(--pixel-gray-min, 0.18))
        saturate(var(--pixel-saturate-min, 0.9))
        brightness(var(--pixel-bright-min, 0.92));
      animation: diffuiCanvasInpaintPixelTreatment var(--pixel-duration, 1300ms) ease-in-out infinite alternate;
      animation-delay: var(--pixel-delay, 0ms);
      will-change: backdrop-filter;
    }
    .inpaintProgressMask {
      z-index: 6;
      border: 1px solid var(--canvas-rim);
      mix-blend-mode: color-dodge;
      box-shadow: 0 0 0 1px rgba(7,9,12,0.22), 0 0 28px rgba(255,197,51,0.22);
    }
    .inpaintProgressMask::before {
      content: "";
      position: absolute;
      top: 0;
      right: -211%;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle at 50%, #ffcccc30, #ffcccc00 50%, #eeeeee00 85%, #33333300 100%);
      animation: diffuiCanvasInpaintShimmer 2800ms linear infinite;
      pointer-events: none;
    }
    .stackFrame[data-inpaint-progress="true"] .inpaintProgressTreatment,
    .stackFrame[data-inpaint-progress="true"] .inpaintProgressMask {
      display: block;
    }
    .stackFrame[data-inpaint-progress="true"] .inpaintProgressTreatment {
      display: grid;
    }
    .stackFrame[data-processing-state="processing-unavailable"]::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(90deg, transparent 0%, var(--canvas-skeleton-sweep) 48%, transparent 100%),
        linear-gradient(var(--canvas-skeleton), var(--canvas-skeleton));
      transform: translateX(-120%);
      animation: diffuiCanvasSkeletonSweep 1100ms ease-in-out infinite;
      pointer-events: none;
    }
    .analysisSpinner {
      position: absolute;
      top: 9px;
      right: 9px;
      width: 20px;
      height: 20px;
      border-radius: 999px;
      border: 2px solid var(--canvas-rim-strong);
      border-top-color: var(--canvas-accent);
      background: var(--canvas-veil);
      box-shadow: var(--canvas-shadow-marker);
      animation: diffuiCanvasStackSpin 760ms linear infinite;
      box-sizing: border-box;
      z-index: 8;
      pointer-events: none;
    }
    .analysisSpinner[hidden] {
      display: none;
    }
    .stackFrame[data-layer="0"] {
      z-index: 4;
      opacity: 1;
      transform: translate(0, 0);
    }
    .stackFrame[data-layer="1"] {
      z-index: 3;
      opacity: 1;
      transform: translate(var(--stack-offset-1, 18px), var(--stack-offset-1, 18px));
      box-shadow: var(--canvas-stack-shadow);
    }
    .stackFrame[data-layer="1"] .stackFrameMedia,
    .stackFrame[data-layer="1"]::after {
      opacity: 0.5;
    }
    .stackFrame[data-layer="2"] {
      z-index: 2;
      opacity: 1;
      transform: translate(var(--stack-offset-2, 36px), var(--stack-offset-2, 36px));
      box-shadow: var(--canvas-stack-shadow);
    }
    .stackFrame[data-layer="2"] .stackFrameMedia {
      opacity: 0.25;
    }
    .stackFrame[data-layer="2"]::after {
      opacity: 0.5;
    }
    .nodeStack[data-depth="2"] .stackFrame[data-layer="2"] .stackFrameMedia,
    .nodeStack[data-depth="2"] .stackFrame[data-layer="2"]::after {
      opacity: 0;
    }
    .stackFrame[data-layer="3"] {
      z-index: 1;
      opacity: 0;
      transform: translate(var(--stack-offset-3, 54px), var(--stack-offset-3, 54px));
      box-shadow: var(--canvas-stack-shadow);
    }
    .stackFrame[data-layer="3"] .stackFrameMedia {
      opacity: 0.18;
    }
    .stackFrame[data-layer="3"]::after {
      opacity: 0.7;
    }
    .stackFrame[data-layer="-1"] {
      z-index: 5;
      opacity: 0;
      transform: translate(-8px, -8px);
    }
    .nodeLoading {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      border-radius: var(--radius-lg, 11px);
      color: var(--canvas-text-faint);
      font-size: 12px;
      background: var(--canvas-veil);
    }
    .nodeError {
      position: absolute;
      left: 10px;
      right: 10px;
      top: 10px;
      z-index: 14;
      display: flex;
      align-items: center;
      gap: 8px;
      box-sizing: border-box;
      padding: 8px 10px;
      border: 1px solid var(--canvas-danger-rim);
      border-radius: 8px;
      background: var(--canvas-danger-surface);
      color: var(--canvas-text);
      font-size: 12px;
      line-height: 1.35;
      box-shadow: var(--canvas-drop-shadow);
    }
    .nodeError[hidden] {
      display: none;
    }
    .nodeErrorIcon {
      display: inline-flex;
      flex: 0 0 auto;
      color: var(--canvas-danger);
    }
    .nodeErrorIcon svg {
      width: 14px;
      height: 14px;
      stroke-width: 1.6;
      display: block;
    }
    .nodeErrorText {
      flex: 1 1 auto;
      min-width: 0;
    }
    .promptBox .nodeErrorRetry,
    .promptBox .nodeErrorDismiss {
      flex: 0 0 auto;
      padding: 4px 9px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      border: 1px solid var(--canvas-rim);
      background: var(--canvas-fill-hover);
    }
    .promptBox .nodeErrorDismiss {
      border-color: transparent;
      background: transparent;
      font-weight: 500;
      color: var(--canvas-text-faint);
    }
    .promptBox .nodeErrorRetry:hover,
    .promptBox .nodeErrorDismiss:hover {
      background: var(--canvas-fill-active);
      color: var(--text);
    }
    .nodeStackBar {
      position: absolute;
      left: 50%;
      bottom: calc(-1 * var(--node-stack-bar-gap, 8px) - 15px);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      opacity: 0;
      transform: translateX(-50%) translateY(-4px);
      pointer-events: none;
      transition: bottom 180ms ease, opacity 160ms ease, transform 160ms ease;
    }
    .promptBox .nodeStackBar[data-visible="true"] {
      pointer-events: auto;
    }
    .promptBox[data-selected="true"] .nodeStackBar[data-visible="true"],
    .promptBox[data-has-image="true"] .nodeStackBar[data-visible="true"]:hover {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .nodeStackBar[data-visible="true"] {
      z-index: 12;
    }
    .stackAdd,
    .stackDot {
      pointer-events: auto;
    }
    :host([data-zooming="true"]) .nodeInputHandle,
    :host([data-zooming="true"]) .nodeOutputHandle,
    :host([data-zooming="true"]) .nodeStackBar,
    :host([data-zooming="true"]) .stackFrame,
    :host([data-zooming="true"]) .stackFrameLayer {
      transition: none !important;
      animation: none !important;
    }
    .stackDots {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .promptBox .stackDot {
      width: 9px;
      height: 9px;
      min-width: 0;
      padding: 0;
      border: 1px solid var(--canvas-rim-strong);
      border-radius: 999px;
      background: transparent;
      box-sizing: border-box;
      cursor: pointer;
      position: relative;
    }
    .promptBox .stackDot[data-state="active"],
    .promptBox .stackDot[data-active="true"]:not([data-state]) {
      background: var(--canvas-accent-bright);
      border-color: var(--canvas-rim-strong);
    }
    .promptBox .stackDot[data-state="processing-unavailable"],
    .promptBox .stackDot[data-state="processing-available"],
    .promptBox .stackDot[data-state="processing-active"],
    .promptBox .stackDot[data-status="loading"] {
      border-color: var(--canvas-rim);
      border-top-color: var(--canvas-accent-bright);
      animation: diffuiCanvasStackSpin 760ms linear infinite;
    }
    .promptBox .stackDot[data-state="processing-active"]::after {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      width: 4px;
      height: 4px;
      border-radius: 999px;
      background: var(--canvas-accent-bright);
      transform: translate(1.5px, 1.5px);
    }
    @keyframes diffuiCanvasInpaintShimmer {
      from { transform: translateX(0); }
      to { transform: translateX(-245%); }
    }
    @keyframes diffuiCanvasInpaintPixelTreatment {
      from {
        backdrop-filter:
          blur(var(--pixel-blur-min, 0px))
          grayscale(var(--pixel-gray-min, 0.18))
          saturate(var(--pixel-saturate-min, 0.9))
          brightness(var(--pixel-bright-min, 0.92));
      }
      to {
        backdrop-filter:
          blur(var(--pixel-blur-max, 4px))
          grayscale(var(--pixel-gray-max, 0.56))
          saturate(var(--pixel-saturate-max, 0.68))
          brightness(var(--pixel-bright-max, 0.78));
      }
    }
    .stackAdd {
      width: 15px;
      height: 15px;
      min-width: 0;
      display: inline-grid;
      place-items: center;
      padding: 0;
      border: 0 !important;
      border-radius: 999px;
      background: var(--canvas-chip) !important;
      color: var(--canvas-chip-text);
      backdrop-filter: blur(2px);
      cursor: pointer;
    }
    .stackAdd:hover {
      background: var(--canvas-chip-hover) !important;
    }
    .stackAdd:active {
      background: var(--canvas-chip-active) !important;
    }
    .stackAdd[disabled] {
      opacity: 0.35;
      cursor: default;
    }
    .stackAdd[hidden] {
      display: none;
    }
    .stackAdd svg {
      width: 7px;
      height: 7px;
    }
    @keyframes diffuiCanvasStackSpin {
      to {
        transform: rotate(360deg);
      }
    }
    @keyframes diffuiCanvasStackPartialRevealPartial {
      0% {
        filter: blur(4px);
        transform: scale(1.02);
        opacity: 1;
      }
      50% {
        filter: blur(4px);
        transform: scale(1);
        opacity: 0;
      }
      100% {
        filter: blur(4px);
        transform: scale(1);
        opacity: 0;
      }
    }
    @keyframes diffuiCanvasStackPartialRevealFinal {
      0% {
        filter: blur(4px);
        transform: scale(1.02);
        opacity: 0;
      }
      50% {
        filter: blur(0);
        transform: scale(1);
        opacity: 1;
      }
      100% {
        filter: blur(0);
        transform: scale(1);
        opacity: 1;
      }
    }
    @keyframes diffuiCanvasSkeletonSweep {
      to {
        transform: translateX(120%);
      }
    }
    .nodeOutput {
      grid-column: 1;
      grid-row: 1;
      position: relative;
      width: var(--node-stage-width, 100%);
      height: var(--node-stage-height, 100%);
      min-width: 0;
      min-height: 0;
      pointer-events: none;
    }
    .findBox {
      position: absolute;
      z-index: 7;
      width: 320px;
      border: 1px solid var(--canvas-rim);
      border-radius: 12px;
      background: var(--canvas-panel-solid);
      box-shadow: var(--canvas-shadow-lift);
      padding: 12px;
      color: var(--text);
    }
    .inspector {
      position: absolute;
      right: 12px;
      top: 12px;
      bottom: 12px;
      z-index: 7;
      width: 322px;
      display: grid;
      grid-template-rows: auto auto auto auto auto 1fr;
      border-left: 1px solid var(--canvas-rim);
      border-radius: 0 11px 11px 0;
      background: var(--canvas-panel-solid);
      box-shadow: var(--canvas-shadow-lift);
      color: var(--text);
      overflow: hidden;
    }
    .inspectorTitle,
    .findTitle {
      font-size: 12px;
      font-weight: 900;
      margin-bottom: 8px;
    }
    .findBox {
      left: 58px;
      top: 14px;
    }
    .panelSection {
      padding: 13px 12px;
      border-bottom: 1px solid var(--canvas-hairline);
    }
    .panelSection:last-child {
      border-bottom: 0;
    }
    .panelSection[data-flex="true"] {
      min-height: 0;
      display: grid;
      grid-template-rows: auto 1fr;
    }
    .panelLabelRow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }
    .panelLabel {
      color: var(--canvas-text-soft);
      font-size: 11px;
      font-weight: 800;
    }
    .panelValue {
      min-width: 0;
      color: var(--canvas-text);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .panelDimGrid {
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: 8px;
      align-items: end;
    }
    .panelFieldLabel {
      display: block;
      margin-bottom: 5px;
      color: var(--canvas-text-faint);
      font-size: 10px;
    }
    .panelFieldValue,
    .panelInput,
    .panelSelect {
      height: 32px;
      display: flex;
      align-items: center;
      box-sizing: border-box;
      border: 1px solid var(--canvas-rim);
      border-radius: 2px;
      background: var(--canvas-fill);
      color: var(--canvas-text);
      font-size: 12px;
      padding: 0 9px;
    }
    .panelInput {
      width: 100%;
      outline: 0;
      font-family: inherit;
      font-size: 12px;
    }
    .panelInput:focus {
      border-color: var(--canvas-accent-line);
      background: var(--canvas-accent-wash-soft);
      color: var(--canvas-text-strong);
    }
    .panelLock {
      height: 32px;
      display: grid;
      place-items: center;
      color: var(--canvas-text-faint);
    }
    .panelLock svg {
      width: 14px;
      height: 14px;
    }
    .panelThumbs {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 7px;
    }
    .panelThumb {
      aspect-ratio: 4 / 3;
      border: 1px solid var(--canvas-rim);
      border-radius: 2px;
      background: var(--canvas-fill);
      overflow: hidden;
    }
    .panelThumb img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
    }
    .panelBrandUsed {
      min-height: 34px;
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      align-items: center;
      gap: 8px;
      color: var(--canvas-text);
      font-size: 12px;
    }
    .panelBrandLogo {
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
      border: 1px solid var(--canvas-rim);
      border-radius: 4px;
      background: var(--canvas-fill);
      color: var(--canvas-text-faint);
      overflow: hidden;
      font-size: 10px;
      line-height: 1;
    }
    .panelBrandLogo img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
    }
    .panelBrandName {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .panelEmpty {
      grid-column: 1 / -1;
      color: var(--canvas-text-faint);
      font-size: 12px;
    }
    .copyJsonBtn {
      height: 22px;
      border: 1px solid var(--canvas-rim);
      border-radius: 2px;
      background: var(--canvas-fill);
      color: var(--canvas-text-soft);
      font: inherit;
      font-size: 10px;
      cursor: pointer;
    }
    .copyJsonBtn:hover {
      border-color: var(--canvas-rim-strong);
      color: var(--canvas-text-strong);
    }
    .promptJson {
      min-height: 100px;
      margin: 0;
      padding: 10px;
      border: 1px solid var(--canvas-rim);
      border-radius: 2px;
      background: var(--canvas-fill);
      color: var(--canvas-text-soft);
      font: 11px/1.35 var(--font-mono);
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .variantButton {
      --height: 33px;
      --padding-x: 10px;
    }
    .findBox input {
      width: 100%;
      box-sizing: border-box;
      height: 32px;
      border: 1px solid var(--canvas-rim);
      border-radius: 2px;
      background: var(--canvas-fill);
      color: var(--text);
      padding: 0 10px;
      outline: 0;
    }
    /* Same menu family as .contextMenu / the popovers: shape from the --menu-* tokens and
       no CSS border, with the rim in the shadow stack. The surface stays canvas-dark rather
       than --menu-surface, and so the rim is light: a dark one would vanish on the canvas. */
    .nodeContextMenu {
      position: fixed;
      min-width: 168px;
      padding: var(--menu-padding, 6px);
      border-radius: var(--menu-radius, 8px);
      background: var(--canvas-panel);
      box-shadow: var(--canvas-panel-shadow);
      /* Above the canvas coach overlay (z-index 1200) so … / right-click menus
         remain visible while a tip is on screen. */
      z-index: 1300;
      display: none;
    }
    .nodeContextMenu[data-open="true"] {
      display: grid;
      gap: 2px;
    }
    .nodeContextMenuItem {
      width: 100%;
      height: 30px;
      border: 0;
      border-radius: var(--menu-row-radius, 4px);
      background: transparent;
      color: var(--canvas-text);
      font: inherit;
      font-size: 12px;
      text-align: left;
      padding: 0 10px;
      cursor: pointer;
    }
    .nodeContextMenuItem:hover:not(:disabled),
    .nodeContextMenuItem[data-coach-hover="true"]:not(:disabled) {
      background: var(--canvas-fill-hover);
      color: var(--canvas-text-strong);
    }
    .nodeContextMenuItem:disabled {
      color: var(--canvas-text-dim);
      cursor: default;
    }
    .nodeContextMenuItem[data-ui-hidden="true"] {
      display: none;
    }
    .nodeContextMenuDivider {
      height: 1px;
      margin: 3px 4px;
      background: var(--canvas-fill-active);
    }
    .edgeFacetMenu {
      position: fixed;
      min-width: 176px;
      padding: var(--menu-padding, 6px);
      border-radius: var(--menu-radius, 8px);
      background: var(--canvas-panel);
      box-shadow: var(--canvas-panel-shadow);
      z-index: 1300;
      display: none;
    }
    .edgeFacetMenu[data-open="true"] {
      display: grid;
      gap: 2px;
    }
    .edgeFacetMenuTitle {
      padding: 4px 8px 6px;
      color: var(--canvas-text-faint);
      font: 10px var(--font-mono);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .edgeFacetMenuItem {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 30px;
      border: 0;
      border-radius: var(--menu-row-radius, 4px);
      background: transparent;
      color: var(--canvas-text);
      font: inherit;
      font-size: 12px;
      text-align: left;
      padding: 0 10px;
      cursor: pointer;
      box-sizing: border-box;
    }
    .edgeFacetMenuItem:hover {
      background: var(--canvas-fill-hover);
      color: var(--canvas-text-strong);
    }
    .edgeFacetMenuItem input {
      appearance: none;
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      margin: 0;
      border: 1px solid var(--canvas-rim-strong);
      border-radius: 3px;
      background: var(--canvas-well);
      cursor: pointer;
      flex: 0 0 auto;
    }
    .edgeFacetMenuItem input:checked {
      border-color: var(--canvas-accent);
      background: var(--canvas-accent);
      box-shadow: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath fill='none' stroke='%23101014' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' d='M3.2 7.2l2.4 2.4 5.2-5.2'/%3E%3C/svg%3E");
      background-size: 12px 12px;
      background-position: center;
      background-repeat: no-repeat;
    }
    /* The tick is baked into the data URI, so it cannot read
       --canvas-accent-contrast: light theme swaps in the pale stroke by hand. */
    :host([data-theme="light"]) .edgeFacetMenuItem input:checked {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath fill='none' stroke='%23fff8e8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' d='M3.2 7.2l2.4 2.4 5.2-5.2'/%3E%3C/svg%3E");
    }
    .edgeFacetMenuItem input:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .canvasToast {
      position: absolute;
      left: 50%;
      bottom: 24px;
      transform: translate(-50%, 8px);
      padding: 8px 12px;
      border: 1px solid var(--canvas-rim);
      border-radius: 6px;
      background: var(--canvas-panel);
      color: var(--canvas-text);
      box-shadow: var(--canvas-shadow-pop);
      font: 12px var(--font-mono);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.16s ease, transform 0.16s ease;
      z-index: 30;
    }
    .canvasToast[data-visible="true"] {
      opacity: 1;
      transform: translate(-50%, 0);
    }
    .toastSpinner {
      width: 13px;
      height: 13px;
      box-sizing: border-box;
      border: 2px solid var(--canvas-rim-strong);
      border-top-color: var(--canvas-text);
      border-radius: 999px;
      animation: toastSpin 0.72s linear infinite;
      flex: 0 0 auto;
    }
    .toastText {
      min-width: 0;
    }
    @keyframes toastSpin {
      to { transform: rotate(360deg); }
    }
    .cursorChatInputWrap {
      position: absolute;
      left: 0;
      top: 0;
      z-index: 20;
      pointer-events: auto;
      display: none;
    }
    .cursorChatInputWrap[data-open="true"] {
      display: block;
    }
    .cursorChatInput {
      box-sizing: border-box;
      min-width: 120px;
      max-width: 240px;
      width: 240px;
      max-height: 120px;
      padding: 4px 8px;
      border: none;
      border-radius: 4px;
      font: 400 12px "Geist Mono", "JetBrains Mono", monospace;
      line-height: 1.35;
      /* The background is the author's own collab colour (set inline), so the
         text stays white in both themes, like the cursor labels. */
      color: #fff;
      box-shadow: var(--canvas-shadow-marker);
      outline: none;
      resize: none;
      overflow-y: hidden;
    }
    .fileSettingsPanel {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      z-index: 9;
      width: 280px;
      display: grid;
      grid-template-rows: auto auto auto 1fr auto;
      gap: 0;
      border-right: 1px solid var(--canvas-rim);
      border-radius: 0 0 0 11px;
      background: var(--canvas-panel);
      box-shadow: var(--canvas-shadow-side);
      color: var(--text);
      transform: translateX(-100%);
      opacity: 0;
      pointer-events: none;
      transition: transform 180ms ease, opacity 160ms ease;
      overflow: hidden;
    }
    .fileSettingsPanel[data-open="true"] {
      transform: translateX(0);
      opacity: 1;
      pointer-events: auto;
    }
    .fileSettingsHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--canvas-hairline);
    }
    .fileSettingsTitle {
      font-size: 12px;
      font-weight: 900;
    }
    .fileSettingsClose {
      width: 28px;
      height: 28px;
      display: inline-grid;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--canvas-text-soft);
      font: inherit;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
    }
    .fileSettingsClose:hover {
      background: var(--canvas-fill-hover);
      color: var(--canvas-text-strong);
    }
    .fileSettingsBody {
      min-height: 0;
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: 0;
      overflow: auto;
    }
    .fileSettingsSection {
      padding: 8px 12px 12px;
      border-bottom: 1px solid var(--canvas-hairline);
    }
    .fileSettingsTextarea {
      width: 100%;
      min-height: 96px;
      box-sizing: border-box;
      border: 1px solid var(--canvas-rim);
      border-radius: 2px;
      outline: 0;
      background: var(--canvas-fill);
      color: var(--canvas-text);
      font: inherit;
      font-size: 12px;
      line-height: 1.35;
      padding: 9px;
      resize: vertical;
    }
    .fileSettingsTextarea:focus {
      border-color: var(--canvas-accent-line);
      background: var(--canvas-accent-wash-soft);
      color: var(--canvas-text-strong);
    }
    .fileSettingsTextarea:disabled,
    .panelInput:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .fileSettingsFooter {
      padding: 12px;
    }
    .fileSettingsThumbWrap {
      border-bottom: 1px solid var(--canvas-hairline);
    }
    .fileSettingsThumb {
      position: relative;
      aspect-ratio: 1312 / 640;
      border: 1px solid var(--canvas-rim);
      border-radius: 2px;
      background: var(--canvas-fill);
      overflow: hidden;
    }
    .fileSettingsThumb img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }
    .fileSettingsThumbEmpty {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      padding: 12px;
      color: var(--canvas-text-faint);
      font-size: 11px;
      text-align: center;
    }
    .fileSettingsThumbSpinner {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      background: var(--canvas-veil);
    }
    .fileSettingsThumbSpinner::after {
      content: "";
      width: 20px;
      height: 20px;
      border-radius: 999px;
      border: 2px solid var(--canvas-rim-strong);
      border-top-color: var(--canvas-accent);
      animation: diffuiCanvasStackSpin 760ms linear infinite;
      box-sizing: border-box;
    }
    .fileSettingsThumb[data-state="ready"] .fileSettingsThumbEmpty {
      display: none;
    }
    .fileSettingsThumb[data-state="generating"] .fileSettingsThumbSpinner {
      display: grid;
    }
    .fileSettingsThumb[data-state="generating"] .fileSettingsThumbEmpty {
      display: none;
    }
    .fileSettingsThumb[data-state="empty"] .fileSettingsThumbSpinner,
    .fileSettingsThumb[data-state="ready"] .fileSettingsThumbSpinner {
      display: none;
    }
    .regenerateThumbnailBtn {
      --height: 33px;
      --padding-x: 10px;
    }
  </style>
  <div class="workspace" id="workspace">
    <div class="canvasFrame" id="canvasFrame">
      <canvas id="canvas"></canvas>
      <div class="promptLayer" id="promptLayer"></div>
      <div class="commentLayer" id="commentLayer"></div>
      <div class="commentComposer" id="commentComposer" data-open="false">
        <textarea id="commentComposerInput" rows="3" maxlength="1200" autocomplete="off" spellcheck="true" aria-label="Comment"></textarea>
        <div class="commentComposerActions">
          <diffui-button type="button" id="commentComposerCancel" subtle>Cancel</diffui-button>
          <diffui-button type="button" id="commentComposerPost">Comment</diffui-button>
        </div>
      </div>
      <canvas class="collabCursorCanvas" id="collabCursorCanvas" aria-hidden="true"></canvas>
      <div class="selectionLayer" id="selectionLayer" aria-hidden="true"></div>
      <div class="collabRectLayer" id="collabRectLayer" aria-hidden="true"></div>
      <canvas class="effectCanvas" id="effectCanvas" aria-hidden="true"></canvas>
      <div class="cursorChatInputWrap" id="cursorChatInputWrap" data-open="false">
        <textarea class="cursorChatInput" id="cursorChatInput" rows="1" maxlength="280" autocomplete="off" spellcheck="false" aria-label="Cursor chat"></textarea>
      </div>
      <aside class="fileSettingsPanel" id="fileSettingsPanel" aria-label="File settings" data-open="false">
        <div class="fileSettingsHeader">
          <div class="fileSettingsTitle">File settings</div>
          <button class="fileSettingsClose" id="fileSettingsClose" type="button" aria-label="Close file settings">×</button>
        </div>
        <div class="fileSettingsThumbWrap">
          <div class="fileSettingsThumb" id="fileSettingsThumb" data-state="empty">
            <img id="fileSettingsThumbImg" alt="" hidden />
            <div class="fileSettingsThumbEmpty" id="fileSettingsThumbEmpty">No thumbnail yet</div>
            <div class="fileSettingsThumbSpinner" id="fileSettingsThumbSpinner" hidden></div>
          </div>
        </div>
        <div class="fileSettingsBody">
          <div class="fileSettingsSection">
            <label>
              <span class="panelFieldLabel">Name</span>
              <input class="panelInput" id="fileSettingsName" type="text" autocomplete="off" spellcheck="false" />
            </label>
          </div>
          <div class="fileSettingsSection">
            <label>
              <span class="panelFieldLabel">Description</span>
              <textarea class="fileSettingsTextarea" id="fileSettingsDescription" rows="4" placeholder="What is this file?"></textarea>
            </label>
          </div>
        </div>
        <div class="fileSettingsFooter">
          <diffui-button class="regenerateThumbnailBtn" id="regenerateThumbnailBtn" type="button">Regenerate thumbnail</diffui-button>
        </div>
      </aside>
      <diffui-inpaint-prompt id="inpaintPrompt" hidden></diffui-inpaint-prompt>
    </div>
    <div class="leftTools" role="toolbar" aria-label="Canvas tools">
      <div class="toolCluster" id="toolCluster">
        <button class="toolBtn" id="toolRect" type="button" aria-label="Rectangle">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M2 13H7V14H2L1.89746 13.9951C1.42703 13.9472 1.05278 13.573 1.00488 13.1025L1 13V9H2V13Z" fill="currentColor"/>
            <path d="M15 13C15 13.5523 14.5523 14 14 14H9V13H14V9H15V13Z" fill="currentColor"/>
            <path d="M7 2V3H2V7H1V3C1 2.48232 1.39333 2.05621 1.89746 2.00488L2 2L7 2Z" fill="currentColor"/>
            <path d="M14 2C14.5523 2 15 2.44772 15 3V7H14V3H9V2L14 2Z" fill="currentColor"/>
          </svg>
        </button>
        <button class="toolBtn" id="toolFind" type="button" aria-label="Find">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M14 6C14 3.79086 12.2091 2 10 2C7.79086 2 6 3.79086 6 6C6 8.20914 7.79086 10 10 10V11C7.23858 11 5 8.76142 5 6C5 3.23858 7.23858 1 10 1C12.7614 1 15 3.23858 15 6C15 8.76142 12.7614 11 10 11V10C12.2091 10 14 8.20914 14 6Z" fill="currentColor"/>
            <path d="M1.5 14.5L6.5 9.5" stroke="currentColor"/>
          </svg>
        </button>
        <button class="toolBtn" id="toolMove" type="button" aria-label="Pointer">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M14.9666 3.76268C15.766 3.4629 16.5491 4.23767 16.2576 5.04002L12.0115 16.7187L11.9392 16.876C11.528 17.6106 10.3846 17.5311 10.117 16.6748L8.65213 11.9883C8.56816 11.7199 8.37587 11.5013 8.12479 11.3828L8.01444 11.3379L3.67948 9.89354C2.78548 9.59554 2.76202 8.33873 3.64432 8.0078L14.9666 3.76268ZM3.99588 8.94432L8.33084 10.3896C8.94046 10.593 9.41552 11.077 9.60721 11.6904L11.0711 16.3769L15.3181 4.69822L3.99588 8.94432Z" fill="currentColor"/>
          </svg>
        </button>
        <button class="toolBtn" id="toolEdit" type="button" aria-label="Edit">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M4 15H9V16H4L3.89746 15.9951C3.42703 15.9472 3.05278 15.573 3.00488 15.1025L3 15V11H4V15Z" fill="currentColor"/>
            <path d="M17 15C17 15.5523 16.5523 16 16 16H11V15H16V11H17V15Z" fill="currentColor"/>
            <path d="M9 4V5H4V9H3V5C3 4.48232 3.39333 4.05621 3.89746 4.00488L4 4H9Z" fill="currentColor"/>
            <path d="M11.0427 10.3582L8.16305 11.7536C7.97566 11.8443 7.79122 11.6235 7.91386 11.4553L9.7992 8.86983C9.82307 8.83711 9.84864 8.80575 9.87623 8.77621L11.1485 10.2991C11.1145 10.321 11.0791 10.3406 11.0427 10.3582Z" fill="currentColor"/>
            <path d="M17.4192 3.76743C17.7733 4.19127 17.7168 4.8219 17.2929 5.17599L11.9209 9.66394L10.6387 8.12908L16.0106 3.64114C16.4345 3.28705 17.0651 3.34359 17.4192 3.76743Z" fill="currentColor"/>
          </svg>
        </button>
        <button class="toolBtn" id="toolDuplicate" type="button" aria-label="Duplicate">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M12.9666 1.76268C13.766 1.4629 14.5491 2.23767 14.2576 3.04002L10.0115 14.7187L9.9392 14.876C9.528 15.6106 8.3846 15.5311 8.117 14.6748L6.65213 9.9883C6.56816 9.7199 6.37587 9.5013 6.12479 9.3828L6.01444 9.3379L1.67948 7.89354C0.785479 7.59554 0.762019 6.33873 1.64432 6.0078L12.9666 1.76268ZM1.99588 6.94432L6.33084 8.3896C6.94046 8.593 7.41552 9.077 7.60721 9.6904L9.0711 14.3769L13.3181 2.69822L1.99588 6.94432Z" fill="currentColor"/>
            <path d="M17.9707 5.06553C18.77 4.76578 19.553 5.54061 19.2617 6.34287L15.0156 18.0216L14.9434 18.1788C14.5322 18.9134 13.3887 18.8339 13.1211 17.9776L11.9585 14.2547C11.912 14.1059 11.9376 13.944 12.0277 13.8169C12.2668 13.4794 12.789 13.562 12.9123 13.9568L14.0752 17.6798L18.3223 6.00107L15.5021 7.05812C15.0972 7.20988 14.7036 6.81073 14.8611 6.40802C14.9128 6.27582 15.0183 6.17184 15.1513 6.12203L17.9707 5.06553Z" fill="currentColor"/>
          </svg>
        </button>
        <button class="toolBtn" id="toolComment" type="button" aria-label="Comment">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M8.66699 11V12H4V11H8.66699ZM13 14.2002C12.9999 14.5297 12.624 14.7173 12.3604 14.5195L9.2666 12.2002C9.13672 12.1028 8.98583 12.0385 8.82715 12.0127L8.66699 12V11C9.09938 11.0001 9.5202 11.1401 9.86621 11.3994L12.0977 13.0732L12.1211 12.8193C12.1709 12.2713 12.4412 11.8517 12.7207 11.5576C12.9948 11.2693 13.3176 11.0578 13.5801 10.9082C13.7886 10.7893 14 10.4932 14 10V5C14 3.89543 13.1046 3 12 3H4C2.89543 3 2 3.89543 2 5V9C2 10.1046 2.89543 11 4 11V12C2.34315 12 1 10.6569 1 9V5C1 3.34315 2.34315 2 4 2H12C13.6569 2 15 3.34315 15 5V10C15 10.7735 14.659 11.4446 14.0752 11.7773L13.9072 11.8779C13.5171 12.1256 13.1583 12.4585 13.1172 12.9092L13 14.2002Z" fill="currentColor"/>
          </svg>
        </button>
      </div>
      <diffui-canvas-tool-tooltip id="toolTooltip" hidden></diffui-canvas-tool-tooltip>
      <button class="toolBtn" id="toolFileSettings" type="button" title="File settings" aria-label="File settings" aria-expanded="false" data-active="false">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <g clip-path="url(#canvasFileSettingsClip)">
            <path d="M8 6.5C8.82843 6.5 9.5 7.17157 9.5 8C9.5 8.82843 8.82843 9.5 8 9.5C7.17157 9.5 6.5 8.82843 6.5 8C6.5 7.17157 7.17157 6.5 8 6.5Z" stroke="currentColor"></path>
            <path d="M12.7091 9.90909C12.6244 10.101 12.5991 10.3139 12.6365 10.5204C12.674 10.7268 12.7724 10.9173 12.9191 11.0673L12.9573 11.1055C13.0756 11.2237 13.1695 11.364 13.2335 11.5185C13.2976 11.673 13.3305 11.8387 13.3305 12.0059C13.3305 12.1732 13.2976 12.3388 13.2335 12.4933C13.1695 12.6478 13.0756 12.7882 12.9573 12.9064C12.8391 13.0247 12.6987 13.1186 12.5442 13.1826C12.3897 13.2467 12.2241 13.2796 12.0568 13.2796C11.8896 13.2796 11.7239 13.2467 11.5694 13.1826C11.4149 13.1186 11.2746 13.0247 11.1564 12.9064L11.1182 12.8682C10.9682 12.7215 10.7777 12.6231 10.5713 12.5856C10.3649 12.5482 10.1519 12.5735 9.96 12.6582C9.77178 12.7388 9.61126 12.8728 9.4982 13.0435C9.38513 13.2143 9.32445 13.4143 9.32364 13.6191V13.7273C9.32364 14.0648 9.18955 14.3885 8.95086 14.6272C8.71218 14.8659 8.38846 15 8.05091 15C7.71336 15 7.38964 14.8659 7.15096 14.6272C6.91227 14.3885 6.77818 14.0648 6.77818 13.7273V13.67C6.77325 13.4594 6.70508 13.2551 6.58251 13.0837C6.45994 12.9123 6.28865 12.7818 6.09091 12.7091C5.89897 12.6244 5.68606 12.5991 5.47963 12.6365C5.27319 12.674 5.0827 12.7724 4.93273 12.9191L4.89455 12.9573C4.77634 13.0756 4.63598 13.1695 4.48147 13.2335C4.32696 13.2976 4.16135 13.3305 3.99409 13.3305C3.82683 13.3305 3.66122 13.2976 3.50671 13.2335C3.35221 13.1695 3.21184 13.0756 3.09364 12.9573C2.9753 12.8391 2.88143 12.6987 2.81738 12.5442C2.75333 12.3897 2.72036 12.2241 2.72036 12.0568C2.72036 11.8896 2.75333 11.7239 2.81738 11.5694C2.88143 11.4149 2.9753 11.2746 3.09364 11.1564L3.13182 11.1182C3.27852 10.9682 3.37694 10.7777 3.41437 10.5713C3.4518 10.3649 3.42653 10.1519 3.34182 9.96C3.26115 9.77178 3.12721 9.61126 2.95648 9.4982C2.78575 9.38513 2.58568 9.32445 2.38091 9.32364H2.27273C1.93518 9.32364 1.61146 9.18955 1.37277 8.95086C1.13409 8.71218 1 8.38846 1 8.05091C1 7.71336 1.13409 7.38964 1.37277 7.15096C1.61146 6.91227 1.93518 6.77818 2.27273 6.77818H2.33C2.54063 6.77325 2.74491 6.70508 2.91628 6.58251C3.08765 6.45994 3.21818 6.28865 3.29091 6.09091C3.37562 5.89897 3.40089 5.68606 3.36346 5.47963C3.32603 5.27319 3.22761 5.0827 3.08091 4.93273L3.04273 4.89455C2.92439 4.77634 2.83052 4.63598 2.76647 4.48147C2.70242 4.32696 2.66945 4.16135 2.66945 3.99409C2.66945 3.82683 2.70242 3.66122 2.76647 3.50671C2.83052 3.35221 2.92439 3.21184 3.04273 3.09364C3.16093 2.9753 3.3013 2.88143 3.4558 2.81738C3.61031 2.75333 3.77593 2.72036 3.94318 2.72036C4.11044 2.72036 4.27605 2.75333 4.43056 2.81738C4.58507 2.88143 4.72543 2.9753 4.84364 3.09364L4.88182 3.13182C5.0318 3.27852 5.22228 3.37694 5.42872 3.41437C5.63515 3.4518 5.84806 3.42653 6.04 3.34182H6.09091C6.27913 3.26115 6.43965 3.12721 6.55271 2.95648C6.66578 2.78575 6.72646 2.58568 6.72727 2.38091V2.27273C6.72727 1.93518 6.86136 1.61146 7.10005 1.37277C7.33873 1.13409 7.66245 1 8 1C8.33755 1 8.66127 1.13409 8.89995 1.37277C9.13864 1.61146 9.27273 1.93518 9.27273 2.27273V2.33C9.27354 2.53477 9.33422 2.73484 9.44729 2.90557C9.56035 3.0763 9.72087 3.21024 9.90909 3.29091C10.101 3.37562 10.3139 3.40089 10.5204 3.36346C10.7268 3.32603 10.9173 3.22761 11.0673 3.08091L11.1055 3.04273C11.2237 2.92439 11.364 2.83052 11.5185 2.76647C11.673 2.70242 11.8387 2.66945 12.0059 2.66945C12.1732 2.66945 12.3388 2.70242 12.4933 2.76647C12.6478 2.83052 12.7882 2.92439 12.9064 3.04273C13.0247 3.16093 13.1186 3.3013 13.1826 3.4558C13.2467 3.61031 13.2796 3.77593 13.2796 3.94318C13.2796 4.11044 13.2467 4.27605 13.1826 4.43056C13.1186 4.58507 13.0247 4.72543 12.9064 4.84364L12.8682 4.88182C12.7215 5.0318 12.6231 5.22228 12.5856 5.42872C12.5482 5.63515 12.5735 5.84806 12.6582 6.04V6.09091C12.7388 6.27913 12.8728 6.43965 13.0435 6.55271C13.2143 6.66578 13.4143 6.72646 13.6191 6.72727H13.7273C14.0648 6.72727 14.3885 6.86136 14.6272 7.10005C14.8659 7.33873 15 7.66245 15 8C15 8.33755 14.8659 8.66127 14.6272 8.89995C14.3885 9.13864 14.0648 9.27273 13.7273 9.27273H13.67C13.4652 9.27354 13.2652 9.33422 13.0944 9.44729C12.9237 9.56035 12.7898 9.72087 12.7091 9.90909Z" stroke="currentColor"></path>
          </g>
          <defs>
            <clipPath id="canvasFileSettingsClip">
              <rect width="16" height="16" fill="white"></rect>
            </clipPath>
          </defs>
        </svg>
      </button>
    </div>
    <div class="findBox" id="findBox" hidden>
      <div class="findTitle">Find node</div>
      <input id="findInput" type="search" placeholder="Search prompts, names, metadata" />
    </div>
    <div class="inspector" id="inspector" hidden>
      <div class="panelSection">
        <label>
          <span class="panelFieldLabel">Name</span>
          <input class="panelInput" id="inspectorNameInput" type="text" autocomplete="off" spellcheck="false" />
        </label>
      </div>
      <div class="panelSection">
        <div class="panelLabelRow">
          <div class="panelLabel">Dimensions</div>
        </div>
        <div class="panelDimGrid">
          <label>
            <span class="panelFieldLabel">Width</span>
            <span class="panelFieldValue" id="inspectorWidth">-</span>
          </label>
          <label>
            <span class="panelFieldLabel">Height</span>
            <span class="panelFieldValue" id="inspectorHeight">-</span>
          </label>
          <span class="panelLock" title="Aspect ratio locked" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none">
              <rect x="4" y="7" width="8" height="6" rx="1.2" stroke="currentColor" stroke-width="1.2"/>
              <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
          </span>
        </div>
      </div>
      <div class="panelSection">
        <div class="panelLabelRow">
          <div class="panelLabel">Input Images</div>
          <span class="panelValue" id="inspectorInputCount">0</span>
        </div>
        <div class="panelThumbs" id="inspectorInputs"></div>
      </div>
      <div class="panelSection" id="inspectorBrandSection" hidden>
        <div class="panelLabelRow">
          <div class="panelLabel">Brand</div>
        </div>
        <div class="panelBrandUsed">
          <span class="panelBrandLogo" id="inspectorBrandLogo"></span>
          <span class="panelBrandName" id="inspectorBrandName"></span>
        </div>
      </div>
      <div class="panelSection" id="inspectorBrandInputsSection" hidden>
        <div class="panelLabelRow">
          <div class="panelLabel">Brand Inputs</div>
          <span class="panelValue" id="inspectorBrandInputCount">0</span>
        </div>
        <div class="panelThumbs" id="inspectorBrandInputs"></div>
      </div>
      <div class="panelSection" data-flex="true">
        <div class="panelLabelRow">
          <div class="panelLabel">Prompt</div>
          <button class="copyJsonBtn" id="copyPromptJson" type="button">Copy JSON</button>
        </div>
        <pre class="promptJson" id="inspectorPrompt">-</pre>
      </div>
      <div class="panelSection">
        <diffui-button class="variantButton" id="generateVariantBtn" type="button">Generate Variant</diffui-button>
      </div>
    </div>
    <div class="nodeContextMenu" id="nodeContextMenu" role="menu" aria-hidden="true" data-open="false">
      <button type="button" class="nodeContextMenuItem" data-action="rename-node">Rename</button>
      <button type="button" class="nodeContextMenuItem" data-action="ask-edits">Ask for edits</button>
      <div class="nodeContextMenuDivider" role="separator"></div>
      <button type="button" class="nodeContextMenuItem" data-action="copy-image">Copy image</button>
      <button type="button" class="nodeContextMenuItem" data-action="download-image">Download image</button>
      <button type="button" class="nodeContextMenuItem" data-action="copy-prompt">Copy prompt</button>
      <button type="button" class="nodeContextMenuItem" data-action="copy-for-agent">Copy for agent</button>
      <button type="button" class="nodeContextMenuItem" data-action="build-with-bb" data-ui-hidden="true">Build with bb</button>
      <button type="button" class="nodeContextMenuItem" data-action="copy-json" data-ui-hidden="true">Copy json</button>
      <button type="button" class="nodeContextMenuItem" data-action="create-brand-from-selection" hidden>Create brand</button>
      <div class="nodeContextMenuDivider" role="separator"></div>
      <button type="button" class="nodeContextMenuItem" data-action="add-to-brand">Add to brand</button>
      <button type="button" class="nodeContextMenuItem" data-action="delete-node">Delete node</button>
    </div>
    <div class="edgeFacetMenu" id="edgeFacetMenu" role="menu" aria-hidden="true" data-open="false">
      <div class="edgeFacetMenuTitle">Input data</div>
      <label class="edgeFacetMenuItem"><input type="checkbox" data-facet="pixels" /> pixel data</label>
      <label class="edgeFacetMenuItem"><input type="checkbox" data-facet="subjects" /> subjects</label>
      <label class="edgeFacetMenuItem"><input type="checkbox" data-facet="composition" /> composition</label>
      <label class="edgeFacetMenuItem"><input type="checkbox" data-facet="style" /> style</label>
      <label class="edgeFacetMenuItem"><input type="checkbox" data-facet="theme" /> theme</label>
      <label class="edgeFacetMenuItem"><input type="checkbox" data-facet="palette" /> palette</label>
    </div>
    <div class="canvasToast" id="canvasToast" role="status" aria-live="polite" data-visible="false"></div>
  </div>
`;

export class DiffuiCanvasWorkspace extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this._projectId = "";
    this._engine = null;
    this._ctx = null;
    this._effectCtx = null;
    this._tool = TOOL_POINTER;
    // The toolbar can show Duplicate as picked while `_tool` stays the pointer.
    this._selectedTool = TOOL_POINTER;
    this._duplicateTool = false;
    this._toolTooltips = null;
    this._state = { version: 1, viewport: { x: 0, y: 0, scale: 1 }, nodes: [], edges: [], metadata: {} };
    this._comments = [];
    this._pointer = null;
    this._commentDragMoveHandler = (event) => this._onCommentDragWindowMove(event);
    this._commentDragEndHandler = (event) => this._onCommentDragWindowEnd(event);
    this._dragPort = null;
    this._images = new Map();
    /** Analysis results that arrived before their node carried the asset id. */
    this._pendingAssetAnalysis = new Map();
    /** In-flight paste/drop asset uploads, by the node already showing them. */
    this._pendingImageUploads = new Map();
    this._saveTimer = 0;
    this._ws = null;
    this._wsProjectId = "";
    this._wsReconnectTimer = 0;
    this._wsReconnectAttempt = 0;
    this._wsLastCloseEvent = null;
    this._wsConnectedAt = 0;
    this._wsLastEvent = "";
    this._activeCanvasGenerationNodeIds = new Set();
    this._failedGenerationRequestIds = new Set();
    this._maxOptionPriceCents = 0;
    this._maxOptionPriceFetchedAt = 0;
    this._maxOptionPricePromise = null;
    this._billingWalletCents = 0;
    this._billingWorkspaceId = "";
    this._bound = false;
    this._lastFind = "";
    this._spacePan = false;
    this._shiftHeld = false;
    this._openToken = 0;
    this._viewportAnimation = 0;
    this._resizeObserver = null;
    this._analysisAnimation = 0;
    this._zoomingTimer = 0;
    this._stackScrollDirectionByNode = new Map();
    this._lastStackIndexByNode = new Map();
    this._stackDirectionClearTimers = new Map();
    this._collabPeerStackAt = new Map();
    this._stackFrameKeySeq = 0;
    this._promptReplaceStackTimers = new Map();
    this._promptTypingAnimations = new Map();
    this._promptTypingTextByNode = new Map();
    this._projectFileTitle = "";
    this._projectFileDescription = "";
    this._projectAgentTarget = "";
    // Live bb bridge state, fetched once per canvas open (the socket itself
    // lives between the diffui-bb plugin and the server, not in this page).
    this._bbBridgeConnected = false;
    this._bbLocalEndpoint = null;
    this._projectThumbnailUrl = "";
    this._projectThumbnailStatus = "";
    this._projectThumbnailCacheKey = 0;
    this._fileSettingsOpen = false;
    this._fileSettingsSaveTimer = 0;
    this._fileSettingsDraft = { name: "", description: "" };
    this._thumbnailRegenerating = false;
    this._suggestedFileTitle = "";
    this._clickEffects = [];
    this._clickEffectAnimation = 0;
    this._hoverNodeId = "";
    this._hoverEdgeId = "";
    this._altKeyHeld = false;
    this._showInspectorOnImageSelect = false;
    this._nodeContextMenuState = null;
    this._edgeFacetMenuState = null;
    this._nodeRenameNodeId = "";
    this._inpaint = null;
    this._promptMentionState = null;
    this._promptEditBeforeInput = new Map();
    this._promptSuggestionChoicesByNode = new Map();
    this._canvasMetadata = {};
    this._promptSuggestionTimer = 0;
    this._promptSuggestionRequestSeq = 0;
    this._lastPromptSuggestionContextKey = "";
    // Next-page placeholder suggestions, keyed by the source image id so a
    // second drag off the same screen reuses the first answer.
    this._nextPageSuggestionsByImageId = new Map();
    this._nextPageSuggestionsInFlight = null;
    this._nextPagePlaceholder = null;
    this._nextPagePlaceholderTimer = 0;
    this._nextPagePlaceholderSeq = 0;
    this._nextPagePlaceholderPendingImageId = "";
    this._brands = [];
    this._brandId = "";
    this._selectedRouteNodeId = null;
    this._suppressSelectionRouteEvent = false;
    this._promptFileDragHoverId = "";
    this._fileDragEndBound = null;
    this._agentCursors = new Map();
    this._agentCursorAnimation = 0;
    this._collabCursors = new Map();
    this._collabCursorAnimation = 0;
    this._collabAwarenessTimer = 0;
    this._pendingCollabAwareness = null;
    this._collabSyncTimer = 0;
    this._crdt = null;
    this._collab = null;
    this._collabPeers = new Map();
    this._collabClickEffectSeen = new Map();
    this._pendingCollabClickEffect = null;
    this._collabClientSessionId = this._createCollabClientSessionId();
    this._canvasAccess = "owner";
    this._canvasOwnerUserId = "";
    this._canvasAnonymousViewer = false;
    this._collabConnected = false;
    this._collabApplyingRemote = false;
    this._collabDocReady = false;
    this._collabPromptFlushTimer = 0;
    this._collabLastFullSyncAt = 0;
    this._collabPeerMoveAt = new Map();
    this._collabMoveSmoothTargets = new Map();
    this._collabPortSmoothTargets = new Map();
    this._collabPeerRects = new Map();
    this._collabPeerRectAt = new Map();
    this._collabGestureSmoothRaf = 0;
    this._collabApplyingRemoteMove = false;
    this._collabLocalDirty = false;
    this._collabPendingCommit = false;
    this._collabInactivityTimer = 0;
    this._collabPausedForInactivity = false;
    this._collabInactivityWired = false;
    this._collabActivityMoveAt = 0;
    this._pendingRemoteCanvasState = null;
    this._lastCollabPushedRaw = "";
    this._restSaveTimer = 0;
    this._viewerCommentsSaveTimer = 0;
    this._lastViewerCommentsJSON = "";
    this._lastSavedStateJSON = "";
    // Document version the last save was based on; 0 means "not read yet", which
    // writes unconditionally.
    this._canvasVersion = 0;
    // Saves are serialised: two PUTs in flight from this tab carry the same
    // baseVersion and the later one is guaranteed to lose the compare-and-set.
    this._saveQueue = new CanvasSaveQueue(() => this._writeCanvasState());
    this._lastPointerWorld = null;
    this._cursorChat = null;
    this._commentDraft = null;
    this._renderFrame = 0;
    this._pendingDraw = false;
    this._pendingOverlaySync = false;
    this._pendingReposition = false;
    this._nodeMetaCache = new WeakMap();
    this._canvasRect = null;
    this._canvasCoachActive = false;
    this._canvasCoachSyncFrame = 0;
    this._coachPortDemo = null;
    this._theme = canvasThemeFromRoot(document.documentElement);
    this._palette = canvasDrawPalette(this._theme);
    this._themeObserver = null;
  }

  connectedCallback() {
    if (window.DIFFUI_EMBED) this.setAttribute("data-embed", "true");
    this._syncTheme();
    this._observeTheme();
    this._wireOnce();
    this._resizeCanvas();
    this._draw();
  }

  /**
   * Mirror the app theme onto the host, so the shadow CSS can reach the few
   * cases a token cannot express (an inline SVG stroke, for one), and refresh
   * the palette the 2D drawing code paints with.
   */
  _syncTheme() {
    const theme = canvasThemeFromRoot(document.documentElement);
    const previous = this._palette;
    this._theme = theme;
    this._palette = resolveCanvasDrawPalette(theme, this);
    const changed = this._palette !== previous || this.getAttribute("data-theme") !== theme;
    if (this.getAttribute("data-theme") !== theme) this.setAttribute("data-theme", theme);
    if (changed && this._ctx) this._scheduleDraw();
  }

  /**
   * Re-read the theme and the drawn-colour tokens. An embedder whose own theme
   * changed without touching this document's `data-app-theme` (the bb plugin
   * follows its host's tokens) calls this to repaint the 2D half.
   */
  refreshTheme() {
    this._syncTheme();
  }

  _observeTheme() {
    if (this._themeObserver) return;
    this._themeObserver = new MutationObserver(() => this._syncTheme());
    this._themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-app-theme"],
    });
  }

  disconnectedCallback() {
    this._themeObserver?.disconnect();
    this._themeObserver = null;
    window.removeEventListener("resize", this._resizeBound);
    window.removeEventListener("keydown", this._keyBound);
    window.removeEventListener("keyup", this._keyUpBound);
    window.removeEventListener("blur", this._blurBound);
    document.removeEventListener("click", this._contextMenuClickAwayBound);
    document.removeEventListener("click", this._promptResolutionClickAwayBound);
    document.removeEventListener("click", this._promptMentionClickAwayBound);
    document.removeEventListener("keydown", this._contextMenuKeyBound);
    window.removeEventListener("resize", this._contextMenuCloseBound);
    window.removeEventListener("scroll", this._contextMenuCloseBound, true);
    if (this._fileDragEndBound) window.removeEventListener("dragend", this._fileDragEndBound);
    this._fileDragEndBound = null;
    this._setPromptFileDragHover("");
    this._toolTooltips?.destroy();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    window.cancelAnimationFrame(this._renderFrame);
    this._renderFrame = 0;
    window.cancelAnimationFrame(this._canvasCoachSyncFrame);
    this._canvasCoachSyncFrame = 0;
    this._coachPortDemo = null;
    this._pendingDraw = false;
    this._pendingOverlaySync = false;
    this._pendingReposition = false;
    window.cancelAnimationFrame(this._analysisAnimation);
    this._analysisAnimation = 0;
    window.cancelAnimationFrame(this._clickEffectAnimation);
    this._clickEffectAnimation = 0;
    this._clickEffects = [];
    window.clearTimeout(this._zoomingTimer);
    this._zoomingTimer = 0;
    this._promptReplaceStackTimers.forEach((timer) => window.clearTimeout(timer));
    this._promptReplaceStackTimers.clear();
    this._promptTypingAnimations.forEach((animation) => window.cancelAnimationFrame(animation.frame));
    this._promptTypingAnimations.clear();
    this._promptTypingTextByNode.clear();
    this._promptEditBeforeInput.clear();
    this._promptSuggestionChoicesByNode.clear();
    window.clearTimeout(this._promptSuggestionTimer);
    this._promptSuggestionTimer = 0;
    this._stopNextPagePlaceholderCycle();
    this._abortNextPageSuggestionsRequest();
    this._nextPageSuggestionsByImageId.clear();
    window.clearTimeout(this._fileSettingsSaveTimer);
    this._fileSettingsSaveTimer = 0;
    window.clearTimeout(this._viewerCommentsSaveTimer);
    this._viewerCommentsSaveTimer = 0;
    window.cancelAnimationFrame(this._agentCursorAnimation);
    this._agentCursorAnimation = 0;
    this._agentCursors.clear();
    this._collabCursors.clear();
    this._removeCommentDragWindowListeners();
    this._cancelCommentDraft();
    this._cancelCursorChat();
    this._closeSocket();
    this._teardownCollab();
  }

  async openProject(projectId, options = {}) {
    if (!projectId) return;
    const openToken = (this._openToken += 1);
    const focusNodeId = String(options.focusNodeId || "").trim();
    this._suggestedFileTitle = "";
    await initCanvasWasm();
    if (!this._engine) this._engine = new CanvasEngine();
    this._activeCanvasGenerationNodeIds.clear();
    if (this._projectId !== projectId) {
      // Price is per space, so a project from another team must not inherit the cached rate.
      this._maxOptionPriceCents = 0;
      this._maxOptionPriceFetchedAt = 0;
    }
    this._projectId = projectId;
    await this._loadBrands();
    const data = await this._api(`/api/projects/${encodeURIComponent(projectId)}/canvas`);
    this._canvasAccess = String(data?.access || "owner");
    this._canvasOwnerUserId = String(data?.ownerUserId || "");
    this._canvasAnonymousViewer = data?.anonymous === true;
    this._setProjectThumbnail(data?.thumbnailUrl || "", data?.thumbnailStatus || "");
    this._syncAccessRestrictedUI();
    this._syncFileSettingsEditableState();
    const state = data?.canvas?.state || safeParse(data?.canvas?.stateJson) || this._state;
    this._canvasVersion = Number(data?.canvas?.version) || 0;
    this._comments = this._normalizeCanvasComments(state?.comments);
    this._canvasMetadata = this._normalizeCanvasMetadata(state?.metadata);
    this._suppressSelectionRouteEvent = true;
    this._engine.load(JSON.stringify(state));
    this._syncStateFromEngine();
    this._lastSavedStateJSON = JSON.stringify({ ...this._state, metadata: this._normalizeCanvasMetadata(this._canvasMetadata) });
    await nextFrame();
    if (openToken !== this._openToken) {
      this._suppressSelectionRouteEvent = false;
      return;
    }
    this._resizeCanvas();
    const shouldPrepareInitialCanvas = this._isInitialCanvasState(this._state);
    if (shouldPrepareInitialCanvas) {
      await nextFrame();
      if (openToken !== this._openToken) {
        this._suppressSelectionRouteEvent = false;
        return;
      }
      this._resizeCanvas();
      this._prepareInitialCanvas();
      this._queueSave();
    }
    if (focusNodeId && !this._focusRouteNode(focusNodeId)) this._clearRouteSelection();
    this._suppressSelectionRouteEvent = false;
    if (focusNodeId) this._emitSelectionRouteChangeIfNeeded({ force: true });
    else this._selectedRouteNodeId = this._routeSelectedNodeId();
    this._ensureSocket();
    await this._initCollab(state);
    this._setStatus("Pointer tool");
    this._syncPromptOverlays();
    this._syncCommentLayer();
    this._draw();
    this._ensureCanvasPromptSuggestionsOnLoad();
    this._startSeedPlaceholderCycleIfNeeded();
    this._notifyCanvasCoach("opened");
    // Warm the affordability clamp so the first generate click does not wait on it.
    this._loadMaxOptionPriceCents().catch(() => null);
    this._refreshBbBridgeStatus().catch(() => null);
  }

  // Asks the server whether this user's bb (getbb.app) plugin is holding a
  // bridge open. Decides whether the context menus offer "Build with bb" on
  // canvases that were not created for bb, and captures the plugin's direct
  // build endpoint (loopback URL + plugin token) when bb shared one, so the
  // dispatch can try the browser→localhost CORS path before the relay.
  // Anonymous share viewers have no account to bridge from, so they skip the
  // request entirely.
  async _refreshBbBridgeStatus() {
    if (!this._bbHost() || this._canvasAnonymousViewer) {
      this._bbBridgeConnected = false;
      this._bbLocalEndpoint = null;
      return;
    }
    try {
      const status = await this._api("/api/bb/bridge/status");
      this._bbBridgeConnected = status?.connected === true;
      const endpoint = status?.localEndpoint;
      this._bbLocalEndpoint = endpoint?.url && endpoint?.token
        ? { url: String(endpoint.url), token: String(endpoint.token) }
        : null;
    } catch {
      this._bbBridgeConnected = false;
      this._bbLocalEndpoint = null;
    }
  }

  // "Build with bb" belongs to the bb plugin, not to diffui.com — and this
  // copy of the canvas is the plugin's, so the host is a given. It shows on
  // canvases created for bb always (offline clicks explain themselves), and on
  // any other canvas once a bridge is live.
  _bbBuildAvailable() {
    if (!this._bbHost()) return false;
    if (this._canvasAnonymousViewer) return false;
    return this._projectAgentTarget === "bb" || this._bbBridgeConnected;
  }

  // True only when this canvas is running inside the bb plugin. Upstream reads
  // window.DIFFUI_BB_HOST here because diffui.ai serves the same module to
  // everyone; this copy ships inside the plugin and has no other host, so the
  // answer is always yes and bb-only actions need no global to switch them on.
  _bbHost() {
    return true;
  }

  setProjectFileTitle(title = "") {
    this._projectFileTitle = String(title || "").trim();
    this._syncFileSettingsForm();
  }

  setProjectFileDescription(description = "") {
    this._projectFileDescription = String(description || "").trim();
    this._syncFileSettingsForm();
  }

  setProjectMetadata({ displayName, description, agentTarget } = {}) {
    if (displayName != null) this._projectFileTitle = String(displayName || "").trim();
    if (description != null) this._projectFileDescription = String(description || "").trim();
    if (agentTarget != null) this._projectAgentTarget = String(agentTarget || "").trim();
    this._syncFileSettingsForm();
  }

  setProjectThumbnail(url = "", status = "") {
    this._setProjectThumbnail(url, status);
  }

  _setProjectThumbnail(url = "", status = "", { bustCache = false } = {}) {
    const nextUrl = String(url || "").trim();
    const prevUrl = this._projectThumbnailUrl;
    this._projectThumbnailUrl = nextUrl;
    this._projectThumbnailStatus = String(status || "").trim();
    if (bustCache || (nextUrl && nextUrl !== prevUrl)) {
      this._projectThumbnailCacheKey = Date.now();
    }
    this._syncFileSettingsThumbnail();
  }

  _syncFileSettingsThumbnail() {
    const wrap = this.shadowRoot.getElementById("fileSettingsThumb");
    const img = this.shadowRoot.getElementById("fileSettingsThumbImg");
    if (!wrap || !img) return;
    const generating = this._thumbnailRegenerating
      || this._projectThumbnailStatus === "generating"
      || this._projectThumbnailStatus === "scheduled";
    const url = resolveEmbedAssetUrl(this._projectThumbnailUrl);
    let state = "empty";
    if (generating) state = "generating";
    else if (url) state = "ready";
    if (wrap.dataset.state !== state) wrap.dataset.state = state;
    if (url) {
      const nextSrc = `${url}${url.includes("?") ? "&" : "?"}v=${this._projectThumbnailCacheKey || 0}`;
      if (img.dataset.loadedSrc !== nextSrc) {
        img.dataset.loadedSrc = nextSrc;
        img.src = nextSrc;
      }
      img.hidden = false;
      return;
    }
    if (img.dataset.loadedSrc) {
      img.removeAttribute("src");
      delete img.dataset.loadedSrc;
    }
    img.hidden = true;
  }

  _syncFileSettingsForm() {
    const panel = this.shadowRoot.getElementById("fileSettingsPanel");
    if (!panel) return;
    const nameInput = this.shadowRoot.getElementById("fileSettingsName");
    const descInput = this.shadowRoot.getElementById("fileSettingsDescription");
    const draftName = String(this._fileSettingsDraft?.name ?? "");
    const draftDesc = String(this._fileSettingsDraft?.description ?? "");
    if (nameInput && document.activeElement !== nameInput) {
      nameInput.value = this._projectFileTitle;
      this._fileSettingsDraft.name = this._projectFileTitle;
    } else if (nameInput && draftName !== nameInput.value) {
      this._fileSettingsDraft.name = nameInput.value;
    }
    if (descInput && document.activeElement !== descInput) {
      descInput.value = this._projectFileDescription;
      this._fileSettingsDraft.description = this._projectFileDescription;
    } else if (descInput && draftDesc !== descInput.value) {
      this._fileSettingsDraft.description = descInput.value;
    }
    this._syncFileSettingsEditableState();
  }

  _syncFileSettingsEditableState() {
    const canEdit = this._canEditCollab();
    const nameInput = this.shadowRoot.getElementById("fileSettingsName");
    const descInput = this.shadowRoot.getElementById("fileSettingsDescription");
    const regenBtn = this.shadowRoot.getElementById("regenerateThumbnailBtn");
    if (nameInput) nameInput.disabled = !canEdit;
    if (descInput) descInput.disabled = !canEdit;
    if (regenBtn) regenBtn.disabled = !canEdit || this._thumbnailRegenerating;
  }

  _syncAccessRestrictedUI() {
    const canEdit = this._canEditCollab();
    const canComment = this._canCommentCollab();
    this.dataset.viewOnly = canEdit ? "false" : "true";
    this.dataset.anonymousViewer = this._canvasAnonymousViewer ? "true" : "false";
    const toolRect = this.shadowRoot.getElementById("toolRect");
    const toolEdit = this.shadowRoot.getElementById("toolEdit");
    const toolDuplicate = this.shadowRoot.getElementById("toolDuplicate");
    const toolSettings = this.shadowRoot.getElementById("toolFileSettings");
    const toolComment = this.shadowRoot.getElementById("toolComment");
    if (toolRect) toolRect.hidden = !canEdit;
    if (toolEdit) toolEdit.hidden = !canEdit;
    if (toolDuplicate) toolDuplicate.hidden = !canEdit;
    if (toolSettings) toolSettings.hidden = !canEdit;
    if (toolComment) toolComment.hidden = !canComment;
    if (!canEdit && EDIT_ONLY_TOOLS.includes(this._selectedTool)) this._setTool(TOOL_POINTER);
    if (!canComment && this._tool === TOOL_COMMENT) this._setTool(TOOL_POINTER);
    if (!canEdit && this._fileSettingsOpen) this._toggleFileSettings(false);
    this._syncCommentLayer();
    this.dispatchEvent(
      new CustomEvent("diffui-canvas:access", {
        bubbles: true,
        composed: true,
        detail: { access: this._canvasAccess, canShare: canEdit },
      }),
    );
  }

  _toggleFileSettings(open) {
    const nextOpen = typeof open === "boolean" ? open : !this._fileSettingsOpen;
    this._fileSettingsOpen = nextOpen;
    const panel = this.shadowRoot.getElementById("fileSettingsPanel");
    const btn = this.shadowRoot.getElementById("toolFileSettings");
    panel?.setAttribute("data-open", nextOpen ? "true" : "false");
    btn?.setAttribute("data-active", nextOpen ? "true" : "false");
    btn?.setAttribute("aria-expanded", nextOpen ? "true" : "false");
    if (nextOpen) {
      this._syncFileSettingsForm();
      this._syncFileSettingsThumbnail();
    }
  }

  _queueFileSettingsSave() {
    window.clearTimeout(this._fileSettingsSaveTimer);
    this._fileSettingsSaveTimer = window.setTimeout(() => {
      this._fileSettingsSaveTimer = 0;
      this._saveFileSettings().catch((error) => {
        this._setStatus(error.message || "File settings save failed");
      });
    }, 450);
  }

  async _saveFileSettings() {
    if (!this._projectId || !this._canEditCollab()) return;
    const nameInput = this.shadowRoot.getElementById("fileSettingsName");
    const descInput = this.shadowRoot.getElementById("fileSettingsDescription");
    const display_name = String(nameInput?.value || "").trim();
    const description = String(descInput?.value || "").trim();
    const prevName = String(this._projectFileTitle || "").trim();
    const prevDesc = String(this._projectFileDescription || "").trim();
    if (display_name === prevName && description === prevDesc) return;
    await this._api(`/api/projects/${encodeURIComponent(this._projectId)}`, {
      method: "PATCH",
      body: JSON.stringify({ display_name, description }),
    });
    this._projectFileTitle = display_name;
    this._projectFileDescription = description;
    this._fileSettingsDraft = { name: display_name, description };
    if (display_name !== prevName) {
      this.dispatchEvent(
        new CustomEvent("diffui-canvas:file-title", {
          bubbles: true,
          composed: true,
          detail: { title: display_name },
        }),
      );
    }
    this.dispatchEvent(
      new CustomEvent("diffui-canvas:file-metadata", {
        bubbles: true,
        composed: true,
        detail: { displayName: display_name, description },
      }),
    );
  }

  async _regenerateFileThumbnail() {
    if (!this._projectId || !this._canEditCollab() || this._thumbnailRegenerating) return;
    await this._saveFileSettings().catch(() => null);
    const regenBtn = this.shadowRoot.getElementById("regenerateThumbnailBtn");
    this._thumbnailRegenerating = true;
    this._projectThumbnailStatus = "generating";
    regenBtn?.setAttribute("state", "in-progress");
    this._syncFileSettingsEditableState();
    this._syncFileSettingsThumbnail();
    try {
      await this._api(`/api/projects/${encodeURIComponent(this._projectId)}/canvas/thumbnail/regenerate`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      this._setStatus("Regenerating thumbnail…");
    } catch (error) {
      this._thumbnailRegenerating = false;
      regenBtn?.setAttribute("state", "default");
      this._syncFileSettingsEditableState();
      this._setStatus(error.message || "Thumbnail regeneration failed");
    }
  }

  _finishThumbnailRegeneration({ success = true, message = "", thumbnailUrl = "" } = {}) {
    this._thumbnailRegenerating = false;
    const regenBtn = this.shadowRoot.getElementById("regenerateThumbnailBtn");
    regenBtn?.setAttribute("state", "default");
    if (success) {
      this._setProjectThumbnail(thumbnailUrl || this._projectThumbnailUrl, "ready", { bustCache: true });
    } else if (!this._projectThumbnailUrl) {
      this._projectThumbnailStatus = "error";
    }
    this._syncFileSettingsEditableState();
    this._syncFileSettingsThumbnail();
    if (message) this._setStatus(message);
    else if (success) this._setStatus("Thumbnail updated");
  }

  async _loadBrands() {
    // Brands are account-scoped; a signed-out share viewer has none.
    if (isPublicShareViewer()) {
      this._brands = [];
      this._brandId = "";
      return;
    }
    try {
      const qs = this._billingWorkspaceId
        ? `?workspaceId=${encodeURIComponent(this._billingWorkspaceId)}&teamShared=1`
        : "";
      // Embedded, this has to carry the api key to Diffui's origin like every
      // other read; a same-origin app keeps its session cookie.
      const brandsPath = `/api/brands${qs}`;
      const embed = window.DIFFUI_EMBED === true;
      const res = await fetch(embed ? resolveEmbedApiUrl(brandsPath) : brandsPath, {
        credentials: embed ? "omit" : "include",
        ...(embed ? { headers: embedFetchHeaders() } : {}),
      });
      if (!res.ok) {
        this._brands = [];
        this._brandId = "";
        return;
      }
      const data = await res.json();
      this._brands = Array.isArray(data.brands) ? data.brands : [];
      if (this._brandId && !this._brands.some((brand) => brand.id === this._brandId)) {
        this._brandId = "";
      }
    } catch {
      this._brands = [];
      this._brandId = "";
    }
  }

  _wireOnce() {
    if (this._bound) return;
    this._bound = true;
    this._resizeBound = () => {
      this._resizeCanvas();
      this._draw();
      this._syncPromptOverlays();
    };
    this._keyBound = (event) => this._onKeyDown(event);
    this._keyUpBound = (event) => this._onKeyUp(event);
    this._blurBound = () => {
      this._stopSpacePan();
      this._setShiftHeld(false);
      this._setAltKeyHeld(false);
      this._toolTooltips?.dismiss();
    };
    this._contextMenuClickAwayBound = (event) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (path.some((el) => el instanceof HTMLElement && (
        el.id === "nodeContextMenu" || el.id === "edgeFacetMenu" ||
        el.classList?.contains("nodeContextMenu") || el.classList?.contains("edgeFacetMenu")
      ))) {
        return;
      }
      this._closeNodeContextMenu();
      this._closeEdgeFacetMenu();
    };
    this._promptResolutionClickAwayBound = (event) => this._closePromptResolutionDropdowns(event);
    this._promptMentionClickAwayBound = (event) => this._closePromptMentionMenus(event);
    this._contextMenuKeyBound = (event) => {
      if (event.key === "Escape") {
        this._closeNodeContextMenu();
        this._closeEdgeFacetMenu();
        this._closePromptResolutionDropdowns();
        this._closePromptMentionMenus();
      }
    };
    this._contextMenuCloseBound = () => {
      this._closeNodeContextMenu();
      this._closeEdgeFacetMenu();
    };
    window.addEventListener("resize", this._resizeBound);
    window.addEventListener("keydown", this._keyBound);
    window.addEventListener("keyup", this._keyUpBound);
    window.addEventListener("blur", this._blurBound);
    document.addEventListener("click", this._contextMenuClickAwayBound);
    document.addEventListener("click", this._promptResolutionClickAwayBound);
    document.addEventListener("click", this._promptMentionClickAwayBound);
    document.addEventListener("keydown", this._contextMenuKeyBound);
    window.addEventListener("resize", this._contextMenuCloseBound);
    window.addEventListener("scroll", this._contextMenuCloseBound, true);
    const canvas = this.shadowRoot.getElementById("canvas");
    const effectCanvas = this.shadowRoot.getElementById("effectCanvas");
    const collabCursorCanvas = this.shadowRoot.getElementById("collabCursorCanvas");
    this._ctx = canvas.getContext("2d");
    this._effectCtx = effectCanvas.getContext("2d");
    this._collabCursorCtx = collabCursorCanvas.getContext("2d");
    canvas.addEventListener("pointerdown", (event) => this._onPointerDown(event));
    canvas.addEventListener("pointermove", (event) => this._onPointerMove(event));
    canvas.addEventListener("pointerup", (event) => this._onPointerUp(event));
    canvas.addEventListener("pointercancel", (event) => this._onPointerUp(event));
    canvas.addEventListener("dblclick", (event) => this._onCanvasDoubleClick(event));
    canvas.addEventListener("auxclick", (event) => {
      if (event.button === 1) event.preventDefault();
    });
    this._resizeObserver = new ResizeObserver(() => {
      this._resizeCanvas();
      this._syncPromptOverlays();
      this._syncToolbar();
      this._draw();
    });
    this._resizeObserver.observe(canvas);
    const workspace = this.shadowRoot.getElementById("workspace");
    workspace?.addEventListener("wheel", (event) => this._onWheel(event), { passive: false });
    workspace?.addEventListener("pointermove", (event) => this._onWorkspacePointerMove(event));
    workspace?.addEventListener("pointerleave", () => this._setHoverTarget("", ""));
    workspace?.addEventListener("contextmenu", (event) => this._onWorkspaceContextMenu(event));
    workspace?.addEventListener("dragover", (event) => this._onDragOver(event));
    workspace?.addEventListener("drop", (event) => this._onDrop(event));
    this._fileDragEndBound = () => this._setPromptFileDragHover("");
    window.addEventListener("dragend", this._fileDragEndBound);
    this.shadowRoot.getElementById("nodeContextMenu")?.addEventListener("click", (event) => this._onNodeContextMenuClick(event));
    const edgeFacetMenu = this.shadowRoot.getElementById("edgeFacetMenu");
    edgeFacetMenu?.addEventListener("click", (event) => event.stopPropagation());
    edgeFacetMenu?.addEventListener("change", (event) => this._onEdgeFacetMenuChange(event));
    edgeFacetMenu?.addEventListener("mousedown", (event) => event.stopPropagation());
    this.shadowRoot.getElementById("inpaintPrompt")?.addEventListener("diffui-inpaint:copy", () => this._copyInpaintSelection().catch((error) => this._setStatus(error.message || "Copy failed")));
    this.shadowRoot.getElementById("inpaintPrompt")?.addEventListener("diffui-inpaint:popout", () => this._popOutInpaintSelection().catch((error) => this._setStatus(error.message || "Crop analysis failed")));
    this.shadowRoot.getElementById("inpaintPrompt")?.addEventListener("diffui-inpaint:add-files", (event) => {
      this._uploadInpaintContextImages(event.detail?.files || []).catch((error) => this._setStatus(error.message || "Image upload failed"));
    });
    this.shadowRoot.getElementById("inpaintPrompt")?.addEventListener("diffui-inpaint:remove-file", (event) => {
      this._removeInpaintContextImage(event.detail?.id || "");
    });
    this.shadowRoot.getElementById("inpaintPrompt")?.addEventListener("diffui-inpaint:input", (event) => {
      if (this._inpaint) this._inpaint.prompt = String(event.detail?.prompt || "");
    });
    this.shadowRoot.getElementById("inpaintPrompt")?.addEventListener("diffui-inpaint:generate", (event) => {
      this._generateInpaint(event.detail?.prompt || "").catch((error) => this._setStatus(error.message || "Inpaint failed"));
    });
    this.shadowRoot.getElementById("toolRect")?.addEventListener("click", () => this._setTool(TOOL_RECT, "toolbar"));
    this.shadowRoot.getElementById("toolFind")?.addEventListener("click", () => this._setTool(TOOL_FIND, "toolbar"));
    this.shadowRoot.getElementById("toolComment")?.addEventListener("click", () => this._setTool(TOOL_COMMENT, "toolbar"));
    this.shadowRoot.getElementById("toolMove")?.addEventListener("click", () => this._setTool(TOOL_POINTER, "toolbar"));
    this.shadowRoot.getElementById("toolEdit")?.addEventListener("click", () => this._setTool(TOOL_EDIT, "toolbar"));
    this.shadowRoot.getElementById("toolDuplicate")?.addEventListener("click", () => this._setTool(TOOL_DUPLICATE, "toolbar"));
    this._wireToolTooltips();
    this.shadowRoot.getElementById("commentLayer")?.addEventListener("diffui-comment:reply", (event) => {
      this._addCommentReply(event.detail?.commentId, event.detail?.body);
    });
    this.shadowRoot.getElementById("commentLayer")?.addEventListener("diffui-comment:delete", (event) => {
      this._deleteComment(event.detail?.commentId);
    });
    this.shadowRoot.getElementById("commentLayer")?.addEventListener("diffui-comment:resolve", (event) => {
      this._resolveComment(event.detail?.commentId);
    });
    this.shadowRoot.getElementById("commentLayer")?.addEventListener("diffui-comment:open", (event) => {
      this._closeExpandedComments(event.detail?.commentId || "");
    });
    this.shadowRoot.getElementById("commentLayer")?.addEventListener("diffui-comment:drag-start", (event) => {
      this._startCommentDrag(event);
    });
    this.shadowRoot.getElementById("commentComposer")?.addEventListener("pointerdown", (event) => event.stopPropagation());
    this.shadowRoot.getElementById("commentComposerCancel")?.addEventListener("click", () => this._cancelCommentDraft());
    this.shadowRoot.getElementById("commentComposerPost")?.addEventListener("click", () => this._commitCommentDraft());
    this.shadowRoot.getElementById("commentComposerInput")?.addEventListener("keydown", (event) => this._onCommentDraftKeyDown(event));
    this.shadowRoot.getElementById("findInput")?.addEventListener("input", (event) => this._find(String(event.target.value || "")));
    this.shadowRoot.getElementById("copyPromptJson")?.addEventListener("click", () => this._copySelectedPromptJSON());
    this.shadowRoot.getElementById("inspectorNameInput")?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.currentTarget.blur();
    });
    this.shadowRoot.getElementById("inspectorNameInput")?.addEventListener("blur", () => this._commitInspectorNameChange());
    this.shadowRoot.getElementById("inspectorNameInput")?.addEventListener("change", () => this._commitInspectorNameChange());
    this.shadowRoot.getElementById("generateVariantBtn")?.addEventListener("click", () => {
      const node = this._selectedNode();
      if (node) this._generateVariantForNode(node);
    });
    const cursorChatInput = this.shadowRoot.getElementById("cursorChatInput");
    cursorChatInput?.addEventListener("input", (event) => this._onCursorChatInput(event));
    cursorChatInput?.addEventListener("keydown", (event) => this._onCursorChatKeyDown(event));
    this.shadowRoot.getElementById("toolFileSettings")?.addEventListener("click", () => this._toggleFileSettings());
    this.shadowRoot.getElementById("fileSettingsClose")?.addEventListener("click", () => this._toggleFileSettings(false));
    const fileSettingsName = this.shadowRoot.getElementById("fileSettingsName");
    const fileSettingsDescription = this.shadowRoot.getElementById("fileSettingsDescription");
    fileSettingsName?.addEventListener("input", () => {
      this._fileSettingsDraft.name = String(fileSettingsName.value || "");
      this._queueFileSettingsSave();
    });
    fileSettingsName?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      fileSettingsName.blur();
    });
    fileSettingsName?.addEventListener("blur", () => {
      this._saveFileSettings().catch((error) => this._setStatus(error.message || "File settings save failed"));
    });
    fileSettingsDescription?.addEventListener("input", () => {
      this._fileSettingsDraft.description = String(fileSettingsDescription.value || "");
      this._queueFileSettingsSave();
    });
    fileSettingsDescription?.addEventListener("blur", () => {
      this._saveFileSettings().catch((error) => this._setStatus(error.message || "File settings save failed"));
    });
    this.shadowRoot.getElementById("regenerateThumbnailBtn")?.addEventListener("click", () => {
      this._regenerateFileThumbnail().catch((error) => this._setStatus(error.message || "Thumbnail regeneration failed"));
    });
    this.addEventListener("paste", (event) => this._onPaste(event));
    this.tabIndex = 0;
    this._setTool(TOOL_POINTER);
  }

  _resizeCanvas() {
    const canvas = this.shadowRoot.getElementById("canvas");
    const rect = canvas.getBoundingClientRect();
    this._canvasRect = rect;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    if (this._ctx) this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const effectCanvas = this.shadowRoot.getElementById("effectCanvas");
    if (effectCanvas) {
      effectCanvas.width = canvas.width;
      effectCanvas.height = canvas.height;
      if (this._effectCtx) this._effectCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const collabCursorCanvas = this.shadowRoot.getElementById("collabCursorCanvas");
    if (collabCursorCanvas) {
      collabCursorCanvas.width = canvas.width;
      collabCursorCanvas.height = canvas.height;
      if (this._collabCursorCtx) this._collabCursorCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  _onKeyDown(event) {
    if (event.key === "Shift") this._setShiftHeld(true);
    if ((event.code === "AltLeft" || event.code === "AltRight") && !event.repeat) this._setAltKeyHeld(true);
    const editableTarget = this._editableEventTarget(event);
    if (event.key === "Escape" && this._cursorChat?.phase === "composing") {
      event.preventDefault();
      this._cancelCursorChat();
      return;
    }
    if (event.key === "Escape" && this._commentDraft) {
      event.preventDefault();
      this._cancelCommentDraft();
      return;
    }
    if (event.key === "Escape" && this._closeExpandedComments()) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" && this._cursorChat?.phase === "posted") {
      event.preventDefault();
      this._clearPostedCursorChat();
      return;
    }
    if (event.key === "Escape" && editableTarget) {
      event.preventDefault();
      editableTarget.blur();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (this._fileSettingsOpen) {
        this._toggleFileSettings(false);
        return;
      }
      if (this._inpaint) {
        this._clearInpaintSelection();
        return;
      }
      this._clearSelection();
      return;
    }
    if (event.ctrlKey && !event.metaKey && (event.key === "\\" || event.code === "Backslash")) {
      event.preventDefault();
      if (event.repeat) return;
      this._toggleImageSelectionInspector();
      return;
    }
    if (editableTarget) return;
    if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && this._cursorChat?.phase !== "composing") {
      event.preventDefault();
      this._startCursorChat();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const node = this._selectedNode();
      if (node && this._readyImagesForNode(node).length > 1) {
        event.preventDefault();
        this._stepNodeStack(node, event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
    }
    if (
      (event.key === "[" || event.key === "]")
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey
      && this._canEditCollab()
    ) {
      const hasSelected = this._state.nodes.some((node) => node.selected);
      if (hasSelected) {
        event.preventDefault();
        this._nudgeSelectedZOrder(event.key === "[" ? -1 : 1);
        return;
      }
    }
    if (event.code === "Space") {
      event.preventDefault();
      this._setSpacePan(true);
      return;
    }
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "z") {
      event.preventDefault();
      if (event.shiftKey) this._redo();
      else this._undo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === "y") {
      event.preventDefault();
      this._redo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === "c" && !event.shiftKey && !event.altKey) {
      const node = this._selectedNode();
      if (node && this._activeImageForNode(node)) {
        event.preventDefault();
        this._copyNodeToClipboard(node).catch((error) => this._setStatus(error.message || "Copy failed"));
        return;
      }
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.altKey &&
      (event.key === "0" || event.code === "Digit0" || event.code === "Numpad0")
    ) {
      event.preventDefault();
      if (!event.repeat) this._resetCanvasZoom100();
      return;
    }
    if (key === "n" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      if (!event.repeat) this._focusAdjacentFrame(event.shiftKey ? -1 : 1);
      return;
    }
    if (key === "r" && this._canEditCollab()) this._setTool(TOOL_RECT, "hotkey");
    if (key === "f") this._setTool(TOOL_FIND, "hotkey");
    if (key === "c") this._setTool(TOOL_COMMENT, "hotkey");
    if (key === "v") this._setTool(TOOL_POINTER, "hotkey");
    const plainKey = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (key === "e" && plainKey && this._canEditCollab()) this._setTool(TOOL_EDIT, "hotkey");
    if (key === "d" && plainKey && this._canEditCollab()) this._setTool(TOOL_DUPLICATE, "hotkey");
    if ((key === "backspace" || key === "delete") && this._canEditCollab()) this._deleteSelected();
  }

  _onKeyUp(event) {
    if (event.code === "AltLeft" || event.code === "AltRight") {
      this._setAltKeyHeld(false);
    }
    if (event.key === "Shift") {
      this._setShiftHeld(false);
      return;
    }
    if (event.code !== "Space") return;
    if (this._isEditableEventTarget(event) && !this._spacePan) return;
    event.preventDefault();
    this._stopSpacePan();
  }

  _stopSpacePan() {
    this._setSpacePan(false);
    if (this._pointer?.mode === "pan" && this._pointer.panSource === "space") {
      this._pointer = null;
      this._setPanning(false);
    }
  }

  /**
   * @param {string} tool the tool to select.
   * @param {string} source how the visitor picked it ("toolbar", "hotkey"), or
   *   "" when the canvas is switching tools on its own. Only a deliberate pick
   *   is telemetry: the resets to the pointer after a rectangle, a comment, or
   *   a lost edit permission are not choices anyone made.
   */
  _setTool(tool, source = "") {
    if (EDIT_ONLY_TOOLS.includes(tool) && !this._canEditCollab()) return;
    if (tool === TOOL_COMMENT && !this._canCommentCollab()) return;
    if (source) {
      this._trackClick(UI_TELEMETRY_EVENTS.CANVAS_TOOL_SELECT, tool, "select", { source });
    }
    // Duplicate is the pointer with alt-duplicate latched on, so every pointer
    // path (drag, hover cursor, prompt boxes) keeps working as it already does.
    this._selectedTool = tool;
    this._duplicateTool = tool === TOOL_DUPLICATE;
    this._tool = tool === TOOL_DUPLICATE ? TOOL_POINTER : tool;
    this.dataset.tool = this._tool;
    this.dataset.selectedTool = this._selectedTool;
    this._syncAltDuplicateHoverDataset();
    this._syncToolButtons();
    this.shadowRoot.getElementById("findBox").hidden = tool !== TOOL_FIND;
    if (tool === TOOL_FIND) {
      setTimeout(() => this.shadowRoot.getElementById("findInput")?.focus(), 0);
    }
    this._setStatus(TOOL_STATUS_LABELS[tool] || TOOL_STATUS_LABELS[TOOL_POINTER]);
  }

  /**
   * Record one canvas interaction. Fire-and-forget by contract: `trackUIClick`
   * queues and returns, so no canvas path ever waits on or fails because of
   * telemetry. See frontend/ui-telemetry.js.
   */
  _trackClick(name, target, action, props = null) {
    trackUIClick(name, { target, action, projectId: this._projectId || "", props });
  }

  _syncToolButtons() {
    const active = toolButtonActiveStates(this._selectedTool, this._altKeyHeld);
    Object.entries(active).forEach(([buttonId, on]) => {
      const btn = this.shadowRoot.getElementById(buttonId);
      if (btn) btn.dataset.active = on ? "true" : "false";
    });
  }

  _wireToolTooltips() {
    const cluster = this.shadowRoot.getElementById("toolCluster");
    const tooltip = this.shadowRoot.getElementById("toolTooltip");
    if (!cluster || !tooltip) return;
    this._toolTooltips = new ToolTooltipScheduler({
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id),
      onShow: (buttonId) => this._showToolTooltip(buttonId),
      onHide: () => tooltip.hide(),
    });
    Object.keys(CANVAS_TOOL_TOOLTIPS).forEach((buttonId) => {
      const btn = this.shadowRoot.getElementById(buttonId);
      if (!btn) return;
      btn.addEventListener("pointerenter", () => this._toolTooltips?.hover(buttonId));
      btn.addEventListener("pointerdown", () => this._toolTooltips?.dismiss());
    });
    cluster.addEventListener("pointerleave", () => this._toolTooltips?.leave());
  }

  _showToolTooltip(buttonId) {
    const tooltip = this.shadowRoot.getElementById("toolTooltip");
    const btn = this.shadowRoot.getElementById(buttonId);
    const tools = this.shadowRoot.querySelector(".leftTools");
    const copy = CANVAS_TOOL_TOOLTIPS[buttonId];
    if (!tooltip || !btn || !tools || !copy || btn.hidden) return;
    tooltip.setTool(copy);
    const btnRect = btn.getBoundingClientRect();
    const toolsRect = tools.getBoundingClientRect();
    tooltip.showAt(
      btnRect.right - toolsRect.left + TOOL_TOOLTIP_GAP_PX,
      btnRect.top + btnRect.height / 2 - toolsRect.top,
    );
  }

  _setSpacePan(active) {
    this._spacePan = active;
    if (active) this.dataset.spacePan = "true";
    else delete this.dataset.spacePan;
  }

  _setAltKeyHeld(active) {
    if (this._altKeyHeld === active) return;
    this._altKeyHeld = active;
    this._syncAltDuplicateHoverDataset();
    this._syncToolButtons();
  }

  /**
   * Alt keydown can be missed entirely — the window may not have had focus when
   * the key went down, and macOS Option is easy to press before clicking in. Every
   * pointer event carries the live modifier state, so trust it over our own.
   */
  _syncAltKeyFromPointerEvent(event) {
    if (typeof event?.altKey !== "boolean") return;
    this._setAltKeyHeld(event.altKey);
  }

  /** True when a pointer drag would duplicate: Alt held, or duplicate tool picked. */
  _altDuplicateArmed() {
    return this._tool === TOOL_POINTER && (this._altKeyHeld || this._duplicateTool);
  }

  /** The node a drag from `nodeId` should duplicate, or "" to move it instead. */
  _altDuplicateDragSourceId(nodeId, event) {
    if (this._tool !== TOOL_POINTER) return "";
    if (!event?.altKey && !this._duplicateTool) return "";
    return this._nodeSupportsAltDuplicate(nodeId) ? nodeId : "";
  }

  _syncAltDuplicateHoverDataset() {
    const show =
      this._altDuplicateArmed() &&
      this._hoverNodeId &&
      this._nodeSupportsAltDuplicate(this._hoverNodeId);
    if (show) this.dataset.altDuplicateHover = "true";
    else delete this.dataset.altDuplicateHover;
    this._patchAltDuplicateHoverOnPromptBoxes(show);
  }

  _patchAltDuplicateHoverOnPromptBoxes(show) {
    const layer = this.shadowRoot.getElementById("promptLayer");
    if (!layer) return;
    const hoverId = this._hoverNodeId || "";
    layer.querySelectorAll(".promptBox").forEach((box) => {
      const on = show && box.dataset.nodeId === hoverId;
      box.dataset.altDuplicateHoverTarget = on ? "true" : "false";
    });
  }

  _setShiftHeld(active) {
    if (this._shiftHeld === active) return;
    this._shiftHeld = active;
    if (this._pointer?.mode === "resize-node" && this._pointer.currentWorld) {
      const size = this._resizeNodeSizeForWorld(this._pointer, this._pointer.currentWorld);
      this._patchNode(this._pointer.nodeId, size, { quiet: true });
      this._syncToolbar();
      this._syncPromptOverlays();
    }
    this._draw();
  }

  _setPanning(active) {
    if (active) this.dataset.panning = "true";
    else delete this.dataset.panning;
  }

  _toggleImageSelectionInspector() {
    this._showInspectorOnImageSelect = !this._showInspectorOnImageSelect;
    if (this._showInspectorOnImageSelect) {
      this._syncToolbar();
      this._setStatus("Properties panel shown");
      return;
    }
    this._hideInspector();
    this._setStatus("Properties panel hidden");
  }

  _markZooming(durationMs = 180) {
    this.dataset.zooming = "true";
    window.clearTimeout(this._zoomingTimer);
    this._zoomingTimer = window.setTimeout(() => {
      this._zoomingTimer = 0;
      delete this.dataset.zooming;
    }, durationMs);
  }

  _onWorkspacePointerMove(event) {
    // Hovering a node happens over its prompt box, not the canvas, so the Alt
    // resync has to live here too or the duplicate affordance can go stale.
    this._syncAltKeyFromPointerEvent(event);
    if (this._pointer && !this._dragPort) return;
    const target = this._connectionHoverTargetForEvent(event);
    this._setHoverTarget(target.nodeId, target.edgeId);
    const canvas = this.shadowRoot.getElementById("canvas");
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) return;
    const world = this._screenToWorld(sx, sy);
    this._lastPointerWorld = world;
    if (this._cursorChat?.phase === "composing") {
      this._cursorChat.worldX = world.x;
      this._cursorChat.worldY = world.y;
      this._syncCursorChatInputPosition();
    } else if (
      this._cursorChat?.phase === "posted" &&
      this._cursorChatBubbleVisible(this._cursorChat, performance.now())
    ) {
      this._cursorChat.worldX = world.x;
      this._cursorChat.worldY = world.y;
      this._publishCollabAwareness(world.x, world.y);
    }
    this._scheduleCollabAwareness(world.x, world.y);
  }

  _connectionHoverTargetForEvent(event) {
    const promptBox = event.composedPath().find((target) => (
      target instanceof HTMLElement && target.classList.contains("promptBox")
    ));
    if (promptBox?.dataset.nodeId) return { nodeId: promptBox.dataset.nodeId, edgeId: "" };

    const canvas = this.shadowRoot.getElementById("canvas");
    const rect = canvas.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) return { nodeId: "", edgeId: "" };
    const world = this._screenToWorld(sx, sy);
    const node = [...this._state.nodes].reverse().find((item) => pointInNode(world.x, world.y, item));
    if (node) return { nodeId: node.id, edgeId: "" };
    const connectorNode = this._connectorHandleHoverNodeAt(world.x, world.y);
    if (connectorNode) return { nodeId: connectorNode.id, edgeId: "" };
    const edge = this._edgeHit(world.x, world.y);
    return { nodeId: "", edgeId: edge ? edgeIdentity(edge) : "" };
  }

  _setHoverTarget(nodeId, edgeId) {
    if (this._hoverNodeId === nodeId && this._hoverEdgeId === edgeId) return;
    this._hoverNodeId = nodeId;
    this._hoverEdgeId = edgeId;
    this._syncAltDuplicateHoverDataset();
    this._draw();
    this._syncPromptOverlays();
  }

  _onWorkspaceContextMenu(event) {
    this._closeExpandedComments();
    const canvas = this.shadowRoot.getElementById("canvas");
    const rect = canvas?.getBoundingClientRect();
    if (rect) {
      const world = this._screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
      const edge = this._edgeHit(world.x, world.y);
      if (edge && (!edge.kind || edge.kind === "prompt_input")) {
        event.preventDefault();
        event.stopPropagation();
        this.focus();
        this._closeNodeContextMenu();
        this._selectEdgeById(edge.id, false);
        this._draw();
        this._syncPromptOverlays();
        this._trackClick(UI_TELEMETRY_EVENTS.CONTEXT_MENU_OPEN, "edge_facet_menu", "open", {
          source: "right_click",
        });
        this._openEdgeFacetMenu(edge, event.clientX, event.clientY);
        return;
      }
    }
    this._closeEdgeFacetMenu();
    const selected = this._state.nodes.filter((n) => n.selected);
    const node = this._contextMenuNodeForEvent(event);
    if (selected.length >= 2 && node && selected.some((n) => n.id === node.id)) {
      event.preventDefault();
      event.stopPropagation();
      this.focus();
      this._trackClick(UI_TELEMETRY_EVENTS.CONTEXT_MENU_OPEN, "multi_select_context_menu", "open", {
        source: "right_click",
        selection_size: selected.length,
      });
      this._openMultiSelectContextMenu(selected, event.clientX, event.clientY);
      return;
    }
    if (!node || !this._activeImageForNode(node)) return;
    event.preventDefault();
    event.stopPropagation();
    this.focus();
    this._selectNodeById(node.id);
    this._syncToolbar();
    this._syncPromptOverlays();
    this._draw();
    this._trackClick(UI_TELEMETRY_EVENTS.CONTEXT_MENU_OPEN, "node_context_menu", "open", {
      source: "right_click",
    });
    this._openNodeContextMenu(node, event.clientX, event.clientY);
  }

  _agentCopyableNodeCount(nodes) {
    return nodes.filter((n) => this._imageIdForNode(n) || this._assetIdForNode(n)).length;
  }

  _openMultiSelectContextMenu(selectedNodes, x, y) {
    this._closeEdgeFacetMenu();
    const menu = this.shadowRoot.getElementById("nodeContextMenu");
    if (!menu) return;
    const imageCount = selectedNodes.filter((n) => this._imageIdForNode(n)).length;
    const agentCopyableCount = this._agentCopyableNodeCount(selectedNodes);
    this._nodeContextMenuState = { multiSelect: true, nodeIds: selectedNodes.map((n) => n.id) };
    menu.dataset.open = "true";
    menu.setAttribute("aria-hidden", "false");
    menu.querySelectorAll(".nodeContextMenuItem").forEach((btn) => {
      const action = btn.dataset.action || "";
      if (action === "create-brand-from-selection") {
        btn.hidden = imageCount < 5;
        btn.disabled = false;
      } else if (action === "copy-for-agent") {
        btn.hidden = false;
        btn.disabled = agentCopyableCount < 2;
      } else if (action === "build-with-bb") {
        btn.hidden = !this._bbBuildAvailable();
        btn.dataset.uiHidden = btn.hidden ? "true" : "false";
        btn.disabled = agentCopyableCount < 2;
      } else {
        btn.hidden = true;
        btn.disabled = false;
      }
    });
    menu.querySelectorAll(".nodeContextMenuDivider").forEach((divider) => {
      divider.hidden = true;
    });
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    const rect = menu.getBoundingClientRect();
    const left = rect.right > window.innerWidth ? Math.max(8, window.innerWidth - rect.width - 8) : x;
    const top = rect.bottom > window.innerHeight ? Math.max(8, window.innerHeight - rect.height - 8) : y;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    if (!this._coachOpeningMenu) {
      this._notifyCanvasCoach("multi-select-menu-opened", { createBrandAvailable: imageCount >= 5 });
    }
  }

  _contextMenuNodeForEvent(event) {
    const promptBox = event.composedPath().find((target) => (
      target instanceof HTMLElement && target.classList.contains("promptBox")
    ));
    if (promptBox?.dataset.nodeId) {
      return this._state.nodes.find((node) => node.id === promptBox.dataset.nodeId) || null;
    }
    const canvas = this.shadowRoot.getElementById("canvas");
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return null;
    const world = this._screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    return this._imageHit(world.x, world.y) || null;
  }

  _openNodeContextMenu(node, x, y) {
    this._closeEdgeFacetMenu();
    const menu = this.shadowRoot.getElementById("nodeContextMenu");
    if (!menu) return;
    menu.querySelectorAll(".nodeContextMenuItem").forEach((btn) => {
      const action = btn.dataset.action || "";
      btn.hidden = action === "create-brand-from-selection";
      if (action === "build-with-bb") {
        btn.dataset.uiHidden = this._bbBuildAvailable() ? "false" : "true";
      }
    });
    menu.querySelectorAll(".nodeContextMenuDivider").forEach((divider) => {
      divider.hidden = false;
    });
    const promptText = this._promptTextForNode(node);
    const promptJson = this._promptJSONForNode(node);
    this._nodeContextMenuState = { nodeId: node.id };
    menu.dataset.open = "true";
    menu.setAttribute("aria-hidden", "false");
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    const activeImage = this._activeImageForNode(node);
    this._setNodeContextMenuDisabled("rename-node", !this._canEditCollab() || node.kind === "image");
    this._setNodeContextMenuDisabled("copy-image", !String(activeImage?.image_url || activeImage?.imageUrl || "").trim());
    this._setNodeContextMenuDisabled("download-image", !String(activeImage?.image_url || activeImage?.imageUrl || "").trim());
    this._setNodeContextMenuDisabled("add-to-brand", !this._imageIdForNode(node));
    this._setNodeContextMenuDisabled("copy-prompt", !promptText);
    this._setNodeContextMenuDisabled("copy-json", !promptJson);
    this._setNodeContextMenuDisabled("copy-for-agent", !this._imageIdForNode(node) && !this._assetIdForNode(node));
    this._setNodeContextMenuDisabled("build-with-bb", !this._imageIdForNode(node) && !this._assetIdForNode(node));
    const rect = menu.getBoundingClientRect();
    const left = rect.right > window.innerWidth ? Math.max(8, window.innerWidth - rect.width - 8) : x;
    const top = rect.bottom > window.innerHeight ? Math.max(8, window.innerHeight - rect.height - 8) : y;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    if (!this._coachOpeningMenu) this._notifyCanvasCoach("node-menu-opened", { nodeId: node.id });
  }

  _setNodeContextMenuDisabled(action, disabled) {
    const button = this.shadowRoot
      .getElementById("nodeContextMenu")
      ?.querySelector(`button[data-action="${action}"]`);
    if (button) button.disabled = !!disabled;
  }

  _closeNodeContextMenu() {
    const menu = this.shadowRoot.getElementById("nodeContextMenu");
    if (!menu) return;
    this._clearCanvasCoachMenuHover?.();
    menu.dataset.open = "false";
    menu.setAttribute("aria-hidden", "true");
    menu.querySelectorAll(".nodeContextMenuItem").forEach((btn) => {
      if (btn.dataset.action === "create-brand-from-selection") btn.hidden = true;
      else btn.hidden = false;
      btn.disabled = false;
    });
    menu.querySelectorAll(".nodeContextMenuDivider").forEach((divider) => {
      divider.hidden = false;
    });
    this._nodeContextMenuState = null;
  }

  _normalizeEdgeInputFacets(raw) {
    const out = { ...DEFAULT_EDGE_INPUT_FACETS };
    if (!raw || typeof raw !== "object") return out;
    EDGE_INPUT_FACET_KEYS.forEach((key) => {
      if (typeof raw[key] === "boolean") out[key] = raw[key];
    });
    return out;
  }

  _edgeInputFacets(edge) {
    return this._normalizeEdgeInputFacets(edge?.inputFacets || edge?.input_facets);
  }

  _edgeHasCustomInputFacets(edge) {
    const facets = this._edgeInputFacets(edge);
    return EDGE_INPUT_FACET_KEYS.some((key) => facets[key] !== DEFAULT_EDGE_INPUT_FACETS[key]);
  }

  _openEdgeFacetMenu(edge, x, y) {
    const menu = this.shadowRoot.getElementById("edgeFacetMenu");
    if (!menu || !edge?.id) return;
    const facets = this._edgeInputFacets(edge);
    this._edgeFacetMenuState = { edgeId: edge.id };
    menu.querySelectorAll("input[data-facet]").forEach((input) => {
      const key = input.dataset.facet || "";
      input.checked = facets[key] !== false;
      input.disabled = !this._canEditCollab();
    });
    menu.dataset.open = "true";
    menu.setAttribute("aria-hidden", "false");
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    const rect = menu.getBoundingClientRect();
    const left = rect.right > window.innerWidth ? Math.max(8, window.innerWidth - rect.width - 8) : x;
    const top = rect.bottom > window.innerHeight ? Math.max(8, window.innerHeight - rect.height - 8) : y;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  _closeEdgeFacetMenu() {
    const menu = this.shadowRoot.getElementById("edgeFacetMenu");
    if (!menu) return;
    menu.dataset.open = "false";
    menu.setAttribute("aria-hidden", "true");
    this._edgeFacetMenuState = null;
  }

  _onEdgeFacetMenuChange(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.facet) return;
    event.stopPropagation();
    const edgeId = this._edgeFacetMenuState?.edgeId || "";
    if (!edgeId || !this._canEditCollab()) return;
    const edge = this._state.edges.find((item) => item.id === edgeId);
    if (!edge) return;
    const next = this._edgeInputFacets(edge);
    next[input.dataset.facet] = !!input.checked;
    this._trackClick(
      UI_TELEMETRY_EVENTS.CONTEXT_MENU_ITEM_CLICK, "edge_facet_menu", input.dataset.facet,
      { outcome: input.checked ? "on" : "off" },
    );
    this._patchEdgeInputFacets(edgeId, next);
  }

  _patchEdgeInputFacets(edgeId, facets) {
    const edge = this._state.edges.find((item) => item.id === edgeId);
    if (!edge) return;
    const normalized = this._normalizeEdgeInputFacets(facets);
    const payload = {
      id: edge.id,
      kind: edge.kind || "prompt_input",
      from_node_id: edge.from_node_id || edge.fromNodeId || "",
      to_node_id: edge.to_node_id || edge.toNodeId || "",
      fromNodeId: edge.from_node_id || edge.fromNodeId || "",
      toNodeId: edge.to_node_id || edge.toNodeId || "",
      selected: !!edge.selected,
      inputFacets: normalized,
    };
    this._engine?.add_edge(JSON.stringify(payload));
    this._syncStateFromEngine();
    this._commitCollabState();
    this._draw();
    this._syncPromptOverlays();
  }

  _onNodeContextMenuClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const state = this._nodeContextMenuState;
    const action = button.dataset.action || "";
    this._trackClick(
      UI_TELEMETRY_EVENTS.CONTEXT_MENU_ITEM_CLICK,
      state?.multiSelect ? "multi_select_context_menu" : "node_context_menu",
      action,
    );
    this._closeNodeContextMenu();
    if (state?.multiSelect && action === "create-brand-from-selection") {
      this._createBrandFromSelection().catch((error) => {
        this._setStatus(error.message || "Action failed");
      });
      return;
    }
    if (state?.multiSelect && action === "copy-for-agent") {
      this._notifyCanvasCoach("copy-for-agent");
      this._copySelectionForAgent(state.nodeIds || []).catch((error) => {
        this._setStatus(error.message || "Action failed");
      });
      return;
    }
    if (state?.multiSelect && action === "build-with-bb") {
      this._buildSelectionWithBb(state.nodeIds || []).catch((error) => {
        this._setStatus(error.message || "Action failed");
      });
      return;
    }
    const nodeId = state?.nodeId || "";
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    this._handleNodeContextMenuAction(action, node).catch((error) => {
      this._setStatus(error.message || "Action failed");
    });
  }

  async _handleNodeContextMenuAction(action, node) {
    if (action === "create-brand-from-selection") {
      await this._createBrandFromSelection();
      return;
    }
    if (action === "rename-node") {
      this._startNodeHeaderRename(node);
      return;
    }
    if (action === "ask-edits") {
      if (!this._canEditCollab()) return;
      this._createEditPromptForNode(node);
      return;
    }
    if (action === "copy-image") {
      await this._copyNodeToClipboard(node);
      return;
    }
    if (action === "download-image") {
      this._downloadNodeImage(node);
      return;
    }
    if (action === "add-to-brand") {
      const imageId = this._imageIdForNode(node);
      if (imageId) {
        window.dispatchEvent(new CustomEvent("diffui:add-generated-to-brand", { detail: { imageId, brandId: this._brandIdForNodeImage(node) } }));
      }
      return;
    }
    if (action === "copy-prompt") {
      await this._copyNodePromptToClipboard(node);
      return;
    }
    if (action === "copy-json") {
      await this._copyNodePromptJsonToClipboard(node);
      return;
    }
    if (action === "copy-for-agent") {
      this._notifyCanvasCoach("copy-for-agent", { nodeId: node.id });
      await this._copyNodeForAgent(node);
      return;
    }
    if (action === "build-with-bb") {
      await this._buildNodesWithBb([node]);
      return;
    }
    if (action === "delete-node") {
      if (!this._canEditCollab()) return;
      this._selectNodeById(node.id);
      this._deleteSelected();
    }
  }

  _imageIdForNode(node) {
    const image = this._activeImageForNode(node);
    const metadata = safeParse(image?.metadata_json) || safeParse(node?.metadata_json || node?.metadataJson) || {};
    return String(metadata.imageId || image?.imageId || "").trim();
  }

  _brandIdForNodeImage(node) {
    const image = this._activeImageForNode(node);
    const metadata = safeParse(image?.metadata_json) || {};
    const brand = metadata.brand && typeof metadata.brand === "object" ? metadata.brand : null;
    return String(brand?.id || "").trim();
  }

  _onWheel(event) {
    const zoomModifier = event.ctrlKey || event.metaKey;
    if (!zoomModifier && this._isFocusedEditableEventTarget(event)) return;
    const rect = this.shadowRoot.getElementById("canvas").getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    event.preventDefault();

    const delta = normalizedWheelDelta(event);
    if (zoomModifier) {
      const rawZoomDeltaY = wheelEventIsTrackpadPinchZoom(event) ? delta.y * TRACKPAD_PINCH_ZOOM_MULTIPLIER : delta.y;
      const zoomDeltaY = clampSignedMagnitude(rawZoomDeltaY, MAX_WHEEL_ZOOM_DELTA);
      this._zoomViewportAt(sx, sy, zoomDeltaY);
      return;
    }

    this._state.viewport.x -= delta.x;
    this._state.viewport.y -= delta.y;
    this._commitViewport();
  }

  _zoomViewportAt(sx, sy, deltaY) {
    if (!deltaY) return;
    const before = this._screenToWorld(sx, sy);
    const factor = Math.exp(-deltaY * WHEEL_ZOOM_INTENSITY);
    const nextScale = clampNumber(this._state.viewport.scale * factor, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE);
    if (nextScale !== this._state.viewport.scale) this._markZooming();
    this._state.viewport.scale = nextScale;
    this._state.viewport.x = sx - before.x * nextScale;
    this._state.viewport.y = sy - before.y * nextScale;
    this._commitViewport();
  }

  _setViewportScaleAnchoredAt(sx, sy, rawScale) {
    const nextScale = clampNumber(rawScale, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE);
    if (nextScale === this._state.viewport.scale) return;
    this._markZooming();
    const before = this._screenToWorld(sx, sy);
    this._state.viewport.scale = nextScale;
    this._state.viewport.x = sx - before.x * nextScale;
    this._state.viewport.y = sy - before.y * nextScale;
    this._commitViewport();
  }

  _resetCanvasZoom100() {
    const canvas = this.shadowRoot.getElementById("canvas");
    const bounds = canvas?.getBoundingClientRect();
    const width = bounds?.width || 1;
    const height = bounds?.height || 1;
    this._setViewportScaleAnchoredAt(width / 2, height / 2, 1);
  }

  _onPointerDown(event) {
    if (
      this._nodeRenameNodeId
      && !event.composedPath().some((target) => target instanceof HTMLInputElement && target.classList.contains("nodeTitleInput"))
    ) {
      this._cancelNodeHeaderRename();
    }
    this.focus();
    this._syncAltKeyFromPointerEvent(event);
    // Capture a fresh canvas rect at gesture start so _eventWorld can reuse it
    // for the duration of the drag without re-reading layout each pointermove.
    this._refreshCanvasRect();
    const world = this._eventWorld(event);
    if (event.button === 1 || (event.button === 0 && this._spacePan)) {
      this._startPan(event, world, event.button === 1 ? "middle" : "space");
      return;
    }
    const isPrimaryOrSecondary = event.button === 0 || event.button === 2;
    if (isPrimaryOrSecondary) this._closeExpandedComments();
    if (event.button !== 0) return;
    if (this._tool === TOOL_COMMENT) {
      event.preventDefault();
      this._placeCommentAt(world);
      return;
    }
    if (!this._canEditCollab()) {
      const hit = this._engine?.hit_test(world.x, world.y) || "";
      if (this._tool === TOOL_POINTER && !hit) {
        const edge = this._edgeHit(world.x, world.y);
        if (edge) {
          this._selectEdgeById(edge.id, event.shiftKey);
          this._draw();
          this._syncToolbar();
          this._syncPromptOverlays();
          return;
        }
        this._pointer = { mode: "select-rect", start: world, current: world, append: event.shiftKey };
        this._capturePointer(event);
        return;
      }
      if (hit && this._tool === TOOL_POINTER) {
        this._prepareNodeSelectionForDrag(hit, event.shiftKey);
        this._selectNodeById(hit, event.shiftKey);
        this._draw();
        this._syncToolbar();
        this._syncPromptOverlays();
      }
      return;
    }
    const portNode = this._portHit(world.x, world.y);
    if (portNode) {
      this._capturePointer(event);
      this._dragPort = {
        from: portNode.id,
        x: world.x,
        y: world.y,
        renderX: world.x,
        renderY: world.y,
        targetPromptId: "",
        promptPreviewRect: null,
      };
      return;
    }
    const hit = this._engine?.hit_test(world.x, world.y) || "";
    const hitImage = hit ? this._state.nodes.find((node) => node.id === hit && this._activeImageForNode(node)) : null;
    if (this._tool === TOOL_EDIT) {
      // Edit starts anywhere the rectangle tool can, including off an image; the
      // `imagesOnly` flag is what keeps the finished rect from becoming a prompt.
      this._pointer = {
        mode: "draw-rect",
        start: world,
        current: world,
        targetImageId: hitImage?.id || this._imageHit(world.x, world.y)?.id || "",
        imagesOnly: true,
      };
      this._capturePointer(event);
      this._publishCollabAwareness(world.x, world.y);
      return;
    }
    if (this._tool === TOOL_RECT && hitImage) {
      this._pointer = { mode: "draw-rect", start: world, current: world, targetImageId: hitImage.id };
      this._capturePointer(event);
      this._publishCollabAwareness(world.x, world.y);
      return;
    }
    if (this._tool === TOOL_POINTER && !hit) {
      const edge = this._edgeHit(world.x, world.y);
      if (edge) {
        this._selectEdgeById(edge.id, event.shiftKey);
        this._draw();
        this._syncToolbar();
        this._syncPromptOverlays();
        return;
      }
      this._pointer = { mode: "select-rect", start: world, current: world, append: event.shiftKey };
      this._capturePointer(event);
      return;
    }
    if (hit) {
      const dup = this._altDuplicateDragSourceId(hit, event);
      if (dup) {
        this._prepareNodeSelectionForDrag(hit, false);
        this._selectNodeById(hit, false);
        this._startMoveNodeDrag(event, world, { duplicateSourceId: dup });
      } else {
        this._prepareNodeSelectionForDrag(hit, event.shiftKey);
        this._startMoveNodeDrag(event, world);
      }
      this._draw();
      this._syncToolbar();
      this._syncPromptOverlays();
      return;
    }
    this._pointer = { mode: "draw-rect", start: world, current: world, targetImageId: this._imageHit(world.x, world.y)?.id || "" };
    this._capturePointer(event);
    this._publishCollabAwareness(world.x, world.y);
  }

  _onCanvasDoubleClick(event) {
    if (!this._canEditCollab()) return;
    if (event.button !== 0 || this._tool !== TOOL_POINTER || this._spacePan) return;
    const world = this._eventWorld(event);
    const source = this._imageHit(world.x, world.y);
    if (!source) return;
    this._createPointerClickPrompt(event, source, world);
  }

  _onPointerMove(event) {
    this._syncAltKeyFromPointerEvent(event);
    const world = this._eventWorld(event);
    this._lastPointerWorld = world;
    if (this._cursorChat?.phase === "composing") {
      this._cursorChat.worldX = world.x;
      this._cursorChat.worldY = world.y;
      this._syncCursorChatInputPosition();
    } else if (
      this._cursorChat?.phase === "posted" &&
      this._cursorChatBubbleVisible(this._cursorChat, performance.now())
    ) {
      this._cursorChat.worldX = world.x;
      this._cursorChat.worldY = world.y;
      this._publishCollabAwareness(world.x, world.y);
    }
    this._scheduleCollabAwareness(world.x, world.y);
    if (this._dragPort) {
      this._updatePortDrag(world);
      this._scheduleDraw();
      return;
    }
    if (!this._pointer) return;
    if (this._pointer.mode === "resize-node" && this._shiftHeld !== event.shiftKey) this._setShiftHeld(event.shiftKey);
    if (this._pointer.mode === "pan") {
      event.preventDefault();
      this._state.viewport.x += event.clientX - this._pointer.lastX;
      this._state.viewport.y += event.clientY - this._pointer.lastY;
      this._pointer.lastX = event.clientX;
      this._pointer.lastY = event.clientY;
      this._commitViewport();
      return;
    }
    if (this._pointer.mode === "move-node") {
      event.preventDefault();
      this._updateMoveNodeDrag(event);
      return;
    }
    if (this._pointer.mode === "resize-node") {
      const size = this._resizeNodeSizeForWorld(this._pointer, world);
      this._patchNode(this._pointer.nodeId, size, { quiet: true, localMirror: true });
      this._syncToolbar();
      this._scheduleRender();
      return;
    }
    if (this._pointer.mode === "resize-inpaint") {
      event.preventDefault();
      this._updateInpaintResize(world);
      return;
    }
    if (this._pointer.mode === "drag-comment") {
      event.preventDefault();
      this._updateCommentDrag(world);
      return;
    }
    if (this._pointer.mode === "draw-rect") {
      this._pointer.current = world;
      const rect = normalizeRect(this._pointer.start, this._pointer.current);
      const targetImage = this._imageMajorityTarget(rect);
      this._pointer.targetImageId = targetImage?.id || "";
      this._scheduleDraw();
      this._publishCollabAwareness(world.x, world.y);
    }
    if (this._pointer.mode === "select-rect") {
      this._pointer.current = world;
      this._scheduleDraw();
    }
  }

  _startMoveNodeDrag(event, world, options = {}) {
    if (!this._canEditCollab()) return;
    this._refreshCanvasRect();
    let duplicateSourceId = String(options.duplicateSourceId || "").trim();
    this._engine?.begin_history_transaction?.();
    let selectedNodes = this._state.nodes.filter((node) => node.selected);
    if (duplicateSourceId) {
      const sourceNode = this._state.nodes.find((node) => node.id === duplicateSourceId);
      if (!sourceNode || !this._nodeSupportsAltDuplicate(duplicateSourceId)) {
        duplicateSourceId = "";
        selectedNodes = this._state.nodes.filter((node) => node.selected);
      } else {
        selectedNodes = [sourceNode];
      }
    }
    this._pointer = {
      mode: "move-node",
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      world,
      selectedNodeIds: selectedNodes.map((node) => node.id),
      startSelectedBounds: unionRects(selectedNodes.map((node) => nodeRect(node))),
      appliedDx: 0,
      appliedDy: 0,
      snapGuides: [],
      duplicateSourceId,
      duplicateSpawned: false,
    };
    this._capturePointer(event);
  }

  _updateMoveNodeDrag(event) {
    const pointer = this._pointer;
    if (!pointer || pointer.mode !== "move-node") return;
    const scale = this._state.viewport.scale || 1;
    const rawDx = (event.clientX - pointer.startX) / scale;
    const rawDy = (event.clientY - pointer.startY) / scale;
    if (pointer.duplicateSourceId && !pointer.duplicateSpawned) {
      const movedPx = Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY);
      if (movedPx < ALT_DUPLICATE_DRAG_THRESHOLD_PX) {
        pointer.snapGuides = [];
        return;
      }
      const sourceId = pointer.duplicateSourceId;
      const sourceNode = this._state.nodes.find((node) => node.id === sourceId);
      const newNode = sourceNode ? this._duplicatePromptNodeForAltDrag(sourceId) : null;
      pointer.duplicateSourceId = "";
      pointer.lastX = event.clientX;
      pointer.lastY = event.clientY;
      if (newNode && sourceNode) {
        pointer.duplicateSpawned = true;
        this._trackClick(UI_TELEMETRY_EVENTS.CANVAS_TOOL_USE, TOOL_DUPLICATE, "duplicate_node", {
          // Duplicate can be the latched tool or a one-off Alt-drag from the
          // pointer, and which one people reach for is the question.
          source: this._duplicateTool ? "tool" : "alt_drag",
        });
        const nx = sourceNode.x + rawDx;
        const ny = sourceNode.y + rawDy;
        this._patchNode(newNode.id, { x: nx, y: ny }, { quiet: true });
        this._syncStateFromEngine();
        this._selectNodeById(newNode.id, false);
        pointer.selectedNodeIds = [newNode.id];
        const placed = this._state.nodes.find((node) => node.id === newNode.id);
        pointer.startSelectedBounds = placed ? unionRects([nodeRect(placed)]) : pointer.startSelectedBounds;
        pointer.appliedDx = 0;
        pointer.appliedDy = 0;
        pointer.startX = event.clientX;
        pointer.startY = event.clientY;
        pointer.snapGuides = [];
        this._syncToolbar();
        this._syncPromptOverlays();
        this._queueSave();
        return;
      }
      pointer.duplicateSpawned = true;
    }
    const snapped = this._snappedMoveDelta(pointer, rawDx, rawDy);
    const dx = snapped.dx - (pointer.appliedDx || 0);
    const dy = snapped.dy - (pointer.appliedDy || 0);
    pointer.snapGuides = snapped.guides;
    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
    if (!dx && !dy) return;
    this._engine?.move_selected(dx, dy);
    this._translateInpaintSelectionForMovedNodes(pointer.selectedNodeIds, dx, dy);
    pointer.appliedDx = snapped.dx;
    pointer.appliedDy = snapped.dy;
    // Mirror the move locally instead of re-serializing the whole document from
    // the engine each frame. `move_selected` only adds (dx, dy) to selected
    // nodes, so the local state stays exact; pointer-up runs a full reconcile.
    this._applyMoveDeltaLocally(dx, dy);
    this._syncToolbar();
    this._scheduleRender();
    this._markCollabDirty();
    this._queueSave();
  }

  _applyMoveDeltaLocally(dx, dy) {
    if (!dx && !dy) return;
    for (const node of this._state.nodes) {
      if (node.selected) {
        node.x += dx;
        node.y += dy;
      }
    }
  }

  _translateInpaintSelectionForMovedNodes(nodeIds, dx, dy) {
    if (!this._inpaint?.cropRect || this._inpaint.generating || (!dx && !dy)) return;
    const moved = new Set(nodeIds || []);
    if (!moved.has(this._inpaint.sourceNodeId)) return;
    const cropRect = this._inpaint.cropRect;
    this._inpaint = {
      ...this._inpaint,
      cropRect: {
        ...cropRect,
        x: cropRect.x + dx,
        y: cropRect.y + dy,
      },
    };
  }

  _snappedMoveDelta(pointer, rawDx, rawDy) {
    const startBounds = pointer.startSelectedBounds;
    if (!startBounds) return { dx: rawDx, dy: rawDy, guides: [] };
    const proposedBounds = translateRect(startBounds, rawDx, rawDy);
    const selectedNodeIds = new Set(pointer.selectedNodeIds || []);
    const xSnap = this._closestMoveSnap("x", proposedBounds, selectedNodeIds);
    const ySnap = this._closestMoveSnap("y", proposedBounds, selectedNodeIds);
    const dx = rawDx + (xSnap?.delta || 0);
    const dy = rawDy + (ySnap?.delta || 0);
    const draggedRect = translateRect(startBounds, dx, dy);
    const guides = [];
    if (xSnap) {
      guides.push({
        axis: "x",
        value: rectSideValue(draggedRect, xSnap.sourceSide),
        draggedRect,
        targetRect: xSnap.targetRect,
      });
    }
    if (ySnap) {
      guides.push({
        axis: "y",
        value: rectSideValue(draggedRect, ySnap.sourceSide),
        draggedRect,
        targetRect: ySnap.targetRect,
      });
    }
    return { dx, dy, guides };
  }

  _closestMoveSnap(axis, proposedBounds, selectedNodeIds) {
    const scale = this._state.viewport.scale || 1;
    const threshold = MOVE_SNAP_SCREEN_THRESHOLD / scale;
    const sides = axis === "x" ? ["left", "right"] : ["top", "bottom"];
    let best = null;
    this._visibleSnapCandidateRects(selectedNodeIds).forEach((targetRect) => {
      sides.forEach((sourceSide) => {
        const sourceValue = rectSideValue(proposedBounds, sourceSide);
        sides.forEach((targetSide) => {
          const targetValue = rectSideValue(targetRect, targetSide);
          const delta = targetValue - sourceValue;
          const distance = Math.abs(delta);
          if (distance > threshold || (best && distance >= best.distance)) return;
          best = { delta, distance, sourceSide, targetSide, targetRect };
        });
      });
    });
    return best;
  }

  _visibleSnapCandidateRects(selectedNodeIds) {
    const viewportRect = this._viewportWorldRect();
    return this._state.nodes
      .filter((node) => !selectedNodeIds.has(node.id))
      .map((node) => nodeRect(node))
      .filter((rect) => rectsIntersect(rect, viewportRect));
  }

  _startResizeNodeDrag(event, node) {
    if (!this._canEditCollab()) return;
    if (this._nodeGenerationInFlight(node)) return;
    event.preventDefault();
    event.stopPropagation();
    this.focus();
    this._refreshCanvasRect();
    this._setShiftHeld(event.shiftKey);
    this._selectNodeById(node.id);
    this._engine?.begin_history_transaction?.();
    this._pointer = {
      mode: "resize-node",
      nodeId: node.id,
      startWorld: this._eventWorld(event),
      currentWorld: this._eventWorld(event),
      startWidth: node.width,
      startHeight: node.height,
      activeAspectGuide: "",
      activeResolution: "",
    };
    this._capturePointer(event);
    this._syncToolbar();
    this._syncPromptOverlays();
    this._draw();
  }

  _startResizeInpaintSelection(event, handle) {
    const source = this._state.nodes.find((node) => node.id === this._inpaint?.sourceNodeId);
    const cropRect = this._inpaint?.cropRect;
    if (!source || !cropRect || this._inpaint?.generating) return;
    event.preventDefault();
    event.stopPropagation();
    this.focus();
    this._pointer = {
      mode: "resize-inpaint",
      handle,
      startWorld: this._eventWorld(event),
      startRect: { ...cropRect },
      sourceRect: nodeRect(source),
    };
    this._capturePointer(event);
    const world = this._eventWorld(event);
    this._publishCollabAwareness(world.x, world.y);
  }

  _updateInpaintResize(world) {
    const pointer = this._pointer;
    if (!pointer || pointer.mode !== "resize-inpaint" || !this._inpaint) return;
    const next = this._resizeInpaintRectForWorld(pointer, world);
    if (!next) return;
    this._inpaint = { ...this._inpaint, cropRect: next };
    this._syncInpaintSelectionOverlay(this.shadowRoot.getElementById("selectionLayer"));
    this._drawEffectLayer();
    this._publishCollabAwareness(world.x, world.y);
  }

  _resizeInpaintRectForWorld(pointer, world) {
    const start = pointer.startRect;
    const bounds = pointer.sourceRect;
    if (!start || !bounds) return null;
    const handle = String(pointer.handle || "");
    const dx = world.x - pointer.startWorld.x;
    const dy = world.y - pointer.startWorld.y;
    let left = start.x;
    let top = start.y;
    let right = start.x + start.width;
    let bottom = start.y + start.height;
    if (handle.includes("w")) left += dx;
    if (handle.includes("e")) right += dx;
    if (handle.includes("n")) top += dy;
    if (handle.includes("s")) bottom += dy;
    const minWorld = Math.min(Math.max(4 / Math.max(this._state.viewport.scale || 1, 0.001), 1), bounds.width, bounds.height);
    left = clampNumber(left, bounds.x, bounds.x + bounds.width - minWorld);
    right = clampNumber(right, bounds.x + minWorld, bounds.x + bounds.width);
    top = clampNumber(top, bounds.y, bounds.y + bounds.height - minWorld);
    bottom = clampNumber(bottom, bounds.y + minWorld, bounds.y + bounds.height);
    if (right - left < minWorld) {
      if (handle.includes("w")) left = right - minWorld;
      else right = left + minWorld;
    }
    if (bottom - top < minWorld) {
      if (handle.includes("n")) top = bottom - minWorld;
      else bottom = top + minWorld;
    }
    left = clampNumber(left, bounds.x, bounds.x + bounds.width - minWorld);
    top = clampNumber(top, bounds.y, bounds.y + bounds.height - minWorld);
    right = clampNumber(right, left + minWorld, bounds.x + bounds.width);
    bottom = clampNumber(bottom, top + minWorld, bounds.y + bounds.height);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  _onPointerUp(event) {
    const world = this._eventWorld(event);
    if (this._dragPort) {
      this._updatePortDrag(world);
      const sourceId = this._dragPort.from;
      const target = this._dragPort.targetPromptId
        ? this._state.nodes.find((node) => node.id === this._dragPort.targetPromptId)
        : null;
      if (target && target.id !== sourceId) {
        this._addEdge(sourceId, target.id, "prompt_input", { skipCommit: true });
      } else if (this._dragPort.promptPreviewRect) {
        const node = this._createPromptNode(this._dragPort.promptPreviewRect, "", { createdFrom: "output_drop", inputNodeId: sourceId }, { skipCommit: true });
        if (node) {
          this._addEdge(sourceId, node.id, "prompt_input", { skipCommit: true });
          this._notifyCanvasCoach("fork-created", { nodeId: node.id, inputNodeId: sourceId });
          this._startNextPagePlaceholderCycle(node.id, sourceId);
          const source = this._state.nodes.find((item) => item.id === sourceId);
          // Camera motion can steal focus mid-animation — refocus once it settles.
          this._fitOutputDropIntoView(source, node, () => {
            this._focusPromptNode(node, { camera: false });
          });
        }
      }
      this._dragPort = null;
      this._releasePointer(event);
      this._flushCollabConnectEnd();
      window.clearTimeout(this._collabAwarenessTimer);
      this._collabAwarenessTimer = 0;
      this._pendingCollabAwareness = null;
      this._publishCollabAwareness(world.x, world.y);
      this._draw();
      this._syncPromptOverlays();
      return;
    }
    if (this._pointer?.mode === "draw-rect") {
      const pointer = this._pointer;
      pointer.current = world;
      const rect = normalizeRect(pointer.start, pointer.current);
      const targetImage = this._imageMajorityTarget(rect);
      this._pointer = null;
      const outcome = drawRectOutcome({
        width: rect.width,
        height: rect.height,
        majorityImageId: targetImage?.id || "",
        targetImageId: pointer.targetImageId || "",
        imagesOnly: pointer.imagesOnly,
      });
      // The tool was only really used if the drag produced something.
      if (outcome !== DRAW_RECT_NOTHING) {
        this._trackClick(
          UI_TELEMETRY_EVENTS.CANVAS_TOOL_USE, this._selectedTool, "draw_rect", { outcome },
        );
      }
      if (outcome === DRAW_RECT_EDIT_IMAGE) {
        this._openInpaintSelection(targetImage.id, rect);
      } else if (outcome === DRAW_RECT_PROMPT) {
        const node = this._createPromptNode(rect);
        if (node) this._focusPromptNode(node);
        this._clearInpaintSelection();
        this._setTool(TOOL_POINTER);
      } else if (outcome === DRAW_RECT_CLICK_PROMPT) {
        const size = this._commonCanvasNodeSize();
        const node = this._createPromptNode(this._singleClickPromptRect(pointer.start, size));
        if (node) this._focusPromptNode(node, { panIntoView: true });
        this._clearInpaintSelection();
        this._setTool(TOOL_POINTER);
      }
    } else if (this._pointer?.mode === "select-rect") {
      const pointer = this._pointer;
      pointer.current = world;
      const rect = normalizeRect(pointer.start, pointer.current);
      this._pointer = null;
      if (rect.width > 4 && rect.height > 4) {
        this._selectWithinRect(rect, pointer.append);
      } else if (!pointer.append) {
        this._clearSelection();
      }
    } else if (this._pointer?.mode === "move-node") {
      this._updateMoveNodeDrag(event);
      this._pointer = null;
      this._engine?.commit_history_transaction?.();
      this._syncStateFromEngine();
      this._flushCollabMoveEnd();
      this._publishCollabAwareness();
    } else if (this._pointer?.mode === "resize-node") {
      const pointer = this._pointer;
      this._pointer = null;
      const size = this._resizeNodeSizeForWorld(pointer, world);
      this._patchNode(pointer.nodeId, size, { quiet: true });
      this._engine?.commit_history_transaction?.();
      this._syncStateFromEngine();
      this._flushCollabMoveEnd();
    } else if (this._pointer?.mode === "resize-inpaint") {
      this._updateInpaintResize(world);
      this._pointer = null;
    } else if (this._pointer?.mode === "drag-comment") {
      this._updateCommentDrag(world);
      this._pointer = null;
      this._commitCommentsChange();
    } else {
      this._pointer = null;
    }
    this._setPanning(false);
    this._releasePointer(event);
    this._draw();
    this._syncToolbar();
    this._syncPromptOverlays();
    this._publishCollabAwareness(world.x, world.y);
  }

  _resizeNodeSizeForWorld(pointer, world) {
    pointer.currentWorld = world;
    const rawWidth = pointer.startWidth + world.x - pointer.startWorld.x;
    const rawHeight = pointer.startHeight + world.y - pointer.startWorld.y;
    if (!this._shiftHeld) {
      pointer.activeAspectGuide = "";
      pointer.activeResolution = "";
      return constrainPromptDimensions(rawWidth, rawHeight);
    }
    const resolutionSnap = this._resizeResolutionSnap(rawWidth, rawHeight);
    if (resolutionSnap) {
      pointer.activeAspectGuide = resolutionSnap.guide.label;
      pointer.activeResolution = resolutionSnap.label;
      return resolutionSnap.size;
    }
    const guide = this._nearestResizeAspectGuide(rawWidth, rawHeight);
    pointer.activeAspectGuide = guide?.label || "";
    pointer.activeResolution = "";
    return constrainPromptDimensions(rawWidth, rawHeight);
  }

  _resizeResolutionSnap(rawWidth, rawHeight) {
    if (rawWidth <= 0 || rawHeight <= 0) return null;
    const scale = this._state.viewport.scale || 1;
    let best = null;
    RESIZE_ASPECT_GUIDES.forEach((guide) => {
      (RESIZE_ASPECT_RESOLUTIONS[guide.label] || []).forEach((label) => {
        const [width, height] = label.split("x").map((value) => Number(value) || 0);
        const screenDistance = Math.hypot(width - rawWidth, height - rawHeight) * scale;
        if (screenDistance > RESIZE_RESOLUTION_SNAP_SCREEN_THRESHOLD || (best && screenDistance >= best.screenDistance)) return;
        best = { guide, label, size: { width, height }, screenDistance };
      });
    });
    return best;
  }

  _nearestResizeAspectGuide(rawWidth, rawHeight) {
    if (rawWidth <= 0 || rawHeight <= 0) return null;
    const scale = this._state.viewport.scale || 1;
    let best = null;
    RESIZE_ASPECT_GUIDES.forEach((guide) => {
      const distance = Math.abs(guide.width * rawHeight - guide.height * rawWidth) / Math.hypot(guide.width, guide.height);
      const screenDistance = distance * scale;
      if (screenDistance > RESIZE_ASPECT_SNAP_SCREEN_THRESHOLD || (best && screenDistance >= best.screenDistance)) return;
      best = { guide, screenDistance };
    });
    return best?.guide || null;
  }

  _startPan(event, world, panSource) {
    event.preventDefault();
    this._refreshCanvasRect();
    this._capturePointer(event);
    this._pointer = {
      mode: "pan",
      panSource,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      world,
    };
    this._setPanning(true);
  }

  _updatePortDrag(world) {
    if (!this._dragPort) return;
    const target = this._promptInputHit(world.x, world.y);
    if (target) {
      const anchor = this._promptInputAnchor(target);
      this._dragPort.x = anchor.x;
      this._dragPort.y = anchor.y;
      this._dragPort.targetPromptId = target.id;
      this._dragPort.promptPreviewRect = null;
    } else {
      const previewRect = this._portDragPromptPreviewRect(world);
      this._dragPort.x = world.x;
      this._dragPort.y = world.y;
      this._dragPort.targetPromptId = "";
      this._dragPort.promptPreviewRect = this._isValidPortPromptDropRect(previewRect) ? previewRect : null;
    }
    this._smoothPortDragRender(this._dragPort, this._dragPort.x, this._dragPort.y);
    this._markCollabDirty();
  }

  _smoothPortDragRender(port, targetX, targetY) {
    if (!port) return;
    const alpha = 0.38;
    if (!Number.isFinite(port.renderX) || !Number.isFinite(port.renderY)) {
      port.renderX = targetX;
      port.renderY = targetY;
      return;
    }
    port.renderX += (targetX - port.renderX) * alpha;
    port.renderY += (targetY - port.renderY) * alpha;
  }

  async _onPaste(event) {
    const items = Array.from(event.clipboardData?.items || []);
    const imageItems = items.filter((item) => item.type?.startsWith("image/"));
    if (!imageItems.length) return;
    const diffuiPayload = parseDiffuiClipboardPayloadFromDataTransfer(event.clipboardData);
    const promptNode = this._focusedPromptNodeForEvent(event);
    event.preventDefault();
    if (promptNode) {
      const files = [];
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      if (files.length) await this._uploadPromptInputImages(files, promptNode, diffuiPayload);
    } else {
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (!file) continue;
        await this._uploadImageFile(file, null, diffuiPayload);
      }
    }
  }

  _onDragOver(event) {
    if (!hasDraggedImages(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const promptNode = this._promptNodeFromDragEvent(event);
    this._setPromptFileDragHover(promptNode?.id || "");
  }

  async _onDrop(event) {
    const imageFiles = imageFilesFromDataTransfer(event.dataTransfer);
    if (!imageFiles.length) return;
    event.preventDefault();
    this._setPromptFileDragHover("");
    const promptNode = this._promptNodeFromDragEvent(event);
    const world = this._eventWorld(event);
    try {
      if (promptNode) await this._uploadPromptInputImages(imageFiles, promptNode);
      else {
        for (const [index, file] of imageFiles.entries()) {
          const offset = index * 28;
          await this._uploadImageFile(file, { x: world.x + offset, y: world.y + offset });
        }
      }
    } catch (error) {
      this._setStatus(error.message || "Image drop failed");
    }
  }

  _setPromptFileDragHover(nodeId) {
    const next = String(nodeId || "");
    const prev = String(this._promptFileDragHoverId || "");
    if (prev === next) return;
    const layer = this.shadowRoot.getElementById("promptLayer");
    const toggleEditor = (id, active) => {
      const box = layer?.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
      box?.querySelector(".promptEditor")?.classList.toggle("promptEditorFileDragHover", active);
    };
    if (prev) toggleEditor(prev, false);
    this._promptFileDragHoverId = next;
    if (next) toggleEditor(next, true);
  }

  _promptNodeFromDragEvent(event) {
    const path = event.composedPath?.() || [];
    for (const item of path) {
      if (!(item instanceof HTMLElement)) continue;
      if (!item.classList.contains("promptBox")) continue;
      if (item.getRootNode() !== this.shadowRoot) continue;
      const nodeId = item.dataset.nodeId || "";
      if (!nodeId) continue;
      const node = this._state.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind === "image") continue;
      return node;
    }
    return null;
  }

  _promptInputPlacementOverlaps(rect, plannedRects = []) {
    const clearance = PROMPT_INPUT_PLACEMENT_CLEARANCE_PX;
    const padded = expandRect(rect, clearance);
    for (const node of this._state.nodes) {
      if (rectsIntersect(padded, nodeRect(node))) return true;
    }
    for (const extra of plannedRects) {
      if (extra && rectsIntersect(padded, extra)) return true;
    }
    return false;
  }

  _tryVerticalStackPlacementsForPromptInputs(promptNode, sizes, plannedRects = []) {
    const promptR = nodeRect(promptNode);
    const gap = PROMPT_INPUT_PROMPT_GAP_PX;
    const verticalGap = PROMPT_INPUT_STACK_VERTICAL_GAP_PX;
    const stepY = 32;
    const n = sizes.length;
    if (!n) return null;

    const constrained = sizes.map((s) =>
      constrainPromptDimensions(normalizeImageDimension(s.width), normalizeImageDimension(s.height)),
    );
    const widths = constrained.map((c) => c.width);
    const heights = constrained.map((c) => c.height);
    const maxW = Math.max(...widths);
    const totalHeight = heights.reduce((sum, h) => sum + h, 0) + Math.max(0, n - 1) * verticalGap;
    const midY = promptR.y + (promptR.height - totalHeight) / 2;

    const rowOffsetsFirstCentered = [];
    for (let k = 0; k <= 22; k += 1) {
      if (k === 0) rowOffsetsFirstCentered.push(0);
      else {
        rowOffsetsFirstCentered.push(k);
        rowOffsetsFirstCentered.push(-k);
      }
    }
    const rowOffsetsTopDown = [];
    for (let r = -22; r <= 22; r += 1) rowOffsetsTopDown.push(r);
    const centerVertically =
      this._connectedInputNodeIdsForNode(promptNode.id).length === 0 && plannedRects.length === 0;
    const rowOffsets = centerVertically ? rowOffsetsFirstCentered : rowOffsetsTopDown;

    for (let col = 0; col < 14; col += 1) {
      const columnShift = col * Math.max(40, Math.round(maxW * 0.08));
      const alignRightX = promptR.x - gap - columnShift;

      for (const rowOff of rowOffsets) {
        const startY = midY + rowOff * stepY;
        let y = startY;
        let ok = true;
        const rects = [];
        for (let i = 0; i < n; i += 1) {
          const w = widths[i];
          const h = heights[i];
          const x = alignRightX - w;
          rects.push({ x, y, width: w, height: h });
          y += h + verticalGap;
        }
        for (const rect of rects) {
          if (this._promptInputPlacementOverlaps(rect, plannedRects)) {
            ok = false;
            break;
          }
        }
        if (ok) return { alignRightX, startY };
      }
    }
    return null;
  }

  _findPiecemealPlacementForPromptInputImage(promptNode, width, height, plannedRects = []) {
    const w = normalizeImageDimension(width);
    const h = normalizeImageDimension(height);
    const promptR = nodeRect(promptNode);
    const gap = PROMPT_INPUT_PROMPT_GAP_PX;
    const stepY = 32;
    for (let col = 0; col < 16; col += 1) {
      const columnShift = col * Math.max(48, Math.round(w * 0.12));
      const x = promptR.x - gap - w - columnShift;
      for (let row = -22; row <= 22; row += 1) {
        const y = promptR.y + (promptR.height - h) / 2 + row * stepY;
        const rect = { x, y, width: w, height: h };
        if (!this._promptInputPlacementOverlaps(rect, plannedRects)) return { x, y };
      }
    }
    return {
      x: promptR.x - gap - w - 16 * Math.max(48, Math.round(w * 0.12)),
      y: promptR.y + (promptR.height - h) / 2,
    };
  }

  async _createPromptInputImageNode(file, promptNode, plannedRects, fixedPos = null, stackAlignRightX = null, clipboardPayload = null) {
    const pasted = await preparePastedImage(file);
    return this._commitPromptInputImageNode(file, pasted, promptNode, plannedRects, fixedPos, stackAlignRightX, clipboardPayload);
  }

  /**
   * Draw a pasted image from the clipboard bitmap: the decoded bitmap is stored
   * under the object URL the node points at, so the first frame needs no fetch.
   */
  _seedLocalImagePreview(pasted) {
    if (!pasted?.previewUrl || !pasted.image) return;
    if (!this._images.has(pasted.previewUrl)) this._images.set(pasted.previewUrl, pasted.image);
  }

  _releaseLocalImagePreview(previewUrl) {
    if (!previewUrl) return;
    this._images.delete(previewUrl);
    URL.revokeObjectURL(previewUrl);
  }

  /**
   * Upload the bytes behind an already-placed node, then swap the local preview
   * for the stored asset. The node spins from paste until analysis finishes, so
   * this never blocks the paste itself.
   */
  _uploadPastedImageAsset(nodeId, file, pasted, clipboardPayload = null, assetMetadata = {}) {
    const promise = this._runPastedImageAssetUpload(nodeId, file, pasted, clipboardPayload, assetMetadata)
      .catch((error) => {
        // Nothing awaits this by default, so a failure past the upload itself
        // has to be reported here rather than escaping unhandled.
        this._setStatus(error?.message || "Image upload failed");
        return null;
      })
      .finally(() => {
        if (this._pendingImageUploads.get(nodeId) === promise) this._pendingImageUploads.delete(nodeId);
      });
    this._pendingImageUploads.set(nodeId, promise);
    return promise;
  }

  /**
   * Generation and saves read the stored document, which only names the pasted
   * image once its upload lands — so both wait here first.
   */
  async _settlePendingImageUploads() {
    const pending = Array.from(this._pendingImageUploads.values());
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }

  async _runPastedImageAssetUpload(nodeId, file, pasted, clipboardPayload = null, assetMetadata = {}) {
    let asset = null;
    try {
      const response = await this._api(`/api/projects/${encodeURIComponent(this._projectId)}/canvas/assets`, {
        method: "POST",
        body: JSON.stringify({
          dataUrl: pasted.dataUrl,
          name: clipboardPayload?.name || file?.name || "Pasted image",
          metadata: this._clipboardAssetMetadata(clipboardPayload, assetMetadata),
        }),
      });
      asset = response?.asset || null;
    } catch (error) {
      // Nothing was stored, so the optimistic node would reload as a dead blob
      // URL. Drop it and say why.
      this._removeNodeById(nodeId);
      this._releaseLocalImagePreview(pasted.previewUrl);
      this._setStatus(error?.message || "Image upload failed");
      return null;
    }

    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node) {
      this._releaseLocalImagePreview(pasted.previewUrl);
      return asset;
    }
    const assetId = String(asset?.id || "");
    // An analysis event can land while the upload is still in flight, before any
    // node carries this asset id; the handler parks it here for exactly that.
    const parked = assetId ? this._pendingAssetAnalysis?.get(assetId) : null;
    if (assetId) this._pendingAssetAnalysis?.delete(assetId);
    const update = uploadedAssetNodeUpdate({
      nodeMetadata: safeParse(node.metadata_json) || {},
      images: this._nodeImages(node),
      asset,
      analysis: { ...assetAnalysisMetadata(asset), ...assetAnalysisMetadata(parked) },
      fallbackName: clipboardPayload?.name || file?.name || "Pasted image",
    });
    if (update.fileUrl) {
      // Keep drawing the clipboard bitmap under the stored URL: identical pixels,
      // no download flash when the node swaps over.
      if (pasted.image && !this._images.has(update.fileUrl)) this._images.set(update.fileUrl, pasted.image);
    }
    this._patchNode(nodeId, {
      name: update.name,
      image_url: update.fileUrl || node.image_url || "",
      status: "ready",
      metadata_json: update.metadataJson,
      images: update.images,
    }, { quiet: true });
    this._commitCollabState();
    this._syncPromptOverlays();
    this._draw();
    // Only once nothing points at it: the overlay sync above is what moves the
    // <img> off the preview URL.
    if (update.fileUrl) this._releaseLocalImagePreview(pasted.previewUrl);
    return asset;
  }

  _removeNodeById(nodeId) {
    const id = String(nodeId || "");
    if (!id) return;
    const remaining = this._state.nodes.filter((node) => node.id !== id);
    if (remaining.length === this._state.nodes.length) return;
    this._state.nodes = remaining;
    this._state.edges = this._state.edges.filter(
      (edge) => edge.from_node_id !== id && edge.to_node_id !== id,
    );
    this._engine?.load(JSON.stringify(this._state));
    this._syncStateFromEngine();
    this._commitCollabState();
    this._syncPromptOverlays();
    this._draw();
  }

  _commitPromptInputImageNode(file, pasted, promptNode, plannedRects, fixedPos = null, stackAlignRightX = null, clipboardPayload = null) {
    const imageSize = {
      width: normalizeImageDimension(pasted.width),
      height: normalizeImageDimension(pasted.height),
    };
    const pos =
      fixedPos && Number.isFinite(fixedPos.x) && Number.isFinite(fixedPos.y)
        ? fixedPos
        : this._findPiecemealPlacementForPromptInputImage(promptNode, imageSize.width, imageSize.height, plannedRects);
    // Draw from the clipboard bitmap now; the upload runs behind the same
    // spinner the analysis uses, so the node never waits on a round trip.
    this._seedLocalImagePreview(pasted);
    const metadata = pendingUploadMetadata({ promptInputNodeId: promptNode.id, ...this._clipboardNodeMetadata(clipboardPayload) });
    let imageNode = this._addImageNode({
      name: PASTE_ANALYZING_NAME,
      imageUrl: pasted.previewUrl,
      source: "prompt_input",
      x: pos.x,
      y: pos.y,
      width: imageSize.width,
      height: imageSize.height,
      metadata,
    });
    if (!imageNode) {
      this._releaseLocalImagePreview(pasted.previewUrl);
      return null;
    }
    this._uploadPastedImageAsset(imageNode.id, file, pasted, clipboardPayload, { promptInputNodeId: promptNode.id });

    if (stackAlignRightX != null && Number.isFinite(stackAlignRightX)) {
      let latest = this._state.nodes.find((item) => item.id === imageNode.id);
      if (latest) {
        const nx = stackAlignRightX - latest.width;
        if (Number.isFinite(nx) && Math.abs(nx - latest.x) > 1e-6) {
          this._patchNode(latest.id, { x: nx }, { quiet: true });
          latest = this._state.nodes.find((item) => item.id === imageNode.id) || latest;
        }
        imageNode = latest;
      }
    }

    this._addEdge(imageNode.id, promptNode.id, "prompt_input");
    plannedRects.push(nodeRect(imageNode));
    this._syncPromptOverlays();
    this._draw();
    return imageNode;
  }

  async _uploadPromptInputImages(files, promptNode, clipboardPayload = null) {
    const entries = [];
    for (const file of files) {
      const pasted = await preparePastedImage(file);
      entries.push({ file, pasted });
    }
    if (!entries.length) return;
    const sizes = entries.map((e) => ({
      width: normalizeImageDimension(e.pasted.width),
      height: normalizeImageDimension(e.pasted.height),
    }));
    const plannedRects = [];
    const stack = this._tryVerticalStackPlacementsForPromptInputs(promptNode, sizes, plannedRects);
    const useStack = Boolean(
      stack && Number.isFinite(stack.alignRightX) && Number.isFinite(stack.startY),
    );

    const created = [];
    let stackYCursor = useStack ? stack.startY : null;
    for (let i = 0; i < entries.length; i += 1) {
      const { file, pasted } = entries[i];
      let pos = null;
      let alignRx = null;
      if (useStack) {
        const cd = constrainPromptDimensions(
          normalizeImageDimension(pasted.width),
          normalizeImageDimension(pasted.height),
        );
        pos = { x: stack.alignRightX - cd.width, y: stackYCursor };
        alignRx = stack.alignRightX;
      }
      const node = this._commitPromptInputImageNode(file, pasted, promptNode, plannedRects, pos, alignRx, files.length === 1 ? clipboardPayload : null);
      if (node) created.push(node);
      if (useStack && node) {
        const latest = this._state.nodes.find((item) => item.id === node.id);
        if (latest) {
          stackYCursor = latest.y + latest.height + PROMPT_INPUT_STACK_VERTICAL_GAP_PX;
        }
      }
    }
    if (!created.length) return;
    this._fitWorldRectIntoView(
      unionRects([this._promptWorldRectForViewportFit(promptNode), ...created.map((n) => this._promptWorldRectForViewportFit(n))]),
      {
        animate: true,
        ifNeeded: false,
      },
    );
  }

  async _uploadImageFile(file, centerWorld = null, clipboardPayload = null) {
    const pasted = await preparePastedImage(file);
    const imageSize = { width: normalizeImageDimension(pasted.width), height: normalizeImageDimension(pasted.height) };
    const placed = centerWorld
      ? {
        x: centerWorld.x - imageSize.width / 2,
        y: centerWorld.y - imageSize.height / 2,
      }
      : placePastedNodeRect(
        this._state.nodes,
        imageSize.width,
        imageSize.height,
        this._pastePlacementViewportRect(),
      );
    this._seedLocalImagePreview(pasted);
    const metadata = pendingUploadMetadata(this._clipboardNodeMetadata(clipboardPayload));
    const node = this._addImageNode({
      name: PASTE_ANALYZING_NAME,
      imageUrl: pasted.previewUrl,
      source: clipboardPayload ? "clipboard" : "asset",
      x: placed.x,
      y: placed.y,
      width: imageSize.width,
      height: imageSize.height,
      metadata,
    });
    if (!node) {
      this._releaseLocalImagePreview(pasted.previewUrl);
      return;
    }
    // Not awaited: a multi-image paste should place every node at once rather
    // than queue each one behind the previous upload.
    this._uploadPastedImageAsset(node.id, file, pasted, clipboardPayload);
  }

  _clipboardAssetMetadata(payload, extra = {}) {
    const metadata = { ...extra };
    if (!payload || typeof payload !== "object") return metadata;
    const expandedJson = payload.expandedJson ?? payload.expanded_json;
    if (expandedJson) {
      metadata.expandedJson = expandedJson;
      metadata.analysisStatus = "done";
      metadata.promptReady = true;
    }
    metadata.clipboardSource = String(payload.source || "diffui").trim() || "diffui";
    return metadata;
  }

  _clipboardNodeMetadata(payload) {
    if (!payload || typeof payload !== "object") return {};
    const metadata = {
      clipboardSource: String(payload.source || "diffui").trim() || "diffui",
    };
    const expandedJson = payload.expandedJson ?? payload.expanded_json;
    if (expandedJson) {
      metadata.expandedJson = expandedJson;
      metadata.analysisStatus = "done";
      metadata.promptReady = true;
    }
    return metadata;
  }

  async _uploadPromptInputImage(file, promptNode, plannedRects = []) {
    const imageNode = await this._createPromptInputImageNode(file, promptNode, plannedRects);
    if (!imageNode) return;
    this._fitWorldRectIntoView(
      unionRects([this._promptWorldRectForViewportFit(imageNode), this._promptWorldRectForViewportFit(promptNode)]),
      { animate: true, ifNeeded: true },
    );
  }

  _promptWorldRectForViewportFit(node) {
    const base = nodeRect(node);
    if (!node || node.kind === "image") return base;
    const scale = Math.max(0.001, this._state.viewport.scale || 1);
    const headerPx = (node.selected ? NODE_HEADER_HEIGHT : 16) + 8;
    /** Prompt footer sits inside `node.height`; only bleed below the stage (resize handle / stack bar). */
    const bottomChromePx =
      node.selected && this._nodeImages(node).length > 1 ? 40 : 22;
    const analysisProcessing = this._nodeAnalysisProcessing(node);
    const outputChromePx = analysisProcessing ? 0 : this._nodeOutputGap(node) + NODE_RIGHT_CONNECTOR_WIDTH + 16;
    let stackSkewWorld = 0;
    if (this._displayableImagesForNode(node).length) {
      stackSkewWorld = STACK_LAYER_OFFSET * 3;
    }
    const topWorld = headerPx / scale;
    const bottomWorld = bottomChromePx / scale + stackSkewWorld;
    const rightWorld = outputChromePx / scale + stackSkewWorld;
    return {
      x: base.x,
      y: base.y - topWorld,
      width: base.width + rightWorld,
      height: base.height + topWorld + bottomWorld,
    };
  }

  _createPromptNode(rect, prompt = "", metadata = { createdFrom: "rectangle" }, options = {}) {
    if (!this._canEditCollab()) return null;
    const size = constrainPromptDimensions(rect.width, rect.height);
    const nextMetadata = {
      ...metadata,
      promptSuggestions: this._suggestionsForNewPromptNode(),
    };
    return this._addNode({
      id: `prompt-${crypto.randomUUID()}`,
      kind: "prompt",
      name: options.name ?? "Prompt",
      x: rect.x,
      y: rect.y,
      width: size.width,
      height: size.height,
      prompt,
      images: [],
      metadata_json: JSON.stringify(nextMetadata),
    }, options);
  }

  async _createCropNode(sourceNodeId, rect) {
    const source = this._state.nodes.find((node) => node.id === sourceNodeId);
    if (!source) return null;
    const sourceImage = this._activeImageForNode(source);
    if (!sourceImage) return null;
    const cropRect = intersectRects(rect, nodeRect(source));
    if (!cropRect) return null;
    const asset = await this._uploadCropAsset(source, sourceImage, cropRect);
    const node = this._addImageNode({
      name: `${source.name || "Image"} crop`,
      imageUrl: asset.asset?.displayFullUrl || asset.asset?.fileUrl || "",
      source: "crop",
      assetId: asset.asset?.id || "",
      sourceNodeId: source.id,
      ...this._cropNodePlacement(source, cropRect),
      width: snap_dimension(cropRect.width),
      height: snap_dimension(cropRect.height),
      metadata: {
        cropRect,
        ...assetAnalysisMetadata(asset.asset),
      },
    });
    if (!node) return null;
    this._selectNodeById(node.id);
    this._syncToolbar();
    this._syncPromptOverlays();
    this._draw();
    this._focusCropAndSource(source, node);
    return node;
  }

  async _copyInpaintSelection() {
    const state = this._inpaint;
    if (!state?.sourceNodeId || !state.cropRect) throw new Error("No selection to copy");
    if (navigator.clipboard?.write && window.ClipboardItem) {
      const blob = await this._inpaintSelectionBlob(state);
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      this._setStatus("Selection copied");
      this._showToast("Selection copied");
      return;
    }
    throw new Error("Copy unavailable");
  }

  async _inpaintSelectionBlob(state = this._inpaint) {
    const source = this._state.nodes.find((node) => node.id === state?.sourceNodeId);
    const sourceImage = this._activeImageForNode(source);
    const imageUrl = sourceImage?.image_url || sourceImage?.imageUrl || "";
    const img = this._imageFor(imageUrl);
    if (!source || !sourceImage || !img) throw new Error("Copy image unavailable");
    await waitForImage(img);
    const sourceRect = this._imageSourceRectForWorldCrop(source, state.cropRect, img);
    if (!sourceRect) throw new Error("Copy image unavailable");
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceRect.width));
    canvas.height = Math.max(1, Math.round(sourceRect.height));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Copy image unavailable"));
      }, "image/png");
    });
  }

  async _popOutInpaintSelection() {
    const state = this._inpaint;
    if (!state?.sourceNodeId || !state.cropRect) return;
    await this._createCropNode(state.sourceNodeId, state.cropRect);
    this._clearInpaintSelection();
  }

  async _uploadInpaintContextImages(files) {
    if (!this._inpaint) return;
    const uploaded = [];
    for (const file of files) {
      const pasted = await preparePastedImage(file);
      const asset = await this._api(`/api/projects/${encodeURIComponent(this._projectId)}/canvas/assets`, {
        method: "POST",
        body: JSON.stringify({
          dataUrl: pasted.dataUrl,
          name: file.name || "Inpaint context",
          metadata: { source: "inpaint_context", skipAnalysis: true },
        }),
      });
      URL.revokeObjectURL(pasted.previewUrl);
      if (asset.asset?.id) {
        uploaded.push({
          id: asset.asset.id,
          fileUrl: asset.asset.fileUrl || "",
          displayThumbUrl: asset.asset.displayThumbUrl || asset.asset.fileUrl || "",
        });
      }
    }
    if (!uploaded.length) return;
    this._inpaint.contextAssets = [...(this._inpaint.contextAssets || []), ...uploaded];
    this._syncInpaintPrompt();
    this._setStatus(`Added ${uploaded.length} inpaint context image${uploaded.length === 1 ? "" : "s"}`);
  }

  _removeInpaintContextImage(id) {
    if (!this._inpaint) return;
    const target = String(id || "");
    if (!target) return;
    const before = this._inpaint.contextAssets || [];
    const next = before.filter((asset) => String(asset.id || asset.displayThumbUrl || asset.fileUrl || asset.url || "") !== target);
    if (next.length === before.length) return;
    this._inpaint = { ...this._inpaint, contextAssets: next };
    this._syncInpaintPrompt();
  }

  async _generateInpaint(promptText) {
    if (!this._inpaint?.sourceNodeId || !this._inpaint.cropRect) return;
    const prompt = String(promptText || "").trim();
    if (!prompt) {
      this._setStatus("Describe the edit first.");
      return;
    }
    const node = this._state.nodes.find((item) => item.id === this._inpaint.sourceNodeId);
    if (!node) return;
    // An inpaint edit costs one option, so the same clamp decides whether it can start.
    if (!(await this._affordableGenerationCount(1))) return;
    const sourceNodeId = node.id;
    const sourceImageId = String(this._inpaint.sourceImageId || "");
    const cropRect = { ...this._inpaint.cropRect };
    const contextAssetIds = (this._inpaint.contextAssets || []).map((asset) => asset.id).filter(Boolean);
    const rawSlotId = `slot-${crypto.randomUUID()}`;
    const requestId = crypto.randomUUID();
    const existingImages = this._nodeImages(node);
    const activeReadyIndex = this._activeImageIndex(node);
    const sourceImage = this._activeImageForNode(node);
    const sourceImageUrl = sourceImage?.image_url || sourceImage?.imageUrl || "";
    const inpaintCropPercent = this._inpaintCropPercentForNode(node, cropRect);
    const rawSlot = {
      id: rawSlotId,
      name: "Inpaint edit",
      image_url: sourceImageUrl,
      status: "loading",
      metadata_json: JSON.stringify({
        source: "inpaint",
        variant: "openai_raw",
        promptNodeId: node.id,
        originalPrompt: prompt,
        requestId,
        slotIndex: 0,
        sourceImageId,
        inpaintCropRect: cropRect,
        inpaintCropPercent,
      }),
    };
    this._inpaint = {
      ...this._inpaint,
      prompt,
      requestId,
      rawSlotId,
      generating: true,
      promptHidden: true,
      previousStackIndex: activeReadyIndex,
    };
    this.shadowRoot.getElementById("selectionLayer")?.replaceChildren();
    this._drawEffectLayer();
    this._hideInpaintPromptOnly();
    this._patchNode(node.id, {
      images: [rawSlot, ...existingImages],
      stackIndex: 0,
      stack_index: 0,
      status: "loading",
      metadataJson: JSON.stringify({ ...(safeParse(node.metadata_json) || {}), inpaintGenerating: true, inpaintRequestId: requestId }),
    }, { quiet: true });
    this._syncStateFromEngine();
    this._commitCollabState();
    this._syncPromptOverlays();
    this._draw();
    requestAnimationFrame(() => this._syncPromptOverlays());
    try {
      // The server reads the edit slot out of the stored document, so a failed
      // staging write means the request cannot run. Roll the slot back rather
      // than leaving it loading on a request that was never sent.
      await this._saveState();
    } catch (error) {
      this._markInpaintRequestDone(requestId, { error: true });
      this._commitCollabState();
      this._setStatus("Could not save the canvas before editing. Try again.");
      throw error;
    }
    try {
      await this._api(`/api/projects/${encodeURIComponent(this._projectId)}/canvas/inpaint`, {
        method: "POST",
        body: JSON.stringify({
          requestId,
          nodeId: sourceNodeId,
          sourceNodeId,
          sourceImageId,
          slotNodeId: rawSlotId,
          rawSlotNodeId: rawSlotId,
          prompt,
          cropRect,
          inpaintCropPercent,
          contextAssetIds,
        }),
      });
    } catch (error) {
      if (isWalletBillingError(error) && this._claimFailedGenerationRequest(requestId)) {
        this._notifyCanvasWalletBlocked(error);
      }
      // Roll the edit slot back so it does not sit loading on a request that never started.
      this._markInpaintRequestDone(requestId, { error: true });
      this._commitCollabState();
      throw error;
    }
  }

  _hideInpaintPromptOnly() {
    const prompt = this.shadowRoot.getElementById("inpaintPrompt");
    if (prompt) {
      prompt.hidden = true;
      prompt.setLoading?.(true);
    }
  }

  _cropNodePlacement(source, cropRect) {
    const anchor = this._lowestCropNodeForSource(source) || source;
    return {
      x: anchor === source ? cropRect.x : anchor.x,
      y: anchor.y + anchor.height + CANVAS_NODE_CHAIN_GAP,
    };
  }

  _lowestCropNodeForSource(source) {
    let lowest = null;
    this._state.nodes.forEach((node) => {
      if (!node || node.id === source.id) return;
      const metadata = safeParse(node.metadata_json || node.metadataJson) || {};
      if (metadata.source !== "crop") return;
      if (metadata.sourceNodeId !== source.id) return;
      if (node.y < source.y + source.height) return;
      if (!lowest || node.y + node.height > lowest.y + lowest.height) lowest = node;
    });
    return lowest;
  }

  async _uploadCropAsset(sourceNode, sourceImage, cropRect) {
    const imageUrl = sourceImage.image_url || sourceImage.imageUrl || "";
    const img = this._imageFor(imageUrl);
    if (!img) throw new Error("crop_image_missing");
    await waitForImage(img);
    const sourceRect = this._imageSourceRectForWorldCrop(sourceNode, cropRect, img);
    if (!sourceRect) throw new Error("crop_rect_invalid");
    const size = fitLongestAxis(sourceRect.width, sourceRect.height, MAX_PROMPT_DIMENSION);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height, 0, 0, size.width, size.height);
    const dataUrl = canvas.toDataURL("image/png");
    return this._api(`/api/projects/${encodeURIComponent(this._projectId)}/canvas/assets`, {
      method: "POST",
      body: JSON.stringify({
        dataUrl,
        name: `${sourceNode.name || "Image"} crop`,
        metadata: {
          source: "crop",
        },
      }),
    });
  }

  _imageSourceRectForWorldCrop(sourceNode, cropRect, img) {
    const visibleCrop = intersectRects(cropRect, nodeRect(sourceNode));
    if (!visibleCrop) return null;
    const sourceBaseRect = this._imageDrawSourceRect(sourceNode, img);
    if (!sourceBaseRect) return null;
    const localX = (visibleCrop.x - sourceNode.x) / sourceNode.width;
    const localY = (visibleCrop.y - sourceNode.y) / sourceNode.height;
    const localWidth = visibleCrop.width / sourceNode.width;
    const localHeight = visibleCrop.height / sourceNode.height;
    return clampImageSourceRect({
      x: sourceBaseRect.x + sourceBaseRect.width * localX,
      y: sourceBaseRect.y + sourceBaseRect.height * localY,
      width: sourceBaseRect.width * localWidth,
      height: sourceBaseRect.height * localHeight,
    }, img);
  }

  _addImageNode({ name, imageUrl, source, assetId = "", imageId = "", sourceNodeId = "", x, y, width, height, metadata = {} }) {
    const image = {
      id: `slot-${crypto.randomUUID()}`,
      name,
      image_url: imageUrl,
      status: imageUrl ? "ready" : "loading",
      metadata_json: JSON.stringify({ source, assetId, imageId, sourceNodeId, ...metadata }),
    };
    return this._addNode({
      id: `node-${crypto.randomUUID()}`,
      kind: "prompt",
      name,
      x,
      y,
      width: normalizeImageDimension(width),
      height: normalizeImageDimension(height),
      prompt: "",
      images: [image],
      stack_index: 0,
      image_url: imageUrl,
      status: image.status,
      metadata_json: JSON.stringify({ source, assetId, imageId, sourceNodeId, ...metadata }),
    });
  }

  _addNode(node, options = {}) {
    this._engine?.add_node(JSON.stringify(node));
    this._syncStateFromEngine();
    if (!options.skipCommit) this._commitCollabState();
    this._syncPromptOverlays();
    this._draw();
    return this._state.nodes.find((item) => item.id === node.id) || null;
  }

  _addEdge(fromNodeId, toNodeId, kind, options = {}) {
    this._engine?.add_edge(
      JSON.stringify({
        id: `edge-${crypto.randomUUID()}`,
        kind,
        from_node_id: fromNodeId,
        to_node_id: toNodeId,
      }),
    );
    this._syncStateFromEngine();
    if (!options.skipCommit) this._commitCollabState();
  }

  _startGeneratePlunger(downEvent, btn, plungerBars, plungerSlide, nodeId) {
    if (btn?.disabled) return;
    const latest = this._state.nodes.find((item) => item.id === nodeId);
    if (!latest || this._nodeGenerationInFlight(latest)) return;
    const MAX_BARS = 8;
    const BAR_PITCH = 8; // 4px bar + 4px gap
    const FIRST_BAR_AT = 4;
    const MAX_PULL = FIRST_BAR_AT + (MAX_BARS - 1) * BAR_PITCH; // 60
    const OVER_PULL = 14;
    const DRAG_THRESHOLD = 4;
    const RESISTANCE = 2.0;
    const EDGE_PADDING = 6;
    const RESTING_LABEL = "Generate";
    const wrap = btn.closest(".generateWrap");
    const promptBox = btn.closest(".promptBox");
    const btnRect = btn.getBoundingClientRect();
    const promptBoxRect = promptBox?.getBoundingClientRect();
    const maxDrag = Math.max(40, (promptBoxRect ? btnRect.left - promptBoxRect.left : 200) - EDGE_PADDING);
    const startX = downEvent.clientX;
    let dragged = false;
    let lastCount = 0;
    let pull = 0;
    const setLabel = (count) => {
      if (count <= 0) {
        btn.textContent = RESTING_LABEL;
        return;
      }
      btn.textContent = `Generate ${count} ${count === 1 ? "design" : "designs"}`;
    };

    const setBarCount = (count) => {
      const existing = plungerBars.children.length;
      if (count > existing) {
        for (let i = existing; i < count; i += 1) {
          const bar = document.createElement("div");
          bar.className = "plungerBar";
          plungerBars.appendChild(bar);
          requestAnimationFrame(() => {
            bar.dataset.grown = "true";
          });
        }
      } else if (count < existing) {
        for (let i = existing - 1; i >= count; i -= 1) {
          const bar = plungerBars.children[i];
          if (bar) bar.remove();
        }
      }
      lastCount = count;
      setLabel(count);
    };

    const computeCount = (p) => {
      if (p < FIRST_BAR_AT) return 0;
      const c = Math.floor((p - FIRST_BAR_AT) / BAR_PITCH) + 1;
      return Math.max(0, Math.min(MAX_BARS, c));
    };

    // Cancel any in-flight release spring. A prior release can leave a
    // transitionend listener that never fires (identity → translateX(0)),
    // and the first count-bar's scaleY transition then bubbles and clears
    // translateX while plunging/bars stay active.
    if (typeof plungerSlide._plungerClearTransition === "function") {
      plungerSlide.removeEventListener("transitionend", plungerSlide._plungerClearTransition);
      if (plungerSlide._plungerClearTimer) {
        window.clearTimeout(plungerSlide._plungerClearTimer);
        plungerSlide._plungerClearTimer = 0;
      }
      plungerSlide._plungerClearTransition = null;
    }
    plungerSlide.style.transition = "none";
    plungerSlide.style.transform = "";

    const onMove = (event) => {
      const dx = event.clientX - startX;
      if (!dragged && -dx > DRAG_THRESHOLD) {
        dragged = true;
        if (wrap) wrap.dataset.plunging = "true";
      }
      if (!dragged) return;
      const rawDrag = Math.max(0, -dx);
      const t = Math.min(1, rawDrag / maxDrag);
      const eased = 1 - Math.pow(1 - t, RESISTANCE);
      pull = MAX_PULL * eased;
      const overflow = Math.max(0, rawDrag - maxDrag);
      const overPull = Math.min(OVER_PULL, overflow * 0.18);
      const visualPull = Math.min(MAX_PULL + OVER_PULL, pull + overPull);
      plungerSlide.style.transform = `translateX(${-visualPull}px)`;
      const count = computeCount(Math.min(MAX_PULL, pull));
      if (count !== lastCount) setBarCount(count);
      event.preventDefault();
    };
    const swallowClick = (event) => {
      event.stopPropagation();
      event.stopImmediatePropagation();
      event.preventDefault();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("keydown", onKey, true);
    };
    const release = (fire) => {
      const finalCount = lastCount;
      if (wrap) delete wrap.dataset.plunging;
      const clearTransition = (event) => {
        // Ignore bubbled transitionend from .plungerBar scaleY animations.
        if (event && event.target !== plungerSlide) return;
        plungerSlide.style.transition = "";
        plungerSlide.style.transform = "";
        plungerSlide.removeEventListener("transitionend", clearTransition);
        if (plungerSlide._plungerClearTimer) {
          window.clearTimeout(plungerSlide._plungerClearTimer);
          plungerSlide._plungerClearTimer = 0;
        }
        if (plungerSlide._plungerClearTransition === clearTransition) {
          plungerSlide._plungerClearTransition = null;
        }
      };
      plungerSlide._plungerClearTransition = clearTransition;
      plungerSlide.style.transition = "transform 320ms cubic-bezier(.2, 1.7, .35, 1)";
      plungerSlide.style.transform = "translateX(0)";
      plungerSlide.addEventListener("transitionend", clearTransition);
      plungerSlide._plungerClearTimer = window.setTimeout(() => clearTransition(null), 400);
      plungerBars.innerHTML = "";
      setLabel(0);
      if (fire && finalCount > 0) {
        const latest = this._state.nodes.find((item) => item.id === nodeId);
        if (latest && String(latest.prompt || "").trim() && !this._nodeGenerationInFlight(latest)) {
          const box = btn.closest(".promptBox");
          if (box) box.dataset.generating = "true";
          this._generateFromPromptNode(latest, { count: finalCount })
            .catch((error) => this._setStatus(error.message || "Generation failed"));
        }
      }
    };
    const onUp = (event) => {
      cleanup();
      if (dragged) {
        event.preventDefault();
        event.stopPropagation();
        btn.addEventListener("click", swallowClick, { capture: true, once: true });
        window.setTimeout(() => btn.removeEventListener("click", swallowClick, true), 0);
        release(true);
      } else {
        plungerSlide.style.transition = "";
        plungerSlide.style.transform = "";
      }
    };
    const onCancel = () => {
      cleanup();
      if (dragged) release(false);
      else { plungerSlide.style.transition = ""; plungerSlide.style.transform = ""; }
    };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      cleanup();
      if (dragged) {
        btn.addEventListener("click", swallowClick, { capture: true, once: true });
        window.setTimeout(() => btn.removeEventListener("click", swallowClick, true), 0);
        release(false);
      }
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("keydown", onKey, true);
  }

  /**
   * Cents one option costs here, from `GET /api/generation/pricing`: this project's team plan
   * rate, or the priciest active generator in a personal space. Returns 0 when the lookup fails
   * or no generator is active, which disables the affordability clamp instead of blocking
   * generation on a pricing hiccup -- the server still refuses the charge it cannot cover.
   */
  async _loadMaxOptionPriceCents() {
    if (this._maxOptionPriceFetchedAt && Date.now() - this._maxOptionPriceFetchedAt < OPTION_PRICE_TTL_MS) {
      return this._maxOptionPriceCents;
    }
    if (!this._maxOptionPricePromise) {
      // Team projects bill at their plan rate, so the clamp has to price this project's space.
      const scope = this._projectId ? `?projectId=${encodeURIComponent(this._projectId)}` : "";
      this._maxOptionPricePromise = this._api(`/api/generation/pricing${scope}`)
        .then((data) => {
          const cents = Number(data?.max_option_price_cents);
          this._maxOptionPriceCents = Number.isFinite(cents) && cents > 0 ? cents : 0;
          this._maxOptionPriceFetchedAt = Date.now();
          return this._maxOptionPriceCents;
        })
        .catch(() => 0)
        .finally(() => {
          this._maxOptionPricePromise = null;
        });
    }
    return this._maxOptionPricePromise;
  }

  /**
   * Reduce a generation request to the number of options the wallet covers at the
   * highest generator price, surfacing the shared out-of-credits toast and top-up
   * nudge whenever anything is blocked. Returns how many options to queue.
   */
  async _affordableGenerationCount(requestedCount) {
    const requested = Math.max(0, Math.round(Number(requestedCount) || 0));
    if (!requested) return 0;
    const user = getCurrentUser();
    const walletCents = this._billingWorkspaceId
      ? Number(this._billingWalletCents || 0)
      : Number(user?.wallet_cents || 0);
    const result = affordableOptionCount({
      requestedCount: requested,
      walletCents,
      priceCents: await this._loadMaxOptionPriceCents(),
      isAdmin: !!user?.is_admin,
      hasWallet: !!user,
    });
    if (!result.clamped) return result.count;
    this._notifyCanvasWalletBlocked(walletCents > 0 ? "insufficient_wallet" : "wallet_depleted", {
      message: result.limited
        ? `Only enough credits for ${result.count} of ${requested} image${requested === 1 ? "" : "s"}. Generating ${result.count} — top up your wallet for the rest.`
        : "",
    });
    return result.count;
  }

  setBillingWallet({ workspaceId = "", cents = 0 } = {}) {
    const nextId = String(workspaceId || "").trim();
    if (nextId !== (this._billingWorkspaceId || "")) return;
    this._billingWalletCents = Number(cents) || 0;
  }

  bindBillingWallet({ workspaceId = "", cents = 0 } = {}) {
    this._billingWorkspaceId = String(workspaceId || "").trim();
    this._billingWalletCents = Number(cents) || 0;
  }

  /** Out-of-credits toast plus the nav top-up nudge, the same pair the other flows use. */
  _notifyCanvasWalletBlocked(error, { message = "" } = {}) {
    notifyInsufficientCredits("canvas-generation", error, { forceNudge: true, message });
  }

  /**
   * True the first time a request id is reported as failed. One failure can arrive
   * as a canvas_generation_error and again as a generation_job_error, and the user
   * should only see one toast for it.
   */
  _claimFailedGenerationRequest(requestId) {
    const id = String(requestId || "");
    if (!id) return true;
    if (this._failedGenerationRequestIds.has(id)) return false;
    this._failedGenerationRequestIds.add(id);
    if (this._failedGenerationRequestIds.size > 64) {
      this._failedGenerationRequestIds.delete(this._failedGenerationRequestIds.values().next().value);
    }
    return true;
  }

  async _generateFromPromptNode(node, { select = true, count = 4 } = {}) {
    if (!this._canEditCollab()) return;
    const prompt = String(node.prompt || "").trim();
    if (!prompt) return;
    // The stack "+" is the way to queue more options while a batch runs; a plain generate that
    // lands on an already-generating node is a duplicate of the run in flight.
    if (this._nodeGenerationInFlight(node)) return;
    const requestCount = await this._affordableGenerationCount(Math.max(1, Math.min(8, Math.round(Number(count) || 4))));
    if (!requestCount) {
      // Nothing was queued, so drop the optimistic "generating" styling the
      // generate button applied on click.
      this._syncPromptOverlays();
      return;
    }
    if (select) this._selectNodeById(node.id);
    this._syncPromptOverlays();
    this._syncToolbar();
    this._requestGeneratedNodeTitle(node.id, prompt).catch((error) => {
      this._setStatus(error.message || "Title generation failed");
    });
    this._scheduleCanvasPromptSuggestions({ delay: 80 });
    await this._requestNodeImageGeneration(node, { replace: true, count: requestCount });
  }

  async _requestNodeImageGeneration(node, { replace = false, count = 4, source = "generate" } = {}) {
    // Input images pasted a moment ago may still be uploading; the server reads
    // them from the stored document, so their real URLs have to land first.
    await this._settlePendingImageUploads();
    const latest = this._state.nodes.find((item) => item.id === node.id) || node;
    const prompt = this._promptTextForNode(latest) || String(latest.prompt || "").trim();
    if (!prompt) {
      this._logStackAdd("requestNodeImageGeneration blocked: no prompt", { source, nodeId: latest.id });
      this._setStatus("Add a prompt before generating.");
      return;
    }
    node = latest;
    const generationSize = constrainPromptDimensions(node.width, node.height);
    if (generationSize.width !== node.width || generationSize.height !== node.height) {
      this._patchNode(node.id, generationSize, { quiet: true });
      node = { ...node, ...generationSize };
      this._syncPromptOverlays();
      this._draw();
    }
    const existingImages = replace ? [] : this._nodeImages(node);
    const available = Math.max(0, MAX_NODE_IMAGES - existingImages.length);
    const slotCount = Math.max(0, Math.min(count, available));
    if (!slotCount) {
      this._logStackAdd("requestNodeImageGeneration blocked: no slots", { source, nodeId: node.id, available });
      this._setStatus(`Stacks are limited to ${MAX_NODE_IMAGES} images.`);
      return;
    }
    const requestCount = await this._affordableGenerationCount(slotCount);
    if (!requestCount) {
      this._logStackAdd("requestNodeImageGeneration blocked: wallet", { source, nodeId: node.id, slotCount });
      this._syncPromptOverlays();
      this._draw();
      return;
    }
    const requestId = crypto.randomUUID();
    const slotIds = Array.from({ length: requestCount }, () => `slot-${crypto.randomUUID()}`);
    const images = slotIds.map((slotId, index) => ({
      id: slotId,
      name: `Image ${existingImages.length + index + 1}`,
      image_url: "",
      status: "loading",
      metadata_json: JSON.stringify({
        source: "generation",
        promptNodeId: node.id,
        originalPrompt: prompt,
        slotIndex: existingImages.length + index,
        requestId,
        // When this slot started waiting, so a request that never reached the
        // server can be told apart from one still running. See
        // abandonedGenerationRequests.
        startedAt: Date.now(),
      }),
    }));
    const startMetadata = {
      ...(safeParse(node.metadata_json) || {}),
      generating: true,
      generationRequestId: requestId,
    };
    delete startMetadata.generationError;
    this._patchNode(node.id, {
      images: replace ? images : [...existingImages, ...images],
      stackIndex: replace ? 0 : this._activeImageIndex(node),
      status: "loading",
      imageUrl: replace ? "" : node.image_url || "",
      metadataJson: JSON.stringify(startMetadata),
    }, { quiet: true });
    this._syncPromptOverlays();
    this._draw();
    this._commitCollabState();
    try {
      // The server resolves this node's inputs and its slots from the stored
      // document, so the generation cannot start until the staging write lands.
      // A failure here used to escape with the slots still spinning: no request
      // was ever sent, so no canvas_generation_error came back to clear them.
      await this._saveState();
    } catch (error) {
      const message = "Could not save the canvas before generating. Try again.";
      this._logStackAdd("save before generate failed", { source, nodeId: node.id, requestId, error: error?.message || String(error) });
      this._clearNodeGenerationState(node.id, requestId, {
        removeLoadingSlots: true,
        errorMessage: message,
        error: { code: "canvas_save_failed", message, count: requestCount },
      });
      throw error;
    }
    const brandSelection = this._promptBrandIdForNode(node);
    const soloPromptCanvas = this._isSoloPromptCanvas();
    const styleRandomize = brandSelection === PROMPT_BRAND_RANDOMIZE || (soloPromptCanvas && !brandSelection);
    const generateBody = {
      prompt,
      nodeId: node.id,
      slotNodeIds: slotIds,
      inputNodeIds: this._generationInputNodeIdsForNode(node),
      inputImages: this._generationInputImagesForNode(node),
      inputMentions: this._generationInputMentionsForNode(node),
      width: Math.round(generationSize.width),
      height: Math.round(generationSize.height),
      requestId,
      // Names this browser session so the server can tell a peer echoing one user action apart
      // from this client deliberately asking again.
      clientId: this._collabClientId(),
      brand_id: styleRandomize ? "" : brandSelection,
      style_randomize: styleRandomize,
    };
    this._logStackAdd("POST /canvas/generate", {
      source,
      nodeId: node.id,
      requestCount,
      requestId,
      slotNodeIds: slotIds,
      inputNodeIds: generateBody.inputNodeIds,
      inputImages: generateBody.inputImages,
    });
    let response;
    try {
      response = await this._api(`/api/projects/${encodeURIComponent(this._projectId)}/canvas/generate`, {
        method: "POST",
        body: JSON.stringify(generateBody),
      });
    } catch (error) {
      // The slots just reserved will never fill, so resolve them into the retry
      // state instead of leaving placeholders spinning.
      const billingError = isWalletBillingError(error);
      const message = billingError ? "Not enough credits to start this generation." : "Generation request failed.";
      this._logStackAdd("POST /canvas/generate failed", { source, nodeId: node.id, requestId, error: error?.message || String(error) });
      if (billingError && this._claimFailedGenerationRequest(requestId)) this._notifyCanvasWalletBlocked(error);
      this._clearNodeGenerationState(node.id, requestId, {
        removeLoadingSlots: true,
        errorMessage: message,
        error: { code: billingError ? "insufficient_wallet" : "generation_failed", message, count: requestCount },
      });
      if (billingError) return;
      throw error;
    }
    const winner = coalescedGeneration(response, requestId);
    if (winner) {
      this._logStackAdd("POST /canvas/generate coalesced", {
        source,
        nodeId: node.id,
        requestId,
        winningRequestId: winner.requestId,
      });
      this._adoptCoalescedGeneration(node.id, requestId, winner);
      return;
    }
    this._logStackAdd("POST /canvas/generate ok", { source, nodeId: node.id, requestId });
    this._notifyCanvasCoach("generation-started", { nodeId: node.id, requestId, source });
  }

  /**
   * Hand a node over from the request this client sent to the job the server already had running
   * for the same action. The placeholders reserved here will never be filled, so they come out
   * before the winning job's slots go in and the node keeps showing one batch in flight.
   */
  _adoptCoalescedGeneration(nodeId, droppedRequestId, winner) {
    this._clearNodeGenerationState(nodeId, droppedRequestId, { removeLoadingSlots: true });
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (node) {
      const metadata = safeParse(node.metadata_json || node.metadataJson) || {};
      if (String(metadata.generationRequestId || "") === droppedRequestId) {
        delete metadata.generationRequestId;
        delete metadata.generating;
        this._patchNode(nodeId, { metadataJson: JSON.stringify(metadata) }, { quiet: true });
      }
    }
    this._applyCanvasGenerationStarted({
      nodeId: winner.nodeId || nodeId,
      requestId: winner.requestId,
      slotNodeIds: winner.slotNodeIds,
    });
  }

  _generationInputNodeIdsForNode(node) {
    const ids = [];
    const seen = new Set();
    const connectedInputIds = this._connectedInputNodeIdsForNode(node?.id || "");
    const connected = new Set(connectedInputIds);
    const add = (id) => {
      id = String(id || "").trim();
      if (!id || seen.has(id) || !connected.has(id)) return;
      seen.add(id);
      ids.push(id);
    };
    const mentionedInputIds = this._mentionedInputNodeIdsForPrompt(node);
    mentionedInputIds.forEach(add);
    if (mentionedInputIds.length) return ids;
    connectedInputIds.forEach(add);
    return ids;
  }

  _generationInputImagesForNode(node) {
    return this._generationInputNodeIdsForNode(node)
      .map((nodeId) => {
        const source = this._state.nodes.find((item) => item.id === nodeId);
        const image = this._activeImageForNode(source);
        const metadata = safeParse(image?.metadata_json || image?.metadataJson) || {};
        const imageId = String(image?.id || "").trim();
        const generationImageId = String(metadata.imageId || metadata.image_id || "").trim();
        const imageUrl = String(image?.image_url || image?.imageUrl || "").trim();
        if (!nodeId || (!imageId && !generationImageId && !imageUrl)) return null;
        return { nodeId, imageId, generationImageId, imageUrl };
      })
      .filter(Boolean);
  }

  _generationInputMentionsForNode(node) {
    const connected = new Set(this._connectedInputNodeIdsForNode(node?.id || ""));
    return this._mentionTokensForNode(node)
      .map((mention) => ({
        nodeId: mention.nodeId,
        label: mention.label,
        start: mention.start,
        end: mention.end,
      }))
      .filter((mention) => mention.nodeId && mention.label && connected.has(mention.nodeId));
  }

  _mentionedInputNodeIdsForPrompt(node) {
    const tokenIds = this._mentionTokensForNode(node).map((mention) => mention.nodeId).filter(Boolean);
    if (tokenIds.length) return tokenIds;
    const prompt = String(node?.prompt || "");
    if (!prompt.includes("@")) return [];
    const ids = [];
    const seen = new Set();
    const candidates = this._mentionableImageNodes(node?.id || "")
      .sort((a, b) => b.name.length - a.name.length);
    candidates.forEach((item) => {
      const match = this._promptHasMention(prompt, item.name);
      if (!match || seen.has(item.id)) return;
      seen.add(item.id);
      ids.push({ id: item.id, index: match.index });
    });
    return ids.sort((a, b) => a.index - b.index).map((item) => item.id);
  }

  _promptHasMention(prompt, name) {
    const needle = `@${name}`;
    let at = prompt.indexOf(needle);
    while (at >= 0) {
      const before = at === 0 ? "" : prompt[at - 1];
      const after = prompt[at + needle.length] || "";
      const beforeOk = !before || /\s|[([{,.;:!?]/.test(before);
      const afterOk = !after || /\s|[)\]},.;:!?]/.test(after);
      if (beforeOk && afterOk) return { index: at };
      at = prompt.indexOf(needle, at + 1);
    }
    return null;
  }

  async _requestGeneratedNodeTitle(nodeId, prompt) {
    const data = await this._api(`/api/projects/${encodeURIComponent(this._projectId)}/explorations/titles`, {
      method: "POST",
      body: JSON.stringify({ prompt, includeFileTitle: true }),
    });
    const pageTitle = String(data?.pageTitle || "").trim();
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    if (pageTitle) {
      this._patchNode(nodeId, { name: pageTitle }, { quiet: true });
      this._syncPromptOverlays();
      this._syncToolbar();
      this._draw();
    }
    const fileTitle = String(data?.fileTitle || "").trim();
    this._maybeApplySuggestedFileTitle(fileTitle, node);
  }

  _maybeApplySuggestedFileTitle(fileTitle, node) {
    const title = String(fileTitle || "").trim();
    if (!title || !node || !this._projectId) return;
    if (this._suggestedFileTitle === title) return;
    if (!this._projectTitleLooksUntitled(this._projectFileTitle)) return;
    if (!this._isFirstTitleSourceNode(node)) return;
    this._suggestedFileTitle = title;
    this._projectFileTitle = title;
    this._syncFileSettingsForm();
    this.dispatchEvent(
      new CustomEvent("diffui-canvas:file-title", {
        bubbles: true,
        composed: true,
        detail: { title },
      }),
    );
    this._api(`/api/projects/${encodeURIComponent(this._projectId)}`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: title }),
    }).catch((error) => {
      this._setStatus(error.message || "File title update failed");
    });
  }

  _projectTitleLooksUntitled(title) {
    const normalized = String(title || "").trim().toLowerCase();
    return normalized === "" || normalized === "untitled" || normalized === "untitled canvas";
  }

  _isFirstTitleSourceNode(node) {
    const nodes = Array.isArray(this._state?.nodes) ? this._state.nodes : [];
    if (!nodes.length) return false;
    if (nodes[0]?.id === node.id) return true;
    const firstImageNode = nodes.find((item) => this._nodeImages(item).length > 0);
    return firstImageNode?.id === node.id;
  }

  _createVariationPrompt(node, prompt = "") {
    const activeImage = this._activeImageForNode(node);
    const metadata = safeParse(activeImage?.metadata_json) || safeParse(node.metadata_json) || {};
    const size = constrainPromptDimensions(node.width, node.height);
    const placed = autoPlaceNodeRect(this._state.nodes, size.width, size.height, [nodeRect(node)]);
    const p = {
      id: `prompt-${crypto.randomUUID()}`,
      kind: "prompt",
      name: "Variation prompt",
      x: placed.x,
      y: placed.y,
      ...size,
      prompt,
      images: [],
      metadata_json: JSON.stringify({ variationSourceNodeId: node.id, imageId: metadata.imageId || "" }),
    };
    this._addNode(p);
  }

  _createEditPromptForNode(node) {
    const activeImage = this._activeImageForNode(node);
    if (!node || !activeImage) return;
    const metadata = safeParse(activeImage.metadata_json) || safeParse(node.metadata_json) || {};
    const promptNode = this._createPromptNode(this._outputPromptRectForNode(node), "", {
      createdFrom: "ask_edits",
      inputNodeId: node.id,
      sourceNodeId: node.id,
      imageId: metadata.imageId || activeImage.id || "",
    }, { name: "Edit prompt" });
    if (!promptNode) return;
    this._addEdge(node.id, promptNode.id, "prompt_input");
    this._focusPromptNode(promptNode, { panIntoView: true });
    this._setStatus("Edit prompt created");
  }

  _outputPromptRectForNode(node) {
    const size = constrainPromptDimensions(node.width, node.height);
    return autoPlaceNodeRect(this._state.nodes, size.width, size.height, [nodeRect(node)]);
  }

  _deleteSelected() {
    if (!this._canEditCollab()) return;
    this._engine?.delete_selected();
    this._syncStateFromEngine();
    this._commitCollabState();
    this._hideInspector();
    this._syncToolbar();
    this._syncPromptOverlays();
    this._draw();
  }

  /** delta < 0 sends toward bottom (earlier draw); delta > 0 brings toward top. */
  _nudgeSelectedZOrder(delta) {
    if (!this._canEditCollab()) return;
    if (!this._engine?.nudge_selected_z?.(delta)) return;
    this._syncStateFromEngine();
    this._syncPromptOverlayZOrder();
    this._commitCollabState();
    this._draw();
  }

  _syncPromptOverlayZOrder() {
    const layer = this.shadowRoot.getElementById("promptLayer");
    if (!layer) return;
    this._state.nodes.forEach((node, index) => {
      const box = layer.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
      if (!box) return;
      box.style.zIndex = String(index + 1);
      layer.appendChild(box);
    });
  }

  _pastePlacementViewportRect() {
    const rect = this._viewportWorldRect();
    const scale = Math.max(0.001, this._state.viewport.scale || 1);
    const margin = VIEWPORT_FIT_MARGIN_PX / scale;
    return {
      x: rect.x + margin,
      y: rect.y + margin,
      width: Math.max(1, rect.width - 2 * margin),
      height: Math.max(1, rect.height - 2 * margin),
    };
  }

  _undo() {
    if (!this._canEditCollab()) return;
    if (!this._engine?.undo()) return;
    this._syncStateFromEngine();
    this._commitCollabState();
    this._syncPromptOverlays();
    this._draw();
  }

  _redo() {
    if (!this._canEditCollab()) return;
    if (!this._engine?.redo()) return;
    this._syncStateFromEngine();
    this._commitCollabState();
    this._syncPromptOverlays();
    this._draw();
  }

  _find(query) {
    const previousQuery = this._lastFind;
    this._lastFind = query.trim().toLowerCase();
    // A search is one use of the tool, not one per keystroke, so this reports
    // the first character typed into an empty box and stays quiet while the
    // query is refined.
    if (this._lastFind && !previousQuery) {
      this._trackClick(UI_TELEMETRY_EVENTS.CANVAS_TOOL_USE, TOOL_FIND, "find_query");
    }
    this._state.nodes.forEach((node) => (node.selected = false));
    this._state.edges.forEach((edge) => (edge.selected = false));
    if (this._lastFind) {
      const found = this._state.nodes.find((node) => {
        const haystack = `${node.name || ""} ${node.prompt || ""} ${node.metadata_json || ""}`.toLowerCase();
        return haystack.includes(this._lastFind);
      });
      if (found) {
        found.selected = true;
        this._state.viewport.x = this.clientWidth / 2 - (found.x + found.width / 2) * this._state.viewport.scale;
        this._state.viewport.y = this.clientHeight / 2 - (found.y + found.height / 2) * this._state.viewport.scale;
        this._engine?.load(JSON.stringify(this._state));
      }
    }
    this._syncToolbar();
    this._syncPromptOverlays();
    this._draw();
  }

  _toggleInspector(node) {
    const inspector = this.shadowRoot.getElementById("inspector");
    if (!inspector.hidden && inspector.dataset.nodeId === node.id) {
      this._hideInspector();
      return;
    }
    this._showInspector(node);
  }

  _showInspector(node) {
    const inspector = this.shadowRoot.getElementById("inspector");
    const activeImage = this._activeImageForNode(node);
    if (!inspector || !activeImage) {
      this._hideInspector();
      return;
    }
    const promptJSON = this._promptJSONForNode(node);
    inspector.dataset.nodeId = node.id;
    inspector.dataset.promptJson = promptJSON;
    const name = this.shadowRoot.getElementById("inspectorNameInput");
    const width = this.shadowRoot.getElementById("inspectorWidth");
    const height = this.shadowRoot.getElementById("inspectorHeight");
    const inputCount = this.shadowRoot.getElementById("inspectorInputCount");
    const inputs = this.shadowRoot.getElementById("inspectorInputs");
    const brandSection = this.shadowRoot.getElementById("inspectorBrandSection");
    const brandInputCount = this.shadowRoot.getElementById("inspectorBrandInputCount");
    const brandInputs = this.shadowRoot.getElementById("inspectorBrandInputs");
    const prompt = this.shadowRoot.getElementById("inspectorPrompt");
    const variantBtn = this.shadowRoot.getElementById("generateVariantBtn");
    if (name && this.shadowRoot.activeElement !== name) name.value = node.name || activeImage.name || "Image node";
    if (width) width.textContent = String(Math.round(node.width));
    if (height) height.textContent = String(Math.round(node.height));
    if (prompt) prompt.textContent = this._promptPanelTextForNode(node);
    if (variantBtn) {
      const images = this._nodeImages(node);
      variantBtn.toggleAttribute("disabled", images.length >= MAX_NODE_IMAGES);
    }
    this._syncInspectorInputImages(inputs, inputCount, node);
    this._syncInspectorBrand(brandSection, node);
    this._syncInspectorBrandInputImages(brandInputs, brandInputCount, node);
    inspector.hidden = false;
  }

  _commitInspectorNameChange() {
    const inspector = this.shadowRoot.getElementById("inspector");
    const input = this.shadowRoot.getElementById("inspectorNameInput");
    const nodeId = inspector?.dataset.nodeId || "";
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!input || !node) return;
    const nextName = String(input.value || "").trim() || "Untitled node";
    if (input.value !== nextName) input.value = nextName;
    this._commitNodeName(node, nextName);
  }

  _commitNodeName(node, rawName) {
    if (!node) return;
    const nextName = String(rawName || "").trim() || "Untitled node";
    if (node.name === nextName) return;
    this._patchNode(node.id, { name: nextName }, { quiet: true });
    this._syncPromptOverlays();
    this._syncToolbar();
    this._draw();
  }

  _promptBoxForNode(nodeId) {
    const layer = this.shadowRoot.getElementById("promptLayer");
    if (!layer || !nodeId) return null;
    return layer.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
  }

  _cancelNodeHeaderRename() {
    const nodeId = this._nodeRenameNodeId;
    if (!nodeId) return;
    const box = this._promptBoxForNode(nodeId);
    const header = box?.querySelector(".nodeHeader");
    const title = box?.querySelector(".nodeTitle");
    const input = header?.querySelector(".nodeTitleInput");
    input?.remove();
    if (title) title.hidden = false;
    if (header) delete header.dataset.renaming;
    this._nodeRenameNodeId = "";
  }

  _startNodeHeaderRename(node) {
    if (!node || !this._canEditCollab() || node.kind === "image") return;
    this._cancelNodeHeaderRename();
    const box = this._promptBoxForNode(node.id);
    const header = box?.querySelector(".nodeHeader");
    const title = box?.querySelector(".nodeTitle");
    if (!header || !title) return;
    const originalName = node.name || "";
    this._nodeRenameNodeId = node.id;
    title.hidden = true;
    header.dataset.renaming = "true";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "nodeTitleInput";
    input.value = originalName;
    input.setAttribute("aria-label", "Node name");
    input.autocomplete = "off";
    input.spellcheck = false;
    const finish = (commit) => {
      if (this._nodeRenameNodeId !== node.id) return;
      const currentInput = header.querySelector(".nodeTitleInput");
      const value = currentInput?.value ?? originalName;
      currentInput?.remove();
      title.hidden = false;
      delete header.dataset.renaming;
      this._nodeRenameNodeId = "";
      if (commit) {
        this._commitNodeName(node, value);
        const latest = this._state.nodes.find((item) => item.id === node.id);
        const nextName = latest?.name || node.name || "";
        title.textContent = nextName;
        const inspector = this.shadowRoot.getElementById("inspector");
        if (inspector?.dataset.nodeId === node.id && !inspector.hidden) {
          const inspectorName = this.shadowRoot.getElementById("inspectorNameInput");
          if (inspectorName && this.shadowRoot.activeElement !== inspectorName) {
            inspectorName.value = nextName;
          }
        }
      } else {
        title.textContent = originalName;
      }
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("click", (event) => event.stopPropagation());
    header.insertBefore(input, title.nextSibling);
    input.focus();
    input.select();
  }

  _hideInspector() {
    const inspector = this.shadowRoot.getElementById("inspector");
    inspector.hidden = true;
    delete inspector.dataset.nodeId;
    delete inspector.dataset.promptJson;
  }

  _syncInspectorInputImages(container, countEl, node) {
    if (!container) return;
    const images = this._inputPreviewImagesForNode(node);
    if (countEl) countEl.textContent = String(images.length);
    const urls = images.map((image) => image.image_url || image.imageUrl || "").filter(Boolean).slice(0, 6);
    const key = urls.join("\n");
    if (container.dataset.urls === key) return;
    container.dataset.urls = key;
    container.replaceChildren();
    if (!urls.length) {
      const empty = document.createElement("div");
      empty.className = "panelEmpty";
      empty.textContent = "No connected input images.";
      container.appendChild(empty);
      return;
    }
    urls.forEach((url) => {
      const thumb = document.createElement("div");
      thumb.className = "panelThumb";
      const img = document.createElement("img");
      img.alt = "";
      img.src = resolveEmbedAssetUrl(url);
      thumb.appendChild(img);
      container.appendChild(thumb);
    });
  }

  _syncInspectorBrandInputImages(container, countEl, node) {
    if (!container) return;
    const section = this.shadowRoot.getElementById("inspectorBrandInputsSection");
    const activeImage = this._activeImageForNode(node);
    const metadata = safeParse(activeImage?.metadata_json) || {};
    const images = Array.isArray(metadata.brandInputs) ? metadata.brandInputs : Array.isArray(activeImage?.brandInputs) ? activeImage.brandInputs : [];
    if (section) section.hidden = images.length === 0;
    if (countEl) countEl.textContent = String(images.length);
    const urls = images.map((image) => image.imageUrl || image.image_url || image.fileUrl || image.file_url || "").filter(Boolean).slice(0, 10);
    const key = urls.join("\n");
    if (container.dataset.urls === key) return;
    container.dataset.urls = key;
    container.replaceChildren();
    if (!urls.length) {
      const empty = document.createElement("div");
      empty.className = "panelEmpty";
      empty.textContent = "No brand inputs.";
      container.appendChild(empty);
      return;
    }
    urls.forEach((url) => {
      const thumb = document.createElement("div");
      thumb.className = "panelThumb";
      const img = document.createElement("img");
      img.alt = "";
      img.src = resolveEmbedAssetUrl(url);
      thumb.appendChild(img);
      container.appendChild(thumb);
    });
  }

  _syncInspectorBrand(section, node) {
    if (!section) return;
    const activeImage = this._activeImageForNode(node);
    const metadata = safeParse(activeImage?.metadata_json) || {};
    const brand = metadata.brand && typeof metadata.brand === "object" ? metadata.brand : activeImage?.brand && typeof activeImage.brand === "object" ? activeImage.brand : null;
    const id = String(brand?.id || "").trim();
    section.hidden = !id;
    if (!id) return;
    const name = this.shadowRoot.getElementById("inspectorBrandName");
    const logo = this.shadowRoot.getElementById("inspectorBrandLogo");
    const label = String(brand?.name || "Brand").trim() || "Brand";
    if (name && name.textContent !== label) name.textContent = label;
    this._patchPanelBrandLogo(logo, String(brand?.logoUrl || brand?.logo_url || ""));
  }

  _patchPanelBrandLogo(container, logoURL) {
    if (!container) return;
    const url = resolveEmbedAssetUrl(String(logoURL || "").trim());
    if (!url) {
      container.replaceChildren();
      container.textContent = "+";
      return;
    }
    let img = container.querySelector("img");
    if (!img) {
      container.replaceChildren();
      img = document.createElement("img");
      img.alt = "";
      container.appendChild(img);
    }
    if (img.getAttribute("src") !== url) img.src = url;
  }

  _promptJSONForNode(node) {
    const activeImage = this._activeImageForNode(node);
    const metadata = safeParse(activeImage?.metadata_json) || safeParse(node?.metadata_json) || {};
    const expanded = metadata.expandedPrompt ?? metadata.expandedJson ?? activeImage?.promptJson ?? null;
    if (expanded && typeof expanded === "object") return JSON.stringify(expanded, null, 2);
    if (typeof expanded === "string" && expanded.trim()) {
      const parsed = safeParse(expanded);
      return parsed ? JSON.stringify(parsed, null, 2) : expanded.trim();
    }
    const originalPrompt = String(node?.prompt || metadata.originalPrompt || activeImage?.userPrompt || "").trim();
    if (!originalPrompt) return "";
    return JSON.stringify({ prompt: originalPrompt }, null, 2);
  }

  _promptPanelTextForNode(node) {
    return this._promptTextForNode(node) || "-";
  }

  _promptTextForNode(node) {
    const activeImage = this._activeImageForNode(node);
    const metadata = safeParse(activeImage?.metadata_json) || safeParse(node?.metadata_json) || {};
    let originalPrompt = String(metadata.originalPrompt || metadata.original_prompt || activeImage?.userPrompt || node?.prompt || "").trim();
    if (!originalPrompt) {
      for (const image of this._nodeImages(node)) {
        const imageMeta = safeParse(image?.metadata_json || image?.metadataJson) || {};
        originalPrompt = String(imageMeta.originalPrompt || imageMeta.original_prompt || "").trim();
        if (originalPrompt) break;
      }
    }
    return originalPrompt;
  }

  _logStackAdd(...args) {
    console.log("[diffui stackAdd]", ...args);
  }

  _syncPromptFromEditor(nodeId) {
    const box = this.shadowRoot.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
    const editor = box?.querySelector(".promptEditor");
    if (editor?.hidden) return;
    const textarea = box?.querySelector("textarea");
    if (!textarea) return;
    const value = clampPromptText(textarea.value || "");
    if (value !== textarea.value) textarea.value = value;
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node || String(node.prompt || "") === value) return;
    this._patchNode(nodeId, { prompt: value }, { quiet: true });
  }

  _handleStackAddAction(nodeId, event, source = "stackAdd") {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const box = this.shadowRoot.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
    const add = box?.querySelector(".stackAdd");
    const node = this._state.nodes.find((item) => item.id === nodeId);
    this._logStackAdd("click", {
      source,
      nodeId,
      hasNode: !!node,
      addDisabled: !!add?.disabled,
      addHidden: add?.hidden ?? null,
      selected: box?.dataset?.selected,
      hasImage: box?.dataset?.hasImage,
      imageCount: node ? this._nodeImages(node).length : 0,
    });
    if (!node) return;
    if (add?.disabled) {
      this._logStackAdd("blocked: button disabled");
      return;
    }
    this._generateVariantForNode(node, { source });
  }

  _generateVariantForNode(node, options = {}) {
    const source = options.source || "variant";
    if (!node) {
      this._logStackAdd("blocked: missing node", { source });
      return;
    }
    this._syncPromptFromEditor(node.id);
    let latest = this._state.nodes.find((item) => item.id === node.id) || node;
    if (this._reconcileStaleNodeGeneration(latest, { log: true })) {
      latest = this._state.nodes.find((item) => item.id === node.id) || latest;
    }
    const prompt = this._promptTextForNode(latest) || String(latest.prompt || "").trim();
    const images = this._nodeImages(latest);
    const available = Math.max(0, MAX_NODE_IMAGES - images.length);
    this._logStackAdd("generateVariantForNode", {
      source,
      nodeId: latest.id,
      promptLength: prompt.length,
      nodePromptLength: String(latest.prompt || "").length,
      imageCount: images.length,
      availableSlots: available,
      metadata: safeParse(latest.metadata_json) || {},
      imageStatuses: images.map((image) => ({
        id: image.id,
        status: image.status,
        hasUrl: !!String(image.image_url || image.imageUrl || "").trim(),
      })),
      projectId: this._projectId || "",
    });
    if (!prompt) {
      this._logStackAdd("blocked: no prompt text");
      this._setStatus("Add a prompt before generating.");
      return;
    }
    if (!available) {
      this._logStackAdd("blocked: stack full");
      this._setStatus(`Stacks are limited to ${MAX_NODE_IMAGES} images.`);
      return;
    }
    if (!String(latest.prompt || "").trim()) {
      this._patchNode(latest.id, { prompt }, { quiet: true });
    }
    this._setStatus("Generating variant...");
    this._requestNodeImageGeneration(
      this._state.nodes.find((item) => item.id === latest.id) || latest,
      { replace: false, count: 1, source },
    ).then(() => {
      this._logStackAdd("generation finished", { source, nodeId: latest.id });
    }).catch((error) => {
      this._logStackAdd("generation failed", { source, nodeId: latest.id, error: error?.message || String(error) });
      this._setStatus(error.message || "Generation failed");
    });
  }

  async _copySelectedPromptJSON() {
    const inspector = this.shadowRoot.getElementById("inspector");
    const node = this._selectedNode();
    const text = inspector?.dataset.promptJson || (node ? this._promptJSONForNode(node) : "");
    if (!text || !navigator.clipboard?.writeText) {
      this._setStatus("Copy JSON unavailable");
      return;
    }
    await navigator.clipboard.writeText(text);
    this._setStatus("Prompt JSON copied");
  }

  async _copyNodePromptToClipboard(node) {
    const text = this._promptTextForNode(node);
    if (!text || !navigator.clipboard?.writeText) throw new Error("Copy prompt unavailable");
    await navigator.clipboard.writeText(text);
    this._setStatus("Prompt copied");
  }

  async _copyNodePromptJsonToClipboard(node) {
    const text = this._promptJSONForNode(node);
    if (!text || !navigator.clipboard?.writeText) throw new Error("Copy JSON unavailable");
    await navigator.clipboard.writeText(text);
    this._setStatus("Prompt JSON copied");
  }

  _draw() {
    const canvas = this.shadowRoot.getElementById("canvas");
    if (!this._ctx || !canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ctx = this._ctx;
    ctx.clearRect(0, 0, width, height);
    this._drawGrid(ctx, width, height);
    this._drawResizeAspectGuides(ctx, width, height);
    this._drawEdges(ctx);
    this._drawRemoteCollabPortSessions(ctx);
    this._cullRect = this._visibleWorldRectWithMargin(0.25);
    this._state.nodes.forEach((node) => this._drawNode(ctx, node));
    if (this._dragPort) this._drawPortDrag(ctx);
    if (this._coachPortDemo) this._drawCanvasCoachPortDemo(ctx);
    this._syncSelectionOverlay();
    this._syncRemoteCollabRectOverlays();
    this._syncCommentLayer();
    this._syncAnalysisAnimation();
    this._drawEffectLayer();
    this._drawCollabCursorLayer();
    if (this._cursorChat?.phase === "composing") this._syncCursorChatInputPosition();
    if (this._commentDraft) this._syncCommentDraftInputPosition();
  }

  _queueClickEffectFrame() {
    if (this._clickEffectAnimation) return;
    this._clickEffectAnimation = window.requestAnimationFrame((now) => {
      this._clickEffectAnimation = 0;
      this._drawClickEffects(now);
    });
  }

  _drawClickEffects(now = performance.now()) {
    this._drawEffectLayer(now);
  }

  _drawCollabCursorLayer(now = performance.now()) {
    const canvas = this.shadowRoot.getElementById("collabCursorCanvas");
    if (!this._collabCursorCtx || !canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ctx = this._collabCursorCtx;
    ctx.clearRect(0, 0, width, height);
    this._drawAgentCursors(ctx, now);
    this._drawCollabCursors(ctx, now);
    this._drawLocalCursorChatBubble(ctx, now);
  }

  _drawEffectLayer(now = performance.now()) {
    const canvas = this.shadowRoot.getElementById("effectCanvas");
    if (!this._effectCtx || !canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ctx = this._effectCtx;
    ctx.clearRect(0, 0, width, height);
    this._drawMoveSnapGuides(ctx);
    if (!this._clickEffects.length) {
      return;
    }

    const active = [];
    this._clickEffects.forEach((effect) => {
      const progress = clampNumber((now - effect.startTime) / effect.duration, 0, 1);
      if (progress < 1) {
        active.push(effect);
        this._drawThumbnailLiftEffect(ctx, effect, progress);
      }
    });
    this._clickEffects = active;
    if (active.length) this._queueClickEffectFrame();
  }

  _drawAgentCursors(ctx, now = performance.now()) {
    if (!this._agentCursors.size) return;
    const fadeIn = 200;
    const fadeDelay = 5000;
    const fadeDuration = 1500;
    const dead = [];
    for (const [id, item] of this._agentCursors) {
      const sinceAppear = now - item.appearTime;
      const sinceActive = now - item.lastActivityTime;
      let opacity = 1;
      if (sinceAppear < fadeIn) {
        opacity = sinceAppear / fadeIn;
      } else if (sinceActive > fadeDelay) {
        opacity = 1 - Math.min(1, (sinceActive - fadeDelay) / fadeDuration);
      }
      if (opacity <= 0) {
        dead.push(id);
        continue;
      }
      item.currentX += (item.targetX - item.currentX) * 0.18;
      item.currentY += (item.targetY - item.currentY) * 0.18;
      const wobbleX = Math.cos(now * 0.003 + item.wobblePhase) * 4;
      const wobbleY = Math.sin(now * 0.0023 + item.wobblePhase) * 4;
      const screen = this._worldToScreen(item.currentX, item.currentY);
      const x = screen.x + wobbleX;
      const y = screen.y + wobbleY;
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.fillStyle = item.color;
      ctx.strokeStyle = this._palette.cursorOutline;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 14, y + 14);
      ctx.lineTo(x + 5, y + 14);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      const label = String(item.label || "");
      if (label) {
        ctx.font = "11px sans-serif";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = this._palette.cursorLabelFill;
        ctx.fillRect(x + 12, y + 10, tw + 10, 18);
        ctx.fillStyle = this._palette.cursorLabelText;
        ctx.fillText(label, x + 17, y + 23);
      }
      ctx.restore();
    }
    dead.forEach((id) => this._agentCursors.delete(id));
  }

  _drawResizeAspectGuides(ctx, width, height) {
    const pointer = this._pointer?.mode === "resize-node" ? this._pointer : null;
    if (!pointer || !this._shiftHeld) return;
    const node = this._state.nodes.find((item) => item.id === pointer.nodeId);
    if (!node) return;
    const origin = this._worldToScreen(node.x, node.y);
    if (origin.x >= width || origin.y >= height) return;
    const activeLabel = pointer.activeAspectGuide || "";
    const guideCanvas = document.createElement("canvas");
    guideCanvas.width = Math.max(1, Math.ceil(width));
    guideCanvas.height = Math.max(1, Math.ceil(height));
    const guideCtx = guideCanvas.getContext("2d");
    if (!guideCtx) return;
    const allTargets = [];
    guideCtx.lineWidth = 1.4;
    guideCtx.lineCap = "round";
    guideCtx.setLineDash([1, 7]);
    guideCtx.font = "11px sans-serif";
    guideCtx.textBaseline = "middle";
    RESIZE_ASPECT_GUIDES.forEach((guide) => {
      const maxGuideScale = MAX_PROMPT_DIMENSION / Math.max(guide.width, guide.height);
      const end = {
        x: origin.x + guide.width * maxGuideScale * (this._state.viewport.scale || 1),
        y: origin.y + guide.height * maxGuideScale * (this._state.viewport.scale || 1),
      };
      const active = guide.label === activeLabel;
      const alpha = active ? 1 : 0.3;
      const targets = this._visibleResizeResolutionTargets(node, guide, width, height)
        .map((target) => ({ ...target, showLabel: active }));
      allTargets.push(...targets);
      const length = Math.hypot(guide.width, guide.height);
      const label = {
        x: clampNumber(end.x - (guide.width / length) * 34 + 8, 4, width - 36),
        y: clampNumber(end.y - (guide.height / length) * 34, 10, height - 10),
      };
      guideCtx.strokeStyle = `rgba(${this._palette.resizeGuideRgb}, ${alpha})`;
      guideCtx.fillStyle = `rgba(${this._palette.resizeGuideRgb}, ${alpha})`;
      this._drawResizeGuideLine(guideCtx, origin, end);
      guideCtx.fillText(guide.label, label.x, label.y);
    });
    this._maskResizeGuideTargets(guideCtx, allTargets);
    ctx.drawImage(guideCanvas, 0, 0);
    allTargets.forEach((target) => this._drawResizeResolutionTarget(ctx, target, width, height));
  }

  _maskResizeGuideTargets(ctx, targets) {
    if (!targets.length) return;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    targets.forEach((target) => {
      ctx.beginPath();
      ctx.arc(target.x, target.y, 8.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  _visibleResizeResolutionTargets(node, guide, width, height) {
    const resolutions = RESIZE_ASPECT_RESOLUTIONS[guide.label] || [];
    return resolutions.map((label) => {
      const [targetWidth, targetHeight] = label.split("x").map((value) => Number(value) || 0);
      const point = this._worldToScreen(node.x + targetWidth, node.y + targetHeight);
      const valid = targetWidth % GENERATED_IMAGE_DIMENSION_MULTIPLE === 0
        && targetHeight % GENERATED_IMAGE_DIMENSION_MULTIPLE === 0
        && targetWidth * guide.height === targetHeight * guide.width;
      return {
        label,
        x: point.x,
        y: point.y,
        valid,
      };
    }).filter((target) => target.x >= 0 && target.x <= width && target.y >= 0 && target.y <= height);
  }

  _drawResizeGuideLine(ctx, origin, end) {
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }

  _drawResizeResolutionTarget(ctx, target, width, height) {
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = this._palette.resizeTarget;
    ctx.fillRect(target.x - 0.5, target.y - 4.5, 1, 9);
    ctx.fillRect(target.x - 4.5, target.y - 0.5, 9, 1);
    if (target.valid) {
      ctx.beginPath();
      ctx.arc(target.x, target.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!target.showLabel) {
      ctx.restore();
      return;
    }
    ctx.fillStyle = this._palette.resizeTargetLabel;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    const labelX = clampNumber(target.x - 7, 34, width - 4);
    const labelY = target.y + 12 <= height - 8 ? target.y + 8 : target.y - 20;
    ctx.fillText(target.label, labelX, clampNumber(labelY, 2, height - 10));
    ctx.restore();
  }

  _drawMoveSnapGuides(ctx) {
    const guides = this._pointer?.mode === "move-node" ? this._pointer.snapGuides || [] : [];
    if (!guides.length) return;
    ctx.save();
    ctx.strokeStyle = this._palette.snapGuide;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    guides.forEach((guide) => {
      if (guide.axis === "x") {
        const x = this._worldToScreen(guide.value, 0).x;
        const y1 = this._worldToScreen(0, Math.min(guide.draggedRect.y, guide.targetRect.y)).y;
        const y2 = this._worldToScreen(0, Math.max(guide.draggedRect.y + guide.draggedRect.height, guide.targetRect.y + guide.targetRect.height)).y;
        ctx.beginPath();
        ctx.moveTo(x, y1);
        ctx.lineTo(x, y2);
        ctx.stroke();
      } else {
        const y = this._worldToScreen(0, guide.value).y;
        const x1 = this._worldToScreen(Math.min(guide.draggedRect.x, guide.targetRect.x), 0).x;
        const x2 = this._worldToScreen(Math.max(guide.draggedRect.x + guide.draggedRect.width, guide.targetRect.x + guide.targetRect.width), 0).x;
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.stroke();
      }
    });
    ctx.restore();
  }

  _drawThumbnailLiftEffect(ctx, effect, progress) {
    const origin = this._worldToScreen(effect.origin.x, effect.origin.y);
    const destination = this._worldToScreen(effect.destination.x, effect.destination.y);
    const travel = easeInOutCubic(progress);
    const lift = Math.sin(progress * Math.PI);
    const x = lerp(origin.x, destination.x, travel);
    const y = lerp(origin.y, destination.y, travel) - lift * 72;
    const grow = easeOutCubic(clampNumber(progress / 0.24, 0, 1));
    const settle = easeOutCubic(clampNumber((progress - 0.7) / 0.3, 0, 1));
    const size = lerp(34, 76, grow) * lerp(1, 0.62, settle);
    const alpha = progress < 0.82 ? 1 : 1 - easeOutCubic((progress - 0.82) / 0.18);
    const spin = effect.tilt * Math.sin(progress * Math.PI);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(spin);
    ctx.globalAlpha = alpha;
    ctx.shadowColor = this._palette.liftGlow;
    ctx.shadowBlur = 22;
    ctx.fillStyle = this._palette.liftFill;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.58, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
    ctx.clip();
    if (!effect.sourceRect && effect.click && effect.image?.naturalWidth > 0) {
      // A relayed loupe can start before this client has decoded the peer's image.
      effect.sourceRect = this._thumbnailSourceRect(effect.image, effect.click);
    }
    if (effect.image?.complete && effect.image.naturalWidth > 0 && effect.sourceRect) {
      ctx.drawImage(
        effect.image,
        effect.sourceRect.x,
        effect.sourceRect.y,
        effect.sourceRect.width,
        effect.sourceRect.height,
        -size / 2,
        -size / 2,
        size,
        size,
      );
    } else {
      ctx.fillStyle = this._palette.liftPlaceholder;
      ctx.fillRect(-size / 2, -size / 2, size, size);
    }
    ctx.restore();

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(spin);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = this._palette.liftRim;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = this._palette.liftArc;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.62, -Math.PI * 0.2, Math.PI * 1.05);
    ctx.stroke();
    ctx.restore();
  }

  _drawGrid(ctx, width, height) {
    const scale = this._state.viewport.scale || 1;
    const step = Math.max(16, 64 * scale);
    ctx.save();
    ctx.strokeStyle = this._palette.gridLine;
    ctx.lineWidth = 1;
    for (let x = this._state.viewport.x % step; x < width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = this._state.viewport.y % step; y < height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawEdges(ctx) {
    ctx.save();
    this._state.edges.forEach((edge) => {
      if (!this._shouldDrawEdge(edge)) return;
      const from = this._state.nodes.find((node) => node.id === (edge.from_node_id || edge.fromNodeId));
      const to = this._state.nodes.find((node) => node.id === (edge.to_node_id || edge.toNodeId));
      if (!from || !to) return;
      const outputAnchor = this._nodeOutputAnchor(from);
      const a = this._worldToScreen(outputAnchor.x, outputAnchor.y);
      const inputAnchor = this._promptInputAnchor(to);
      const b = this._worldToScreen(inputAnchor.x, inputAnchor.y);
      const customFacets = this._edgeHasCustomInputFacets(edge);
      ctx.strokeStyle = edge.selected
        ? this._palette.edgeSelected
        : customFacets
          ? this._palette.edgeCustomFacets
          : this._palette.edge;
      ctx.lineWidth = edge.selected ? 4 : customFacets ? 2.5 : 2;
      if (customFacets) ctx.setLineDash([5, 5]);
      else ctx.setLineDash([]);
      strokeNoodle(ctx, a, b);
      ctx.setLineDash([]);
    });
    ctx.restore();
  }

  _shouldDrawEdge(edge) {
    if (edge.selected || edgeIdentity(edge) === this._hoverEdgeId) return true;
    const { fromId, toId } = edgeEndpointIds(edge);
    return this._isConnectionNodeActive(fromId) || this._isConnectionNodeActive(toId);
  }

  _isConnectionNodeActive(nodeId) {
    if (!nodeId) return false;
    if (this._hoverNodeId === nodeId) return true;
    if (this._dragPort?.from === nodeId || this._dragPort?.targetPromptId === nodeId) return true;
    const node = this._state.nodes.find((item) => item.id === nodeId);
    return !!node?.selected;
  }

  _nodeHasActiveEdge(nodeId) {
    if (!nodeId) return false;
    return this._state.edges.some((edge) => {
      const { fromId, toId } = edgeEndpointIds(edge);
      if (fromId !== nodeId && toId !== nodeId) return false;
      return edge.selected || edgeIdentity(edge) === this._hoverEdgeId;
    });
  }

  _shouldShowNodeConnectors(node) {
    if (!node) return false;
    return this._isConnectionNodeActive(node.id) || this._nodeHasActiveEdge(node.id);
  }

  _shouldShowNodeInputConnector(node) {
    if (!node) return false;
    if (this._dragPort && node.kind !== "image") return true;
    return this._shouldShowNodeConnectors(node);
  }

  _shouldShowNodeOutputConnector(node) {
    return this._shouldShowNodeConnectors(node);
  }

  _drawNode(ctx, node) {
    if (node.kind !== "image") return;
    // Viewport culling: skip nodes fully outside the (margin-expanded) view so
    // per-frame draw cost scales with visible nodes, not total document size.
    const cull = this._cullRect;
    if (
      cull &&
      (node.x > cull.x + cull.width ||
        node.x + node.width < cull.x ||
        node.y > cull.y + cull.height ||
        node.y + node.height < cull.y)
    ) {
      return;
    }
    const p = this._worldToScreen(node.x, node.y);
    const scale = this._state.viewport.scale || 1;
    const w = node.width * scale;
    const h = node.height * scale;
    ctx.save();
    ctx.lineWidth = node.selected ? 2 : 1;
    ctx.strokeStyle = node.selected ? this._palette.nodeRimSelected : this._palette.nodeRim;
    ctx.fillStyle = this._readyImagesForNode(node).length
      ? this._palette.nodeFillWithImage
      : this._palette.nodeFill;
    roundRect(ctx, p.x, p.y, w, h, CANVAS_CONTAINER_RADIUS);
    ctx.fill();
    ctx.stroke();
    if (node.kind === "image") {
      const img = this._imageFor(node.image_url);
      if (img?.complete && img.naturalWidth > 0) {
        const sourceRect = this._imageDrawSourceRect(node, img);
        ctx.save();
        clipRoundRect(ctx, p.x + 1, p.y + 1, w - 2, h - 2, NODE_IMAGE_RADIUS);
        if (sourceRect) {
          ctx.drawImage(
            img,
            sourceRect.x,
            sourceRect.y,
            sourceRect.width,
            sourceRect.height,
            p.x + 1,
            p.y + 1,
            w - 2,
            h - 2,
          );
        }
        ctx.restore();
      } else if (node.status === "loading") {
        ctx.fillStyle = this._palette.nodeSkeleton;
        ctx.fillRect(p.x + 14, p.y + h / 2 - 8, Math.max(30, w - 28), 16);
      }
      this._drawAnalysisBadge(ctx, node, p.x, p.y, w, h);
    }
    if (!this._shouldUseLowDetailNodeUi(node)) {
      ctx.fillStyle = node.selected ? this._palette.nodeLabelSelected : this._palette.nodeLabel;
      ctx.font = "12px sans-serif";
      ctx.fillText(node.name || "Node", p.x + 10, p.y - 8);
    }
    ctx.restore();
    const showInput = this._shouldShowNodeInputConnector(node);
    const showOutput = this._shouldShowNodeOutputConnector(node);
    if (showInput || showOutput) this._drawNodeHandles(ctx, node, { input: showInput, output: showOutput });
  }

  _drawAnalysisBadge(ctx, node, x, y, width, height) {
    const image = this._activeImageForNode(node);
    const metadata = safeParse(image?.metadata_json) || safeParse(node.metadata_json) || {};
    const status = String(metadata.analysisStatus || "").trim();
    const promptReady = !!metadata.promptReady || !!metadata.prompt_ready;
    if (!status && !promptReady) return;
    // Generated prompt_only JSON passes are silent — no badge/spinner chrome.
    if (status === "processing" && !this._isPasteScreenshotAnalysis(image, node, metadata)) return;
    const size = Math.max(18, Math.min(28, Math.min(width, height) * 0.12));
    const cx = x + width - size * 0.72;
    const cy = y + size * 0.72;
    ctx.save();
    ctx.fillStyle = this._palette.badgeFill;
    ctx.strokeStyle = this._palette.badgeRim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (status === "processing" && this._isPasteScreenshotAnalysis(image, node, metadata)) {
      const t = performance.now() / 240;
      ctx.strokeStyle = this._palette.badgeSpinner;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.28, t, t + Math.PI * 1.45);
      ctx.stroke();
    } else if (promptReady || status === "done") {
      ctx.strokeStyle = this._palette.badgeDone;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(cx - size * 0.22, cy);
      ctx.lineTo(cx - size * 0.04, cy + size * 0.18);
      ctx.lineTo(cx + size * 0.26, cy - size * 0.22);
      ctx.stroke();
    } else if (status === "error") {
      ctx.fillStyle = this._palette.badgeError;
      ctx.font = `${Math.round(size * 0.62)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("!", cx, cy + 1);
    }
    ctx.restore();
  }

  _drawNodeHandles(ctx, node, { input: showInput = true, output: showOutput = true } = {}) {
    const input = this._worldToScreen(node.x, node.y + node.height / 2);
    const output = this._worldToScreen(node.x + node.width, node.y + node.height / 2);
    const scale = this._state.viewport.scale || 1;
    const inputWidth = NODE_LEFT_CONNECTOR_WIDTH * scale;
    const inputHeight = NODE_IN_HANDLE_HEIGHT * scale;
    const outputWidth = NODE_RIGHT_CONNECTOR_WIDTH * scale;
    const outputHeight = NODE_OUT_HANDLE_HEIGHT * scale;
    ctx.save();
    ctx.fillStyle = this._palette.handleFill;
    ctx.strokeStyle = this._palette.handleRim;
    ctx.lineWidth = 1;
    if (showInput) {
      roundRect(ctx, input.x - inputWidth, input.y - inputHeight / 2, inputWidth, inputHeight, inputWidth / 2);
      ctx.fill();
      ctx.stroke();
    }
    if (showOutput) {
      roundRect(ctx, output.x, output.y - outputHeight / 2, outputWidth, outputHeight, outputWidth / 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = this._palette.handleGlyph;
    ctx.font = `${Math.max(8, 12 * scale)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (showInput) ctx.fillText(">", input.x - inputWidth / 2, input.y + 0.5);
    if (showOutput) ctx.fillText(">", output.x + outputWidth / 2, output.y + 0.5);
    ctx.restore();
  }

  _syncSelectionOverlay() {
    const layer = this.shadowRoot.getElementById("selectionLayer");
    if (!layer) return;
    if (this._inpaint?.generating) {
      layer.replaceChildren();
      return;
    }
    if (this._inpaint?.sourceNodeId && this._inpaint?.cropRect) {
      this._syncInpaintSelectionOverlay(layer);
      return;
    }
    if (!["draw-rect", "select-rect"].includes(this._pointer?.mode) || !this._pointer.start || !this._pointer.current) {
      layer.replaceChildren();
      return;
    }
    const rect = normalizeRect(this._pointer.start, this._pointer.current);
    if (rect.width <= 0 || rect.height <= 0) {
      layer.replaceChildren();
      return;
    }
    const targetImage = this._pointer.mode === "draw-rect" && this._pointer.targetImageId
      ? this._state.nodes.find((node) => node.id === this._pointer.targetImageId)
      : null;
    const cropRect = targetImage ? intersectRects(rect, nodeRect(targetImage)) : null;
    let outer = layer.querySelector('[data-kind="outer"]');
    if (!outer) {
      outer = document.createElement("div");
      outer.className = "selectionRect";
      outer.dataset.kind = "outer";
      layer.appendChild(outer);
    }
    outer.dataset.target = this._pointer.mode === "select-rect" ? "selection" : targetImage ? "image" : "canvas";
    setScreenRectStyle(outer, this._worldRectToScreenRect(rect));
    let inner = layer.querySelector('[data-kind="inner"]');
    if (cropRect) {
      if (!inner) {
        inner = document.createElement("div");
        inner.className = "selectionRect";
        inner.dataset.kind = "inner";
        layer.appendChild(inner);
      }
      setScreenRectStyle(inner, this._worldRectToScreenRect(cropRect));
    } else if (inner) {
      inner.remove();
    }
    // An edit drag can never become a prompt node, so it must not tease one.
    const promptPreviewRect = this._pointer.mode === "draw-rect" && !targetImage && !this._pointer.imagesOnly
      ? this._drawRectPromptPreviewRect(this._pointer, rect)
      : null;
    let promptPreview = layer.querySelector('[data-kind="prompt-preview"]');
    if (promptPreviewRect) {
      if (!promptPreview) {
        promptPreview = document.createElement("div");
        promptPreview.className = "selectionRect";
        promptPreview.dataset.kind = "prompt-preview";
        layer.appendChild(promptPreview);
      }
      setScreenRectStyle(promptPreview, this._worldRectToScreenRect(promptPreviewRect));
    } else if (promptPreview) {
      promptPreview.remove();
    }
  }

  _syncRemoteCollabRectOverlays() {
    const layer = this.shadowRoot.getElementById("collabRectLayer");
    if (!layer) return;
    const activePeerIds = new Set();
    for (const [peerId, session] of this._collabPeerRects) {
      activePeerIds.add(peerId);
      const peer = this._collabPeers.get(peerId);
      this._renderCollabPeerRect(layer, peerId, session, resolveCollabColor(peer?.color, peerId));
    }
    layer.querySelectorAll("[data-peer-id]").forEach((element) => {
      if (!activePeerIds.has(element.dataset.peerId)) element.remove();
    });
  }

  _renderCollabPeerRect(layer, peerId, session, color) {
    const peerKey = String(peerId || "");
    if (!peerKey || !session?.mode) return;
    const wanted = new Set();
    const upsert = (kind, screenRect, target = "") => {
      if (!screenRect || screenRect.width <= 0 || screenRect.height <= 0) return;
      const selector = `[data-peer-id="${CSS.escape(peerKey)}"][data-kind="${kind}"]`;
      let element = layer.querySelector(selector);
      if (!element) {
        element = document.createElement("div");
        element.className = "selectionRect collabPeerRect";
        element.dataset.peerId = peerKey;
        element.dataset.kind = kind;
        layer.appendChild(element);
      }
      if (target) element.dataset.target = target;
      else delete element.dataset.target;
      element.style.setProperty("--peer-color", color || this._palette.portWire);
      setScreenRectStyle(element, screenRect);
      wanted.add(`${kind}`);
    };
    if (session.mode === "draw-rect" && session.start && session.current) {
      const rect = normalizeRect(session.start, session.current);
      const targetImage = session.targetImageId
        ? this._state.nodes.find((node) => node.id === session.targetImageId)
        : null;
      const cropRect = session.cropRect
        || (targetImage ? intersectRects(rect, nodeRect(targetImage)) : null);
      upsert("outer", this._worldRectToScreenRect(rect), targetImage ? "image" : "canvas");
      if (cropRect) upsert("inner", this._worldRectToScreenRect(cropRect));
      if (session.promptPreviewRect) {
        upsert("prompt-preview", this._worldRectToScreenRect(session.promptPreviewRect));
      }
    } else if (session.mode === "resize-inpaint" && session.cropRect) {
      upsert("inpaint-crop", this._worldRectToScreenRect(session.cropRect), "image");
    }
    layer.querySelectorAll(`[data-peer-id="${CSS.escape(peerKey)}"]`).forEach((element) => {
      if (!wanted.has(element.dataset.kind || "")) element.remove();
    });
  }

  _drawRectPromptPreviewRect(pointer, rect) {
    if (rect.width > 12 && rect.height > 12) {
      return {
        x: rect.x,
        y: rect.y,
        ...constrainPromptDimensions(rect.width, rect.height),
      };
    }
    if (pointer.targetImageId) return null;
    return this._singleClickPromptRect(pointer.start, this._commonCanvasNodeSize());
  }

  _openInpaintSelection(sourceNodeId, rect) {
    const source = this._state.nodes.find((node) => node.id === sourceNodeId);
    const activeImage = this._activeImageForNode(source);
    const cropRect = source ? intersectRects(rect, nodeRect(source)) : null;
    if (!source || !activeImage || !cropRect) return;
    this._selectNodeById(source.id);
    this._inpaint = {
      sourceNodeId: source.id,
      sourceImageId: activeImage.id || "",
      cropRect,
      prompt: "",
      contextAssets: [],
      requestId: "",
      generating: false,
    };
    this._setTool(TOOL_POINTER);
    this._syncToolbar();
    this._syncPromptOverlays();
    this._syncInpaintPrompt();
    this._draw();
    requestAnimationFrame(() => this.shadowRoot.getElementById("inpaintPrompt")?.focusPrompt?.());
  }

  _clearInpaintSelection({ keepGenerating = false } = {}) {
    if (!this._inpaint) return;
    if (keepGenerating && this._inpaint.generating) return;
    this._inpaint = null;
    const prompt = this.shadowRoot.getElementById("inpaintPrompt");
    if (prompt) {
      prompt.hidden = true;
      prompt.setLoading?.(false);
      prompt.setContextImages?.([]);
    }
    this.shadowRoot.getElementById("selectionLayer")?.replaceChildren();
    this._draw();
  }

  _syncInpaintPrompt() {
    const prompt = this.shadowRoot.getElementById("inpaintPrompt");
    if (!prompt || !this._inpaint?.cropRect) {
      if (prompt) prompt.hidden = true;
      return;
    }
    const canvas = this.shadowRoot.getElementById("canvas");
    const canvasRect = canvas?.getBoundingClientRect();
    if (!canvasRect) return;
    const rect = this._worldRectToScreenRect(this._inpaint.cropRect);
    const panelWidth = Math.min(600, Math.max(320, canvasRect.width - 48));
    const left = clampNumber(rect.x, 12, Math.max(12, canvasRect.width - panelWidth - 12));
    const top = clampNumber(rect.y + rect.height + 10, 12, Math.max(12, canvasRect.height - 310));
    prompt.style.width = `${panelWidth}px`;
    prompt.style.left = `${Math.round(left)}px`;
    prompt.style.top = `${Math.round(top)}px`;
    if (this._inpaint.promptHidden) {
      prompt.hidden = true;
      return;
    }
    prompt.value = this._inpaint.prompt || "";
    prompt.setLoading?.(!!this._inpaint.generating);
    prompt.setContextImages?.((this._inpaint.contextAssets || []).map((asset) => ({
      id: asset.id,
      url: asset.displayThumbUrl || asset.fileUrl || asset.url,
    })));
    prompt.hidden = false;
  }

  _syncInpaintSelectionOverlay(layer) {
    if (!layer) return;
    const source = this._state.nodes.find((node) => node.id === this._inpaint?.sourceNodeId);
    const cropRect = this._inpaint?.cropRect;
    if (!source || !cropRect) {
      layer.replaceChildren();
      return;
    }
    const sourceScreen = this._worldRectToScreenRect(nodeRect(source));
    const cropScreen = this._worldRectToScreenRect(cropRect);
    const wanted = new Set();
    let dimSvg = layer.querySelector('[data-kind="inpaint-dim"]');
    if (!dimSvg) {
      dimSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      dimSvg.classList.add("selectionDimSvg");
      dimSvg.dataset.kind = "inpaint-dim";
      dimSvg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("fill-rule", "evenodd");
      dimSvg.appendChild(path);
      layer.appendChild(dimSvg);
    }
    const canvas = this.shadowRoot.getElementById("canvas");
    const width = canvas?.clientWidth || 0;
    const height = canvas?.clientHeight || 0;
    dimSvg.setAttribute("viewBox", `0 0 ${Math.max(1, width)} ${Math.max(1, height)}`);
    const dimPath = dimSvg.querySelector("path");
    if (dimPath) {
      dimPath.setAttribute(
        "d",
        `M ${sourceScreen.x} ${sourceScreen.y} H ${sourceScreen.x + sourceScreen.width} V ${sourceScreen.y + sourceScreen.height} H ${sourceScreen.x} Z ` +
        `M ${cropScreen.x} ${cropScreen.y} H ${cropScreen.x + cropScreen.width} V ${cropScreen.y + cropScreen.height} H ${cropScreen.x} Z`,
      );
    }
    wanted.add("inpaint-dim");
    const shell = this._ensureInpaintSelectionShell(layer);
    wanted.add("inpaint-shell");
    setScreenRectStyle(shell, cropScreen);
    const generating = this._inpaint?.generating ? "true" : "false";
    shell.dataset.generating = generating;
    this._syncInpaintSelectionResizeTargets(shell, generating === "true");
    Array.from(layer.children).forEach((child) => {
      if (!wanted.has(child.dataset.kind || "")) child.remove();
    });
    this._syncInpaintPrompt();
  }

  _ensureInpaintSelectionShell(layer) {
    let shell = layer.querySelector('[data-kind="inpaint-shell"]');
    if (shell) {
      if (shell.nextSibling) layer.appendChild(shell);
      return shell;
    }
    shell = document.createElement("div");
    shell.className = "selectionShell";
    shell.dataset.kind = "inpaint-shell";
    const selection = document.createElement("div");
    selection.className = "selectionRect";
    selection.dataset.kind = "inpaint";
    shell.appendChild(selection);
    layer.appendChild(shell);
    return shell;
  }

  _syncInpaintSelectionResizeTargets(shell, generating) {
    if (generating) {
      shell.querySelectorAll(".selectionEdge, .selectionHandle").forEach((target) => target.remove());
      return;
    }
    ["n", "e", "s", "w"].forEach((handle) => {
      if (shell.querySelector(`.selectionEdge[data-handle="${handle}"]`)) return;
      const edge = document.createElement("div");
      edge.className = "selectionEdge";
      edge.dataset.handle = handle;
      this._bindInpaintResizeTarget(edge, handle);
      shell.appendChild(edge);
    });
    ["nw", "ne", "se", "sw"].forEach((handle) => {
      if (shell.querySelector(`.selectionHandle[data-handle="${handle}"]`)) return;
      const corner = document.createElement("div");
      corner.className = "selectionHandle";
      corner.dataset.handle = handle;
      this._bindInpaintResizeTarget(corner, handle);
      shell.appendChild(corner);
    });
  }

  _bindInpaintResizeTarget(el, handle) {
    el.addEventListener("pointerdown", (event) => this._startResizeInpaintSelection(event, handle));
    el.addEventListener("pointermove", (event) => this._onPointerMove(event));
    el.addEventListener("pointerup", (event) => this._onPointerUp(event));
    el.addEventListener("pointercancel", (event) => this._onPointerUp(event));
  }

  _placeCommentAt(world) {
    if (!this._canCommentCollab()) {
      this._setStatus("You need access to comment");
      return;
    }
    const anchor = this._commentAnchorForWorldPoint(world);
    this._commentDraft = {
      world,
      anchor,
    };
    this._showCommentDraftInput();
  }

  _showCommentDraftInput() {
    const wrap = this.shadowRoot.getElementById("commentComposer");
    const input = this.shadowRoot.getElementById("commentComposerInput");
    if (!wrap || !input || !this._commentDraft) return;
    input.value = "";
    wrap.dataset.open = "true";
    this._syncCommentDraftInputPosition();
    window.setTimeout(() => input.focus(), 0);
  }

  _hideCommentDraftInput() {
    const wrap = this.shadowRoot.getElementById("commentComposer");
    const input = this.shadowRoot.getElementById("commentComposerInput");
    if (wrap) wrap.dataset.open = "false";
    input?.blur();
  }

  _syncCommentDraftInputPosition() {
    const wrap = this.shadowRoot.getElementById("commentComposer");
    const draft = this._commentDraft;
    if (!wrap || wrap.dataset.open !== "true" || !draft?.world) return;
    const canvas = this.shadowRoot.getElementById("canvas");
    if (!canvas) return;
    const screen = this._worldToScreen(draft.world.x, draft.world.y);
    const width = wrap.offsetWidth || 280;
    const height = wrap.offsetHeight || 130;
    const left = clampNumber(screen.x + 14, 14, Math.max(14, canvas.clientWidth - width - 14));
    const top = clampNumber(screen.y - 14, 14, Math.max(14, canvas.clientHeight - height - 14));
    wrap.style.left = `${Math.round(left)}px`;
    wrap.style.top = `${Math.round(top)}px`;
  }

  _onCommentDraftKeyDown(event) {
    if (!this._commentDraft) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this._commitCommentDraft();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this._cancelCommentDraft();
    }
  }

  _commitCommentDraft() {
    const draft = this._commentDraft;
    const input = this.shadowRoot.getElementById("commentComposerInput");
    const text = String(input?.value || "").trim();
    if (!draft || !text) {
      this._cancelCommentDraft();
      return;
    }
    this._hideCommentDraftInput();
    const now = Date.now();
    const comment = {
      id: `comment-${crypto.randomUUID()}`,
      anchor: draft.anchor,
      body: text,
      ...this._commentAuthorFields(),
      createdAt: now,
      updatedAt: now,
      replies: [],
      resolved: false,
    };
    this._comments = [...this._normalizeCanvasComments(this._comments), comment];
    this._state.comments = this._comments;
    this._commitCommentsChange();
    this._commentDraft = null;
    this._syncCommentLayer();
    this._trackClick(UI_TELEMETRY_EVENTS.CANVAS_TOOL_USE, TOOL_COMMENT, "comment_added", {
      node_type: draft.anchor.type === "node" ? "node" : "canvas",
    });
    this._setStatus(draft.anchor.type === "node" ? "Comment added to image" : "Comment added");
  }

  _cancelCommentDraft() {
    if (!this._commentDraft) return;
    this._hideCommentDraftInput();
    this._commentDraft = null;
  }

  _startCommentDrag(event) {
    const detail = event.detail || {};
    const sourceEvent = detail.pointerEvent;
    const commentId = String(detail.commentId || "").trim();
    if (!commentId || !sourceEvent || !this._canEditCollab()) return;
    sourceEvent.stopPropagation();
    const world = this._eventWorld(sourceEvent);
    const comment = this._normalizeCanvasComments(this._comments).find((item) => item.id === commentId);
    const point = this._commentWorldPoint(comment);
    if (!comment || !point) return;
    this._pointer = {
      mode: "drag-comment",
      commentId,
      dx: world.x - point.x,
      dy: world.y - point.y,
      startClientX: sourceEvent.clientX,
      startClientY: sourceEvent.clientY,
      dragged: false,
    };
    window.addEventListener("pointermove", this._commentDragMoveHandler, true);
    window.addEventListener("pointerup", this._commentDragEndHandler, true);
    window.addEventListener("pointercancel", this._commentDragEndHandler, true);
  }

  _updateCommentDrag(world) {
    const pointer = this._pointer;
    if (!pointer || pointer.mode !== "drag-comment") return;
    const nextWorld = {
      x: world.x - pointer.dx,
      y: world.y - pointer.dy,
    };
    let changed = false;
    this._comments = this._normalizeCanvasComments(this._comments).map((comment) => {
      if (comment.id !== pointer.commentId) return comment;
      changed = true;
      return {
        ...comment,
        anchor: this._commentAnchorForWorldPoint(nextWorld),
        updatedAt: Date.now(),
      };
    });
    if (!changed) return;
    this._state.comments = this._comments;
    this._syncCommentLayer();
  }

  _onCommentDragWindowMove(event) {
    const pointer = this._pointer;
    if (!pointer || pointer.mode !== "drag-comment") return;
    const moved = Math.hypot(event.clientX - pointer.startClientX, event.clientY - pointer.startClientY);
    if (moved < 3 && !pointer.dragged) return;
    pointer.dragged = true;
    event.preventDefault();
    this._updateCommentDrag(this._eventWorld(event));
  }

  _onCommentDragWindowEnd(event) {
    const pointer = this._pointer;
    if (!pointer || pointer.mode !== "drag-comment") {
      this._removeCommentDragWindowListeners();
      return;
    }
    if (pointer.dragged) {
      event.preventDefault();
      this._updateCommentDrag(this._eventWorld(event));
      this._commitCommentsChange();
      this._draw();
      this._publishCollabAwareness();
    }
    this._pointer = null;
    this._removeCommentDragWindowListeners();
  }

  _removeCommentDragWindowListeners() {
    window.removeEventListener("pointermove", this._commentDragMoveHandler, true);
    window.removeEventListener("pointerup", this._commentDragEndHandler, true);
    window.removeEventListener("pointercancel", this._commentDragEndHandler, true);
  }

  _commentAnchorForWorldPoint(world) {
    const node = this._imageHit(world.x, world.y);
    if (node) {
      return {
        type: "node",
        nodeId: node.id,
        offsetX: clampNumber((world.x - node.x) / Math.max(1, node.width), 0, 1),
        offsetY: clampNumber((world.y - node.y) / Math.max(1, node.height), 0, 1),
      };
    }
    return { type: "canvas", x: world.x, y: world.y };
  }

  _syncCommentLayer(options = {}) {
    const layer = this.shadowRoot.getElementById("commentLayer");
    if (!layer) return;
    const visible = this._normalizeCanvasComments(this._comments).filter((comment) => !comment.resolved);
    const wanted = new Set();
    visible.forEach((comment, index) => {
      const point = this._commentWorldPoint(comment);
      if (!point) return;
      wanted.add(comment.id);
      let el = layer.querySelector(`diffui-canvas-comment[data-comment-id="${CSS.escape(comment.id)}"]`);
      if (!el) {
        el = document.createElement("diffui-canvas-comment");
        el.dataset.commentId = comment.id;
        layer.appendChild(el);
      }
      const screen = this._worldToScreen(point.x, point.y);
      const left = `${Math.round(screen.x)}px`;
      const top = `${Math.round(screen.y)}px`;
      if (el.style.left !== left) el.style.left = left;
      if (el.style.top !== top) el.style.top = top;
      const renderOptions = {
        index: index + 1,
        canReply: this._canCommentCollab(),
        canDelete: this._canDeleteComment(comment),
        canResolve: this._canResolveComments(),
        currentUserAvatarUrl: this._currentUserAvatarUrl(),
        currentUserName: this._currentUserName(),
        currentUserColor: this._currentUserCollabColor(),
      };
      const renderSignature = this._commentRenderSignature(comment, renderOptions);
      if (el.dataset.renderSignature !== renderSignature) {
        el.setComment?.(comment, renderOptions);
        el.dataset.renderSignature = renderSignature;
      }
      if (options.focusCommentId === comment.id) {
        requestAnimationFrame(() => el.focusReply?.());
      }
    });
    layer.querySelectorAll("diffui-canvas-comment[data-comment-id]").forEach((el) => {
      if (!wanted.has(el.dataset.commentId || "")) el.remove();
    });
  }

  _commentRenderSignature(comment, options = {}) {
    return JSON.stringify({
      id: comment.id,
      body: comment.body,
      authorUserId: comment.authorUserId,
      authorName: comment.authorName,
      authorAvatarUrl: comment.authorAvatarUrl,
      authorColor: comment.authorColor,
      createdAt: comment.createdAt,
      replies: (comment.replies || []).map((reply) => ({
        id: reply.id,
        body: reply.body,
        authorUserId: reply.authorUserId,
        authorName: reply.authorName,
        authorAvatarUrl: reply.authorAvatarUrl,
        authorColor: reply.authorColor,
        createdAt: reply.createdAt,
      })),
      canReply: !!options.canReply,
      canDelete: !!options.canDelete,
      canResolve: !!options.canResolve,
      currentUserAvatarUrl: options.currentUserAvatarUrl || "",
      currentUserName: options.currentUserName || "",
      currentUserColor: options.currentUserColor || "",
    });
  }

  _closeExpandedComments(exceptCommentId = "") {
    const layer = this.shadowRoot.getElementById("commentLayer");
    if (!layer) return false;
    let closed = false;
    layer.querySelectorAll("diffui-canvas-comment").forEach((el) => {
      if (exceptCommentId && el.dataset.commentId === exceptCommentId) return;
      if (el.dataset.expanded === "true") closed = true;
      el.close?.();
    });
    return closed;
  }

  _commentWorldPoint(comment) {
    const anchor = comment?.anchor || {};
    if (anchor.type === "node") {
      const node = this._state.nodes.find((item) => item.id === anchor.nodeId);
      if (!node) return null;
      return {
        x: node.x + clampNumber(Number(anchor.offsetX), 0, 1) * node.width,
        y: node.y + clampNumber(Number(anchor.offsetY), 0, 1) * node.height,
      };
    }
    if (Number.isFinite(Number(anchor.x)) && Number.isFinite(Number(anchor.y))) {
      return { x: Number(anchor.x), y: Number(anchor.y) };
    }
    return null;
  }

  _addCommentReply(commentId, body) {
    if (!this._canCommentCollab()) return;
    const text = String(body || "").trim();
    if (!text) return;
    const now = Date.now();
    let changed = false;
    this._comments = this._normalizeCanvasComments(this._comments).map((comment) => {
      if (comment.id !== commentId || comment.resolved) return comment;
      changed = true;
      return {
        ...comment,
        updatedAt: now,
        replies: [
          ...(Array.isArray(comment.replies) ? comment.replies : []),
          {
            id: `reply-${crypto.randomUUID()}`,
            body: text,
            ...this._commentAuthorFields(),
            createdAt: now,
          },
        ],
      };
    });
    if (!changed) return;
    this._state.comments = this._comments;
    this._commitCommentsChange();
    this._syncCommentLayer();
  }

  _deleteComment(commentId) {
    const before = this._normalizeCanvasComments(this._comments);
    const target = before.find((comment) => comment.id === commentId);
    if (!target || !this._canDeleteComment(target)) return;
    this._comments = before.filter((comment) => comment.id !== commentId);
    this._state.comments = this._comments;
    this._commitCommentsChange();
    this._syncCommentLayer();
    this._setStatus("Comment deleted");
  }

  _resolveComment(commentId) {
    if (!this._canResolveComments()) return;
    let changed = false;
    const now = Date.now();
    this._comments = this._normalizeCanvasComments(this._comments).map((comment) => {
      if (comment.id !== commentId || comment.resolved) return comment;
      changed = true;
      return {
        ...comment,
        resolved: true,
        resolvedAt: now,
        resolvedByUserId: this._currentUserId(),
      };
    });
    if (!changed) return;
    this._state.comments = this._comments;
    this._commitCommentsChange();
    this._syncCommentLayer();
    this._setStatus("Comment resolved");
  }

  _commitCommentsChange() {
    this._bumpCollabRevision();
    this._state.comments = this._comments;
    if (this._canEditCollab()) {
      this._markCollabDirty();
      this._queueSave();
      if (this._collabConnected && this._collabDocReady) this._flushCollabStateSync({ force: true });
      return;
    }
    if (this._canCommentCollab()) this._queueViewerCommentsSave();
  }

  _queueViewerCommentsSave() {
    window.clearTimeout(this._viewerCommentsSaveTimer);
    this._viewerCommentsSaveTimer = window.setTimeout(() => {
      this._viewerCommentsSaveTimer = 0;
      this._saveViewerComments().catch(() => null);
    }, 300);
  }

  async _saveViewerComments() {
    if (!this._projectId || !this._canCommentCollab() || this._canEditCollab()) return;
    const comments = this._normalizeCanvasComments(this._comments);
    const payload = JSON.stringify({ comments });
    if (payload === this._lastViewerCommentsJSON) return;
    await this._api(`/api/projects/${encodeURIComponent(this._projectId)}/canvas/comments`, {
      method: "PUT",
      body: payload,
    });
    this._lastViewerCommentsJSON = payload;
  }

  _mergeComments(localComments = [], remoteComments = []) {
    const map = new Map();
    for (const comment of [...localComments, ...remoteComments]) {
      const existing = map.get(comment.id);
      if (!existing || Number(comment.updatedAt || 0) >= Number(existing.updatedAt || 0)) {
        map.set(comment.id, comment);
      }
    }
    return [...map.values()].sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  }

  _applyRemoteComments(comments, collabRev = 0) {
    const remote = this._normalizeCanvasComments(comments);
    const merged = this._mergeComments(this._comments, remote);
    const mergedJSON = JSON.stringify(merged);
    if (mergedJSON === JSON.stringify(this._comments)) return;
    this._comments = merged;
    this._state.comments = merged;
    if (Number(collabRev || 0) > 0) {
      const meta = this._normalizeCanvasMetadata(this._canvasMetadata || this._state?.metadata);
      this._canvasMetadata = { ...meta, collabRev: Number(collabRev) };
      this._state.metadata = this._canvasMetadata;
    }
    this._syncCommentLayer();
    if (this._canEditCollab()) {
      this._markCollabDirty();
      this._flushCollabStateSync({ force: true });
    } else if (this._canCommentCollab()) {
      this._lastViewerCommentsJSON = JSON.stringify({ comments: merged });
    }
  }

  _canDeleteComment(comment) {
    return this._canCommentCollab() && String(comment?.authorUserId || "") === this._currentUserId();
  }

  _canResolveComments() {
    return this._canvasAccess === "owner" || (!!this._canvasOwnerUserId && this._canvasOwnerUserId === this._currentUserId());
  }

  /**
   * Author fields for a comment or reply this client is about to add. A
   * signed-out share viewer has no account id, and the server stamps these
   * fields regardless, so mirroring that here keeps the optimistic comment
   * identical to the stored one instead of briefly showing a delete affordance
   * that disappears on the next load.
   */
  _commentAuthorFields() {
    if (this._canvasAnonymousViewer) {
      return {
        authorUserId: "",
        authorName: this._currentUserName(),
        authorAvatarUrl: "",
        authorColor: this._currentUserCollabColor(),
        anonymous: true,
      };
    }
    return {
      authorUserId: this._currentUserId(),
      authorName: this._currentUserName(),
      authorAvatarUrl: this._currentUserAvatarUrl(),
      authorColor: this._currentUserCollabColor(),
    };
  }

  _currentUserId() {
    return String(window.DIFFUI_USER_ID || "local");
  }

  _currentUserName() {
    return String(window.DIFFUI_USER_NAME || "You").trim().slice(0, 48) || "You";
  }

  _currentUserAvatarUrl() {
    return String(window.DIFFUI_USER_AVATAR || "").trim();
  }

  _currentUserCollabColor() {
    return String(this._collabClientColor?.() || "").trim();
  }

  _normalizeCanvasComments(comments) {
    if (!Array.isArray(comments)) return [];
    return comments
      .map((comment) => {
        const id = String(comment?.id || "").trim();
        const body = String(comment?.body || "").trim();
        const anchor = this._normalizeCommentAnchor(comment?.anchor);
        if (!id || !body || !anchor) return null;
        return {
          id,
          anchor,
          body,
          authorUserId: String(comment.authorUserId || comment.author_user_id || ""),
          authorName: String(comment.authorName || comment.author_name || "User").slice(0, 48),
          authorAvatarUrl: String(comment.authorAvatarUrl || comment.author_avatar_url || ""),
          authorColor: String(comment.authorColor || comment.author_color || ""),
          // Set by the server for comments left through a public share link; kept
          // here so an editor's later full save does not strip the marker.
          anonymous: !!comment.anonymous,
          createdAt: Number(comment.createdAt || comment.created_at || Date.now()),
          updatedAt: Number(comment.updatedAt || comment.updated_at || comment.createdAt || Date.now()),
          resolved: !!comment.resolved,
          resolvedAt: Number(comment.resolvedAt || comment.resolved_at || 0) || undefined,
          resolvedByUserId: String(comment.resolvedByUserId || comment.resolved_by_user_id || ""),
          replies: Array.isArray(comment.replies)
            ? comment.replies.map((reply) => ({
                id: String(reply?.id || `reply-${crypto.randomUUID()}`),
                body: String(reply?.body || "").trim(),
                authorUserId: String(reply?.authorUserId || reply?.author_user_id || ""),
                authorName: String(reply?.authorName || reply?.author_name || "User").slice(0, 48),
                authorAvatarUrl: String(reply?.authorAvatarUrl || reply?.author_avatar_url || ""),
                authorColor: String(reply?.authorColor || reply?.author_color || ""),
                anonymous: !!reply?.anonymous,
                createdAt: Number(reply?.createdAt || reply?.created_at || Date.now()),
              })).filter((reply) => reply.body)
            : [],
        };
      })
      .filter(Boolean);
  }

  _normalizeCommentAnchor(anchor) {
    if (!anchor || typeof anchor !== "object") return null;
    if (anchor.type === "node") {
      const nodeId = String(anchor.nodeId || anchor.node_id || "").trim();
      if (!nodeId) return null;
      return {
        type: "node",
        nodeId,
        offsetX: clampNumber(Number(anchor.offsetX ?? anchor.offset_x), 0, 1),
        offsetY: clampNumber(Number(anchor.offsetY ?? anchor.offset_y), 0, 1),
      };
    }
    const x = Number(anchor.x);
    const y = Number(anchor.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { type: "canvas", x, y };
  }

  _drawRemoteCollabPortSessions(ctx) {
    for (const [peerId, port] of this._collabPortSmoothTargets) {
      const peer = this._collabPeers.get(peerId);
      this._drawPortWire(ctx, port, resolveCollabColor(peer?.color, peerId));
    }
  }

  _drawPortWire(ctx, port, color = "") {
    const from = this._state.nodes.find((node) => node.id === port.from);
    if (!from) return;
    if (port.promptPreviewRect) this._drawPortPromptPreview(ctx, port.promptPreviewRect);
    const anchor = this._nodeOutputAnchor(from);
    const a = this._worldToScreen(anchor.x, anchor.y);
    const endX = Number.isFinite(port.renderX) ? port.renderX : port.x;
    const endY = Number.isFinite(port.renderY) ? port.renderY : port.y;
    const b = this._worldToScreen(endX, endY);
    ctx.save();
    ctx.strokeStyle = color || this._palette.portWire;
    ctx.lineWidth = 2;
    strokeNoodle(ctx, a, b);
    ctx.restore();
  }

  _drawPortDrag(ctx) {
    const from = this._state.nodes.find((node) => node.id === this._dragPort.from);
    if (!from) return;
    const port = {
      from: this._dragPort.from,
      x: this._dragPort.x,
      y: this._dragPort.y,
      renderX: this._dragPort.renderX,
      renderY: this._dragPort.renderY,
      promptPreviewRect: this._dragPort.promptPreviewRect,
    };
    this._drawPortWire(ctx, port, this._palette.portWire);
  }
  _drawPortPromptPreview(ctx, rect) {
    const p = this._worldToScreen(rect.x, rect.y);
    const scale = this._state.viewport.scale || 1;
    ctx.save();
    ctx.strokeStyle = this._palette.portPreviewRim;
    ctx.fillStyle = this._palette.portPreviewFill;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 6]);
    ctx.fillRect(p.x, p.y, rect.width * scale, rect.height * scale);
    ctx.strokeRect(p.x, p.y, rect.width * scale, rect.height * scale);
    ctx.restore();
  }

  _onPromptBoxPointerDown(event, nodeId) {
    this._syncAltKeyFromPointerEvent(event);
    if (event.button === 1) {
      this._startPan(event, this._eventWorld(event), "middle");
      return;
    }
    if (event.button !== 0 || this._spacePan) return;
    if (this._tool === TOOL_COMMENT) {
      event.preventDefault();
      event.stopPropagation();
      this.focus();
      this._closeExpandedComments();
      this._placeCommentAt(this._eventWorld(event));
      return;
    }
    if (this._isPromptBoxInteractiveTarget(event.target)) return;
    const textarea = event.currentTarget.querySelector("textarea");
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    if (this._tool !== TOOL_POINTER) {
      const hasImage = !!this._activeImageForNode(node);
      // Edit may also start on a node with no image of its own: the drag can end
      // over a neighbouring image, and does nothing at all when it does not.
      const drawsRect = this._tool === TOOL_EDIT || (this._tool === TOOL_RECT && hasImage);
      if (drawsRect && this._canEditCollab()) {
        event.preventDefault();
        if (hasImage) this._selectNodeById(nodeId, event.shiftKey);
        const world = this._eventWorld(event);
        this._pointer = {
          mode: "draw-rect",
          start: world,
          current: world,
          targetImageId: hasImage ? node.id : "",
          imagesOnly: this._tool === TOOL_EDIT,
        };
        this._capturePointer(event);
        this._publishCollabAwareness(world.x, world.y);
        this._draw();
        this._syncToolbar();
        this._syncPromptOverlays();
        return;
      }
      if (hasImage) {
        this._selectNodeById(nodeId, event.shiftKey);
        this._draw();
        this._syncToolbar();
        this._syncPromptOverlays();
        return;
      }
      if (this._canEditCollab()) textarea?.focus();
      return;
    }
    event.preventDefault();
    if (!this._canEditCollab()) {
      this._prepareNodeSelectionForDrag(nodeId, event.shiftKey);
      this._selectNodeById(nodeId, event.shiftKey);
      this._draw();
      this._syncToolbar();
      this._syncPromptOverlays();
      return;
    }
    const dup = this._altDuplicateDragSourceId(nodeId, event);
    if (dup) {
      this._prepareNodeSelectionForDrag(nodeId, false);
      this._selectNodeById(nodeId, false);
      this._startMoveNodeDrag(event, this._eventWorld(event), { duplicateSourceId: dup });
    } else {
      this._prepareNodeSelectionForDrag(nodeId, event.shiftKey);
      this._startMoveNodeDrag(event, this._eventWorld(event));
    }
    this._draw();
    this._syncToolbar();
    this._syncPromptOverlays();
  }

  _onPromptBoxDoubleClick(event, nodeId) {
    if (!this._canEditCollab()) return;
    if (event.button !== 0) {
      this._logPointerClickPromptSkip("non_primary_button", { nodeId, button: event.button });
      return;
    }
    if (this._tool !== TOOL_POINTER) {
      this._logPointerClickPromptSkip("pointer_tool_not_active", { nodeId, tool: this._tool });
      return;
    }
    if (this._spacePan) {
      this._logPointerClickPromptSkip("space_pan_active", { nodeId });
      return;
    }
    if (this._isPromptBoxInteractiveTarget(event.target)) {
      this._logPointerClickPromptSkip("interactive_target", { nodeId, target: event.target?.tagName || "" });
      return;
    }
    const source = this._state.nodes.find((item) => item.id === nodeId);
    if (!source) {
      this._logPointerClickPromptSkip("source_node_missing", { nodeId });
      return;
    }
    if (!this._activeImageForNode(source)) {
      this._logPointerClickPromptSkip("source_has_no_active_image", { nodeId });
      return;
    }
    const world = this._eventWorld(event);
    if (!pointInNode(world.x, world.y, source)) {
      this._logPointerClickPromptSkip("click_outside_source_node", { nodeId, world });
      return;
    }
    this._createPointerClickPrompt(event, source, world);
  }

  // Double-click does not wait for the source image's analysis. The analysis only
  // adds optional context to the suggestion, the asset it describes is readable
  // from the moment the node exists, and a node whose analysis never settled —
  // the tab reloaded, or the canvas_asset_analysis event arrived while the socket
  // was down — stays analysisStatus=processing in the stored document forever.
  // Gating here made those pasted screenshots permanently undouble-clickable.
  _createPointerClickPrompt(event, source, world) {
    const activeImage = this._activeImageForNode(source);
    if (!activeImage) {
      this._logPointerClickPromptSkip("active_image_missing", { nodeId: source?.id || "" });
      return;
    }
    const click = this._imageClickInfoForEvent(source, event, world);
    if (!click) {
      this._logPointerClickPromptSkip("click_image_info_missing", { nodeId: source.id, imageId: activeImage.id || "" });
      this._setStatus("Clicked image is not ready yet.");
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const requestId = crypto.randomUUID();
    const target = this._createPromptNode(this._pointerClickPromptRect(source), "", {
      createdFrom: "pointer_double_click",
      clickPromptStatus: "detecting",
      clickPromptRequestId: requestId,
      sourceNodeId: source.id,
      clickedImageId: activeImage.id || "",
      clickImageX: click.imageX,
      clickImageY: click.imageY,
    }, { name: "" });
    if (!target) {
      this._logPointerClickPromptSkip("target_node_create_failed", { nodeId: source.id, imageId: activeImage.id || "" });
      return;
    }
    this._addEdge(source.id, target.id, "prompt_input");
    this._startPointerClickEffect(source, target, click, world);
    this._syncToolbar();
    this._syncPromptOverlays();
    this._focusPromptNode(target, { camera: false });
    this._draw();
    this._setStatus("Detecting clicked object...");
    this._requestCanvasClickPrompt(source, target, click, requestId).catch((error) => {
      this._logPointerClickPromptSkip("click_prompt_request_failed", { nodeId: source.id, targetNodeId: target.id, error });
      this._markClickPromptError(target.id, requestId, error.message || "Click prompt failed");
    });
  }

  _logPointerClickPromptSkip(reason, details = {}) {
    console.info("[diffui-canvas] Image double-click prompt skipped", { reason, ...details });
  }

  _startPointerClickEffect(source, target, click, world) {
    const effect = this._createThumbnailLiftEffect(source, target, click, world);
    if (!effect) return;
    this._clickEffects.push(effect);
    this._queueClickEffectFrame();
    this._publishCollabClickEffect(effect);
  }

  _createThumbnailLiftEffect(source, target, click, world) {
    const imageUrl = this._thumbnailLiftImageUrl(source);
    const img = this._imageFor(imageUrl);
    return {
      type: CLICK_EFFECT_THUMBNAIL,
      startTime: performance.now(),
      duration: CLICK_EFFECT_THUMBNAIL_DURATION,
      origin: { x: world.x, y: world.y },
      destination: { x: target.x + target.width / 2, y: target.y + target.height / 2 },
      sourceNodeId: source?.id || "",
      imageUrl,
      image: img,
      click,
      sourceRect: img ? this._thumbnailSourceRect(img, click) : null,
      tilt: (Math.random() - 0.5) * 0.38,
    };
  }

  /** Rebuilds a peer's loupe locally from the world coordinates it relayed. */
  _createRemoteThumbnailLiftEffect(relayed) {
    const source = relayed.nodeId ? this._state?.nodes?.find((node) => node.id === relayed.nodeId) : null;
    const imageUrl = relayed.imageUrl || this._thumbnailLiftImageUrl(source);
    const img = this._imageFor(imageUrl);
    return {
      type: CLICK_EFFECT_THUMBNAIL,
      startTime: performance.now(),
      duration: CLICK_EFFECT_THUMBNAIL_DURATION,
      origin: { ...relayed.origin },
      destination: { ...relayed.destination },
      sourceNodeId: relayed.nodeId,
      imageUrl,
      image: img,
      click: relayed.click,
      sourceRect: img ? this._thumbnailSourceRect(img, relayed.click) : null,
      tilt: relayed.tilt,
    };
  }

  _thumbnailLiftImageUrl(source) {
    if (!source) return "";
    const activeImage = this._activeImageForNode(source);
    return activeImage?.image_url || activeImage?.imageUrl || source.image_url || source.imageUrl || "";
  }

  _thumbnailSourceRect(img, click) {
    if (!img?.naturalWidth || !img?.naturalHeight) return null;
    const imageWidth = Math.max(1, Number(click?.imageWidth) || img.naturalWidth);
    const imageHeight = Math.max(1, Number(click?.imageHeight) || img.naturalHeight);
    const centerX = clampNumber((Number(click?.imageX) || 0) / imageWidth, 0, 1) * img.naturalWidth;
    const centerY = clampNumber((Number(click?.imageY) || 0) / imageHeight, 0, 1) * img.naturalHeight;
    const size = Math.max(72, Math.min(img.naturalWidth, img.naturalHeight) * 0.22);
    return clampImageSourceRect({
      x: centerX - size / 2,
      y: centerY - size / 2,
      width: size,
      height: size,
    }, img);
  }

  _pointerClickPromptRect(source) {
    return autoPlaceNodeRect(this._state.nodes, source.width, source.height, [nodeRect(source)]);
  }

  async _requestCanvasClickPrompt(source, target, click, requestId) {
    // Best effort. The server resolves the clicked image from the identifiers
    // below and only falls back to the stored document, so a save that loses a
    // compare-and-set must not cost the user their double-click — that is how
    // nodes ended up stranded with clickPromptError "canvas_version_conflict".
    await this._saveState().catch((error) => {
      this._logPointerClickPromptSkip("save_before_click_prompt_failed", {
        nodeId: source.id,
        targetNodeId: target.id,
        error: error?.message || String(error || ""),
      });
    });
    const activeImage = this._activeImageForNode(source) || {};
    const imageMetadata = safeParse(activeImage.metadata_json || activeImage.metadataJson) || {};
    await this._api(`/api/projects/${encodeURIComponent(this._projectId)}/canvas/click-prompt`, {
      method: "POST",
      body: JSON.stringify({
        requestId,
        // Echoed back on canvas_click_prompt_ready so only this client generates from the
        // suggestion; the other edit clients type it in and stop there.
        clientId: this._collabClientId(),
        sourceNodeId: source.id,
        targetNodeId: target.id,
        sourceName: source.name || "",
        // What was clicked, independent of the canvas document: a pasted
        // screenshot's asset row exists from the moment its node appears, long
        // before the document that mentions it has been written.
        assetId: String(imageMetadata.assetId || imageMetadata.asset_id || "").trim(),
        imageId: String(imageMetadata.imageId || imageMetadata.image_id || "").trim(),
        imageUrl: String(activeImage.image_url || activeImage.imageUrl || "").trim(),
        imageX: click.imageX,
        imageY: click.imageY,
        imageWidth: click.imageWidth,
        imageHeight: click.imageHeight,
      }),
    });
  }

  _typePromptIntoNode(nodeId, prompt, metadata, { autoGenerate = true } = {}) {
    this._cancelPromptTyping(nodeId);
    const durationMs = 1500;
    const startedAt = performance.now();
    const animation = { frame: 0 };
    const tick = (now) => {
      const node = this._state.nodes.find((item) => item.id === nodeId);
      if (!node) {
        this._cancelPromptTyping(nodeId);
        return;
      }
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const length = Math.min(prompt.length, Math.ceil(prompt.length * progress));
      const visiblePrompt = prompt.slice(0, length);
      this._promptTypingTextByNode.set(nodeId, visiblePrompt);
      const textarea = this.shadowRoot
        .getElementById("promptLayer")
        ?.querySelector(`[data-node-id="${CSS.escape(nodeId)}"] textarea`);
      if (textarea && textarea.value !== visiblePrompt) textarea.value = visiblePrompt;
      if (progress < 1) {
        animation.frame = window.requestAnimationFrame(tick);
        return;
      }
      this._promptTypingAnimations.delete(nodeId);
      this._promptTypingTextByNode.delete(nodeId);
      const latestMetadata = safeParse(node.metadata_json) || metadata || {};
      this._patchNode(nodeId, {
        prompt,
        metadataJson: JSON.stringify({
          ...latestMetadata,
          clickPromptStatus: "ready",
        }),
      }, { quiet: true });
      this._syncPromptOverlays();
      this._draw();
      if (!autoGenerate) {
        // A peer typed this in; the client that double-clicked owns the generation and its
        // canvas_generation_started will bring the loading slots here.
        this._setStatus("Prompt ready");
        return;
      }
      this._setStatus("Generating from clicked object...");
      const latest = this._state.nodes.find((item) => item.id === nodeId);
      if (latest) this._generateFromPromptNode(latest, { select: false }).catch((error) => this._setStatus(error.message || "Generation failed"));
    };
    animation.frame = window.requestAnimationFrame(tick);
    this._promptTypingAnimations.set(nodeId, animation);
  }

  _cancelPromptTyping(nodeId) {
    const animation = this._promptTypingAnimations.get(nodeId);
    if (animation) window.cancelAnimationFrame(animation.frame);
    this._promptTypingAnimations.delete(nodeId);
    this._promptTypingTextByNode.delete(nodeId);
  }

  _markClickPromptError(nodeId, requestId, message) {
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    this._cancelPromptTyping(nodeId);
    const metadata = safeParse(node.metadata_json) || {};
    if (metadata.clickPromptRequestId && requestId && metadata.clickPromptRequestId !== requestId) return;
    this._patchNode(nodeId, {
      metadataJson: JSON.stringify({
        ...metadata,
        clickPromptStatus: "error",
        clickPromptError: message,
      }),
    }, { quiet: true });
    this._syncPromptOverlays();
    this._draw();
    this._setStatus(message || "Click prompt failed");
  }

  _onNodeOutputPointerDown(event, nodeId) {
    if (!this._canEditCollab()) return;
    if (event.button !== 0 || this._spacePan) return;
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    // The drag may end on empty canvas and create a fork node, whose textarea
    // wants these suggestions immediately. Asking now buys the round trip.
    this._prefetchNextPageSuggestions(node);
    event.preventDefault();
    event.stopPropagation();
    this.focus();
    this._selectNodeById(nodeId, event.shiftKey);
    const anchor = this._nodeOutputAnchor(node);
    this._dragPort = {
      from: node.id,
      x: anchor.x,
      y: anchor.y,
      renderX: anchor.x,
      renderY: anchor.y,
      targetPromptId: "",
      promptPreviewRect: null,
    };
    this._capturePointer(event);
    this._draw();
    this._syncToolbar();
    this._syncPromptOverlays();
  }

  _promptTextareaForNode(nodeId) {
    if (!nodeId) return null;
    return this.shadowRoot
      .getElementById("promptLayer")
      ?.querySelector(`[data-node-id="${CSS.escape(nodeId)}"] textarea`) || null;
  }

  /**
   * The cache key for a node's suggestions. Generated images and uploaded
   * assets both keep their id across drags; a node with neither still gets one
   * entry of its own, since the server can resolve it by node id.
   */
  _nextPageSuggestionsKeyForNode(node) {
    if (!node || !this._activeImageForNode(node)) return "";
    return this._imageIdForNode(node) || this._assetIdForNode(node) || node.id;
  }

  /**
   * Ask what pages a visitor would navigate to from a node's active image.
   * Results are cached per image, so dragging twice off the same screen only
   * costs one request. Failures resolve to an empty list — the placeholder just
   * stays as it is.
   */
  _prefetchNextPageSuggestions(node) {
    if (!node || !this._projectId) return null;
    const imageId = this._nextPageSuggestionsKeyForNode(node);
    if (!imageId) return null;
    const cached = this._nextPageSuggestionsByImageId.get(imageId);
    if (cached) return cached;
    if (this._nextPageSuggestionsInFlight && this._nextPageSuggestionsInFlight.imageId !== imageId) {
      this._abortNextPageSuggestionsRequest();
    }
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const request = this._api(`/api/projects/${encodeURIComponent(this._projectId)}/canvas/next-page-suggestions`, {
      method: "POST",
      body: JSON.stringify({ imageId: this._imageIdForNode(node), nodeId: node.id, sourceName: node.name || "" }),
      ...(controller ? { signal: controller.signal } : {}),
    })
      .then((data) => normalizeNextPageSuggestions(data?.suggestions))
      .catch(() => [])
      .then((suggestions) => {
        if (this._nextPageSuggestionsInFlight?.imageId === imageId) this._nextPageSuggestionsInFlight = null;
        // An empty answer is not worth caching; a later drag can try again.
        if (!suggestions.length) this._nextPageSuggestionsByImageId.delete(imageId);
        return suggestions;
      });
    this._nextPageSuggestionsByImageId.set(imageId, request);
    this._nextPageSuggestionsInFlight = { imageId, controller };
    return request;
  }

  _abortNextPageSuggestionsRequest() {
    const inFlight = this._nextPageSuggestionsInFlight;
    this._nextPageSuggestionsInFlight = null;
    if (!inFlight) return;
    this._nextPageSuggestionsByImageId.delete(inFlight.imageId);
    inFlight.controller?.abort?.();
  }

  /**
   * Take over a freshly forked prompt node's placeholder with the pages you
   * could navigate to from the image it is wired to. The default copy stays up
   * for at least NEXT_PAGE_PLACEHOLDER_MIN_HOLD_MS, or until the suggestions
   * land if that takes longer.
   */
  _startNextPagePlaceholderCycle(nodeId, sourceNodeId) {
    this._stopNextPagePlaceholderCycle("", { abortPending: false });
    const source = this._state.nodes.find((item) => item.id === sourceNodeId);
    if (!source) return;
    const request = this._prefetchNextPageSuggestions(source);
    const seq = ++this._nextPagePlaceholderSeq;
    this._nextPagePlaceholderPendingImageId = this._nextPageSuggestionsKeyForNode(source);
    const readyAt = Date.now() + NEXT_PAGE_PLACEHOLDER_MIN_HOLD_MS;
    const begin = (suggestions) => {
      if (seq !== this._nextPagePlaceholderSeq) return;
      if (this._nextPagePlaceholderShouldStop(nodeId)) return;
      const list = suggestions.length
        ? suggestions
        : normalizeNextPageSuggestions([...NEXT_PAGE_PLACEHOLDER_FALLBACKS]);
      if (!list.length) return;
      this._nextPagePlaceholderTimer = window.setTimeout(() => {
        this._nextPagePlaceholderTimer = 0;
        if (seq !== this._nextPagePlaceholderSeq) return;
        this._beginNextPagePlaceholderCycle(nodeId, list);
      }, Math.max(0, readyAt - Date.now()));
    };
    // No resolvable source image / no project → still show the fallback cycle.
    if (!request) {
      begin([]);
      return;
    }
    request.then((suggestions) => begin(suggestions || []));
  }

  _beginNextPagePlaceholderCycle(nodeId, suggestions) {
    this._nextPagePlaceholderPendingImageId = "";
    if (this._nextPagePlaceholderShouldStop(nodeId)) return;
    const cycle = new NextPagePlaceholderCycle({
      getTextarea: () => this._promptTextareaForNode(nodeId),
      defaultText: PROMPT_PLACEHOLDER_DEFAULT,
      suggestions,
      shouldStop: () => this._nextPagePlaceholderShouldStop(nodeId),
    });
    this._nextPagePlaceholder = { nodeId, cycle };
    if (!cycle.start()) this._nextPagePlaceholder = null;
  }

  /**
   * Seed / blank-canvas prompt has no connected image, so reuse the website
   * starter prompts as the typewriter cycle. Same timings as a forked node.
   * Only starts on an untouched initial board so we never rewrite an existing
   * project's empty prompt mid-session.
   */
  _startSeedPlaceholderCycleIfNeeded() {
    if (!this._isInitialCanvasState(this._state)) return;
    if (this._canvasHasPromptText()) return;
    const node = this._state.nodes.find((item) => item && item.kind !== "image");
    if (!node || this._nextPagePlaceholderShouldStop(node.id)) return;
    const suggestions = this._seedPlaceholderSuggestions(node);
    if (!suggestions.length) return;
    const seq = ++this._nextPagePlaceholderSeq;
    const readyAt = Date.now() + NEXT_PAGE_PLACEHOLDER_MIN_HOLD_MS;
    window.clearTimeout(this._nextPagePlaceholderTimer);
    this._nextPagePlaceholderTimer = window.setTimeout(() => {
      this._nextPagePlaceholderTimer = 0;
      if (seq !== this._nextPagePlaceholderSeq) return;
      this._beginNextPagePlaceholderCycle(node.id, suggestions);
    }, Math.max(0, readyAt - Date.now()));
  }

  _seedPlaceholderSuggestions(_node) {
    // Same three examples as the coach tip, same order.
    return normalizeNextPageSuggestions([...CANVAS_COACH_PROMPT_EXAMPLES], CANVAS_COACH_PROMPT_EXAMPLES.length);
  }

  /**
   * Stops the running cycle, optionally only when it belongs to `nodeId`.
   * A cycle that is superseded by another fork keeps its request alive, since
   * the replacement usually wants the very same answer.
   */
  _stopNextPagePlaceholderCycle(nodeId = "", { abortPending = true } = {}) {
    const active = this._nextPagePlaceholder;
    const pendingImageId = abortPending ? this._nextPagePlaceholderPendingImageId || "" : "";
    if (nodeId && active && active.nodeId !== nodeId) return;
    if (nodeId && !active && !pendingImageId) return;
    this._nextPagePlaceholderSeq += 1;
    this._nextPagePlaceholderPendingImageId = "";
    window.clearTimeout(this._nextPagePlaceholderTimer);
    this._nextPagePlaceholderTimer = 0;
    this._nextPagePlaceholder = null;
    active?.cycle.stop();
    // Nothing is waiting on the answer any more, so stop paying for it.
    if (pendingImageId && this._nextPageSuggestionsInFlight?.imageId === pendingImageId) {
      this._abortNextPageSuggestionsRequest();
    }
  }

  /**
   * Stop the typewriter once the user has typed (or a generation is in flight).
   * Focus alone must not stop it — new prompts are focused immediately so the
   * cycle has to keep running until the first character lands.
   */
  _nextPagePlaceholderShouldStop(nodeId) {
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node) return true;
    if (String(node.prompt || "").trim()) return true;
    if (this._nodeGenerationInFlight(node)) return true;
    const textarea = this._promptTextareaForNode(nodeId);
    if (!textarea) return false;
    return !!String(textarea.value || "").trim();
  }

  // Memoized parse of a node's metadata_json. Parsing was happening multiple
  // times per node per frame; the cache is keyed on the node object + raw string
  // so it stays valid until the metadata actually changes. Treat the result as
  // read-only.
  _nodeMetadata(node) {
    if (!node) return {};
    const raw = node.metadata_json || node.metadataJson || "";
    const cached = this._nodeMetaCache.get(node);
    if (cached && cached.raw === raw) return cached.parsed;
    const parsed = safeParse(raw) || {};
    this._nodeMetaCache.set(node, { raw, parsed });
    return parsed;
  }

  // Shared visibility rule for prompt boxes, used by both the full content sync
  // and the geometry-only reposition so the two never disagree about which
  // boxes exist. Nodes that are selected, being edited/focused, or mid-work are
  // always rendered even when scrolled out of view.
  _promptBoxShouldRender(node, box, cull, activeEditorId, activeEl) {
    return (
      this._nodeIntersectsRect(node, cull) ||
      node.selected ||
      node.id === activeEditorId ||
      this._nodeGenerationInFlight(node) ||
      this._nodeAnalysisProcessing(node) ||
      !!(box && activeEl && box.contains(activeEl))
    );
  }

  // Position + size a prompt box from its node. Uses a compositor-friendly
  // transform (instead of left/top) so panning many boxes does not trigger
  // layout. Content/dataset state is intentionally left untouched here.
  _applyPromptBoxGeometry(box, node, scale) {
    box.style.display = "";
    const p = this._worldToScreen(node.x, node.y);
    box.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
    const stageWidth = node.width * scale;
    const stageHeight = node.height * scale;
    box.style.setProperty("--node-stage-width", `${stageWidth}px`);
    box.style.setProperty("--node-stage-height", `${stageHeight}px`);
    const outputGap = this._nodeOutputGap(node);
    box.style.setProperty("--node-output-gap", `${outputGap}px`);
    box.style.setProperty("--node-stack-bar-gap", `${this._nodeStackBarGap(node)}px`);
    box.style.setProperty("--stack-offset-1", `${STACK_LAYER_OFFSET * scale}px`);
    box.style.setProperty("--stack-offset-2", `${STACK_LAYER_OFFSET * 2 * scale}px`);
    box.style.setProperty("--stack-offset-3", `${STACK_LAYER_OFFSET * 3 * scale}px`);
    const analysisProcessing = box.dataset.analysisProcessing === "true";
    const outputChromeWidth = analysisProcessing ? 0 : outputGap + NODE_RIGHT_CONNECTOR_WIDTH + 16;
    box.style.width = `${stageWidth + outputChromeWidth}px`;
    box.style.height = `${stageHeight + this._nodeStackBarOverflowPx(node, scale)}px`;
  }

  // Scale-dependent presentation (low-detail chrome, suggestion visibility) for
  // an existing prompt box. Cheap enough to run on every pan/zoom frame.
  _applyPromptBoxViewportPresentation(box, node) {
    box.dataset.lowDetail = this._shouldUseLowDetailNodeUi(node) ? "true" : "false";
    const editor = box.querySelector(".promptEditor");
    const promptSuggestions = box.querySelector("diffui-prompt-suggestions");
    this._syncPromptSuggestions(promptSuggestions, editor, node);
  }

  // Cheap viewport-driven update: only reposition/resize visible prompt boxes.
  // If a node has scrolled into view but has no box yet, fall back to a full
  // content sync for that frame so the new box gets populated.
  _repositionPromptOverlays() {
    const layer = this.shadowRoot.getElementById("promptLayer");
    if (!layer) return;
    const scale = this._state.viewport.scale || 1;
    const cull = this._visibleWorldRectWithMargin(0.6);
    const activeEditorId = this._activePromptEditorNodeId();
    const activeEl = this.shadowRoot.activeElement;
    const boxes = new Map();
    layer.querySelectorAll(".promptBox").forEach((b) => boxes.set(b.dataset.nodeId, b));
    for (const node of this._state.nodes) {
      if (node.kind === "image") continue;
      const box = boxes.get(node.id);
      if (!this._promptBoxShouldRender(node, box, cull, activeEditorId, activeEl)) {
        if (box) box.style.display = "none";
        continue;
      }
      if (!box) {
        this._syncPromptOverlays();
        return;
      }
      this._applyPromptBoxGeometry(box, node, scale);
      this._applyPromptBoxViewportPresentation(box, node);
    }
  }

  _syncPromptOverlays() {
    const layer = this.shadowRoot.getElementById("promptLayer");
    const seen = new Set();
    // Cull off-screen prompt boxes: hide them and skip the (expensive) per-node
    // DOM sync. Always render nodes that are selected, being edited/focused, or
    // mid-generation so in-progress UI is never disrupted.
    const overlayCull = this._visibleWorldRectWithMargin(0.6);
    const activeEditorId = this._activePromptEditorNodeId();
    const activeEl = this.shadowRoot.activeElement;
    this._state.nodes.forEach((node, index) => {
      if (node.kind === "image") return;
      let box = layer.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
      if (!this._promptBoxShouldRender(node, box, overlayCull, activeEditorId, activeEl)) {
        if (box) {
          box.style.display = "none";
          seen.add(node.id);
        }
        return;
      }
      seen.add(node.id);
      if (!box) {
        box = document.createElement("div");
        box.className = "promptBox";
        box.dataset.nodeId = node.id;
        const header = document.createElement("div");
        header.className = "nodeHeader";
        const title = document.createElement("div");
        title.className = "nodeTitle";
        const headerActions = document.createElement("div");
        headerActions.className = "nodeHeaderActions";
        [
          ["delete", "Delete", "trash"],
          ["copy", "Copy", "copy"],
          ["more", "More options", "more-horizontal"],
        ].forEach(([action, label, icon]) => {
          const button = document.createElement("button");
          button.className = "nodeIconBtn";
          button.type = "button";
          button.dataset.nodeAction = action;
          button.title = label;
          button.setAttribute("aria-label", label);
          button.appendChild(featherIcon(icon));
          headerActions.appendChild(button);
        });
        header.append(title, headerActions);
        const input = document.createElement("div");
        input.className = "nodeInput";
        const inputHandle = document.createElement("div");
        inputHandle.className = "nodeInputHandle";
        inputHandle.appendChild(connectorChevronIcon());
        input.appendChild(inputHandle);
        const stage = document.createElement("div");
        stage.className = "nodeStage";
        const editor = document.createElement("div");
        editor.className = "promptEditor";
        const fileDropOverlay = document.createElement("div");
        fileDropOverlay.className = "promptFileDropOverlay";
        fileDropOverlay.textContent = "Add images as inputs";
        fileDropOverlay.setAttribute("aria-hidden", "true");
        const textarea = document.createElement("textarea");
        textarea.placeholder = PROMPT_PLACEHOLDER_DEFAULT;
        textarea.maxLength = MAX_PROMPT_LENGTH;
        const mentionMenu = document.createElement("div");
        mentionMenu.className = "promptMentionMenu";
        mentionMenu.hidden = true;
        mentionMenu.setAttribute("role", "listbox");
        const promptSuggestions = document.createElement("diffui-prompt-suggestions");
        promptSuggestions.hidden = true;
        promptSuggestions.dataset.visible = "false";
        const actions = document.createElement("div");
        actions.className = "promptActions";
        const resolutionControl = this._createPromptResolutionControl(node.id);
        const brandControl = this._createPromptBrandControl(node.id);
        const generateWrap = document.createElement("div");
        generateWrap.className = "generateWrap";
        const plungerSlide = document.createElement("div");
        plungerSlide.className = "plungerSlide";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "generateBtn";
        btn.textContent = "Generate";
        const plungerBars = document.createElement("div");
        plungerBars.className = "plungerBars";
        plungerBars.setAttribute("aria-hidden", "true");
        plungerSlide.append(btn, plungerBars);
        generateWrap.append(plungerSlide);
        actions.append(brandControl, resolutionControl, generateWrap);
        editor.append(textarea, mentionMenu, promptSuggestions, actions, fileDropOverlay);
        const stack = document.createElement("div");
        stack.className = "nodeStack";
        stack.hidden = true;
        const loading = document.createElement("div");
        loading.className = "nodeLoading";
        loading.textContent = "Generating...";
        loading.hidden = true;
        const generationError = this._createNodeErrorPanel(node.id);
        const stackBar = document.createElement("div");
        stackBar.className = "nodeStackBar";
        const dots = document.createElement("div");
        dots.className = "stackDots";
        const addStack = document.createElement("button");
        addStack.className = "stackAdd";
        addStack.type = "button";
        addStack.title = "Generate more variations";
        addStack.setAttribute("aria-label", "Generate more variations");
        addStack.appendChild(stackPlusIcon());
        addStack.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
        });
        addStack.addEventListener("click", (event) => this._handleStackAddAction(node.id, event, "stackAdd-button"));
        stackBar.append(dots, addStack);
        stage.append(editor, stack, loading, generationError, stackBar);
        const output = document.createElement("div");
        output.className = "nodeOutput";
        const outputHandle = document.createElement("div");
        outputHandle.className = "nodeOutputHandle";
        outputHandle.appendChild(connectorChevronIcon());
        output.appendChild(outputHandle);
        const resizeHandle = document.createElement("div");
        resizeHandle.className = "nodeResizeHandle";
        resizeHandle.setAttribute("aria-hidden", "true");
        box.append(header, input, stage, output, resizeHandle);
        box.addEventListener("pointerdown", (event) => this._onPromptBoxPointerDown(event, node.id));
        box.addEventListener("pointermove", (event) => this._onPointerMove(event));
        box.addEventListener("pointerup", (event) => this._onPointerUp(event));
        box.addEventListener("pointercancel", (event) => this._onPointerUp(event));
        box.addEventListener("dblclick", (event) => this._onPromptBoxDoubleClick(event, node.id));
        box.addEventListener("auxclick", (event) => {
          if (event.button === 1) event.preventDefault();
        });
        outputHandle.addEventListener("pointerdown", (event) => this._onNodeOutputPointerDown(event, node.id));
        outputHandle.addEventListener("pointermove", (event) => this._onPointerMove(event));
        outputHandle.addEventListener("pointerup", (event) => this._onPointerUp(event));
        outputHandle.addEventListener("pointercancel", (event) => this._onPointerUp(event));
        resizeHandle.addEventListener("pointerdown", (event) => {
          const latest = this._state.nodes.find((item) => item.id === node.id);
          if (latest) this._startResizeNodeDrag(event, latest);
        });
        resizeHandle.addEventListener("pointermove", (event) => this._onPointerMove(event));
        resizeHandle.addEventListener("pointerup", (event) => this._onPointerUp(event));
        resizeHandle.addEventListener("pointercancel", (event) => this._onPointerUp(event));
        stackBar.addEventListener("pointerdown", (event) => {
          if (event.target.closest(".stackAdd, .stackDot")) event.stopPropagation();
        });
        stackBar.addEventListener("click", (event) => this._onNodeStackBarClick(event, node.id));
        textarea.addEventListener("beforeinput", () => this._capturePromptTextareaBeforeInput(node.id, textarea));
        textarea.addEventListener("input", () => this._onPromptTextareaInput(node.id, textarea));
        textarea.addEventListener("keydown", (event) => this._onPromptTextareaKeyDown(event, node.id, textarea));
        textarea.addEventListener("blur", () => {
          window.setTimeout(() => {
            if (this.shadowRoot.activeElement?.closest?.(".promptMentionMenu")) return;
            this._closePromptMentionMenus();
          }, 80);
        });
        mentionMenu.addEventListener("pointerdown", (event) => event.stopPropagation());
        mentionMenu.addEventListener("click", (event) => this._onPromptMentionMenuClick(event, node.id, textarea));
        promptSuggestions.addEventListener("pointerdown", (event) => event.stopPropagation());
        promptSuggestions.addEventListener("diffui-prompt-suggestion:select", (event) => {
          this._onPromptSuggestionSelect(event, node.id, textarea);
        });
        btn.addEventListener("click", () => {
          if (btn.disabled) return;
          const latest = this._state.nodes.find((item) => item.id === node.id);
          if (!latest || this._nodeGenerationInFlight(latest)) return;
          if (String(latest.prompt || "").trim()) box.dataset.generating = "true";
          this._generateFromPromptNode(latest).catch((error) => this._setStatus(error.message || "Generation failed"));
        });
        btn.addEventListener("pointerdown", (event) => {
          if (event.button !== 0 || btn.disabled) return;
          const latest = this._state.nodes.find((item) => item.id === node.id);
          if (!latest || this._nodeGenerationInFlight(latest)) return;
          this._startGeneratePlunger(event, btn, plungerBars, plungerSlide, node.id);
        });
        headerActions.addEventListener("click", (event) => this._onNodeHeaderAction(event, node.id));
        layer.appendChild(box);
      }
      box.style.zIndex = String(index + 1);
      const textarea = box.querySelector("textarea");
      const editor = box.querySelector(".promptEditor");
      if (editor && !editor.querySelector(".promptFileDropOverlay")) {
        const fileDropOverlay = document.createElement("div");
        fileDropOverlay.className = "promptFileDropOverlay";
        fileDropOverlay.textContent = "Add images as inputs";
        fileDropOverlay.setAttribute("aria-hidden", "true");
        editor.appendChild(fileDropOverlay);
      }
      const resolutionControl = box.querySelector(".promptResolutionControl");
      const brandControl = box.querySelector(".promptBrandControl");
      const promptSuggestions = box.querySelector("diffui-prompt-suggestions");
      const title = box.querySelector(".nodeTitle");
      if (!textarea) {
        box.remove();
        return;
      }
      const metadata = this._nodeMetadata(node);
      const clickPromptState = String(metadata.clickPromptStatus || "");
      const typingText = this._promptTypingTextByNode.get(node.id);
      const isLocalEditor = this._activePromptEditorNodeId() === node.id;
      const remoteDraft = !isLocalEditor ? this._remotePromptDraftForNode(node.id) : null;
      const promptValue = clampPromptText(typingText ?? (remoteDraft != null ? remoteDraft : (node.prompt ?? "")));
      if (textarea.value !== promptValue) textarea.value = promptValue;
      if (!textarea.maxLength || textarea.maxLength !== MAX_PROMPT_LENGTH) textarea.maxLength = MAX_PROMPT_LENGTH;
      const canEdit = this._canEditCollab();
      textarea.readOnly = clickPromptState === "typing" || !canEdit;
      const resizeHandle = box.querySelector(".nodeResizeHandle");
      const outputHandle = box.querySelector(".nodeOutputHandle");
      const generateBtn = box.querySelector(".generateBtn");
      if (resizeHandle) resizeHandle.hidden = !canEdit;
      if (outputHandle) outputHandle.style.pointerEvents = canEdit ? "" : "none";
      const generating = this._nodeGenerationInFlight(node);
      if (generateBtn) {
        // While options are in flight, only the stack "+" queues more — Generate
        // (click or plunger) must stay off so it cannot replace the batch.
        generateBtn.disabled = !canEdit || generating;
        generateBtn.title = generating
          ? "Generating… use + below to add more options"
          : "Generate";
      }
      this._syncPromptResolutionControl(resolutionControl, node);
      this._syncPromptBrandControl(brandControl, node);
      const scale = this._state.viewport.scale || 1;
      const headerHeight = node.selected ? NODE_HEADER_HEIGHT : 16;
      if (title && this._nodeRenameNodeId !== node.id) title.textContent = node.name || "";
      box.dataset.selected = node.selected ? "true" : "false";
      box.dataset.hasImage = this._activeImageForNode(node) ? "true" : "false";
      box.dataset.clickPromptState = clickPromptState;
      const analysisProcessing = this._nodeAnalysisProcessing(node);
      box.dataset.analysisProcessing = analysisProcessing ? "true" : "false";
      box.dataset.generating = generating ? "true" : "false";
      const inpaintGenerating = (this._inpaint?.generating && this._inpaint.sourceNodeId === node.id)
        || metadata.inpaintGenerating === true;
      box.dataset.inpaintGenerating = inpaintGenerating ? "true" : "false";
      const hasInputs = this._nodeHasInputs(node);
      box.dataset.hasInputs = hasInputs ? "true" : "false";
      const inputVisible = this._shouldShowNodeInputConnector(node);
      const outputVisible = this._shouldShowNodeOutputConnector(node) && !analysisProcessing;
      box.dataset.inputVisible = inputVisible ? "true" : "false";
      box.dataset.outputVisible = outputVisible ? "true" : "false";
      const resizeTargetSnap = this._pointer?.mode === "resize-node"
        && this._pointer.nodeId === node.id
        && !!this._pointer.activeResolution;
      box.dataset.resizeTargetSnap = resizeTargetSnap ? "true" : "false";
      box.dataset.altDuplicateHoverTarget =
        this._altDuplicateArmed() &&
        this._hoverNodeId === node.id &&
        this._nodeSupportsAltDuplicate(node.id)
          ? "true"
          : "false";
      box.style.setProperty("--node-header-height", `${headerHeight}px`);
      box.style.setProperty("--node-input-width", "0px");
      box.style.setProperty("--node-input-gap", "10px");
      this._applyPromptBoxGeometry(box, node, scale);
      this._applyPromptBoxViewportPresentation(box, node);
      this._syncNodeImageStack(box, node);
      this._syncNodeGenerationError(box, node);
    });
    layer.querySelectorAll(".promptBox").forEach((box) => {
      if (!seen.has(box.dataset.nodeId)) {
        this._promptSuggestionChoicesByNode.delete(box.dataset.nodeId);
        box.remove();
      }
    });
  }

  _onPromptTextareaInput(nodeId, textarea) {
    const next = clampPromptText(textarea.value);
    // First typed character ends the typewriter and restores the static default.
    // Clearing the field later must not restart the cycle.
    if (String(next || "").trim()) this._stopNextPagePlaceholderCycle(nodeId);
    if (next !== textarea.value) {
      const caret = Math.min(Number(textarea.selectionStart) || 0, next.length);
      textarea.value = next;
      textarea.setSelectionRange(caret, caret);
      this._setStatus(`Prompt is limited to ${MAX_PROMPT_LENGTH.toLocaleString()} characters.`);
    }
    this._patchPromptNodeText(nodeId, next, this._adjustMentionTokensAfterInput(nodeId, textarea));
    this._scheduleCollabPromptFlush();
    this._publishCollabAwareness();
    this._updatePromptMentionMenu(nodeId, textarea);
    const editor = textarea?.closest?.(".promptEditor");
    const suggestions = editor?.querySelector?.("diffui-prompt-suggestions");
    const node = this._state.nodes.find((item) => item.id === nodeId);
    this._syncPromptSuggestions(suggestions, editor, node);
  }

  _onPromptSuggestionSelect(event, nodeId, textarea) {
    event.preventDefault();
    event.stopPropagation();
    const prompt = clampPromptText(String(event.detail?.prompt || "").trim());
    if (!prompt || !textarea) return;
    this._stopNextPagePlaceholderCycle(nodeId);
    textarea.value = prompt;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(prompt.length, prompt.length);
    this._patchPromptNodeText(nodeId, prompt, this._adjustMentionTokensAfterInput(nodeId, textarea));
    this._updatePromptMentionMenu(nodeId, textarea);
    const editor = textarea.closest(".promptEditor");
    const suggestions = editor?.querySelector("diffui-prompt-suggestions");
    const node = this._state.nodes.find((item) => item.id === nodeId);
    this._syncPromptSuggestions(suggestions, editor, node);
  }

  _syncPromptSuggestions(element, editor, node) {
    if (!element || !editor || !node) return;
    if (typeof element.setSuggestions !== "function") {
      element.hidden = true;
      element.dataset.visible = "false";
      editor.dataset.hasSuggestions = "false";
      return;
    }
    const screenWidth = Math.max(0, Number(node.width) || 0) * Math.max(0.001, this._state.viewport.scale || 1);
    const shouldShow = !String(node.prompt || "").trim()
      && screenWidth >= MIN_PROMPT_SUGGESTION_SCREEN_WIDTH
      && !this._activeImageForNode(node)
      && !this._nodeGenerationInFlight(node)
      && String((safeParse(node.metadata_json || node.metadataJson) || {}).clickPromptStatus || "") !== "typing";
    const suggestions = shouldShow ? this._websitePromptSuggestionsForNode(node) : [];
    element.setSuggestions(suggestions);
    editor.dataset.hasSuggestions = suggestions.length ? "true" : "false";
  }

  _websitePromptSuggestionsForNode(node) {
    const metadata = safeParse(node?.metadata_json || node?.metadataJson) || {};
    const suggestions = Array.isArray(metadata.promptSuggestions) ? metadata.promptSuggestions : [];
    const clean = this._normalizePromptSuggestions(suggestions);
    if (clean.length) return clean;
    if (!this._canvasHasPromptText()) return this._randomPromptSuggestionsForNode(node?.id || "", WEBSITE_PROMPT_STARTERS, "starters");
    return [];
  }

  _suggestionsForNewPromptNode() {
    const latest = this._latestCanvasPromptSuggestions();
    if (latest.length) return latest;
    if (!this._canvasHasPromptText()) return shuffledSuggestions(WEBSITE_PROMPT_STARTERS).slice(0, PROMPT_SUGGESTION_COUNT);
    return [];
  }

  _randomPromptSuggestionsForNode(nodeId, suggestions, key) {
    const id = String(nodeId || "");
    const existing = this._promptSuggestionChoicesByNode.get(id);
    if (existing?.key === key) return existing.choices;
    const choices = shuffledSuggestions(suggestions).slice(0, PROMPT_SUGGESTION_COUNT);
    this._promptSuggestionChoicesByNode.set(id, { key, choices });
    return choices;
  }

  _latestCanvasPromptSuggestions() {
    const payload = this._normalizeCanvasMetadata(this._canvasMetadata).promptSuggestions;
    const suggestions = Array.isArray(payload?.suggestions) ? payload.suggestions : [];
    return this._normalizePromptSuggestions(suggestions);
  }

  _normalizePromptSuggestions(suggestions) {
    return (Array.isArray(suggestions) ? suggestions : [])
      .map((item) => ({
        label: String(item?.label || "").trim(),
        prompt: String(item?.prompt || "").trim(),
      }))
      .filter((item) => item.label && item.prompt)
      .slice(0, PROMPT_SUGGESTION_COUNT);
  }

  _canvasHasPromptText() {
    return this._state.nodes.some((node) => node && node.kind !== "image" && String(node.prompt || "").trim());
  }

  _normalizeCanvasMetadata(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const metadata = { ...value };
    const payload = metadata.promptSuggestions;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      delete metadata.promptSuggestions;
      return metadata;
    }
    const suggestions = this._normalizePromptSuggestions(payload.suggestions);
    metadata.promptSuggestions = {
      ...payload,
      suggestions,
    };
    return metadata;
  }

  _onPromptTextareaKeyDown(event, nodeId, textarea) {
    const state = this._promptMentionState;
    if (event.key === "Backspace" && !event.metaKey && !event.ctrlKey && !event.altKey && this._deleteMentionTokenBeforeCaret(nodeId, textarea)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!state || state.nodeId !== nodeId || !state.open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this._closePromptMentionMenus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      this._setPromptMentionActiveIndex(state.activeIndex + delta);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      const item = state.items[state.activeIndex] || state.items[0];
      if (item) this._insertPromptMention(nodeId, textarea, item);
    }
  }

  _onPromptMentionMenuClick(event, nodeId, textarea) {
    const option = event.target.closest(".promptMentionOption");
    if (!option) return;
    event.preventDefault();
    event.stopPropagation();
    const state = this._promptMentionState;
    const item = state?.items?.find((entry) => entry.id === option.dataset.nodeId);
    if (item) this._insertPromptMention(nodeId, textarea, item);
  }

  _capturePromptTextareaBeforeInput(nodeId, textarea) {
    this._promptEditBeforeInput.set(nodeId, {
      value: String(textarea.value || ""),
      selectionStart: Number(textarea.selectionStart) || 0,
      selectionEnd: Number(textarea.selectionEnd) || 0,
      mentions: this._mentionTokensForNode(this._state.nodes.find((node) => node.id === nodeId)),
    });
  }

  _updatePromptMentionMenu(nodeId, textarea) {
    const menu = this._promptMentionMenuForNode(nodeId);
    if (!menu || textarea.readOnly) return;
    const trigger = this._promptMentionTrigger(textarea);
    if (!trigger) {
      this._closePromptMentionMenus();
      return;
    }
    const items = this._mentionableImageNodes(nodeId)
      .filter((item) => item.name.toLowerCase().includes(trigger.query.toLowerCase()));
    if (!items.length) {
      this._closePromptMentionMenus();
      return;
    }
    this._promptMentionState = {
      open: true,
      nodeId,
      start: trigger.start,
      end: trigger.end,
      query: trigger.query,
      items,
      activeIndex: 0,
    };
    this._patchPromptMentionMenu(menu, items, trigger.query);
    this._positionPromptMentionMenu(menu, textarea, trigger);
    menu.hidden = false;
  }

  _promptMentionTrigger(textarea) {
    const end = Number(textarea.selectionStart);
    if (!Number.isFinite(end) || end !== Number(textarea.selectionEnd)) return null;
    const value = String(textarea.value || "");
    const before = value.slice(0, end);
    const at = before.lastIndexOf("@");
    if (at < 0) return null;
    if (at > 0 && !/\s/.test(before[at - 1])) return null;
    const query = before.slice(at + 1);
    if (/[\r\n]/.test(query) || /\s/.test(query)) return null;
    return { start: at, end, query };
  }

  _positionPromptMentionMenu(menu, textarea, trigger) {
    const editor = textarea?.closest?.(".promptEditor");
    if (!menu || !textarea || !editor || !trigger) return;
    const caret = textareaCaretOffset(textarea, trigger.end);
    const editorRect = editor.getBoundingClientRect();
    const textareaRect = textarea.getBoundingClientRect();
    const menuWidth = Math.min(300, Math.max(180, editorRect.width - 20));
    const preferredLeft = textareaRect.left - editorRect.left + caret.left;
    const left = clampNumber(preferredLeft, 10, Math.max(10, editorRect.width - menuWidth - 10));
    const preferredTop = textareaRect.top - editorRect.top + caret.top + caret.height + 8;
    const maxTop = Math.max(10, editorRect.height - 54);
    menu.style.width = `${menuWidth}px`;
    menu.style.setProperty("--mention-menu-left", `${Math.round(left)}px`);
    menu.style.setProperty("--mention-menu-top", `${Math.round(Math.min(preferredTop, maxTop))}px`);
  }

  _mentionableImageNodes(currentNodeId = "") {
    const inputIds = this._connectedInputNodeIdsForNode(currentNodeId);
    return inputIds
      .map((id) => this._state.nodes.find((node) => node.id === id))
      .filter((node) => node && this._activeImageForNode(node))
      .map((node, index) => ({
        id: node.id,
        name: this._mentionNameForNode(node, index),
      }))
      .filter((item) => item.name);
  }

  _connectedInputNodeIdsForNode(nodeId) {
    nodeId = String(nodeId || "").trim();
    if (!nodeId) return [];
    const ids = [];
    const seen = new Set();
    this._state.edges.forEach((edge) => {
      if (edge.to_node_id !== nodeId && edge.toNodeId !== nodeId) return;
      if (edge.kind && edge.kind !== "prompt_input") return;
      const sourceId = String(edge.from_node_id || edge.fromNodeId || "").trim();
      if (!sourceId || seen.has(sourceId)) return;
      seen.add(sourceId);
      ids.push(sourceId);
    });
    return ids;
  }

  _mentionNameForNode(node, index = 0) {
    const raw = String(node?.name || "").trim();
    return raw || `Image ${index + 1}`;
  }

  _patchPromptMentionMenu(menu, items, query = "") {
    const wanted = new Set(items.map((item) => item.id));
    Array.from(menu.querySelectorAll(".promptMentionOption")).forEach((button) => {
      if (!wanted.has(button.dataset.nodeId || "")) button.remove();
    });
    items.forEach((item, index) => {
      let button = menu.querySelector(`[data-node-id="${CSS.escape(item.id)}"]`);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "promptMentionOption";
        button.setAttribute("role", "option");
        const label = document.createElement("span");
        label.className = "promptMentionOptionName";
        button.appendChild(label);
      }
      button.dataset.nodeId = item.id;
      button.dataset.index = String(index);
      button.dataset.active = index === 0 ? "true" : "false";
      button.setAttribute("aria-selected", index === 0 ? "true" : "false");
      const label = button.querySelector(".promptMentionOptionName");
      if (label) this._patchPromptMentionLabel(label, item.name, query);
      if (menu.children[index] !== button) menu.insertBefore(button, menu.children[index] || null);
    });
  }

  _patchPromptMentionLabel(label, name, query = "") {
    const match = this._mentionNameMatch(name, query);
    if (!match) {
      if (label.textContent !== name) label.textContent = name;
      return;
    }
    const before = name.slice(0, match.start);
    const hit = name.slice(match.start, match.end);
    const after = name.slice(match.end);
    const current = Array.from(label.childNodes).map((node) => node.textContent || "").join("");
    if (current === name && label.querySelector("strong")?.textContent === hit) return;
    label.replaceChildren();
    if (before) label.appendChild(document.createTextNode(before));
    const strong = document.createElement("strong");
    strong.textContent = hit;
    label.appendChild(strong);
    if (after) label.appendChild(document.createTextNode(after));
  }

  _mentionNameMatch(name, query = "") {
    name = String(name || "");
    query = String(query || "");
    if (!query) return null;
    const start = name.toLowerCase().indexOf(query.toLowerCase());
    if (start < 0) return null;
    return { start, end: start + query.length };
  }

  _setPromptMentionActiveIndex(index) {
    const state = this._promptMentionState;
    if (!state?.open || !state.items.length) return;
    const count = state.items.length;
    state.activeIndex = (index + count) % count;
    const menu = this._promptMentionMenuForNode(state.nodeId);
    if (!menu) return;
    Array.from(menu.querySelectorAll(".promptMentionOption")).forEach((button) => {
      const active = Number(button.dataset.index) === state.activeIndex;
      button.dataset.active = active ? "true" : "false";
      button.setAttribute("aria-selected", active ? "true" : "false");
      if (active) button.scrollIntoView({ block: "nearest" });
    });
  }

  _insertPromptMention(nodeId, textarea, item) {
    const state = this._promptMentionState;
    if (!state || state.nodeId !== nodeId) return;
    const value = String(textarea.value || "");
    const insert = `@${item.name} `;
    const next = clampPromptText(`${value.slice(0, state.start)}${insert}${value.slice(state.end)}`);
    textarea.value = next;
    const caret = Math.min(state.start + insert.length, next.length);
    textarea.setSelectionRange(caret, caret);
    const token = {
      nodeId: item.id,
      label: item.name,
      start: state.start,
      end: state.start + insert.length - 1,
    };
    const shifted = this._mentionTokensForNode(this._state.nodes.find((node) => node.id === nodeId))
      .filter((mention) => mention.end <= state.start || mention.start >= state.end)
      .map((mention) => mention.start >= state.end ? { ...mention, start: mention.start + insert.length - (state.end - state.start), end: mention.end + insert.length - (state.end - state.start) } : mention);
    this._patchPromptNodeText(nodeId, next, [...shifted, token]);
    this._closePromptMentionMenus();
    textarea.focus();
  }

  _promptMentionMenuForNode(nodeId) {
    return this.shadowRoot
      .getElementById("promptLayer")
      ?.querySelector(`[data-node-id="${CSS.escape(nodeId)}"] .promptMentionMenu`) || null;
  }

  _patchPromptNodeText(nodeId, prompt, mentions = null) {
    const node = this._state.nodes.find((item) => item.id === nodeId);
    const metadata = safeParse(node?.metadata_json || node?.metadataJson) || {};
    const nextPrompt = clampPromptText(prompt);
    const nextMentions = Array.isArray(mentions) ? this._normalizeMentionTokens(mentions, nextPrompt) : this._mentionTokensForNode(node, nextPrompt);
    const cleanPrompt = String(nextPrompt || "").trim();
    this._patchNode(nodeId, {
      prompt: nextPrompt,
      metadataJson: JSON.stringify({
        ...metadata,
        mentions: nextMentions,
        ...(cleanPrompt ? { promptUpdatedAt: Date.now() } : {}),
      }),
    }, { quiet: true });
  }

  _mentionTokensForNode(node, prompt = null) {
    const metadata = safeParse(node?.metadata_json || node?.metadataJson) || {};
    return this._normalizeMentionTokens(metadata.mentions, prompt ?? node?.prompt ?? "");
  }

  _normalizeMentionTokens(mentions, prompt = "") {
    const text = String(prompt || "");
    if (!Array.isArray(mentions)) return [];
    return mentions
      .map((mention) => ({
        nodeId: String(mention?.nodeId || "").trim(),
        label: String(mention?.label || "").trim(),
        start: Math.max(0, Math.round(Number(mention?.start) || 0)),
        end: Math.max(0, Math.round(Number(mention?.end) || 0)),
      }))
      .filter((mention) => {
        if (!mention.nodeId || !mention.label || mention.end < mention.start) return false;
        return text.slice(mention.start, mention.end) === `@${mention.label}`;
      })
      .sort((a, b) => a.start - b.start);
  }

  _adjustMentionTokensAfterInput(nodeId, textarea) {
    const before = this._promptEditBeforeInput.get(nodeId);
    this._promptEditBeforeInput.delete(nodeId);
    const node = this._state.nodes.find((item) => item.id === nodeId);
    const currentText = String(textarea.value || "");
    if (!before) return this._mentionTokensForNode(node, currentText);
    const oldText = String(before.value || "");
    const replacedStart = Math.min(before.selectionStart, before.selectionEnd);
    const replacedEnd = Math.max(before.selectionStart, before.selectionEnd);
    const delta = currentText.length - oldText.length;
    return (Array.isArray(before.mentions) ? before.mentions : [])
      .map((mention) => {
        if (replacedEnd <= mention.start) {
          return { ...mention, start: mention.start + delta, end: mention.end + delta };
        }
        if (replacedStart >= mention.end) return mention;
        return null;
      })
      .filter(Boolean);
  }

  _deleteMentionTokenBeforeCaret(nodeId, textarea) {
    if (textarea.selectionStart !== textarea.selectionEnd) return false;
    const caret = Number(textarea.selectionStart) || 0;
    const node = this._state.nodes.find((item) => item.id === nodeId);
    const mentions = this._mentionTokensForNode(node, textarea.value);
    const value = String(textarea.value || "");
    const mention = mentions.find((token) => token.end === caret || (token.end + 1 === caret && value[token.end] === " "));
    if (!mention) return false;
    const deleteEnd = mention.end + (value[mention.end] === " " ? 1 : 0);
    const next = `${value.slice(0, mention.start)}${value.slice(deleteEnd)}`;
    const removed = deleteEnd - mention.start;
    const nextMentions = mentions
      .filter((token) => token !== mention)
      .map((token) => token.start >= deleteEnd ? { ...token, start: token.start - removed, end: token.end - removed } : token);
    textarea.value = next;
    textarea.setSelectionRange(mention.start, mention.start);
    this._patchPromptNodeText(nodeId, next, nextMentions);
    this._closePromptMentionMenus();
    return true;
  }

  _closePromptMentionMenus(event = null) {
    const path = event?.composedPath?.() || [];
    let keptOpen = false;
    this.shadowRoot.querySelectorAll(".promptMentionMenu").forEach((menu) => {
      if (path.includes(menu)) {
        keptOpen = true;
        return;
      }
      menu.hidden = true;
    });
    if (!keptOpen) this._promptMentionState = null;
  }

  _createPromptResolutionControl(nodeId) {
    const control = document.createElement("div");
    control.className = "promptResolutionControl";
    control.dataset.nodeId = nodeId;
    control.dataset.open = "false";
    control.dataset.custom = "false";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "promptResolutionButton";
    button.setAttribute("aria-label", "Prompt resolution");
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    const buttonSize = document.createElement("span");
    buttonSize.className = "promptResolutionButtonSize";
    button.appendChild(buttonSize);

    const menu = document.createElement("div");
    menu.className = "promptResolutionMenu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;

    const appendResolutionOption = (group, entry) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "promptResolutionOption";
      option.dataset.value = promptResolutionValue(entry.width, entry.height);
      option.setAttribute("role", "option");
      const name = this._promptResolutionSpan("promptResolutionName", entry.label);
      if (entry.aspect) {
        name.appendChild(this._promptResolutionSpan("promptResolutionAspect", ` (${entry.aspect})`));
      }
      option.append(
        this._promptResolutionIcon(entry.icon, "promptResolutionIcon"),
        name,
        this._promptResolutionSpan("promptResolutionSize", promptResolutionText(entry.width, entry.height)),
        this._promptResolutionCheckmark(),
      );
      option.addEventListener("click", () => this._onPromptResolutionChange(nodeId, option.dataset.value));
      group.appendChild(option);
    };

    PROMPT_RESOLUTION_GROUPS.forEach((columnData) => {
      const column = document.createElement("div");
      column.className = "promptResolutionColumn";
      column.dataset.heading = columnData.heading;
      const sections = Array.isArray(columnData.sections)
        ? columnData.sections
        : [{ heading: columnData.heading, icon: columnData.icon, options: columnData.options }];
      sections.forEach((section) => {
        const group = document.createElement("div");
        group.className = "promptResolutionGroup";
        if (section.heading) {
          const heading = document.createElement("div");
          heading.className = "promptResolutionHeading";
          heading.append(
            this._promptResolutionIcon(section.icon || columnData.icon, "promptResolutionHeadingIcon"),
            document.createTextNode(section.heading),
          );
          group.appendChild(heading);
        }
        (section.options || []).forEach((entry) => appendResolutionOption(group, entry));
        column.appendChild(group);
      });
      if (columnData.custom) {
        const customRow = document.createElement("div");
        customRow.className = "promptResolutionCustomRow";
        const customButton = document.createElement("button");
        customButton.type = "button";
        customButton.className = "promptResolutionCustomTrigger";
        customButton.append(
          this._promptResolutionIcon("custom-size", "promptResolutionIcon"),
          this._promptResolutionSpan("promptResolutionName", "Custom size"),
          this._promptResolutionSpan("promptResolutionSize", ""),
          this._promptResolutionSpan("promptResolutionMark", ""),
        );
        customButton.addEventListener("click", () => this._showPromptResolutionCustomInputs(control));
        customRow.appendChild(customButton);
        column.appendChild(customRow);
      }
      menu.appendChild(column);
    });

    const custom = document.createElement("div");
    custom.className = "promptResolutionCustom";
    custom.hidden = true;
    const widthInput = document.createElement("input");
    widthInput.type = "number";
    widthInput.min = "480";
    widthInput.step = "16";
    widthInput.inputMode = "numeric";
    widthInput.setAttribute("aria-label", "Custom width");
    const divider = document.createElement("span");
    divider.textContent = "x";
    const heightInput = document.createElement("input");
    heightInput.type = "number";
    heightInput.min = "480";
    heightInput.step = "16";
    heightInput.inputMode = "numeric";
    heightInput.setAttribute("aria-label", "Custom height");
    custom.append(widthInput, divider, heightInput);

    control.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", () => this._togglePromptResolutionMenu(control));
    widthInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        heightInput.focus();
      } else if (event.key === "Escape") {
        this._cancelPromptResolutionCustomInputs(control);
      }
    });
    heightInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this._commitPromptResolutionCustomInputs(control);
      } else if (event.key === "Escape") {
        this._cancelPromptResolutionCustomInputs(control);
      }
    });
    heightInput.addEventListener("blur", () => this._commitPromptResolutionCustomInputs(control));

    control.append(button, menu, custom);
    return control;
  }

  _createPromptBrandControl(nodeId = "") {
    const control = document.createElement("div");
    control.className = "promptBrandControl";
    control.dataset.open = "false";
    control.dataset.nodeId = nodeId || "";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "promptBrandButton";
    button.setAttribute("aria-label", "Brand");
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    const logo = document.createElement("span");
    logo.className = "promptBrandLogo";
    const name = document.createElement("span");
    name.className = "promptBrandName";
    button.append(logo, name);

    const menu = document.createElement("div");
    menu.className = "promptBrandMenu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;

    control.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", () => this._togglePromptBrandMenu(control));
    control.append(button, menu);
    this._syncPromptBrandControl(control);
    return control;
  }

  _syncPromptBrandControl(control, node = null) {
    if (!control) return;
    if (node?.id && control.dataset.nodeId !== node.id) control.dataset.nodeId = node.id;
    const brands = Array.isArray(this._brands) ? this._brands : [];
    control.dataset.visible = "true";
    const wanted = new Set(["", PROMPT_BRAND_RANDOMIZE, ...brands.map((brand) => String(brand.id || ""))]);
    const menu = control.querySelector(".promptBrandMenu");
    for (const option of [...(menu?.querySelectorAll(".promptBrandOption") || [])]) {
      if (!wanted.has(option.dataset.value || "")) option.remove();
    }
    let none = menu?.querySelector('.promptBrandOption[data-value=""]');
    if (!none) {
      none = this._createPromptBrandOption("", "No brand", "");
      menu?.insertBefore(none, menu.firstChild || null);
    }
    this._patchPromptBrandOption(none, { id: "", name: "No brand", logo_url: "" });
    let randomize = menu?.querySelector(`.promptBrandOption[data-value="${PROMPT_BRAND_RANDOMIZE}"]`);
    if (!randomize) {
      randomize = this._createPromptBrandRandomizeOption();
    }
    if (menu && menu.children[1] !== randomize) menu.insertBefore(randomize, menu.children[1] || null);
    brands.forEach((brand, index) => {
      const value = String(brand.id || "");
      if (!value) return;
      let option = menu?.querySelector(`.promptBrandOption[data-value="${CSS.escape(value)}"]`);
      if (!option) {
        option = this._createPromptBrandOption(value, String(brand.name || "Brand").trim(), String(brand.logo_url || brand.logoUrl || ""));
        menu?.appendChild(option);
      }
      this._patchPromptBrandOption(option, brand);
      const desired = index + 2;
      if (menu?.children[desired] !== option) menu?.insertBefore(option, menu.children[desired] || null);
    });
    const selectedID = this._promptBrandIdForNode(node || this._state.nodes.find((item) => item.id === control.dataset.nodeId));
    const selectedBrand = brands.find((brand) => String(brand.id || "") === selectedID) || null;
    this._patchPromptBrandButton(control, selectedBrand, selectedID);
    control.querySelectorAll(".promptBrandOption").forEach((option) => {
      const selected = (option.dataset.value || "") === selectedID;
      option.dataset.selected = selected ? "true" : "false";
      option.setAttribute("aria-selected", selected ? "true" : "false");
    });
  }

  _createPromptBrandOption(value, label, logoURL) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "promptBrandOption";
    option.dataset.value = value;
    option.setAttribute("role", "option");
    option.append(
      this._promptBrandLogoElement(logoURL),
      this._promptResolutionSpan("promptResolutionName", label || "Brand"),
      this._promptResolutionCheckmark(),
    );
    option.addEventListener("click", (event) => this._onPromptBrandChange(event.currentTarget?.closest(".promptBrandControl"), value));
    return option;
  }

  _createPromptBrandRandomizeOption() {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "promptBrandOption";
    option.dataset.value = PROMPT_BRAND_RANDOMIZE;
    option.dataset.hasLogo = "true";
    option.setAttribute("role", "option");
    const logo = document.createElement("span");
    logo.className = "promptBrandLogo";
    logo.dataset.empty = "false";
    logo.dataset.icon = "randomize";
    logo.innerHTML = PROMPT_BRAND_RANDOMIZE_ICON_SVG;
    option.append(
      logo,
      this._promptResolutionSpan("promptResolutionName", "Randomize style"),
      this._promptResolutionCheckmark(),
    );
    option.addEventListener("click", (event) => this._onPromptBrandChange(event.currentTarget?.closest(".promptBrandControl"), PROMPT_BRAND_RANDOMIZE));
    return option;
  }

  _patchPromptBrandOption(option, brand) {
    if (!option) return;
    const label = String(brand?.name || "Brand").trim() || "Brand";
    const name = option.querySelector(".promptResolutionName");
    if (name && name.textContent !== label) name.textContent = label;
    const logoURL = String(brand?.logo_url || brand?.logoUrl || "");
    option.dataset.hasLogo = logoURL.trim() ? "true" : "false";
    this._patchPromptBrandLogo(option.querySelector(".promptBrandLogo"), logoURL);
  }

  _patchPromptBrandButton(control, brand, selectedID = "") {
    const randomize = selectedID === PROMPT_BRAND_RANDOMIZE;
    const label = randomize ? "Randomize style" : brand ? String(brand.name || "Brand").trim() || "Brand" : "No brand";
    const name = control.querySelector(".promptBrandName");
    if (name && name.textContent !== label) name.textContent = label;
    const logo = control.querySelector(".promptBrandLogo");
    if (randomize) {
      if (!logo) return;
      logo.dataset.empty = "false";
      if (logo.dataset.icon !== "randomize") {
        logo.dataset.icon = "randomize";
        logo.innerHTML = PROMPT_BRAND_RANDOMIZE_ICON_SVG;
      }
      return;
    }
    if (logo && logo.dataset.icon === "randomize") {
      delete logo.dataset.icon;
      logo.replaceChildren();
    }
    this._patchPromptBrandLogo(logo, brand ? String(brand.logo_url || brand.logoUrl || "") : "");
  }

  _promptBrandLogoElement(logoURL) {
    const logo = document.createElement("span");
    logo.className = "promptBrandLogo";
    this._patchPromptBrandLogo(logo, logoURL);
    return logo;
  }

  _patchPromptBrandLogo(container, logoURL) {
    if (!container) return;
    const url = resolveEmbedAssetUrl(String(logoURL || "").trim());
    if (!url) {
      container.dataset.empty = "true";
      const img = container.querySelector("img");
      if (img) img.remove();
      if (container.textContent) container.textContent = "";
      return;
    }
    container.dataset.empty = "false";
    let img = container.querySelector("img");
    if (!img) {
      container.replaceChildren();
      img = document.createElement("img");
      img.alt = "";
      container.appendChild(img);
    }
    if (img.getAttribute("src") !== url) img.src = url;
  }

  _togglePromptBrandMenu(control) {
    const willOpen = control.dataset.open !== "true";
    this._closePromptResolutionDropdowns();
    this._setPromptBrandMenuOpen(control, willOpen);
  }

  _setPromptBrandMenuOpen(control, open) {
    control.dataset.open = open ? "true" : "false";
    const button = control.querySelector(".promptBrandButton");
    const menu = control.querySelector(".promptBrandMenu");
    if (button) button.setAttribute("aria-expanded", open ? "true" : "false");
    if (menu) menu.hidden = !open;
  }

  _onPromptBrandChange(control, value) {
    const nodeId = String(control?.dataset?.nodeId || "").trim();
    const node = nodeId ? this._state.nodes.find((item) => item.id === nodeId) : null;
    if (!node) return;
    this._setPromptBrandIdForNode(node, value);
    this._closePromptResolutionDropdowns();
    this._syncPromptBrandControl(control, this._state.nodes.find((item) => item.id === nodeId) || node);
  }

  _promptBrandIdForNode(node) {
    const metadata = safeParse(node?.metadata_json || node?.metadataJson) || {};
    const id = String(metadata.promptBrandId || metadata.brand_id || "").trim();
    if (!id) return "";
    if (id === PROMPT_BRAND_RANDOMIZE) return id;
    const brands = Array.isArray(this._brands) ? this._brands : [];
    return brands.some((brand) => String(brand.id || "") === id) ? id : "";
  }

  _promptNodeCount() {
    return (Array.isArray(this._state.nodes) ? this._state.nodes : []).filter((node) => node && node.kind !== "image").length;
  }

  _isSoloPromptCanvas() {
    return this._promptNodeCount() === 1;
  }

  _setPromptBrandIdForNode(node, value) {
    const brandId = String(value || "").trim();
    const metadata = safeParse(node?.metadata_json || node?.metadataJson) || {};
    const nextMetadata = { ...metadata };
    delete nextMetadata.brand_id;
    if (brandId) nextMetadata.promptBrandId = brandId;
    else delete nextMetadata.promptBrandId;
    this._patchNode(node.id, { metadataJson: JSON.stringify(nextMetadata) }, { quiet: true });
  }

  _promptResolutionSpan(className, text) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    return span;
  }

  _promptResolutionIcon(icon, className) {
    const span = document.createElement("span");
    span.className = className;
    span.dataset.icon = icon || "";
    span.innerHTML = promptResolutionIconSVG(icon);
    return span;
  }

  _promptResolutionCheckmark() {
    const span = document.createElement("span");
    span.className = "promptResolutionMark";
    span.innerHTML = '<svg width="9" height="7" viewBox="0 0 9 7" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M0.353553 3.35355L2.85355 5.85355L8.35355 0.353546" stroke="black"/></svg>';
    return span;
  }

  _syncPromptResolutionControl(control, node) {
    if (!control || control.dataset.custom === "true") return;
    const value = promptResolutionValue(node.width, node.height);
    const buttonSize = control.querySelector(".promptResolutionButtonSize");
    if (buttonSize) buttonSize.textContent = promptResolutionText(node.width, node.height);
    let hasPresetMatch = false;
    control.querySelectorAll(".promptResolutionOption").forEach((option) => {
      const selected = option.dataset.value === value;
      if (selected) hasPresetMatch = true;
      option.dataset.selected = selected ? "true" : "false";
      option.setAttribute("aria-selected", selected ? "true" : "false");
    });
    const customTrigger = control.querySelector(".promptResolutionCustomTrigger");
    if (customTrigger) {
      customTrigger.dataset.selected = hasPresetMatch ? "false" : "true";
      const mark = customTrigger.querySelector(".promptResolutionMark");
      if (mark) mark.replaceChildren(...(hasPresetMatch ? [] : [this._promptResolutionCheckmark().firstElementChild.cloneNode(true)]));
      customTrigger.querySelector(".promptResolutionSize").textContent = hasPresetMatch ? "" : promptResolutionText(node.width, node.height);
    }
  }

  _togglePromptResolutionMenu(control) {
    const willOpen = control.dataset.open !== "true";
    this._closePromptResolutionDropdowns();
    this._setPromptResolutionMenuOpen(control, willOpen);
  }

  _setPromptResolutionMenuOpen(control, open) {
    control.dataset.open = open ? "true" : "false";
    const button = control.querySelector(".promptResolutionButton");
    const menu = control.querySelector(".promptResolutionMenu");
    if (button) button.setAttribute("aria-expanded", open ? "true" : "false");
    if (menu) {
      menu.hidden = !open;
      if (open) this._positionPromptResolutionMenu(control, menu);
    }
  }

  _positionPromptResolutionMenu(control, menu) {
    const promptBox = control.closest(".promptBox");
    if (!promptBox) {
      menu.style.left = "0px";
      return;
    }
    const controlRect = control.getBoundingClientRect();
    const promptRect = promptBox.getBoundingClientRect();
    const menuWidth = menu.getBoundingClientRect().width || 882;
    const left = menuWidth <= promptRect.width
      ? promptRect.left - controlRect.left
      : promptRect.left + (promptRect.width - menuWidth) / 2 - controlRect.left;
    menu.style.left = `${Math.round(left)}px`;
  }

  _closePromptResolutionDropdowns(event = null) {
    const path = event?.composedPath?.() || [];
    this.shadowRoot.querySelectorAll('.promptResolutionControl[data-open="true"]').forEach((control) => {
      if (path.includes(control)) return;
      this._setPromptResolutionMenuOpen(control, false);
    });
    this.shadowRoot.querySelectorAll('.promptBrandControl[data-open="true"]').forEach((control) => {
      if (path.includes(control)) return;
      this._setPromptBrandMenuOpen(control, false);
    });
  }

  _showPromptResolutionCustomInputs(control) {
    const node = this._state.nodes.find((item) => item.id === control.dataset.nodeId);
    if (!node) return;
    this._setPromptResolutionMenuOpen(control, false);
    control.dataset.custom = "true";
    const custom = control.querySelector(".promptResolutionCustom");
    const inputs = custom?.querySelectorAll("input") || [];
    if (inputs[0]) inputs[0].value = String(Math.round(node.width));
    if (inputs[1]) inputs[1].value = String(Math.round(node.height));
    if (custom) custom.hidden = false;
    inputs[0]?.focus();
    inputs[0]?.select();
  }

  _cancelPromptResolutionCustomInputs(control) {
    control.dataset.custom = "false";
    const custom = control.querySelector(".promptResolutionCustom");
    if (custom) custom.hidden = true;
    const node = this._state.nodes.find((item) => item.id === control.dataset.nodeId);
    if (node) this._syncPromptResolutionControl(control, node);
  }

  _commitPromptResolutionCustomInputs(control) {
    if (control.dataset.custom !== "true") return;
    const inputs = control.querySelectorAll(".promptResolutionCustom input");
    const width = Number(inputs[0]?.value);
    const height = Number(inputs[1]?.value);
    const node = this._state.nodes.find((item) => item.id === control.dataset.nodeId);
    if (!node) return;
    const size = constrainPromptDimensions(
      Number.isFinite(width) && width > 0 ? width : node.width,
      Number.isFinite(height) && height > 0 ? height : node.height,
    );
    this._cancelPromptResolutionCustomInputs(control);
    this._patchNode(node.id, size, { quiet: true });
    this._syncToolbar();
    this._syncPromptOverlays();
    this._draw();
  }

  _onPromptResolutionChange(nodeId, value) {
    const preset = promptResolutionPresetForValue(value);
    if (!preset) return;
    this._closePromptResolutionDropdowns();
    this._patchNode(nodeId, { width: preset.width, height: preset.height }, { quiet: true });
    this._syncToolbar();
    this._syncPromptOverlays();
    this._draw();
  }

  _createNodeErrorPanel(nodeId) {
    const panel = document.createElement("div");
    panel.className = "nodeError";
    panel.hidden = true;
    panel.setAttribute("role", "status");
    const icon = document.createElement("span");
    icon.className = "nodeErrorIcon";
    icon.appendChild(featherIcon("alert-triangle"));
    const text = document.createElement("span");
    text.className = "nodeErrorText";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "nodeErrorRetry";
    retry.textContent = "Retry";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "nodeErrorDismiss";
    dismiss.textContent = "Dismiss";
    panel.append(icon, text, retry, dismiss);
    panel.addEventListener("pointerdown", (event) => event.stopPropagation());
    retry.addEventListener("click", (event) => {
      event.stopPropagation();
      this._retryFailedNodeGeneration(nodeId);
    });
    dismiss.addEventListener("click", (event) => {
      event.stopPropagation();
      this._clearNodeGenerationError(nodeId);
    });
    return panel;
  }

  _nodeGenerationError(node) {
    const error = (safeParse(node?.metadata_json || node?.metadataJson) || {}).generationError;
    if (!error || typeof error !== "object") return null;
    return {
      code: String(error.code || "generation_failed"),
      message: String(error.message || "Generation failed."),
      count: Math.max(1, Math.round(Number(error.count) || 1)),
    };
  }

  _syncNodeGenerationError(box, node) {
    const panel = box.querySelector(".nodeError");
    if (!panel) return;
    const error = this._nodeGenerationError(node);
    panel.hidden = !error;
    box.dataset.generationError = error ? "true" : "false";
    if (!error) return;
    const text = panel.querySelector(".nodeErrorText");
    if (text && text.textContent !== error.message) text.textContent = error.message;
    panel.dataset.code = error.code;
    const retry = panel.querySelector(".nodeErrorRetry");
    if (retry) retry.disabled = !this._canEditCollab();
  }

  _clearNodeGenerationError(nodeId) {
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const metadata = safeParse(node.metadata_json || node.metadataJson) || {};
    if (!metadata.generationError) return;
    delete metadata.generationError;
    this._patchNode(nodeId, { metadataJson: JSON.stringify(metadata) }, { quiet: true });
    this._syncPromptOverlays();
    this._draw();
  }

  /** Re-queue the options the failed run never produced (the wallet clamp still applies). */
  _retryFailedNodeGeneration(nodeId) {
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node || !this._canEditCollab()) return;
    const error = this._nodeGenerationError(node);
    this._clearNodeGenerationError(nodeId);
    const latest = this._state.nodes.find((item) => item.id === nodeId) || node;
    this._requestNodeImageGeneration(latest, {
      replace: false,
      count: error?.count || 1,
      source: "generation-error-retry",
    }).catch((requestError) => {
      this._setStatus(requestError.message || "Generation failed");
    });
  }

  _syncNodeImageStack(box, node) {
    const editor = box.querySelector(".promptEditor");
    const stack = box.querySelector(".nodeStack");
    const loading = box.querySelector(".nodeLoading");
    const stackBar = box.querySelector(".nodeStackBar");
    if (!editor || !stack || !loading || !stackBar) return;
    const readyImages = this._displayableImagesForNode(node);
    const hasReadyImage = readyImages.length > 0;
    const metadata = safeParse(node.metadata_json) || {};
    const clickPromptState = String(metadata.clickPromptStatus || "");
    const isThinking = clickPromptState === "detecting";
    const stackHadFrames = !!stack.querySelector(".stackFrame");
    const isPromptReplaceTransition = !stackHadFrames
      && readyImages.length === 1
      && this._partialOrderForImage(readyImages[0]) === 1;
    editor.hidden = (hasReadyImage && !isPromptReplaceTransition) || isThinking;
    stack.hidden = !hasReadyImage;
    loading.textContent = isThinking ? "Thinking..." : "Generating...";
    loading.hidden = hasReadyImage || (!isThinking && !this._nodeImages(node).some((image) => image.status === "loading"));
    this._syncNodeStackBar(stackBar, node, readyImages);
    if (!hasReadyImage) {
      stack.replaceChildren();
      return;
    }
    const activeIndex = this._activeImageIndex(node, readyImages);
    if (!this._stackScrollDirectionByNode.has(node.id)) {
      const previousIndex = this._lastStackIndexByNode.get(node.id);
      if (previousIndex !== undefined && previousIndex !== activeIndex) {
        const inferred = this._stackSwitchDirection(previousIndex, activeIndex, readyImages.length);
        if (inferred) this._stackScrollDirectionByNode.set(node.id, inferred);
      }
    }
    const activeImage = readyImages[activeIndex];
    const activeImageId = String(activeImage?.id || activeImage?.image_id || activeImage?.image_url || activeImage?.imageUrl || "");
    const stackSwitching = this._stackScrollDirectionByNode.has(node.id);
    const stackSwitchDirection = this._stackScrollDirectionByNode.get(node.id) || 0;
    const visible = this._assignStackFrameKeys(node.id, stack, this._stackVisibleImages(readyImages, activeIndex, node.id));
    stack.dataset.depth = String(Math.min(visible.length, 3));
    const visibleIds = new Set(visible.map((entry) => entry.key));
    Array.from(stack.querySelectorAll(".stackFrame")).forEach((frame) => {
      if (!visibleIds.has(frame.dataset.stackKey)) frame.remove();
    });
    visible.forEach(({ image, layer, key }) => {
      const imageId = image.id || image.image_id || image.image_url || image.imageUrl;
      const url = displayUrlForGenerationFileUrl(image.image_url || image.imageUrl || "");
      const metadata = this._imageMetadata(image);
      const analysisStatus = String(metadata.analysisStatus || metadata.analysis_status || "");
      const isProcessing = image.status === "loading";
      const isLoading = !String(url || "").trim() || isProcessing;
      const isPartial = isProcessing && !!String(url || "").trim() && metadata.partial === true;
      const processingState = isProcessing ? (url ? "processing-available" : "processing-unavailable") : "ready";
      let frame = stack.querySelector(`[data-stack-key="${CSS.escape(key)}"]`);
      const isNewFrame = !frame;
      if (!frame) {
        frame = document.createElement("div");
        frame.className = "stackFrame";
        frame.dataset.imageId = imageId;
        frame.dataset.stackKey = key;
        const media = document.createElement("div");
        media.className = "stackFrameMedia";
        const finalImg = document.createElement("img");
        finalImg.className = "stackFrameLayer stackFrameFinal";
        finalImg.alt = "";
        media.append(finalImg);
        const spinner = document.createElement("div");
        spinner.className = "analysisSpinner";
        spinner.hidden = true;
        const inpaintTreatment = document.createElement("div");
        inpaintTreatment.className = "inpaintProgressTreatment";
        const inpaintMask = document.createElement("div");
        inpaintMask.className = "inpaintProgressMask";
        frame.append(media, inpaintTreatment, inpaintMask, spinner);
        stack.appendChild(frame);
      }
      const { partialImg, finalImg } = this._ensureStackFrameLayers(frame);
      const spinner = frame.querySelector(".analysisSpinner");
      const inpaintTreatment = frame.querySelector(".inpaintProgressTreatment");
      const inpaintMask = frame.querySelector(".inpaintProgressMask");
      const nextUrlAbs = url ? new URL(url, window.location.href).href : "";
      const partialUrlAbs = partialImg?.src || "";
      const finalUrlAbs = finalImg.src || "";
      const partialSrcWillChange = !!nextUrlAbs && partialUrlAbs !== nextUrlAbs;
      const finalSrcWillChange = !!nextUrlAbs && finalUrlAbs !== nextUrlAbs;
      const partialRevealState = frame.dataset.partialReveal || "";
      const partialRevealPending = partialRevealState === "pending";
      const partialRevealActive = partialRevealState === "active";
      const hasLoadedPartial = this._stackFrameHasLoadedPartial(frame);
      const shouldRevealFinal = !isPartial && !partialRevealPending && !partialRevealActive && finalSrcWillChange;
      const shouldAnimatePartialReveal = shouldRevealFinal && hasLoadedPartial;
      const skipSrcUpdate = stackSwitching && !isNewFrame
        && String(frame.dataset.imageId || "") === String(imageId);
      frame.dataset.imageId = imageId;
      frame.dataset.loading = isLoading ? "true" : "false";
      frame.dataset.processingState = processingState;
      frame.dataset.activeStack = String(imageId) === activeImageId ? "true" : "false";
      if (skipSrcUpdate) {
        // Keep the existing bitmap while layers animate; src changes read as a hard cut.
      } else if (!url) {
        this._removeStackFramePartial(frame);
        finalImg.removeAttribute("src");
        delete frame.dataset.partial;
        delete frame.dataset.partialReveal;
        this._cancelStackFramePartialReveal(frame);
      } else if (isPartial) {
        this._cancelStackFramePartialReveal(frame);
        delete frame.dataset.partialReveal;
        frame.dataset.partial = "true";
        const partialEl = this._ensureStackFramePartial(frame);
        if (partialSrcWillChange) {
          delete frame.dataset.partialReady;
          partialEl.src = nextUrlAbs;
          this._bindStackFramePartialImg(frame, partialEl);
        }
        finalImg.removeAttribute("src");
      } else if (shouldAnimatePartialReveal) {
        frame.dataset.partialReveal = "pending";
        frame.dataset.partial = "true";
        if (finalSrcWillChange) finalImg.src = nextUrlAbs;
        this._startStackFramePartialReveal(frame, { partialImg, finalImg, stackKey: key, expectedUrl: nextUrlAbs });
      } else if (shouldRevealFinal) {
        this._snapStackFrameFinal(frame, { finalImg, stackKey: key, expectedUrl: nextUrlAbs });
      } else if (partialRevealPending) {
        frame.dataset.partial = hasLoadedPartial ? "true" : "false";
        if (finalSrcWillChange) finalImg.src = nextUrlAbs;
        if (!hasLoadedPartial) this._snapStackFrameFinal(frame, { finalImg, stackKey: key, expectedUrl: nextUrlAbs });
      } else if (partialRevealActive) {
        // crossfade in progress
      } else {
        this._cancelStackFramePartialReveal(frame);
        delete frame.dataset.partialReveal;
        delete frame.dataset.partial;
        if (finalSrcWillChange) finalImg.src = nextUrlAbs;
        this._removeStackFramePartial(frame);
      }
      const partialOrder = this._partialOrderForImage(image);
      const entryLayer = this._initialLayerForNewPartialStackFrame({
        isNewFrame,
        isPartial,
        partialOrder,
        finalLayer: layer,
        promptReplace: isPromptReplaceTransition,
      });
      const applyTargetLayer = () => {
        if (frame.isConnected && frame.dataset.stackKey === key) frame.dataset.layer = String(layer);
      };
      if (stackSwitching && !isNewFrame) {
        if (frame.dataset.layer !== String(layer)) {
          this._animateStackFrameLayer(frame, layer, stackSwitchDirection, applyTargetLayer);
        }
      } else if (stackSwitching && isNewFrame) {
        this._animateStackFrameLayer(frame, layer, stackSwitchDirection, applyTargetLayer);
      } else if (entryLayer !== null) {
        frame.dataset.layer = String(entryLayer);
        window.requestAnimationFrame(applyTargetLayer);
      } else {
        frame.dataset.layer = String(layer);
      }
      frame.dataset.analysisStatus = analysisStatus;
      const muteForAnalysis = analysisStatus === "processing"
        && this._isPasteScreenshotAnalysis(image, node, metadata);
      if (muteForAnalysis) frame.dataset.analysisMute = "true";
      else delete frame.dataset.analysisMute;
      // Top-right spinner is paste/upload-only. Generated prompt_only JSON passes
      // keep analysisStatus=processing but must not show this chrome.
      const showAnalysisSpinner = layer === 0
        && analysisStatus === "processing"
        && this._isPasteScreenshotAnalysis(image, node, metadata);
      if (spinner) spinner.hidden = !showAnalysisSpinner;
      this._syncInpaintProgressMask(frame, [inpaintTreatment, inpaintMask], node, image, metadata);
    });
    if (isPromptReplaceTransition) {
      window.clearTimeout(this._promptReplaceStackTimers.get(node.id));
      const timer = window.setTimeout(() => {
        this._promptReplaceStackTimers.delete(node.id);
        const currentBox = this.shadowRoot.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
        const currentEditor = currentBox?.querySelector(".promptEditor");
        const currentNode = this._state.nodes.find((item) => item.id === node.id);
        if (currentEditor && this._displayableImagesForNode(currentNode).length) currentEditor.hidden = true;
      }, 220);
      this._promptReplaceStackTimers.set(node.id, timer);
    }
    this._lastStackIndexByNode.set(node.id, activeIndex);
    if (this._stackScrollDirectionByNode.has(node.id)) {
      this._scheduleStackDirectionClear(node.id);
    }
    const moreBtn = box.querySelector('[data-node-action="more"]');
    if (moreBtn) moreBtn.disabled = !this._activeImageForNode(node)?.image_url;
  }

  _syncInpaintProgressMask(frame, masks, node, image, metadata) {
    if (!frame || !node || !image) return;
    const overlays = Array.isArray(masks) ? masks.filter(Boolean) : [masks].filter(Boolean);
    if (!overlays.length) return;
    const treatment = overlays.find((overlay) => overlay.classList?.contains("inpaintProgressTreatment"));
    const meta = metadata || this._imageMetadata(image);
    const { cropPercent, cropRect } = this._inpaintCropGeometry(node, image, meta);
    const isInpaintProgress = image.status === "loading"
      && String(meta?.source || "") === "inpaint"
      && (!!cropPercent || !!cropRect);
    frame.dataset.inpaintProgress = isInpaintProgress ? "true" : "false";
    if (!isInpaintProgress) {
      overlays.forEach((overlay) => {
        overlay.removeAttribute("style");
        delete overlay.dataset.inpaintGeometry;
      });
      return;
    }
    const percent = this._normalizeInpaintCropPercent(cropPercent) || this._inpaintCropPercentForNode(node, cropRect);
    if (!percent) {
      frame.dataset.inpaintProgress = "false";
      overlays.forEach((overlay) => {
        overlay.removeAttribute("style");
        delete overlay.dataset.inpaintGeometry;
      });
      return;
    }
    const left = clampNumber(Number(percent.left), 0, 100);
    const top = clampNumber(Number(percent.top), 0, 100);
    const width = clampNumber(Number(percent.width), 0, 100 - left);
    const height = clampNumber(Number(percent.height), 0, 100 - top);
    const cropWidth = Math.max(1, (width / 100) * Math.max(1, node.width));
    const cropHeight = Math.max(1, (height / 100) * Math.max(1, node.height));
    if (treatment) this._syncInpaintProgressPixels(treatment, cropWidth, cropHeight);
    const geometryKey = `${left}:${top}:${width}:${height}`;
    overlays.forEach((overlay) => {
      if (overlay.dataset.inpaintGeometry === geometryKey) return;
      overlay.style.left = `${left}%`;
      overlay.style.top = `${top}%`;
      overlay.style.width = `${width}%`;
      overlay.style.height = `${height}%`;
      overlay.dataset.inpaintGeometry = geometryKey;
    });
  }

  _normalizeInpaintCropPercent(raw) {
    if (!raw || typeof raw !== "object") return null;
    const left = Number(raw.left);
    const top = Number(raw.top);
    const width = Number(raw.width);
    const height = Number(raw.height);
    if (![left, top, width, height].every((value) => Number.isFinite(value))) return null;
    return {
      left: clampNumber(left, 0, 100),
      top: clampNumber(top, 0, 100),
      width: clampNumber(width, 0, 100),
      height: clampNumber(height, 0, 100),
    };
  }

  _normalizeInpaintCropRect(raw) {
    if (!raw || typeof raw !== "object") return null;
    const width = Number(raw.width);
    const height = Number(raw.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return {
      x: Number(raw.x) || 0,
      y: Number(raw.y) || 0,
      width,
      height,
    };
  }

  _inpaintCropPercentForNode(node, cropRect) {
    if (!node || !cropRect) return null;
    const bounds = nodeRect(node);
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    const left = clampNumber(((Number(cropRect.x) - bounds.x) / width) * 100, 0, 100);
    const top = clampNumber(((Number(cropRect.y) - bounds.y) / height) * 100, 0, 100);
    const right = clampNumber(((Number(cropRect.x) + Number(cropRect.width) - bounds.x) / width) * 100, left, 100);
    const bottom = clampNumber(((Number(cropRect.y) + Number(cropRect.height) - bounds.y) / height) * 100, top, 100);
    return {
      left,
      top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  _syncInpaintProgressPixels(treatment, width, height) {
    if (!treatment) return;
    const worldPixelSize = this._inpaintProgressWorldPixelSize(width, height);
    const pixelSize = Math.max(1, Math.ceil(worldPixelSize * (this._state.viewport.scale || 1)));
    const columns = Math.max(1, Math.ceil(width / worldPixelSize));
    const rows = Math.max(1, Math.ceil(height / worldPixelSize));
    const gridKey = `${columns}x${rows}`;
    treatment.style.setProperty("--pixel-size", `${pixelSize}px`);
    treatment.style.setProperty("--pixel-columns", String(columns));
    treatment.style.setProperty("--pixel-rows", String(rows));
    if (treatment.dataset.pixelGrid === gridKey) return;
    const fragment = document.createDocumentFragment();
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        const pixel = document.createElement("div");
        pixel.className = "inpaintProgressTreatmentPixel";
        pixel.style.setProperty("--pixel-blur-min", "1px");
        pixel.style.setProperty("--pixel-blur-max", `${(1.8 + Math.random() * 2.2).toFixed(2)}px`);
        pixel.style.setProperty("--pixel-gray-min", (0.10 + Math.random() * 0.20).toFixed(2));
        pixel.style.setProperty("--pixel-gray-max", (0.38 + Math.random() * 0.26).toFixed(2));
        pixel.style.setProperty("--pixel-saturate-min", (0.82 + Math.random() * 0.18).toFixed(2));
        pixel.style.setProperty("--pixel-saturate-max", (0.56 + Math.random() * 0.20).toFixed(2));
        pixel.style.setProperty("--pixel-bright-min", (0.88 + Math.random() * 0.10).toFixed(2));
        pixel.style.setProperty("--pixel-bright-max", (0.72 + Math.random() * 0.14).toFixed(2));
        pixel.style.setProperty("--pixel-duration", `${Math.round(820 + Math.random() * 1280)}ms`);
        pixel.style.setProperty("--pixel-delay", `${Math.round(-2200 + Math.random() * 2200)}ms`);
        pixel.style.setProperty("--pixel-tint", (0.006 + Math.random() * 0.026).toFixed(3));
        fragment.appendChild(pixel);
      }
    }
    treatment.replaceChildren(fragment);
    treatment.dataset.pixelGrid = gridKey;
  }

  _inpaintProgressWorldPixelSize(width, height) {
    const sizes = [16, 32, 48, 64, 96, 128, 192, 256];
    return sizes.find((size) => Math.ceil(width / size) * Math.ceil(height / size) <= 64) || sizes[sizes.length - 1];
  }

  _ensureStackFrameLayers(frame) {
    let media = frame.querySelector(".stackFrameMedia");
    const legacyImg = frame.querySelector(":scope > img:not(.stackFramePartial):not(.stackFrameFinal)");
    if (!media) {
      media = document.createElement("div");
      media.className = "stackFrameMedia";
      const insertBefore = legacyImg || frame.querySelector(".inpaintProgressTreatment") || frame.firstChild;
      frame.insertBefore(media, insertBefore);
      if (legacyImg) {
        legacyImg.classList.add("stackFrameLayer", "stackFrameFinal");
        media.appendChild(legacyImg);
      }
    }
    let finalImg = media.querySelector(".stackFrameFinal");
    if (!finalImg) {
      finalImg = document.createElement("img");
      finalImg.className = "stackFrameLayer stackFrameFinal";
      finalImg.alt = "";
      media.appendChild(finalImg);
    }
    const partialImg = media.querySelector(".stackFramePartial");
    const stray = media.querySelector(":scope > img:not(.stackFramePartial):not(.stackFrameFinal)");
    if (stray) {
      if (!finalImg.getAttribute("src") && stray.src) finalImg.src = stray.src;
      stray.remove();
    }
    return { media, partialImg, finalImg };
  }

  _ensureStackFramePartial(frame) {
    const { media, finalImg } = this._ensureStackFrameLayers(frame);
    let partialImg = media.querySelector(".stackFramePartial");
    if (!partialImg) {
      partialImg = document.createElement("img");
      partialImg.className = "stackFrameLayer stackFramePartial";
      partialImg.alt = "";
      media.insertBefore(partialImg, finalImg);
    }
    return partialImg;
  }

  _removeStackFramePartial(frame) {
    frame.querySelector(".stackFramePartial")?.remove();
    delete frame.dataset.partialReady;
  }

  _stackFrameHasLoadedPartial(frame) {
    const partialImg = frame.querySelector(".stackFramePartial");
    return !!(partialImg?.src && partialImg.complete && partialImg.naturalWidth > 0);
  }

  _bindStackFramePartialImg(frame, partialImg) {
    const expectedSrc = partialImg.src;
    const onLoad = () => {
      if (!frame.isConnected || partialImg.src !== expectedSrc) return;
      frame.dataset.partialReady = "true";
    };
    const onError = () => {
      if (!frame.isConnected || partialImg.src !== expectedSrc) return;
      this._removeStackFramePartial(frame);
      delete frame.dataset.partial;
    };
    partialImg.addEventListener("load", onLoad, { once: true });
    partialImg.addEventListener("error", onError, { once: true });
    if (partialImg.complete && partialImg.naturalWidth > 0) onLoad();
    else if (partialImg.complete) onError();
  }

  _snapStackFrameFinal(frame, { finalImg, stackKey, expectedUrl }) {
    this._cancelStackFramePartialReveal(frame);
    this._removeStackFramePartial(frame);
    delete frame.dataset.partial;
    delete frame.dataset.partialReveal;
    if (!frame.isConnected || (stackKey && frame.dataset.stackKey !== stackKey)) return;
    if (expectedUrl && finalImg.src !== expectedUrl) finalImg.src = expectedUrl;
    finalImg.style.removeProperty("animation");
    finalImg.style.removeProperty("filter");
    finalImg.style.removeProperty("transform");
    finalImg.style.removeProperty("opacity");
  }

  _cancelStackFramePartialReveal(frame) {
    const handlers = frame._partialRevealHandlers;
    if (!handlers) return;
    handlers.abort();
    frame._partialRevealHandlers = null;
    delete frame.dataset.partialReveal;
    const partialImg = frame.querySelector(".stackFramePartial");
    const finalImg = frame.querySelector(".stackFrameFinal");
    partialImg?.style.removeProperty("animation");
    finalImg?.style.removeProperty("animation");
  }

  _startStackFramePartialReveal(frame, { partialImg, finalImg, stackKey, expectedUrl }) {
    if (!partialImg || !this._stackFrameHasLoadedPartial(frame)) {
      this._snapStackFrameFinal(frame, { finalImg, stackKey, expectedUrl });
      return;
    }
    this._cancelStackFramePartialReveal(frame);
    const controller = new AbortController();
    const { signal } = controller;
    const finish = () => {
      if (signal.aborted) return;
      if (!frame.isConnected || frame.dataset.stackKey !== stackKey) return;
      if (expectedUrl && finalImg.src !== expectedUrl) return;
      this._removeStackFramePartial(frame);
      finalImg.style.removeProperty("animation");
      delete frame.dataset.partial;
      delete frame.dataset.partialReveal;
      frame._partialRevealHandlers = null;
    };
    const begin = () => {
      if (signal.aborted) return;
      if (!frame.isConnected || frame.dataset.stackKey !== stackKey) return;
      if (expectedUrl && finalImg.src !== expectedUrl) return;
      const livePartial = frame.querySelector(".stackFramePartial");
      if (!livePartial || !this._stackFrameHasLoadedPartial(frame)) {
        this._snapStackFrameFinal(frame, { finalImg, stackKey, expectedUrl });
        return;
      }
      const onEnd = (event) => {
        if (event.animationName !== "diffuiCanvasStackPartialRevealPartial") return;
        finish();
      };
      frame.dataset.partialReveal = "active";
      delete frame.dataset.partial;
      livePartial.addEventListener("animationend", onEnd, { once: true, signal });
      livePartial.addEventListener("animationcancel", finish, { once: true, signal });
    };
    const onReady = () => {
      if (signal.aborted) return;
      window.requestAnimationFrame(begin);
    };
    frame._partialRevealHandlers = { abort: () => controller.abort() };
    if (finalImg.complete && finalImg.naturalWidth > 0) onReady();
    else {
      finalImg.addEventListener("load", onReady, { once: true, signal });
      finalImg.addEventListener("error", () => this._snapStackFrameFinal(frame, { finalImg, stackKey, expectedUrl }), { once: true, signal });
    }
  }

  _initialLayerForNewPartialStackFrame({ isNewFrame, isPartial, partialOrder, finalLayer, promptReplace }) {
    if (!isNewFrame || !isPartial) return null;
    if (promptReplace && partialOrder === 1 && finalLayer === 0) return -1;
    if (partialOrder === 2 && finalLayer === 1) return 3;
    if (partialOrder === 3 && finalLayer === 2) return 3;
    return null;
  }

  _animateStackFrameLayer(frame, targetLayer, direction, applyTargetLayer) {
    const target = String(targetLayer);
    const start = String(Number(targetLayer) + direction);
    if (start === target) {
      applyTargetLayer();
      return;
    }
    frame.style.transition = "none";
    frame.dataset.layer = start;
    frame.offsetHeight;
    frame.style.removeProperty("transition");
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(applyTargetLayer);
    });
  }

  _stackVisibleImages(readyImages, activeIndex, nodeId = "") {
    if (!readyImages.length) return [];
    if (readyImages.length === 1) return [{ image: readyImages[0], layer: 0, role: "active" }];
    const hasArrivalOrderedImages = readyImages.some((image) => this._partialOrderForImage(image) > 0);
    const switchingStack = nodeId && this._stackScrollDirectionByNode.has(nodeId);
    const switchDirection = switchingStack ? (this._stackScrollDirectionByNode.get(nodeId) || 0) : 0;
    if (switchingStack) {
      const at = (offset) => readyImages[(activeIndex + offset + readyImages.length) % readyImages.length];
      if (switchDirection < 0) {
        const entries = [
          { image: at(0), layer: 0, role: "active" },
          { image: at(1), layer: 1, role: "next" },
        ];
        if (readyImages.length > 2) entries.push({ image: at(2), layer: 2, role: "third" });
        if (readyImages.length > 3) entries.push({ image: at(3), layer: 3, role: "fourth" });
        return entries;
      }
      if (switchDirection > 0 && readyImages.length > 3) {
        return [
          { image: at(-1), layer: -1, role: "prev" },
          { image: at(0), layer: 0, role: "active" },
          { image: at(1), layer: 1, role: "next" },
          { image: at(2), layer: 2, role: "third" },
        ];
      }
      const entries = [
        { image: at(-1), layer: -1, role: "prev" },
        { image: at(0), layer: 0, role: "active" },
      ];
      if (readyImages.length > 2) entries.push({ image: at(1), layer: 1, role: "next" });
      return entries;
    }
    if (activeIndex === 0 && hasArrivalOrderedImages && !switchingStack) {
      return readyImages.slice(0, 4).map((image, index) => ({
        image,
        layer: index,
        role: index === 0 ? "active" : `behind-${index}`,
      }));
    }
    const at = (offset) => readyImages[(activeIndex + offset + readyImages.length) % readyImages.length];
    const push = (image, layer, role) => {
      if (!image) return;
      entries.push({ image, layer, role });
    };
    const entries = [];
    push(at(-1), -1, "prev");
    push(at(0), 0, "active");
    if (readyImages.length > 2) push(at(1), 1, "next");
    if (readyImages.length > 3) push(at(2), 2, "third");
    return entries;
  }

  _assignStackFrameKeys(nodeId, stack, entries) {
    const direction = this._stackScrollDirectionByNode.get(nodeId) || 0;
    const previous = Array.from(stack.querySelectorAll(".stackFrame")).map((frame) => ({
      imageId: frame.dataset.imageId || "",
      key: frame.dataset.stackKey || "",
      layer: Number(frame.dataset.layer),
    }));
    const usedPrevious = new Set();
    return entries.map((entry) => {
      const imageId = entry.image.id || entry.image.image_id || entry.image.image_url || entry.image.imageUrl || entry.role;
      const desiredLayer = Number(entry.layer) + direction;
      let match = null;
      if (direction) {
        match = previous.find((item) => item.imageId === imageId && item.layer === desiredLayer && !usedPrevious.has(item.key));
        if (!match) {
          match = previous.find((item) => item.imageId === imageId && !usedPrevious.has(item.key));
        }
      } else {
        match = previous.find((item) => item.imageId === imageId && item.layer === entry.layer && !usedPrevious.has(item.key));
      }
      if (match) {
        usedPrevious.add(match.key);
        return { ...entry, key: match.key };
      }
      this._stackFrameKeySeq += 1;
      return { ...entry, key: `${imageId}:${entry.role}:${this._stackFrameKeySeq}` };
    });
  }

  _syncNodeStackBar(stackBar, node, readyImages = this._readyImagesForNode(node)) {
    const images = this._nodeImages(node);
    const hasStack = images.length > 0;
    stackBar.dataset.visible = hasStack ? "true" : "false";
    if (!hasStack) return;
    const dots = stackBar.querySelector(".stackDots");
    const add = stackBar.querySelector(".stackAdd");
    if (!dots || !add) return;
    const activeReadyImage = readyImages[this._activeImageIndex(node, readyImages)];
    const activeId = activeReadyImage?.id || "";
    const nextIds = images.map((image) => image.id || image.image_url || image.imageUrl || "");
    while (dots.children.length > nextIds.length) dots.lastElementChild?.remove();
    nextIds.forEach((id, index) => {
      let dot = dots.children[index];
      if (!dot) {
        dot = document.createElement("button");
        dot.className = "stackDot";
        dot.type = "button";
        dots.appendChild(dot);
      }
      dot.dataset.imageId = id;
      dot.dataset.index = String(index);
      dot.setAttribute("aria-label", `Show image ${index + 1}`);
    });
    Array.from(dots.querySelectorAll(".stackDot")).forEach((dot, index) => {
      const image = images[index];
      const hasUrl = !!String(image?.image_url || image?.imageUrl || "").trim();
      const isProcessing = image?.status === "loading";
      const isActive = image?.id === activeId;
      let state = isActive ? "active" : "available";
      if (isProcessing && !hasUrl) state = "processing-unavailable";
      else if (isProcessing && isActive) state = "processing-active";
      else if (isProcessing) state = "processing-available";
      dot.dataset.state = state;
      dot.dataset.status = isProcessing ? "loading" : "ready";
      dot.dataset.active = isActive ? "true" : "false";
      dot.disabled = !hasUrl;
    });
    add.hidden = false;
    add.disabled = images.length >= MAX_NODE_IMAGES;
  }

  _onNodeStackBarClick(event, nodeId) {
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const add = event.target.closest(".stackAdd");
    if (add) {
      this._handleStackAddAction(nodeId, event, "stackAdd-bar");
      return;
    }
    const dot = event.target.closest(".stackDot");
    if (!dot) return;
    event.preventDefault();
    event.stopPropagation();
    const images = this._nodeImages(node);
    const image = images[Number(dot.dataset.index) || 0];
    if (!String(image?.image_url || image?.imageUrl || "").trim()) return;
    const readyImages = this._readyImagesForNode(node);
    const readyIndex = readyImages.findIndex((readyImage) => readyImage.id === image.id);
    if (readyIndex < 0) return;
    if (!this._applyNodeStackSwitch(node, readyIndex, readyImages)) return;
    this._syncToolbar();
    this._draw();
  }

  _onNodeHeaderAction(event, nodeId) {
    const button = event.target.closest("button[data-node-action]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    this._selectNodeById(nodeId);
    this._trackClick(
      UI_TELEMETRY_EVENTS.NODE_TOOLBAR_CLICK, "node_header", button.dataset.nodeAction || "",
    );
    if (button.dataset.nodeAction === "delete") {
      this._deleteSelected();
      return;
    }
    if (button.dataset.nodeAction === "copy") {
      this._copyNodeToClipboard(node).catch((error) => this._setStatus(error.message || "Copy failed"));
      return;
    }
    if (button.dataset.nodeAction === "more") {
      if (!this._activeImageForNode(node)) return;
      const menu = this.shadowRoot.getElementById("nodeContextMenu");
      const alreadyOpen = menu?.dataset.open === "true"
        && this._nodeContextMenuState
        && !this._nodeContextMenuState.multiSelect
        && this._nodeContextMenuState.nodeId === node.id;
      if (alreadyOpen) {
        this._closeNodeContextMenu();
        return;
      }
      const rect = button.getBoundingClientRect();
      this._trackClick(UI_TELEMETRY_EVENTS.CONTEXT_MENU_OPEN, "node_context_menu", "open", {
        source: "node_toolbar",
      });
      this._openNodeContextMenu(node, rect.left, rect.bottom + 4);
    }
  }

  _duplicateSelected() {
    const suffix = `-copy-${crypto.randomUUID()}`;
    const raw = this._engine?.duplicate_selected?.(suffix);
    const duplicated = safeParse(raw) || [];
    this._syncStateFromEngine();
    const node = duplicated[0];
    if (node?.id) this._selectNodeById(node.id);
    this._commitCollabState();
    this._syncPromptOverlays();
    this._syncToolbar();
    this._draw();
  }

  _agentCopyText(buildUrl) {
    return `Create a web page implementation from the following instructions: ${buildUrl}`;
  }

  _assetIdForNode(node) {
    const image = this._activeImageForNode(node);
    const metadata = safeParse(image?.metadata_json) || safeParse(node?.metadata_json || node?.metadataJson) || {};
    return String(metadata.assetId || "").trim();
  }

  _agentBuildPagesFromNodes(nodes) {
    const pages = [];
    for (const node of nodes) {
      const imageId = this._imageIdForNode(node);
      const assetId = imageId ? "" : this._assetIdForNode(node);
      if (!imageId && !assetId) continue;
      const image = this._activeImageForNode(node);
      const name = String(node?.name || image?.name || "design").trim();
      const brandId = this._promptBrandIdForNode(node) || this._brandIdForNodeImage(node);
      pages.push({
        image_id: imageId,
        asset_id: assetId,
        name,
        original_prompt: this._promptTextForNode(node),
        brand_id: brandId,
      });
    }
    return pages;
  }

  _agentBundleNameFromNodes(nodes) {
    if (nodes.length === 1) {
      const image = this._activeImageForNode(nodes[0]);
      return String(nodes[0]?.name || image?.name || "design").trim();
    }
    const title = String(this._projectFileTitle || "").trim();
    if (!this._projectTitleLooksUntitled(title)) {
      return `${title}_build`;
    }
    const image = this._activeImageForNode(nodes[0]);
    const pageName = String(nodes[0]?.name || image?.name || "design").trim();
    return `${pageName}_build`;
  }

  async _copySelectionForAgent(nodeIds) {
    if (!navigator.clipboard?.writeText) throw new Error("Copy for agent unavailable");
    const nodes = (nodeIds || [])
      .map((id) => this._state.nodes.find((n) => n.id === id))
      .filter(Boolean);
    const pages = this._agentBuildPagesFromNodes(nodes);
    if (pages.length < 2) throw new Error("Copy for agent unavailable");
    const res = await this._api("/api/agent-build-link", {
      method: "POST",
      body: JSON.stringify({
        bundle_name: this._agentBundleNameFromNodes(nodes),
        pages,
      }),
    });
    const buildUrl = String(res?.buildUrl || "").trim();
    if (!buildUrl) throw new Error("Copy for agent unavailable");
    await navigator.clipboard.writeText(this._agentCopyText(buildUrl));
    this._setStatus("Copied prompt for agent");
    this._showToast("Copied prompt for agent");
  }

  async _copyNodeForAgent(node) {
    if (!navigator.clipboard?.writeText) throw new Error("Copy for agent unavailable");
    const pages = this._agentBuildPagesFromNodes([node]);
    if (!pages.length) throw new Error("Copy for agent unavailable");
    const res = await this._api("/api/agent-build-link", {
      method: "POST",
      body: JSON.stringify({
        bundle_name: this._agentBundleNameFromNodes([node]),
        pages,
      }),
    });
    const buildUrl = String(res?.buildUrl || "").trim();
    if (!buildUrl) throw new Error("Copy for agent unavailable");
    await navigator.clipboard.writeText(this._agentCopyText(buildUrl));
    this._setStatus("Copied prompt for agent");
    this._showToast("Copied prompt for agent");
  }

  async _buildSelectionWithBb(nodeIds) {
    const nodes = (nodeIds || [])
      .map((id) => this._state.nodes.find((n) => n.id === id))
      .filter(Boolean);
    await this._buildNodesWithBb(nodes);
  }

  // Sends the selected designs into the user's bb. Preferred transport is the
  // plugin's direct build route on localhost (token auth + per-route CORS —
  // needs bb with getbb.app's experimental_cors, jjcm/bb#6); anything short of
  // a readable success falls back to the server-side bridge relay, and a
  // downed bridge falls back again to putting the same prompt on the
  // clipboard that Copy for agent would.
  async _buildNodesWithBb(nodes) {
    const pages = this._agentBuildPagesFromNodes(nodes);
    if (!pages.length) throw new Error("Build with bb unavailable");
    this._setStatus("Sending to bb…");
    const body = {
      bundle_name: this._agentBundleNameFromNodes(nodes),
      pages,
      project_id: this._projectId,
      project_title: this._projectFileTitle,
    };
    const direct = await this._buildWithBbDirect(body);
    if (direct) {
      this._announceBbBuild(direct);
      return;
    }
    let res;
    try {
      res = await this._api("/api/bb/build", { method: "POST", body: JSON.stringify(body) });
    } catch (error) {
      const fallbackUrl = String(error?.data?.buildUrl || "").trim();
      if (fallbackUrl && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(this._agentCopyText(fallbackUrl));
        const reason = error?.data?.error === "bb_bridge_offline"
          ? "bb isn't connected"
          : "bb didn't answer";
        this._setStatus("Copied prompt for agent");
        this._showToast(`${reason} — copied build prompt instead`);
        this._refreshBbBridgeStatus().catch(() => null);
        return;
      }
      throw new Error(error?.data?.message || error.message || "Build with bb failed");
    }
    this._announceBbBuild(res);
  }

  // The direct browser→localhost path: mint the dispatch payload server-side,
  // then POST it straight to the bb plugin's token route. Returns the build
  // result, or null to fall back to the relay (no endpoint paired, CORS not
  // available in this bb yet, bb not running, or a stale token — the 401 is
  // readable thanks to the route's CORS declaration, so we can say why).
  async _buildWithBbDirect(body) {
    const endpoint = this._bbLocalEndpoint;
    if (!endpoint?.url || !endpoint?.token) return null;
    let payload;
    try {
      payload = await this._api("/api/bb/build-package", { method: "POST", body: JSON.stringify(body) });
    } catch {
      return null;
    }
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bb-plugin-token": endpoint.token,
        },
        body: JSON.stringify(payload),
      });
      if (response.status === 401) {
        this._showToast("bb rejected the pairing token — reconnect bb, retrying via Diffui");
        return null;
      }
      if (!response.ok) return null;
      const result = await response.json().catch(() => null);
      if (result?.ok !== true) return null;
      return result;
    } catch {
      // Preflight refused (bb without per-route CORS) or bb not reachable.
      return null;
    }
  }

  _announceBbBuild(result) {
    const threadTitle = String(result?.thread?.title || "").trim();
    const bbProjectName = String(result?.bbProject?.name || "").trim();
    const where = bbProjectName ? ` in ${bbProjectName}` : "";
    this._setStatus("Sent to bb");
    this._showToast(`Building in bb${where}: ${threadTitle || "new thread"}`);
  }

  async _copyNodeToClipboard(node) {
    const image = this._activeImageForNode(node);
    const imageUrl = image?.image_url || image?.imageUrl || "";
    if (imageUrl && navigator.clipboard?.write && window.ClipboardItem) {
      try {
        const blob = await this._nodeImageClipboardBlob(node, imageUrl);
        const payload = this._diffuiClipboardPayloadForNode(node, image);
        if (payload) await this._writeDiffuiClipboardItem(blob, payload);
        else await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        this._setStatus("Image copied to clipboard");
        this._showToast("Image copied to clipboard");
        return;
      } catch {
        // Fall back to text below when image clipboard writes are unavailable.
      }
    }
    const metadata = safeParse(image?.metadata_json) || safeParse(node.metadata_json) || {};
    const text = String(node.prompt || metadata.originalPrompt || imageUrl || node.name || "").trim();
    if (!text || !navigator.clipboard?.writeText) throw new Error("Copy unavailable");
    await navigator.clipboard.writeText(text);
    this._setStatus("Copied to clipboard");
    this._showToast("Copied to clipboard");
  }

  async _writeDiffuiClipboardItem(blob, payload) {
    const json = JSON.stringify(payload);
    try {
      await navigator.clipboard.write([new ClipboardItem({
        [blob.type]: blob,
        [DIFFUI_CLIPBOARD_MIME]: new Blob([json], { type: "application/json" }),
      })]);
    } catch {
      await navigator.clipboard.write([new ClipboardItem({
        [blob.type]: blob,
        "text/plain": new Blob([json], { type: "text/plain" }),
      })]);
    }
  }

  _diffuiClipboardPayloadForNode(node, image) {
    const metadata = safeParse(image?.metadata_json) || safeParse(node?.metadata_json) || {};
    const expandedJson = metadata.expandedPrompt ?? metadata.expandedJson ?? image?.promptJson ?? null;
    if (!expandedJson) return null;
    return {
      diffuiClipboard: DIFFUI_CLIPBOARD_MARKER,
      version: 1,
      source: "image_node",
      name: String(image?.name || node?.name || "Image node").trim() || "Image node",
      width: Math.round(Number(node?.width || 0)),
      height: Math.round(Number(node?.height || 0)),
      expandedJson,
    };
  }

  async _nodeImageClipboardBlob(node, imageUrl) {
    const img = this._imageFor(imageUrl);
    if (!img) throw new Error("Copy image unavailable");
    await waitForImage(img);
    const sourceRect = this._imageDrawSourceRect(node, img);
    if (!sourceRect) throw new Error("Copy image unavailable");
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceRect.width));
    canvas.height = Math.max(1, Math.round(sourceRect.height));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Copy image unavailable"));
      }, "image/png");
    });
  }

  _downloadNodeImage(node) {
    const image = this._activeImageForNode(node);
    const url = image?.image_url || image?.imageUrl || "";
    if (!url) return;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slugify(image.name || node.name || "canvas-image")}.png`;
    anchor.rel = "noopener";
    anchor.click();
  }

  _shouldUseLowDetailNodeUi(node) {
    const scale = this._state.viewport.scale || 1;
    return node.width * scale < MIN_UI_SCREEN_WIDTH || node.height * scale < MIN_UI_SCREEN_HEIGHT;
  }

  _patchNode(id, patch, options = {}) {
    this._engine?.patch_node(id, JSON.stringify(patch));
    if (options.localMirror) {
      // Interactive path (e.g. live resize): avoid re-serializing the whole
      // document each frame. Mirror the patched fields onto the local node;
      // pointer-up runs a full _syncStateFromEngine() to reconcile normalization.
      this._applyNodePatchLocally(id, patch);
    } else {
      this._syncStateFromEngine();
    }
    this._markCollabDirty();
    if (!options.quiet) this._draw();
    this._queueSave();
  }

  _applyNodePatchLocally(id, patch) {
    const node = this._state.nodes.find((item) => item.id === id);
    if (!node) return;
    if (Number.isFinite(Number(patch.x))) node.x = Number(patch.x);
    if (Number.isFinite(Number(patch.y))) node.y = Number(patch.y);
    if (Number.isFinite(Number(patch.width))) {
      node.width = node.kind === "image" ? Math.max(16, Math.round(Number(patch.width))) : snap_dimension(Number(patch.width));
    }
    if (Number.isFinite(Number(patch.height))) {
      node.height = node.kind === "image" ? Math.max(16, Math.round(Number(patch.height))) : snap_dimension(Number(patch.height));
    }
    if (typeof patch.name === "string") node.name = patch.name;
    if (typeof patch.prompt === "string") node.prompt = clampPromptText(patch.prompt);
    if (typeof patch.status === "string") node.status = patch.status;
  }

  _imageMetadata(image) {
    if (!image) return {};
    return safeParse(image.metadata_json || image.metadataJson || image.metadata) || {};
  }

  _inpaintCropGeometry(node, image, metadata) {
    let cropPercent = metadata?.inpaintCropPercent || null;
    let cropRect = metadata?.inpaintCropRect || metadata?.cropRect || null;
    const isInpaintSlot = image?.status === "loading" && String(metadata?.source || "") === "inpaint";
    if (isInpaintSlot && !cropPercent && !cropRect && this._inpaint?.sourceNodeId === node?.id) {
      if (this._inpaint.cropRect) {
        cropRect = this._inpaint.cropRect;
        cropPercent = this._inpaintCropPercentForNode(node, cropRect);
      }
    }
    return { cropPercent, cropRect };
  }

  _nodeImages(node) {
    if (!node) return [];
    if (Array.isArray(node.images)) return node.images;
    if (node.kind === "image") {
      return [{
        id: node.id,
        name: node.name || "Image",
        image_url: node.image_url || node.imageUrl || "",
        status: node.status || "",
        metadata_json: node.metadata_json || node.metadataJson || "",
      }];
    }
    return [];
  }

  _canvasHasGenerationStarted() {
    return this._state.nodes.some((node) => {
      if (!node || node.kind === "image") return false;
      if (this._nodeGenerationInFlight(node)) return true;
      if (String(node.status || "").toLowerCase() === "loading") return true;
      return this._nodeImages(node).some((image) => {
        const status = String(image.status || "").toLowerCase();
        return status === "loading" || status === "ready" || !!String(image.image_url || image.imageUrl || "").trim();
      });
    });
  }

  _readyImagesForNode(node) {
    return this._displayableImagesForNode(node);
  }

  _displayableImagesForNode(node) {
    return this._nodeImages(node).filter((image) => String(image.image_url || image.imageUrl || "").trim());
  }

  _imageGenerationPending(image) {
    if (!image || String(image.status || "").toLowerCase() !== "loading") return false;
    const imageMeta = safeParse(image.metadata_json || image.metadataJson) || {};
    const hasUrl = !!String(image.image_url || image.imageUrl || "").trim();
    if (imageMeta.partial === true) return true;
    if (!hasUrl) return true;
    if (String(imageMeta.source || "") === "generation" || String(imageMeta.source || "") === "inpaint") {
      return false;
    }
    return false;
  }

  _nodeGenerationInFlightReason(node) {
    const metadata = safeParse(node?.metadata_json || node?.metadataJson) || {};
    const images = this._nodeImages(node);
    const pending = images.filter((image) => this._imageGenerationPending(image));
    if (pending.length) {
      return { reason: "loading_slots", count: pending.length, slotIds: pending.map((image) => image.id) };
    }
    if (metadata.inpaintGenerating === true) {
      const inpaintPending = images.some((image) => {
        const imageMeta = safeParse(image.metadata_json) || {};
        return image.status === "loading" && imageMeta.source === "inpaint";
      });
      if (inpaintPending) return { reason: "inpaint_generating" };
    }
    if (metadata.generating === true) {
      return { reason: "metadata_generating_stale" };
    }
    return null;
  }

  _nodeGenerationInFlight(node) {
    return !!this._nodeGenerationInFlightReason(node);
  }

  _syncNodeGenerationMetadata(metadata, images) {
    const next = { ...(metadata || {}) };
    const stillLoading = (Array.isArray(images) ? images : []).some(
      (image) => String(image?.status || "").toLowerCase() === "loading",
    );
    if (stillLoading) {
      next.generating = true;
    } else {
      delete next.generating;
      delete next.generationRequestId;
    }
    return next;
  }

  _reconcileStaleNodeGeneration(node, options = {}) {
    if (!node) return false;
    const metadata = safeParse(node.metadata_json || node.metadataJson) || {};
    const images = this._nodeImages(node).map((image) => {
      const hasUrl = !!String(image.image_url || image.imageUrl || "").trim();
      const imageMeta = safeParse(image.metadata_json || image.metadataJson) || {};
      // An in-flight inpaint slot carries the source image URL as the treatment
      // backdrop; promoting it to ready would also blind the inpaintPending
      // check below, which reads statuses from this promoted array.
      if (image.status === "loading" && hasUrl && imageMeta.partial !== true && String(imageMeta.source || "") !== "inpaint") {
        return { ...image, status: "ready" };
      }
      return image;
    });
    const pending = images.some((image) => this._imageGenerationPending(image));
    const inpaintPending = metadata.inpaintGenerating === true && images.some((image) => {
      const imageMeta = safeParse(image.metadata_json) || {};
      return image.status === "loading" && imageMeta.source === "inpaint";
    });
    if (pending || inpaintPending) return false;
    const staleGenerating = metadata.generating === true || metadata.generationRequestId;
    const staleStatus = String(node.status || "").toLowerCase() === "loading" && this._readyImagesForNode({ ...node, images }).length;
    if (!staleGenerating && !staleStatus) return false;
    const nextMetadata = { ...metadata };
    delete nextMetadata.generating;
    delete nextMetadata.generationRequestId;
    const readyImages = this._readyImagesForNode({ ...node, images });
    const activeImage = readyImages[this._activeImageIndex(node, readyImages)] || readyImages[0];
    this._patchNode(node.id, {
      images,
      status: readyImages.length ? "ready" : node.status,
      imageUrl: activeImage?.image_url || activeImage?.imageUrl || node.image_url || "",
      metadataJson: JSON.stringify(nextMetadata),
    }, { quiet: true });
    if (options.log) {
      this._logStackAdd("reconciled stale generation flags", { nodeId: node.id });
    }
    return true;
  }

  _moveImageIntoNextEmptyImageSlot(images, imageIndex) {
    if (imageIndex < 0 || imageIndex >= images.length) return images;
    const displayImage = images[imageIndex];
    if (!String(displayImage?.image_url || displayImage?.imageUrl || "").trim()) return images;
    const nextEmptyIndex = images.findIndex((image, index) => {
      if (index === imageIndex) return false;
      return !String(image?.image_url || image?.imageUrl || "").trim();
    });
    if (nextEmptyIndex < 0 || nextEmptyIndex >= imageIndex) return images;
    const nextImages = images.slice();
    nextImages.splice(imageIndex, 1);
    nextImages.splice(nextEmptyIndex, 0, displayImage);
    return nextImages;
  }

  _partialOrderForImage(image) {
    const metadata = safeParse(image?.metadata_json || image?.metadataJson) || {};
    const order = Number(metadata.partialOrder ?? metadata.partial_order);
    return Number.isFinite(order) && order > 0 ? order : 0;
  }

  _nextPartialOrder(images, currentIndex) {
    const existing = this._partialOrderForImage(images[currentIndex]);
    if (existing > 0) return existing;
    return images.reduce((maxOrder, image, index) => {
      if (index === currentIndex) return maxOrder;
      return Math.max(maxOrder, this._partialOrderForImage(image));
    }, 0) + 1;
  }

  _orderImagesByPartialArrival(images) {
    const partials = [];
    const rest = [];
    images.forEach((image, index) => {
      const order = this._partialOrderForImage(image);
      if (order > 0) partials.push({ image, index, order });
      else rest.push({ image, index });
    });
    partials.sort((a, b) => a.order - b.order || a.index - b.index);
    return [...partials.map((entry) => entry.image), ...rest.map((entry) => entry.image)];
  }

  _activeImageIndex(node, images = this._readyImagesForNode(node)) {
    if (!images.length) return 0;
    const raw = Number(node.stack_index ?? node.stackIndex ?? 0);
    return Math.max(0, Math.min(images.length - 1, Number.isFinite(raw) ? Math.round(raw) : 0));
  }

  _activeImageForNode(node) {
    const images = this._readyImagesForNode(node);
    return images[this._activeImageIndex(node, images)] || null;
  }

  /**
   * True while a pasted/uploaded screenshot is still being analyzed. Generated
   * prompt_only JSON passes also set analysisStatus=processing, but those must
   * not hide the … menu / output handle or show the top-right spinner.
   */
  _nodeAnalysisProcessing(node) {
    const image = this._activeImageForNode(node);
    const metadata = safeParse(image?.metadata_json) || safeParse(node?.metadata_json) || {};
    if (String(metadata.analysisStatus || metadata.analysis_status || "") !== "processing") return false;
    return this._isPasteScreenshotAnalysis(image, node, metadata);
  }

  /** Paste/upload analysis (show spinner + block chrome) vs generated JSON pass. */
  _isPasteScreenshotAnalysis(image, node, metadata = null) {
    const meta = metadata || safeParse(image?.metadata_json) || safeParse(node?.metadata_json) || {};
    const source = String(meta.source || "").trim();
    if (source === "generation" || source === "inpaint") return false;
    if (meta.assetId || meta.asset_id) return true;
    if (source === "paste" || source === "prompt_input" || source === "clipboard") return true;
    // Standalone image nodes without a generation image id are pastes.
    if (node?.kind === "image" && !this._imageIdForNode(node)) return true;
    // Generation image id present → generated screen, even if source was omitted.
    if (meta.imageId || meta.image_id || image?.imageId || image?.image_id) return false;
    return true;
  }

  _inputPreviewImagesForNode(node) {
    const refs = [];
    this._state.edges.forEach((edge) => {
      if (edge.to_node_id !== node.id && edge.toNodeId !== node.id) return;
      const sourceId = edge.from_node_id || edge.fromNodeId || "";
      const source = this._state.nodes.find((item) => item.id === sourceId);
      const image = this._activeImageForNode(source);
      if (image) refs.push(image);
    });
    return refs;
  }

  _nodeHasInputs(node) {
    return this._state.edges.some((edge) => edge.to_node_id === node.id || edge.toNodeId === node.id);
  }

  _stackSwitchDirection(fromIndex, toIndex, length) {
    if (length < 2 || fromIndex === toIndex) return 0;
    const forward = (toIndex - fromIndex + length) % length;
    const backward = (fromIndex - toIndex + length) % length;
    return forward <= backward ? 1 : -1;
  }

  _prepareStackSwitchDirection(node, nextIndex, images = this._readyImagesForNode(node)) {
    const direction = this._stackSwitchDirection(this._activeImageIndex(node, images), nextIndex, images.length);
    if (!direction) return 0;
    this._stackScrollDirectionByNode.set(node.id, direction);
    return direction;
  }

  _scheduleStackDirectionClear(nodeId, delayMs = 220) {
    window.clearTimeout(this._stackDirectionClearTimers.get(nodeId));
    const timer = window.setTimeout(() => {
      this._stackDirectionClearTimers.delete(nodeId);
      this._stackScrollDirectionByNode.delete(nodeId);
      const box = this.shadowRoot?.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
      const node = this._state.nodes.find((entry) => entry.id === nodeId);
      if (box && node) this._syncNodeImageStack(box, node);
    }, delayMs);
    this._stackDirectionClearTimers.set(nodeId, timer);
  }

  _applyNodeStackSwitch(node, nextIndex, readyImages = this._readyImagesForNode(node), { user = true } = {}) {
    const current = this._activeImageIndex(node, readyImages);
    if (nextIndex === current) return false;
    // Only user gestures (dot click / ←→) notify the coach. Generation reorders
    // stack images without going through this helper; keep it that way.
    if (user) this._notifyCanvasCoach("option-selected", { nodeId: node.id, index: nextIndex, user: true });
    this._prepareStackSwitchDirection(node, nextIndex, readyImages);
    this._patchNode(node.id, { stackIndex: nextIndex, stack_index: nextIndex }, { quiet: true });
    this._commitCollabState();
    window.clearTimeout(this._collabAwarenessTimer);
    this._collabAwarenessTimer = 0;
    this._pendingCollabAwareness = null;
    this._publishCollabAwareness();
    // Defer overlay sync so the browser paints existing frame layers before we retarget them.
    window.requestAnimationFrame(() => {
      this._syncPromptOverlays();
    });
    return true;
  }

  _stepNodeStack(node, delta) {
    const images = this._readyImagesForNode(node);
    if (images.length < 2) return;
    const current = this._activeImageIndex(node, images);
    const next = (current + delta + images.length) % images.length;
    if (next === current) return;
    if (!this._applyNodeStackSwitch(node, next, images)) return;
    this._syncToolbar();
    this._draw();
  }

  _syncToolbar() {
    const node = this._selectedNode();
    if (!node) {
      this._hideInspector();
      return;
    }
    if (this._showInspectorOnImageSelect && this._activeImageForNode(node)) {
      this._showInspector(node);
      return;
    }
    this._hideInspector();
  }

  _hideInspectorIfNodeUnselected() {
    const inspector = this.shadowRoot.getElementById("inspector");
    if (inspector.hidden) return;
    const inspectedNodeId = inspector.dataset.nodeId || "";
    if (this._state.nodes.some((node) => node.id === inspectedNodeId && node.selected)) return;
    this._hideInspector();
  }

  _syncStateFromEngine() {
    const metadata = this._normalizeCanvasMetadata(this._canvasMetadata || this._state?.metadata);
    const comments = this._normalizeCanvasComments(this._comments || this._state?.comments);
    this._state = safeParse(this._engine?.serialize()) || this._state;
    this._canvasMetadata = metadata;
    this._state.metadata = this._canvasMetadata;
    this._comments = comments;
    this._state.comments = this._comments;
    this._emitSelectionRouteChangeIfNeeded();
    this._scheduleCanvasCoachSync();
  }

  _routeSelectedNodeId() {
    const selected = this._state.nodes.filter((node) => node.selected);
    return selected.length === 1 ? selected[0].id : "";
  }

  _emitSelectionRouteChangeIfNeeded({ force = false } = {}) {
    if (this._suppressSelectionRouteEvent) return;
    const nodeId = this._routeSelectedNodeId();
    if (!force && nodeId === this._selectedRouteNodeId) return;
    this._selectedRouteNodeId = nodeId;
    this.dispatchEvent(
      new CustomEvent("diffui-canvas:selection-route", {
        bubbles: true,
        composed: true,
        detail: { projectId: this._projectId, nodeId },
      }),
    );
  }

  _commitViewport() {
    this._applyViewport(this._state.viewport, { save: true });
  }

  // Coalesce overlay sync + canvas draw into a single animation frame so a burst
  // of pointer events (panning, dragging) produces at most one render per frame.
  _scheduleRender() {
    this._pendingOverlaySync = true;
    this._pendingDraw = true;
    this._requestRenderFrame();
  }

  _scheduleDraw() {
    this._pendingDraw = true;
    this._requestRenderFrame();
  }

  // Geometry-only overlay update for viewport changes (pan/zoom). A viewport
  // change never mutates node content, so we only need to reposition/resize the
  // existing prompt boxes -- skipping the expensive per-node content sync.
  _scheduleReposition() {
    this._pendingReposition = true;
    this._pendingDraw = true;
    this._requestRenderFrame();
  }

  _requestRenderFrame() {
    if (this._renderFrame) return;
    this._renderFrame = window.requestAnimationFrame(() => {
      this._renderFrame = 0;
      const overlay = this._pendingOverlaySync;
      const reposition = this._pendingReposition;
      const draw = this._pendingDraw;
      this._pendingOverlaySync = false;
      this._pendingReposition = false;
      this._pendingDraw = false;
      if (overlay) this._syncPromptOverlays();
      else if (reposition) this._repositionPromptOverlays();
      if (draw) this._draw();
    });
  }

  _applyViewport(viewport, { save = false } = {}) {
    this._state.viewport.x = viewport.x;
    this._state.viewport.y = viewport.y;
    this._state.viewport.scale = viewport.scale;
    this._engine?.set_viewport(this._state.viewport.x, this._state.viewport.y, this._state.viewport.scale);
    // A viewport change never mutates nodes/edges, so there is no need to
    // re-serialize the entire document out of the engine and parse it back in
    // (the dominant cost when panning a large file). Update locally and render.
    this._syncToolbar();
    this._scheduleReposition();
    if (save) this._queueSave();
  }

  _isInitialCanvasState(state) {
    const nodes = Array.isArray(state?.nodes) ? state.nodes : [];
    const node = nodes[0];
    const edges = Array.isArray(state?.edges) ? state.edges : [];
    return nodes.length === 1
      && node?.id === "prompt-1"
      && node?.kind === "prompt"
      && !String(node?.prompt || "").trim()
      && edges.length === 0;
  }

  _prepareInitialCanvas() {
    const node = this._state.nodes[0];
    if (!node) return;
    const metadata = safeParse(node.metadata_json || node.metadataJson) || {};
    if (!Array.isArray(metadata.promptSuggestions) || !metadata.promptSuggestions.length) {
      metadata.promptSuggestions = this._suggestionsForNewPromptNode();
      node.metadata_json = JSON.stringify(metadata);
    }
    node.x = -DEFAULT_PROMPT_WIDTH / 2;
    node.y = -DEFAULT_PROMPT_HEIGHT / 2;
    node.width = DEFAULT_PROMPT_WIDTH;
    node.height = DEFAULT_PROMPT_HEIGHT;
    this._engine?.load(JSON.stringify(this._state));
    this._syncStateFromEngine();
    this._centerViewportOnNode(this._state.nodes[0], { margin: INITIAL_VIEWPORT_FIT_MARGIN_PX });
    this._syncPromptOverlays();
    this._focusPromptNode(this._state.nodes[0], { camera: false });
  }

  _centerViewportOnNode(node, { margin = VIEWPORT_FIT_MARGIN_PX } = {}) {
    if (!node) return;
    const canvas = this.shadowRoot.getElementById("canvas");
    const bounds = canvas?.getBoundingClientRect();
    const width = bounds?.width || this.clientWidth || window.innerWidth || 1;
    const height = bounds?.height || this.clientHeight || window.innerHeight || 1;
    const fitScale = Math.min(
      1,
      Math.max(0.28, (width - margin * 2) / Math.max(1, node.width)),
      Math.max(0.28, (height - margin * 2) / Math.max(1, node.height)),
    );
    this._state.viewport.scale = fitScale;
    this._state.viewport.x = width / 2 - (node.x + node.width / 2) * fitScale;
    this._state.viewport.y = height / 2 - (node.y + node.height / 2) * fitScale;
    this._engine?.set_viewport(this._state.viewport.x, this._state.viewport.y, this._state.viewport.scale);
    this._syncStateFromEngine();
  }

  _focusRouteNode(nodeId) {
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node) return false;
    this._state.nodes.forEach((item) => (item.selected = item.id === nodeId));
    this._state.edges.forEach((edge) => (edge.selected = false));
    this._engine?.load(JSON.stringify(this._state));
    this._syncStateFromEngine();
    this._centerViewportOnNode(this._state.nodes.find((item) => item.id === nodeId));
    this._syncToolbar();
    this._syncPromptOverlays();
    return true;
  }

  /** Top-left first, then left→right, then wrap to the next row below (y then x). */
  _nodesInReadingOrder() {
    return [...this._state.nodes].sort((a, b) => (a.y - b.y) || (a.x - b.x) || String(a.id).localeCompare(String(b.id)));
  }

  _focusAdjacentFrame(delta) {
    const ordered = this._nodesInReadingOrder();
    if (!ordered.length) return;
    const selected = this._selectedNode();
    const index = selected ? ordered.findIndex((node) => node.id === selected.id) : -1;
    let nextIndex;
    if (index < 0) nextIndex = delta > 0 ? 0 : ordered.length - 1;
    else nextIndex = (index + delta + ordered.length) % ordered.length;
    const next = ordered[nextIndex];
    this._selectNodeById(next.id);
    this._fitWorldRectIntoView(this._promptWorldRectForViewportFit(next), { animate: true });
    this._syncToolbar();
    this._syncPromptOverlays();
  }

  _clearRouteSelection() {
    this._state.nodes.forEach((node) => (node.selected = false));
    this._state.edges.forEach((edge) => (edge.selected = false));
    this._engine?.load(JSON.stringify(this._state));
    this._syncStateFromEngine();
    this._syncToolbar();
    this._syncPromptOverlays();
  }

  _fitWorldRectIntoView(rect, { animate = false, ifNeeded = false, durationMs = 300 } = {}) {
    if (!rect) return;
    const canvas = this.shadowRoot.getElementById("canvas");
    const bounds = canvas?.getBoundingClientRect();
    const width = bounds?.width || this.clientWidth || window.innerWidth || 1;
    const height = bounds?.height || this.clientHeight || window.innerHeight || 1;
    const margin = VIEWPORT_FIT_MARGIN_PX;
    if (ifNeeded && this._isWorldRectVisible(rect, width, height, margin)) return;
    const viewport = this._viewportForWorldRect(rect, width, height, margin);
    if (animate) this._animateViewport(viewport, durationMs);
    else this._applyViewport(viewport, { save: true });
  }

  /**
   * After dragging a prompt out of an output handle:
   * - No-op when both are already fully visible and prompt UI is past LoD.
   * - Zoom out as needed so both fit on screen.
   * - Zoom in only when past the low-detail LoD, and only up to that readable
   *   scale (never past what still keeps both in frame).
   */
  _fitOutputDropIntoView(source, created, onComplete = null) {
    const done = () => onComplete?.();
    if (!created) {
      done();
      return;
    }
    const bounds = unionRects([
      this._promptWorldRectForViewportFit(source),
      this._promptWorldRectForViewportFit(created),
    ]);
    if (!bounds) {
      done();
      return;
    }
    const canvas = this.shadowRoot.getElementById("canvas");
    const screen = canvas?.getBoundingClientRect();
    const width = screen?.width || this.clientWidth || window.innerWidth || 1;
    const height = screen?.height || this.clientHeight || window.innerHeight || 1;
    const margin = VIEWPORT_FIT_MARGIN_PX;
    const currentScale = Math.max(0.001, this._state.viewport.scale || 1);
    const bothVisible = this._isWorldRectVisible(bounds, width, height, margin);
    const pastLod = this._shouldUseLowDetailNodeUi(created)
      || (source && source.kind !== "image" && this._shouldUseLowDetailNodeUi(source));
    // Already can see both with prompt UI readable — leave the camera alone.
    if (bothVisible && !pastLod) {
      done();
      return;
    }

    const lodScaleFor = (node) => {
      if (!node) return 0;
      return Math.max(
        MIN_UI_SCREEN_WIDTH / Math.max(1, node.width),
        MIN_UI_SCREEN_HEIGHT / Math.max(1, node.height),
      );
    };
    let lodScale = lodScaleFor(created);
    if (source && source.kind !== "image") lodScale = Math.max(lodScale, lodScaleFor(source));
    lodScale = Math.min(1, Math.max(MIN_VIEWPORT_SCALE, lodScale));

    // Scale that frames both nodes with margin — may require zooming out.
    const fitScale = this._fitScaleForWorldRect(bounds, width, height, margin);
    let targetScale = currentScale;

    // Prefer keeping both fully on screen: zoom out when the pair is larger
    // than the viewport at the current scale (pan alone cannot fix that).
    if (fitScale < currentScale - 0.001) {
      targetScale = fitScale;
    }

    // Zoom in only when past LoD, and only up to the readable threshold —
    // never past what still fits both.
    if (pastLod) {
      const readableAndFitting = Math.min(lodScale, fitScale);
      if (readableAndFitting > targetScale) targetScale = readableAndFitting;
    }

    if (Math.abs(targetScale - currentScale) < 0.001) {
      if (!bothVisible) {
        this._panWorldRectIntoView(bounds, { animate: true, onComplete: done });
        return;
      }
      done();
      return;
    }

    const viewport = this._viewportCenteredOnWorldRect(bounds, width, height, targetScale);
    this._animateViewport(viewport, 300, done);
  }

  _panWorldRectIntoView(rect, { animate = false, onComplete = null } = {}) {
    if (!rect) {
      onComplete?.();
      return;
    }
    const canvas = this.shadowRoot.getElementById("canvas");
    const bounds = canvas?.getBoundingClientRect();
    const width = bounds?.width || this.clientWidth || window.innerWidth || 1;
    const height = bounds?.height || this.clientHeight || window.innerHeight || 1;
    const margin = VIEWPORT_FIT_MARGIN_PX;
    const screenRect = this._worldRectToScreenRect(rect);
    const availableLeft = margin;
    const availableTop = margin;
    const availableRight = width - margin;
    const availableBottom = height - margin;
    let dx = 0;
    let dy = 0;
    if (screenRect.width > availableRight - availableLeft) dx = availableLeft - screenRect.x;
    else if (screenRect.x < availableLeft) dx = availableLeft - screenRect.x;
    else if (screenRect.x + screenRect.width > availableRight) dx = availableRight - (screenRect.x + screenRect.width);
    if (screenRect.height > availableBottom - availableTop) dy = availableTop - screenRect.y;
    else if (screenRect.y < availableTop) dy = availableTop - screenRect.y;
    else if (screenRect.y + screenRect.height > availableBottom) dy = availableBottom - (screenRect.y + screenRect.height);
    if (!dx && !dy) {
      onComplete?.();
      return;
    }
    const viewport = {
      x: this._state.viewport.x + dx,
      y: this._state.viewport.y + dy,
      scale: this._state.viewport.scale,
    };
    if (animate) this._animateViewport(viewport, 220, onComplete);
    else {
      this._applyViewport(viewport, { save: true });
      onComplete?.();
    }
  }

  _focusCropAndSource(source, crop) {
    const combined = unionRects([nodeRect(source), nodeRect(crop)]);
    if (!combined) return;
    const canvas = this.shadowRoot.getElementById("canvas");
    const bounds = canvas?.getBoundingClientRect();
    const width = bounds?.width || this.clientWidth || window.innerWidth || 1;
    const height = bounds?.height || this.clientHeight || window.innerHeight || 1;
    const margin = VIEWPORT_FIT_MARGIN_PX;
    const currentScale = this._state.viewport.scale || 1;
    if (this._worldRectFitsAtScale(combined, width, height, margin, currentScale)) {
      this._animateViewport(this._viewportCenteredOnWorldRect(combined, width, height, currentScale), 300);
      return;
    }
    this._fitWorldRectIntoView(combined, { animate: true });
  }

  _isWorldRectVisible(rect, width, height, margin) {
    const topLeft = this._worldToScreen(rect.x, rect.y);
    const bottomRight = this._worldToScreen(rect.x + rect.width, rect.y + rect.height);
    return topLeft.x >= margin
      && topLeft.y >= margin
      && bottomRight.x <= width - margin
      && bottomRight.y <= height - margin;
  }

  _worldRectFitsAtScale(rect, width, height, margin, scale) {
    const availableWidth = Math.max(1, width - margin * 2);
    const availableHeight = Math.max(1, height - margin * 2);
    return rect.width * scale <= availableWidth && rect.height * scale <= availableHeight;
  }

  _fitScaleForWorldRect(rect, width, height, margin) {
    const availableWidth = Math.max(1, width - margin * 2);
    const availableHeight = Math.max(1, height - margin * 2);
    const scaleW = availableWidth / Math.max(1, rect.width);
    const scaleH = availableHeight / Math.max(1, rect.height);
    return Math.min(1, Math.max(MIN_VIEWPORT_SCALE, Math.min(scaleW, scaleH)));
  }

  _viewportCenteredOnWorldRect(rect, width, height, scale) {
    return {
      x: width / 2 - (rect.x + rect.width / 2) * scale,
      y: height / 2 - (rect.y + rect.height / 2) * scale,
      scale,
    };
  }

  _viewportForWorldRect(rect, width, height, margin) {
    return this._viewportCenteredOnWorldRect(rect, width, height, this._fitScaleForWorldRect(rect, width, height, margin));
  }

  _animateViewport(target, durationMs, onComplete = null) {
    window.cancelAnimationFrame(this._viewportAnimation);
    const from = { ...this._state.viewport };
    if (target.scale !== from.scale) this._markZooming(durationMs + 80);
    const start = performance.now();
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      this._applyViewport({
        x: lerp(from.x, target.x, eased),
        y: lerp(from.y, target.y, eased),
        scale: lerp(from.scale, target.scale, eased),
      });
      if (progress < 1) {
        this._viewportAnimation = window.requestAnimationFrame(tick);
        return;
      }
      this._viewportAnimation = 0;
      this._queueSave();
      onComplete?.();
    };
    this._viewportAnimation = window.requestAnimationFrame(tick);
  }

  _queueSave() {
    if (!this._canEditCollab()) return;
    if (this._collabConnected && this._collabDocReady && this._canEditCollab()) {
      window.clearTimeout(this._saveTimer);
      this._scheduleCollabStateSync();
      window.clearTimeout(this._restSaveTimer);
      this._restSaveTimer = window.setTimeout(() => this._saveState().catch(() => null), 15000);
      return;
    }
    window.clearTimeout(this._saveTimer);
    this._saveTimer = window.setTimeout(() => {
      if (this._collabConnected && this._collabDocReady && this._canEditCollab()) {
        this._flushCollabStateSync();
        return;
      }
      this._saveState().catch(() => null);
    }, 600);
  }

  _scheduleCanvasPromptSuggestions({ delay = 1000 } = {}) {
    window.clearTimeout(this._promptSuggestionTimer);
    const prompts = this._recentCanvasPromptsForSuggestions();
    if (!prompts.length) return;
    this._promptSuggestionTimer = window.setTimeout(() => {
      this._promptSuggestionTimer = 0;
      this._refreshCanvasPromptSuggestions(prompts).catch(() => null);
    }, delay);
  }

  _ensureCanvasPromptSuggestionsOnLoad() {
    if (this._latestCanvasPromptSuggestions().length) return;
    const prompts = this._recentCanvasPromptsForSuggestions();
    if (!prompts.length) return;
    this._refreshCanvasPromptSuggestions(prompts).catch(() => null);
  }

  _recentCanvasPromptsForSuggestions() {
    return this._state.nodes
      .filter((node) => node && node.kind !== "image" && String(node.prompt || "").trim())
      .map((node, index) => {
        const metadata = safeParse(node.metadata_json || node.metadataJson) || {};
        return {
          prompt: String(node.prompt || "").trim(),
          updatedAt: Number(metadata.promptUpdatedAt || 0),
          index,
        };
      })
      .sort((a, b) => (b.updatedAt - a.updatedAt) || (b.index - a.index))
      .map((item) => item.prompt)
      .slice(0, 5);
  }

  async _refreshCanvasPromptSuggestions(prompts = this._recentCanvasPromptsForSuggestions()) {
    // Suggestions are a billed model call behind edit access; viewers must not ask.
    if (!this._projectId || !prompts.length || !this._canEditCollab()) return;
    const contextKey = prompts.join("\n---\n");
    if (contextKey === this._lastPromptSuggestionContextKey) return;
    const seq = ++this._promptSuggestionRequestSeq;
    // Best effort: the server reads the prompts it rewrites out of the request
    // body, so a save that lost a compare-and-set is no reason to skip them.
    await this._saveState().catch(() => null);
    const data = await this._api(`/api/projects/${encodeURIComponent(this._projectId)}/canvas/prompt-suggestions`, {
      method: "POST",
      body: JSON.stringify({ prompts }),
    });
    if (seq !== this._promptSuggestionRequestSeq) return;
    this._lastPromptSuggestionContextKey = contextKey;
    this._applyCanvasPromptSuggestions(data?.suggestions, data?.canvas?.state || safeParse(data?.canvas?.stateJson));
  }

  _applyCanvasPromptSuggestions(suggestions, state = null) {
    const metadata = this._normalizeCanvasMetadata(state?.metadata || this._canvasMetadata);
    const cleanSuggestions = Array.isArray(suggestions)
      ? suggestions
          .map((item) => ({
            label: String(item?.label || "").trim(),
            prompt: String(item?.prompt || "").trim(),
          }))
          .filter((item) => item.label && item.prompt)
          .slice(0, PROMPT_SUGGESTION_COUNT)
      : [];
    if (cleanSuggestions.length) {
      metadata.promptSuggestions = {
        ...(metadata.promptSuggestions || {}),
        suggestions: cleanSuggestions,
        updatedAt: Date.now(),
      };
    }
    this._canvasMetadata = this._normalizeCanvasMetadata(metadata);
    this._state.metadata = this._canvasMetadata;
    this._syncPromptOverlays();
  }

  // Saves are compare-and-set against the version this tab last read. Without
  // that check a save built before another writer's change silently deletes it,
  // which is how MCP-staged prompt nodes used to disappear mid-generation.
  //
  // Everything routes through the queue: a save asked for while one is open
  // collapses into a single follow-up rather than racing the open write with the
  // same baseVersion, which used to make this tab conflict with itself.
  _saveState() {
    if (!this._projectId || !this._canEditCollab()) return Promise.resolve();
    return this._saveQueue.run();
  }

  // One logical save: write, and on a conflict rebase onto the document the
  // server returned and write again. The version moves once per committed image
  // while a generation runs, so a single retry is not enough — it lands on a
  // version that has already moved on, and the caller (double-click, most
  // visibly) sees the 409.
  async _writeCanvasState() {
    if (!this._projectId || !this._canEditCollab()) return;
    for (let attempt = 1; ; attempt += 1) {
      const state = withoutPendingUploadNodes({ ...this._state, metadata: this._normalizeCanvasMetadata(this._canvasMetadata), comments: this._normalizeCanvasComments(this._comments) });
      const stateJSON = JSON.stringify(state);
      if (stateJSON === this._lastSavedStateJSON) return;
      try {
        const data = await this._api(`/api/projects/${encodeURIComponent(this._projectId)}/canvas`, {
          method: "PUT",
          body: JSON.stringify({ state, baseVersion: this._canvasVersion || 0 }),
        });
        this._canvasVersion = Number(data?.canvas?.version) || 0;
        this._lastSavedStateJSON = stateJSON;
        return;
      } catch (err) {
        if (err?.status !== 409 || attempt >= CANVAS_SAVE_ATTEMPTS) throw err;
        await this._rebaseOnRemoteCanvas(err?.data?.canvas);
        // Jittered so two tabs that just conflicted do not wake on the same tick
        // and conflict again.
        await new Promise((resolve) => window.setTimeout(resolve, canvasSaveRetryDelayMs(attempt)));
      }
    }
  }

  // Move to a version another writer reported, so the next save is not built on
  // a baseVersion this tab knows is stale. Never moves backwards: project events
  // and in-flight save responses can arrive out of order.
  _adoptCanvasVersion(version) {
    const next = Number(version) || 0;
    if (next > (this._canvasVersion || 0)) this._canvasVersion = next;
  }

  // Take the document the conflict response returned, adopt everything this tab
  // is missing from it, and move to its version so the retry writes on top of
  // the other client's work instead of over it.
  async _rebaseOnRemoteCanvas(canvas) {
    this._canvasVersion = Number(canvas?.version) || 0;
    const state = canvas?.state || safeParse(canvas?.stateJson);
    if (!state) return;
    this._mergeCommittedCanvasImages(state, { skipSave: true });
  }

  _ensureSocket() {
    if (this._wsProjectId === this._projectId && this._ws && this._ws.readyState !== WebSocket.CLOSED) return;
    if (this._ws) {
      this._closeSocket();
    } else {
      window.clearTimeout(this._wsReconnectTimer);
      this._wsReconnectTimer = 0;
    }
    const embed = window.DIFFUI_EMBED === true;
    const projectId = this._projectId;
    const base = embed ? new URL(resolveEmbedApiUrl("/")) : new URL(window.location.href);
    const proto = base.protocol === "https:" ? "wss:" : "ws:";
    this._wsProjectId = projectId;
    let wsPath = `${proto}//${base.host}/api/projects/${encodeURIComponent(projectId)}/watch`;
    const token = String(window.DIFFUI_API_KEY || "").trim();
    if (embed && token) {
      wsPath += `?access_token=${encodeURIComponent(token)}`;
    }
    const ws = new WebSocket(withPublicShareParam(wsPath));
    this._ws = ws;
    ws.addEventListener("open", () => {
      if (this._ws !== ws) return;
      this._wsReconnectAttempt = 0;
      this._wsLastCloseEvent = null;
      this._wsConnectedAt = Date.now();
      this._wsLastEvent = "open";
      this._mergeCommittedCanvasImagesFromServer().catch(() => null);
    });
    ws.addEventListener("message", (event) => {
      const payload = safeParse(event.data);
      if (payload) this._handleProjectEvent(payload);
    });
    ws.addEventListener("close", (event) => {
      if (this._ws !== ws) return;
      const reconnectAttempt = Number(this._wsReconnectAttempt || 0);
      const shouldReport = event.code !== 1000
        && (reconnectAttempt === 0 || (reconnectAttempt & (reconnectAttempt - 1)) === 0);
      if (shouldReport) {
        reportError(`canvas_project_websocket_closed_${event.code || 1006}`, {
          component: "diffui-canvas-workspace",
          category: "websocket",
          operation: "canvas_project_socket_close",
          projectId,
          metadata: {
            close_code: event.code || 1006,
            close_reason: event.reason || "",
            was_clean: event.wasClean === true,
            ready_state: ws.readyState,
            reconnect_attempt: reconnectAttempt,
            connected_ms: this._wsConnectedAt ? Date.now() - this._wsConnectedAt : 0,
            last_event: this._wsLastEvent,
            browser_online: navigator.onLine,
          },
        });
      }
      this._ws = null;
      this._wsLastCloseEvent = event;
      if (this._wsProjectId === this._projectId && this.isConnected) this._scheduleSocketReconnect();
    });
  }

  _closeSocket() {
    window.clearTimeout(this._wsReconnectTimer);
    this._wsReconnectTimer = 0;
    if (this._ws) {
      try { this._ws.close(); } catch { /* ignore */ }
    }
    this._ws = null;
    this._wsProjectId = "";
    this._wsReconnectAttempt = 0;
    this._wsLastCloseEvent = null;
    this._wsConnectedAt = 0;
    this._wsLastEvent = "";
  }

  _scheduleSocketReconnect() {
    window.clearTimeout(this._wsReconnectTimer);
    const delay = reconnectDelay(this._wsReconnectAttempt);
    this._wsReconnectAttempt += 1;
    this._wsReconnectTimer = window.setTimeout(async () => {
      this._wsReconnectTimer = 0;
      if (looksLikeAuthClose(this._wsLastCloseEvent) && !window.DIFFUI_EMBED && !isPublicShareViewer()) {
        if (!(await isSessionValid())) {
          notifySessionExpired();
          return;
        }
      }
      if (this.isConnected && this._projectId && this._wsProjectId === this._projectId) this._ensureSocket();
    }, delay);
  }

  _applyCanvasGenerationStarted(payload) {
    const promptNodeId = String(payload.nodeId || payload.promptNodeId || "");
    const slotNodeIds = Array.isArray(payload.slotNodeIds) ? payload.slotNodeIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
    const requestId = String(payload.requestId || "");
    if (!promptNodeId || !slotNodeIds.length) return;
    this._activeCanvasGenerationNodeIds.add(promptNodeId);
    const node = this._state.nodes.find((item) => item.id === promptNodeId);
    if (!node) return;
    const existingImages = this._nodeImages(node);
    const existingIds = new Set(existingImages.map((image) => image.id));
    const prompt = String(node.prompt || "").trim();
    const metadata = safeParse(node.metadata_json || node.metadataJson) || {};
    if (requestId && metadata.generationRequestId && metadata.generationRequestId !== requestId && metadata.generating) {
      return;
    }
    const newSlots = slotNodeIds.filter((slotId) => !existingIds.has(slotId));
    const newImages = newSlots.map((slotId, index) => ({
      id: slotId,
      name: `Image ${existingImages.length + index + 1}`,
      image_url: "",
      status: "loading",
      metadata_json: JSON.stringify({
        source: "generation",
        promptNodeId: node.id,
        originalPrompt: prompt,
        slotIndex: existingImages.length + index,
        requestId,
        // When this slot started waiting, so a request that never reached the
        // server can be told apart from one still running. See
        // abandonedGenerationRequests.
        startedAt: Date.now(),
      }),
    }));
    const nextMetadata = {
      ...metadata,
      generating: true,
      generationRequestId: requestId || metadata.generationRequestId || "",
    };
    const patch = {
      status: "loading",
      metadataJson: JSON.stringify(nextMetadata),
    };
    if (newImages.length) {
      patch.images = [...existingImages, ...newImages];
    }
    this._patchNode(node.id, patch, { quiet: true });
    this._syncPromptOverlays();
    this._draw();
    if (this._collabConnected) this._flushCollabStateSync();
  }

  _clearNodeGenerationState(nodeId, requestId = "", { removeLoadingSlots = false, errorMessage = "", error = null } = {}) {
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const metadata = safeParse(node.metadata_json || node.metadataJson) || {};
    if (requestId && metadata.generationRequestId && metadata.generationRequestId !== requestId) return;
    let images = this._nodeImages(node);
    let removedSlots = 0;
    if (removeLoadingSlots) {
      const dropped = withoutFailedGenerationSlots(images, requestId);
      images = dropped.images;
      removedSlots = dropped.removed;
    }
    const nextMetadata = this._syncNodeGenerationMetadata(metadata, images);
    if (error) {
      nextMetadata.generationError = {
        code: String(error.code || "generation_failed"),
        message: String(error.message || "Generation failed"),
        // How many options Retry should re-queue: the slots this failure stranded,
        // or the count a previous report of the same failure already recorded.
        count: Math.max(1, removedSlots || Number(error.count) || Number(metadata.generationError?.count) || 1),
      };
    }
    const readyImages = this._readyImagesForNode({ ...node, images });
    const activeImage = readyImages[0] || images[0];
    const stillLoading = images.some((image) => image.status === "loading");
    this._patchNode(node.id, {
      images,
      status: stillLoading ? "loading" : (readyImages.length ? "ready" : node.status),
      imageUrl: activeImage?.image_url || activeImage?.imageUrl || "",
      metadataJson: JSON.stringify(nextMetadata),
    }, { quiet: true });
    this._syncPromptOverlays();
    this._draw();
    if (errorMessage) this._setStatus(errorMessage);
    if (removedSlots || error) {
      // Dropping slots lowers the collab state rank, so a plain sync loses to the
      // peer/CRDT copy that still holds them and the spinners come straight back.
      // Commit it as an authoritative revision, the same as any other removal.
      this._commitCollabState();
      return;
    }
    if (this._collabConnected) this._flushCollabStateSync();
  }

  _applyCanvasInpaintStarted(payload) {
    const nodeId = String(payload.nodeId || payload.sourceNodeId || "");
    const rawSlotNodeId = String(payload.rawSlotNodeId || payload.rawSlotId || "");
    const requestId = String(payload.requestId || "");
    if (!nodeId || !rawSlotNodeId) return;
    this._activeCanvasGenerationNodeIds.add(nodeId);
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const existingImages = this._nodeImages(node);
    const cropRect = this._normalizeInpaintCropRect(payload.cropRect || payload.crop_rect);
    const inpaintCropPercent = this._normalizeInpaintCropPercent(payload.inpaintCropPercent || payload.inpaint_crop_percent)
      || (cropRect ? this._inpaintCropPercentForNode(node, cropRect) : null);
    if (existingImages.some((image) => image.id === rawSlotNodeId)) {
      const metadata = safeParse(node.metadata_json || node.metadataJson) || {};
      const images = existingImages.map((image) => {
        if (image.id !== rawSlotNodeId) return image;
        const slotMeta = this._imageMetadata(image);
        return {
          ...image,
          status: "loading",
          metadata_json: JSON.stringify({
            ...slotMeta,
            source: "inpaint",
            requestId: requestId || slotMeta.requestId || "",
            ...(cropRect ? { inpaintCropRect: cropRect, inpaintCropPercent } : {}),
          }),
        };
      });
      this._patchNode(node.id, {
        images,
        status: "loading",
        metadataJson: JSON.stringify({
          ...metadata,
          inpaintGenerating: true,
          inpaintRequestId: requestId || metadata.inpaintRequestId || "",
        }),
      }, { quiet: true });
      this._syncPromptOverlays();
      this._draw();
      return;
    }
    const sourceImage = this._activeImageForNode(node);
    const sourceImageUrl = sourceImage?.image_url || sourceImage?.imageUrl || "";
    const rawSlot = {
      id: rawSlotNodeId,
      name: "Inpaint edit",
      image_url: sourceImageUrl,
      status: "loading",
      metadata_json: JSON.stringify({
        source: "inpaint",
        variant: "openai_raw",
        promptNodeId: node.id,
        requestId,
        slotIndex: 0,
        sourceImageId: String(payload.sourceImageId || sourceImage?.id || ""),
        ...(cropRect ? { inpaintCropRect: cropRect, inpaintCropPercent } : {}),
      }),
    };
    const metadata = safeParse(node.metadata_json || node.metadataJson) || {};
    this._patchNode(node.id, {
      images: [rawSlot, ...existingImages],
      stackIndex: 0,
      stack_index: 0,
      status: "loading",
      imageUrl: sourceImageUrl,
      metadataJson: JSON.stringify({
        ...metadata,
        inpaintGenerating: true,
        inpaintRequestId: requestId,
      }),
    }, { quiet: true });
    this._syncPromptOverlays();
    this._draw();
    if (this._collabConnected) this._flushCollabStateSync();
  }

  _applyGenerationJobsSnapshot(payload) {
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    const activeCanvasNodeIds = new Set();
    const liveRequestIds = new Set();
    let touched = false;
    for (const job of jobs) {
      const kind = String(job?.kind || "");
      const status = String(job?.status || "");
      if (status !== "queued" && status !== "running") continue;
      const liveRequestId = String(job?.requestId || job?.payload?.requestId || "");
      if (liveRequestId) liveRequestIds.add(liveRequestId);
      if (kind === "canvas_generate") {
        const nodeId = String(job?.payload?.nodeId || "");
        if (nodeId) activeCanvasNodeIds.add(nodeId);
        this._applyCanvasGenerationStarted({
          requestId: job.requestId || job?.payload?.requestId || "",
          nodeId: job?.payload?.nodeId || "",
          slotNodeIds: job?.payload?.slotNodeIds || [],
        });
        const slots = Array.isArray(job.slots) ? job.slots : [];
        for (const slot of slots) {
          if (slot?.status !== "completed" || !slot?.imageId) continue;
          // Committed images are merged from server canvas state on socket open;
          // keep loading placeholders for unfinished slots only.
        }
        touched = true;
      } else if (kind === "canvas_inpaint") {
        const nodeId = String(job?.payload?.sourceNodeId || "");
        if (nodeId) activeCanvasNodeIds.add(nodeId);
        this._applyCanvasInpaintStarted({
          requestId: job.requestId || job?.payload?.requestId || "",
          nodeId: job?.payload?.sourceNodeId || "",
          sourceImageId: job?.payload?.sourceImageId || "",
          rawSlotNodeId: job?.payload?.rawSlotNodeId || "",
          cropRect: job?.payload?.cropRect || null,
        });
        touched = true;
      }
    }
    this._activeCanvasGenerationNodeIds = activeCanvasNodeIds;
    this._clearAbandonedGenerationState(liveRequestIds);
    if (touched || !activeCanvasNodeIds.size) {
      this._mergeCommittedCanvasImagesFromServer({ reconcileGenerationState: true }).catch(() => null);
      this._syncPromptOverlays();
      this._draw();
    }
  }

  // The snapshot is the only authority on what is really running. Slots left
  // waiting on a request it does not name will never be filled, and nothing else
  // clears them — the node spins forever, and every generate on it is refused as
  // a duplicate of the run "in flight".
  _clearAbandonedGenerationState(liveRequestIds) {
    const abandoned = abandonedGenerationRequests({
      nodes: this._state.nodes,
      liveRequestIds,
      now: Date.now(),
    });
    for (const { nodeId, requestId } of abandoned) {
      const message = "Generation never started. Try again.";
      this._logStackAdd("clearing abandoned generation slots", { nodeId, requestId });
      this._clearNodeGenerationState(nodeId, requestId, {
        removeLoadingSlots: true,
        error: { code: "generation_abandoned", message },
      });
    }
  }

  _handleProjectEvent(payload) {
    this._wsLastEvent = String(payload?.type || "unknown");
    if (payload.type === "access_lost") {
      // The share link stopped granting access. Stop the event stream rather than
      // letting the reconnect loop retry a handshake that can only 401 now.
      this._closeSocket();
      this._setStatus("Access revoked");
      return;
    }
    if (payload.type === "generation_jobs_snapshot") {
      this._applyGenerationJobsSnapshot(payload);
      return;
    }
    if (payload.type === "canvas_thumbnail_started") {
      this._thumbnailRegenerating = true;
      this._projectThumbnailStatus = "generating";
      this.shadowRoot.getElementById("regenerateThumbnailBtn")?.setAttribute("state", "in-progress");
      this._syncFileSettingsEditableState();
      this._syncFileSettingsThumbnail();
      return;
    }
    if (payload.type === "canvas_thumbnail") {
      this._finishThumbnailRegeneration({
        success: true,
        thumbnailUrl: String(payload.thumbnailUrl || ""),
      });
      return;
    }
    if (payload.type === "canvas_thumbnail_error") {
      this._finishThumbnailRegeneration({
        success: false,
        message: String(payload.error || "Thumbnail regeneration failed"),
      });
      return;
    }
    if (payload.type === "bb_build_status") {
      const bundle = String(payload.bundle || "design").trim() || "design";
      if (payload.status === "idle") {
        this._showToast(`bb finished building ${bundle}`);
        this._setStatus("bb build finished");
      } else {
        this._showToast(`bb build failed: ${bundle}`);
        this._setStatus("bb build failed");
      }
      return;
    }
    if (payload.type === "canvas_generation_started") {
      this._applyCanvasGenerationStarted(payload);
      return;
    }
    if (payload.type === "canvas_generation_done") {
      const promptNodeId = String(payload.nodeId || payload.promptNodeId || "");
      const node = this._state.nodes.find((item) => item.id === promptNodeId);
      if (promptNodeId) this._activeCanvasGenerationNodeIds.delete(promptNodeId);
      if (!node) {
        this._mergeCommittedCanvasImagesFromServer({ reconcileGenerationState: true }).catch(() => null);
        return;
      }
      const metadata = safeParse(node.metadata_json || node.metadataJson) || {};
      const images = this._nodeImages(node);
      const stillLoading = images.some((image) => image.status === "loading");
      const nextMetadata = this._syncNodeGenerationMetadata(metadata, images);
      this._patchNode(node.id, {
        metadataJson: JSON.stringify(nextMetadata),
        status: stillLoading ? "loading" : (this._readyImagesForNode(node).length ? "ready" : node.status),
      }, { quiet: true });
      this._syncPromptOverlays();
      this._draw();
      if (this._collabConnected) this._flushCollabStateSync();
      this._mergeCommittedCanvasImagesFromServer({ reconcileGenerationState: true }).catch(() => null);
      return;
    }
    if (payload.type === "canvas_inpaint_started") {
      this._applyCanvasInpaintStarted(payload);
      return;
    }
    if (payload.type === "canvas_click_prompt_started") {
      this._setStatus("Detecting clicked object...");
    }
    if (payload.type === "canvas_click_prompt_ready") {
      const targetNodeId = String(payload.targetNodeId || "");
      const node = this._state.nodes.find((item) => item.id === targetNodeId);
      if (!node) return;
      const metadata = safeParse(node.metadata_json) || {};
      const requestId = String(payload.requestId || "");
      if (metadata.clickPromptRequestId && requestId && metadata.clickPromptRequestId !== requestId) return;
      const prompt = String(payload.prompt || "").trim();
      if (!prompt) {
        this._markClickPromptError(targetNodeId, requestId, "Click prompt was empty");
        return;
      }
      const nextMetadata = {
        ...metadata,
        clickPromptStatus: "typing",
        clickedLabel: payload.clickedLabel || "",
        clickedKind: payload.clickedKind || "",
        productName: payload.productName || "",
        clickPromptConfidence: Number(payload.confidence || 0),
      };
      this._patchNode(targetNodeId, {
        prompt: "",
        name: payload.clickedLabel ? `${payload.clickedLabel} prompt` : node.name || "Prompt",
        metadataJson: JSON.stringify(nextMetadata),
      }, { quiet: true });
      this._syncPromptOverlays();
      this._draw();
      this._setStatus("Writing prompt...");
      this._typePromptIntoNode(targetNodeId, prompt, nextMetadata, {
        autoGenerate: shouldAutoGenerateClickPrompt({
          initiatorClientId: payload.initiatorClientId,
          localClientId: this._collabClientId(),
        }),
      });
      return;
    }
    if (payload.type === "canvas_click_prompt_error") {
      this._markClickPromptError(String(payload.targetNodeId || ""), String(payload.requestId || ""), payload.error || "Click prompt failed");
      return;
    }
    if (payload.type === "canvas_image_partial") {
      const slotNodeId = String(payload.slotNodeId || "");
      const promptNodeId = String(payload.promptNodeId || payload.nodeId || "");
      const node = this._state.nodes.find((item) => item.id === promptNodeId)
        || this._state.nodes.find((item) => this._nodeImages(item).some((entry) => entry.id === slotNodeId));
      if (!node) return;
      const images = this._nodeImages(node).slice();
      const slotIndex = images.findIndex((entry) => entry.id === slotNodeId);
      if (slotIndex < 0) return;
      const slotMetadata = safeParse(images[slotIndex]?.metadata_json) || {};
      if (String(slotMetadata.source || "") === "inpaint") return;
      const imageUrl = displayUrlForGenerationFileUrl(payload.imageUrl || "");
      if (!imageUrl) return;
      const previousActiveId = this._activeImageForNode(node)?.id || "";
      const partialOrder = this._nextPartialOrder(images, slotIndex);
      images[slotIndex] = {
        ...images[slotIndex],
        status: "loading",
        image_url: imageUrl,
        metadata_json: JSON.stringify({
          ...slotMetadata,
          partial: true,
          partialIndex: Number(payload.partialIndex ?? 0),
          partialOrder,
        }),
      };
      const orderedImages = this._orderImagesByPartialArrival(this._moveImageIntoNextEmptyImageSlot(images, slotIndex));
      const readyOrderedImages = this._readyImagesForNode({ ...node, images: orderedImages });
      const preservedActiveIndex = previousActiveId ? readyOrderedImages.findIndex((entry) => entry.id === previousActiveId) : -1;
      const activeImage = readyOrderedImages[preservedActiveIndex >= 0 ? preservedActiveIndex : this._activeImageIndex(node, readyOrderedImages)] || readyOrderedImages[0] || orderedImages[0] || images[slotIndex];
      this._patchNode(node.id, {
        images: orderedImages,
        status: "loading",
        imageUrl: activeImage?.image_url || "",
        ...(preservedActiveIndex >= 0 ? { stackIndex: preservedActiveIndex, stack_index: preservedActiveIndex } : {}),
      }, { quiet: true });
      this._syncPromptOverlays();
      this._syncToolbar();
      this._draw();
      if (this._collabConnected) this._scheduleCollabStateSync();
      return;
    }
    if (payload.type === "canvas_image_analysis") {
      const imageId = String(payload.imageId || "").trim();
      if (!imageId) return;
      const terminalStatus = String(payload.analysisStatus || "").trim();
      if (!payload.expandedPrompt && terminalStatus !== "error" && terminalStatus !== "done") return;
      const node = this._state.nodes.find((item) => this._nodeImages(item).some((entry) => {
        const metadata = safeParse(entry?.metadata_json || entry?.metadataJson) || {};
        return String(metadata.imageId || "").trim() === imageId;
      }));
      if (!node) {
        this._mergeCommittedCanvasImagesFromServer().catch(() => null);
        return;
      }
      const images = this._nodeImages(node).map((entry) => {
        const metadata = safeParse(entry?.metadata_json || entry?.metadataJson) || {};
        if (String(metadata.imageId || "").trim() !== imageId) return entry;
        const patch = { ...metadata, analysisStatus: terminalStatus || "done" };
        if (payload.expandedPrompt) patch.expandedPrompt = payload.expandedPrompt;
        if (terminalStatus === "error" && payload.analysisError) patch.analysisError = payload.analysisError;
        return {
          ...entry,
          metadata_json: JSON.stringify(patch),
        };
      });
      this._patchNode(node.id, { images }, { quiet: true });
      this._syncPromptOverlays();
      this._syncToolbar();
      this._draw();
      if (this._collabConnected) this._flushCollabStateSync();
      return;
    }
    if (payload.type === "canvas_image") {
      const image = payload.image || {};
      const slotNodeId = payload.slotNodeId || "";
      const promptNodeId = payload.promptNodeId || payload.nodeId || "";
      const node = this._state.nodes.find((item) => item.id === promptNodeId)
        || this._state.nodes.find((item) => this._nodeImages(item).some((entry) => entry.id === slotNodeId));
      if (!node) {
        this._mergeCommittedCanvasImagesFromServer().catch(() => null);
        return;
      }
      const images = this._nodeImages(node).slice();
      const slotIndex = images.findIndex((entry) => entry.id === slotNodeId);
      if (slotIndex < 0) {
        this._mergeCommittedCanvasImagesFromServer().catch(() => null);
        return;
      }
      const metadata = safeParse(images[slotIndex]?.metadata_json) || {};
      const imageUrl = displayUrlForGenerationFileUrl(image.fileUrl || image.imageUrl || image.url || "");
      const textExpansionStrategy = String(image.textExpansionStrategy || metadata.textExpansionStrategy || "").trim();
      const previousActiveId = this._activeImageForNode(node)?.id || "";
      const inpaintSlot = this._inpaint?.generating
        && String(payload.requestId || "") === this._inpaint.requestId
        && this._inpaint.rawSlotId === slotNodeId;
      images[slotIndex] = {
        ...images[slotIndex],
        status: "ready",
        image_url: imageUrl,
        metadata_json: JSON.stringify({
          ...metadata,
          source: "generation",
          imageId: image.id || "",
          model: image.modelId || image.model || image.generation_model || "",
          expandedPrompt: image.promptJson || null,
          textExpansionStrategy,
          ...(textExpansionStrategy === "prompt_only" ? { analysisStatus: "processing" } : {}),
          brand: image.brand || null,
          brandInputs: Array.isArray(image.brandInputs) ? image.brandInputs : [],
          partial: false,
        }),
      };
      const orderedImages = inpaintSlot ? images : this._orderImagesByPartialArrival(this._moveImageIntoNextEmptyImageSlot(images, slotIndex));
      const readyOrderedImages = this._readyImagesForNode({ ...node, images: orderedImages });
      const preservedActiveIndex = previousActiveId ? readyOrderedImages.findIndex((entry) => entry.id === previousActiveId) : -1;
      const activeImage = inpaintSlot
        ? orderedImages[slotIndex]
        : readyOrderedImages[preservedActiveIndex >= 0 ? preservedActiveIndex : 0] || orderedImages[0] || images[slotIndex];
      if (inpaintSlot) this._retireInpaintSelectionVisuals();
      const stillLoading = orderedImages.some((image) => image.status === "loading");
      const nextMetadata = inpaintSlot
        ? { ...(safeParse(node.metadata_json) || {}), generating: false }
        : this._syncNodeGenerationMetadata(safeParse(node.metadata_json) || {}, orderedImages);
      this._patchNode(node.id, {
        images: orderedImages,
        status: stillLoading ? "loading" : "ready",
        imageUrl: activeImage?.image_url || "",
        ...(inpaintSlot ? { stackIndex: slotIndex, stack_index: slotIndex } : preservedActiveIndex >= 0 ? { stackIndex: preservedActiveIndex, stack_index: preservedActiveIndex } : {}),
        metadataJson: JSON.stringify(nextMetadata),
      });
      // The commit that produced this image bumped the document version. The
      // slot it landed in is now identical here, so this tab may write at that
      // version — and must, or a generation that commits N images leaves it
      // N versions stale and every save of the run has to rebase out of a 409.
      this._adoptCanvasVersion(payload.canvasVersion);
      this._maybeFinishInpaintRequest(payload);
      this._syncPromptOverlays();
      this._notifyCanvasCoach("generation-ready", { nodeId: node.id });
      this._setStatus(`Generated ${images[slotIndex].name || node.name || "image"}`);
      if (this._collabConnected) this._flushCollabStateSync();
      return;
    }
    if (payload.type === "canvas_comments") {
      this._applyRemoteComments(payload.comments, payload.collabRev);
      return;
    }
    if (payload.type === "canvas_node_added") {
      const node = payload.node;
      if (!node?.id) return;
      if (this._state.nodes.some((item) => item.id === node.id)) return;
      this._addNode(node);
      this._setStatus(`Added ${node.name || "image"} to canvas`);
      return;
    }
    if (payload.type === "canvas_state") {
      const state = payload.canvas?.state || safeParse(payload.canvas?.stateJson);
      if (state?.metadata) {
        this._canvasMetadata = this._normalizeCanvasMetadata(state.metadata);
        this._state.metadata = this._canvasMetadata;
        this._syncPromptOverlays();
      }
      this._mergeCommittedCanvasImages(state);
      // Only after the merge: the version may only be adopted once this tab's
      // document is a superset of the one it names, or the next save writes at
      // that version without the nodes it introduced and deletes them.
      this._adoptCanvasVersion(payload.version ?? payload.canvas?.version);
    }
    if (payload.type === "canvas_prompt_suggestions") {
      this._applyCanvasPromptSuggestions(payload.suggestions, payload.canvas?.state || safeParse(payload.canvas?.stateJson));
      return;
    }
    if (payload.type === "canvas_asset_analysis") {
      const asset = payload.asset || {};
      const assetId = String(asset.id || "").trim();
      if (!assetId) return;
      console.log("[diffui] canvas_asset_analysis", {
        assetId,
        analysisStatus: asset.analysisStatus ?? asset.analysis_status,
        promptReady: asset.promptReady ?? asset.prompt_ready,
      });
      let updated = false;
      this._state.nodes
        .filter((node) => this._nodeImages(node).length)
        .forEach((node) => {
          const images = this._nodeImages(node).slice();
          let nodeChanged = false;
          const nextImages = images.map((image) => {
            const metadata = safeParse(image.metadata_json) || {};
            if (String(metadata.assetId || "") !== assetId) return image;
            nodeChanged = true;
            return {
              ...image,
              metadata_json: JSON.stringify({
                ...metadata,
                ...assetAnalysisMetadata(asset),
              }),
            };
          });
          if (!nodeChanged) return;
          this._patchNode(node.id, {
            images: nextImages,
          }, { quiet: true });
          updated = true;
        });
      if (!updated && this._pendingImageUploads.size) {
        // The paste that owns this asset is still uploading, so no node names it
        // yet. Park the result; the upload applies it when the id lands.
        this._pendingAssetAnalysis.set(assetId, asset);
      }
      if (updated) {
        const pageTitle = canvasAssetPageTitle(asset);
        const fileTitle = canvasAssetFileTitle(asset);
        if (pageTitle) {
          this._state.nodes
            .filter((node) => this._nodeImages(node).some((image) => {
              const metadata = safeParse(image.metadata_json) || {};
              return String(metadata.assetId || "") === assetId;
            }))
            .forEach((node) => {
              this._patchNode(node.id, { name: pageTitle }, { quiet: true });
              this._maybeApplySuggestedFileTitle(fileTitle, node);
            });
        }
        if (asset.analysisStatus === "error") {
          this._state.nodes
            .filter((node) => this._nodeImages(node).some((image) => {
              const metadata = safeParse(image.metadata_json) || {};
              return String(metadata.assetId || "") === assetId;
            }))
            .forEach((node) => {
              if (String(node.name || "").trim() === "Analyzing...") {
                this._patchNode(node.id, { name: "Pasted image" }, { quiet: true });
              }
            });
        }
        this._draw();
        this._syncPromptOverlays();
        this._setStatus(asset.analysisStatus === "done" ? "Pasted image analyzed" : asset.analysisError || "Image analysis updated");
      }
    }
    if (payload.type === "canvas_generation_error") {
      const requestId = String(payload.requestId || "");
      const rawError = String(payload.error || "");
      const billingError = isWalletBillingError(rawError);
      // A failed slot never fills in, so keeping it as a loading placeholder leaves
      // the node spinning forever; drop it and leave an error the user can retry.
      const message = billingError ? "Not enough credits to finish this generation." : "Generation failed.";
      if (billingError && this._claimFailedGenerationRequest(requestId)) this._notifyCanvasWalletBlocked(rawError);
      this._markInpaintRequestDone(requestId, { error: true });
      const promptNodeId = String(payload.nodeId || payload.promptNodeId || "");
      if (promptNodeId) {
        this._activeCanvasGenerationNodeIds.delete(promptNodeId);
        this._clearNodeGenerationState(promptNodeId, requestId, {
          removeLoadingSlots: true,
          errorMessage: message,
          error: { code: billingError ? "insufficient_wallet" : "generation_failed", message },
        });
      } else {
        this._setStatus(message);
      }
      if (this._collabConnected) this._flushCollabStateSync();
      this._mergeCommittedCanvasImagesFromServer({ reconcileGenerationState: true }).catch(() => null);
      return;
    }
    if ((payload.type === "generation_job_done" || payload.type === "generation_job_error")
      && (payload.kind === "canvas_generate" || payload.kind === "canvas_inpaint")) {
      const requestId = String(payload.requestId || "");
      const failed = payload.type === "generation_job_error";
      if (requestId) {
        const nodeIds = this._state.nodes
          .filter((node) => {
            const metadata = safeParse(node.metadata_json || node.metadataJson) || {};
            return metadata.generationRequestId === requestId || metadata.inpaintRequestId === requestId;
          })
          .map((node) => node.id);
        nodeIds.forEach((nodeId) => this._activeCanvasGenerationNodeIds.delete(nodeId));
        if (failed) {
          // The canvas_generation_error for this job can be missed (backgrounded
          // tab, dropped socket); without this the slots reconcile as still
          // pending and spin forever.
          const rawError = String(payload.error || "");
          const billingError = isWalletBillingError(rawError);
          const message = billingError ? "Not enough credits to finish this generation." : "Generation failed.";
          if (billingError && this._claimFailedGenerationRequest(requestId)) this._notifyCanvasWalletBlocked(rawError);
          this._markInpaintRequestDone(requestId, { error: true });
          nodeIds.forEach((nodeId) => {
            this._clearNodeGenerationState(nodeId, requestId, {
              removeLoadingSlots: true,
              errorMessage: message,
              error: { code: billingError ? "insufficient_wallet" : "generation_failed", message },
            });
          });
        }
      }
      this._mergeCommittedCanvasImagesFromServer({ reconcileGenerationState: true }).catch(() => null);
      return;
    }
    if (payload.type === "canvas_inpaint_done") {
      const requestId = String(payload.requestId || "");
      this._markInpaintRequestDone(requestId);
      const nodeId = String(payload.nodeId || "");
      if (nodeId) this._activeCanvasGenerationNodeIds.delete(nodeId);
      const node = nodeId ? this._state.nodes.find((item) => item.id === nodeId) : null;
      if (node) {
        const metadata = safeParse(node.metadata_json || node.metadataJson) || {};
        if (!requestId || !metadata.inpaintRequestId || metadata.inpaintRequestId === requestId) {
          delete metadata.inpaintGenerating;
          delete metadata.inpaintRequestId;
          this._patchNode(node.id, { metadataJson: JSON.stringify(metadata) }, { quiet: true });
          this._syncPromptOverlays();
          this._draw();
          if (this._collabConnected) this._flushCollabStateSync();
        }
      }
      this._mergeCommittedCanvasImagesFromServer({ reconcileGenerationState: true }).catch(() => null);
      return;
    }
  }

  _maybeFinishInpaintRequest(payload) {
    const requestId = String(payload?.requestId || "");
    if (!this._inpaint?.generating || !requestId || this._inpaint.requestId !== requestId) return;
    const node = this._state.nodes.find((item) => item.id === this._inpaint.sourceNodeId);
    const ids = new Set([this._inpaint.rawSlotId].filter(Boolean));
    const pending = this._nodeImages(node).some((image) => ids.has(image.id) && image.status === "loading");
    if (!pending) this._markInpaintRequestDone(requestId);
  }

  _retireInpaintSelectionVisuals() {
    if (!this._inpaint?.cropRect) return;
    this._inpaint = { ...this._inpaint, cropRect: null, promptHidden: true };
    const prompt = this.shadowRoot.getElementById("inpaintPrompt");
    if (prompt) prompt.hidden = true;
    this.shadowRoot.getElementById("selectionLayer")?.replaceChildren();
    this._drawEffectLayer();
  }

  _markInpaintRequestDone(requestId, { error = false } = {}) {
    if (!this._inpaint?.generating) return;
    if (requestId && this._inpaint.requestId !== requestId) return;
    const nodeId = this._inpaint.sourceNodeId;
    const rawSlotId = this._inpaint.rawSlotId || "";
    const previousStackIndex = Number(this._inpaint.previousStackIndex);
    this._inpaint = { ...this._inpaint, generating: false };
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (node) {
      const metadata = safeParse(node.metadata_json) || {};
      delete metadata.inpaintGenerating;
      delete metadata.inpaintRequestId;
      const patch = {
        status: error ? "ready" : node.status,
        metadataJson: JSON.stringify(metadata),
      };
      if (error && rawSlotId) {
        patch.images = this._nodeImages(node).filter((image) => image.id !== rawSlotId);
        patch.stackIndex = Number.isFinite(previousStackIndex) ? previousStackIndex : 0;
        patch.stack_index = patch.stackIndex;
        patch.imageUrl = this._activeImageForNode({ ...node, images: patch.images, stackIndex: patch.stackIndex, stack_index: patch.stackIndex })?.image_url || "";
      }
      this._patchNode(node.id, patch, { quiet: true });
    }
    this._syncInpaintPrompt();
    this._draw();
  }

  async _mergeCommittedCanvasImagesFromServer(options = {}) {
    if (!this._projectId) return;
    const data = await this._api(`/api/projects/${encodeURIComponent(this._projectId)}/canvas`);
    const state = data?.canvas?.state || safeParse(data?.canvas?.stateJson);
    this._mergeCommittedCanvasImages(state, options);
    // After the merge, as everywhere: the version may only be adopted once this
    // tab holds what the document at that version holds. Without adopting it at
    // all the tab keeps writing the version it loaded with, and every generation
    // that committed an image in the meantime turns the next save into a 409.
    this._adoptCanvasVersion(data?.canvas?.version);
  }

  _mergeCommittedCanvasImages(state, { reconcileGenerationState = false, skipSave = false } = {}) {
    if (state?.metadata) {
      this._canvasMetadata = this._normalizeCanvasMetadata(state.metadata);
      this._state.metadata = this._canvasMetadata;
    }
    const nodes = Array.isArray(state?.nodes) ? state.nodes : [];
    let changed = false;
    // Adopt first: a node this tab has never seen (an MCP agent's prompt node,
    // say) has to exist locally before the next save, or that save deletes it
    // and orphans whatever it is generating.
    const additions = remoteCanvasAdditions({
      localNodes: this._state.nodes,
      localEdges: this._state.edges,
      remoteNodes: nodes,
      remoteEdges: Array.isArray(state?.edges) ? state.edges : [],
      normalizeImageUrl: displayUrlForGenerationFileUrl,
    });
    additions.nodes.forEach((node) => this._engine?.add_node(JSON.stringify(node)));
    additions.edges.forEach((edge) => this._engine?.add_edge(JSON.stringify(edge)));
    additions.pendingSlots.forEach(({ nodeId, images }) => {
      const localNode = this._state.nodes.find((node) => node.id === nodeId);
      if (!localNode) return;
      this._engine?.patch_node(localNode.id, JSON.stringify({
        images: [...this._nodeImages(localNode), ...images],
        status: "loading",
      }));
    });
    if (additions.nodes.length || additions.edges.length || additions.pendingSlots.length) {
      this._syncStateFromEngine();
      changed = true;
    }
    nodes.forEach((serverNode) => {
      const serverImages = this._nodeImages(serverNode);
      const localNode = this._state.nodes.find((node) => node.id === serverNode.id);
      if (!localNode) return;
      const result = reconcileCommittedGenerationImages({
        localImages: this._nodeImages(localNode),
        serverImages,
        nodeMetadata: safeParse(localNode.metadata_json || localNode.metadataJson) || {},
        active: this._activeCanvasGenerationNodeIds.has(localNode.id),
        reconcileGenerationState,
        resolveImageUrl: (image) => displayUrlForGenerationFileUrl(image.image_url || image.imageUrl || ""),
      });
      if (!result.changed) return;
      const localImages = result.images;
      const activeImage = this._activeImageForNode({ ...localNode, images: localImages }) || this._readyImagesForNode({ ...localNode, images: localImages })[0] || {};
      this._engine?.patch_node(localNode.id, JSON.stringify({
        images: localImages,
        status: result.stillPending ? "loading" : (activeImage.image_url ? "ready" : localNode.status),
        image_url: activeImage.image_url || "",
        metadataJson: JSON.stringify(result.metadata),
      }));
      changed = true;
    });
    if (!changed) return;
    this._syncStateFromEngine();
    if (!skipSave) this._queueSave();
    this._syncToolbar();
    this._syncPromptOverlays();
    this._draw();
  }

  getCanvasStateSnapshot() {
    return this._engine?.serialize?.() ? JSON.parse(this._engine.serialize()) : { ...this._state };
  }

  applyEmbedOps(ops = []) {
    if (!Array.isArray(ops) || !ops.length) return;
    for (const op of ops) {
      const kind = String(op?.op || "");
      if (kind === "add_node" && op.node) {
        this._addNode(op.node);
        continue;
      }
      if (kind === "patch_node" && op.nodeId) {
        this._patchNode(op.nodeId, op.patch || {});
        continue;
      }
      if (kind === "add_edge" && op.edge) {
        this._engine?.add_edge(JSON.stringify(op.edge));
        continue;
      }
      if (kind === "connect" && op.from && op.to) {
        this._addEdge(op.from, op.to, op.kind || "input");
        continue;
      }
      if (kind === "set_prompt" && op.nodeId) {
        this._patchNode(op.nodeId, { prompt: String(op.prompt || "") });
        continue;
      }
      if (kind === "set_brand" && op.nodeId) {
        const metadata = safeParse(this._state.nodes.find((n) => n.id === op.nodeId)?.metadata_json) || {};
        metadata.brandId = op.brandId || "";
        this._patchNode(op.nodeId, { metadataJson: JSON.stringify(metadata) });
        continue;
      }
      if (kind === "create_prompt" && op.x != null) {
        this._addNode({
          id: `node-${crypto.randomUUID()}`,
          kind: "prompt",
          name: op.name || "Prompt",
          x: Number(op.x) || 0,
          y: Number(op.y) || 0,
          width: normalizeImageDimension(op.width || DEFAULT_PROMPT_WIDTH),
          height: normalizeImageDimension(op.height || DEFAULT_PROMPT_HEIGHT),
          prompt: String(op.prompt || ""),
          status: "ready",
        });
      }
    }
    this._syncStateFromEngine();
    this._syncPromptOverlays();
    this._draw();
    this._queueSave();
  }

  setAgentCursor(agentId, worldX, worldY, meta = {}) {
    const id = String(agentId || "agent");
    const now = performance.now();
    let item = this._agentCursors.get(id);
    if (!item) {
      item = {
        color: meta.color || this._agentCursorColor(id),
        label: String(meta.label || "Cursor"),
        currentX: worldX,
        currentY: worldY,
        targetX: worldX,
        targetY: worldY,
        appearTime: now,
        lastActivityTime: now,
        wobblePhase: Math.random() * Math.PI * 2,
      };
      this._agentCursors.set(id, item);
    } else {
      item.targetX = worldX;
      item.targetY = worldY;
      item.lastActivityTime = now;
      if (meta.label) item.label = String(meta.label);
      if (meta.color) item.color = meta.color;
    }
    this._queueAgentCursorFrame();
  }

  clearAgentCursor(agentId) {
    this._agentCursors.delete(String(agentId || "agent"));
    this._drawCollabCursorLayer();
  }

  _agentCursorColor(agentId) {
    let hash = 0;
    for (let i = 0; i < agentId.length; i += 1) hash = (hash * 31 + agentId.charCodeAt(i)) | 0;
    const hues = ["#d4a640", "#53acff", "#ff8a65", "#81c784", "#ba68c8"];
    return hues[Math.abs(hash) % hues.length];
  }

  _queueAgentCursorFrame() {
    if (this._agentCursorAnimation) return;
    this._agentCursorAnimation = window.requestAnimationFrame(() => {
      this._agentCursorAnimation = 0;
      this._drawCollabCursorLayer();
      if (this._agentCursors.size) this._queueAgentCursorFrame();
    });
  }

  async _createBrandFromSelection() {
    const selected = this._state.nodes.filter((n) => n.selected);
    const imageIds = selected.map((n) => this._imageIdForNode(n)).filter(Boolean);
    if (imageIds.length < 5) {
      this._setStatus("Select at least 5 image nodes");
      return;
    }
    this._notifyCanvasCoach("brand-create-started", { imageCount: imageIds.length });
    let name = "Brand";
    this._showLoadingToast("Creating brand…");
    this._setStatus("Creating brand…");
    try {
      const data = await this._api("/api/brands/from-canvas", {
        method: "POST",
        body: JSON.stringify({
          auto_name: true,
          generate_icon: true,
          project_id: this._projectId,
          image_ids: imageIds,
        }),
      });
      const brandId = data?.brand_id || data?.brand?.id;
      name = String(data?.brand?.name || name).trim() || name;
      await this._loadBrands();
      this._showLoadingToast(data?.icon_started ? "Generating icon…" : "Generating guideline…");
      const detail = await this._waitForBrandGuidelineStream(brandId, (message) => this._showLoadingToast(message));
      await this._loadBrands();
      this._syncPromptOverlays();
      const guidelineNode = this._placeBrandGuidelineFromDetail(detail, brandId, selected);
      this._hideLoadingToast();
      this._showToast(`Brand "${name}" created`);
      this._setStatus(guidelineNode ? `Brand “${name}” created` : `Brand “${name}” created`);
    } catch (error) {
      this._hideLoadingToast();
      const message = error?.message || "Brand creation failed";
      this._showToast(message);
      this._setStatus(message);
      throw error;
    }
  }

  _placeBrandGuidelineFromDetail(detail, brandId, selectedNodes) {
    if (!brandId) return null;
    const images = Array.isArray(detail?.images) ? detail.images : [];
    const guideline = images.find((img) => img.role === "guideline" && img.analysis_status === "done" && (img.display_full_file_url || img.file_url));
    if (!guideline) return null;
    const anchors = selectedNodes.map((n) => nodeRect(n));
    const width = guideline.width || 1440;
    const height = guideline.height || 810;
    const placed = autoPlaceNodeRect(this._state.nodes, width, height, anchors);
    const imageUrl = displayUrlForGenerationFileUrl(guideline.display_full_file_url || guideline.file_url);
    return this._addImageNode({
      name: `${detail?.brand?.name || "Brand"} guideline`,
      imageUrl,
      source: "brand-guideline",
      x: placed.x,
      y: placed.y,
      width,
      height,
      metadata: { brandId, brandImageId: guideline.id },
    });
  }

  _waitForBrandGuidelineStream(brandId, onProgress) {
    brandId = String(brandId || "").trim();
    if (!brandId) return Promise.reject(new Error("missing_brand_id"));
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this._brandStreamURL(brandId));
      let settled = false;
      const timeout = window.setTimeout(() => {
        finish(null, new Error("Brand guideline generation timed out"));
      }, 30 * 60 * 1000);
      const finish = (detail, error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        try { ws.close(); } catch {}
        if (error) reject(error);
        else resolve(detail);
      };
      ws.addEventListener("message", (event) => {
        const payload = safeParse(event.data);
        if (!payload) return;
        if (payload.type === "brand_deleted") {
          finish(null, new Error("Brand was deleted"));
          return;
        }
        const images = Array.isArray(payload.images) ? payload.images : [];
        const logo = images.find((img) => img.role === "logo");
        const guideline = images.find((img) => img.role === "guideline");
        if (logo?.analysis_status === "error") {
          finish(null, new Error(logo.analysis_error || "Brand icon generation failed"));
          return;
        }
        if (guideline?.analysis_status === "error") {
          finish(null, new Error(guideline.analysis_error || "Brand guideline generation failed"));
          return;
        }
        if (!logo || logo.analysis_status === "generating") {
          onProgress?.("Generating icon…");
        } else {
          onProgress?.("Generating guideline…");
        }
        if (guideline?.analysis_status === "done" && (guideline.display_full_file_url || guideline.file_url)) {
          finish(payload, null);
        }
      });
      ws.addEventListener("error", () => {
        finish(null, new Error("Brand stream failed"));
      });
      ws.addEventListener("close", () => {
        if (!settled) finish(null, new Error("Brand stream closed"));
      });
    });
  }

  _brandStreamURL(brandId) {
    const embed = window.DIFFUI_EMBED === true;
    const base = embed ? new URL(resolveEmbedApiUrl("/")) : new URL(window.location.href);
    const proto = base.protocol === "https:" ? "wss:" : "ws:";
    let wsPath = `${proto}//${base.host}/api/brands/${encodeURIComponent(brandId)}/stream`;
    const token = String(window.DIFFUI_API_KEY || "").trim();
    if (embed && token) {
      wsPath += `?access_token=${encodeURIComponent(token)}`;
    }
    return wsPath;
  }

  async _api(path, opts = {}) {
    const embed = window.DIFFUI_EMBED === true;
    const url = embed ? resolveEmbedApiUrl(path) : path;
    const res = await fetch(url, {
      credentials: embed ? "omit" : "include",
      headers: embed
        ? embedFetchHeaders(opts.headers || {})
        : publicShareFetchHeaders({ "Content-Type": "application/json", ...(opts.headers || {}) }),
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Status and body ride along so callers can act on a specific failure —
      // a 409 canvas save, for instance, rebases on the returned document.
      const error = new Error(data.error || "request_failed");
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  _eventWorld(event) {
    // During an active drag the canvas does not move, so reuse the rect captured
    // at pointer-down instead of forcing a layout read (getBoundingClientRect)
    // on every pointermove -- this avoids layout thrash with the overlay writes.
    let rect = this._canvasRect;
    if (!rect || !(this._pointer || this._dragPort)) {
      rect = this.shadowRoot.getElementById("canvas").getBoundingClientRect();
    }
    return this._screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
  }

  _refreshCanvasRect() {
    const canvas = this.shadowRoot.getElementById("canvas");
    this._canvasRect = canvas ? canvas.getBoundingClientRect() : null;
    return this._canvasRect;
  }

  _imageClickInfoForEvent(node, event, world) {
    const activeImage = this._activeImageForNode(node);
    const imageUrl = activeImage?.image_url || activeImage?.imageUrl || "";
    const box = this.shadowRoot.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
    const domImage = box?.querySelector('.stackFrame[data-layer="0"] .stackFrameFinal');
    if (domImage?.naturalWidth > 0 && domImage.naturalHeight > 0) {
      const rect = domImage.getBoundingClientRect();
      const point = coveredImagePoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
        rect.width,
        rect.height,
        domImage.naturalWidth,
        domImage.naturalHeight,
      );
      return {
        imageX: point.x,
        imageY: point.y,
        imageWidth: domImage.naturalWidth,
        imageHeight: domImage.naturalHeight,
      };
    }
    const img = this._imageFor(imageUrl);
    if (!img?.naturalWidth || !img?.naturalHeight) return null;
    const localX = world.x - node.x;
    const localY = world.y - node.y;
    return {
      imageX: clampNumber((localX / Math.max(1, node.width)) * img.naturalWidth, 0, img.naturalWidth - 1),
      imageY: clampNumber((localY / Math.max(1, node.height)) * img.naturalHeight, 0, img.naturalHeight - 1),
      imageWidth: img.naturalWidth,
      imageHeight: img.naturalHeight,
    };
  }

  _capturePointer(event) {
    try {
      event.currentTarget?.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture may be unavailable for synthetic or already-ended events.
    }
  }

  _releasePointer(event) {
    try {
      if (event.currentTarget?.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore pointer capture races during cancellation.
    }
  }

  _isEditableEventTarget(event) {
    return !!this._editableEventTarget(event);
  }

  _editableEventTarget(event) {
    return event.composedPath().find((target) => {
      if (!(target instanceof HTMLElement)) return false;
      return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
    }) || null;
  }

  _isFocusedEditableEventTarget(event) {
    return event.composedPath().some((target) => {
      if (!(target instanceof HTMLElement)) return false;
      const isEditable = target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      return isEditable && (target.matches(":focus") || target === this.shadowRoot.activeElement);
    });
  }

  _focusedPromptNodeForEvent(event) {
    const target = event.composedPath().find((item) => item instanceof HTMLTextAreaElement && item.matches(":focus"));
    const box = target?.closest?.(".promptBox");
    const nodeId = box?.dataset?.nodeId || "";
    return nodeId ? this._state.nodes.find((node) => node.id === nodeId && node.kind === "prompt") : null;
  }

  _isPromptBoxInteractiveTarget(target) {
    return !!target?.closest?.("textarea, button, input, select, diffui-prompt-suggestions, [contenteditable]");
  }

  _nodeSupportsAltDuplicate(nodeId) {
    const node = this._state.nodes.find((item) => item.id === nodeId);
    return Boolean(node && node.kind !== "image");
  }

  _duplicatePromptNodeForAltDrag(sourceId) {
    const source = this._state.nodes.find((item) => item.id === sourceId);
    if (!source || source.kind === "image") return null;
    const incomingEdges = this._state.edges
      .filter((edge) => (edge.to_node_id || edge.toNodeId) === sourceId)
      .map((edge) => ({
        fromId: edge.from_node_id || edge.fromNodeId || "",
        kind: edge.kind || "prompt_input",
      }))
      .filter((edge) => edge.fromId);
    const srcMeta = safeParse(source.metadata_json || source.metadataJson) || {};
    const meta = { ...srcMeta };
    delete meta.generating;
    delete meta.clickPromptStatus;
    delete meta.clickPromptRequestId;
    delete meta.clickImageX;
    delete meta.clickImageY;
    delete meta.clickedImageId;
    meta.createdFrom = "alt_drag_duplicate";
    meta.duplicateSourceNodeId = source.id;
    const baseName =
      String(source.name || "Prompt")
        .replace(/\s+copy\d*$/i, "")
        .trim() || "Prompt";
    const created = this._addNode({
      id: `prompt-${crypto.randomUUID()}`,
      kind: source.kind || "prompt",
      name: `${baseName} copy`,
      x: source.x,
      y: source.y,
      width: source.width,
      height: source.height,
      prompt: String(source.prompt || ""),
      images: [],
      stack_index: 0,
      stackIndex: 0,
      image_url: "",
      imageUrl: "",
      status: "",
      metadata_json: JSON.stringify(meta),
      selected: false,
    }, { skipCommit: true });
    if (!created) return null;
    incomingEdges.forEach(({ fromId, kind }) => {
      this._addEdge(fromId, created.id, kind, { skipCommit: true });
    });
    this._commitCollabState();
    return this._state.nodes.find((item) => item.id === created.id) || created;
  }

  _prepareNodeSelectionForDrag(nodeId, append = false) {
    const node = this._state.nodes.find((item) => item.id === nodeId);
    if (!node) return false;
    if (!append && node.selected) {
      const hadSelectedEdges = this._state.edges.some((edge) => edge.selected);
      if (hadSelectedEdges) {
        this._state.edges.forEach((edge) => (edge.selected = false));
        this._engine?.load(JSON.stringify(this._state));
        this._syncStateFromEngine();
      }
      return true;
    }
    this._selectNodeById(nodeId, append);
    return true;
  }

  _selectNodeById(nodeId, append = false) {
    let selected = false;
    this._state.nodes.forEach((node) => {
      if (!append) node.selected = false;
      if (node.id === nodeId) {
        node.selected = true;
        selected = true;
      }
    });
    if (!append) this._state.edges.forEach((edge) => (edge.selected = false));
    if (!selected) return;
    this._engine?.load(JSON.stringify(this._state));
    this._syncStateFromEngine();
  }

  _selectEdgeById(edgeId, append = false) {
    let selected = false;
    if (!append) this._state.nodes.forEach((node) => (node.selected = false));
    this._state.edges.forEach((edge) => {
      if (!append) edge.selected = false;
      if (edge.id === edgeId) {
        edge.selected = true;
        selected = true;
      }
    });
    if (!selected) return;
    this._engine?.load(JSON.stringify(this._state));
    this._syncStateFromEngine();
  }

  _selectWithinRect(rect, append = false) {
    let changed = false;
    if (!append) {
      this._state.nodes.forEach((node) => {
        if (!node.selected) return;
        node.selected = false;
        changed = true;
      });
      this._state.edges.forEach((edge) => {
        if (!edge.selected) return;
        edge.selected = false;
        changed = true;
      });
    }
    this._state.nodes.forEach((node) => {
      if (!rectsIntersect(rect, nodeRect(node)) || node.selected) return;
      node.selected = true;
      changed = true;
    });
    this._state.edges.forEach((edge) => {
      if (!this._edgeIntersectsRect(edge, rect) || edge.selected) return;
      edge.selected = true;
      changed = true;
    });
    if (!changed) return;
    this._engine?.load(JSON.stringify(this._state));
    this._syncStateFromEngine();
    this._queueSave();
    this._syncToolbar();
    this._syncPromptOverlays();
    this._draw();
  }

  _clearSelection() {
    let changed = false;
    this._state.nodes.forEach((node) => {
      if (!node.selected) return;
      node.selected = false;
      changed = true;
    });
    this._state.edges.forEach((edge) => {
      if (!edge.selected) return;
      edge.selected = false;
      changed = true;
    });
    if (!changed) return;
    this._engine?.load(JSON.stringify(this._state));
    this._syncStateFromEngine();
    this._queueSave();
    this._hideInspector();
    this._syncToolbar();
    this._syncPromptOverlays();
    this._draw();
  }

  _commonCanvasNodeSize() {
    const sizes = new Map();
    this._state.nodes.forEach((node) => {
      const width = Math.max(16, snap_dimension(node.width));
      const height = Math.max(16, snap_dimension(node.height));
      const key = `${width}x${height}`;
      const current = sizes.get(key) || { width, height, count: 0, area: width * height };
      current.count += 1;
      sizes.set(key, current);
    });
    return Array.from(sizes.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.area - a.area;
    })[0] || { width: DEFAULT_PROMPT_WIDTH, height: DEFAULT_PROMPT_HEIGHT };
  }

  _singleClickPromptRect(point, size) {
    const { width, height } = constrainPromptDimensions(size.width, size.height);
    const fallback = { x: point.x, y: point.y, width, height };
    if (this._isPromptPlacementClear(fallback)) return fallback;
    const radius = 1000;
    const step = 64;
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx += step) {
      for (let dy = -radius; dy <= radius; dy += step) {
        const distance = Math.hypot(dx, dy);
        if (!distance || distance > radius) continue;
        candidates.push({
          x: snap_dimension(point.x + dx),
          y: snap_dimension(point.y + dy),
          width,
          height,
          distance,
        });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
    return candidates.find((rect) => this._isPromptPlacementClear(rect)) || fallback;
  }

  _isPromptPlacementClear(rect) {
    return !this._state.nodes.some((node) => rectsIntersect(rect, nodeRect(node)));
  }

  _focusPromptNode(node, { panIntoView = false, camera = true } = {}) {
    if (!node) return;
    this._selectNodeById(node.id);
    this._syncToolbar();
    this._syncPromptOverlays();
    if (camera) {
      if (panIntoView) this._panWorldRectIntoView(nodeRect(node), { animate: true });
      else this._fitWorldRectIntoView(nodeRect(node), { animate: true, ifNeeded: !this._shouldUseLowDetailNodeUi(node) });
    }
    requestAnimationFrame(() => {
      const box = this.shadowRoot.getElementById("promptLayer")?.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
      const textarea = box?.querySelector("textarea");
      if (!textarea || textarea.readOnly) return;
      textarea.focus({ preventScroll: true });
    });
  }

  _screenToWorld(x, y) {
    const scale = this._state.viewport.scale || 1;
    return {
      x: (x - this._state.viewport.x) / scale,
      y: (y - this._state.viewport.y) / scale,
    };
  }

  _worldToScreen(x, y) {
    const scale = this._state.viewport.scale || 1;
    return {
      x: x * scale + this._state.viewport.x,
      y: y * scale + this._state.viewport.y,
    };
  }

  _worldRectToScreenRect(rect) {
    const p = this._worldToScreen(rect.x, rect.y);
    const scale = this._state.viewport.scale || 1;
    return {
      x: p.x,
      y: p.y,
      width: rect.width * scale,
      height: rect.height * scale,
    };
  }

  _viewportWorldRect() {
    const canvas = this.shadowRoot.getElementById("canvas");
    const width = canvas?.clientWidth || this.clientWidth || 1;
    const height = canvas?.clientHeight || this.clientHeight || 1;
    const topLeft = this._screenToWorld(0, 0);
    const bottomRight = this._screenToWorld(width, height);
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  }

  // Visible world rect expanded by a margin (as a ratio of the viewport) so that
  // nodes near the edges are still drawn/positioned a little before they scroll
  // fully into view, avoiding pop-in during fast panning.
  _visibleWorldRectWithMargin(marginRatio = 0.25) {
    const rect = this._viewportWorldRect();
    const mx = rect.width * marginRatio;
    const my = rect.height * marginRatio;
    return {
      x: rect.x - mx,
      y: rect.y - my,
      width: rect.width + mx * 2,
      height: rect.height + my * 2,
    };
  }

  _nodeIntersectsRect(node, rect) {
    if (!rect) return true;
    return !(
      node.x > rect.x + rect.width ||
      node.x + node.width < rect.x ||
      node.y > rect.y + rect.height ||
      node.y + node.height < rect.y
    );
  }

  _selectedNode() {
    return this._state.nodes.find((node) => node.selected);
  }

  _imageHit(x, y) {
    return [...this._state.nodes].reverse().find((node) => this._activeImageForNode(node) && pointInNode(x, y, node));
  }

  _imageMajorityTarget(rect) {
    const rectArea = rect.width * rect.height;
    if (!Number.isFinite(rectArea) || rectArea <= 0) return null;
    let bestNode = null;
    let bestArea = 0;
    [...this._state.nodes].reverse().forEach((node) => {
      if (!this._activeImageForNode(node)) return;
      const overlap = intersectRects(rect, nodeRect(node));
      if (!overlap) return;
      const area = overlap.width * overlap.height;
      if (area <= bestArea) return;
      bestArea = area;
      bestNode = node;
    });
    return bestArea > rectArea / 2 ? bestNode : null;
  }

  _promptHit(x, y) {
    return [...this._state.nodes].reverse().find((node) => node.kind !== "image" && pointInNode(x, y, node));
  }

  _edgeHit(x, y) {
    const radius = 8 / Math.max(0.2, this._state.viewport.scale || 1);
    let best = null;
    let bestDistance = Infinity;
    [...this._state.edges].reverse().forEach((edge) => {
      const points = this._edgeWorldPoints(edge);
      if (points.length < 2) return;
      for (let index = 1; index < points.length; index += 1) {
        const distance = distanceToSegment({ x, y }, points[index - 1], points[index]);
        if (distance > radius || distance >= bestDistance) continue;
        best = edge;
        bestDistance = distance;
      }
    });
    return best;
  }

  _edgeIntersectsRect(edge, rect) {
    const points = this._edgeWorldPoints(edge);
    if (points.some((point) => pointInRect(point, rect))) return true;
    for (let index = 1; index < points.length; index += 1) {
      if (segmentIntersectsRect(points[index - 1], points[index], rect)) return true;
    }
    return false;
  }

  _edgeWorldPoints(edge) {
    const fromId = edge.from_node_id || edge.fromNodeId || "";
    const toId = edge.to_node_id || edge.toNodeId || "";
    const from = this._state.nodes.find((node) => node.id === fromId);
    const to = this._state.nodes.find((node) => node.id === toId);
    if (!from || !to) return [];
    const a = this._nodeOutputAnchor(from);
    const b = this._promptInputAnchor(to);
    const h = noodleControlOffset(a, b, NOODLE_HANDLE_MAX_PX / (this._state.viewport.scale || 1));
    const c1 = { x: a.x + h, y: a.y };
    const c2 = { x: b.x - h, y: b.y };
    const points = [];
    for (let step = 0; step <= 24; step += 1) {
      points.push(cubicBezierPoint(a, c1, c2, b, step / 24));
    }
    return points;
  }

  _promptInputAnchor(node) {
    const scale = this._state.viewport.scale || 1;
    const inputCenterOffset = 10 + 8 - NODE_LEFT_CONNECTOR_WIDTH / 2;
    return { x: node.x - inputCenterOffset / scale, y: node.y + node.height / 2 };
  }

  /** Deepest visible back card extension in screen px (layer 3 ignored; `[data-depth="2"]` has no visible layer 2). */
  _lowestVisibleStackLayerOffsetPx(node, scale = this._state.viewport.scale || 1) {
    const depth = Math.min(this._displayableImagesForNode(node).length, 3);
    if (depth < 2) return 0;
    const backLayers = depth === 2 ? 1 : 2;
    return STACK_LAYER_OFFSET * backLayers * scale;
  }

  _nodeOutputGap(node) {
    if (this._nodeAnalysisProcessing(node)) return 0;
    const readyImages = this._displayableImagesForNode(node);
    if (!readyImages.length) return 8;
    const scale = this._state.viewport.scale || 1;
    const offsetPx = this._lowestVisibleStackLayerOffsetPx(node, scale);
    return offsetPx > 0 ? offsetPx + 8 : 8;
  }

  _nodeStackBarGap(node) {
    return this._nodeOutputGap(node);
  }

  _nodeStackBarOverflowPx(node, scale = this._state.viewport.scale || 1) {
    if (!this._nodeImages(node).length) return 0;
    return Math.round((23 + this._nodeStackBarGap(node)) * scale);
  }

  _nodeOutputAnchor(node) {
    const scale = this._state.viewport.scale || 1;
    const screenOffset = this._nodeOutputGap(node) + NODE_RIGHT_CONNECTOR_WIDTH / 2;
    return {
      x: node.x + node.width + screenOffset / scale,
      y: node.y + node.height / 2,
    };
  }

  _promptInputHit(x, y) {
    const scale = this._state.viewport.scale || 1;
    const radius = PROMPT_INPUT_HIT_RADIUS / scale;
    let best = null;
    let bestDistance = Infinity;
    [...this._state.nodes].reverse().forEach((node) => {
      if (node.kind === "image") return;
      const anchor = this._promptInputAnchor(node);
      const distance = Math.hypot(anchor.x - x, anchor.y - y);
      const inInputStrip = x >= anchor.x - radius
        && x <= anchor.x + radius
        && y >= node.y - radius
        && y <= node.y + node.height + radius;
      if (!inInputStrip || distance > radius || distance >= bestDistance) return;
      best = node;
      bestDistance = distance;
    });
    return best;
  }

  _portDragPromptPreviewRect(world) {
    const source = this._state.nodes.find((node) => node.id === this._dragPort?.from);
    if (!source) return null;
    const size = constrainPromptDimensions(source.width, source.height);
    return {
      x: world.x,
      y: world.y - size.height / 2,
      width: size.width,
      height: size.height,
    };
  }

  _isValidPortPromptDropRect(rect) {
    if (!rect || rect.width < 16 || rect.height < 16) return false;
    return !this._state.nodes.some((node) => rectsIntersect(rect, nodeRect(node)));
  }

  _connectorHandleHoverNodeAt(x, y) {
    const scale = this._state.viewport.scale || 1;
    return [...this._state.nodes].reverse().find((node) => {
      if (this._shouldShowNodeInputConnector(node)) {
        const input = this._promptInputAnchor(node);
        const inputHalfWidth = (NODE_LEFT_CONNECTOR_WIDTH / 2 + 8) / scale;
        const inputHalfHeight = (NODE_IN_HANDLE_HEIGHT / 2 + 8) / scale;
        if (
          x >= input.x - inputHalfWidth
          && x <= input.x + inputHalfWidth
          && y >= input.y - inputHalfHeight
          && y <= input.y + inputHalfHeight
        ) {
          return true;
        }
      }
      if (this._shouldShowNodeOutputConnector(node) && !this._nodeAnalysisProcessing(node)) {
        const output = this._nodeOutputAnchor(node);
        const outputHalfWidth = (NODE_RIGHT_CONNECTOR_WIDTH / 2 + 8) / scale;
        const outputHalfHeight = (NODE_OUT_HANDLE_HEIGHT / 2 + 8) / scale;
        if (
          x >= output.x - outputHalfWidth
          && x <= output.x + outputHalfWidth
          && y >= output.y - outputHalfHeight
          && y <= output.y + outputHalfHeight
        ) {
          return true;
        }
      }
      return false;
    }) || null;
  }

  _portHit(x, y) {
    return [...this._state.nodes].reverse().find((node) => {
      if (this._nodeAnalysisProcessing(node)) return false;
      if (!this._shouldShowNodeOutputConnector(node)) return false;
      const anchor = this._nodeOutputAnchor(node);
      const px = anchor.x;
      const py = anchor.y;
      const scale = this._state.viewport.scale || 1;
      return x >= px - (NODE_RIGHT_CONNECTOR_WIDTH / 2 + 8) / scale
        && x <= px + (NODE_RIGHT_CONNECTOR_WIDTH / 2 + 8) / scale
        && y >= py - (NODE_OUT_HANDLE_HEIGHT / 2 + 8) / scale
        && y <= py + (NODE_OUT_HANDLE_HEIGHT / 2 + 8) / scale;
    });
  }

  _imageFor(url) {
    if (!url) return null;
    let img = this._images.get(url);
    if (!img) {
      img = new Image();
      // Embedded, these bitmaps are cross-origin, and drawing one without CORS
      // taints any canvas it lands in — which would break the crop upload's
      // toDataURL readback. The file origin answers with CORS headers for an
      // embedder (see withEmbedCORS), so ask for them.
      if (window.DIFFUI_EMBED === true) img.crossOrigin = "anonymous";
      img.onload = () => this._draw();
      img.src = resolveEmbedAssetUrl(url);
      this._images.set(url, img);
    }
    return img;
  }

  _imageDrawSourceRect(node, img, seen = new Set()) {
    const fullRect = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
    if (!node || seen.has(node.id)) return fullRect;
    seen.add(node.id);

    const metadata = safeParse(node.metadata_json) || {};
    if (String(metadata.assetId || "").trim()) return fullRect;
    const cropRect = normalizeStoredRect(metadata.cropRect);
    const sourceNodeId = String(metadata.sourceNodeId || "");
    if (!cropRect || !sourceNodeId) return fullRect;

    const sourceNode = this._state.nodes.find((item) => item.id === sourceNodeId);
    if (!sourceNode) return fullRect;

    const visibleCrop = intersectRects(cropRect, nodeRect(sourceNode));
    if (!visibleCrop) return null;

    const sourceBaseRect = this._imageDrawSourceRect(sourceNode, img, seen);
    if (!sourceBaseRect) return null;

    const localX = (visibleCrop.x - sourceNode.x) / sourceNode.width;
    const localY = (visibleCrop.y - sourceNode.y) / sourceNode.height;
    const localWidth = visibleCrop.width / sourceNode.width;
    const localHeight = visibleCrop.height / sourceNode.height;

    return clampImageSourceRect({
      x: sourceBaseRect.x + sourceBaseRect.width * localX,
      y: sourceBaseRect.y + sourceBaseRect.height * localY,
      width: sourceBaseRect.width * localWidth,
      height: sourceBaseRect.height * localHeight,
    }, img);
  }

  _syncAnalysisAnimation() {
    const hasProcessing = this._state.nodes.some((node) => {
      return this._nodeImages(node).some((image) => {
        const metadata = safeParse(image.metadata_json) || {};
        return metadata.analysisStatus === "processing";
      });
    });
    if (!hasProcessing) {
      window.cancelAnimationFrame(this._analysisAnimation);
      this._analysisAnimation = 0;
      return;
    }
    if (this._analysisAnimation) return;
    this._analysisAnimation = window.requestAnimationFrame(() => {
      this._analysisAnimation = 0;
      this._draw();
    });
  }

  _setStatus(text) {
    this.dispatchEvent(
      new CustomEvent("diffui-canvas-status", {
        bubbles: true,
        composed: true,
        detail: { text: String(text || "") },
      }),
    );
  }

  _showToast(text) {
    const toast = this.shadowRoot.getElementById("canvasToast");
    if (!toast) return;
    window.clearTimeout(this._toastTimer);
    toast.dataset.loading = "false";
    this._setToastText(String(text || ""), false);
    toast.dataset.visible = toast.textContent ? "true" : "false";
    if (!toast.textContent) return;
    this._toastTimer = window.setTimeout(() => {
      toast.dataset.visible = "false";
    }, 1800);
  }

  _showLoadingToast(text) {
    const toast = this.shadowRoot.getElementById("canvasToast");
    if (!toast) return;
    window.clearTimeout(this._toastTimer);
    toast.dataset.loading = "true";
    toast.dataset.visible = "true";
    this._setToastText(String(text || ""), true);
  }

  _hideLoadingToast() {
    const toast = this.shadowRoot.getElementById("canvasToast");
    if (!toast) return;
    if (toast.dataset.loading !== "true") return;
    window.clearTimeout(this._toastTimer);
    toast.dataset.loading = "false";
    toast.dataset.visible = "false";
    while (toast.firstChild) toast.removeChild(toast.firstChild);
  }

  _setToastText(text, loading) {
    const toast = this.shadowRoot.getElementById("canvasToast");
    if (!toast) return;
    const value = String(text || "");
    if (!loading) {
      toast.textContent = value;
      return;
    }
    let spinner = toast.querySelector(".toastSpinner");
    if (!spinner) {
      spinner = document.createElement("span");
      spinner.className = "toastSpinner";
      spinner.setAttribute("aria-hidden", "true");
      toast.appendChild(spinner);
    }
    let textEl = toast.querySelector(".toastText");
    if (!textEl) {
      textEl = document.createElement("span");
      textEl.className = "toastText";
      toast.appendChild(textEl);
    }
    textEl.textContent = value;
  }
}

function safeParse(raw) {
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function shuffledSuggestions(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({ item, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ item }) => item);
}

function parseDiffuiClipboardPayload(raw) {
  const payload = safeParse(String(raw || "").trim());
  if (!payload || typeof payload !== "object") return null;
  if (payload.diffuiClipboard !== DIFFUI_CLIPBOARD_MARKER) return null;
  if (!(payload.expandedJson || payload.expanded_json)) return null;
  return payload;
}

function parseDiffuiClipboardPayloadFromDataTransfer(dataTransfer) {
  if (!dataTransfer) return null;
  const preferred = [
    DIFFUI_CLIPBOARD_MIME,
    "application/x-diffui-image-node",
    "text/plain",
  ];
  for (const type of preferred) {
    const payload = parseDiffuiClipboardPayload(dataTransfer.getData(type));
    if (payload) return payload;
  }
  for (const type of Array.from(dataTransfer.types || [])) {
    if (!String(type || "").includes("diffui-image-node")) continue;
    const payload = parseDiffuiClipboardPayload(dataTransfer.getData(type));
    if (payload) return payload;
  }
  return null;
}

function normalizeRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

function nodeRect(node) {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

function translateRect(rect, dx, dy) {
  return { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
}

function expandRect(rect, margin) {
  const m = Number(margin) || 0;
  return {
    x: rect.x - m,
    y: rect.y - m,
    width: rect.width + 2 * m,
    height: rect.height + 2 * m,
  };
}

function rectSideValue(rect, side) {
  if (side === "right") return rect.x + rect.width;
  if (side === "bottom") return rect.y + rect.height;
  if (side === "top") return rect.y;
  return rect.x;
}

function normalizeStoredRect(rect) {
  if (!rect || typeof rect !== "object") return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function assetAnalysisMetadata(asset) {
  if (!asset || typeof asset !== "object") return {};
  const metadata = {};
  const analysisStatus = String(asset.analysisStatus || asset.analysis_status || "").trim();
  if (analysisStatus) metadata.analysisStatus = analysisStatus;
  if ("promptReady" in asset || "prompt_ready" in asset) {
    metadata.promptReady = !!(asset.promptReady ?? asset.prompt_ready);
  }
  const expandedJson = asset.expandedJson ?? asset.expanded_json;
  if (expandedJson) metadata.expandedJson = expandedJson;
  const pageTitle = String(asset.pageTitle || asset.page_title || titleFromExpandedJson(expandedJson) || "").trim();
  if (pageTitle) metadata.pageTitle = pageTitle;
  const fileTitle = String(asset.fileTitle || asset.file_title || "").trim();
  if (fileTitle) metadata.fileTitle = fileTitle;
  const analysisError = String(asset.analysisError || asset.analysis_error || "").trim();
  if (analysisError) metadata.analysisError = analysisError;
  return metadata;
}

function canvasAssetPageTitle(asset) {
  if (!asset || typeof asset !== "object") return "";
  return String(asset.pageTitle || asset.page_title || titleFromExpandedJson(asset.expandedJson ?? asset.expanded_json) || "").trim();
}

function canvasAssetFileTitle(asset) {
  if (!asset || typeof asset !== "object") return "";
  return String(asset.fileTitle || asset.file_title || "").trim();
}

function titleFromExpandedJson(raw) {
  if (!raw) return "";
  const parsed = safeParse(raw);
  if (!parsed || typeof parsed !== "object") return "";
  return String(parsed.title || parsed.pageTitle || parsed.page_title || "").trim();
}

function unionRects(rects) {
  const valid = rects.filter(Boolean);
  if (!valid.length) return null;
  const left = Math.min(...valid.map((rect) => rect.x));
  const top = Math.min(...valid.map((rect) => rect.y));
  const right = Math.max(...valid.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...valid.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function intersectRects(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

/**
 * Shared auto-placement algorithm for agentic/automatic node creation
 * (mirrors backend/pkg/canvaslayout). Outputs prefer columns to the right of
 * their inputs; inputs mirror that flow with columns to the left of their
 * output. Siblings stack downward on an even lattice and all results snap to
 * the 16px grid.
 */
const AUTO_PLACE_GAP_X = 160;
const AUTO_PLACE_GAP_Y = 120;
const AUTO_PLACE_CLEARANCE = 48;
const AUTO_PLACE_MAX_ROWS = 8;
const AUTO_PLACE_MAX_COLS = 8;
/** Clearance used when searching for a free paste slot near the viewport anchor. */
const PASTE_PLACE_CLEARANCE = 24;
const PASTE_PLACE_SEARCH_STEP = 32;
/** Viewport-relative anchor for free-canvas image pastes (x=25%, y=50%). */
const PASTE_PLACE_ANCHOR_X = 0.25;
const PASTE_PLACE_ANCHOR_Y = 0.5;

function autoPlaceSnap(value) {
  return Math.round(value / 16) * 16;
}

/**
 * Place a pasted image near 25%/50% of the visible viewport, staying inside the
 * viewport and preferring a collision-free slot. If every in-viewport candidate
 * collides, returns the preferred position so the paste stacks on top.
 */
function placePastedNodeRect(nodes, width, height, viewport) {
  const existing = (Array.isArray(nodes) ? nodes : [])
    .map((node) => nodeRect(node))
    .filter((rect) => rect.width > 0 && rect.height > 0);
  const vp = viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height) && viewport.width > 0 && viewport.height > 0
    ? viewport
    : { x: -width / 2, y: -height / 2, width: Math.max(width, 1) * 4, height: Math.max(height, 1) * 4 };

  const clampPasteAxis = (pos, size, vpStart, vpSize) => {
    if (size >= vpSize) {
      // Keep as much of the node covering the viewport as possible around `pos`.
      return clampNumber(pos, vpStart + vpSize - size, vpStart);
    }
    return clampNumber(pos, vpStart, vpStart + vpSize - size);
  };

  const preferredCenterX = vp.x + vp.width * PASTE_PLACE_ANCHOR_X;
  const preferredCenterY = vp.y + vp.height * PASTE_PLACE_ANCHOR_Y;
  let preferredX = clampPasteAxis(preferredCenterX - width / 2, width, vp.x, vp.width);
  let preferredY = clampPasteAxis(preferredCenterY - height / 2, height, vp.y, vp.height);
  preferredX = clampPasteAxis(autoPlaceSnap(preferredX), width, vp.x, vp.width);
  preferredY = clampPasteAxis(autoPlaceSnap(preferredY), height, vp.y, vp.height);

  const isFree = (x, y) => {
    const padded = {
      x: x - PASTE_PLACE_CLEARANCE,
      y: y - PASTE_PLACE_CLEARANCE,
      width: width + 2 * PASTE_PLACE_CLEARANCE,
      height: height + 2 * PASTE_PLACE_CLEARANCE,
    };
    return !existing.some((rect) => rectsIntersect(padded, rect));
  };

  const fullyInViewport = (x, y) => {
    if (width <= vp.width && (x < vp.x || x + width > vp.x + vp.width + 0.5)) return false;
    if (height <= vp.height && (y < vp.y || y + height > vp.y + vp.height + 0.5)) return false;
    return true;
  };

  if (isFree(preferredX, preferredY)) {
    return { x: preferredX, y: preferredY, width, height };
  }

  // Search expanding square rings around the preferred spot and take the first
  // free slot, so work scales with how far we have to look — not viewport area.
  const maxRadius = Math.max(vp.width, vp.height, width, height);
  const seen = new Set();
  for (let radius = PASTE_PLACE_SEARCH_STEP; radius <= maxRadius; radius += PASTE_PLACE_SEARCH_STEP) {
    const candidates = [];
    for (let d = -radius; d <= radius; d += PASTE_PLACE_SEARCH_STEP) {
      // Top and bottom edges of the ring, plus left and right edges (corners
      // belong to the horizontal edges; skip them on the vertical ones).
      const offsets = [[d, -radius], [d, radius]];
      if (Math.abs(d) !== radius) offsets.push([-radius, d], [radius, d]);
      for (const [dx, dy] of offsets) {
        const x = clampPasteAxis(autoPlaceSnap(preferredX + dx), width, vp.x, vp.width);
        const y = clampPasteAxis(autoPlaceSnap(preferredY + dy), height, vp.y, vp.height);
        if (!fullyInViewport(x, y)) continue;
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          x,
          y,
          distance: Math.hypot(x - preferredX, y - preferredY),
        });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
    for (const candidate of candidates) {
      if (isFree(candidate.x, candidate.y)) {
        return { x: candidate.x, y: candidate.y, width, height };
      }
    }
  }

  return { x: preferredX, y: preferredY, width, height };
}

function autoPlaceNodeRect(nodes, width, height, anchors = [], side = "right") {
  const existing = (Array.isArray(nodes) ? nodes : [])
    .map((node) => nodeRect(node))
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (!existing.length) {
    return { x: autoPlaceSnap(-width / 2), y: autoPlaceSnap(-height / 2), width, height };
  }
  const anchorRects = (anchors || []).filter((rect) => rect && rect.width > 0 && rect.height > 0);
  const origin = unionRects(anchorRects.length ? anchorRects : existing);

  const isFree = (x, y) => {
    const padded = {
      x: x - AUTO_PLACE_CLEARANCE,
      y: y - AUTO_PLACE_CLEARANCE,
      width: width + 2 * AUTO_PLACE_CLEARANCE,
      height: height + 2 * AUTO_PLACE_CLEARANCE,
    };
    return !existing.some((rect) => rectsIntersect(padded, rect));
  };

  const colW = Math.ceil((width + AUTO_PLACE_GAP_X) / 16) * 16;
  const rowH = Math.ceil((height + AUTO_PLACE_GAP_Y) / 16) * 16;
  const rightBaseX = autoPlaceSnap(origin.x + origin.width + AUTO_PLACE_GAP_X);
  const leftBaseX = autoPlaceSnap(origin.x - AUTO_PLACE_GAP_X - width);
  const bottomBaseY = autoPlaceSnap(origin.y + origin.height + AUTO_PLACE_GAP_Y);
  const baseX = autoPlaceSnap(origin.x);
  const baseY = autoPlaceSnap(origin.y);

  if (side === "left") {
    for (let col = 0; col < AUTO_PLACE_MAX_COLS; col += 1) {
      for (let row = 0; row < AUTO_PLACE_MAX_ROWS; row += 1) {
        const x = leftBaseX - col * colW;
        const y = baseY + row * rowH;
        if (isFree(x, y)) return { x, y, width, height };
      }
    }
    const bounds = unionRects(existing);
    return {
      x: autoPlaceSnap(bounds.x - AUTO_PLACE_GAP_X - width),
      y: baseY,
      width,
      height,
    };
  }

  // First column to the right of the anchor, filling downward.
  for (let row = 0; row < AUTO_PLACE_MAX_ROWS; row += 1) {
    const y = baseY + row * rowH;
    if (isFree(rightBaseX, y)) return { x: rightBaseX, y, width, height };
  }
  // Below the anchor, scanning left-to-right.
  for (let row = 0; row < AUTO_PLACE_MAX_ROWS; row += 1) {
    for (let col = 0; col < AUTO_PLACE_MAX_COLS; col += 1) {
      const x = baseX + col * colW;
      const y = bottomBaseY + row * rowH;
      if (isFree(x, y)) return { x, y, width, height };
    }
  }
  // Additional columns further right.
  for (let col = 1; col < AUTO_PLACE_MAX_COLS; col += 1) {
    for (let row = 0; row < AUTO_PLACE_MAX_ROWS; row += 1) {
      const x = rightBaseX + col * colW;
      const y = baseY + row * rowH;
      if (isFree(x, y)) return { x, y, width, height };
    }
  }
  // Fallback: strictly right of everything on the canvas.
  const bounds = unionRects(existing);
  return { x: autoPlaceSnap(bounds.x + bounds.width + AUTO_PLACE_GAP_X), y: baseY, width, height };
}

function pointInNode(x, y, node) {
  return x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height;
}

function pointInRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function coveredImagePoint(localX, localY, boxWidth, boxHeight, imageWidth, imageHeight) {
  if (boxWidth <= 0 || boxHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return { x: 0, y: 0 };
  }
  const scale = Math.max(boxWidth / imageWidth, boxHeight / imageHeight);
  const renderedWidth = imageWidth * scale;
  const renderedHeight = imageHeight * scale;
  const offsetX = (boxWidth - renderedWidth) / 2;
  const offsetY = (boxHeight - renderedHeight) / 2;
  return {
    x: clampNumber((localX - offsetX) / scale, 0, imageWidth - 1),
    y: clampNumber((localY - offsetY) / scale, 0, imageHeight - 1),
  };
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clampSignedMagnitude(value, maxMagnitude) {
  if (!Number.isFinite(value)) return 0;
  const magnitude = Math.abs(maxMagnitude);
  return Math.max(-magnitude, Math.min(magnitude, value));
}

function normalizedWheelDelta(event) {
  let unit = 1;
  if (event.deltaMode === WHEEL_DELTA_LINE_MODE) unit = WHEEL_LINE_HEIGHT;
  if (event.deltaMode === WHEEL_DELTA_PAGE_MODE) unit = WHEEL_PAGE_HEIGHT;
  return {
    x: event.deltaX * unit,
    y: event.deltaY * unit,
  };
}

function wheelEventIsTrackpadPinchZoom(event) {
  // Browsers synthesize ctrl+wheel (pixel mode) for trackpad pinch-to-zoom.
  return event.ctrlKey && event.deltaMode === 0;
}

function edgeEndpointIds(edge) {
  return {
    fromId: edge.from_node_id || edge.fromNodeId || "",
    toId: edge.to_node_id || edge.toNodeId || "",
  };
}

function edgeIdentity(edge) {
  const { fromId, toId } = edgeEndpointIds(edge);
  return edge.id || `${fromId}->${toId}`;
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (!lengthSq) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function segmentIntersectsRect(a, b, rect) {
  if (pointInRect(a, rect) || pointInRect(b, rect)) return true;
  const topLeft = { x: rect.x, y: rect.y };
  const topRight = { x: rect.x + rect.width, y: rect.y };
  const bottomRight = { x: rect.x + rect.width, y: rect.y + rect.height };
  const bottomLeft = { x: rect.x, y: rect.y + rect.height };
  return segmentsIntersect(a, b, topLeft, topRight)
    || segmentsIntersect(a, b, topRight, bottomRight)
    || segmentsIntersect(a, b, bottomRight, bottomLeft)
    || segmentsIntersect(a, b, bottomLeft, topLeft);
}

function segmentsIntersect(a, b, c, d) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const denominator = abx * cdy - aby * cdx;
  if (!denominator) return false;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const t = (acx * cdy - acy * cdx) / denominator;
  const u = (acx * aby - acy * abx) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function noodleControlOffset(a, b, max = NOODLE_HANDLE_MAX_PX) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  return Math.min(max, dist * NOODLE_HANDLE_DIST_FACTOR);
}

function strokeNoodle(ctx, a, b) {
  const h = noodleControlOffset(a, b);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.bezierCurveTo(a.x + h, a.y, b.x - h, b.y, b.x, b.y);
  ctx.stroke();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.beginPath();
  ctx.arc(a.x, a.y, NOODLE_END_RADIUS_PX, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(b.x, b.y, NOODLE_END_RADIUS_PX, 0, Math.PI * 2);
  ctx.fill();
}

function cubicBezierPoint(a, b, c, d, t) {
  const mt = 1 - t;
  return {
    x: mt ** 3 * a.x + 3 * mt ** 2 * t * b.x + 3 * mt * t ** 2 * c.x + t ** 3 * d.x,
    y: mt ** 3 * a.y + 3 * mt ** 2 * t * b.y + 3 * mt * t ** 2 * c.y + t ** 3 * d.y,
  };
}

function clampImageSourceRect(rect, img) {
  const left = Math.max(0, Math.min(img.naturalWidth, rect.x));
  const top = Math.max(0, Math.min(img.naturalHeight, rect.y));
  const right = Math.max(left, Math.min(img.naturalWidth, rect.x + rect.width));
  const bottom = Math.max(top, Math.min(img.naturalHeight, rect.y + rect.height));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function setScreenRectStyle(el, rect) {
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function clipRoundRect(ctx, x, y, width, height, radius) {
  roundRect(ctx, x, y, width, height, radius);
  ctx.clip();
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

function hasDraggedImages(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  if (items.length) return items.some((item) => item.kind === "file" && (!item.type || item.type.startsWith("image/")));
  return Array.from(dataTransfer?.files || []).some((file) => isImageFile(file));
}

function imageFilesFromDataTransfer(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  if (items.length) {
    return items
      .filter((item) => item.kind === "file" && (!item.type || item.type.startsWith("image/")))
      .map((item) => item.getAsFile())
      .filter((file) => file && isImageFile(file));
  }
  return Array.from(dataTransfer?.files || []).filter((file) => isImageFile(file));
}

function isImageFile(file) {
  if (file.type?.startsWith("image/")) return true;
  return /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(file.name || "");
}

async function preparePastedImage(file) {
  const dataUrl = await fileToDataURL(file);
  const image = await imageFromDataURL(dataUrl);
  const size = fitLongestAxis(image.naturalWidth || 1, image.naturalHeight || 1, MAX_PROMPT_DIMENSION);
  // The decoded clipboard bitmap draws the node immediately; the object URL is
  // only a cache key for it, so it stays the original bytes even when the
  // uploaded copy is downscaled.
  const previewUrl = URL.createObjectURL(file);
  if (size.width === image.naturalWidth && size.height === image.naturalHeight) {
    return { dataUrl, width: size.width, height: size.height, previewUrl, image };
  }
  return {
    dataUrl: resizeImageDataURL(image, size.width, size.height, file.type),
    width: size.width,
    height: size.height,
    previewUrl,
    image,
  };
}

function imageFromDataURL(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image_decode_failed"));
    image.src = dataUrl;
  });
}

function waitForImage(image) {
  if (image.complete && image.naturalWidth > 0) return Promise.resolve(image);
  return new Promise((resolve, reject) => {
    const onLoad = () => {
      cleanup();
      resolve(image);
    };
    const onError = () => {
      cleanup();
      reject(new Error("image_decode_failed"));
    };
    const cleanup = () => {
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
    };
    image.addEventListener("load", onLoad, { once: true });
    image.addEventListener("error", onError, { once: true });
  });
}

function resizeImageDataURL(image, width, height, preferredType = "") {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, width, height);
  const type = ["image/jpeg", "image/webp"].includes(preferredType) ? preferredType : "image/png";
  return canvas.toDataURL(type, 0.92);
}

function normalizeImageDimension(value) {
  return Math.max(16, Math.round(Number(value) || 16));
}

function promptResolutionValue(width, height) {
  return `${Math.round(width)}x${Math.round(height)}`;
}

function promptResolutionText(width, height) {
  return `${Math.round(width)} × ${Math.round(height)}`;
}

function promptResolutionIconSVG(icon) {
  switch (icon) {
    case "desktop":
      return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M19 6V16H5V6H19ZM6 15H18V7H6V15Z" fill="currentColor"/><path d="M11 18V16H13V18H16V19H8V18H11Z" fill="currentColor"/></svg>';
    case "laptop":
      return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M19 6V15H18V7H7L7 15H6L6 6H19Z" fill="currentColor"/><rect x="5" y="16" width="15" height="1" fill="currentColor"/></svg>';
    case "tablet":
      return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M18 5V19H6V5H18ZM7 18H17V6H7V18Z" fill="currentColor"/></svg>';
    case "tablet-landscape":
      return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M19 18L5 18L5 6L19 6L19 18ZM6 7L6 17L18 17L18 7L6 7Z" fill="currentColor"/></svg>';
    case "phone":
      return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M17 4V20H7V4H17ZM8 19H16V5H8V19Z" fill="currentColor"/></svg>';
    case "phone-landscape":
      return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M20 17L4 17L4 7L20 7L20 17ZM5 8L5 16L19 16L19 8L5 8Z" fill="currentColor"/></svg>';
    case "ads":
      return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 10H9L17 6V18L9 14H6V10ZM10 10.6V13.4L16 16.4V7.6L10 10.6Z" fill="currentColor"/><path d="M18 10.5L21 9V15L18 13.5V12.4L20 13.4V10.6L18 11.6V10.5Z" fill="currentColor"/></svg>';
    case "x":
      return '<svg viewBox="0 0 300 271" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="m236 0h46l-101 115 118 156h-92.6l-72.5-94.8-83 94.8h-46l107-123-113-148h94.9l65.5 86.6zm-16.1 244h25.5l-165-218h-27.4z" fill="currentColor"/></svg>';
    case "linkedin":
      return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="#0A66C2"/><path d="M8 10H10V17H8V10ZM9 7.6C9.7 7.6 10.2 8.1 10.2 8.7C10.2 9.4 9.7 9.8 9 9.8C8.3 9.8 7.8 9.4 7.8 8.7C7.8 8.1 8.3 7.6 9 7.6ZM11.2 10H13.1V11C13.5 10.3 14.1 9.8 15.2 9.8C16.8 9.8 17.2 10.8 17.2 12.5V17H15.2V12.9C15.2 12 14.9 11.4 14.2 11.4C13.5 11.4 13.2 11.9 13.2 12.9V17H11.2V10Z" fill="white"/></svg>';
    case "instagram":
      return '<svg viewBox="0 0 132.004 132" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="diffui-instagram-b"><stop offset="0" stop-color="#3771c8"/><stop stop-color="#3771c8" offset=".128"/><stop offset="1" stop-color="#60f" stop-opacity="0"/></linearGradient><linearGradient id="diffui-instagram-a"><stop offset="0" stop-color="#fd5"/><stop offset=".1" stop-color="#fd5"/><stop offset=".5" stop-color="#ff543e"/><stop offset="1" stop-color="#c837ab"/></linearGradient><radialGradient id="diffui-instagram-c" cx="158.429" cy="578.088" r="65" href="#diffui-instagram-a" gradientUnits="userSpaceOnUse" gradientTransform="matrix(0 -1.98198 1.8439 0 -1031.402 454.004)" fx="158.429" fy="578.088"/><radialGradient id="diffui-instagram-d" cx="147.694" cy="473.455" r="65" href="#diffui-instagram-b" gradientUnits="userSpaceOnUse" gradientTransform="matrix(.17394 .86872 -3.5818 .71718 1648.348 -458.493)" fx="147.694" fy="473.455"/></defs><path fill="url(#diffui-instagram-c)" d="M65.03 0C37.888 0 29.95.028 28.407.156c-5.57.463-9.036 1.34-12.812 3.22-2.91 1.445-5.205 3.12-7.47 5.468C4 13.126 1.5 18.394.595 24.656c-.44 3.04-.568 3.66-.594 19.188-.01 5.176 0 11.988 0 21.125 0 27.12.03 35.05.16 36.59.45 5.42 1.3 8.83 3.1 12.56 3.44 7.14 10.01 12.5 17.75 14.5 2.68.69 5.64 1.07 9.44 1.25 1.61.07 18.02.12 34.44.12 16.42 0 32.84-.02 34.41-.1 4.4-.207 6.955-.55 9.78-1.28 7.79-2.01 14.24-7.29 17.75-14.53 1.765-3.64 2.66-7.18 3.065-12.317.088-1.12.125-18.977.125-36.81 0-17.836-.04-35.66-.128-36.78-.41-5.22-1.305-8.73-3.127-12.44-1.495-3.037-3.155-5.305-5.565-7.624C116.9 4 111.64 1.5 105.372.596 102.335.157 101.73.027 86.19 0H65.03z" transform="translate(1.004 1)"/><path fill="url(#diffui-instagram-d)" d="M65.03 0C37.888 0 29.95.028 28.407.156c-5.57.463-9.036 1.34-12.812 3.22-2.91 1.445-5.205 3.12-7.47 5.468C4 13.126 1.5 18.394.595 24.656c-.44 3.04-.568 3.66-.594 19.188-.01 5.176 0 11.988 0 21.125 0 27.12.03 35.05.16 36.59.45 5.42 1.3 8.83 3.1 12.56 3.44 7.14 10.01 12.5 17.75 14.5 2.68.69 5.64 1.07 9.44 1.25 1.61.07 18.02.12 34.44.12 16.42 0 32.84-.02 34.41-.1 4.4-.207 6.955-.55 9.78-1.28 7.79-2.01 14.24-7.29 17.75-14.53 1.765-3.64 2.66-7.18 3.065-12.317.088-1.12.125-18.977.125-36.81 0-17.836-.04-35.66-.128-36.78-.41-5.22-1.305-8.73-3.127-12.44-1.495-3.037-3.155-5.305-5.565-7.624C116.9 4 111.64 1.5 105.372.596 102.335.157 101.73.027 86.19 0H65.03z" transform="translate(1.004 1)"/><path fill="#fff" d="M66.004 18c-13.036 0-14.672.057-19.792.29-5.11.234-8.598 1.043-11.65 2.23-3.157 1.226-5.835 2.866-8.503 5.535-2.67 2.668-4.31 5.346-5.54 8.502-1.19 3.053-2 6.542-2.23 11.65C18.06 51.327 18 52.964 18 66s.058 14.667.29 19.787c.235 5.11 1.044 8.598 2.23 11.65 1.227 3.157 2.867 5.835 5.536 8.503 2.667 2.67 5.345 4.314 8.5 5.54 3.054 1.187 6.543 1.996 11.652 2.23 5.12.233 6.755.29 19.79.29 13.037 0 14.668-.057 19.788-.29 5.11-.234 8.602-1.043 11.656-2.23 3.156-1.226 5.83-2.87 8.497-5.54 2.67-2.668 4.31-5.346 5.54-8.502 1.18-3.053 1.99-6.542 2.23-11.65.23-5.12.29-6.752.29-19.788 0-13.036-.06-14.672-.29-19.792-.24-5.11-1.05-8.598-2.23-11.65-1.23-3.157-2.87-5.835-5.54-8.503-2.67-2.67-5.34-4.31-8.5-5.535-3.06-1.187-6.55-1.996-11.66-2.23-5.12-.233-6.75-.29-19.79-.29zm-4.306 8.65c1.278-.002 2.704 0 4.306 0 12.816 0 14.335.046 19.396.276 4.68.214 7.22.996 8.912 1.653 2.24.87 3.837 1.91 5.516 3.59 1.68 1.68 2.72 3.28 3.592 5.52.657 1.69 1.44 4.23 1.653 8.91.23 5.06.28 6.58.28 19.39s-.05 14.33-.28 19.39c-.214 4.68-.996 7.22-1.653 8.91-.87 2.24-1.912 3.835-3.592 5.514-1.68 1.68-3.275 2.72-5.516 3.59-1.69.66-4.232 1.44-8.912 1.654-5.06.23-6.58.28-19.396.28-12.817 0-14.336-.05-19.396-.28-4.68-.216-7.22-.998-8.913-1.655-2.24-.87-3.84-1.91-5.52-3.59-1.68-1.68-2.72-3.276-3.592-5.517-.657-1.69-1.44-4.23-1.653-8.91-.23-5.06-.276-6.58-.276-19.398s.046-14.33.276-19.39c.214-4.68.996-7.22 1.653-8.912.87-2.24 1.912-3.84 3.592-5.52 1.68-1.68 3.28-2.72 5.52-3.592 1.692-.66 4.233-1.44 8.913-1.655 4.428-.2 6.144-.26 15.09-.27zm29.928 7.97c-3.18 0-5.76 2.577-5.76 5.758 0 3.18 2.58 5.76 5.76 5.76 3.18 0 5.76-2.58 5.76-5.76 0-3.18-2.58-5.76-5.76-5.76zm-25.622 6.73c-13.613 0-24.65 11.037-24.65 24.65 0 13.613 11.037 24.645 24.65 24.645C79.617 90.645 90.65 79.613 90.65 66S79.616 41.35 66.003 41.35zm0 8.65c8.836 0 16 7.163 16 16 0 8.836-7.164 16-16 16-8.837 0-16-7.164-16-16 0-8.837 7.163-16 16-16z"/></svg>';
    case "facebook":
      return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="#1877F2"/><path d="M13 12.5H14.8L15.1 10.4H13V9.2C13 8.6 13.3 8.1 14.2 8.1H15.2V6.3C15.2 6.3 14.3 6.1 13.5 6.1C11.8 6.1 10.7 7.1 10.7 8.9V10.4H8.8V12.5H10.7V17.8C11.1 17.9 11.5 18 12 18C12.3 18 12.7 18 13 17.9V12.5Z" fill="white"/></svg>';
    case "youtube":
      return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="5" y="7" width="14" height="10" rx="2.4" fill="#FF0000"/><path d="M11 10V14L14.5 12L11 10Z" fill="white"/></svg>';
    case "ratio-9-16":
      return promptResolutionRatioIcon(7, 4, 10, 16);
    case "ratio-4-5":
      return promptResolutionRatioIcon(7, 4, 10, 16);
    case "ratio-square":
      return promptResolutionRatioIcon(6, 6, 12, 12);
    case "ratio-4-3":
      return promptResolutionRatioIcon(4, 7, 16, 10);
    case "ratio-5-4":
      return promptResolutionRatioIcon(4, 8, 16, 8);
    case "ratio-16-9":
      return promptResolutionRatioIcon(3, 8, 18, 8);
    case "custom-size":
      return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="5.5" y="5.5" width="13" height="13" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2"/></svg>';
    default:
      return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="6" y="6" width="12" height="12" stroke="currentColor" stroke-width="1.5"/></svg>';
  }
}

function promptResolutionRatioIcon(x, y, width, height) {
  return `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="${x + 0.5}" y="${y + 0.5}" width="${width - 1}" height="${height - 1}" stroke="currentColor" stroke-width="1"/></svg>`;
}

function promptResolutionPresetForValue(value) {
  return promptResolutionOptions()
    .find((preset) => promptResolutionValue(preset.width, preset.height) === value) || null;
}

function promptResolutionOptions() {
  return PROMPT_RESOLUTION_GROUPS.flatMap((column) => {
    const sections = Array.isArray(column.sections) ? column.sections : [column];
    return sections.flatMap((section) => section.options || []);
  });
}

function snapPromptDimension(value) {
  return Math.max(GENERATED_IMAGE_DIMENSION_MULTIPLE, Math.min(MAX_PROMPT_DIMENSION, snap_dimension(value)));
}

function ceilPromptDimension(value) {
  return Math.min(
    MAX_PROMPT_DIMENSION,
    Math.max(
      GENERATED_IMAGE_DIMENSION_MULTIPLE,
      Math.ceil((Number(value) || GENERATED_IMAGE_DIMENSION_MULTIPLE) / GENERATED_IMAGE_DIMENSION_MULTIPLE) * GENERATED_IMAGE_DIMENSION_MULTIPLE,
    ),
  );
}

function constrainPromptDimensions(width, height) {
  let w = snapPromptDimension(width);
  let h = snapPromptDimension(height);
  if (w > h * MAX_GENERATION_ASPECT_RATIO) {
    h = ceilPromptDimension(w / MAX_GENERATION_ASPECT_RATIO);
  } else if (h > w * MAX_GENERATION_ASPECT_RATIO) {
    w = ceilPromptDimension(h / MAX_GENERATION_ASPECT_RATIO);
  }
  if (w * h < MIN_GENERATION_PIXELS) {
    const scale = Math.sqrt(MIN_GENERATION_PIXELS / Math.max(1, w * h));
    w = ceilPromptDimension(w * scale);
    h = ceilPromptDimension(h * scale);
  }
  if (w > h * MAX_GENERATION_ASPECT_RATIO) {
    h = ceilPromptDimension(w / MAX_GENERATION_ASPECT_RATIO);
  } else if (h > w * MAX_GENERATION_ASPECT_RATIO) {
    w = ceilPromptDimension(h / MAX_GENERATION_ASPECT_RATIO);
  }
  return { width: w, height: h };
}

function fitLongestAxis(width, height, maxAxis) {
  return fitSize(width, height, maxAxis, maxAxis);
}

function fitSize(width, height, maxWidth, maxHeight) {
  const safeWidth = Math.max(1, Number(width) || maxWidth);
  const safeHeight = Math.max(1, Number(height) || maxHeight);
  const scale = Math.min(1, maxWidth / safeWidth, maxHeight / safeHeight);
  return {
    width: Math.round(safeWidth * scale),
    height: Math.round(safeHeight * scale),
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeOutCubic(t) {
  const p = clampNumber(t, 0, 1);
  return 1 - (1 - p) ** 3;
}

function easeInOutCubic(t) {
  const p = clampNumber(t, 0, 1);
  return p < 0.5 ? 4 * p ** 3 : 1 - ((-2 * p + 2) ** 3) / 2;
}

function slugify(value) {
  return String(value || "canvas-image")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "canvas-image";
}

function textareaCaretOffset(textarea, index) {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const properties = [
    "boxSizing",
    "width",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "letterSpacing",
    "textTransform",
    "wordSpacing",
    "lineHeight",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "whiteSpace",
    "overflowWrap",
    "wordBreak",
    "tabSize",
  ];
  properties.forEach((property) => {
    mirror.style[property] = style[property];
  });
  mirror.style.position = "fixed";
  mirror.style.left = "-10000px";
  mirror.style.top = "0";
  mirror.style.visibility = "hidden";
  mirror.style.height = "auto";
  mirror.style.minHeight = "0";
  mirror.style.maxHeight = "none";
  mirror.style.overflow = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  const value = String(textarea.value || "");
  mirror.textContent = value.slice(0, Math.max(0, index));
  const marker = document.createElement("span");
  marker.textContent = value.slice(Math.max(0, index), Math.max(0, index) + 1) || "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const markerRect = marker.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
  const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.35 || 18;
  const result = {
    left: markerRect.left - mirrorRect.left + borderLeft - textarea.scrollLeft,
    top: markerRect.top - mirrorRect.top + borderTop - textarea.scrollTop,
    height: markerRect.height || lineHeight,
  };
  mirror.remove();
  return result;
}

function featherIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const append = (tag, attrs) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
    svg.appendChild(el);
  };
  if (name === "trash") {
    append("polyline", { points: "3 6 5 6 21 6" });
    append("path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" });
    append("path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" });
    append("line", { x1: "10", y1: "11", x2: "10", y2: "17" });
    append("line", { x1: "14", y1: "11", x2: "14", y2: "17" });
  }
  if (name === "copy") {
    append("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2", ry: "2" });
    append("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" });
  }
  if (name === "download") {
    append("path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" });
    append("polyline", { points: "7 10 12 15 17 10" });
    append("line", { x1: "12", y1: "15", x2: "12", y2: "3" });
  }
  if (name === "more-horizontal") {
    append("circle", { cx: "12", cy: "12", r: "1", fill: "currentColor" });
    append("circle", { cx: "19", cy: "12", r: "1", fill: "currentColor" });
    append("circle", { cx: "5", cy: "12", r: "1", fill: "currentColor" });
  }
  if (name === "alert-triangle") {
    append("path", { d: "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" });
    append("line", { x1: "12", y1: "9", x2: "12", y2: "13" });
    append("line", { x1: "12", y1: "17", x2: "12.01", y2: "17" });
  }
  return svg;
}

function connectorChevronIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "5");
  svg.setAttribute("height", "7");
  svg.setAttribute("viewBox", "0 0 5 7");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M0.353554 0.353516L3.35355 3.35352L0.353554 6.35352");
  path.setAttribute("stroke", "currentColor");
  svg.appendChild(path);
  return svg;
}

function stackPlusIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "7");
  svg.setAttribute("height", "7");
  svg.setAttribute("viewBox", "0 0 7 7");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const horizontal = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  horizontal.setAttribute("y", "3");
  horizontal.setAttribute("width", "7");
  horizontal.setAttribute("height", "1");
  horizontal.setAttribute("fill", "black");
  const vertical = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  vertical.setAttribute("x", "4");
  vertical.setAttribute("width", "7");
  vertical.setAttribute("height", "1");
  vertical.setAttribute("transform", "rotate(90 4 0)");
  vertical.setAttribute("fill", "black");
  svg.append(horizontal, vertical);
  return svg;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

DiffuiCanvasWorkspace.prototype._teardownCollab = function _teardownCollab() {
  window.clearTimeout(this._restSaveTimer);
  this._restSaveTimer = 0;
  this._collabPausedForInactivity = false;
  this._unwireCollabInactivityTracking();
  window.clearTimeout(this._collabAwarenessTimer);
  this._collabAwarenessTimer = 0;
  window.clearTimeout(this._collabPromptFlushTimer);
  this._collabPromptFlushTimer = 0;
  this._pendingCollabAwareness = null;
  this._pendingCollabClickEffect = null;
  this._collabClickEffectSeen.clear();
  window.clearTimeout(this._collabSyncTimer);
  this._collabSyncTimer = 0;
  this._collabDocReady = false;
  this._collabLastFullSyncAt = 0;
  this._collabPeerMoveAt.clear();
  this._collabPeerRectAt.clear();
  this._collabPeerRects.clear();
  this._collabMoveSmoothTargets.clear();
  this._stopCollabMoveSmooth();
  this.shadowRoot?.getElementById("collabRectLayer")?.replaceChildren();
  this._collabLocalDirty = false;
  this._collabPendingCommit = false;
  this._pendingRemoteCanvasState = null;
  this._lastCollabPushedRaw = "";
  this._collabApplyingRemoteMove = false;
  window.cancelAnimationFrame(this._collabCursorAnimation);
  this._collabCursorAnimation = 0;
  this._collab?.disconnect();
  this._collab = null;
  this._crdt?.destroy();
  this._crdt = null;
  this._collabPeers.clear();
  this._collabCursors.clear();
  this._collabConnected = false;
  this._dispatchCanvasPresence();
};

DiffuiCanvasWorkspace.prototype._initCollab = async function _initCollab(initialState) {
  this._teardownCollab();
  if (!this._projectId) return;
  const readOnly = !this._canEditCollab();
  this._crdt = new CanvasCRDT();
  this._collab = new CanvasCollabProvider({
    projectId: this._projectId,
    apiFetch: (path, opts) => this._api(path, opts),
    readOnly,
    getWsUrl: (pid) => {
      const embed = window.DIFFUI_EMBED === true;
      const base = embed ? new URL(resolveEmbedApiUrl("/")) : new URL(window.location.href);
      const proto = base.protocol === "https:" ? "wss:" : "ws:";
      let wsPath = `${proto}//${base.host}/api/projects/${encodeURIComponent(pid)}/collab`;
      const token = String(window.DIFFUI_API_KEY || "").trim();
      if (embed && token) wsPath += `?access_token=${encodeURIComponent(token)}`;
      return withPublicShareParam(wsPath);
    },
  });
  this._collab.attach(this._crdt);
  this._crdt.onStateChange((remoteState, origin) => {
    if (origin === "remote") this._applyRemoteCanvasState(remoteState);
  });
  this._collab.onDocReady(() => {
    this._collabDocReady = true;
    this._collabPendingCommit = false;
    this._reconcileCollabWithEngine({
      forcePush: this._collabLocalDirty,
    });
  });
  this._collab.onAwareness((bytes) => this._applyCollabAwareness(bytes));
  this._collab.onConnectionChange((connected) => {
    this._collabConnected = connected;
    this._dispatchCanvasPresence();
  });
  this._collab.onAccessLost(() => {
    this._setStatus("Access revoked");
    this._teardownCollab();
  });
  this._collab.connect();
  this._collabPausedForInactivity = false;
  this._wireCollabInactivityTracking();
  this._resetCollabInactivityTimer();
  this._publishCollabAwareness();
  this._dispatchCanvasPresence();
};

DiffuiCanvasWorkspace.prototype._scheduleCollabPromptFlush = function _scheduleCollabPromptFlush() {
  if (!this._collabConnected || !this._collabDocReady || this._canvasAccess !== "edit") return;
  window.clearTimeout(this._collabPromptFlushTimer);
  this._collabPromptFlushTimer = window.setTimeout(() => {
    this._collabPromptFlushTimer = 0;
    this._flushCollabStateSync();
  }, 100);
};

DiffuiCanvasWorkspace.prototype._scheduleCollabStateSync = function _scheduleCollabStateSync() {
  if (!this._collabConnected || !this._collabDocReady || !this._canEditCollab() || !this._crdt) return;
  window.clearTimeout(this._collabSyncTimer);
  this._collabSyncTimer = window.setTimeout(() => {
    this._collabSyncTimer = 0;
    this._pushLocalStateToCRDT();
  }, 32);
};

DiffuiCanvasWorkspace.prototype._canEditCollab = function _canEditCollab() {
  return this._canvasAccess === "owner" || this._canvasAccess === "edit";
};

DiffuiCanvasWorkspace.prototype._canCommentCollab = function _canCommentCollab() {
  // Commenting is the one mutation a signed-out share viewer may make, so this
  // deliberately includes anonymous viewers. The server merges their PUT
  // append-only, so they can add but never edit or delete anyone else's.
  return this._canEditCollab() || this._canvasAccess === "view";
};

DiffuiCanvasWorkspace.prototype._markCollabDirty = function _markCollabDirty() {
  this._collabLocalDirty = true;
};

DiffuiCanvasWorkspace.prototype._flushCollabStateSync = function _flushCollabStateSync(options = {}) {
  if (!this._collabDocReady || !this._canEditCollab()) return;
  window.clearTimeout(this._collabSyncTimer);
  this._collabSyncTimer = 0;
  this._pushLocalStateToCRDT(options);
};

DiffuiCanvasWorkspace.prototype._commitCollabState = function _commitCollabState() {
  this._markCollabDirty();
  this._bumpCollabRevision();
  this._queueSave();
  if (this._collabConnected && this._collabDocReady) {
    this._flushCollabStateSync({ force: true });
    if (this._collab?.persistSnapshot) {
      this._collab.persistSnapshot().catch(() => null);
    }
  } else if (this._collabConnected) {
    this._collabPendingCommit = true;
  }
  this._saveState().catch(() => null);
};

DiffuiCanvasWorkspace.prototype._flushCollabMoveEnd = function _flushCollabMoveEnd() {
  this._commitCollabState();
};

DiffuiCanvasWorkspace.prototype._flushCollabConnectEnd = function _flushCollabConnectEnd() {
  this._commitCollabState();
};

DiffuiCanvasWorkspace.prototype._bumpCollabRevision = function _bumpCollabRevision() {
  const meta = this._normalizeCanvasMetadata(this._canvasMetadata || this._state?.metadata);
  const rev = Math.max(Number(meta.collabRev || 0) + 1, Date.now());
  this._canvasMetadata = { ...meta, collabRev: rev };
  this._state.metadata = this._canvasMetadata;
};

DiffuiCanvasWorkspace.prototype._mergeCollabEdges = function _mergeCollabEdges(localEdges = [], remoteEdges = []) {
  const map = new Map();
  for (const edge of [...localEdges, ...remoteEdges]) {
    if (!edge?.id) continue;
    const existing = map.get(edge.id) || {};
    map.set(edge.id, {
      ...existing,
      ...edge,
      id: edge.id,
      kind: edge.kind || existing.kind || "prompt_input",
      from_node_id: edge.from_node_id || edge.fromNodeId || existing.from_node_id || existing.fromNodeId || "",
      to_node_id: edge.to_node_id || edge.toNodeId || existing.to_node_id || existing.toNodeId || "",
      fromNodeId: edge.fromNodeId || edge.from_node_id || existing.fromNodeId || existing.from_node_id || "",
      toNodeId: edge.toNodeId || edge.to_node_id || existing.toNodeId || existing.to_node_id || "",
      inputFacets: edge.inputFacets || edge.input_facets || existing.inputFacets || existing.input_facets,
    });
  }
  return [...map.values()];
};

DiffuiCanvasWorkspace.prototype._collabStateRank = function _collabStateRank(state) {
  if (!state || typeof state !== "object") return 0;
  const rev = this._collabRevision(state);
  const edges = Array.isArray(state.edges) ? state.edges.length : 0;
  const comments = Array.isArray(state.comments) ? state.comments.length : 0;
  let images = 0;
  for (const node of state.nodes || []) images += this._nodeImages(node).length;
  const nodes = Array.isArray(state.nodes) ? state.nodes.length : 0;
  return rev * 1e9 + edges * 1e6 + images * 1e3 + nodes + comments;
};

/** Canvas state synced over CRDT — viewport is per-client and excluded. */
DiffuiCanvasWorkspace.prototype._collabStateForShare = function _collabStateForShare(state) {
  if (!state || typeof state !== "object") return {};
  const shared = { ...state };
  delete shared.viewport;
  return shared;
};

DiffuiCanvasWorkspace.prototype._collabRevision = function _collabRevision(state) {
  return Number(this._normalizeCanvasMetadata(state?.metadata)?.collabRev || 0);
};

DiffuiCanvasWorkspace.prototype._localCollabShareableState = function _localCollabShareableState() {
  const state = safeParse(this._engine?.serialize?.()) || { ...this._state };
  state.metadata = this._normalizeCanvasMetadata(this._canvasMetadata);
  state.comments = this._normalizeCanvasComments(this._comments);
  return this._collabStateForShare(state);
};

DiffuiCanvasWorkspace.prototype._reconcileCollabWithEngine = function _reconcileCollabWithEngine(options = {}) {
  if (!this._crdt || !this._collabDocReady || !this._engine) return;
  const remote = this._crdt.getState();
  const localShareable = this._localCollabShareableState();
  const remoteRank = this._collabStateRank(remote);
  const localRank = this._collabStateRank(localShareable);
  if (remote && remoteRank > localRank) {
    this._applyRemoteCanvasState(remote, { force: true });
    return;
  }
  if (localRank > remoteRank || options.forcePush) {
    this._lastCollabPushedRaw = "";
    this._markCollabDirty();
    this._flushCollabStateSync({ force: true });
  }
};

DiffuiCanvasWorkspace.prototype._mergeRemoteCollabState = function _mergeRemoteCollabState(remoteState) {
  const expandedByImageId = new Map();
  for (const node of this._state.nodes || []) {
    for (const image of this._nodeImages(node)) {
      const metadata = safeParse(image?.metadata_json || image?.metadataJson) || {};
      const imageId = String(metadata.imageId || "").trim();
      if (imageId && metadata.expandedPrompt && typeof metadata.expandedPrompt === "object") {
        expandedByImageId.set(imageId, metadata.expandedPrompt);
      }
    }
  }
  if (expandedByImageId.size && Array.isArray(remoteState?.nodes)) {
    remoteState = {
      ...remoteState,
      nodes: remoteState.nodes.map((node) => {
        const images = this._nodeImages(node);
        let changed = false;
        const nextImages = images.map((image) => {
          const metadata = safeParse(image?.metadata_json || image?.metadataJson) || {};
          const expandedPrompt = expandedByImageId.get(String(metadata.imageId || "").trim());
          if (!expandedPrompt || (metadata.expandedPrompt && typeof metadata.expandedPrompt === "object")) return image;
          changed = true;
          return {
            ...image,
            metadata_json: JSON.stringify({ ...metadata, expandedPrompt, analysisStatus: "done" }),
          };
        });
        return changed ? { ...node, images: nextImages } : node;
      }),
    };
  }
  const localViewport = {
    x: this._state.viewport?.x ?? 0,
    y: this._state.viewport?.y ?? 0,
    scale: this._state.viewport?.scale ?? 1,
  };
  const editingId = this._activePromptEditorNodeId();
  let merged = {
    ...remoteState,
    viewport: localViewport,
    edges: this._mergeCollabEdges(this._state.edges, remoteState.edges),
    comments: this._normalizeCanvasComments(remoteState.comments),
  };
  if (editingId && Array.isArray(remoteState.nodes)) {
    const localNode = this._state.nodes.find((node) => node.id === editingId);
    if (localNode) {
      merged = {
        ...merged,
        nodes: remoteState.nodes.map((node) => (
          node.id === editingId ? { ...node, prompt: localNode.prompt } : node
        )),
      };
    }
  }
  return merged;
};

DiffuiCanvasWorkspace.prototype._pushLocalStateToCRDT = function _pushLocalStateToCRDT(options = {}) {
  const force = options.force === true;
  if (!this._crdt || this._collabApplyingRemote || this._collabApplyingRemoteMove || !this._collabDocReady) return;
  if (!this._collabLocalDirty && !force) return;
  const shareable = this._localCollabShareableState();
  const remote = this._crdt.getState();
  if (remote?.edges) shareable.edges = this._mergeCollabEdges(shareable.edges, remote.edges);
  const raw = JSON.stringify(shareable);
  if (!force && raw === this._lastCollabPushedRaw) return;
  this._lastCollabPushedRaw = raw;
  this._crdt.setState(shareable);
  this._collabLocalDirty = false;
  this._collabPendingCommit = false;
};

DiffuiCanvasWorkspace.prototype._hasActivePeerMoveSession = function _hasActivePeerMoveSession() {
  for (const peer of this._collabPeers.values()) {
    const nodes = peer.session?.move?.nodes;
    if (Array.isArray(nodes) && nodes.length) return true;
  }
  return false;
};

DiffuiCanvasWorkspace.prototype._hasActivePeerGestureSession = function _hasActivePeerGestureSession() {
  if (this._hasActivePeerMoveSession()) return true;
  for (const peer of this._collabPeers.values()) {
    if (peer.session?.port?.from) return true;
  }
  return false;
};

DiffuiCanvasWorkspace.prototype._flushPendingRemoteCanvasState = function _flushPendingRemoteCanvasState() {
  if (this._hasActivePeerMoveSession()) return;
  const pending = this._pendingRemoteCanvasState;
  if (!pending) return;
  const pendingEdges = Array.isArray(pending.edges) ? pending.edges.length : 0;
  const localEdges = Array.isArray(this._state.edges) ? this._state.edges.length : 0;
  if (pendingEdges > localEdges && this._collabStateRank(pending) >= this._collabStateRank(this._state)) {
    this._tryApplyPendingRemoteCanvasState();
    return;
  }
  // Drop deferred mid-move snapshots; keep smoothed positions until the authoritative
  // post-release CRDT update arrives from the peer who was dragging.
  this._pendingRemoteCanvasState = null;
};

DiffuiCanvasWorkspace.prototype._tryApplyPendingRemoteCanvasState = function _tryApplyPendingRemoteCanvasState() {
  const pending = this._pendingRemoteCanvasState;
  if (!pending || this._hasActivePeerMoveSession()) return;
  this._pendingRemoteCanvasState = null;
  this._applyRemoteCanvasState(pending, { force: true });
};

DiffuiCanvasWorkspace.prototype._applyRemoteCanvasState = function _applyRemoteCanvasState(remoteState, options = {}) {
  if (!remoteState || !this._engine) return;
  const remoteRank = this._collabStateRank(remoteState);
  const localRank = this._collabStateRank(this._state);
  if (!options.force && remoteRank < localRank) {
    this._reconcileCollabWithEngine({ forcePush: true });
    return;
  }
  if (!options.force && remoteRank === localRank) {
    const localEdgeIds = new Set((this._state.edges || []).map((edge) => edge.id).filter(Boolean));
    const hasNewRemoteEdge = (remoteState.edges || []).some((edge) => edge?.id && !localEdgeIds.has(edge.id));
    if (!hasNewRemoteEdge) return;
  }
  // Only defer during peer node moves — port-wire previews are awareness-only and must not
  // block the post-connect CRDT update from landing when the dragger releases.
  if (!options.force && this._hasActivePeerMoveSession()) {
    this._pendingRemoteCanvasState = remoteState;
    return;
  }
  this._collabLastFullSyncAt = Date.now();
  this._collabMoveSmoothTargets.clear();
  this._collabPortSmoothTargets.clear();
  this._stopCollabMoveSmooth();
  this._pendingRemoteCanvasState = null;
  window.clearTimeout(this._collabSyncTimer);
  this._collabSyncTimer = 0;
  const merged = this._mergeRemoteCollabState(remoteState);
  this._collabApplyingRemote = true;
  try {
    this._canvasMetadata = this._normalizeCanvasMetadata(merged?.metadata);
    this._comments = this._normalizeCanvasComments(merged?.comments);
    this._engine.load(JSON.stringify(merged));
    this._engine?.set_viewport(merged.viewport.x, merged.viewport.y, merged.viewport.scale);
    this._syncStateFromEngine();
    this._syncPromptOverlays();
    this._syncCommentLayer();
    this._draw();
  } finally {
    this._collabApplyingRemote = false;
    this._collabLocalDirty = false;
  }
};

DiffuiCanvasWorkspace.prototype._activePromptEditorNodeId = function _activePromptEditorNodeId() {
  const active = this.shadowRoot?.activeElement;
  if (!active?.matches?.("textarea")) return "";
  const box = active.closest?.(".promptBox");
  return String(box?.dataset?.nodeId || "").trim();
};

DiffuiCanvasWorkspace.prototype._remotePromptDraftForNode = function _remotePromptDraftForNode(nodeId) {
  let latest = null;
  let latestAt = 0;
  for (const peer of this._collabPeers.values()) {
    const draft = peer.session?.prompt;
    if (!draft || draft.nodeId !== nodeId) continue;
    const at = Number(peer.lastSeen || draft.at || 0);
    if (at >= latestAt) {
      latestAt = at;
      latest = String(draft.text ?? "");
    }
  }
  return latest;
};

DiffuiCanvasWorkspace.prototype._collabRectSessionPayload = function _collabRectSessionPayload() {
  const pointer = this._pointer;
  if (pointer?.mode === "draw-rect" && pointer.start && pointer.current) {
    const rect = normalizeRect(pointer.start, pointer.current);
    if (rect.width <= 0 || rect.height <= 0) return null;
    const payload = {
      mode: "draw-rect",
      start: { x: pointer.start.x, y: pointer.start.y },
      current: { x: pointer.current.x, y: pointer.current.y },
      targetImageId: pointer.targetImageId || "",
      at: Date.now(),
    };
    const targetImage = payload.targetImageId
      ? this._state.nodes.find((node) => node.id === payload.targetImageId)
      : null;
    const cropRect = targetImage ? intersectRects(rect, nodeRect(targetImage)) : null;
    if (cropRect) payload.cropRect = cropRect;
    if (!targetImage && !pointer.imagesOnly) {
      const preview = this._drawRectPromptPreviewRect(pointer, rect);
      if (preview) payload.promptPreviewRect = preview;
    }
    return payload;
  }
  if (pointer?.mode === "resize-inpaint" && this._inpaint?.cropRect) {
    return {
      mode: "resize-inpaint",
      sourceNodeId: this._inpaint.sourceNodeId || "",
      cropRect: { ...this._inpaint.cropRect },
      at: Date.now(),
    };
  }
  return null;
};

DiffuiCanvasWorkspace.prototype._buildCollabSessionPayload = function _buildCollabSessionPayload() {
  const session = {};
  const rectSession = this._collabRectSessionPayload();
  if (rectSession) session.rect = rectSession;
  if (this._pointer?.mode === "move-node" && Array.isArray(this._pointer.selectedNodeIds)) {
    const nodes = this._pointer.selectedNodeIds
      .map((id) => this._state.nodes.find((node) => node.id === id))
      .filter(Boolean)
      .map((node) => ({ id: node.id, x: node.x, y: node.y }));
    if (nodes.length) session.move = { nodes, at: Date.now() };
  }
  if (this._dragPort?.from) {
    session.port = {
      from: this._dragPort.from,
      x: this._dragPort.x,
      y: this._dragPort.y,
      targetPromptId: this._dragPort.targetPromptId || "",
      promptPreviewRect: this._dragPort.promptPreviewRect || null,
      at: Date.now(),
    };
  }
  for (const [nodeId, direction] of this._stackScrollDirectionByNode) {
    const node = this._state.nodes.find((entry) => entry.id === nodeId);
    if (!node) continue;
    const images = this._readyImagesForNode(node);
    const index = this._activeImageIndex(node, images);
    const image = images[index];
    session.stack = {
      nodeId,
      imageId: image?.id || "",
      index,
      direction,
      at: Date.now(),
    };
    break;
  }
  const editorId = this._activePromptEditorNodeId();
  if (editorId) {
    const textarea = this.shadowRoot.querySelector(
      `.promptBox[data-node-id="${CSS.escape(editorId)}"] textarea`,
    );
    if (textarea) {
      session.prompt = { nodeId: editorId, text: textarea.value, at: Date.now() };
    }
  }
  const chatPayload = this._cursorChatPayloadForAwareness();
  if (chatPayload) session.chat = chatPayload;
  if (this._pendingCollabClickEffect) {
    // One-shot: consumed here so it rides exactly one awareness frame.
    session.effect = this._pendingCollabClickEffect;
    this._pendingCollabClickEffect = null;
  }
  return Object.keys(session).length ? session : null;
};

DiffuiCanvasWorkspace.prototype._createCollabClientSessionId = function _createCollabClientSessionId() {
  const storageKey = "diffui.collab.clientSessionId";
  try {
    let id = sessionStorage.getItem(storageKey);
    if (!id) {
      id = `client-${crypto.randomUUID()}`;
      sessionStorage.setItem(storageKey, id);
    }
    return id;
  } catch {
    return `client-${crypto.randomUUID()}`;
  }
};

DiffuiCanvasWorkspace.prototype._collabClientId = function _collabClientId() {
  return String(this._collabClientSessionId || "");
};

DiffuiCanvasWorkspace.prototype._collabAccountId = function _collabAccountId() {
  return String(window.DIFFUI_USER_ID || "local");
};

DiffuiCanvasWorkspace.prototype._collabClientColor = function _collabClientColor() {
  if (!this._collabClientColorValue) {
    this._collabClientColorValue = getOrCreateClientCollabColor();
  }
  return this._collabClientColorValue;
};

DiffuiCanvasWorkspace.prototype._collabColorForId = function _collabColorForId(id) {
  return collabColorFromId(id);
};

DiffuiCanvasWorkspace.prototype._scheduleCollabAwareness = function _scheduleCollabAwareness(worldX, worldY) {
  if (!this._collab) return;
  if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return;
  this._pendingCollabAwareness = { x: worldX, y: worldY };
  if (this._collabAwarenessTimer) return;
  this._collabAwarenessTimer = window.setTimeout(() => {
    this._collabAwarenessTimer = 0;
    const pending = this._pendingCollabAwareness;
    this._pendingCollabAwareness = null;
    if (pending) this._publishCollabAwareness(pending.x, pending.y);
  }, 48);
};

DiffuiCanvasWorkspace.prototype._publishCollabAwareness = function _publishCollabAwareness(worldX, worldY) {
  if (!this._collab) return;
  const selected = this._state?.nodes?.find((n) => n.selected);
  const clientId = this._collabClientId();
  const userId = this._collabAccountId();
  const payload = {
    id: clientId,
    userId,
    name: String(window.DIFFUI_USER_NAME || "You").slice(0, 24),
    avatarUrl: String(window.DIFFUI_USER_AVATAR || "").trim(),
    color: this._collabClientColor(),
    nodeId: selected?.id || "",
    at: Date.now(),
  };
  if (Number.isFinite(worldX) && Number.isFinite(worldY)) {
    payload.x = worldX;
    payload.y = worldY;
  }
  const session = this._buildCollabSessionPayload();
  if (session) payload.session = session;
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  this._collab.setAwareness(bytes);
};

/**
 * Relays a loupe the local user just triggered so every peer plays it too. Only
 * called from the double-click path that starts the animation locally, so plain
 * clicks never reach the wire.
 */
DiffuiCanvasWorkspace.prototype._publishCollabClickEffect = function _publishCollabClickEffect(effect) {
  if (!this._collab || !effect) return;
  const relay = buildClickEffectAwareness({
    effectId: `effect-${crypto.randomUUID()}`,
    sourceNodeId: effect.sourceNodeId,
    imageUrl: effect.imageUrl,
    origin: effect.origin,
    destination: effect.destination,
    click: effect.click,
    tilt: effect.tilt,
    at: Date.now(),
  });
  if (!relay) return;
  this._pendingCollabClickEffect = relay;
  window.clearTimeout(this._collabAwarenessTimer);
  this._collabAwarenessTimer = 0;
  this._pendingCollabAwareness = null;
  // Publish immediately rather than waiting on the cursor debounce, then publish
  // again: the provider replays its last awareness payload on reconnect, and the
  // second frame leaves it holding one without the effect.
  this._publishCollabAwareness(effect.origin.x, effect.origin.y);
  this._publishCollabAwareness(effect.origin.x, effect.origin.y);
};

DiffuiCanvasWorkspace.prototype._applyCollabPeerClickEffect = function _applyCollabPeerClickEffect(payload) {
  const relayed = readClickEffectAwareness(payload, {
    selfClientId: this._collabClientId(),
    seen: this._collabClickEffectSeen,
  });
  if (!relayed) return;
  const effect = this._createRemoteThumbnailLiftEffect(relayed);
  if (!effect) return;
  this._clickEffects.push(effect);
  this._queueClickEffectFrame();
};

DiffuiCanvasWorkspace.prototype._stopCollabMoveSmooth = function _stopCollabMoveSmooth() {
  if (this._collabMoveSmoothRaf) {
    window.cancelAnimationFrame(this._collabMoveSmoothRaf);
    this._collabMoveSmoothRaf = 0;
  }
};

DiffuiCanvasWorkspace.prototype._startCollabMoveSmooth = function _startCollabMoveSmooth() {
  if (this._collabMoveSmoothRaf) return;
  const smoothFactor = 0.34;
  const snapEps = 0.4;
  const portSnapEps = 0.4;
  const tick = () => {
    this._collabMoveSmoothRaf = 0;
    const engineNodes = this._engine?.state?.nodes;
    let settling = false;
    if (engineNodes && this._collabMoveSmoothTargets.size) {
      for (const targets of this._collabMoveSmoothTargets.values()) {
        for (const [nodeId, item] of targets) {
          const node = engineNodes.find((entry) => entry.id === nodeId);
          if (!node) continue;
          let cx = Number.isFinite(item.x) ? item.x : node.x;
          let cy = Number.isFinite(item.y) ? item.y : node.y;
          const dx = item.tx - cx;
          const dy = item.ty - cy;
          if (Math.hypot(dx, dy) < snapEps) {
            node.x = item.tx;
            node.y = item.ty;
            item.x = item.tx;
            item.y = item.ty;
          } else {
            cx += dx * smoothFactor;
            cy += dy * smoothFactor;
            node.x = cx;
            node.y = cy;
            item.x = cx;
            item.y = cy;
            settling = true;
          }
        }
      }
    }
    for (const port of this._collabPortSmoothTargets.values()) {
      this._smoothPortDragRender(port, port.x, port.y);
      if (Math.hypot(port.renderX - port.x, port.renderY - port.y) > portSnapEps) settling = true;
    }
    if (this._collabMoveSmoothTargets.size || this._collabPortSmoothTargets.size) {
      this._collabApplyingRemoteMove = true;
      try {
        if (this._collabMoveSmoothTargets.size) {
          this._syncStateFromEngine();
          this._syncPromptOverlays();
        }
        this._draw();
      } finally {
        this._collabApplyingRemoteMove = false;
      }
    }
    if (settling) this._collabMoveSmoothRaf = window.requestAnimationFrame(tick);
  };
  this._collabMoveSmoothRaf = window.requestAnimationFrame(tick);
};

DiffuiCanvasWorkspace.prototype._applyCollabPeerRect = function _applyCollabPeerRect(peerId, payload) {
  const rect = payload?.session?.rect;
  if (!rect?.mode) {
    this._collabPeerRects.delete(peerId);
    this._collabPeerRectAt.delete(peerId);
    this._syncRemoteCollabRectOverlays();
    return;
  }
  const at = Number(rect.at || payload.at || 0);
  if (at <= (this._collabPeerRectAt.get(peerId) || 0)) return;
  this._collabPeerRectAt.set(peerId, at);
  this._collabPeerRects.set(peerId, {
    ...rect,
    color: resolveCollabColor(payload.color, peerId),
  });
  this._syncRemoteCollabRectOverlays();
};

DiffuiCanvasWorkspace.prototype._applyCollabPeerStack = function _applyCollabPeerStack(peerId, payload) {
  const stack = payload?.session?.stack;
  if (!stack?.nodeId || !Number.isFinite(stack.direction)) return;
  const at = Number(stack.at || payload.at || 0);
  if (at <= (this._collabPeerStackAt.get(peerId) || 0)) return;
  this._collabPeerStackAt.set(peerId, at);
  const direction = stack.direction > 0 ? 1 : -1;
  this._stackScrollDirectionByNode.set(stack.nodeId, direction);
  const node = this._state.nodes.find((entry) => entry.id === stack.nodeId);
  if (!node) return;
  const readyImages = this._readyImagesForNode(node);
  let targetIndex = Number(stack.index);
  if (!Number.isFinite(targetIndex) && stack.imageId) {
    targetIndex = readyImages.findIndex((image) => image.id === stack.imageId);
  }
  if (targetIndex >= 0 && targetIndex < readyImages.length) {
    const current = this._activeImageIndex(node, readyImages);
    if (current !== targetIndex) {
      this._patchNode(stack.nodeId, { stackIndex: targetIndex, stack_index: targetIndex }, { quiet: true });
    }
  }
  window.requestAnimationFrame(() => {
    this._syncPromptOverlays();
    this._draw();
  });
};

DiffuiCanvasWorkspace.prototype._applyCollabPeerPort = function _applyCollabPeerPort(peerId, payload) {
  const port = payload?.session?.port;
  if (!port?.from || !Number.isFinite(port.x) || !Number.isFinite(port.y)) {
    this._collabPortSmoothTargets.delete(peerId);
    if (!this._collabMoveSmoothTargets.size && !this._collabPortSmoothTargets.size) this._stopCollabMoveSmooth();
    this._tryApplyPendingRemoteCanvasState();
    this._draw();
    return;
  }
  let entry = this._collabPortSmoothTargets.get(peerId);
  if (!entry) {
    entry = {
      from: port.from,
      x: port.x,
      y: port.y,
      renderX: port.x,
      renderY: port.y,
      targetPromptId: port.targetPromptId || "",
      promptPreviewRect: port.promptPreviewRect || null,
    };
    this._collabPortSmoothTargets.set(peerId, entry);
  } else {
    entry.from = port.from;
    entry.x = port.x;
    entry.y = port.y;
    entry.targetPromptId = port.targetPromptId || "";
    entry.promptPreviewRect = port.promptPreviewRect || null;
    this._smoothPortDragRender(entry, port.x, port.y);
  }
  this._startCollabMoveSmooth();
};

DiffuiCanvasWorkspace.prototype._applyCollabPeerMove = function _applyCollabPeerMove(peerId, payload) {
  const move = payload?.session?.move;
  if (!move?.nodes?.length) {
    this._collabPeerMoveAt.delete(peerId);
    this._collabMoveSmoothTargets.delete(peerId);
    if (!this._collabMoveSmoothTargets.size && !this._collabPortSmoothTargets.size) this._stopCollabMoveSmooth();
    this._flushPendingRemoteCanvasState();
    return;
  }
  const at = Number(move.at || payload.at || 0);
  if (at <= (this._collabPeerMoveAt.get(peerId) || 0)) return;
  if (at <= (this._collabLastFullSyncAt || 0)) return;
  this._collabPeerMoveAt.set(peerId, at);
  const engineNodes = this._engine?.state?.nodes;
  if (!engineNodes) return;
  let targets = this._collabMoveSmoothTargets.get(peerId);
  if (!targets) {
    targets = new Map();
    this._collabMoveSmoothTargets.set(peerId, targets);
  }
  for (const placement of move.nodes) {
    if (!placement?.id || !Number.isFinite(placement.x) || !Number.isFinite(placement.y)) continue;
    const node = engineNodes.find((entry) => entry.id === placement.id);
    const existing = targets.get(placement.id);
    if (!existing && node) {
      targets.set(placement.id, { tx: placement.x, ty: placement.y, x: node.x, y: node.y });
    } else {
      targets.set(placement.id, {
        tx: placement.x,
        ty: placement.y,
        x: existing?.x ?? placement.x,
        y: existing?.y ?? placement.y,
      });
    }
  }
  this._startCollabMoveSmooth();
};

DiffuiCanvasWorkspace.prototype._removeCollabPeer = function _removeCollabPeer(peerId) {
  const id = String(peerId || "");
  if (!id) return false;
  const hadPeer = this._collabPeers.has(id)
    || this._collabCursors.has(id)
    || this._collabPeerRects.has(id)
    || this._collabMoveSmoothTargets.has(id)
    || this._collabPortSmoothTargets.has(id);
  if (!hadPeer) return false;
  this._collabPeers.delete(id);
  this._collabCursors.delete(id);
  this._collabPeerMoveAt.delete(id);
  this._collabMoveSmoothTargets.delete(id);
  this._collabPortSmoothTargets.delete(id);
  this._collabPeerRects.delete(id);
  this._collabPeerRectAt.delete(id);
  this._collabPeerStackAt.delete(id);
  if (!this._collabMoveSmoothTargets.size && !this._collabPortSmoothTargets.size) {
    this._stopCollabMoveSmooth();
  }
  return true;
};

DiffuiCanvasWorkspace.prototype._applyCollabAwareness = function _applyCollabAwareness(bytes) {
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload?.id || payload.id === this._collabClientId()) return;
    if (payload.leave === true) {
      if (this._removeCollabPeer(payload.id)) {
        this._dispatchCanvasPresence();
        this._syncRemoteCollabRectOverlays();
        this._flushPendingRemoteCanvasState();
        this._syncPromptOverlays();
        this._draw();
      }
      return;
    }
    payload.lastSeen = Date.now();
    this._collabPeers.set(payload.id, payload);
    this._applyCollabPeerMove(payload.id, payload);
    this._applyCollabPeerPort(payload.id, payload);
    this._applyCollabPeerStack(payload.id, payload);
    this._applyCollabPeerRect(payload.id, payload);
    this._applyCollabPeerClickEffect(payload);
    if (payload.session?.prompt?.nodeId) {
      this._syncPromptOverlays();
    }
    if (payload.session?.chat) {
      this._queueCollabCursorFrame();
    }
    if (payload.session?.port || this._collabPortSmoothTargets.has(payload.id)) {
      this._draw();
    }
    if (payload.session?.rect || this._collabPeerRects.has(payload.id)) {
      this._syncRemoteCollabRectOverlays();
    }
    if (Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
      let item = this._collabCursors.get(payload.id);
      if (!item) {
        item = {
          targetX: payload.x,
          targetY: payload.y,
          currentX: payload.x,
          currentY: payload.y,
          label: payload.name || "Collaborator",
          color: resolveCollabColor(payload.color, payload.id),
          chat: payload.session?.chat?.text ? { ...payload.session.chat } : null,
        };
        this._collabCursors.set(payload.id, item);
        this._queueCollabCursorFrame();
      } else {
        const moved = item.targetX !== payload.x || item.targetY !== payload.y;
        item.targetX = payload.x;
        item.targetY = payload.y;
        item.label = String(payload.name || item.label || "Collaborator");
        item.color = resolveCollabColor(payload.color || item.color, payload.id);
        if (payload.session?.chat?.text) {
          item.chat = { ...payload.session.chat };
        } else {
          item.chat = null;
        }
        if (moved || payload.session?.chat) this._queueCollabCursorFrame();
      }
    } else if (payload.session?.chat?.text) {
      const item = this._collabCursors.get(payload.id);
      if (item) {
        item.chat = { ...payload.session.chat };
        this._queueCollabCursorFrame();
      }
    }
    this._dispatchCanvasPresence();
  } catch {
    /* ignore malformed awareness */
  }
};

DiffuiCanvasWorkspace.prototype._collabCursorNeedsAnimation = function _collabCursorNeedsAnimation(now = performance.now()) {
  for (const item of this._collabCursors.values()) {
    if (Math.hypot(item.targetX - item.currentX, item.targetY - item.currentY) > 0.5) return true;
    if (item.chat && this._cursorChatBubbleVisible(item.chat, now)) return true;
  }
  if (this._cursorChat?.phase === "posted" && this._cursorChatBubbleVisible(this._cursorChat, now)) return true;
  return false;
};

DiffuiCanvasWorkspace.prototype._queueCollabCursorFrame = function _queueCollabCursorFrame() {
  if (this._collabCursorAnimation) return;
  if (!this._collabCursorNeedsAnimation()) return;
  const tick = () => {
    this._collabCursorAnimation = 0;
    this._draw();
    if (this._collabCursorNeedsAnimation()) {
      this._collabCursorAnimation = window.requestAnimationFrame(tick);
    }
  };
  this._collabCursorAnimation = window.requestAnimationFrame(tick);
};

DiffuiCanvasWorkspace.prototype._drawCollabPointerCursor = function _drawCollabPointerCursor(ctx, screenX, screenY, color) {
  return drawCollabCursor(ctx, screenX, screenY, color, () => {
    if (typeof this._drawCollabCursorLayer === "function") this._drawCollabCursorLayer();
  });
};

DiffuiCanvasWorkspace.prototype._drawCollabCursors = function _drawCollabCursors(ctx, now = performance.now()) {
  if (!this._collabCursors.size) return;
  const staleMs = 12000;
  const dead = [];
  let needsAnimation = false;
  for (const [id, item] of this._collabCursors) {
    const peer = this._collabPeers.get(id);
    if (peer?.lastSeen && now - peer.lastSeen > staleMs) {
      dead.push(id);
      continue;
    }
    const dx = item.targetX - item.currentX;
    const dy = item.targetY - item.currentY;
    if (Math.hypot(dx, dy) > 0.5) {
      item.currentX += dx * 0.35;
      item.currentY += dy * 0.35;
      needsAnimation = true;
    } else {
      item.currentX = item.targetX;
      item.currentY = item.targetY;
    }
    const screen = this._worldToScreen(item.currentX, item.currentY);
    const x = screen.x;
    const y = screen.y;
    const color = resolveCollabColor(item.color || peer?.color, id);
    const chat = item.chat;
    if (chat?.phase === "posted" && chat.text && !this._cursorChatBubbleVisible(chat, now)) {
      item.chat = null;
    }
    ctx.save();
    this._drawCollabPointerCursor(ctx, x, y, color);
    const activeChat = item.chat;
    if (activeChat?.text && this._cursorChatBubbleVisible(activeChat, now)) {
      drawCollabChatBubble(ctx, x, y, activeChat.text, color, {
        opacity: this._cursorChatBubbleOpacity(activeChat, now),
      });
    } else {
      drawCollabCursorLabel(ctx, x, y, item.label, color);
    }
    ctx.restore();
  }
  dead.forEach((id) => {
    this._removeCollabPeer(id);
  });
  if (dead.length) {
    this._dispatchCanvasPresence();
    this._draw();
    this._syncPromptOverlays();
  }
  if (needsAnimation) this._queueCollabCursorFrame();
};

DiffuiCanvasWorkspace.prototype._defaultCursorChatWorld = function _defaultCursorChatWorld() {
  const canvas = this.shadowRoot.getElementById("canvas");
  if (!canvas) return { x: 0, y: 0 };
  return this._screenToWorld(canvas.clientWidth / 2, canvas.clientHeight / 2);
};

DiffuiCanvasWorkspace.prototype._hasActiveCursorChat = function _hasActiveCursorChat(now = performance.now()) {
  if (this._cursorChat?.phase === "composing") return true;
  if (this._cursorChat?.phase === "posted" && this._cursorChatBubbleVisible(this._cursorChat, now)) return true;
  return false;
};

DiffuiCanvasWorkspace.prototype._cursorChatBubbleVisible = function _cursorChatBubbleVisible(chat, now = performance.now()) {
  if (!chat?.text) return false;
  if (chat.phase === "composing") return true;
  if (chat.phase !== "posted") return false;
  const postedAt = Number(chat.at || 0);
  return postedAt > 0 && now - postedAt < CURSOR_CHAT_POSTED_TTL_MS;
};

DiffuiCanvasWorkspace.prototype._cursorChatBubbleOpacity = function _cursorChatBubbleOpacity(chat, now = performance.now()) {
  if (!chat || chat.phase !== "posted") return 1;
  const postedAt = Number(chat.at || 0);
  const age = now - postedAt;
  if (age >= CURSOR_CHAT_POSTED_TTL_MS) return 0;
  const fadeStart = CURSOR_CHAT_POSTED_TTL_MS - CURSOR_CHAT_FADE_MS;
  if (age <= fadeStart) return 1;
  return 1 - (age - fadeStart) / CURSOR_CHAT_FADE_MS;
};

DiffuiCanvasWorkspace.prototype._cursorChatPayloadForAwareness = function _cursorChatPayloadForAwareness() {
  const chat = this._cursorChat;
  if (!chat) return null;
  const text = String(chat.text || "");
  if (chat.phase === "composing") {
    if (!text.trim()) return null;
    return { text: text.slice(0, CURSOR_CHAT_MAX_LEN), phase: "composing", at: chat.at || Date.now() };
  }
  if (chat.phase === "posted" && text.trim() && this._cursorChatBubbleVisible(chat)) {
    return { text: text.trim(), phase: "posted", at: chat.at || Date.now() };
  }
  return null;
};

DiffuiCanvasWorkspace.prototype._startCursorChat = function _startCursorChat() {
  if (this._cursorChat?.phase === "composing") return;
  const world = this._lastPointerWorld || this._defaultCursorChatWorld();
  this._cursorChat = {
    phase: "composing",
    text: "",
    worldX: world.x,
    worldY: world.y,
    at: Date.now(),
  };
  this._showCursorChatInput();
};

DiffuiCanvasWorkspace.prototype._showCursorChatInput = function _showCursorChatInput() {
  const wrap = this.shadowRoot.getElementById("cursorChatInputWrap");
  const input = this.shadowRoot.getElementById("cursorChatInput");
  if (!wrap || !input) return;
  const color = resolveCollabColor(this._collabClientColor(), "label");
  input.value = "";
  input.style.background = color;
  wrap.dataset.open = "true";
  this._syncCursorChatInputHeight(input);
  this._syncCursorChatInputPosition();
  window.setTimeout(() => input.focus(), 0);
};

DiffuiCanvasWorkspace.prototype._syncCursorChatInputHeight = function _syncCursorChatInputHeight(input) {
  if (!input) input = this.shadowRoot.getElementById("cursorChatInput");
  if (!input) return;
  const maxHeight = 120;
  input.style.height = "0px";
  const nextHeight = Math.min(Math.max(input.scrollHeight, 0), maxHeight);
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
};

DiffuiCanvasWorkspace.prototype._hideCursorChatInput = function _hideCursorChatInput() {
  const wrap = this.shadowRoot.getElementById("cursorChatInputWrap");
  const input = this.shadowRoot.getElementById("cursorChatInput");
  if (wrap) wrap.dataset.open = "false";
  if (input) input.style.height = "";
  input?.blur();
};

DiffuiCanvasWorkspace.prototype._syncCursorChatInputPosition = function _syncCursorChatInputPosition() {
  const wrap = this.shadowRoot.getElementById("cursorChatInputWrap");
  const chat = this._cursorChat;
  if (!wrap || wrap.dataset.open !== "true" || !chat) return;
  const canvas = this.shadowRoot.getElementById("canvas");
  if (!canvas) return;
  const screen = this._worldToScreen(chat.worldX, chat.worldY);
  const offsetX = 14;
  const offsetY = 12;
  wrap.style.left = `${screen.x + offsetX}px`;
  wrap.style.top = `${screen.y + offsetY}px`;
};

DiffuiCanvasWorkspace.prototype._onCursorChatInput = function _onCursorChatInput(event) {
  if (this._cursorChat?.phase !== "composing") return;
  this._cursorChat.text = String(event.target.value || "").slice(0, CURSOR_CHAT_MAX_LEN);
  this._cursorChat.at = Date.now();
  this._syncCursorChatInputHeight(event.target);
  this._scheduleCollabAwareness(this._cursorChat.worldX, this._cursorChat.worldY);
};

DiffuiCanvasWorkspace.prototype._onCursorChatKeyDown = function _onCursorChatKeyDown(event) {
  if (this._cursorChat?.phase !== "composing") return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    this._commitCursorChat();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    this._cancelCursorChat();
  }
};

DiffuiCanvasWorkspace.prototype._commitCursorChat = function _commitCursorChat() {
  const chat = this._cursorChat;
  if (!chat || chat.phase !== "composing") return;
  const text = String(chat.text || "").slice(0, CURSOR_CHAT_MAX_LEN).trim();
  if (!text) {
    this._cancelCursorChat();
    return;
  }
  this._hideCursorChatInput();
  this._cursorChat = {
    phase: "posted",
    text,
    worldX: chat.worldX,
    worldY: chat.worldY,
    at: Date.now(),
  };
  this._publishCollabAwareness(this._cursorChat.worldX, this._cursorChat.worldY);
  this._queueCollabCursorFrame();
  this._draw();
};

DiffuiCanvasWorkspace.prototype._cancelCursorChat = function _cancelCursorChat() {
  this._hideCursorChatInput();
  this._cursorChat = null;
  this._publishCollabAwareness(
    this._lastPointerWorld?.x,
    this._lastPointerWorld?.y,
  );
  this._draw();
};

DiffuiCanvasWorkspace.prototype._clearPostedCursorChat = function _clearPostedCursorChat() {
  if (this._cursorChat?.phase !== "posted") return;
  this._cursorChat = null;
  this._publishCollabAwareness(
    this._lastPointerWorld?.x,
    this._lastPointerWorld?.y,
  );
  this._draw();
};

DiffuiCanvasWorkspace.prototype._drawLocalCursorChatBubble = function _drawLocalCursorChatBubble(ctx, now = performance.now()) {
  const chat = this._cursorChat;
  if (!chat || chat.phase !== "posted") return;
  const text = String(chat.text || "").trim();
  if (!text) {
    this._clearPostedCursorChat();
    return;
  }
  if (!this._cursorChatBubbleVisible(chat, now)) {
    this._clearPostedCursorChat();
    return;
  }
  const screen = this._worldToScreen(chat.worldX, chat.worldY);
  drawCollabChatBubble(ctx, screen.x, screen.y, text, this._collabClientColor(), {
    opacity: this._cursorChatBubbleOpacity(chat, now),
  });
};

DiffuiCanvasWorkspace.prototype._dispatchCanvasPresence = function _dispatchCanvasPresence() {
  if (this._collabPausedForInactivity) {
    this.dispatchEvent(
      new CustomEvent("diffui-canvas:presence", {
        bubbles: true,
        composed: true,
        detail: { active: false },
      }),
    );
    return;
  }
  const peers = [...this._collabPeers.values()]
    .sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0))
    .map((peer) => ({
      id: peer.id,
      userId: peer.userId,
      name: peer.name || "Collaborator",
      avatarUrl: String(peer.avatarUrl || peer.avatar_url || "").trim(),
      color: resolveCollabColor(peer.color, peer.userId || peer.id),
    }));
  this.dispatchEvent(
    new CustomEvent("diffui-canvas:presence", {
      bubbles: true,
      composed: true,
      detail: {
        local: {
          name: String(window.DIFFUI_USER_NAME || "You").slice(0, 24),
          avatarUrl: String(window.DIFFUI_USER_AVATAR || "").trim(),
          color: this._collabClientColor(),
        },
        peers,
      },
    }),
  );
};

DiffuiCanvasWorkspace.prototype._wireCollabInactivityTracking = function _wireCollabInactivityTracking() {
  if (this._collabInactivityWired) return;
  this._collabInactivityWired = true;
  this._collabActivityBound = () => this._onCollabTabActivity();
  const opts = { capture: true, passive: true };
  window.addEventListener("pointerdown", this._collabActivityBound, opts);
  window.addEventListener("keydown", this._collabActivityBound, opts);
  window.addEventListener("wheel", this._collabActivityBound, opts);
  window.addEventListener("touchstart", this._collabActivityBound, opts);
  window.addEventListener("scroll", this._collabActivityBound, opts);
  this._collabActivityMoveBound = () => {
    const now = Date.now();
    if (now - (this._collabActivityMoveAt || 0) < 1000) return;
    this._collabActivityMoveAt = now;
    this._onCollabTabActivity();
  };
  window.addEventListener("pointermove", this._collabActivityMoveBound, opts);
};

DiffuiCanvasWorkspace.prototype._unwireCollabInactivityTracking = function _unwireCollabInactivityTracking() {
  if (!this._collabInactivityWired) return;
  this._collabInactivityWired = false;
  const opts = { capture: true };
  window.removeEventListener("pointerdown", this._collabActivityBound, opts);
  window.removeEventListener("keydown", this._collabActivityBound, opts);
  window.removeEventListener("wheel", this._collabActivityBound, opts);
  window.removeEventListener("touchstart", this._collabActivityBound, opts);
  window.removeEventListener("scroll", this._collabActivityBound, opts);
  window.removeEventListener("pointermove", this._collabActivityMoveBound, opts);
  window.clearTimeout(this._collabInactivityTimer);
  this._collabInactivityTimer = 0;
  this._collabActivityBound = null;
  this._collabActivityMoveBound = null;
};

DiffuiCanvasWorkspace.prototype._resetCollabInactivityTimer = function _resetCollabInactivityTimer() {
  if (!this._collab || this._collabPausedForInactivity) return;
  window.clearTimeout(this._collabInactivityTimer);
  this._collabInactivityTimer = window.setTimeout(() => {
    this._collabInactivityTimer = 0;
    this._pauseCollabForInactivity();
  }, COLLAB_TAB_INACTIVITY_MS);
};

DiffuiCanvasWorkspace.prototype._onCollabTabActivity = function _onCollabTabActivity() {
  if (!this._collab) return;
  if (this._collabPausedForInactivity) {
    this._resumeCollabFromInactivity();
    return;
  }
  this._resetCollabInactivityTimer();
};

DiffuiCanvasWorkspace.prototype._pauseCollabForInactivity = function _pauseCollabForInactivity() {
  if (!this._collab || this._collabPausedForInactivity) return;
  this._collabPausedForInactivity = true;
  window.clearTimeout(this._collabInactivityTimer);
  this._collabInactivityTimer = 0;
  this._collabPeers.clear();
  this._collabCursors.clear();
  this._collabPeerMoveAt.clear();
  this._collabPeerRectAt.clear();
  this._collabPeerRects.clear();
  this._collabMoveSmoothTargets.clear();
  this._collabPortSmoothTargets.clear();
  this._stopCollabMoveSmooth();
  window.cancelAnimationFrame(this._collabCursorAnimation);
  this._collabCursorAnimation = 0;
  this.shadowRoot?.getElementById("collabRectLayer")?.replaceChildren();
  this._collab.disconnect(true);
  this._collabConnected = false;
  this._collabDocReady = false;
  this._dispatchCanvasPresence();
  this._syncRemoteCollabRectOverlays();
  this._draw();
};

DiffuiCanvasWorkspace.prototype._resumeCollabFromInactivity = function _resumeCollabFromInactivity() {
  if (!this._collabPausedForInactivity || !this._collab) return;
  this._collabPausedForInactivity = false;
  this._collab.connect();
  this._publishCollabAwareness();
  this._resetCollabInactivityTimer();
};

/* --------------------------------------------------------------------------
 * Canvas onboarding coach bridge
 *
 * `<diffui-canvas-onboarding-coach>` lives outside this component, so it reads
 * the board through these three entry points instead of reaching into the
 * shadow root: a snapshot of the counts its steps gate on, viewport rects for
 * the elements its ghost cursor points at, and a `diffui-canvas:coach` event
 * for the gestures it waits on. Everything here is inert until a coach calls
 * `registerCanvasCoach(true)`, so a board without one pays nothing.
 * ------------------------------------------------------------------------ */

DiffuiCanvasWorkspace.prototype.registerCanvasCoach = function registerCanvasCoach(active) {
  this._canvasCoachActive = !!active;
  if (!this._canvasCoachActive) {
    window.cancelAnimationFrame(this._canvasCoachSyncFrame);
    this._canvasCoachSyncFrame = 0;
    this.setCanvasCoachPortDemo(null);
  }
};

/**
 * Ghost of an output drag for the coach's fork demo. It is the real gesture's
 * rendering — `_drawPortWire`, the dashed prompt preview, and the same cursor
 * art peers get — so the demo cannot drift from production; only the alpha and
 * the half-size preview box mark it as a demo.
 *
 * @param {{fromNodeId: string, screenX: number, screenY: number, dragging?: boolean, opacity?: number}|null} demo
 *   Screen coordinates, so the coach can drive it from the same viewport space
 *   its other demos animate in. Pass null to clear.
 */
DiffuiCanvasWorkspace.prototype.setCanvasCoachPortDemo = function setCanvasCoachPortDemo(demo) {
  const canvas = this.shadowRoot?.getElementById("canvas");
  const from = demo ? this._state.nodes.find((node) => node.id === demo.fromNodeId) : null;
  if (!demo || !from || !canvas) {
    if (!this._coachPortDemo) return;
    this._coachPortDemo = null;
    this._scheduleDraw();
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const world = this._screenToWorld(demo.screenX - rect.left, demo.screenY - rect.top);
  const size = constrainPromptDimensions(from.width, from.height);
  const width = size.width / 2;
  const height = size.height / 2;
  this._coachPortDemo = {
    from: from.id,
    x: world.x,
    y: world.y,
    dragging: demo.dragging !== false,
    opacity: clampNumber(Number(demo.opacity ?? CANVAS_COACH_DEMO_ALPHA), 0, 1),
    // Same shape and anchoring as `_portDragPromptPreviewRect`, at half size.
    promptPreviewRect: demo.dragging === false ? null : { x: world.x, y: world.y - height / 2, width, height },
  };
  this._scheduleDraw();
};

/**
 * Pans — never zooms — just far enough to bring a node and its chrome fully on
 * screen. A node fitted to the viewport sits with its option bar and header a
 * few pixels off the fold, and a tip that says "click the circles below" has to
 * be pointing at circles the user can actually see. No-op when already visible.
 */
DiffuiCanvasWorkspace.prototype.revealCanvasCoachNode = function revealCanvasCoachNode(nodeId, part = "") {
  const node = this._state.nodes.find((item) => item.id === nodeId);
  if (!node) return;
  const scale = Math.max(0.001, this._state.viewport.scale || 1);
  const base = nodeRect(node);
  const px = (value) => value / scale;
  let rect = this._promptWorldRectForViewportFit(node);
  // A node fitted to the viewport is already taller than the space available
  // once its chrome is counted, and panning the whole thing into view just
  // pushes the other end out. Each step therefore reveals only the strip it
  // points at.
  if (part === "options") {
    rect = {
      x: base.x,
      y: base.y + base.height - px(40),
      width: base.width,
      height: px(40 + this._nodeStackBarOverflowPx(node, scale) + 12),
    };
  } else if (part === "header") {
    rect = {
      x: base.x,
      y: base.y - px(NODE_HEADER_HEIGHT + 16),
      width: base.width,
      height: px(NODE_HEADER_HEIGHT + 56),
    };
  } else if (part === "output") {
    // Node + a lane of empty canvas past the handle, so the fork demo has room
    // to land. Fit (not pan-only) so a viewport-filling node also zooms out a
    // little; the viewport change is animated.
    rect = {
      x: base.x,
      y: base.y,
      width: base.width + px(this._nodeOutputGap(node) + NODE_RIGHT_CONNECTOR_WIDTH + CANVAS_COACH_FORK_LANE_PX),
      height: base.height,
    };
    // Twice the normal fit duration so the fork tip's reveal reads clearly.
    this._fitWorldRectIntoView(rect, { animate: true, durationMs: 600 });
    return;
  }
  this._panWorldRectIntoView(rect, { animate: true });
};

DiffuiCanvasWorkspace.prototype._drawCanvasCoachPortDemo = function _drawCanvasCoachPortDemo(ctx) {
  const demo = this._coachPortDemo;
  if (!demo || !this._state.nodes.some((node) => node.id === demo.from)) return;
  ctx.save();
  ctx.globalAlpha = demo.opacity;
  if (demo.dragging) this._drawPortWire(ctx, demo, this._palette.portWire);
  const point = this._worldToScreen(demo.x, demo.y);
  drawCollabCursor(ctx, point.x, point.y, this._collabClientColor(), () => this._scheduleDraw());
  ctx.restore();
};

DiffuiCanvasWorkspace.prototype._notifyCanvasCoach = function _notifyCanvasCoach(signal, detail = {}) {
  if (!this._canvasCoachActive) return;
  this.dispatchEvent(
    new CustomEvent("diffui-canvas:coach", {
      bubbles: true,
      composed: true,
      detail: { signal, projectId: this._projectId || "", ...detail },
    }),
  );
};

/**
 * Node and image mutations all funnel through `_syncStateFromEngine`, which
 * fires many times per gesture. Coalescing to one signal per frame keeps the
 * coach's recount off the drag path.
 */
DiffuiCanvasWorkspace.prototype._scheduleCanvasCoachSync = function _scheduleCanvasCoachSync() {
  if (!this._canvasCoachActive || this._canvasCoachSyncFrame) return;
  this._canvasCoachSyncFrame = window.requestAnimationFrame(() => {
    this._canvasCoachSyncFrame = 0;
    this._notifyCanvasCoach("state");
  });
};

/**
 * A node counts as a generation once its active image has finished generating
 * and carries a generation image id — the same test the "Copy for agent" and
 * "Create brand" actions apply, so the coach never unlocks a tip for an action
 * the menus would refuse. Pasted or uploaded images have no generation id and
 * do not count.
 */
DiffuiCanvasWorkspace.prototype._canvasCoachNodeIsGeneration = function _canvasCoachNodeIsGeneration(node) {
  const image = this._activeImageForNode(node);
  if (!image || String(image.status || "").toLowerCase() === "loading") return false;
  return !!this._imageIdForNode(node);
};

DiffuiCanvasWorkspace.prototype.getCanvasCoachSnapshot = function getCanvasCoachSnapshot() {
  const nodes = Array.isArray(this._state?.nodes) ? this._state.nodes : [];
  const generationNodeIds = [];
  // Options are the images a node's stack dots step through, which is also what
  // the ← / → keys cycle: `_readyImagesForNode`, the list `_applyNodeStackSwitch`
  // indexes into.
  const generationOptionCounts = [];
  // A node whose batch is still landing has a count that will keep changing, so
  // the coach waits it out rather than teaching a number that is about to move.
  const generationPending = [];
  let generationAnalysisPending = false;
  let forkNodeCount = 0;
  let hasPromptText = false;
  let selectedGenerationNodeId = "";
  const selectedNodeIds = [];
  nodes.forEach((node) => {
    if (String(node.prompt || "").trim()) hasPromptText = true;
    if (String(this._nodeMetadata(node).createdFrom || "") === "output_drop") forkNodeCount += 1;
    if (node.selected) selectedNodeIds.push(node.id);
    if (!this._canvasCoachNodeIsGeneration(node)) return;
    generationNodeIds.push(node.id);
    generationOptionCounts.push(this._readyImagesForNode(node).length);
    generationPending.push(this._nodeGenerationInFlight(node));
    // prompt_only JSON pass: tip that teaches Copy for agent must wait until
    // expandedPrompt analysis is done (spinner stays hidden, but tip still waits).
    const active = this._activeImageForNode(node);
    const imageMeta = this._imageMetadata(active) || {};
    if (String(imageMeta.analysisStatus || imageMeta.analysis_status || "") === "processing"
      && !this._isPasteScreenshotAnalysis(active, node, imageMeta)) {
      generationAnalysisPending = true;
    }
    if (node.selected) selectedGenerationNodeId = node.id;
  });
  return {
    projectId: this._projectId || "",
    // Access is only known once a board has been opened; before that the field
    // still holds its "owner" default, which must not read as edit rights.
    canEdit: !!this._projectId && this._canEditCollab(),
    isOwner: !!this._projectId && this._canvasAccess === "owner",
    // The `?share=` token that let this session in, if any: it survives the
    // whole visit, so it stays the signal that the user got here from a link
    // rather than from their own files.
    shareLinkEntry: !!publicShareTokenFromLocation(),
    anonymous: this._canvasAnonymousViewer === true || isPublicShareViewer(),
    embed: window.DIFFUI_EMBED === true,
    freshCanvas: this._isInitialCanvasState(this._state) && !generationNodeIds.length,
    hasPromptText,
    generationNodeCount: generationNodeIds.length,
    generationNodeIds,
    generationOptionCounts,
    generationPending,
    generationAnalysisPending,
    selectedGenerationNodeId,
    selectedNodeIds,
    forkNodeCount,
    seedNodeId: nodes[0]?.id || "",
  };
};

/**
 * Whether Escape already has a job on this canvas. `_onKeyDown` consumes every
 * Escape it sees — closing a draft or panel, blurring an input, or otherwise
 * clearing the selection — so overlay UI on top of the workspace cannot tell
 * from `defaultPrevented` whether the key was really wanted. This mirrors that
 * ladder as a query, and covers the menus that close from their own listener.
 */
DiffuiCanvasWorkspace.prototype.canvasEscapeIsSpokenFor = function canvasEscapeIsSpokenFor() {
  if (this._cursorChat || this._commentDraft || this._inpaint) return true;
  if (this._fileSettingsOpen || this._nodeRenameNodeId) return true;
  if (this._nodeContextMenuState || this._edgeFacetMenuState) return true;
  if (this._state?.nodes?.some((node) => node.selected)) return true;
  if (this._state?.edges?.some((edge) => edge.selected)) return true;
  const root = this.shadowRoot;
  if (!root) return false;
  // `data-open="true"` is this component's convention for an open menu or
  // panel; the prompt-box menus use `hidden` instead.
  if (root.querySelector('[data-open="true"]')) return true;
  if (root.querySelector(".promptMentionMenu:not([hidden]), .promptResolutionMenu:not([hidden]), .promptBrandMenu:not([hidden])")) return true;
  const active = root.activeElement;
  if (active instanceof HTMLElement && (active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName))) return true;
  return root.querySelector("diffui-canvas-comment[data-expanded='true']") !== null;
};

/**
 * Viewport rect for something the ghost cursor points at, or null when it is
 * not on screen. `node-more` falls back to where the "…" button will appear
 * once the node is selected, since the header actions only render for the
 * selected node and the demo is what tells the user to select it.
 */

/** Open the single-node … / right-click menu for the coach ghost demo. */
/** Select a node for the coach demo without opening a menu. */
DiffuiCanvasWorkspace.prototype.selectCanvasCoachNode = function selectCanvasCoachNode(nodeId) {
  const node = this._state.nodes.find((item) => item.id === nodeId);
  if (!node) return false;
  if (!node.selected) this._selectNodeById(node.id, false);
  this._syncPromptOverlays?.();
  return true;
};

DiffuiCanvasWorkspace.prototype.openCanvasCoachNodeMenu = function openCanvasCoachNodeMenu(nodeId, screenX, screenY) {
  const node = this._state.nodes.find((item) => item.id === nodeId);
  if (!node) return null;
  if (!node.selected) this._selectNodeById(node.id, false);
  this._coachOpeningMenu = true;
  try {
    this._openNodeContextMenu(node, screenX, screenY);
  } finally {
    this._coachOpeningMenu = false;
  }
  this._syncPromptOverlays?.();
  return this.getCanvasCoachNodeMenuItemRect("copy-for-agent");
};

/**
 * Open the multi-select right-click menu (Create brand / Copy for agent) for the
 * brand coach demo. Selects the given nodes first so the menu matches production.
 */
DiffuiCanvasWorkspace.prototype.openCanvasCoachMultiSelectMenu = function openCanvasCoachMultiSelectMenu(nodeIds, screenX, screenY) {
  const ids = Array.isArray(nodeIds) ? nodeIds.filter(Boolean) : [];
  if (!ids.length) return null;
  const idSet = new Set(ids);
  this._state.nodes.forEach((node) => {
    node.selected = idSet.has(node.id);
  });
  this._state.edges.forEach((edge) => {
    edge.selected = false;
  });
  this._engine?.load(JSON.stringify(this._state));
  this._syncStateFromEngine();
  const selected = this._state.nodes.filter((node) => node.selected);
  if (selected.length < 2) return null;
  this._coachOpeningMenu = true;
  try {
    this._openMultiSelectContextMenu(selected, screenX, screenY);
  } finally {
    this._coachOpeningMenu = false;
  }
  this._syncPromptOverlays?.();
  return this.getCanvasCoachNodeMenuItemRect("create-brand-from-selection");
};

DiffuiCanvasWorkspace.prototype.closeCanvasCoachNodeMenu = function closeCanvasCoachNodeMenu() {
  this._clearCanvasCoachMenuHover();
  const menu = this.shadowRoot?.getElementById("nodeContextMenu");
  if (!menu || menu.dataset.open !== "true") return;
  this._closeNodeContextMenu();
};

DiffuiCanvasWorkspace.prototype.getCanvasCoachNodeMenuItemRect = function getCanvasCoachNodeMenuItemRect(action) {
  const menu = this.shadowRoot?.getElementById("nodeContextMenu");
  if (!menu || menu.dataset.open !== "true") return null;
  const button = menu.querySelector(`.nodeContextMenuItem[data-action="${CSS.escape(action)}"]`);
  if (!button || button.hidden || button.disabled) return null;
  const rect = button.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};

DiffuiCanvasWorkspace.prototype.setCanvasCoachMenuHover = function setCanvasCoachMenuHover(action = "") {
  const menu = this.shadowRoot?.getElementById("nodeContextMenu");
  if (!menu) return;
  menu.querySelectorAll(".nodeContextMenuItem[data-coach-hover]").forEach((btn) => {
    btn.removeAttribute("data-coach-hover");
  });
  if (!action || menu.dataset.open !== "true") return;
  const button = menu.querySelector(`.nodeContextMenuItem[data-action="${CSS.escape(action)}"]`);
  if (button && !button.hidden && !button.disabled) button.dataset.coachHover = "true";
};

DiffuiCanvasWorkspace.prototype._clearCanvasCoachMenuHover = function _clearCanvasCoachMenuHover() {
  this.setCanvasCoachMenuHover("");
};

DiffuiCanvasWorkspace.prototype.isCanvasCoachPanning = function isCanvasCoachPanning() {
  return this.dataset.panning === "true" || this.dataset.spacePan === "true" || this._pointer?.mode === "pan";
};

DiffuiCanvasWorkspace.prototype.getCanvasCoachAnchor = function getCanvasCoachAnchor(kind, { nodeId = "", index = 0 } = {}) {
  const toRect = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };
  if (kind === "canvas") return toRect(this.shadowRoot?.getElementById("canvasFrame"));
  if (kind === "tools") return toRect(this.shadowRoot?.querySelector(".leftTools"));
  const box = this._promptBoxForNode(nodeId);
  if (!box || box.style.display === "none") return null;
  if (kind === "node") return toRect(box);
  // The stack dots under a node: the option picker the choose step teaches.
  if (kind === "node-options") return toRect(box.querySelector(".nodeStackBar .stackDots"));
  if (kind === "node-option") {
    const dots = box.querySelectorAll(".nodeStackBar .stackDots .stackDot");
    const i = Math.max(0, Number(index) || 0);
    return toRect(dots[i] || null);
  }
  // Spinners / stack dots under a generating node — toast noodle target.
  if (kind === "node-spinners") {
    const bar = toRect(box.querySelector(".nodeStackBar"));
    if (bar && box.querySelector(".nodeStackBar")?.dataset.visible === "true") return bar;
    const loading = toRect(box.querySelector(".nodeLoading"));
    if (loading) return loading;
    const frame = toRect(box);
    return frame
      ? { left: frame.left + frame.width * 0.25, top: frame.top + frame.height - 8, width: frame.width * 0.5, height: 18 }
      : null;
  }
  if (kind === "prompt-input") return toRect(box.querySelector(".promptEditor textarea")) || toRect(box);
  if (kind === "prompt-suggestions") return toRect(box.querySelector("diffui-prompt-suggestions"));
  if (kind === "generate") return toRect(box.querySelector(".generateBtn"));
  if (kind === "node-output") {
    const handle = toRect(box.querySelector(".nodeOutputHandle"));
    if (handle) return handle;
    const frame = toRect(box);
    return frame ? { left: frame.left + frame.width - 6, top: frame.top + frame.height / 2 - 6, width: 12, height: 12 } : null;
  }
  if (kind === "node-more") {
    const button = box.querySelector('[data-node-action="more"]');
    if (box.dataset.selected === "true") {
      const rect = toRect(button);
      if (rect) return rect;
    }
    const header = toRect(box.querySelector(".nodeHeader"));
    if (!header) return null;
    return { left: header.left + header.width - 28, top: header.top + header.height / 2 - 12, width: 24, height: 24 };
  }
  return null;
};

customElements.define("diffui-canvas-workspace", DiffuiCanvasWorkspace);

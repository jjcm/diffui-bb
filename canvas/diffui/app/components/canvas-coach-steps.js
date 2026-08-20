/**
 * Step gating for the canvas onboarding coach (`<diffui-canvas-onboarding-coach>`).
 *
 * The coach runs after the user is already on a canvas, so it is entirely
 * separate from the generation wizard's tutorial overlay and never reads or
 * writes that overlay's keys. Its own progress lives under
 * `diffui_canvas_coach_seen_user:{userId}`.
 *
 * Five steps run in a fixed order. Each one has a trigger (when it may be
 * shown) and a completion test (the real action it teaches). A step is
 * resolved once it is either completed by the user or skipped, and a resolved
 * step never comes back.
 */

export const CANVAS_COACH_STEPS = Object.freeze(["prompt", "choose", "fork", "more", "brand"]);

/** Prompt-tip example prompts — also used as the seed node's placeholder cycle. */
export const CANVAS_COACH_PROMPT_EXAMPLES = Object.freeze([
  "A landing page for a VR-for-cats product",
  "A dashboard for a botanical skincare company",
  "A pricing page, bauhaus style",
]);
export const CANVAS_COACH_STORAGE_PREFIX = "diffui_canvas_coach_seen_user:";
export const CANVAS_COACH_PROGRESS_VERSION = 1;
/** Generation nodes on the canvas before the "… menu → Copy for agent" tip unlocks. */
export const CANVAS_COACH_MORE_STEP_NODES = 3;
/** Generation nodes before the "select screens → Create brand" tip unlocks; matches the menu's own `imageCount >= 5`. */
export const CANVAS_COACH_BRAND_STEP_NODES = 5;

const OUTCOMES = new Set(["done", "skipped"]);

export function canvasCoachStorageKey(userId) {
  const id = String(userId || "").trim();
  return id ? `${CANVAS_COACH_STORAGE_PREFIX}${id}` : "";
}

/**
 * Coerce anything read out of localStorage into `{ version, steps }` with one
 * entry per step ("", "done" or "skipped"). Unknown or corrupt input reads as
 * "nothing seen yet" rather than throwing.
 */
export function normalizeCoachProgress(raw) {
  let source = raw;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      source = null;
    }
  }
  const steps = source && typeof source === "object" ? source.steps : null;
  const normalized = {};
  CANVAS_COACH_STEPS.forEach((step) => {
    const value = String(steps?.[step] || "");
    normalized[step] = OUTCOMES.has(value) ? value : "";
  });
  return { version: CANVAS_COACH_PROGRESS_VERSION, steps: normalized };
}

export function coachProgressWith(progress, step, outcome) {
  const next = normalizeCoachProgress(progress);
  if (!CANVAS_COACH_STEPS.includes(step) || !OUTCOMES.has(outcome)) return next;
  next.steps[step] = outcome;
  return next;
}

/** Marks every still-unresolved step as skipped ("skip the rest of the tour"). */
export function coachProgressSkippingRest(progress) {
  const next = normalizeCoachProgress(progress);
  CANVAS_COACH_STEPS.forEach((step) => {
    if (!next.steps[step]) next.steps[step] = "skipped";
  });
  return next;
}

export function coachStepResolved(progress, step) {
  return !!normalizeCoachProgress(progress).steps[step];
}

export function coachFinished(progress) {
  const normalized = normalizeCoachProgress(progress);
  return CANVAS_COACH_STEPS.every((step) => !!normalized.steps[step]);
}

/**
 * Whether this session arrived on the board through somebody else's share link.
 *
 * Entry is the question, not permission: a link shared at edit level makes a
 * real editor of whoever follows it, so `canEdit` alone would happily coach a
 * guest through their host's board. Someone who opens their own link is still
 * on their own canvas ("I sent myself my own file"), and keeps the coach.
 */
export function coachGuestShareEntry(snapshot = {}) {
  return !!snapshot.shareLinkEntry && !snapshot.isOwner;
}

/**
 * The coach only ever runs for someone who can actually edit the board, and
 * only on a board that is theirs to learn on. A view-only collaborator, a
 * signed-out share-link visitor, and the IDE embed are all excluded — none of
 * them can perform the actions being taught — and so is a guest who followed
 * someone else's share link here, who came to look at that person's work.
 */
export function coachAllowed(snapshot = {}) {
  return !!snapshot.canEdit
    && !snapshot.embed
    && !snapshot.anonymous
    && !coachGuestShareEntry(snapshot);
}

/**
 * Whether the first generation has finished landing every option it queued.
 * Options arrive one image at a time, so the count is only trustworthy once the
 * node reports nothing still generating.
 */
function chooseOptionsSettled(snapshot = {}) {
  // chooseOptionsUnknown means we cannot see the generation node yet (or it
  // briefly dropped out of the snapshot). Treat that as not settled so a
  // missing count of 0 cannot silently retire the tip.
  return !!snapshot.readyGenerationSeen
    && !snapshot.chooseOptionsPending
    && !snapshot.chooseOptionsUnknown;
}

/** Whether a step's trigger has fired, ignoring whether it was already resolved. */
export function coachStepUnlocked(step, snapshot = {}) {
  if (!coachAllowed(snapshot)) return false;
  const generationNodeCount = Number(snapshot.generationNodeCount) || 0;
  if (step === "prompt") {
    // Only on a canvas that is still the untouched seed prompt: a returning
    // user with work on the board does not need to be told where to type.
    return !!snapshot.freshCanvas;
  }
  if (step === "choose") {
    // Only after the batch has settled with at least two finished screens —
    // switching is meaningless with one, and mid-batch counts are still moving.
    return chooseOptionsSettled(snapshot)
      && !snapshot.chooseOptionsUnknown
      && (Number(snapshot.chooseOptionCount) || 0) >= 2;
  }
  // Both of these wait for the first batch to finish landing, so the coach does
  // not put up a tip while options are still appearing behind it.
  if (step === "fork") return chooseOptionsSettled(snapshot);
  if (step === "more") {
    // Wait for prompt_only JSON analysis to finish — Copy for agent needs the
    // expanded prompt, and the tip should not teach a menu while chrome is mid-pass.
    return generationNodeCount >= CANVAS_COACH_MORE_STEP_NODES
      && !snapshot.generationAnalysisPending;
  }
  if (step === "brand") return generationNodeCount >= CANVAS_COACH_BRAND_STEP_NODES;
  return false;
}

/**
 * Whether the user has already done the thing a step teaches. This doubles as
 * the "stop the ghost demo" test and as a silent-resolve test: a step whose
 * action happened before the tip could appear is marked done without ever
 * being shown.
 */
export function coachStepComplete(step, snapshot = {}) {
  if (step === "prompt") {
    return !!snapshot.hasPromptText
      || !!snapshot.readyGenerationSeen
      || (Number(snapshot.generationNodeCount) || 0) > 0;
  }
  if (step === "choose") {
    if (!snapshot.readyGenerationSeen) return false;
    // User ←/→ or stack-dot click — the only gesture that completes this tip.
    // If they did it before the tip could unlock (mid-batch, or before 2 screens
    // were ready), that is the one intentional silent skip.
    if (!!snapshot.optionSelected) return true;
    // Forking past the tip also retires it (they moved on without choosing).
    if ((Number(snapshot.forkNodeCount) || 0) > 0) return true;
    // Wait for the batch to settle before the "nothing to choose" path. A
    // missing choose node (count 0 / pending unknown) must not look settled.
    if (!chooseOptionsSettled(snapshot)) return false;
    if (snapshot.chooseOptionsUnknown) return false;
    // Settled with fewer than 2 finished screens: nothing to teach.
    return (Number(snapshot.chooseOptionCount) || 0) < 2;
  }
  if (step === "fork") return (Number(snapshot.forkNodeCount) || 0) > 0;
  if (step === "more") return !!snapshot.moreMenuOpened;
  if (step === "brand") return !!snapshot.brandFlowStarted;
  return false;
}

/**
 * The step whose tip should be on screen right now: the earliest unresolved
 * step that is unlocked and not already done. Staying in order means a user
 * who blows past three steps at once still gets them one at a time rather
 * than a pile of tips.
 */
export function nextCoachStep(snapshot = {}, progress = null) {
  if (!coachAllowed(snapshot)) return "";
  const normalized = normalizeCoachProgress(progress);
  return CANVAS_COACH_STEPS.find((step) => (
    !normalized.steps[step]
    && coachStepUnlocked(step, snapshot)
    && !coachStepComplete(step, snapshot)
  )) || "";
}

/**
 * Steps that are unresolved but whose action already happened, so the coach
 * can retire them quietly instead of teaching something the user knows.
 */
export function coachStepsToAutoComplete(snapshot = {}, progress = null) {
  // A guest visit resolves nothing. Someone else's finished board would retire
  // most of the tour on sight, spending steps this user has never been shown on
  // work that is not theirs; their own first canvas still has to teach them.
  if (coachGuestShareEntry(snapshot)) return [];
  const normalized = normalizeCoachProgress(progress);
  return CANVAS_COACH_STEPS.filter((step) => !normalized.steps[step] && coachStepComplete(step, snapshot));
}

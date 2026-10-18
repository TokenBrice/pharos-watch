import { expandEvidenceModuleFor } from "@/components/stablecoin-detail/evidence-module";

/**
 * Detail-page modules hide part of their content until asked: below `md` an
 * `EvidenceModule` tile folds to its header, and every module folds its
 * evidence behind native `<details>` (ModuleDisclosure). A hash jump that
 * lands on — or inside — a folded element must unfold the module and open
 * every enclosing disclosure first, or the navigation strands the user on a
 * closed fold with no signal of where the target went.
 *
 * Opened disclosures stay open (owner decision 2026-08-08): navigation is a
 * statement of intent, and auto-reclosing would fight the user.
 */
/** Dispatched on a hidden `[data-tab-panel]` that holds a hash target; its tab group selects it synchronously. */
export const TAB_PANEL_REVEAL_EVENT = "pharos:tab-panel-reveal";

/** Mount only the deferred islands preceding or inside the requested longform zone. */
export function revealDeferredSectionsThroughAnchor(
  sectionId: string,
  zoneIds: readonly string[],
  root: HTMLElement | null,
): void {
  const target = document.getElementById(sectionId);
  if (!root || !target || !root.contains(target)) return;
  const zones = zoneIds.map((id) => document.getElementById(id))
    .filter((zone): zone is HTMLElement => zone !== null && root.contains(zone));
  const nextZone = zones.find((zone) => zone !== target
    && Boolean(target.compareDocumentPosition(zone) & Node.DOCUMENT_POSITION_FOLLOWING)
    && !zone.contains(target));
  for (const deferred of root.querySelectorAll<HTMLElement>("[data-lazy-section]")) {
    if (nextZone && !(deferred.compareDocumentPosition(nextZone) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    deferred.dispatchEvent(new Event("pharos:lazy-section-reveal"));
  }
}

interface AnchorAlignmentOptions {
  /** Mount the intended islands before each measurement, including newly loaded descendants. */
  beforeAlign?: () => void;
  /** Scrollspy supplies its measured sticky offset; nested targets use CSS scroll margins. */
  align?: () => void;
}

function revealAnchorTarget(target: HTMLElement | null): void {
  if (!target) return;

  // A target in (or on) an inactive tab panel: select the tab before measuring.
  const panel = target.closest<HTMLElement>("[data-tab-panel]");
  if (panel?.hidden) panel.dispatchEvent(new Event(TAB_PANEL_REVEAL_EVENT, { bubbles: true }));

  // Synchronous attribute flip, so the body is displayed before any scroll.
  expandEvidenceModuleFor(target);

  // The target may itself be a disclosure (e.g. an id on a <details>).
  if (target instanceof HTMLDetailsElement) {
    target.open = true;
  }

  let node: HTMLElement | null = target.parentElement;
  while (node) {
    const details = node.closest("details");
    if (!details) break;
    details.open = true;
    node = details.parentElement;
  }
}

/**
 * Resolves a hash id to the element to scroll to, revealing it on the way.
 *
 * Some modules mount twice: the in-flow copy (below `xl`) owns the id, and the
 * `xl+` rail copy marks itself `data-anchor-twin="<id>"`. When the owner is
 * display-hidden at the current breakpoint (no `offsetParent` once its folds
 * are open), the visible twin stands in, so a cold `#collateralization` at xl
 * lands on the rail card instead of a `display: none` node.
 */
export function revealAnchorId(sectionId: string): HTMLElement | null {
  const target = document.getElementById(sectionId);
  revealAnchorTarget(target);
  if (target && target.offsetParent !== null) return target;
  // Inside a quoted attribute value only `"` and `\` need escaping.
  const twin = document.querySelector<HTMLElement>(`[data-anchor-twin="${sectionId.replace(/["\\]/g, "\\$&")}"]`);
  if (!twin) return target;
  revealAnchorTarget(twin);
  return twin;
}

/** Re-align an anchor while lazy sections settle; click jumps skip the initial frame. */
export function alignAnchorAfterHydration(
  sectionId: string,
  alignOnNextFrame = true,
  { beforeAlign, align: alignTarget }: AnchorAlignmentOptions = {},
): () => void {
  const initialHash = window.location.hash;
  let cancelled = false;
  const align = () => {
    if (cancelled) return;
    if (window.location.hash !== initialHash) {
      stop();
      return;
    }
    // An initial-position correction must not animate through every lazy
    // section: CSS smooth scrolling delays mounting and retargets mid-flight.
    beforeAlign?.();
    if (alignTarget) alignTarget();
    else revealAnchorId(sectionId)?.scrollIntoView({ block: "start", behavior: "instant" });
  };
  // Match the bounded passport-link cadence; instant also respects reduced motion.
  const frame = alignOnNextFrame ? window.requestAnimationFrame(align) : 0;
  const timers = [160, 480, 960, 1800].map((delay) => window.setTimeout(align, delay));
  // Lazy sections above a deep anchor (reserves, charts) can keep growing past the
  // fixed cadence, so also re-align on every page-height change, for a bounded window.
  let pending = 0;
  const observer = typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver(() => {
        window.cancelAnimationFrame(pending);
        pending = window.requestAnimationFrame(align);
      });
  observer?.observe(document.body);
  // Chunk completion can mount another deferred child without changing the reserve's height.
  const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
    window.cancelAnimationFrame(pending);
    pending = window.requestAnimationFrame(align);
  });
  mutations?.observe(document.body, { childList: true, subtree: true });
  const deadline = window.setTimeout(() => stop(), 15000);
  const stop = () => {
    cancelled = true;
    window.cancelAnimationFrame(frame);
    window.cancelAnimationFrame(pending);
    timers.forEach((timer) => window.clearTimeout(timer));
    window.clearTimeout(deadline);
    observer?.disconnect();
    mutations?.disconnect();
    window.removeEventListener("hashchange", stop);
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      window.removeEventListener(event, stop);
    }
  };
  // Never pull readers back after they take over navigation themselves.
  for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
    window.addEventListener(event, stop, { passive: true });
  }
  window.addEventListener("hashchange", stop);
  return stop;
}

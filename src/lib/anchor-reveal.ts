/**
 * Detail-page modules fold their evidence behind native `<details>`
 * (ModuleDisclosure). A hash jump that lands on — or inside — a folded
 * element must open every enclosing disclosure first, or the navigation
 * strands the user on a closed fold with no signal of where the target went.
 *
 * Opened disclosures stay open (owner decision 2026-08-08): navigation is a
 * statement of intent, and auto-reclosing would fight the user.
 */
export function revealAnchorTarget(target: HTMLElement | null): void {
  if (!target) return;

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

/** Convenience for hash strings: resolve the id, then reveal. */
export function revealAnchorId(sectionId: string): HTMLElement | null {
  const target = document.getElementById(sectionId);
  revealAnchorTarget(target);
  return target;
}

/** Re-align a cold-load nested anchor while lazy dossier sections settle. */
export function alignAnchorAfterHydration(sectionId: string): () => void {
  const initialHash = window.location.hash;
  let cancelled = false;
  const align = () => {
    if (cancelled || window.location.hash !== initialHash) return;
    // An initial-position correction must not animate through every lazy
    // section: CSS smooth scrolling delays mounting and retargets mid-flight.
    revealAnchorId(sectionId)?.scrollIntoView({ block: "start", behavior: "instant" });
  };
  // Match the bounded passport-link cadence; instant also respects reduced motion.
  const frame = window.requestAnimationFrame(align);
  const timers = [160, 480, 960, 1800].map((delay) => window.setTimeout(align, delay));
  const stop = () => {
    cancelled = true;
    window.cancelAnimationFrame(frame);
    timers.forEach((timer) => window.clearTimeout(timer));
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      window.removeEventListener(event, stop);
    }
  };
  // Never pull readers back after they take over navigation themselves.
  for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
    window.addEventListener(event, stop, { passive: true });
  }
  return stop;
}

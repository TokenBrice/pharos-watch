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

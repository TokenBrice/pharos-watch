import type { Result } from "axe-core";

export const TAGS = ["wcag2a", "wcag2aa", "wcag22a", "wcag22aa"];

export interface AxeNodeWaiver {
  routePath: string;
  ruleId: string;
  target: string;
  note: string;
}

/**
 * Known debt is waived at the node level. Do not disable whole axe rules:
 * that hides broad regressions on routes that already pass the same rule.
 * Hydrated-scan waivers use the `<path>#hydrated` routePath convention.
 */
export const KNOWN_NODE_WAIVERS: readonly AxeNodeWaiver[] = [];

// axe selectors are CrossTreeSelector (string | string[] for shadow DOM);
// waivers match on the flattened string form.
function selectorToString(target: unknown): string {
  return Array.isArray(target) ? target.join(" ") : String(target);
}

function isWaivedNode(routePath: string, violation: Result, target: string): boolean {
  return KNOWN_NODE_WAIVERS.some(
    (waiver) =>
      waiver.routePath === routePath &&
      waiver.ruleId === violation.id &&
      waiver.target === target,
  );
}

export function summarizeViolations(routePath: string, violations: Result[]) {
  return violations
    .map((violation) => {
      const nodes = violation.nodes.filter(
        (node) =>
          !node.target.some((target) => isWaivedNode(routePath, violation, selectorToString(target))),
      );
      const firstTarget = nodes[0]?.target?.[0];
      return {
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodeCount: nodes.length,
        firstTarget: firstTarget === undefined ? undefined : selectorToString(firstTarget),
      };
    })
    .filter((violation) => violation.nodeCount > 0);
}

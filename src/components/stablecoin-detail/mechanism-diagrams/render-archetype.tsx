import type { MechanismArchetype } from "@shared/types";

import { SyntheticDeltaNeutralDiagram } from "./synthetic-delta-neutral-diagram";
import { ThreeStepArchetypeDiagram } from "./three-step-archetype-diagram";
import type { CoinOverride } from "./types";

/**
 * Dispatch a {@link MechanismArchetype} to its concrete diagram component.
 * Shared by the top-level dispatcher and the wrapper diagram's parent panel so
 * a newly added archetype only needs wiring in one place.
 *
 * `navToken` is the rendered coin's `flags.navToken`; leave it undefined when
 * no coin is in hand so the archetype keeps its default copy.
 */
export function renderArchetype(
  archetype: MechanismArchetype,
  symbol: string,
  override?: CoinOverride,
  navToken?: boolean | null,
): React.ReactNode {
  const steps = override?.steps;
  const stressFootnote = override?.stressFootnote;
  if (archetype === "synthetic-delta-neutral") {
    return (
      <SyntheticDeltaNeutralDiagram
        symbol={symbol}
        steps={steps}
        strategy={override?.syntheticStrategy}
        {...(stressFootnote !== undefined ? { stressFootnote } : {})}
      />
    );
  }
  if (
    archetype === "fiat-cash" ||
    archetype === "tbill" ||
    archetype === "cdp" ||
    archetype === "algorithmic" ||
    archetype === "rwa-credit-fund" ||
    archetype === "commodity-claim"
  ) {
    return (
      <ThreeStepArchetypeDiagram
        archetype={archetype}
        symbol={symbol}
        steps={steps}
        navToken={navToken}
        {...(stressFootnote !== undefined ? { stressFootnote } : {})}
      />
    );
  }
  return null;
}

import type { MechanismArchetype } from "@shared/types";

import { SyntheticDeltaNeutralDiagram } from "./synthetic-delta-neutral-diagram";
import { ThreeStepArchetypeDiagram } from "./three-step-archetype-diagram";

/**
 * Generic archetype diagram (responsive SVG) for `/learn` and the OG images:
 * the family description, with no coin facts or overrides. Coin pages draw
 * the resolved `MechanismFlow` (`./mechanism-flow`) instead.
 */
export function mechanismDiagramFor(archetype: MechanismArchetype, symbol: string): React.ReactNode {
  if (archetype === "synthetic-delta-neutral") {
    return <SyntheticDeltaNeutralDiagram symbol={symbol} />;
  }
  if (
    archetype === "fiat-cash" ||
    archetype === "tbill" ||
    archetype === "cdp" ||
    archetype === "algorithmic" ||
    archetype === "rwa-credit-fund" ||
    archetype === "commodity-claim" ||
    archetype === "ucits-trs-fund" ||
    archetype === "shared-reserve" ||
    archetype === "protocol-position"
  ) {
    return <ThreeStepArchetypeDiagram archetype={archetype} symbol={symbol} />;
  }
  return null;
}

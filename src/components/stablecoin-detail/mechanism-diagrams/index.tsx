import type { MechanismArchetype } from "@shared/types";

import { SyntheticDeltaNeutralDiagram } from "./synthetic-delta-neutral-diagram";
import { ThreeStepArchetypeDiagram } from "./three-step-archetype-diagram";
import { WrapperDiagram } from "./wrapper-diagram";
import type { CoinOverride, MechanismDiagramOptions } from "./types";

export type { CoinOverride, MechanismDiagramOptions } from "./types";

function renderArchetype(
  archetype: MechanismArchetype,
  symbol: string,
  override?: CoinOverride,
): React.ReactNode {
  const steps = override?.steps;
  const stressFootnote = override?.stressFootnote;
  if (archetype === "synthetic-delta-neutral") {
    return (
      <SyntheticDeltaNeutralDiagram
        symbol={symbol}
        steps={steps}
        {...(stressFootnote !== undefined ? { stressFootnote } : {})}
      />
    );
  }
  if (
    archetype === "fiat-cash" ||
    archetype === "tbill" ||
    archetype === "cdp" ||
    archetype === "algorithmic" ||
    archetype === "rwa-credit-fund"
  ) {
    return (
      <ThreeStepArchetypeDiagram
        archetype={archetype}
        symbol={symbol}
        steps={steps}
        {...(stressFootnote !== undefined ? { stressFootnote } : {})}
      />
    );
  }
  return null;
}

export function mechanismDiagramFor(
  archetype: MechanismArchetype,
  symbol: string,
  options?: MechanismDiagramOptions,
): React.ReactNode {
  if (
    options?.isWrapper &&
    options.parentSymbol &&
    options.parentArchetype
  ) {
    return (
      <WrapperDiagram
        symbol={symbol}
        parentSymbol={options.parentSymbol}
        parentArchetype={options.parentArchetype}
        variantKind={options.variantKind}
      />
    );
  }
  return renderArchetype(archetype, symbol, options?.override);
}

import type { MechanismArchetype } from "@shared/types";

import { AlgorithmicDiagram } from "./algorithmic-diagram";
import { CdpDiagram } from "./cdp-diagram";
import { FiatCashDiagram } from "./fiat-cash-diagram";
import { RwaCreditFundDiagram } from "./rwa-credit-fund-diagram";
import { SyntheticDeltaNeutralDiagram } from "./synthetic-delta-neutral-diagram";
import { TbillDiagram } from "./tbill-diagram";
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
  switch (archetype) {
    case "fiat-cash":
      return (
        <FiatCashDiagram
          symbol={symbol}
          steps={steps}
          {...(stressFootnote !== undefined ? { stressFootnote } : {})}
        />
      );
    case "tbill":
      return (
        <TbillDiagram
          symbol={symbol}
          steps={steps}
          {...(stressFootnote !== undefined ? { stressFootnote } : {})}
        />
      );
    case "cdp":
      return (
        <CdpDiagram
          symbol={symbol}
          steps={steps}
          {...(stressFootnote !== undefined ? { stressFootnote } : {})}
        />
      );
    case "synthetic-delta-neutral":
      return (
        <SyntheticDeltaNeutralDiagram
          symbol={symbol}
          steps={steps}
          {...(stressFootnote !== undefined ? { stressFootnote } : {})}
        />
      );
    case "algorithmic":
      return (
        <AlgorithmicDiagram
          symbol={symbol}
          steps={steps}
          {...(stressFootnote !== undefined ? { stressFootnote } : {})}
        />
      );
    case "rwa-credit-fund":
      return (
        <RwaCreditFundDiagram
          symbol={symbol}
          steps={steps}
          {...(stressFootnote !== undefined ? { stressFootnote } : {})}
        />
      );
    default:
      return null;
  }
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

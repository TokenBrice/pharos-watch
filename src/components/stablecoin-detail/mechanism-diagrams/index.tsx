import type { MechanismArchetype } from "@shared/types";

import { FiatCashDiagram } from "./fiat-cash-diagram";
import { TbillDiagram } from "./tbill-diagram";
import { CdpDiagram } from "./cdp-diagram";
import { SyntheticDeltaNeutralDiagram } from "./synthetic-delta-neutral-diagram";
import { AlgorithmicDiagram } from "./algorithmic-diagram";

export function mechanismDiagramFor(
  archetype: MechanismArchetype,
  symbol: string,
): React.ReactNode {
  switch (archetype) {
    case "fiat-cash":
      return <FiatCashDiagram symbol={symbol} />;
    case "tbill":
      return <TbillDiagram symbol={symbol} />;
    case "cdp":
      return <CdpDiagram symbol={symbol} />;
    case "synthetic-delta-neutral":
      return <SyntheticDeltaNeutralDiagram symbol={symbol} />;
    case "algorithmic":
      return <AlgorithmicDiagram symbol={symbol} />;
    default:
      return null;
  }
}

import type { MechanismArchetype } from "@shared/types";

import { renderArchetype } from "./render-archetype";
import { WrapperDiagram } from "./wrapper-diagram";
import type { MechanismDiagramOptions } from "./types";

export type { CoinOverride, MechanismDiagramOptions } from "./types";

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
        parentNavToken={options.parentNavToken}
      />
    );
  }
  return renderArchetype(archetype, symbol, options?.override, options?.navToken);
}

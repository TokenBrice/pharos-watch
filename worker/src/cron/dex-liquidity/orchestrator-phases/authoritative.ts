import { buildDirectApiPoolIdentity } from "../direct-source-helpers";
import type { DirectApiFetchPhaseResult } from "./direct-api";

export interface AuthoritativeStagedPoolConfirmationIndex {
  enforcedChainsByProtocol: Map<string, Set<string>>;
  confirmedExactKeysByProtocol: Map<string, Set<string>>;
}

export function buildAuthoritativeStagedPoolConfirmationIndex(
  results: DirectApiFetchPhaseResult["results"],
): AuthoritativeStagedPoolConfirmationIndex {
  const enforcedChainsByProtocol = new Map<string, Set<string>>();
  const confirmedExactKeysByProtocol = new Map<string, Set<string>>();

  for (const entry of results) {
    if (!entry.result.ok || entry.result.degraded || (entry.result.warnings?.length ?? 0) > 0) {
      continue;
    }

    const enforcedChains = enforcedChainsByProtocol.get(entry.normalizedProtocol) ?? new Set<string>();
    for (const chain of entry.supportedChains) {
      enforcedChains.add(chain);
    }
    enforcedChainsByProtocol.set(entry.normalizedProtocol, enforcedChains);

    const confirmedExactKeys = confirmedExactKeysByProtocol.get(entry.normalizedProtocol) ?? new Set<string>();
    if (entry.authoritativeExactPoolKeys) {
      for (const exactPoolKey of entry.authoritativeExactPoolKeys) {
        confirmedExactKeys.add(exactPoolKey);
      }
    } else {
      for (const pool of entry.result.pools) {
        const exactPoolKey = buildDirectApiPoolIdentity(pool).exactPoolKey;
        if (exactPoolKey) {
          confirmedExactKeys.add(exactPoolKey);
        }
      }
    }
    confirmedExactKeysByProtocol.set(entry.normalizedProtocol, confirmedExactKeys);
  }

  return {
    enforcedChainsByProtocol,
    confirmedExactKeysByProtocol,
  };
}

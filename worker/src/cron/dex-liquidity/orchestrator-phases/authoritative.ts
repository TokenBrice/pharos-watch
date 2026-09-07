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
    const pagination = entry.result.pagination;
    if (
      // A bounded sample never saw most of its protocol, so a pool missing from
      // it is not evidence that the pool does not exist.
      entry.censusScope === "bounded-sample" ||
      !entry.result.ok ||
      entry.result.degraded ||
      (pagination != null &&
        (pagination.state !== "complete" || !pagination.headRefreshed || !pagination.cycleCompleted))
    ) {
      continue;
    }

    // Only the raw provider census can confirm a staged pool. `result.pools` has
    // been compacted down to pools holding a tracked token by this point, and
    // enforcing against that subset vetoes real pools the compaction removed.
    // A census that produced no identity at all — a silent empty response, an
    // adapter that resolved nothing — carries no evidence either; enforcing on
    // it rejects every staged pool for the protocol on the strength of nothing.
    const rawExactPoolKeys = entry.authoritativeExactPoolKeys;
    if (!rawExactPoolKeys || rawExactPoolKeys.size === 0) continue;

    const enforcedChains = enforcedChainsByProtocol.get(entry.normalizedProtocol) ?? new Set<string>();
    for (const chain of entry.supportedChains) {
      enforcedChains.add(chain);
    }
    enforcedChainsByProtocol.set(entry.normalizedProtocol, enforcedChains);

    const confirmedExactKeys = confirmedExactKeysByProtocol.get(entry.normalizedProtocol) ?? new Set<string>();
    for (const exactPoolKey of rawExactPoolKeys) {
      confirmedExactKeys.add(exactPoolKey);
    }
    confirmedExactKeysByProtocol.set(entry.normalizedProtocol, confirmedExactKeys);
  }

  return {
    enforcedChainsByProtocol,
    confirmedExactKeysByProtocol,
  };
}

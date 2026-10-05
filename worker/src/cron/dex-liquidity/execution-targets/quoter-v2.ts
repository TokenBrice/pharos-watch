import { canonicalExitRouteAssetKey } from "@shared/types/exit-route-identity";
import type { DexExecutionTargetFactoryInput, DexExecutionTargetFactoryOutput } from "../execution-target-registry";
import {
  buildUniV3ExecutionCandidateKey,
  buildUniV3MeasuredExecutionTarget,
  parseUniV3FeePips,
  type UniV3ExecutionCandidate,
} from "../../measured-execution/inventory";
import { buildRegisteredTargetInput, toRegisteredTargetOutput } from "./shared";

// Candidate maps are completed by the source stage before target resolution.
// Index that generation once, rather than scanning the entire family per pool.
const candidateIndexes = new WeakMap<
  DexExecutionTargetFactoryInput["context"]["uniV3ExecutionCandidates"],
  {
    exact: Map<string, UniV3ExecutionCandidate[]>;
    pair: Map<string, UniV3ExecutionCandidate[]>;
  }
>();

function getCandidateIndexes(
  candidates: DexExecutionTargetFactoryInput["context"]["uniV3ExecutionCandidates"],
) {
  const existing = candidateIndexes.get(candidates);
  if (existing) return existing;
  const indexes = {
    exact: new Map<string, UniV3ExecutionCandidate[]>(),
    pair: new Map<string, UniV3ExecutionCandidate[]>(),
  };
  for (const bucket of candidates.values()) {
    for (const candidate of bucket) {
      const pairKey = buildUniV3ExecutionCandidateKey(
        candidate.chain, candidate.tokens.map((token) => token.address), 0,
      );
      if (pairKey == null) continue;
      const exactKey = `${canonicalExitRouteAssetKey(candidate.chain, candidate.poolAddress)}|${pairKey}`;
      const pairEntries = indexes.pair.get(pairKey) ?? [];
      pairEntries.push(candidate);
      indexes.pair.set(pairKey, pairEntries);
      const exactEntries = indexes.exact.get(exactKey) ?? [];
      exactEntries.push(candidate);
      indexes.exact.set(exactKey, exactEntries);
    }
  }
  candidateIndexes.set(candidates, indexes);
  return indexes;
}

export function buildQuoterV2RegisteredExecutionTarget(
  input: DexExecutionTargetFactoryInput,
): DexExecutionTargetFactoryOutput | null {
  const { context, identity } = input;
  if (identity.protocol !== "uniswap-v3") return null;

  const indexes = getCandidateIndexes(context.uniV3ExecutionCandidates);
  const tokenKey = buildUniV3ExecutionCandidateKey(
    identity.chainNorm, identity.pool.underlyingTokens, 0,
  );
  const exactPoolKey = canonicalExitRouteAssetKey(identity.chainNorm, identity.pool.pool);
  const hasExactPoolAddress = /^0x[a-f0-9]{40}$/.test(
    exactPoolKey.slice(identity.chainNorm.length + 1),
  );
  let matchingCandidates: readonly UniV3ExecutionCandidate[];
  if (hasExactPoolAddress) {
    matchingCandidates = tokenKey == null
      ? []
      : indexes.exact.get(`${exactPoolKey}|${tokenKey}`) ?? [];
    // The physical address and currency pair own identity. Display fee metadata
    // can be absent or stale; the exact source candidate owns the executable fee.
  } else {
    const feePips = parseUniV3FeePips(identity.pool.poolMeta);
    const executionKey = buildUniV3ExecutionCandidateKey(
      identity.chainNorm, identity.pool.underlyingTokens, feePips,
    );
    // An absent display fee is not a zero fee. Only a unique source candidate
    // across all actual fees may recover it; a known fee never broadens scope.
    matchingCandidates = feePips == null && tokenKey != null
      ? indexes.pair.get(tokenKey) ?? []
      : executionKey ? context.uniV3ExecutionCandidates.get(executionKey) ?? [] : [];
  }
  if (matchingCandidates.length !== 1) {
    return {
      executionCapabilityGate: {
        family: "measured-execution",
        reason: "target-unresolved",
      },
    };
  }

  const measuredExecutionTarget = buildUniV3MeasuredExecutionTarget(
    buildRegisteredTargetInput(input, matchingCandidates[0]!),
  );
  return toRegisteredTargetOutput(measuredExecutionTarget);
}

import { canonicalExitRouteAssetKey } from "@shared/types/exit-route-identity";
import type { DexExecutionTargetFactoryInput, DexExecutionTargetFactoryOutput } from "../execution-target-registry";
import {
  buildUniV3ExecutionCandidateKey,
  buildUniV3MeasuredExecutionTarget,
  parseUniV3FeePips,
  type UniV3ExecutionCandidate,
} from "../../measured-execution/inventory";
import { buildRegisteredTargetInput, toRegisteredTargetOutput } from "./shared";

export function buildQuoterV2RegisteredExecutionTarget(
  input: DexExecutionTargetFactoryInput,
): DexExecutionTargetFactoryOutput | null {
  const { context, identity } = input;
  if (identity.protocol !== "uniswap-v3") return null;

  const exactPoolKey = canonicalExitRouteAssetKey(identity.chainNorm, identity.pool.pool);
  const hasExactPoolAddress = /^0x[a-f0-9]{40}$/.test(
    exactPoolKey.slice(identity.chainNorm.length + 1),
  );
  let matchingCandidates: readonly UniV3ExecutionCandidate[];
  if (hasExactPoolAddress) {
    const exactCandidates: UniV3ExecutionCandidate[] = [];
    const tokenKey = buildUniV3ExecutionCandidateKey(
      identity.chainNorm, identity.pool.underlyingTokens, 0,
    );
    // The physical address and currency pair own identity. Display fee metadata
    // can be absent or stale; the exact source candidate owns the executable fee.
    for (const bucket of context.uniV3ExecutionCandidates.values()) {
      for (const candidate of bucket) {
        if (
          tokenKey != null &&
          canonicalExitRouteAssetKey(candidate.chain, candidate.poolAddress) === exactPoolKey &&
          buildUniV3ExecutionCandidateKey(
            candidate.chain, candidate.tokens.map((token) => token.address), 0,
          ) === tokenKey
        ) exactCandidates.push(candidate);
      }
    }
    matchingCandidates = exactCandidates;
  } else {
    const executionKey = buildUniV3ExecutionCandidateKey(
      identity.chainNorm,
      identity.pool.underlyingTokens,
      parseUniV3FeePips(identity.pool.poolMeta),
    );
    matchingCandidates = executionKey
      ? context.uniV3ExecutionCandidates.get(executionKey) ?? []
      : [];
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

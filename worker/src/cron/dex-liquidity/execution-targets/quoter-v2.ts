import type { DexExecutionTargetFactoryInput, DexExecutionTargetFactoryOutput } from "../execution-target-registry";
import {
  buildUniV3ExecutionCandidateKey,
  buildUniV3MeasuredExecutionTarget,
  parseUniV3FeePips,
} from "../../measured-execution/inventory";
import { buildRegisteredTargetInput, toRegisteredTargetOutput } from "./shared";

function retainedPoolAddress(poolId: string): string | null {
  const normalized = poolId.trim().toLowerCase();
  const match = normalized.match(/0x[a-f0-9]{40}$/);
  return match?.[0] ?? null;
}

export function buildQuoterV2RegisteredExecutionTarget(
  input: DexExecutionTargetFactoryInput,
): DexExecutionTargetFactoryOutput | null {
  const { context, identity } = input;
  if (identity.protocol !== "uniswap-v3") return null;

  const feePips = parseUniV3FeePips(identity.pool.poolMeta);
  const executionKey = buildUniV3ExecutionCandidateKey(
    identity.chainNorm,
    identity.pool.underlyingTokens,
    feePips,
  );
  const candidates = executionKey
    ? context.uniV3ExecutionCandidates.get(executionKey) ?? []
    : [];
  const exactPoolAddress = retainedPoolAddress(identity.pool.pool);
  const matchingCandidates = exactPoolAddress
    ? candidates.filter(
        (candidate) => candidate.poolAddress.trim().toLowerCase() === exactPoolAddress,
      )
    : candidates;
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

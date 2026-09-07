import type { DexExecutionTargetFactoryInput, DexExecutionTargetFactoryOutput } from "../execution-target-registry";
import {
  buildUniswapV4ExecutionCandidateKey,
  buildUniswapV4MeasuredExecutionTarget,
  parseUniV3FeePips,
} from "../../measured-execution/inventory";
import { buildRegisteredTargetInput, toRegisteredTargetOutput } from "./shared";

function retainedPoolId(poolId: string): string | null {
  const normalized = poolId.trim().toLowerCase();
  const match = normalized.match(/0x[a-f0-9]{64}$/);
  return match?.[0] ?? null;
}

export function buildUniswapV4RegisteredExecutionTarget(
  input: DexExecutionTargetFactoryInput,
): DexExecutionTargetFactoryOutput | null {
  const { context, identity } = input;
  if (identity.protocol !== "uniswap-v4") return null;

  const feePips = parseUniV3FeePips(identity.pool.poolMeta);
  const executionKey = buildUniswapV4ExecutionCandidateKey(
    identity.chainNorm,
    identity.pool.underlyingTokens,
    feePips,
  );
  const candidates = executionKey
    ? context.uniswapV4ExecutionCandidates.get(executionKey) ?? []
    : [];
  const exactPoolId = retainedPoolId(identity.pool.pool);
  const matchingCandidates = exactPoolId
    ? [...context.uniswapV4ExecutionCandidates.values()].flat().filter(
        (candidate) => candidate.chain === identity.chainNorm && candidate.poolId === exactPoolId,
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

  const measuredExecutionTarget = buildUniswapV4MeasuredExecutionTarget(
    buildRegisteredTargetInput(input, matchingCandidates[0]!),
  );
  return toRegisteredTargetOutput(measuredExecutionTarget);
}

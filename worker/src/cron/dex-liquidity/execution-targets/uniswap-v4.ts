import type { DexExecutionTargetFactoryInput, DexExecutionTargetFactoryOutput } from "../execution-target-registry";
import {
  buildUniswapV4ExecutionCandidateKey,
  buildUniswapV4MeasuredExecutionTarget,
  parseUniV3FeePips,
  type UniswapV4ExecutionCandidate,
} from "../../measured-execution/inventory";
import { buildRegisteredTargetInput, toRegisteredTargetOutput } from "./shared";

function retainedPoolId(poolId: string, chain: string): string | null {
  const normalized = poolId.trim().toLowerCase();
  const colon = normalized.lastIndexOf(":");
  const prefix = colon === -1 ? null : normalized.slice(0, colon);
  const id = normalized.slice(colon + 1);
  if (!/^0x[a-f0-9]{64}$/.test(id) || (prefix !== null && !/^[a-z0-9-]+$/.test(prefix))) return null;
  return prefix === null || prefix === chain ? id : null;
}

export function buildUniswapV4RegisteredExecutionTarget(
  input: DexExecutionTargetFactoryInput,
): DexExecutionTargetFactoryOutput | null {
  const { context, identity } = input;
  if (identity.protocol !== "uniswap-v4") return null;

  const exactPoolId = retainedPoolId(identity.pool.pool, identity.chainNorm);
  const currencyKey = buildUniswapV4ExecutionCandidateKey(
    identity.chainNorm, identity.pool.underlyingTokens, 0,
  );
  if (!currencyKey || (
    !exactPoolId && /0x[a-f0-9]{64}$/i.test(identity.pool.pool.trim())
  )) return toRegisteredTargetOutput(null);

  let candidate: UniswapV4ExecutionCandidate | undefined;
  if (exactPoolId) {
    // Do not flatten/copy the whole source inventory for every retained pool.
    for (const candidates of context.uniswapV4ExecutionCandidates.values()) {
      for (const current of candidates) {
        if (current.chain !== identity.chainNorm || current.poolId !== exactPoolId) continue;
        if (buildUniswapV4ExecutionCandidateKey(
          current.chain, current.tokens.map((token) => token.address), 0,
        ) !== currencyKey) continue;
        if (candidate) return toRegisteredTargetOutput(null);
        candidate = current;
      }
    }
  } else {
    const executionKey = buildUniswapV4ExecutionCandidateKey(
      identity.chainNorm, identity.pool.underlyingTokens,
      parseUniV3FeePips(identity.pool.poolMeta),
    );
    const candidates = executionKey
      ? context.uniswapV4ExecutionCandidates.get(executionKey) ?? []
      : [];
    if (candidates.length === 1) candidate = candidates[0];
  }
  if (!candidate) {
    return {
      executionCapabilityGate: {
        family: "measured-execution",
        reason: "target-unresolved",
      },
    };
  }

  const measuredExecutionTarget = buildUniswapV4MeasuredExecutionTarget(
    {
      ...buildRegisteredTargetInput(input, candidate),
      identityMatch: exactPoolId ? "exact-pool-id" : "token-fee",
    },
  );
  return toRegisteredTargetOutput(measuredExecutionTarget);
}

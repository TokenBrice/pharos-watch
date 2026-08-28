import { EXIT_ROUTE_SCORING_TABLES } from "./exit-route-scoring";
import type {
  DexAmmExecutionModel,
  DexAmmExecutionToken,
  ExitRouteCapacityPoint,
  ExitRouteObservation,
  ExitRouteOutput,
} from "../types/market";
import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteScopedId,
} from "./exit-route-identity";
import { buildCapacityPoint } from "./p4-exit-route-capability-policy";

const AMM_EXECUTION_COST_TOLERANCE_BPS = 0.02;
export const P4_AMM_MODELED_TVL_MIN_RATIO = 0.5;
export const P4_AMM_MODELED_TVL_MAX_RATIO = 2;

export function validateAmmExecutionModel(
  model: DexAmmExecutionModel,
  context: { chain: string; stablecoinId: string; retainedTvlUsd: number },
): string[] {
  const issues: string[] = [];
  if (
    !Number.isInteger(model.trackedTokenIndex) ||
    model.trackedTokenIndex < 0 ||
    model.trackedTokenIndex >= model.tokens.length
  ) {
    issues.push("invalid-tracked-token-index");
  }
  if (!Number.isFinite(model.feeRate) || model.feeRate < 0 || model.feeRate >= 1) issues.push("invalid-fee");
  if (model.tokens.length < 2 || model.tokens.length > 8) issues.push("invalid-token-count");
  const identities = new Set<string>();
  for (const token of model.tokens) {
    if (!token.address?.trim() || !token.symbol?.trim()) issues.push("missing-token-identity");
    const identity = canonicalExitRouteScopedId(context.chain, token.address);
    if (identities.has(identity)) issues.push("duplicate-token-identity");
    identities.add(identity);
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255)
      issues.push("invalid-decimals");
    if (!Number.isFinite(token.balance) || token.balance <= 0) issues.push("invalid-balance");
    if (!Number.isFinite(token.referencePriceUsd) || token.referencePriceUsd <= 0)
      issues.push("invalid-reference-price");
  }
  const trackedToken = model.tokens[model.trackedTokenIndex];
  if (trackedToken && trackedToken.trackedAssetId !== context.stablecoinId) {
    issues.push("tracked-input-stablecoin-mismatch");
  }
  const modeledTvlUsd = model.tokens.reduce((total, token) => total + token.balance * token.referencePriceUsd, 0);
  if (Number.isFinite(modeledTvlUsd) && modeledTvlUsd > 0) {
    const modeledTvlRatio = modeledTvlUsd / context.retainedTvlUsd;
    if (modeledTvlRatio < P4_AMM_MODELED_TVL_MIN_RATIO) issues.push("modeled-tvl-below-retained-bound");
    if (modeledTvlRatio > P4_AMM_MODELED_TVL_MAX_RATIO) issues.push("modeled-tvl-above-retained-bound");
  }
  if (model.invariant === "constant-product") {
    if (
      !["raydium", "uniswap-v2", "pancakeswap-v2", "aerodrome-volatile"].includes(model.source) ||
      model.tokens.length !== 2
    ) {
      issues.push("invalid-constant-product-model");
    }
  } else if (model.invariant === "stableswap") {
    if (model.source !== "curve" && model.source !== "balancer") issues.push("invalid-stableswap-model-source");
    if (model.amplification == null || !Number.isFinite(model.amplification) || model.amplification <= 0) {
      issues.push("invalid-amplification");
    }
  } else {
    if (model.source !== "balancer") issues.push("invalid-weighted-model-source");
    const weights = model.tokens.map((token) => token.weight);
    if (weights.some((weight) => weight == null || !Number.isFinite(weight) || weight <= 0)) {
      issues.push("invalid-weights");
    } else {
      const sum = (weights as number[]).reduce((total, weight) => total + weight, 0);
      if (Math.abs(sum - 1) > 0.0001) issues.push("invalid-weight-sum");
    }
  }
  return [...new Set(issues)];
}

/** StableSwap invariant D for balances x under amplification A (plain paper convention). */
function stableswapInvariantD(balances: readonly number[], amplification: number): number {
  const n = balances.length;
  const sum = balances.reduce((total, balance) => total + balance, 0);
  if (sum <= 0) return 0;
  const ann = amplification * n ** n;
  let d = sum;
  for (let iteration = 0; iteration < 256; iteration++) {
    let dProduct = d;
    for (const balance of balances) dProduct = (dProduct * d) / (balance * n);
    const previous = d;
    d = ((ann * sum + dProduct * n) * d) / ((ann - 1) * d + (n + 1) * dProduct);
    if (Math.abs(d - previous) <= 1e-10 * d) return d;
  }
  return d;
}

/** Output-token balance that keeps the invariant after the input balance moves to newInputBalance. */
function stableswapOutputBalance(
  balances: readonly number[],
  inputIndex: number,
  outputIndex: number,
  newInputBalance: number,
  amplification: number,
): number {
  const n = balances.length;
  const d = stableswapInvariantD(balances, amplification);
  const ann = amplification * n ** n;
  let c = d;
  let sum = 0;
  for (let index = 0; index < n; index++) {
    if (index === outputIndex) continue;
    const balance = index === inputIndex ? newInputBalance : balances[index]!;
    sum += balance;
    c = (c * d) / (balance * n);
  }
  c = (c * d) / (ann * n);
  const b = sum + d / ann;
  let y = d;
  for (let iteration = 0; iteration < 256; iteration++) {
    const previous = y;
    y = (y * y + c) / (2 * y + b - d);
    if (Math.abs(y - previous) <= 1e-10 * Math.max(1, y)) return y;
  }
  return y;
}

function simulateAmmOutput(model: DexAmmExecutionModel, outputTokenIndex: number, inputAmount: number): number {
  const input = model.tokens[model.trackedTokenIndex]!;
  const output = model.tokens[outputTokenIndex]!;
  const effectiveInput = inputAmount * (1 - model.feeRate);
  if (!Number.isFinite(effectiveInput) || effectiveInput <= 0) return 0;

  if (model.invariant === "constant-product") {
    return (output.balance * effectiveInput) / (input.balance + effectiveInput);
  }

  if (model.invariant === "stableswap") {
    const balances = model.tokens.map((token) => token.balance);
    // Curve StableSwap/NG evaluates its invariant on the full input, then
    // deducts the (static) fee from output. Other modeled StableSwap sources
    // charge against input. Treating Curve as input-fee is optimistic because
    // its concave curve produces more than (1 - fee) of the full-input output.
    const invariantInput = model.source === "curve" ? inputAmount : effectiveInput;
    const newOutputBalance = stableswapOutputBalance(
      balances,
      model.trackedTokenIndex,
      outputTokenIndex,
      input.balance + invariantInput,
      model.amplification!,
    );
    const grossOutput = output.balance - newOutputBalance;
    return Math.max(0, model.source === "curve" ? grossOutput * (1 - model.feeRate) : grossOutput);
  }

  const inputWeight = input.weight!;
  const outputWeight = output.weight!;
  const balanceRatio = input.balance / (input.balance + effectiveInput);
  return output.balance * (1 - balanceRatio ** (inputWeight / outputWeight));
}

function executableAmmInputUsd(
  model: DexAmmExecutionModel,
  outputTokenIndex: number,
  requestedNotionalUsd: number,
  maxCostBps: number,
): number {
  const input = model.tokens[model.trackedTokenIndex]!;
  const output = model.tokens[outputTokenIndex]!;
  const minimumOutputRatio = Math.max(0, 1 - maxCostBps / 10_000);
  // StableSwap has no simple closed-form spot price; an epsilon trade through
  // the invariant gives the fee-inclusive marginal ratio deterministically.
  const stableswapMarginalRatio = () => {
    const epsilon = Math.max(input.balance * 1e-6, 1e-6);
    const marginalOutput = simulateAmmOutput(model, outputTokenIndex, epsilon);
    return ((marginalOutput / epsilon) * output.referencePriceUsd) / input.referencePriceUsd;
  };
  const marginalOutputRatio =
    model.invariant === "constant-product"
      ? ((output.balance / input.balance) * (1 - model.feeRate) * output.referencePriceUsd) / input.referencePriceUsd
      : model.invariant === "stableswap"
        ? stableswapMarginalRatio()
        : ((output.balance / input.balance) *
            (input.weight! / output.weight!) *
            (1 - model.feeRate) *
            output.referencePriceUsd) /
          input.referencePriceUsd;
  if (!Number.isFinite(marginalOutputRatio) || marginalOutputRatio + 1e-12 < minimumOutputRatio) return 0;

  const qualifies = (inputUsd: number): boolean => {
    if (inputUsd <= 0) return true;
    const inputAmount = inputUsd / input.referencePriceUsd;
    const outputUsd = simulateAmmOutput(model, outputTokenIndex, inputAmount) * output.referencePriceUsd;
    return Number.isFinite(outputUsd) && outputUsd + 0.000001 >= inputUsd * minimumOutputRatio;
  };
  if (qualifies(requestedNotionalUsd)) return requestedNotionalUsd;

  let lower = 0;
  let upper = requestedNotionalUsd;
  for (let iteration = 0; iteration < 64; iteration++) {
    const midpoint = (lower + upper) / 2;
    if (qualifies(midpoint)) lower = midpoint;
    else upper = midpoint;
  }
  return lower;
}

function realizedAmmExecutionCostBps(
  model: DexAmmExecutionModel,
  outputTokenIndex: number,
  requestedNotionalUsd: number,
  executableUsd: number,
  maxCostBps: number,
): number | null {
  if (!Number.isFinite(executableUsd) || executableUsd <= 0) return null;
  const input = model.tokens[model.trackedTokenIndex];
  const output = model.tokens[outputTokenIndex];
  if (!input || !output || !Number.isFinite(input.referencePriceUsd) || input.referencePriceUsd <= 0) return null;
  const inputAmount = executableUsd / input.referencePriceUsd;
  const outputAmount = simulateAmmOutput(model, outputTokenIndex, inputAmount);
  const outputUsd = outputAmount * output.referencePriceUsd;
  if (!Number.isFinite(outputUsd) || outputUsd < 0) return null;
  const realizedCostBps = Math.max(0, (1 - outputUsd / executableUsd) * 10_000);
  if (!Number.isFinite(realizedCostBps) || realizedCostBps > maxCostBps + AMM_EXECUTION_COST_TOLERANCE_BPS) {
    return null;
  }
  if (
    executableUsd + 0.01 < requestedNotionalUsd &&
    realizedCostBps >= maxCostBps - AMM_EXECUTION_COST_TOLERANCE_BPS
  ) {
    return null;
  }
  return Math.round(Math.min(maxCostBps, realizedCostBps) * 1_000_000) / 1_000_000;
}

export function buildAmmCapacityCurve(model: DexAmmExecutionModel, outputTokenIndex: number): ExitRouteCapacityPoint[] {
  return EXIT_ROUTE_SCORING_TABLES.request.notionalGridUsd.map((notional) => {
    const point = buildCapacityPoint(
      notional,
      EXIT_ROUTE_SCORING_TABLES.request.maxCostBps,
      executableAmmInputUsd(model, outputTokenIndex, notional, EXIT_ROUTE_SCORING_TABLES.request.maxCostBps),
    );
    const executionCostBps = realizedAmmExecutionCostBps(
      model,
      outputTokenIndex,
      point.requestedNotionalUsd,
      point.executableUsd,
      point.maxCostBps,
    );
    return executionCostBps == null ? point : { ...point, executionCostBps };
  });
}

export function outputFromAmmToken(
  chain: string,
  token: Pick<DexAmmExecutionToken, "address" | "symbol" | "trackedAssetId">,
): ExitRouteOutput {
  const assetKey = canonicalExitRouteAssetKey(chain, token.address);
  if (token.trackedAssetId) {
    return {
      kind: "tracked-stablecoin",
      trackedAssetIds: [token.trackedAssetId],
      assetKeys: [assetKey],
    };
  }
  return {
    kind: "collateral",
    assetKeys: [assetKey],
    basketWeights: [{ symbol: token.symbol, weight: 1 }],
  };
}

export function trackedExactAmmOutputValuationFields(
  token: Pick<DexAmmExecutionToken, "trackedAssetId" | "referencePriceUsd" | "referencePriceSource">,
  sourceId: string,
  observedAt: number,
): Partial<
  Pick<
    ExitRouteObservation,
    "outputUnitValueUsd" | "outputUnitValueSourceId" | "outputUnitValueObservedAt"
  >
> {
  if (
    !token.trackedAssetId ||
    (token.referencePriceSource !== "source-token-usd" && token.referencePriceSource !== "tracked-market")
  ) {
    return {};
  }
  return {
    outputUnitValueUsd: token.referencePriceUsd,
    outputUnitValueSourceId: sourceId,
    outputUnitValueObservedAt: observedAt,
  };
}


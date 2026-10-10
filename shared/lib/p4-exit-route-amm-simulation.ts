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
} from "../types/exit-route-identity";
import { buildCapacityPoint } from "./p4-exit-route-capability-policy";
import { quoteSolidlyV2Raw, solidlyUsdToRawAmount } from "./solidly-v2-math";
import { SOLIDLY_V2_DEPLOYMENTS } from "./solidly-v2-deployments";
import { DEX_MEASURED_FRESHNESS_MAX_SEC } from "../types/measured-execution";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "./depeg-config";

const AMM_EXECUTION_COST_TOLERANCE_BPS = 0.02;
export const P4_AMM_MODELED_TVL_MIN_RATIO = 0.5;
export const P4_AMM_MODELED_TVL_MAX_RATIO = 2;

export function validateAmmExecutionModel(
  model: DexAmmExecutionModel,
  context: { chain: string; stablecoinId: string; retainedTvlUsd: number; nowSec?: number },
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
  if (model.source === "uniswap-v2" || model.source === "pancakeswap-v2" || model.capture) {
    const capture = model.capture;
    if (!capture || !Number.isSafeInteger(capture.blockNumber) || capture.blockNumber <= 0 ||
      !/^0x[0-9a-fA-F]{64}$/.test(capture.blockHash) || !capture.sourceGenerationId?.trim() ||
      !Number.isSafeInteger(capture.blockTimestamp) || capture.blockTimestamp <= 0 ||
      !Number.isSafeInteger(context.nowSec)) {
      issues.push("missing-exact-capture-identity");
    } else if (capture.blockTimestamp > context.nowSec! + 60 ||
      context.nowSec! - capture.blockTimestamp > DEX_MEASURED_FRESHNESS_MAX_SEC) {
      issues.push("stale-exact-capture");
    }
  }
  if (model.source === "solidly-v2") {
    const state = model.solidlyState;
    const deployment = SOLIDLY_V2_DEPLOYMENTS.find((row) => row.chain === context.chain && row.variant === state?.variant);
    if (!deployment || state?.factoryAddress.toLowerCase() !== deployment.factoryAddress) issues.push("invalid-solidly-deployment");
    if (!state?.blockTimestamp || !state.sourceGenerationId || !Number.isSafeInteger(context.nowSec) ||
      state.blockTimestamp > context.nowSec! + 60 || context.nowSec! - state.blockTimestamp > DEX_MEASURED_FRESHNESS_MAX_SEC ||
      model.tokens.some((token) => !token.referencePriceSourceId || !Number.isSafeInteger(token.referencePriceObservedAt) ||
        token.referencePriceObservedAt! <= 0 || token.referencePriceObservedAt! > context.nowSec! ||
        token.referencePriceObservedAt! > state.blockTimestamp! + 60 ||
        context.nowSec! - token.referencePriceObservedAt! > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC)) {
      issues.push("invalid-solidly-freshness");
    }
    const chain = state?.variant === "aerodrome" ? "base" : "optimism";
    if (!state || context.chain !== chain || model.tokens.length !== 2 || state.stable !== true ||
      !["aerodrome", "velodrome"].includes(state.variant) ||
      model.invariant !== "solidly-stable" || model.feeRate !== state.fee / 10_000 ||
      !Array.isArray(state.quoteChecks) || state.verifiedQuoteCount !== state.quoteChecks.length ||
      state.quoteChecks.length > 32 ||
      new Set(state.quoteChecks.filter((point) => point.tokenInIndex === model.trackedTokenIndex).map((point) => point.amountIn)).size < EXIT_ROUTE_SCORING_TABLES.request.notionalGridUsd.length) {
      issues.push("invalid-solidly-proof");
    } else {
      try {
        const reserves = [BigInt(state.reserve0), BigInt(state.reserve1)];
        if (reserves.some((reserve, index) => Number(reserve) / 10 ** model.tokens[index]!.decimals !== model.tokens[index]!.balance)) {
          issues.push("invalid-solidly-proof");
        }
        const input = model.tokens[model.trackedTokenIndex]!;
        for (const usd of EXIT_ROUTE_SCORING_TABLES.request.notionalGridUsd) {
          const raw = solidlyUsdToRawAmount(usd, input.decimals, input.referencePriceUsd);
          if (!raw || !state.quoteChecks.some((point) => point.tokenInIndex === model.trackedTokenIndex && point.amountIn === raw.toString())) {
            issues.push("invalid-solidly-proof");
          }
        }
        const expected = buildSolidlyV2CapacityChecks(model);
        if (!expected || state.capacityChecks?.length !== expected.length || expected.some((point, index) => {
          const captured = state.capacityChecks?.[index];
          return !captured || captured.requestedNotionalUsd !== point.requestedNotionalUsd ||
            captured.executableUsd !== point.executableUsd || captured.selectedAmountIn !== point.selectedAmountIn ||
            captured.selectedAmountOut !== point.selectedAmountOut || captured.rejectedAmountIn !== point.rejectedAmountIn ||
            captured.rejectedAmountOut !== point.rejectedAmountOut;
        })) issues.push("invalid-solidly-capacity-proof");
        for (const point of expected ?? []) {
          for (const [amountIn, amountOut] of [
            [point.selectedAmountIn, point.selectedAmountOut], [point.rejectedAmountIn, point.rejectedAmountOut],
          ]) {
            if (amountIn && amountIn !== "0" && !state.quoteChecks.some((quote) =>
              quote.tokenInIndex === model.trackedTokenIndex && quote.amountIn === amountIn && quote.amountOut === amountOut)) {
              issues.push("invalid-solidly-capacity-proof");
            }
          }
        }
        for (const point of state.quoteChecks) {
          if ((point.tokenInIndex !== 0 && point.tokenInIndex !== 1) || !/^[1-9][0-9]{0,77}$/.test(point.amountIn)) {
            issues.push("invalid-solidly-proof");
            break;
          }
          const amountOut = quoteSolidlyV2Raw({
            reserve0: reserves[0]!, reserve1: reserves[1]!,
            decimals0: model.tokens[0]!.decimals, decimals1: model.tokens[1]!.decimals,
            stable: state.stable, fee: BigInt(state.fee), variant: state.variant,
          }, BigInt(point.amountIn), point.tokenInIndex);
          if (amountOut === null || amountOut.toString() !== point.amountOut) {
            issues.push("solidly-quote-equivalence-failed");
            break;
          }
        }
      } catch {
        issues.push("invalid-solidly-proof");
      }
    }
    return [...new Set(issues)];
  }
  if (model.invariant === "constant-product") {
    if (
      !["raydium", "uniswap-v2", "pancakeswap-v2"].includes(model.source) ||
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
      : model.invariant === "stableswap" || model.invariant === "solidly-stable"
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

/** Raw endpoints defining the published cent-floored capacity, not just the request grid. */
export function buildSolidlyV2CapacityChecks(model: DexAmmExecutionModel) {
  const state = model.solidlyState;
  if (!state || state.stable !== true || model.tokens.length !== 2) return null;
  const input = model.tokens[model.trackedTokenIndex];
  const output = model.tokens[1 - model.trackedTokenIndex];
  if (!input || !output || !/^[1-9][0-9]{0,77}$/.test(state.reserve0) || !/^[1-9][0-9]{0,77}$/.test(state.reserve1) ||
    !Number.isSafeInteger(state.fee) || state.fee < 0 || state.fee >= 10_000 ||
    [input, output].some((token) => !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 77 ||
      !Number.isFinite(token.referencePriceUsd * 100_000_000) || token.referencePriceUsd <= 0)) return null;
  const inputScale = 10n ** BigInt(input.decimals);
  const outputScale = 10n ** BigInt(output.decimals);
  const inputPrice = BigInt(Math.round(input.referencePriceUsd * 100_000_000));
  const outputPrice = BigInt(Math.round(output.referencePriceUsd * 100_000_000));
  if (inputPrice <= 0n || outputPrice <= 0n) return null;
  const quoteState = {
    reserve0: BigInt(state.reserve0), reserve1: BigInt(state.reserve1),
    decimals0: model.tokens[0]!.decimals, decimals1: model.tokens[1]!.decimals,
    stable: state.stable, fee: BigInt(state.fee), variant: state.variant,
  };
  const quote = (raw: bigint) => raw === 0n ? 0n : quoteSolidlyV2Raw(quoteState, raw, model.trackedTokenIndex as 0 | 1);
  const qualifies = (raw: bigint, rawOutput: bigint) =>
    rawOutput * outputPrice * inputScale * 10_000n >=
    raw * inputPrice * outputScale * BigInt(10_000 - EXIT_ROUTE_SCORING_TABLES.request.maxCostBps);
  const grid = EXIT_ROUTE_SCORING_TABLES.request.notionalGridUsd;
  const maximumRequestRaw = solidlyUsdToRawAmount(grid[grid.length - 1]!, input.decimals, input.referencePriceUsd);
  if (maximumRequestRaw == null) return null;
  const maximumRequestOutput = quote(maximumRequestRaw);
  if (maximumRequestOutput == null) return null;
  let lower = maximumRequestRaw;
  let upper = maximumRequestRaw;
  let rejectedAmountOut: bigint | undefined;
  if (!qualifies(maximumRequestRaw, maximumRequestOutput)) {
    lower = 0n;
    // One local integer search for the whole grid. Only the emitted endpoints
    // go to RPC, never the midpoints; adjacent raw units establish the maximum.
    while (upper - lower > 1n) {
      const midpoint = (lower + upper) / 2n;
      const amountOut = quote(midpoint);
      if (amountOut == null) return null;
      if (qualifies(midpoint, amountOut)) lower = midpoint;
      else upper = midpoint;
    }
    rejectedAmountOut = quote(upper) ?? undefined;
    if (rejectedAmountOut == null || qualifies(upper, rejectedAmountOut)) return null;
  }
  const capacityUsd = Number(lower * inputPrice * 100n / (inputScale * 100_000_000n)) / 100;
  const checks: NonNullable<NonNullable<DexAmmExecutionModel["solidlyState"]>["capacityChecks"]> = [];
  for (const requestedNotionalUsd of grid) {
    const requestRaw = solidlyUsdToRawAmount(requestedNotionalUsd, input.decimals, input.referencePriceUsd);
    if (requestRaw == null) return null;
    const full = requestRaw <= lower;
    const executableUsd = full ? requestedNotionalUsd : capacityUsd;
    const selectedAmountIn = executableUsd === 0 ? 0n :
      solidlyUsdToRawAmount(executableUsd, input.decimals, input.referencePriceUsd);
    if (selectedAmountIn == null) return null;
    const selectedAmountOut = quote(selectedAmountIn);
    if (selectedAmountOut == null || !qualifies(selectedAmountIn, selectedAmountOut)) return null;
    const outputUsd = Number(selectedAmountOut) / 10 ** output.decimals * output.referencePriceUsd;
    if (executableUsd > 0 && outputUsd + 1e-9 < executableUsd * (1 - EXIT_ROUTE_SCORING_TABLES.request.maxCostBps / 10_000)) return null;
    checks.push({
      requestedNotionalUsd, executableUsd,
      selectedAmountIn: selectedAmountIn.toString(), selectedAmountOut: selectedAmountOut.toString(),
      ...(full ? {} : { rejectedAmountIn: upper.toString(), rejectedAmountOut: rejectedAmountOut!.toString() }),
    });
  }
  return checks;
}

export function buildAmmCapacityCurve(model: DexAmmExecutionModel, outputTokenIndex: number): ExitRouteCapacityPoint[] {
  if (model.source === "solidly-v2") {
    const checks = model.solidlyState?.capacityChecks;
    if (!checks || outputTokenIndex !== 1 - model.trackedTokenIndex) return [];
    const output = model.tokens[outputTokenIndex]!;
    return checks.map((check) => {
      const point = buildCapacityPoint(check.requestedNotionalUsd, EXIT_ROUTE_SCORING_TABLES.request.maxCostBps, check.executableUsd);
      if (point.executableUsd === 0) return point;
      const outputUsd = Number(BigInt(check.selectedAmountOut)) / 10 ** output.decimals * output.referencePriceUsd;
      const cost = Math.max(0, (1 - outputUsd / point.executableUsd) * 10_000);
      return { ...point, executionCostBps: Math.round(cost * 1_000_000) / 1_000_000 };
    });
  }
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
    token.referencePriceSource !== "tracked-market"
  ) {
    return {};
  }
  return {
    outputUnitValueUsd: token.referencePriceUsd,
    outputUnitValueSourceId: sourceId,
    outputUnitValueObservedAt: observedAt,
  };
}


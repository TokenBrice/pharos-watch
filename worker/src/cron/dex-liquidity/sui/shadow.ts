import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "@shared/lib/depeg-config";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { getDexMeasuredExecutionProbeNotionals, type DexRequestBudget } from "@shared/types/measured-execution";
import { SuiClmmShadowHistorySchema, SuiClmmShadowSampleSchema, SUI_CLMM_SHADOW_HISTORY_LIMIT, SUI_CLMM_SHADOW_PACKET_MAX_BYTES, type SuiClmmShadowSample } from "@shared/types/sui-clmm";
import { parseUnits } from "viem/utils";
import { throwIfAborted } from "../../../lib/abort";
import { getCache, setCachesAt } from "../../../lib/db-cache";
import { loadDwellirBudgetState, recordDwellirCredits, type DwellirBudgetEnv } from "../../../lib/rpc-provider-budget";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../../../lib/stablecoins-cache";
import { readDexSourcePaginationState, writeDexSourcePaginationState } from "../source-pagination-state";
import { createSuiTransactionCheckpointResolver } from "./archival-checkpoints";
import { quoteSuiClmmExactIn } from "./clmm-quote";
import { inspectSuiClmmQuotes } from "./independent-quote";
import { SUI_CLMM_DEPLOYMENTS, suiClmmFamily, suiClmmPoolId, suiCoinType } from "./identity";
import { decodeSuiClmmSnapshot, fetchSuiClmmCapture, type SuiClmmSnapshot, type SuiRpc } from "./state-reader";
import { createSuiClmmGrpc } from "./grpc";

const MAX_POOLS = 2;
const RUNTIME_MS = 45_000;
const MAX_REQUESTS = 64;
const CURSOR_KEY = "sui-clmm-native-shadow:v1";
interface RetainedSuiPool { pool_id: string; stablecoin_id: string; tvl_usd: number; project: string }

export function selectSuiShadowPools(rows: readonly RetainedSuiPool[], cursor: string | null) {
  const unique = new Map<string, RetainedSuiPool>();
  for (const row of rows) {
    const poolId = suiClmmPoolId(row.pool_id);
    if (!poolId || suiClmmFamily(row.project) !== "cetus" || !Number.isFinite(row.tvl_usd) || row.tvl_usd <= 0 || !ACTIVE_META_BY_ID.has(row.stablecoin_id)) continue;
    const key = `${poolId}:${row.stablecoin_id}`;
    const prior = unique.get(key);
    if (!prior || prior.tvl_usd < row.tvl_usd) unique.set(key, { ...row, pool_id: poolId });
  }
  const ordered = [...unique.values()].sort((a, b) => b.tvl_usd - a.tvl_usd || a.pool_id.localeCompare(b.pool_id) || a.stablecoin_id.localeCompare(b.stablecoin_id));
  const parsed = Number(cursor ?? 0);
  const start = Number.isSafeInteger(parsed) && parsed >= 0 && ordered.length ? parsed % ordered.length : 0;
  return { selected: ordered.slice(start, start + MAX_POOLS), start, total: ordered.length };
}

/** Actual read/quote producer seam shared with live smoke. Nothing here writes production data. */
export async function observeSuiClmmShadowPool(input: {
  rpc: SuiRpc | null; snapshot: SuiClmmSnapshot; stablecoinId: string;
  coinTypeIn: string; inputDecimals: number; inputPriceUsd: number; retainedTvlUsd: number;
  inputPriceReference?: SuiClmmShadowSample["inputPriceReference"];
  generationId: string;
}): Promise<SuiClmmShadowSample> {
  if (!Number.isFinite(input.inputPriceUsd) || input.inputPriceUsd <= 0 || !Number.isInteger(input.inputDecimals) || input.inputDecimals < 0 || input.inputDecimals > 18) throw new Error("sui-trusted-input-reference-unavailable");
  const { snapshot } = input;
  const coinTypeIn = suiCoinType(input.coinTypeIn);
  if (coinTypeIn !== snapshot.pool.coinA && coinTypeIn !== snapshot.pool.coinB) throw new Error("sui-tracked-input-identity-mismatch");
  const notionals = getDexMeasuredExecutionProbeNotionals(input.retainedTvlUsd);
  if (!notionals.length) throw new Error("sui-request-grid-unavailable");
  const requests = notionals.map((notional) => {
    const units = notional / input.inputPriceUsd;
    if (!Number.isFinite(units) || units <= 0 || units >= 1e21) throw new Error("sui-input-notional-invalid");
    return { aToB: coinTypeIn === snapshot.pool.coinA, amountIn: parseUnits(units.toFixed(input.inputDecimals), input.inputDecimals) };
  });
  const quotes = requests.map((request, index) => {
    try {
      const quote = quoteSuiClmmExactIn(snapshot, coinTypeIn, request.amountIn);
      return { notionalUsd: notionals[index], amountIn: request.amountIn.toString(),
        amountOut: quote.amountOut.toString(), feeAmount: quote.feeAmount.toString(),
        protocolFeeAmount: quote.protocolFeeAmount.toString(), sqrtPriceAfter: quote.sqrtPriceAfter.toString(),
        crossedTicks: quote.crossedTicks, reason: null, independentAgreement: null as boolean | null };
    } catch (error) {
      return { notionalUsd: notionals[index], amountIn: request.amountIn.toString(),
        amountOut: null, feeAmount: null, protocolFeeAmount: null, sqrtPriceAfter: null,
        crossedTicks: null, reason: error instanceof Error && error.message.startsWith("sui-") ? error.message.slice(0, 180) : "sui-quote-failed", independentAgreement: null as boolean | null };
    }
  });
  let independentCheck: "stationary-object-set" | "failed" = "failed";
  let independentCheckReason: string | null = null;
  try {
    if (!input.rpc) throw new Error("sui-grpc-inspection-unsupported");
    const independent = await inspectSuiClmmQuotes(input.rpc, snapshot, requests);
    for (let i = 0; i < quotes.length; i++) {
      const local = quotes[i];
      const remote = independent.quotes[i];
      local.independentAgreement = local.reason != null
        ? local.reason === "sui-clmm-liquidity-exhausted" && remote.exceeded
        : !remote.exceeded && local.amountOut === remote.amountOut.toString() && local.feeAmount === remote.feeAmount.toString() && local.sqrtPriceAfter === remote.sqrtPriceAfter.toString();
    }
    if (quotes.every((quote) => quote.independentAgreement)) independentCheck = "stationary-object-set";
    else independentCheckReason = "sui-independent-quote-mismatch";
  } catch (error) {
    independentCheckReason = error instanceof Error && error.message.startsWith("sui-") ? error.message.slice(0, 180) : "sui-independent-check-failed";
  }
  const { pool } = snapshot;
  return SuiClmmShadowSampleSchema.parse({
    generationId: input.generationId, observedAtSec: Math.floor(Date.now() / 1000),
    stablecoinId: input.stablecoinId, profileId: SUI_CLMM_DEPLOYMENTS[pool.family].profileId,
    modelVersion: "sui-clmm-q64-v1", scoreEligible: false, checkpointBoundInspection: false,
    checkpoint: snapshot.checkpoint, checkpointDigest: snapshot.checkpointDigest, checkpointTimestampMs: snapshot.timestampMs,
    poolId: pool.poolId, coinA: pool.coinA, coinB: pool.coinB, coinTypeIn,
    inputDecimals: input.inputDecimals, inputPriceUsd: input.inputPriceUsd, inputPriceReference: input.inputPriceReference,
    quotePackage: SUI_CLMM_DEPLOYMENTS[pool.family].quotePackage,
    sqrtPrice: pool.sqrtPrice.toString(), currentTick: pool.currentTick, liquidity: pool.liquidity.toString(),
    tickSpacing: pool.tickSpacing, feePips: pool.feePips, protocolFeeRate: pool.protocolFeeRate,
    tickCensusComplete: true,
    ticks: snapshot.ticks.map((tick) => ({ index: tick.index, sqrtPrice: tick.sqrtPrice.toString(), liquidityGross: tick.liquidityGross.toString(), liquidityNet: tick.liquidityNet.toString() })),
    references: snapshot.references, independentCheck, independentCheckReason, quotes,
  });
}

/** Serialized after the existing measured/native lanes: one connection, no new trigger.
 * Bounded per-pool histories are diagnostic cache rows, never V1 quote/target or score data. */
export async function collectSuiClmmShadowQuotes(input: { db: D1Database; env: DwellirBudgetEnv; signal?: AbortSignal }) {
  const startedAt = Date.now();
  const nowSec = Math.floor(startedAt / 1000);
  const summary = { attempted: 0, persisted: 0, failed: 0, budgetExhausted: false,
    scoreEligible: false as const, durationMs: 0, requests: 0, reason: null as string | null,
    lastFailureReason: null as string | null, independentCheckReason: null as string | null,
    skipped: {} as Record<string, number>, failures: [] as string[] };
  const dwellir = await loadDwellirBudgetState(input.db, input.env, nowSec);
  if (!dwellir.usable) { summary.reason = dwellir.reason; summary.skipped[dwellir.reason] = 1; return summary; }
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(RUNTIME_MS)]);
  const budget: DexRequestBudget = {
    maxRequests: MAX_REQUESTS, deadlineMs: startedAt + RUNTIME_MS,
    get remainingRequests() { return MAX_REQUESTS - summary.requests; },
    tryConsume(count = 1) {
      if (signal.aborted || Date.now() >= this.deadlineMs || count > this.remainingRequests || (dwellir.usedCredits ?? dwellir.capCredits) + summary.requests + count > dwellir.capCredits) return false;
      summary.requests += count; return true;
    },
  };
  const rpc = createSuiClmmGrpc({ url: "https://api-sui-mainnet-full.n.dwellir.com", headers: { "X-Api-Key": input.env.DWELLIR_API_KEY! }, signal, budget, onResponse: () => recordDwellirCredits(1) });
  const archive = createSuiTransactionCheckpointResolver({ signal, budget });
  const state = await readDexSourcePaginationState(input.db, CURSOR_KEY, "sync-cl-exit-depth");
  const retained = await input.db.prepare(`SELECT json_extract(pool.value, '$.poolId') AS pool_id,
    dl.stablecoin_id, json_extract(pool.value, '$.tvlUsd') AS tvl_usd,
    json_extract(pool.value, '$.project') AS project
    FROM dex_liquidity dl, json_each(dl.top_pools_json) pool
    WHERE dl.updated_at >= ? AND dl.publication_state = 'published'
      AND dl.publication_generation_id = (SELECT publication_generation_id FROM dex_liquidity
        WHERE stablecoin_id = '__global__' AND publication_state = 'published')
      AND lower(json_extract(pool.value, '$.chain')) = 'sui'
      AND json_extract(pool.value, '$.project') IN ('cetus', 'cetus-clmm')
    ORDER BY json_extract(pool.value, '$.tvlUsd') DESC LIMIT 256`).bind(nowSec - 24 * 60 * 60).all<RetainedSuiPool>();
  const window = selectSuiShadowPools(retained.results ?? [], state.cursor);
  const prices = new Map<string, { price: number; reference: NonNullable<SuiClmmShadowSample["inputPriceReference"]> }>();
  const cached = await loadStablecoinsCache(input.db, { contract: "published" });
  if (hasUsableStablecoinsPayload(cached) && Number.isSafeInteger(cached.updatedAt) && cached.updatedAt! > 0 &&
    cached.updatedAt! <= nowSec && nowSec - cached.updatedAt! <= DEPEG_PRIMARY_PRICE_MAX_AGE_SEC) {
    for (const asset of cached.payload.peggedAssets) {
      const observedAt = asset.priceObservedAt ?? asset.priceUpdatedAt;
      // Single-source prices size diagnostic inputs only; scored quote-leg trust remains unchanged.
      if (typeof asset.price !== "number" || !Number.isFinite(asset.price) || asset.price <= 0 ||
        !asset.priceSource?.trim() || asset.priceSource.length > 500 || !isObservedPrice(asset) ||
        (asset.priceConfidence !== "high" && asset.priceConfidence !== "single-source") ||
        !Number.isSafeInteger(observedAt) || observedAt! <= 0 || observedAt! > nowSec ||
        nowSec - observedAt! > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC) continue;
      prices.set(asset.id, { price: asset.price, reference: { source: asset.priceSource, confidence: asset.priceConfidence,
        observedAtSec: observedAt!, cacheUpdatedAtSec: cached.updatedAt!, maxAgeSec: DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } });
    }
  }
  let examined = 0;
  for (const row of window.selected) {
    if (signal.aborted || budget.remainingRequests <= 0) {
      if (budget.remainingRequests <= 0) {
        summary.reason ??= "sui-rpc-budget-exhausted";
        summary.budgetExhausted = true;
      } else {
        summary.reason = "sui-runtime-fence-exceeded";
      }
      break;
    }
    examined++;
    summary.attempted++;
    try {
      const price = prices.get(row.stablecoin_id);
      if (!price) throw new Error("sui-trusted-input-reference-unavailable");
      const family = suiClmmFamily(row.project)!;
      const capture = await fetchSuiClmmCapture(rpc, family, row.pool_id, undefined, archive);
      const snapshot = decodeSuiClmmSnapshot(capture, Math.floor(Date.now() / 1000), { poolId: row.pool_id });
      const contracts = (ACTIVE_META_BY_ID.get(row.stablecoin_id)?.contracts ?? []).filter((contract) => contract.chain === "sui" && [snapshot.pool.coinA, snapshot.pool.coinB].includes(suiCoinType(contract.address) ?? ""));
      if (contracts.length !== 1 || contracts[0].decimals == null) throw new Error("sui-tracked-input-identity-unresolved");
      const sample = await observeSuiClmmShadowPool({ rpc: null, snapshot, stablecoinId: row.stablecoin_id,
        coinTypeIn: contracts[0].address, inputDecimals: contracts[0].decimals, inputPriceUsd: price.price, inputPriceReference: price.reference,
        retainedTvlUsd: row.tvl_usd, generationId: `sui-clmm-shadow-${Math.floor(nowSec / 1800) * 1800}` });
      summary.independentCheckReason ??= sample.independentCheckReason;
      throwIfAborted(signal);
      const key = `dex:sui-clmm-shadow:v1:${row.pool_id}:${row.stablecoin_id}`;
      const prior = await getCache(input.db, key, signal);
      let samples: SuiClmmShadowSample[] = [];
      if (prior) {
        const parsed: unknown = JSON.parse(prior.value);
        const decoded = SuiClmmShadowHistorySchema.safeParse(parsed);
        if (!decoded.success) throw new Error("sui-shadow-history-invalid");
        samples = decoded.data.samples;
      }
      samples = samples.filter((row) => row.generationId !== sample.generationId);
      samples.push(sample);
      samples = samples.slice(-SUI_CLMM_SHADOW_HISTORY_LIMIT);
      const value = JSON.stringify(SuiClmmShadowHistorySchema.parse({ schemaVersion: "sui-clmm-shadow-v1", samples }));
      if (new TextEncoder().encode(value).length > SUI_CLMM_SHADOW_PACKET_MAX_BYTES) throw new Error("sui-shadow-history-payload-overflow");
      await setCachesAt(input.db, [{ key, value }], sample.observedAtSec, { mode: "if-newer", signal });
      summary.persisted++;
    } catch (error) {
      throwIfAborted(input.signal);
      const reason = error instanceof Error ? /^sui-[a-z0-9-]+/.exec(error.message)?.[0]?.slice(0, 180) ?? "sui-shadow-observation-failed" : "sui-shadow-observation-failed";
      summary.reason ??= reason;
      summary.lastFailureReason = reason;
      summary.failed++;
      summary.failures.push(`${row.pool_id}:${error instanceof Error && error.message.startsWith("sui-") ? error.message.slice(0, 180) : reason}`);
      if (budget.remainingRequests <= 0) { summary.budgetExhausted = true; break; }
      if (signal.aborted) { summary.reason = "sui-runtime-fence-exceeded"; break; }
    }
  }
  throwIfAborted(input.signal);
  const next = window.start + examined;
  const written = await writeDexSourcePaginationState({ db: input.db, sourceKey: CURSOR_KEY,
    cursor: String(next >= window.total ? 0 : next), cycleStartedAt: state.cycleStartedAt ?? nowSec,
    nowSec, completed: next >= window.total, pagesFetched: state.pagesFetched + 1,
    diagnostics: summary.failures, job: "sync-cl-exit-depth" });
  if (!written.written) throw new Error("sui-shadow-cursor-persistence-failed");
  summary.durationMs = Date.now() - startedAt;
  return summary;
}

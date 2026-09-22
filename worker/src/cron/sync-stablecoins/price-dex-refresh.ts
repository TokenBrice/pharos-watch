import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { throwIfAborted, rethrowIfAborted } from "../../lib/abort";
import { getCache, setCacheIfNewer } from "../../lib/db-cache";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { dsRateLimit } from "../../lib/dexscreener";
import { isProviderCircuitAllowed, recordProviderOutcomeSafe } from "../../lib/pricing-provider-lifecycle";
import { hasPublishableCurrentPrice } from "../../lib/price-publication-state";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import { clearPriceMetadata, loadPreviousStablecoinsById } from "./shared";
import { applyTrackedAssetOverrides } from "./phase-helpers";
import { buildDexScreenerTargets, runDexScreenerPass, type DexScreenerBatchTarget } from "./enrich-prices-dexscreener-pass";
import { DEX_REFRESH_CACHE_KEY, PRICE_CORROBORATION_OBSERVATIONS_KEY, type PriceCorroborationObservation } from "./price-corroboration-observations";
import { loadFxRatesForPriceBounds } from "./enrich-prices-progress";
import type { PeggedAsset } from "./enrich-prices-shared";

const REFRESH_BUDGET_MS = 45_000;
const MAX_BATCHES = 9; // Existing 45-second envelope / five-second request ceiling.
const BATCH_SIZE = 30;
interface ExactTarget { id: string; chain: string; target: string; observedAt?: number }
interface RefreshState { observations: PriceCorroborationObservation[]; targets: ExactTarget[]; cursor: number }

export interface DexRefreshSummary {
  cohortSize: number;
  resolved: number;
  attemptedBatches: number;
  deferredBatches: number;
  unsupportedAssets: number;
  missingQuotes: number;
  timedOut: boolean;
  cacheWritten: boolean;
  errorClasses: string[];
}

function exactTarget(value: unknown): ExactTarget | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<ExactTarget>;
  return typeof row.id === "string" && typeof row.chain === "string" && typeof row.target === "string"
    ? { id: row.id, chain: row.chain, target: row.target,
      ...(Number.isSafeInteger(row.observedAt) ? { observedAt: row.observedAt } : {}) } : null;
}

async function readState(db: D1Database, signal?: AbortSignal): Promise<RefreshState> {
  const result: RefreshState = { observations: [], targets: [], cursor: 0 };
  for (const key of [DEX_REFRESH_CACHE_KEY, PRICE_CORROBORATION_OBSERVATIONS_KEY]) {
    const row = await getCache(db, key, signal);
    if (!row) continue;
    // Routing hints can outlive quotes, but never enter publication as price evidence.
    let payload: unknown;
    try { payload = JSON.parse(row.value); } catch { throw new Error("Invalid DEX routing state"); }
    if (key === DEX_REFRESH_CACHE_KEY && payload && typeof payload === "object") {
      const state = payload as Partial<RefreshState>;
      if (!Array.isArray(state.targets) || !Array.isArray(state.observations) || !Number.isSafeInteger(state.cursor) || state.cursor! < 0) {
        throw new Error("Invalid DEX routing state");
      }
      if (Number.isSafeInteger(state.cursor) && state.cursor! >= 0) result.cursor = state.cursor!;
      if (Array.isArray(state.targets)) result.targets.push(...state.targets.map(exactTarget).filter((x): x is ExactTarget => x !== null));
    } else if (Array.isArray(payload)) {
      result.targets.push(...payload.filter((x) => x?.source === "dexscreener-exact")
        .map(exactTarget).filter((x): x is ExactTarget => x !== null));
    } else { throw new Error("Invalid DEX routing state"); }
  }
  return result;
}

export function planDexRefresh(assets: PeggedAsset[], hints: ExactTarget[], cursor: number) {
  const targetsById = new Map<string, ExactTarget>();
  for (const hint of [...hints].sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0))) {
    const meta = ACTIVE_META_BY_ID.get(hint.id);
    if (!meta || targetsById.has(hint.id)) continue;
    const reviewed = buildDexScreenerTargets({ id: meta.id, symbol: meta.symbol } as PeggedAsset);
    if (reviewed.some((target) => target.chain === hint.chain && target.address === hint.target)) {
      targetsById.set(hint.id, hint);
    }
  }
  const cohort = assets.filter((asset) => ACTIVE_META_BY_ID.has(asset.id) && (
    !hasPublishableCurrentPrice(asset) || splitCompositePriceSource(asset.priceSource ?? "").includes("dexscreener-exact")
  )).map((asset) => ({ ...asset }));
  applyTrackedAssetOverrides(cohort);
  const chainGroups = new Map<string, DexScreenerBatchTarget[]>();
  let unsupportedAssets = 0;
  for (const [index, asset] of cohort.entries()) {
    // Only reviewed active deployments may validate a persisted hint.
    const meta = ACTIVE_META_BY_ID.get(asset.id)!;
    const reviewed = buildDexScreenerTargets({ ...asset, address: undefined, contracts: meta.contracts ?? [] });
    const hint = targetsById.get(asset.id);
    const target = hint ? reviewed.find((target) => target.chain === hint.chain && target.address === hint.target)! : reviewed[0];
    clearPriceMetadata(asset);
    if (!target) { unsupportedAssets++; continue; }
    if (hint) targetsById.set(asset.id, hint);
    const group = chainGroups.get(target.chain) ?? [];
    group.push({ entry: { asset, index, exactTargets: [target], missingGenerations: 0 }, target });
    chainGroups.set(target.chain, group);
  }
  const allBatches: DexScreenerBatchTarget[][] = [];
  for (const [, targets] of [...chainGroups].sort(([a], [b]) => a.localeCompare(b))) {
    for (let i = 0; i < targets.length; i += BATCH_SIZE) allBatches.push(targets.slice(i, i + BATCH_SIZE));
  }
  const start = allBatches.length > MAX_BATCHES ? cursor % allBatches.length : 0;
  const batches = Array.from({ length: Math.min(MAX_BATCHES, allBatches.length) }, (_, i) => allBatches[(start + i) % allBatches.length]!);
  return { cohort, targetsById, batches, allBatchCount: allBatches.length, unsupportedAssets, start };
}

export async function runPriceDexRefresh(params: { db: D1Database; syncStartSec: number; signal?: AbortSignal }): Promise<DexRefreshSummary> {
  const { previousAssetsById, cacheState } = await loadPreviousStablecoinsById(params.db);
  if (cacheState.state !== "ok") throw new Error("DEX refresh requires valid published stablecoins cache");
  const previous = await readState(params.db, params.signal);
  const fxRates = await loadFxRatesForPriceBounds(params.db);
  const plan = planDexRefresh([...previousAssetsById.values()], previous.targets, previous.cursor);
  const summary: DexRefreshSummary = { cohortSize: plan.cohort.length, resolved: 0, attemptedBatches: 0,
    deferredBatches: plan.allBatchCount, unsupportedAssets: plan.unsupportedAssets, missingQuotes: 0,
    timedOut: false, cacheWritten: false, errorClasses: [] };
  const diagnostics: PricingProviderAttemptDiagnostic[] = [];
  const timeout = createTimeoutSignal({ timeoutMs: REFRESH_BUDGET_MS, timeoutReason: new DOMException("DEX refresh deadline", "TimeoutError"), parentSignal: params.signal });
  let successfulBatches = 0;
  const observations: PriceCorroborationObservation[] = [];
  try {
    const allowed = plan.batches.length === 0 || await isProviderCircuitAllowed({ db: params.db,
      circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES_REFRESH, diagnostics, errorMessage: "DEX refresh circuit open",
      diagnostic: { source: "dexscreener-exact", stage: "fallback", endpoint: "api.dexscreener.com/tokens/v1" } });
    if (!allowed) summary.errorClasses.push("circuit-open");
    else for (const [batchIndex, batch] of plan.batches.entries()) {
      // DexScreener throttles per egress IP; pace consecutive batches inside the
      // lane budget — the sleep rejects as soon as the 45 s deadline passes.
      if (batchIndex > 0) await dsRateLimit(timeout.signal);
      throwIfAborted(timeout.signal);
      summary.attemptedBatches++;
      // Existing executor owns admission, five-second requests, response consumption,
      // provenance and quote selection. Circuit outcome is aggregated once below.
      const result = await runDexScreenerPass(plan.cohort, fxRates, undefined, timeout.signal,
        undefined, undefined, undefined, batch);
      const rows = result.diagnostics ?? [];
      if (rows.some((row) => row.success)) successfulBatches++;
      summary.errorClasses.push(...rows.filter((row) => !row.success).map((row) => row.errorClass ?? "upstream-error"));
      for (const attempt of rows.flatMap((row) => row.assetAttempts ?? [])) {
        if (attempt.result !== "resolved" || !attempt.chain || !attempt.target) continue;
        const asset = plan.cohort.find((asset) => asset.id === attempt.assetId);
        if (!asset || !hasPublishableCurrentPrice(asset) || asset.priceObservedAt == null) continue;
        const target = { id: asset.id, chain: attempt.chain, target: attempt.target, observedAt: asset.priceObservedAt };
        plan.targetsById.set(asset.id, target);
        observations.push({ ...target, source: "dexscreener-exact", price: asset.price!,
          observedAt: asset.priceObservedAt, observedAtMode: asset.priceObservedAtMode ?? null });
      }
      // A 429/Cloudflare-1015 refusal throttles the shared egress IP; issuing the
      // remaining batches this slot would only collect the same refusal. They stay
      // deferred and the recorded class keeps the slot degraded.
      if (rows.some((row) => !row.success && row.errorClass === "rate-limited")) {
        summary.errorClasses.push("rate-limited");
        break;
      }
    }
  } catch (error) {
    rethrowIfAborted(error, params.signal);
    if (!timeout.isTimedOut()) throw error;
    summary.timedOut = true;
    summary.errorClasses.push("timeout");
  } finally { timeout.dispose(); }
  throwIfAborted(params.signal);
  summary.resolved = observations.length;
  summary.deferredBatches = Math.max(0, plan.allBatchCount - summary.attemptedBatches);
  summary.missingQuotes = Math.max(0, plan.cohort.length - summary.unsupportedAssets - observations.length);
  summary.errorClasses = [...new Set(summary.errorClasses)];
  await recordProviderOutcomeSafe({ db: params.db, circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES_REFRESH,
    attempted: summary.attemptedBatches, successful: successfulBatches });
  const written = await setCacheIfNewer(params.db, DEX_REFRESH_CACHE_KEY, JSON.stringify({
    observations, targets: [...plan.targetsById.values()], cursor: plan.allBatchCount
      ? (plan.start + summary.attemptedBatches) % plan.allBatchCount : 0,
  } satisfies RefreshState), params.syncStartSec, params.signal);
  summary.cacheWritten = written.written;
  return summary;
}

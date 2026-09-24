import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { throwIfAborted, rethrowIfAborted } from "../../lib/abort";
import { getCache, setCacheIfNewer } from "../../lib/db-cache";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { recordOutcomeDecision, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { dsRateLimit } from "../../lib/dexscreener";
import { isProviderCircuitAllowed, recoverProviderOnNoCandidates, recordProviderOutcomeSafe } from "../../lib/pricing-provider-lifecycle";
import { hasPublishableCurrentPrice } from "../../lib/price-publication-state";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import {
  buildAddressPriceTargetsByProvider,
  collectAddressPriceProviderQuotes,
  resolveEnabledAddressPriceProviders,
  type AddressPriceProviderRuntimeConfig,
} from "../../lib/address-price-providers";
import { clearPriceMetadata, loadPreviousStablecoinsById } from "./shared";
import { applyTrackedAssetOverrides } from "./phase-helpers";
import { buildDexScreenerTargets, runDexScreenerPass, type DexScreenerBatchTarget } from "./enrich-prices-dexscreener-pass";
import { DEX_REFRESH_CACHE_KEY, PRICE_CORROBORATION_OBSERVATIONS_KEY, type PriceCorroborationObservation } from "./price-corroboration-observations";
import { loadFxRatesForPriceBounds } from "./enrich-prices-progress";
import type { PeggedAsset } from "./enrich-prices-shared";
import { resolveStablecoinPriceGapReviews } from "../../lib/stablecoin-publication-coverage";

const REFRESH_BUDGET_MS = 45_000;
// 45-second envelope / (five-second request ceiling + 1.1-second DexScreener pacing).
const MAX_BATCHES = 7;
const BATCH_SIZE = 30;
// CoinGecko Onchain answers this cohort with at most five paced requests, so a
// 25-second window bounds the coverage lane inside the slot even when a request
// stalls: the provider starts another batch only while that deadline holds, and
// the DEX lane keeps its own independent envelope.
const ADDRESS_REFRESH_BUDGET_MS = 25_000;
interface ExactTarget { id: string; chain: string; target: string; observedAt?: number }
interface RefreshState {
  observations: PriceCorroborationObservation[];
  targets: ExactTarget[];
  cursor: number;
  /** Last deployment each asset's exact-address quote came from. */
  addressTargets: ExactTarget[];
}

export interface DexRefreshSummary {
  cohortSize: number;
  resolved: number;
  attemptedBatches: number;
  deferredBatches: number;
  unsupportedAssets: number;
  missingQuotes: number;
  /** Missing-price assets skipped because a valid price-gap review covers them. */
  acknowledgedGapsSkipped: number;
  /** Attempted cohort assets whose exact route resolved in an earlier slot. */
  hintedAttempted: number;
  hintedResolved: number;
  timedOut: boolean;
  cacheWritten: boolean;
  errorClasses: string[];
  addressRefresh: AddressRefreshSummary;
}

/**
 * Coverage lane for `coingecko-onchain-address`, the only exact-address
 * provider left enabled and the only live lane for assets whose market exists
 * on chain but not in an aggregator list. Its quotes live for one publication
 * window, so the same fifteen-minute slot that refreshes exact DEX routes also
 * re-observes the rows this lane prices (and the rows still missing a price).
 * Every admission guard stays with the provider; this lane only decides which
 * rows are worth a request and how the result is staged.
 */
export interface AddressRefreshSummary {
  /** False when the provider is not enabled in this environment. */
  enabled: boolean;
  /** Distinct assets with at least one provider-supported deployment. */
  cohortSize: number;
  /** Deployment targets handed to the provider for this slot. */
  targetCount: number;
  /** Distinct rows that produced at least one quote this slot. */
  resolved: number;
  attemptedRequests: number;
  successfulRequests: number;
  /** Deployment targets left unqueried by the provider's request cap. */
  cappedTargets: number;
  failureClasses: string[];
  circuitOpen: boolean;
  timedOut: boolean;
}

function exactTarget(value: unknown): ExactTarget | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<ExactTarget>;
  return typeof row.id === "string" && typeof row.chain === "string" && typeof row.target === "string"
    ? { id: row.id, chain: row.chain, target: row.target,
      ...(Number.isSafeInteger(row.observedAt) ? { observedAt: row.observedAt } : {}) } : null;
}

async function readState(db: D1Database, signal?: AbortSignal): Promise<RefreshState> {
  const result: RefreshState = { observations: [], targets: [], cursor: 0, addressTargets: [] };
  for (const key of [DEX_REFRESH_CACHE_KEY, PRICE_CORROBORATION_OBSERVATIONS_KEY]) {
    const row = await getCache(db, key, signal);
    if (!row) continue;
    // Routing hints can outlive quotes, but never enter publication as price evidence.
    let payload: unknown;
    try { payload = JSON.parse(row.value); } catch { throw new Error("Invalid DEX routing state"); }
    if (key === DEX_REFRESH_CACHE_KEY && payload && typeof payload === "object") {
      const state = payload as Partial<RefreshState>;
      if (!Array.isArray(state.targets) || !Array.isArray(state.observations) || !Number.isSafeInteger(state.cursor) || state.cursor! < 0
        || (state.addressTargets !== undefined && !Array.isArray(state.addressTargets))) {
        throw new Error("Invalid DEX routing state");
      }
      if (Number.isSafeInteger(state.cursor) && state.cursor! >= 0) result.cursor = state.cursor!;
      if (Array.isArray(state.targets)) result.targets.push(...state.targets.map(exactTarget).filter((x): x is ExactTarget => x !== null));
      if (Array.isArray(state.addressTargets)) {
        result.addressTargets.push(...state.addressTargets.map(exactTarget).filter((x): x is ExactTarget => x !== null));
      }
    } else if (Array.isArray(payload)) {
      result.targets.push(...payload.filter((x) => x?.source === "dexscreener-exact")
        .map(exactTarget).filter((x): x is ExactTarget => x !== null));
    } else { throw new Error("Invalid DEX routing state"); }
  }
  return result;
}

/**
 * `reviewedGapIds` are missing-price assets under a valid price-gap review
 * (reviewed as having no admissible market). The narrow refresh skips them;
 * the hourly corroboration passes still probe them, so a returning market is
 * still discovered.
 */
export function planDexRefresh(
  assets: PeggedAsset[],
  hints: ExactTarget[],
  cursor: number,
  reviewedGapIds: ReadonlySet<string> = new Set(),
) {
  const targetsById = new Map<string, ExactTarget>();
  for (const hint of [...hints].sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0))) {
    const meta = ACTIVE_META_BY_ID.get(hint.id);
    if (!meta || targetsById.has(hint.id)) continue;
    const reviewed = buildDexScreenerTargets({ id: meta.id, symbol: meta.symbol } as PeggedAsset);
    if (reviewed.some((target) => target.chain === hint.chain && target.address === hint.target)) {
      targetsById.set(hint.id, hint);
    }
  }
  let acknowledgedGapsSkipped = 0;
  const cohort = assets.filter((asset) => {
    if (!ACTIVE_META_BY_ID.has(asset.id)) return false;
    if (splitCompositePriceSource(asset.priceSource ?? "").includes("dexscreener-exact")) return true;
    if (hasPublishableCurrentPrice(asset)) return false;
    if (reviewedGapIds.has(asset.id)) {
      acknowledgedGapsSkipped++;
      return false;
    }
    return true;
  }).map((asset) => ({ ...asset }));
  applyTrackedAssetOverrides(cohort);
  const chainGroups = new Map<string, DexScreenerBatchTarget[]>();
  let unsupportedAssets = 0;
  const hintedIds = new Set<string>();
  for (const [index, asset] of cohort.entries()) {
    // Only reviewed active deployments may validate a persisted hint.
    const meta = ACTIVE_META_BY_ID.get(asset.id)!;
    const reviewed = buildDexScreenerTargets({ ...asset, address: undefined, contracts: meta.contracts ?? [] });
    const hint = targetsById.get(asset.id);
    const target = hint ? reviewed.find((target) => target.chain === hint.chain && target.address === hint.target)! : reviewed[0];
    clearPriceMetadata(asset);
    if (!target) { unsupportedAssets++; continue; }
    if (hint) {
      targetsById.set(asset.id, hint);
      hintedIds.add(asset.id);
    }
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
  return { cohort, targetsById, hintedIds, batches, allBatchCount: allBatches.length, unsupportedAssets, acknowledgedGapsSkipped, start };
}

async function runAddressRefresh(params: {
  db: D1Database;
  syncStartSec: number;
  signal?: AbortSignal;
  addressProvider?: AddressPriceProviderRuntimeConfig;
  previousAssetsById: Map<string, PeggedAsset>;
  reviewedGapIds: ReadonlySet<string>;
  hints: readonly ExactTarget[];
}): Promise<{ summary: AddressRefreshSummary; observations: PriceCorroborationObservation[]; targets: ExactTarget[] }> {
  const summary: AddressRefreshSummary = { enabled: false, cohortSize: 0, targetCount: 0, resolved: 0,
    attemptedRequests: 0, successfulRequests: 0, cappedTargets: 0, failureClasses: [], circuitOpen: false, timedOut: false };
  const observations: PriceCorroborationObservation[] = [];
  const resolvedTargets = new Map<string, ExactTarget>();
  const none = { summary, observations, targets: [] as ExactTarget[] };
  const providers = resolveEnabledAddressPriceProviders(params.addressProvider);
  if (providers.length === 0 || !params.addressProvider) return none;
  summary.enabled = true;
  const deploymentHints = new Map(params.hints.map((hint) => [hint.id, { chain: hint.chain, address: hint.target }] as const));
  const targetsByProvider = buildAddressPriceTargetsByProvider({
    assets: [...params.previousAssetsById.values()]
      .filter((asset) => ACTIVE_META_BY_ID.has(asset.id) && !params.reviewedGapIds.has(asset.id)),
    previousAssetsById: params.previousAssetsById,
    providers,
    nowSec: params.syncStartSec,
    cohort: "coverage-refresh",
    deploymentHints,
  });
  const targets = targetsByProvider.get("coingecko-onchain-address") ?? [];
  summary.targetCount = targets.length;
  summary.cohortSize = new Set(targets.map((target) => target.stablecoinId)).size;
  // No targets means nothing this lane can price; requesting anyway would spend
  // the request cap and record a meaningless provider outcome.
  if (targets.length === 0) return none;
  const sourceAllowed = { "coingecko-onchain-address": await shouldAttemptFetch(params.db, CIRCUIT_SOURCE.CG_ONCHAIN) };
  if (!sourceAllowed["coingecko-onchain-address"]) {
    summary.circuitOpen = true;
    return none;
  }
  const timeout = createTimeoutSignal({ timeoutMs: ADDRESS_REFRESH_BUDGET_MS,
    timeoutReason: new DOMException("Address refresh deadline", "TimeoutError"), parentSignal: params.signal });
  try {
    const result = await collectAddressPriceProviderQuotes({
      targetsByProvider, providers, sourceAllowed, config: params.addressProvider,
      signal: timeout.signal, nowSec: Math.floor(Date.now() / 1_000), budgetMs: ADDRESS_REFRESH_BUDGET_MS,
    });
    summary.attemptedRequests = result.attemptedRequests;
    summary.successfulRequests = result.successfulRequests;
    summary.cappedTargets = result.diagnostics
      .find((diagnostic) => diagnostic.errorClass === "cap")?.candidateCount ?? 0;
    // `status !== 404` mirrors the provider-outcome rule: an unindexed
    // deployment is coverage information, not an unhealthy provider.
    summary.failureClasses = [...new Set(result.diagnostics
      .filter((diagnostic) => !diagnostic.success && diagnostic.status !== 404)
      .map((diagnostic) => diagnostic.errorClass ?? "upstream-error"))];
    for (const [provider, outcome] of result.providerOutcomes) {
      if (provider === "coingecko-onchain-address") {
        await recordOutcomeDecision(params.db, CIRCUIT_SOURCE.CG_ONCHAIN, outcome);
      }
    }
    for (const [stablecoinId, quotes] of result.quotesByStablecoinId) {
      for (const quote of quotes) {
        observations.push({ id: stablecoinId, source: quote.source, chain: quote.chain, target: quote.address,
          price: quote.priceUsd, observedAt: quote.observedAt, observedAtMode: quote.observedAtMode ?? null });
        resolvedTargets.set(stablecoinId, { id: stablecoinId, chain: quote.chain, target: quote.address,
          ...(quote.observedAt == null ? {} : { observedAt: quote.observedAt }) });
      }
    }
    summary.resolved = new Set(observations.map((observation) => observation.id)).size;
  } catch (error) {
    rethrowIfAborted(error, params.signal);
    // A wall-clock abort is this lane's own deadline, not a provider verdict:
    // the circuit stays untouched and the slot degrades through `timedOut`.
    if (!timeout.isTimedOut()) throw error;
    summary.timedOut = true;
  } finally { timeout.dispose(); }
  return { summary, observations, targets: [...resolvedTargets.values()] };
}

export async function runPriceDexRefresh(params: {
  db: D1Database;
  syncStartSec: number;
  signal?: AbortSignal;
  addressProvider?: AddressPriceProviderRuntimeConfig;
}): Promise<DexRefreshSummary> {
  const { previousAssetsById, cacheState } = await loadPreviousStablecoinsById(params.db);
  if (cacheState.state !== "ok") throw new Error("DEX refresh requires valid published stablecoins cache");
  const previous = await readState(params.db, params.signal);
  const fxRates = await loadFxRatesForPriceBounds(params.db);
  const reviewedGapIds = new Set(
    resolveStablecoinPriceGapReviews([...ACTIVE_META_BY_ID.keys()], params.syncStartSec).activeById.keys(),
  );
  const plan = planDexRefresh([...previousAssetsById.values()], previous.targets, previous.cursor, reviewedGapIds);
  // Coverage first: the address lane is the only live source for rows with no
  // aggregator market, and a throttled DexScreener crawl can consume the whole
  // slot envelope. Its own deadline keeps it from delaying the DEX lane.
  const address = await runAddressRefresh({
    db: params.db,
    syncStartSec: params.syncStartSec,
    signal: params.signal,
    addressProvider: params.addressProvider,
    previousAssetsById,
    reviewedGapIds,
    hints: previous.addressTargets,
  });
  const addressObservations = address.observations;
  const addressTargets = new Map(previous.addressTargets.map((target) => [target.id, target] as const));
  for (const target of address.targets) addressTargets.set(target.id, target);
  const summary: DexRefreshSummary = { cohortSize: plan.cohort.length, resolved: 0, attemptedBatches: 0,
    deferredBatches: plan.allBatchCount, unsupportedAssets: plan.unsupportedAssets, missingQuotes: 0,
    acknowledgedGapsSkipped: plan.acknowledgedGapsSkipped,
    hintedAttempted: 0, hintedResolved: 0, timedOut: false, cacheWritten: false, errorClasses: [],
    addressRefresh: address.summary };
  const diagnostics: PricingProviderAttemptDiagnostic[] = [];
  const timeout = createTimeoutSignal({ timeoutMs: REFRESH_BUDGET_MS, timeoutReason: new DOMException("DEX refresh deadline", "TimeoutError"), parentSignal: params.signal });
  let successfulBatches = 0;
  const observations: PriceCorroborationObservation[] = [];
  try {
    // An empty batch plan is not a provider verdict, so it must not consume the
    // breaker's probe or be recorded as one. Mirror the exact pass's documented
    // no-candidate recovery instead: a non-closed breaker is closed without an
    // upstream request, because no eligible DexScreener work remains this slot.
    // Without it a temporarily empty cohort pins the refresh circuit open
    // indefinitely (nothing else ever records an outcome for this source).
    const hasBatches = plan.batches.length > 0;
    if (!hasBatches) {
      await recoverProviderOnNoCandidates({
        db: params.db,
        circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES_REFRESH,
        diagnostic: { source: "dexscreener-exact", stage: "no-candidates", endpoint: "api.dexscreener.com/tokens/v1" },
        diagnostics,
      });
    }
    const allowed = !hasBatches || await isProviderCircuitAllowed({ db: params.db,
      circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES_REFRESH, diagnostics, errorMessage: "DEX refresh circuit open",
      diagnostic: { source: "dexscreener-exact", stage: "fallback", endpoint: "api.dexscreener.com/tokens/v1" } });
    if (!allowed) summary.errorClasses.push("circuit-open");
    else for (const [batchIndex, batch] of plan.batches.entries()) {
      // DexScreener throttles per egress IP; pace consecutive batches inside the
      // lane budget — the sleep rejects as soon as the 45 s deadline passes.
      if (batchIndex > 0) await dsRateLimit(timeout.signal);
      throwIfAborted(timeout.signal);
      // The existing executor owns admission, five-second requests, response
      // consumption, provenance and quote selection; the circuit outcome is
      // aggregated once below. Count a batch as attempted only once its
      // outcome is definitive: a batch whose fetch this lane's own deadline
      // aborted never reached a provider verdict, and counting it would
      // record a DexScreener failure for a local wall-clock abort while the
      // provider may be healthy. The aborted batch stays deferred and the
      // slot still degrades via `timedOut`/`deferredBatches`.
      const result = await runDexScreenerPass(plan.cohort, fxRates, undefined, timeout.signal,
        undefined, undefined, undefined, batch);
      summary.attemptedBatches++;
      summary.hintedAttempted += batch.filter(({ entry }) => plan.hintedIds.has(entry.asset.id)).length;
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
  summary.hintedResolved = observations.filter((observation) => plan.hintedIds.has(observation.id)).length;
  summary.errorClasses = [...new Set(summary.errorClasses)];
  await recordProviderOutcomeSafe({ db: params.db, circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES_REFRESH,
    attempted: summary.attemptedBatches, successful: successfulBatches });
  const written = await setCacheIfNewer(params.db, DEX_REFRESH_CACHE_KEY, JSON.stringify({
    observations: [...addressObservations, ...observations],
    targets: [...plan.targetsById.values()],
    // Hints outlive the slots that produced them but never a delisting.
    addressTargets: [...addressTargets.values()].filter((target) => previousAssetsById.has(target.id)),
    cursor: plan.allBatchCount
      ? (plan.start + summary.attemptedBatches) % plan.allBatchCount : 0,
  } satisfies RefreshState), params.syncStartSec, params.signal);
  summary.cacheWritten = written.written;
  summary.addressRefresh = address.summary;
  return summary;
}

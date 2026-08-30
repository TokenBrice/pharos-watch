import { logWorkerEventArgs } from "../structured-log";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types/core";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { rethrowIfAborted } from "../abort";
import { recordOutcomeSafe, shouldAttemptFetch } from "../circuit-breaker";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS } from "../stablecoin-publication-coverage";
import {
  appendPricingAssetAttempts,
  createPricingAssetAttempt,
  errorClassFor,
  type PricingAssetAttemptRecord,
} from "../pricing-provider-diagnostics";
import type { PriceValidationReferences } from "../price-validation";
import { azndCurvePoolProvider } from "./aznd-curve-pool";
import { capCusdProvider } from "./cap-cusd";
import { erc4626NavProvider, previewRedeemProvider } from "./erc4626-nav";
import {
  CACHED_VAULT_RATE_SOURCE,
  type CurrentPriceOverride,
  type HistoricalPriceContext,
  type HistoricalPriceResolution,
  type LivePriceContext,
  type PriceSourceProvider,
  getRegistryLivePriceDiagnosticTarget,
  isValidatedLivePriceNoQuote,
} from "./helpers";
import { idleCdoTrancheProvider } from "./idle-cdo-tranche";
import { inheritedTrackedPriceProvider } from "./inherited-tracked";
import { iusdInfinifiProvider } from "./infinifi-iusd";
import { jusdStablecoinBridgeProvider } from "./jusd-stablecoin-bridge";
import { readVaultRateCache, writeVaultRateCache } from "./rate-cache";
import { kavaUsdxPricefeedProvider } from "./kava-pricefeed";
import { protocolParProvider } from "./protocol-par";

export type {
  CurrentPriceOverride,
  HistoricalPriceContext,
  HistoricalPricePoint,
  HistoricalPriceResolution,
  HistoricalSupplySnapshot,
} from "./helpers";
export { resolveVaultNavSupplyPrice } from "./erc4626-nav";

const AUTHORITATIVE_PRICE_PROVIDERS: PriceSourceProvider[] = [
  capCusdProvider,
  iusdInfinifiProvider,
  inheritedTrackedPriceProvider,
  protocolParProvider,
  azndCurvePoolProvider,
  kavaUsdxPricefeedProvider,
  jusdStablecoinBridgeProvider,
  erc4626NavProvider,
  previewRedeemProvider,
  idleCdoTrancheProvider,
];

export const AUTHORITATIVE_LIVE_OVERRIDE_BUDGET_MS = 10_000;
export const AUTHORITATIVE_LIVE_CANDIDATE_TIMEOUT_MS = 2_500;

export interface AuthoritativeLivePriceOverrideStats {
  budgetMs: number;
  candidateCount: number;
  attemptedCount: number;
  successCount: number;
  failedCount: number;
  emptyCount: number;
  skippedCircuitOpen: number;
  skippedBudget: number;
  cachedRateFallbacks: number;
  timedOut: boolean;
  assetAttempts: PricingAssetAttemptRecord[];
}

const MAX_AUTHORITATIVE_ASSET_ATTEMPTS = 512;

type LivePriceProvider = PriceSourceProvider & {
  fetchLivePrice: NonNullable<PriceSourceProvider["fetchLivePrice"]>;
};

export interface AuthoritativeLivePriceCandidate {
  asset: PeggedAsset;
  provider: LivePriceProvider;
  originalIndex: number;
  previousMissingGenerations: number;
  alertEligibleMissing: boolean;
}

function getProviderLivePriority(provider: PriceSourceProvider): number {
  const priority = provider.livePriority;
  return typeof priority === "number" && Number.isFinite(priority) ? priority : 10;
}

function hasUsableLivePrice(asset: PeggedAsset): boolean {
  return hasPublishableCurrentPrice(asset);
}

function getProviderLiveTimeoutMs(provider: PriceSourceProvider): number {
  const timeoutMs = provider.liveTimeoutMs;
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : AUTHORITATIVE_LIVE_CANDIDATE_TIMEOUT_MS;
}

function shouldRecordLiveCircuitFailure(provider: PriceSourceProvider, asset: PeggedAsset): boolean {
  return !provider.recordLiveCircuitFailuresOnlyWhenMissing || !hasUsableLivePrice(asset);
}

export function prioritizeAuthoritativeLivePriceCandidates<T extends AuthoritativeLivePriceCandidate>(
  candidates: readonly T[],
): T[] {
  const interleaveProviders = (partition: readonly T[]): T[] => {
    const grouped = new Map<LivePriceProvider, T[]>();
    for (const candidate of partition) {
      const group = grouped.get(candidate.provider) ?? [];
      group.push(candidate);
      grouped.set(candidate.provider, group);
    }

    const groups = [...grouped.entries()]
      .map(([provider, entries]) => ({
        provider,
        entries: [...entries].sort((a, b) => a.originalIndex - b.originalIndex),
      }))
      .sort((a, b) => {
        const priorityDelta = getProviderLivePriority(a.provider) - getProviderLivePriority(b.provider);
        if (priorityDelta !== 0) return priorityDelta;
        return (a.entries[0]?.originalIndex ?? 0) - (b.entries[0]?.originalIndex ?? 0);
      });

    const prioritized: T[] = [];
    for (let tierStart = 0; tierStart < groups.length;) {
      const firstTierGroup = groups[tierStart];
      if (!firstTierGroup) break;
      const tierPriority = getProviderLivePriority(firstTierGroup.provider);
      let tierEnd = tierStart + 1;
      while (tierEnd < groups.length) {
        const nextGroup = groups[tierEnd];
        if (!nextGroup || getProviderLivePriority(nextGroup.provider) !== tierPriority) break;
        tierEnd += 1;
      }

      const tierGroups = groups.slice(tierStart, tierEnd);
      for (let round = 0; ; round += 1) {
        let added = false;
        for (const group of tierGroups) {
          const candidate = group.entries[round];
          if (!candidate) continue;
          prioritized.push(candidate);
          added = true;
        }
        if (!added) break;
      }
      tierStart = tierEnd;
    }
    return prioritized;
  };

  const circuitBacked = candidates.filter((candidate) => Boolean(candidate.provider.liveCircuitSource));
  const ordinary = candidates.filter((candidate) => !candidate.provider.liveCircuitSource);
  const alertEligibleMissing = (partition: readonly T[]) => partition.filter((candidate) =>
    !hasUsableLivePrice(candidate.asset) && candidate.alertEligibleMissing === true
  );
  const missing = (partition: readonly T[]) => partition.filter((candidate) =>
    !hasUsableLivePrice(candidate.asset) && candidate.alertEligibleMissing !== true
  );
  const priced = (partition: readonly T[]) => partition.filter((candidate) => hasUsableLivePrice(candidate.asset));
  return [
    ...interleaveProviders(alertEligibleMissing(circuitBacked)),
    ...interleaveProviders(alertEligibleMissing(ordinary)),
    ...interleaveProviders(missing(circuitBacked)),
    ...interleaveProviders(missing(ordinary)),
    ...interleaveProviders(priced(circuitBacked)),
    ...interleaveProviders(priced(ordinary)),
  ];
}

export function createAuthoritativeLivePriceOverrideStats(
  budgetMs = AUTHORITATIVE_LIVE_OVERRIDE_BUDGET_MS,
): AuthoritativeLivePriceOverrideStats {
  return {
    budgetMs,
    candidateCount: 0,
    attemptedCount: 0,
    successCount: 0,
    failedCount: 0,
    emptyCount: 0,
    skippedCircuitOpen: 0,
    skippedBudget: 0,
    cachedRateFallbacks: 0,
    timedOut: false,
    assetAttempts: [],
  };
}

export interface AuthoritativeLivePriceOverrideOptions {
  db?: D1Database;
  wallClockBudgetMs?: number;
  stats?: AuthoritativeLivePriceOverrideStats;
  maxProviderLivePriority?: number;
  previousMissingGenerationsById?: ReadonlyMap<string, number>;
}

function applyOverrideToLiveContext(context: LivePriceContext, assetId: string, override: CurrentPriceOverride): void {
  const asset = context.assetsById.get(assetId);
  if (!asset) return;
  const nowSec = Math.floor(Date.now() / 1000);
  asset.price = override.price;
  asset.priceSource = override.source;
  asset.priceSelectedSource = override.source;
  asset.priceConfidence = override.confidence;
  asset.priceObservedAt = override.observedAt ?? nowSec;
  asset.priceObservedAtMode = override.observedAtMode ?? "local_fetch";
  asset.priceUpdatedAt = override.observedAt ?? nowSec;
  asset.priceSyncedAt = nowSec;
  asset.agreeSources = [override.source];
  asset.consensusSources = [override.source];
}

function readLastUntrustedParent(context: LivePriceContext): { parentId: string; reason: string } | null {
  return context.lastUntrustedParent ?? null;
}

async function shouldAttemptLiveFetch(
  db: D1Database,
  source: string,
  circuitAttempts: Map<string, boolean>,
): Promise<boolean> {
  const memoized = circuitAttempts.get(source);
  if (typeof memoized === "boolean") return memoized;
  const allowed = await shouldAttemptFetch(db, source);
  circuitAttempts.set(source, allowed);
  return allowed;
}

export async function fetchAuthoritativeLivePriceOverrides(
  assets: PeggedAsset[],
  signal?: AbortSignal,
  validationReferences?: PriceValidationReferences,
  options?: AuthoritativeLivePriceOverrideOptions,
): Promise<Map<string, CurrentPriceOverride>> {
  const results = new Map<string, CurrentPriceOverride>();
  const liveContext: LivePriceContext = {
    assetsById: new Map(assets.map((asset) => [asset.id, { ...asset }])),
    validationReferences,
    vaultRateCache: options?.db
      ? await readVaultRateCache(options.db, Math.floor(Date.now() / 1000))
      : undefined,
    vaultRateWrites: new Map(),
  };
  const candidates = assets
    .filter((asset) => ACTIVE_IDS.has(asset.id))
    .map((asset, originalIndex) => {
      const previousMissingGenerations = options?.previousMissingGenerationsById?.get(asset.id) ?? 0;
      const alertEligibleMissing =
        !hasUsableLivePrice(asset) &&
        previousMissingGenerations + 1 >= ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS;
      return {
        asset,
        originalIndex,
        previousMissingGenerations,
        alertEligibleMissing,
        provider: AUTHORITATIVE_PRICE_PROVIDERS.find((candidate) => candidate.matches(asset.id)),
      };
    })
    .filter(
      (entry): entry is AuthoritativeLivePriceCandidate =>
        typeof entry.provider?.fetchLivePrice === "function" &&
        !(entry.provider.liveMissingOnly && hasUsableLivePrice(entry.asset)) &&
        (options?.maxProviderLivePriority == null ||
          getProviderLivePriority(entry.provider) <= options.maxProviderLivePriority),
    );
  const prioritizedCandidates = prioritizeAuthoritativeLivePriceCandidates(candidates);
  const budgetMs = options?.wallClockBudgetMs ?? AUTHORITATIVE_LIVE_OVERRIDE_BUDGET_MS;
  const stats = options?.stats;
  if (stats) {
    stats.budgetMs = budgetMs;
    stats.candidateCount += prioritizedCandidates.length;
  }
  const budgetSignal = budgetMs > 0 ? AbortSignal.timeout(budgetMs) : undefined;
  const liveSignal = signal && budgetSignal ? AbortSignal.any([signal, budgetSignal]) : (budgetSignal ?? signal);
  const circuitAttempts = new Map<string, boolean>();

  const recordAttempt = (
    asset: PeggedAsset,
    provider: LivePriceProvider,
    input: Omit<
      Parameters<typeof createPricingAssetAttempt>[0],
      "assetId" | "adapter" | "source" | "chain" | "target" | "replaySafe"
    > & {
      source?: string;
    },
  ): void => {
    if (!stats) return;
    const target = getRegistryLivePriceDiagnosticTarget(asset.id);
    appendPricingAssetAttempts(
      stats.assetAttempts,
      [
        createPricingAssetAttempt({
          assetId: asset.id,
          adapter: provider.source,
          source: input.source ?? provider.source,
          ...(target ?? {}),
          ...input,
        }),
      ],
      MAX_AUTHORITATIVE_ASSET_ATTEMPTS,
    );
  };

  const recordSkippedBudget = (startIndex: number): void => {
    const candidateAt = Math.floor(Date.now() / 1000);
    for (const candidate of prioritizedCandidates.slice(startIndex)) {
      recordAttempt(candidate.asset, candidate.provider, {
        state: "skipped",
        skipReason: "budget",
        rejectionClass: "timeout",
        candidateAt,
      });
    }
  };

  for (let index = 0; index < prioritizedCandidates.length; index += 1) {
    if (budgetSignal?.aborted) {
      if (stats) {
        stats.timedOut = true;
        stats.skippedBudget += prioritizedCandidates.length - index;
      }
      recordSkippedBudget(index);
      break;
    }

    const { asset, provider } = prioritizedCandidates[index];
    const candidateAt = Math.floor(Date.now() / 1000);
    const circuitSource = provider.liveCircuitSource;
    if (circuitSource && options?.db) {
      const allowed = await shouldAttemptLiveFetch(options.db, circuitSource, circuitAttempts);
      if (!allowed) {
        if (stats) stats.skippedCircuitOpen += 1;
        recordAttempt(asset, provider, {
          state: "skipped",
          skipReason: "circuit-open",
          rejectionClass: "blocked",
          candidateAt,
        });
        continue;
      }
    }
    if (stats) stats.attemptedCount += 1;

    const providerTimeoutMs = getProviderLiveTimeoutMs(provider);
    const usesCandidateTimeout = providerTimeoutMs > 0 && (budgetMs <= 0 || providerTimeoutMs < budgetMs);
    const candidateTimeout = usesCandidateTimeout
      ? createTimeoutSignal({
          timeoutMs: providerTimeoutMs,
          timeoutReason: "authoritative live price candidate timed out",
          parentSignal: liveSignal,
        })
      : null;
    const candidateSignal = candidateTimeout?.signal ?? liveSignal;

    liveContext.lastUntrustedParent = null;
    try {
      const liveResult = await provider.fetchLivePrice(asset, liveContext, candidateSignal);
      const override = isValidatedLivePriceNoQuote(liveResult) ? null : liveResult;
      if (override) {
        results.set(asset.id, override);
        applyOverrideToLiveContext(liveContext, asset.id, override);
        if (stats) {
          stats.successCount += 1;
          if (override.source === CACHED_VAULT_RATE_SOURCE) stats.cachedRateFallbacks += 1;
        }
        recordAttempt(asset, provider, {
          state: "attempted",
          result: "resolved",
          source: override.source,
          candidateAt,
          observedAt: override.observedAt,
        });
        if (circuitSource && options?.db) {
          await recordOutcomeSafe(options.db, circuitSource, true);
          circuitAttempts.delete(circuitSource);
        }
      } else {
        if (stats) stats.emptyCount += 1;
        const untrustedParent = readLastUntrustedParent(liveContext);
        recordAttempt(asset, provider, {
          state: "attempted",
          result: "empty",
          rejectionClass: untrustedParent
            ? `untrusted-parent:${untrustedParent.parentId}:${untrustedParent.reason}`
            : "missing-quote",
          candidateAt,
        });
        const explicitCircuitOutcome = isValidatedLivePriceNoQuote(liveResult)
          ? liveResult.circuitOutcome
          : null;
        if (circuitSource && options?.db && explicitCircuitOutcome === "success") {
          await recordOutcomeSafe(options.db, circuitSource, true);
          circuitAttempts.delete(circuitSource);
        } else if (
          circuitSource &&
          options?.db &&
          provider.recordNullLiveResultAsCircuitFailure &&
          shouldRecordLiveCircuitFailure(provider, asset)
        ) {
          await recordOutcomeSafe(options.db, circuitSource, false);
          circuitAttempts.delete(circuitSource);
        }
      }
    } catch (error) {
      rethrowIfAborted(error, signal);
      if (budgetSignal?.aborted && !signal?.aborted) {
        if (stats) {
          stats.timedOut = true;
          stats.skippedBudget += prioritizedCandidates.length - index - 1;
        }
        recordAttempt(asset, provider, {
          state: "attempted",
          result: "failed",
          rejectionClass: "timeout",
          candidateAt,
        });
        if (circuitSource && options?.db && shouldRecordLiveCircuitFailure(provider, asset)) {
          await recordOutcomeSafe(options.db, circuitSource, false);
          circuitAttempts.delete(circuitSource);
        }
        recordSkippedBudget(index + 1);
        logWorkerEventArgs("lib", "warn", `[authoritative-price-sources] live override budget exhausted after ${budgetMs}ms`);
        break;
      }
      if (candidateTimeout?.isTimedOut() && !signal?.aborted) {
        if (stats) stats.failedCount += 1;
        recordAttempt(asset, provider, {
          state: "attempted",
          result: "failed",
          rejectionClass: "timeout",
          candidateAt,
        });
        logWorkerEventArgs("lib", "warn",
          `[authoritative-price-sources] ${asset.id} live override exceeded ${providerTimeoutMs}ms candidate budget`,
        );
        continue;
      }
      if (stats) stats.failedCount += 1;
      recordAttempt(asset, provider, {
        state: "attempted",
        result: "failed",
        rejectionClass: errorClassFor(error),
        candidateAt,
      });
      if (circuitSource && options?.db && shouldRecordLiveCircuitFailure(provider, asset)) {
        await recordOutcomeSafe(options.db, circuitSource, false);
        circuitAttempts.delete(circuitSource);
      }
      logWorkerEventArgs("lib", "warn", `[authoritative-price-sources] ${asset.id} live override failed:`, error);
    } finally {
      candidateTimeout?.dispose();
    }
  }

  if (options?.db && liveContext.vaultRateWrites && liveContext.vaultRateWrites.size > 0) {
    await writeVaultRateCache(options.db, liveContext.vaultRateWrites, Math.floor(Date.now() / 1000));
  }

  return results;
}

export async function fetchAuthoritativeHistoricalPriceSeries(
  meta: StablecoinMeta,
  context: HistoricalPriceContext,
): Promise<HistoricalPriceResolution> {
  const provider = AUTHORITATIVE_PRICE_PROVIDERS.find(
    (candidate) => candidate.matches(meta.id) && (candidate.matchesHistoricalPrices?.(meta.id) ?? true),
  );
  if (!provider?.fetchHistoricalPrices) {
    return { matched: false, source: null, prices: null };
  }

  try {
    const prices = await provider.fetchHistoricalPrices(meta, context);
    return {
      matched: true,
      source: provider.source,
      prices,
    };
  } catch (error) {
    rethrowIfAborted(error, context.signal);
    logWorkerEventArgs("lib", "warn", `[authoritative-price-sources] ${meta.id} historical source failed:`, error);
    return {
      matched: true,
      source: provider.source,
      prices: null,
    };
  }
}

import type { StablecoinMeta } from "@shared/types/core";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { rethrowIfAborted } from "../abort";
import { recordOutcomeSafe, shouldAttemptFetch } from "../circuit-breaker";
import type { PriceValidationReferences } from "../price-validation";
import { capCusdProvider } from "./cap-cusd";
import { erc4626NavProvider } from "./erc4626-nav";
import {
  type CurrentPriceOverride,
  type HistoricalPriceContext,
  type HistoricalPriceResolution,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";
import { idleCdoTrancheProvider } from "./idle-cdo-tranche";
import { inheritedTrackedPriceProvider } from "./inherited-tracked";
import { iusdInfinifiProvider } from "./infinifi-iusd";
import { previewRedeemProvider } from "./preview-redeem";
import { protocolParProvider } from "./protocol-par";

export type {
  CurrentPriceOverride,
  HistoricalPriceContext,
  HistoricalPricePoint,
  HistoricalPriceResolution,
  HistoricalSupplySnapshot,
} from "./helpers";

const AUTHORITATIVE_PRICE_PROVIDERS: PriceSourceProvider[] = [
  capCusdProvider,
  iusdInfinifiProvider,
  inheritedTrackedPriceProvider,
  protocolParProvider,
  erc4626NavProvider,
  previewRedeemProvider,
  idleCdoTrancheProvider,
];

export const AUTHORITATIVE_LIVE_OVERRIDE_BUDGET_MS = 10_000;

export interface AuthoritativeLivePriceOverrideStats {
  budgetMs: number;
  candidateCount: number;
  attemptedCount: number;
  successCount: number;
  failedCount: number;
  emptyCount: number;
  skippedCircuitOpen: number;
  skippedBudget: number;
  timedOut: boolean;
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
    timedOut: false,
  };
}

export interface AuthoritativeLivePriceOverrideOptions {
  db?: D1Database;
  wallClockBudgetMs?: number;
  stats?: AuthoritativeLivePriceOverrideStats;
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
    assetsById: new Map(assets.map((asset) => [asset.id, asset])),
    validationReferences,
  };
  const candidates = assets
    .map((asset) => ({
      asset,
      provider: AUTHORITATIVE_PRICE_PROVIDERS.find((candidate) => candidate.matches(asset.id)),
    }))
    .filter((entry): entry is { asset: PeggedAsset; provider: PriceSourceProvider & { fetchLivePrice: NonNullable<PriceSourceProvider["fetchLivePrice"]> } } =>
      typeof entry.provider?.fetchLivePrice === "function"
    );
  const budgetMs = options?.wallClockBudgetMs ?? AUTHORITATIVE_LIVE_OVERRIDE_BUDGET_MS;
  const stats = options?.stats;
  if (stats) {
    stats.budgetMs = budgetMs;
    stats.candidateCount += candidates.length;
  }
  const budgetSignal = budgetMs > 0 ? AbortSignal.timeout(budgetMs) : undefined;
  const liveSignal = signal && budgetSignal
    ? AbortSignal.any([signal, budgetSignal])
    : budgetSignal ?? signal;
  const circuitAttempts = new Map<string, boolean>();

  for (let index = 0; index < candidates.length; index += 1) {
    if (budgetSignal?.aborted) {
      if (stats) {
        stats.timedOut = true;
        stats.skippedBudget += candidates.length - index;
      }
      break;
    }

    const { asset, provider } = candidates[index];
    const circuitSource = provider.liveCircuitSource;
    if (circuitSource && options?.db) {
      const allowed = await shouldAttemptLiveFetch(options.db, circuitSource, circuitAttempts);
      if (!allowed) {
        if (stats) stats.skippedCircuitOpen += 1;
        continue;
      }
    }
    if (stats) stats.attemptedCount += 1;

    try {
      const override = await provider.fetchLivePrice(asset, liveContext, liveSignal);
      if (override) {
        results.set(asset.id, override);
        if (stats) stats.successCount += 1;
        if (circuitSource && options?.db) {
          await recordOutcomeSafe(options.db, circuitSource, true);
          circuitAttempts.delete(circuitSource);
        }
      } else {
        if (stats) stats.emptyCount += 1;
        if (circuitSource && options?.db && provider.recordNullLiveResultAsCircuitFailure) {
          await recordOutcomeSafe(options.db, circuitSource, false);
          circuitAttempts.delete(circuitSource);
        }
      }
    } catch (error) {
      rethrowIfAborted(error, signal);
      if (budgetSignal?.aborted && !signal?.aborted) {
        if (stats) {
          stats.timedOut = true;
          stats.skippedBudget += candidates.length - index - 1;
        }
        console.warn(`[authoritative-price-sources] live override budget exhausted after ${budgetMs}ms`);
        break;
      }
      if (stats) stats.failedCount += 1;
      if (circuitSource && options?.db) {
        await recordOutcomeSafe(options.db, circuitSource, false);
        circuitAttempts.delete(circuitSource);
      }
      console.warn(`[authoritative-price-sources] ${asset.id} live override failed:`, error);
    }
  }

  return results;
}

export async function fetchAuthoritativeHistoricalPriceSeries(
  meta: StablecoinMeta,
  context: HistoricalPriceContext,
): Promise<HistoricalPriceResolution> {
  const provider = AUTHORITATIVE_PRICE_PROVIDERS.find((candidate) =>
    candidate.matches(meta.id) && (candidate.matchesHistoricalPrices?.(meta.id) ?? true)
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
    console.warn(`[authoritative-price-sources] ${meta.id} historical source failed:`, error);
    return {
      matched: true,
      source: provider.source,
      prices: null,
    };
  }
}

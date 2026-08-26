/**
 * Domain-level DEWS source-state orchestrator.
 *
 * Loads each upstream slice and assembles the `DewsSourceState`
 * consumed by downstream scoring. Each slice's loader lives in
 * `source-state/hydration.ts`. Two narrower concerns live in companion modules:
 *
 *   - `source-state/legacy-bridge.ts` — pre-envelope stress-signals shape
 *                                       compatibility + yield-rankings cache
 *                                       coercion.
 *
 * The shape returned here is load-bearing for the DEWS scoring pipeline; do
 * not alter `DewsSourceState` keys or value types without coordinating
 * scoring updates.
 */

import type { DewsSourceState, PersistedJsonDecodeReason } from "./contracts";
import {
  hydrateBlacklistEvents,
  hydrateDexLiquidity,
  hydrateDexLiquidityHistory,
  hydrateDexPrices,
  hydrateLatestPsiScore,
  hydrateMintBurn,
  hydratePreviousStressSignals,
  hydrateYieldRankingsCache,
  hydrateYieldWarnings,
  type HydrationContext,
} from "./source-state/hydration";

interface LoadDewsSourceStateOptions {
  db: D1Database;
  nowSec: number;
  bootstrapPending: boolean;
  registerSourceFailure: (source: string, error: unknown, options?: { bootstrapAllowed?: boolean }) => void;
  registerMalformedPersistedInput: (options: {
    source: string;
    context: string;
    stablecoinId: string;
    updatedAt?: number | null;
    reason: PersistedJsonDecodeReason;
    degradesRun: boolean;
  }) => void;
}

type HydrationEvent =
  | {
      kind: "sourceFailure";
      source: string;
      error: unknown;
      options?: { bootstrapAllowed?: boolean };
    }
  | {
      kind: "malformedPersistedInput";
      options: Parameters<HydrationContext["registerMalformedPersistedInput"]>[0];
    };

async function hydrateSource<T>(
  ctx: HydrationContext,
  loader: (ctx: HydrationContext) => Promise<T>,
): Promise<{ result: T; events: HydrationEvent[] }> {
  const events: HydrationEvent[] = [];
  const bufferedCtx: HydrationContext = {
    ...ctx,
    registerSourceFailure: (source, error, options) => {
      events.push({ kind: "sourceFailure", source, error, options });
    },
    registerMalformedPersistedInput: (options) => {
      events.push({ kind: "malformedPersistedInput", options });
    },
  };
  return { result: await loader(bufferedCtx), events };
}

function replayHydrationEvents(hydrations: readonly { events: HydrationEvent[] }[], ctx: HydrationContext): void {
  for (const hydration of hydrations) {
    for (const event of hydration.events) {
      if (event.kind === "sourceFailure") {
        ctx.registerSourceFailure(event.source, event.error, event.options);
      } else {
        ctx.registerMalformedPersistedInput(event.options);
      }
    }
  }
}

export async function loadDewsSourceState(options: LoadDewsSourceStateOptions): Promise<DewsSourceState> {
  const ctx: HydrationContext = {
    db: options.db,
    nowSec: options.nowSec,
    bootstrapPending: options.bootstrapPending,
    registerSourceFailure: options.registerSourceFailure,
    registerMalformedPersistedInput: options.registerMalformedPersistedInput,
  };

  // These hydrators are D1/cache-only and each owns its degraded fallback
  // handling. Run them concurrently, then replay diagnostics in legacy order
  // so metadata shape is stable even when D1 reads finish out of order.
  const [
    dexLiqHydration,
    dexPricesHydration,
    dexLiqHistoryHydration,
    blacklistHydration,
    prevSignalsHydration,
    mintBurnHydration,
    yieldWarningsHydration,
    yieldRankingsHydration,
    latestPsiScoreHydration,
  ] = await Promise.all([
    hydrateSource(ctx, hydrateDexLiquidity),
    hydrateSource(ctx, hydrateDexPrices),
    hydrateSource(ctx, hydrateDexLiquidityHistory),
    hydrateSource(ctx, hydrateBlacklistEvents),
    hydrateSource(ctx, hydratePreviousStressSignals),
    hydrateSource(ctx, hydrateMintBurn),
    hydrateSource(ctx, hydrateYieldWarnings),
    hydrateSource(ctx, hydrateYieldRankingsCache),
    hydrateSource(ctx, hydrateLatestPsiScore),
  ]);
  const orderedHydrations = [
    dexLiqHydration,
    dexPricesHydration,
    dexLiqHistoryHydration,
    blacklistHydration,
    prevSignalsHydration,
    mintBurnHydration,
    yieldWarningsHydration,
    yieldRankingsHydration,
    latestPsiScoreHydration,
  ];
  replayHydrationEvents(orderedHydrations, ctx);

  const dexLiq = dexLiqHydration.result;
  const dexPrices = dexPricesHydration.result;
  const dexLiqHistory = dexLiqHistoryHydration.result;
  const blacklist = blacklistHydration.result;
  const prevSignals = prevSignalsHydration.result;
  const mintBurn = mintBurnHydration.result;
  const yieldWarnings = yieldWarningsHydration.result;
  const yieldRankings = yieldRankingsHydration.result;
  const latestPsiScore = latestPsiScoreHydration.result;

  // Source-coverage keys are emitted in the same order the legacy orchestrator
  // produced them so downstream diagnostics (`Object.assign` consumers) see an
  // identical iteration order. The dex-prices stale-rows key is intentionally
  // omitted on load failure to match legacy behavior.
  const sourceCoverage: Record<string, number> = {
    dexLiquidity: dexLiq.totalRows,
    dexLiquidityFreshRows: dexLiq.freshCount,
    dexLiquidityStaleRows: dexLiq.staleCount,
  };
  if (dexLiq.freshnessAgeSec != null) {
    sourceCoverage.dexLiquidityAgeSec = dexLiq.freshnessAgeSec;
  }
  sourceCoverage.dexPrices = dexPrices.trustedCount;
  if (dexPrices.staleCount != null) {
    sourceCoverage.dexPricesStaleRows = dexPrices.staleCount;
  }
  sourceCoverage.dexLiquidityHistory = dexLiqHistory.liqHistRowsRead;
  sourceCoverage.blacklistEvents = blacklist.rowsRead;
  sourceCoverage.previousStressSignals = prevSignals.rowsRead;
  sourceCoverage.previousStressSignalsFreshRows = prevSignals.prevSignals.size;
  sourceCoverage.previousStressSignalsStaleRows = prevSignals.prevSignalStaleIds.size;
  sourceCoverage.mintBurnHourly = mintBurn.rowsRead;
  sourceCoverage.mintBurnHourlyFreshRows = mintBurn.freshCount;
  sourceCoverage.mintBurnHourlyStaleRows = mintBurn.staleCount;
  if (mintBurn.freshnessAgeSec != null) {
    sourceCoverage.mintBurnHourlyAgeSec = mintBurn.freshnessAgeSec;
  }
  sourceCoverage.yieldWarnings = yieldWarnings.rowsRead;
  sourceCoverage.yieldStructuredRows = yieldRankings.yieldSourceRisk.size;

  return {
    dexLiqRows: dexLiq.dexLiqRows,
    dexLiqMap: dexLiq.dexLiqMap,
    dexLiqAgeSecById: dexLiq.dexLiqAgeSecById,
    dexLiqStaleIds: dexLiq.dexLiqStaleIds,
    dexPriceMap: dexPrices.dexPriceMap,
    dexPriceAgeSecById: dexPrices.dexPriceAgeSecById,
    dexPriceStaleIds: dexPrices.dexPriceStaleIds,
    liqHist7dMap: dexLiqHistory.liqHist7dMap,
    liqHistRowsRead: dexLiqHistory.liqHistRowsRead,
    blacklistCounts: blacklist.blacklistCounts,
    prevSignals: prevSignals.prevSignals,
    prevSignalStaleIds: prevSignals.prevSignalStaleIds,
    mintBurnMap: mintBurn.mintBurnMap,
    mintBurnAgeSecById: mintBurn.mintBurnAgeSecById,
    mintBurnStaleIds: mintBurn.mintBurnStaleIds,
    yieldWarnings: yieldWarnings.yieldWarnings,
    yieldSourceRisk: yieldRankings.yieldSourceRisk,
    yieldRankChangeAttribution: yieldRankings.yieldRankChangeAttribution,
    latestPsiScore,
    sourceCoverage,
    dependencyDiagnostics: {
      dexLiquidity: dexLiq.dependencyDiagnostics,
    },
  };
}

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

import type { DewsSourceState } from "./contracts";
import * as hydration from "./source-state/hydration";
import type { HydrationContext } from "./source-state/hydration";

type HydrationEvent =
  | {
      kind: "sourceFailure";
      source: string;
      error: unknown;
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
    registerSourceFailure: (source, error) => {
      events.push({ kind: "sourceFailure", source, error });
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
        ctx.registerSourceFailure(event.source, event.error);
      } else {
        ctx.registerMalformedPersistedInput(event.options);
      }
    }
  }
}

export async function loadDewsSourceState(ctx: HydrationContext): Promise<DewsSourceState> {
  // These hydrators are D1/cache-only and each owns its degraded fallback
  // handling. Run them concurrently, then replay diagnostics in legacy order
  // so metadata shape is stable even when D1 reads finish out of order.
  const orderedHydrations = await Promise.all([
    hydrateSource(ctx, hydration.hydrateDexLiquidity),
    hydrateSource(ctx, hydration.hydrateDexPrices),
    hydrateSource(ctx, hydration.hydrateDexLiquidityHistory),
    hydrateSource(ctx, hydration.hydrateBlacklistEvents),
    hydrateSource(ctx, hydration.hydratePreviousStressSignals),
    hydrateSource(ctx, hydration.hydrateMintBurn),
    hydrateSource(ctx, hydration.hydrateYieldWarnings),
    hydrateSource(ctx, hydration.hydrateYieldRankingsCache),
    hydrateSource(ctx, hydration.hydrateLatestPsiScore),
  ]);
  replayHydrationEvents(orderedHydrations, ctx);

  // Source-coverage keys are emitted in the same order the legacy orchestrator
  // produced them so downstream diagnostics (`Object.assign` consumers) see an
  // identical iteration order. The dex-prices stale-rows key is intentionally
  // omitted on load failure to match legacy behavior.
  const [liq, prices, history, blacklist, previous, mintBurn, warnings, rankings, psi] = orderedHydrations;
  return {
    dexLiqRows: liq.result.dexLiqRows,
    dexLiqMap: liq.result.dexLiqMap,
    dexLiqAgeSecById: liq.result.dexLiqAgeSecById,
    dexLiqStaleIds: liq.result.dexLiqStaleIds,
    dexPriceMap: prices.result.dexPriceMap,
    dexPriceAgeSecById: prices.result.dexPriceAgeSecById,
    dexPriceStaleIds: prices.result.dexPriceStaleIds,
    liqHist7dMap: history.result.liqHist7dMap,
    liqHistRowsRead: history.result.liqHistRowsRead,
    blacklistCounts: blacklist.result.blacklistCounts,
    blacklistSourceOk: blacklist.result.blacklistSourceOk,
    prevSignals: previous.result.prevSignals,
    prevSignalStaleIds: previous.result.prevSignalStaleIds,
    mintBurnMap: mintBurn.result.mintBurnMap,
    mintBurnAgeSecById: mintBurn.result.mintBurnAgeSecById,
    mintBurnStaleIds: mintBurn.result.mintBurnStaleIds,
    yieldWarnings: warnings.result.yieldWarnings,
    yieldSourceRisk: rankings.result.yieldSourceRisk,
    yieldRankChangeAttribution: rankings.result.yieldRankChangeAttribution,
    latestPsiScore: psi.result.latestPsiScore,
    sourceCoverage: {
      dexLiquidity: liq.result.totalRows,
      dexLiquidityFreshRows: liq.result.freshCount,
      dexLiquidityStaleRows: liq.result.staleCount,
      ...(liq.result.freshnessAgeSec != null ? { dexLiquidityAgeSec: liq.result.freshnessAgeSec } : {}),
      dexPrices: prices.result.trustedCount,
      ...(prices.result.staleCount != null ? { dexPricesStaleRows: prices.result.staleCount } : {}),
      dexLiquidityHistory: history.result.liqHistRowsRead,
      blacklistEvents: blacklist.result.rowsRead,
      previousStressSignals: previous.result.rowsRead,
      previousStressSignalsFreshRows: previous.result.prevSignals.size,
      previousStressSignalsStaleRows: previous.result.prevSignalStaleIds.size,
      mintBurnHourly: mintBurn.result.rowsRead,
      mintBurnHourlyFreshRows: mintBurn.result.freshCount,
      mintBurnHourlyStaleRows: mintBurn.result.staleCount,
      ...(mintBurn.result.freshnessAgeSec != null ? { mintBurnHourlyAgeSec: mintBurn.result.freshnessAgeSec } : {}),
      yieldWarnings: warnings.result.rowsRead,
      yieldStructuredRows: rankings.result.yieldSourceRisk.size,
    },
    dependencyDiagnostics: {
      dexLiquidity: liq.result.dependencyDiagnostics,
      psi: psi.result.dependencyDiagnostics,
    },
  };
}

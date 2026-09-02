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
import * as hydration from "./source-state/hydration";
import type { HydrationContext, HydrationLoader } from "./source-state/hydration";

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

type ProjectedSourceState = Omit<DewsSourceState, "sourceCoverage" | "dependencyDiagnostics">;

interface HydrationProjection {
  state: Partial<ProjectedSourceState>;
  coverage: Record<string, number>;
  dependencyDiagnostics?: Partial<DewsSourceState["dependencyDiagnostics"]>;
}

function defineHydration<Key extends string, Result>(
  key: Key,
  loader: HydrationLoader<Result>,
  projectCoverage: (result: Result) => Record<string, number>,
  projectState: (result: Result) => Partial<ProjectedSourceState>,
  projectDependencyDiagnostics?: (result: Result) => Partial<DewsSourceState["dependencyDiagnostics"]>,
) {
  return {
    key, loader, projectCoverage, projectState, projectDependencyDiagnostics,
    async hydrate(ctx: HydrationContext): Promise<HydrationProjection> {
      const result = await loader(ctx);
      return {
        state: projectState(result),
        coverage: projectCoverage(result),
        dependencyDiagnostics: projectDependencyDiagnostics?.(result),
      };
    },
  };
}

const DEWS_HYDRATION_REGISTRY = [
  defineHydration(
    "dexLiquidity",
    hydration.hydrateDexLiquidity,
    (result) => ({
      dexLiquidity: result.totalRows,
      dexLiquidityFreshRows: result.freshCount,
      dexLiquidityStaleRows: result.staleCount,
      ...(result.freshnessAgeSec != null ? { dexLiquidityAgeSec: result.freshnessAgeSec } : {}),
    }),
    (result) => ({
      dexLiqRows: result.dexLiqRows,
      dexLiqMap: result.dexLiqMap,
      dexLiqAgeSecById: result.dexLiqAgeSecById,
      dexLiqStaleIds: result.dexLiqStaleIds,
    }),
    (result) => ({ dexLiquidity: result.dependencyDiagnostics }),
  ),
  defineHydration(
    "dexPrices",
    hydration.hydrateDexPrices,
    (result) => ({
      dexPrices: result.trustedCount,
      ...(result.staleCount != null ? { dexPricesStaleRows: result.staleCount } : {}),
    }),
    (result) => ({
      dexPriceMap: result.dexPriceMap,
      dexPriceAgeSecById: result.dexPriceAgeSecById,
      dexPriceStaleIds: result.dexPriceStaleIds,
    }),
  ),
  defineHydration(
    "dexLiquidityHistory",
    hydration.hydrateDexLiquidityHistory,
    (result) => ({ dexLiquidityHistory: result.liqHistRowsRead }),
    (result) => ({ liqHist7dMap: result.liqHist7dMap, liqHistRowsRead: result.liqHistRowsRead }),
  ),
  defineHydration("blacklistEvents", hydration.hydrateBlacklistEvents,
    (result) => ({ blacklistEvents: result.rowsRead }),
    (result) => ({ blacklistCounts: result.blacklistCounts }),
  ),
  defineHydration(
    "previousStressSignals",
    hydration.hydratePreviousStressSignals,
    (result) => ({
      previousStressSignals: result.rowsRead,
      previousStressSignalsFreshRows: result.prevSignals.size,
      previousStressSignalsStaleRows: result.prevSignalStaleIds.size,
    }),
    (result) => ({ prevSignals: result.prevSignals, prevSignalStaleIds: result.prevSignalStaleIds }),
  ),
  defineHydration(
    "mintBurn",
    hydration.hydrateMintBurn,
    (result) => ({
      mintBurnHourly: result.rowsRead,
      mintBurnHourlyFreshRows: result.freshCount,
      mintBurnHourlyStaleRows: result.staleCount,
      ...(result.freshnessAgeSec != null ? { mintBurnHourlyAgeSec: result.freshnessAgeSec } : {}),
    }),
    (result) => ({
      mintBurnMap: result.mintBurnMap,
      mintBurnAgeSecById: result.mintBurnAgeSecById,
      mintBurnStaleIds: result.mintBurnStaleIds,
    }),
  ),
  defineHydration("yieldWarnings", hydration.hydrateYieldWarnings,
    (result) => ({ yieldWarnings: result.rowsRead }),
    (result) => ({ yieldWarnings: result.yieldWarnings }),
  ),
  defineHydration(
    "yieldRankings",
    hydration.hydrateYieldRankingsCache,
    (result) => ({ yieldStructuredRows: result.yieldSourceRisk.size }),
    (result) => ({
      yieldSourceRisk: result.yieldSourceRisk,
      yieldRankChangeAttribution: result.yieldRankChangeAttribution,
    }),
  ),
  defineHydration("latestPsiScore", hydration.hydrateLatestPsiScore,
    () => ({}),
    (result) => ({ latestPsiScore: result }),
  ),
] as const;

async function hydrateSource<T>(
  ctx: HydrationContext,
  descriptor: { hydrate: HydrationLoader<T> },
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
  return { result: await descriptor.hydrate(bufferedCtx), events };
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
  const orderedHydrations = await Promise.all(
    DEWS_HYDRATION_REGISTRY.map((descriptor) => hydrateSource(ctx, descriptor)),
  );
  replayHydrationEvents(orderedHydrations, ctx);

  // Source-coverage keys are emitted in the same order the legacy orchestrator
  // produced them so downstream diagnostics (`Object.assign` consumers) see an
  // identical iteration order. The dex-prices stale-rows key is intentionally
  // omitted on load failure to match legacy behavior.
  const state: Partial<ProjectedSourceState> = {};
  const sourceCoverage: Record<string, number> = {};
  const dependencyDiagnostics: Partial<DewsSourceState["dependencyDiagnostics"]> = {};
  for (const { result } of orderedHydrations) {
    Object.assign(state, result.state);
    Object.assign(sourceCoverage, result.coverage);
    Object.assign(dependencyDiagnostics, result.dependencyDiagnostics);
  }

  return {
    ...state,
    sourceCoverage,
    dependencyDiagnostics,
  } as DewsSourceState;
}

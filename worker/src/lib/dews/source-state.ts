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
import type { HydrationContext } from "./source-state/hydration";

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

type HydrationProjection = {
  state: Partial<ProjectedSourceState>;
  coverage: Record<string, number>;
  dependencyDiagnostics?: Partial<DewsSourceState["dependencyDiagnostics"]>;
};

function defineHydration<DescriptorKey extends string, Result, StateKey extends keyof Result & keyof ProjectedSourceState>(
  key: DescriptorKey,
  loader: (ctx: HydrationContext) => Promise<Result>,
  stateKeys: readonly StateKey[],
  projectCoverage: (result: Result) => Record<string, number>,
  projectDependencyDiagnostics?: (result: Result) => Partial<DewsSourceState["dependencyDiagnostics"]>,
) {
  return {
    key,
    async hydrate(ctx: HydrationContext): Promise<HydrationProjection> {
      const result = await loader(ctx);
      return {
        state: Object.fromEntries(stateKeys.map((stateKey) => [stateKey, result[stateKey]])) as Partial<ProjectedSourceState>,
        coverage: projectCoverage(result),
        dependencyDiagnostics: projectDependencyDiagnostics?.(result),
      };
    },
  };
}

// Named (not inline) so `Result` is inferred before the state-key tuple; a
// contextually typed arrow would defer and collapse StateKey to `never`.
async function hydrateLatestPsiScoreState(ctx: HydrationContext) {
  return { latestPsiScore: await hydration.hydrateLatestPsiScore(ctx) };
}

const DEWS_HYDRATION_REGISTRY = [
  defineHydration(
    "dexLiquidity",
    hydration.hydrateDexLiquidity,
    ["dexLiqRows", "dexLiqMap", "dexLiqAgeSecById", "dexLiqStaleIds"],
    (result) => ({
      dexLiquidity: result.totalRows,
      dexLiquidityFreshRows: result.freshCount,
      dexLiquidityStaleRows: result.staleCount,
      ...(result.freshnessAgeSec != null ? { dexLiquidityAgeSec: result.freshnessAgeSec } : {}),
    }),
    (result) => ({ dexLiquidity: result.dependencyDiagnostics }),
  ),
  defineHydration(
    "dexPrices",
    hydration.hydrateDexPrices,
    ["dexPriceMap", "dexPriceAgeSecById", "dexPriceStaleIds"],
    (result) => ({
      dexPrices: result.trustedCount,
      ...(result.staleCount != null ? { dexPricesStaleRows: result.staleCount } : {}),
    }),
  ),
  defineHydration("dexLiquidityHistory", hydration.hydrateDexLiquidityHistory,
    ["liqHist7dMap", "liqHistRowsRead"],
    (result) => ({ dexLiquidityHistory: result.liqHistRowsRead }),
  ),
  defineHydration("blacklistEvents", hydration.hydrateBlacklistEvents, ["blacklistCounts"],
    (result) => ({ blacklistEvents: result.rowsRead }),
  ),
  defineHydration(
    "previousStressSignals",
    hydration.hydratePreviousStressSignals,
    ["prevSignals", "prevSignalStaleIds"],
    (result) => ({ previousStressSignals: result.rowsRead,
      previousStressSignalsFreshRows: result.prevSignals.size, previousStressSignalsStaleRows: result.prevSignalStaleIds.size }),
  ),
  defineHydration(
    "mintBurn",
    hydration.hydrateMintBurn,
    ["mintBurnMap", "mintBurnAgeSecById", "mintBurnStaleIds"],
    (result) => ({
      mintBurnHourly: result.rowsRead,
      mintBurnHourlyFreshRows: result.freshCount,
      mintBurnHourlyStaleRows: result.staleCount,
      ...(result.freshnessAgeSec != null ? { mintBurnHourlyAgeSec: result.freshnessAgeSec } : {}),
    }),
  ),
  defineHydration("yieldWarnings", hydration.hydrateYieldWarnings, ["yieldWarnings"],
    (result) => ({ yieldWarnings: result.rowsRead }),
  ),
  defineHydration("yieldRankings", hydration.hydrateYieldRankingsCache,
    ["yieldSourceRisk", "yieldRankChangeAttribution"],
    (result) => ({ yieldStructuredRows: result.yieldSourceRisk.size }),
  ),
  defineHydration("latestPsiScore", hydrateLatestPsiScoreState, ["latestPsiScore"], () => ({})),
] as const;

async function hydrateSource<T>(
  ctx: HydrationContext,
  descriptor: { hydrate: (ctx: HydrationContext) => Promise<T> },
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

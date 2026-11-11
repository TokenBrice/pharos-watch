import { throwIfAborted } from "../lib/abort";
import type { CronResult } from "../lib/cron-logger";
import type { Env } from "../lib/env";
import type { YieldBenchmarkKey } from "@shared/types/yield";
import { loadRiskFreeRateRegistryWithState } from "./yield-sync/state";
import { BENCHMARK_FETCH_DESCRIPTORS, BENCHMARK_METADATA_DESCRIPTORS, BENCHMARK_RESOLUTION_POLICIES } from "./tbill-sources/providers";
import { resolveBenchmarkProviderMap, resolveBenchmarkProvider, type BenchmarkRateConfirmation } from "./tbill-sources/resolve";
import { buildBenchmarkRegistry, publishBenchmarks } from "./tbill-sources/publication";
import { buildMetadata, resolveBenchmarkRefreshNeed, buildBenchmarkDegradationReasons, buildBenchmarkRunMetadata, buildGbpResponseDiagnosticMetadata } from "./tbill-sources/metadata";

export interface FetchTbillRateOptions {
  /**
   * Skip this run when the published registry already carries a market
   * observation newer than this many seconds. Only the hourly yield-lane retry
   * passes it; the canonical daily 08:00 invocation always refreshes every
   * descriptor so the daily cadence stays authoritative.
   */
  minRegistryAgeSec?: number;
}

export async function fetchTbillRate(
  db: D1Database,
  signal?: AbortSignal,
  env?: Pick<Env, "BANXICO_TOKEN">,
  options?: FetchTbillRateOptions,
): Promise<CronResult> {
  const loaded = await loadRiskFreeRateRegistryWithState(db);
  throwIfAborted(signal);
  const previous = loaded.registry;
  const fetchedAt = Math.floor(Date.now() / 1000);
  const minRegistryAgeSec = options?.minRegistryAgeSec ?? null;

  const refreshNeed = minRegistryAgeSec == null
    ? null
    : resolveBenchmarkRefreshNeed({ registry: previous, nowSec: fetchedAt, minRegistryAgeSec });
  if (refreshNeed && !refreshNeed.refresh) {
    return {
      status: "skipped_neutral",
      itemCount: 0,
      metadata: buildMetadata({
        reason: "risk-free-registry-fresh",
        skipped: true,
        skipReason: "risk-free-registry-fresh",
        minRegistryAgeSec,
        newestMarketAgeSec: refreshNeed.newestMarketAgeSec,
        usdMarketAgeSec: refreshNeed.usdMarketAgeSec,
      }),
    };
  }

  const usdResolved = await resolveBenchmarkProvider({
    db, key: "USD", policy: BENCHMARK_RESOLUTION_POLICIES.USD, previous, fetchedAt, env, signal,
  });
  const usdMeta = usdResolved.meta!;
  const usdParsed = usdResolved.parsed;
  const usdConfirmation = usdResolved.confirmation;

  const resolvedByKey = await resolveBenchmarkProviderMap({
    db,
    previous,
    fetchedAt,
    env,
    signal,
  });

  // SGD: TODO — no stable public SORA endpoint identified yet; SGD pegs fall back to USD.
  const benchmarks = buildBenchmarkRegistry(usdMeta, resolvedByKey);

  const resolvedKeys: YieldBenchmarkKey[] = usdParsed ? ["USD"] : [];
  for (const descriptor of BENCHMARK_FETCH_DESCRIPTORS) {
    if (resolvedByKey[descriptor.key]?.parsed) resolvedKeys.push(descriptor.key);
  }
  const rateConfirmations: BenchmarkRateConfirmation[] = [
    ...(usdConfirmation ? [usdConfirmation] : []),
    ...Object.values(resolvedByKey).flatMap((resolved) =>
      resolved.confirmation ? [resolved.confirmation] : []),
  ];
  // A cache row that exists but cannot be parsed leaves no evidence behind the
  // keys this run did not resolve. Rewriting it with the placeholder registry
  // would destroy the raw row and publish an unverifiable "current" snapshot, so
  // that specific case is left untouched until something measured is available
  // (a missing row has nothing to preserve and keeps the historical write).
  const registryCacheWrite = loaded.cacheState === "invalid" && resolvedKeys.length === 0
    ? "skipped-unreadable-cache"
    : "written";
  const { gbpRetainedFallbackMonitor, usdFreshStreakMonitor, generationId, previousGenerationId, previousGenerationUnavailableReason } =
    await publishBenchmarks({ db, benchmarks, fetchedAt, registryCacheWrite, signal });

  const degradationReasons = buildBenchmarkDegradationReasons(usdMeta, resolvedByKey);
  return {
    status: degradationReasons.length > 0 ? "degraded" : "ok",
    itemCount: BENCHMARK_METADATA_DESCRIPTORS.filter(({ key }) => benchmarks[key] != null).length,
    productivity: { productive: registryCacheWrite === "written" },
    metadata: buildBenchmarkRunMetadata({
      fallbackMode: degradationReasons.length > 0 ? degradationReasons.join(",") : null,
      benchmarks,
      includeDetails: true,
      extraFields: {
        ...(degradationReasons.length > 0 ? { reason: degradationReasons.join(",") } : {}),
        ...gbpRetainedFallbackMonitor.metadata,
        ...usdFreshStreakMonitor.metadata,
        generationId,
        previousGenerationId,
        previousGenerationUnavailableReason,
        registryCacheState: loaded.cacheState,
        registryCacheWrite,
        resolvedBenchmarkKeys: resolvedKeys,
        ...(rateConfirmations.length > 0 ? {
          benchmarkRateConfirmations: rateConfirmations,
          quality: {
            reason: "benchmark-rate-level-shift-confirmed",
            confirmedKeys: rateConfirmations.map(({ key }) => key),
          },
        } : {}),
        ...buildGbpResponseDiagnosticMetadata(resolvedByKey.GBP),
        brlResponseAttempts: resolvedByKey.BRL.responseDiagnostics ?? [],
      },
    }),
  };
}

import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { logCronEvent } from "../../lib/cron-logger";
import { assessYieldBenchmarkRate } from "@shared/lib/yield-benchmark-freshness";
import type { YieldBenchmarkKey } from "@shared/types/yield";
import type { Env } from "../../lib/env";
import { throwIfAborted } from "../../lib/abort";
import { buildHardcodedUsdBenchmark, withYieldBenchmarkStaticMeta, type ParsedYieldBenchmarkMeta, type ParsedYieldBenchmarkRegistry } from "../yield-sync/benchmarks";
import { type BenchmarkFetchResult, type BenchmarkProviderAttemptDiagnostic } from "./shared";
import { BENCHMARK_FETCH_DESCRIPTORS, type BenchmarkResolutionPolicy } from "./providers";

const TREASURY_CIRCUIT_PREFIX = "TREASURY_RATES:";

/**
 * A rejected market rate is a metadata/status finding, not a transport failure:
 * the descriptor's fallbackMode names it, the run degrades, and the benchmark
 * canaries fail. The event keeps the rejected and retained values inspectable.
 */
async function recordBenchmarkRateOutOfBand(
  db: D1Database,
  key: YieldBenchmarkKey,
  rate: number,
  previousMarketRate: number | null,
): Promise<void> {
  try {
    await logCronEvent(db, {
      job: "fetch-tbill-rate",
      eventType: "benchmark-rate-out-of-band",
      severity: "warning",
      message: `${key} market rate ${rate} moved outside the plausibility band`,
      metadata: { key, rate, previousMarketRate },
    });
  } catch {
    // Diagnostic only; the publication decision already failed closed.
  }
}

function benchmarkCircuitKey(key: string): string {
  return `${TREASURY_CIRCUIT_PREFIX}${key}`;
}

function buildRetainedBenchmark(
  previous: ParsedYieldBenchmarkMeta | null,
  fallbackMode: string,
  rejected?: { rate: number; recordDate: string | null; fetchedAt: number } | null,
): ParsedYieldBenchmarkMeta | null {
  if (
    previous?.lastMarketRate != null &&
    previous.lastMarketSource &&
    previous.lastMarketSource !== "hardcoded-fallback"
  ) {
    const retainedSource = previous.source ?? previous.lastMarketSource;
    const retained = withYieldBenchmarkStaticMeta(previous.key ?? "USD", {
      rate: previous.lastMarketRate,
      recordDate: previous.lastMarketRecordDate,
      fetchedAt: previous.lastMarketFetchedAt,
      ageSeconds:
        previous.lastMarketFetchedAt != null
          ? Math.max(0, Math.floor(Date.now() / 1000) - previous.lastMarketFetchedAt)
          : null,
      source: retainedSource,
      isFallback: true,
      fallbackMode: `${fallbackMode}-retained`,
    });
    return {
      ...retained,
      isProxy: previous.isProxy,
      lastMarketRate: previous.lastMarketRate,
      lastMarketRecordDate: previous.lastMarketRecordDate,
      lastMarketFetchedAt: previous.lastMarketFetchedAt,
      lastMarketSource: previous.lastMarketSource,
      // Only the immediately preceding rejection is confirmation evidence; a
      // failed or non-publishing run clears it so two unrelated values cannot pair.
      lastRejectedMarketRate: rejected?.rate ?? null,
      lastRejectedMarketRecordDate: rejected?.recordDate ?? null,
      lastRejectedMarketFetchedAt: rejected?.fetchedAt ?? null,
    };
  }

  return null;
}

function buildResolvedBenchmark(params: {
  key: YieldBenchmarkKey;
  rate: number;
  recordDate: string;
  fetchedAt: number;
  source: string;
  isFallback?: boolean;
  fallbackMode?: string | null;
  isProxy?: boolean;
}): ParsedYieldBenchmarkMeta {
  const resolved = withYieldBenchmarkStaticMeta(params.key, {
    rate: params.rate,
    recordDate: params.recordDate,
    fetchedAt: params.fetchedAt,
    ageSeconds: 0,
    source: params.source,
    isFallback: params.isFallback ?? false,
    fallbackMode: params.fallbackMode ?? null,
  });
  const marketFields = params.isFallback
    ? {
        lastMarketRate: null,
        lastMarketRecordDate: null,
        lastMarketFetchedAt: null,
        lastMarketSource: null,
      }
    : {
        lastMarketRate: params.rate,
        lastMarketRecordDate: params.recordDate,
        lastMarketFetchedAt: params.fetchedAt,
        lastMarketSource: params.source,
      };

  return {
    ...resolved,
    isProxy: params.isProxy ?? resolved.isProxy,
    ...marketFields,
    lastRejectedMarketRate: null,
    lastRejectedMarketRecordDate: null,
    lastRejectedMarketFetchedAt: null,
  };
}

export interface BenchmarkRateConfirmation {
  key: YieldBenchmarkKey;
  rate: number;
  previousMarketRate: number;
  previousRejectedMarketRate: number;
  previousRejectedMarketFetchedAt: number | null;
  confirmedAt: number;
}

export interface ResolvedBenchmarkProvider {
  key: YieldBenchmarkKey;
  parsed: BenchmarkFetchResult | null;
  meta: ParsedYieldBenchmarkMeta | null;
  failureMode: string | null;
  confirmation?: BenchmarkRateConfirmation | null;
  responseDiagnostics?: BenchmarkProviderAttemptDiagnostic[];
}

export async function resolveBenchmarkProvider(params: {
  db: D1Database;
  key: Exclude<YieldBenchmarkKey, "SGD">;
  policy: BenchmarkResolutionPolicy;
  previous: ParsedYieldBenchmarkRegistry;
  fetchedAt: number;
  env?: Pick<Env, "BANXICO_TOKEN">;
  signal?: AbortSignal;
}): Promise<ResolvedBenchmarkProvider> {
  const { db, key, policy, previous, fetchedAt, env, signal } = params;
  const credential = policy.credentials.binding === "none" ? null : env?.[policy.credentials.binding]?.trim() || null;
  const hasCredentials = policy.credentials.binding === "none" || credential != null;
  const circuitSource = benchmarkCircuitKey(key);
  const allowed = await shouldAttemptFetch(db, circuitSource);
  const previousBenchmark = previous[key] ?? null;
  const previousMarketRate = previousBenchmark?.lastMarketRate ?? null;
  let parsed: BenchmarkFetchResult | null = null;
  let source: string | null = null;
  let rejected: BenchmarkFetchResult | null = null;
  let confirmation: BenchmarkRateConfirmation | null = null;
  let responseDiagnostics: BenchmarkProviderAttemptDiagnostic[] | undefined;

  if (allowed && hasCredentials) {
    for (const provider of policy.orderedProviders) {
      const outcome = await provider.fetch({ signal, credential });
      const fetched = outcome && "result" in outcome ? outcome.result : outcome;
      if (policy.responseDiagnostics === "preserve") responseDiagnostics = outcome?.responseDiagnostics;
      if (!fetched) continue;
      const assessment = assessYieldBenchmarkRate(
        key, fetched.rate, previousMarketRate, previousBenchmark?.lastRejectedMarketRate ?? null,
      );
      if (!assessment.accepted) {
        rejected ??= fetched;
        if (provider.rejectionDiagnostic === "record") {
          await recordBenchmarkRateOutOfBand(db, key, fetched.rate, previousMarketRate);
        }
        continue;
      }
      parsed = fetched;
      source = provider.sourceSelection === "observation" ? fetched.source ?? provider.source : provider.source;
      if (assessment.confirmedLevelShift && previousMarketRate != null) {
        confirmation = {
          key,
          rate: fetched.rate,
          previousMarketRate,
          previousRejectedMarketRate: previousBenchmark?.lastRejectedMarketRate ?? fetched.rate,
          previousRejectedMarketFetchedAt: previousBenchmark?.lastRejectedMarketFetchedAt ?? null,
          confirmedAt: fetchedAt,
        };
      }
      break;
    }
  }

  const fallbackMode = !allowed ? "circuit-open"
    : !hasCredentials ? policy.credentials.missingFallbackMode!
      : rejected ? `${key.toLowerCase()}-rate-out-of-band` : policy.failureMode;
  const recordThisOutcome = allowed && (hasCredentials || policy.credentials.missingOutcome === "record-failure");
  if (recordThisOutcome && policy.outcomeTiming === "before-meta") {
    await recordOutcome(db, circuitSource, parsed != null);
  }
  const meta = parsed
    ? buildResolvedBenchmark({ key, rate: parsed.rate, recordDate: parsed.recordDate, fetchedAt, source: source! })
    : buildRetainedBenchmark(
        previousBenchmark,
        fallbackMode,
        rejected ? { rate: rejected.rate, recordDate: rejected.recordDate, fetchedAt } : null,
      ) ?? (policy.terminalFallback === "hardcoded-usd" ? buildHardcodedUsdBenchmark(fallbackMode) : null);
  if (recordThisOutcome && policy.outcomeTiming === "after-meta") {
    await recordOutcome(db, circuitSource, parsed != null);
  }
  return {
    key,
    parsed,
    meta,
    failureMode: parsed ? null : meta?.fallbackMode ?? fallbackMode,
    ...(confirmation ? { confirmation } : {}),
    ...(responseDiagnostics ? { responseDiagnostics } : {}),
  };
}

export async function resolveBenchmarkProviderMap(params: {
  db: D1Database;
  previous: ParsedYieldBenchmarkRegistry;
  fetchedAt: number;
  env?: Pick<Env, "BANXICO_TOKEN">;
  signal?: AbortSignal;
}): Promise<Record<string, ResolvedBenchmarkProvider>> {
  const resolvedProviders: ResolvedBenchmarkProvider[] = [];
  for (const descriptor of BENCHMARK_FETCH_DESCRIPTORS) {
    throwIfAborted(params.signal);
    resolvedProviders.push(await resolveBenchmarkProvider({ ...params, key: descriptor.key, policy: descriptor.policy }));
  }
  return Object.fromEntries(resolvedProviders.map((entry) => [entry.key, entry]));
}

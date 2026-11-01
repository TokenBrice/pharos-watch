import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compactCronMetadataForPersistence,
  MAX_PERSISTED_CRON_METADATA_BYTES,
  DEFAULT_CRON_METADATA_BUDGET_BYTES,
  getCronMetadataBudgetBytes,
} from "../cron-metadata-persistence";
import { buildResourcePressure } from "../cron-resource-pressure";
import { normalizeCronMetadataWithLease } from "../cron-metadata";

describe("compactCronMetadataForPersistence", () => {
  afterEach(() => vi.restoreAllMocks());
  it("uses explicit per-job exceptions without raising the default budget", () => {
    expect(getCronMetadataBudgetBytes("unregistered-job")).toBe(DEFAULT_CRON_METADATA_BUDGET_BYTES);
    expect(getCronMetadataBudgetBytes("sync-dex-liquidity")).toBe(16 * 1_024);
    for (const job of ["sync-mint-burn", "sync-mint-burn-extended", "sync-live-reserves"]) {
      expect(getCronMetadataBudgetBytes(job)).toBe(32 * 1_024);
    }
    for (const job of ["sync-stablecoins", "cron-sentinel"]) {
      expect(getCronMetadataBudgetBytes(job)).toBe(MAX_PERSISTED_CRON_METADATA_BYTES);
    }
  });

  it("preserves the complete resource block outside diagnostics through oversized compaction", () => {
    const resourcePressure = buildResourcePressure({
      phase: "decode", observedAt: 123, intakeBytes: 42, cacheBytes: 336,
      bodyCapBytes: 256, inputCapBytes: 1024, inputBytes: 512, catalogMaxAssets: 488, catalogAssets: 397,
      rejectedBodies: 0, cacheBasis: "intake-estimate",
    });
    const result = compactCronMetadataForPersistence(JSON.stringify({ resourcePressure, payload: "x".repeat(100_000) }));
    expect(result.compacted).toBe(true);
    expect(JSON.parse(result.metadata!).resourcePressure).toEqual(resourcePressure);
    expect(result.persistedBytes).toBeLessThanOrEqual(MAX_PERSISTED_CRON_METADATA_BYTES);
  });

  it("keeps the consumer-read capabilities object across an over-budget fallback sync row", () => {
    // A CoinGecko fallback sync repeats its provider diagnostics under
    // `enrichment`, so the duplicated bulk alone exceeds the sync-stablecoins budget.
    const providerDiagnostics = Array.from({ length: 1_200 }, (_, index) => ({
      assetId: `asset-${index}`, adapter: "coinmarketcap", state: "attempted",
      result: "failed", rejectionClass: "non-ok",
    }));
    const capabilities = { stablecoinsCache: true, depegPipeline: true };
    const result = compactCronMetadataForPersistence(JSON.stringify({
      capabilities,
      enrichment: { totalMissing: 120, providerDiagnostics },
      providerDiagnostics,
    }), undefined, "sync-stablecoins");

    expect(result.compacted).toBe(true);
    const persisted = JSON.parse(result.metadata!);
    expect(persisted.capabilities).toEqual(capabilities);
    expect(persisted.enrichment.providerDiagnostics).toEqual({ count: providerDiagnostics.length });
    expect(result.persistedBytes).toBeLessThanOrEqual(MAX_PERSISTED_CRON_METADATA_BYTES);
  });

  it.each([null, 0])("retains scheduler-enriched measurement evidence (%s) through oversized compaction", (measurement) => {
    const measurements = {
      rowsRead: measurement, rowsWritten: measurement, rowsDropped: measurement, validationFailures: measurement,
    };
    const normalized = normalizeCronMetadataWithLease({
      itemCount: 99,
      metadata: JSON.stringify({ ...measurements, providerDiagnostics: [{ body: "x".repeat(100_000) }] }),
    }, { leaseOwner: "scheduled-test", scheduleKey: "quarterHourly", slotStartedAt: 600 });
    const result = compactCronMetadataForPersistence(normalized);
    expect(result.compacted).toBe(true);
    expect(result.persistedBytes).toBeLessThanOrEqual(DEFAULT_CRON_METADATA_BUDGET_BYTES);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      ...measurements, leaseOwner: "scheduled-test", scheduleKey: "quarterHourly", slotStartedAt: 600,
    });
  });

  it("compacts rich results to the default 8 KiB budget while retaining named diagnostics as counts", () => {
    const metadata = JSON.stringify({
      reason: "stablecoin-publication",
      rowsRead: 410,
      rowsWritten: 364,
      providerDiagnostics: Array.from({ length: 5_000 }, (_, index) => ({
        provider: `provider-${index}`,
        body: `sensitive-${"x".repeat(120)}`,
      })),
      fullAssets: Array.from({ length: 410 }, (_, index) => ({
        id: String(index),
        symbol: "coins-\u{1F4B0}".repeat(100),
      })),
      coverage: {
        expectedCount: 364,
        publishedCount: 364,
        omittedIds: Array.from({ length: 100 }, (_, index) => String(index)),
      },
    });

    const result = compactCronMetadataForPersistence(metadata);
    const parsed = JSON.parse(result.metadata!) as {
      reason: string;
      persistenceCompaction: { originalBytes: number };
      providerDiagnostics: unknown;
      fullAssets: unknown;
    };

    expect(result.compacted).toBe(true);
    expect(result.originalBytes).toBeGreaterThan(MAX_PERSISTED_CRON_METADATA_BYTES);
    expect(result.persistedBytes).toBeLessThanOrEqual(MAX_PERSISTED_CRON_METADATA_BYTES);
    expect(parsed.reason).toBe("stablecoin-publication");
    expect(parsed.persistenceCompaction.originalBytes).toBe(result.originalBytes);
    expect(parsed).toMatchObject({
      rowsRead: 410, rowsWritten: 364,
      providerDiagnostics: { count: 5_000 }, fullAssets: { count: 410 },
    });
    expect(result.persistedBytes).toBeLessThanOrEqual(DEFAULT_CRON_METADATA_BUDGET_BYTES);
  });

  it("preserves measured-execution per-chain evidence through sync-cl-exit-depth compaction", () => {
    const chains = {
      base: { scoreEligibleTargets: 4, measured: 0, failed: 4, deferred: 0 },
      ethereum: { scoreEligibleTargets: 9, measured: 9, failed: 0, deferred: 0 },
    };
    const result = compactCronMetadataForPersistence(JSON.stringify({
      lane: "active",
      chains,
      failuresByReason: Object.fromEntries(
        Array.from({ length: 1_000 }, (_, index) => [`reason-${index}`, "x".repeat(40)]),
      ),
    }), undefined, "sync-cl-exit-depth");
    expect(result.compacted).toBe(true);
    expect(JSON.parse(result.metadata!).chains).toEqual(chains);
  });

  it("preserves mxLedger scalars as top-level keys through oversized compaction", () => {
    const chunk = "A".repeat(240);
    const metadata = JSON.stringify({
      reason: "dex-liquidity-publication",
      mxLedgerV: 1,
      mxLedgerKind: "A",
      mxLedgerCycle: 1_787_120_160,
      mxLedgerParts: 2,
      mxLedger0: chunk,
      mxLedger1: chunk,
      bulk: Array.from({ length: 5_000 }, (_, index) => ({
        pool: `pool-${index}`,
        body: "x".repeat(120),
      })),
    });

    const result = compactCronMetadataForPersistence(metadata);
    expect(result.compacted).toBe(true);
    const parsed = JSON.parse(result.metadata!) as Record<string, unknown>;
    // Top-level scalars, not nested under diagnostics: producer history's
    // normalizeHistoryMetadata drops nested objects, and the durable
    // activation-gate ledger reads these keys from worker_producer_history.
    expect(parsed.mxLedgerV).toBe(1);
    expect(parsed.mxLedgerKind).toBe("A");
    expect(parsed.mxLedgerCycle).toBe(1_787_120_160);
    expect(parsed.mxLedgerParts).toBe(2);
    expect(parsed.mxLedger0).toBe(chunk);
    expect(parsed.mxLedger1).toBe(chunk);
  });

  it("preserves the terminal arbitration scalars outside diagnostics", () => {
    const evidence = { schedulerAttemptKey: `scheduled-child:${"a".repeat(64)}`,
      schedulerTerminalSource: "synthetic", schedulerTerminalToken: "contender-token",
      childDisposition: "execution_unknown" };
    const source = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`diagnostic${index}`, "x".repeat(1000)]));
    const result = compactCronMetadataForPersistence(JSON.stringify({ ...source, ...evidence }));
    expect(result.compacted).toBe(true);
    expect(JSON.parse(result.metadata!)).toMatchObject(evidence);
  });

  it("leaves metadata at the inclusive byte boundary unchanged and admits multibyte diagnostics below it", () => {
    const metadata = JSON.stringify({ payload: "x".repeat(DEFAULT_CRON_METADATA_BUDGET_BYTES - 14) });
    expect(new TextEncoder().encode(metadata).length).toBe(DEFAULT_CRON_METADATA_BUDGET_BYTES);
    expect(compactCronMetadataForPersistence(metadata)).toMatchObject({ metadata, compacted: false });
    const result = compactCronMetadataForPersistence(JSON.stringify({ payload: "\u{1F4B0}".repeat(3_000) }));
    expect(result.compacted).toBe(true);
    expect(result.persistedBytes).toBeLessThanOrEqual(DEFAULT_CRON_METADATA_BUDGET_BYTES);
  });

  it("preserves every consumer contract at its original path while reducing adapter diagnostics", () => {
    const evidence = {
      reason: "source-incomplete", reasons: ["source-incomplete"], mode: "daily",
      outputPublishedAt: null, stale: [{ producerJob: "sync-test", publishedAt: 123, thresholdSec: 600 }],
      resourcePressure: buildResourcePressure(), retentionTruncated: true, truncated: true,
      d1Cost: { rowsRead: 123, rowsWritten: 4 }, breakerKeys: ["live-reserves:coin-a"],
      quality: { sources: { feed: { reasons: ["partial"] } } },
      sourceCoverage: { comparisonAnchorFreshness: { staleAnchorExamples: [{ stablecoinId: "coin-a" }] } },
      persistence: { skipped: false, generationId: "generation-a" }, coverageOutcomeCounts: { quiet: 2 },
      activePriceCoverage: { missingActiveIds: ["coin-a"], missingActiveState: [["coin-a", 5, 123]] },
      onchainPartition: { candidates: 12, entered: 1, retained: 1, carried: 1, divergent: 2,
        unreadable: 3, deadlineSkipped: 4, carryExpired: 1, divergences: [{ id: "coin-a", ratio: 1.2 }], divergencesTruncated: 1 },
      activePublicationCoverage: { missingActiveIds: ["coin-a"], complete: false },
      publicationStats: { pysInputsPersistedCount: 3, pysInputsNullCount: 1 },
      apiErrorConfigs: [{ configKey: "ethereum-test" }],
    };
    const result = compactCronMetadataForPersistence(JSON.stringify({ ...evidence,
      adapterLatency: { groups: Array.from({ length: 1_000 }, () => ({ adapterKey: "test", elapsedMs: 10 })) },
    }));
    expect(result.compacted).toBe(true);
    expect(result.persistedBytes).toBeLessThanOrEqual(DEFAULT_CRON_METADATA_BUDGET_BYTES);
    expect(JSON.parse(result.metadata!)).toMatchObject(evidence);
    expect(JSON.parse(result.metadata!).d1Cost).toEqual(evidence.d1Cost);
    expect(JSON.parse(result.metadata!).adapterLatency).toEqual({ groupsCount: 1_000 });
  });

  it("retains complete watchdog generation evidence under the documented per-job exception", () => {
    const stale = Array.from({ length: 80 }, (_, index) => ({
      laneKey: "dexLiquidity", cacheKey: "dex-liquidity", producerJob: `producer-${index}`,
      ageSeconds: 7201, publishedAt: 1000, generationId: `generation-${index}`, assessedAt: 8201,
      thresholdSec: 7200, producerThresholdSec: 7200, endpointThresholdSec: 14400,
      availabilityThresholdSec: 14400, availabilityImpacting: false,
    }));
    const sources = { freshness: { observedAt: 8201, status: "degraded", metadata: { stale } } };
    const result = compactCronMetadataForPersistence(JSON.stringify({ sources, oversized: "x".repeat(70_000) }),
      undefined, "cron-sentinel");
    expect(result.persistedBytes).toBeLessThanOrEqual(getCronMetadataBudgetBytes("cron-sentinel"));
    expect(JSON.parse(result.metadata!).sources).toEqual(sources);
  });

  it.each([undefined, "cron-sentinel"])("retains over-budget consumer evidence with an explicit marker and warning (%s)", (job) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stale = Array.from({ length: 3_000 }, () => ({ generationId: "generation-a" }));
    const result = compactCronMetadataForPersistence(JSON.stringify({ stale, outputPublishedAt: null,
      payload: "optional".repeat(10_000) }), undefined, job);
    expect(result.persistedBytes).toBeGreaterThan(getCronMetadataBudgetBytes(job));
    expect(result.persistedBytes).toBe(new TextEncoder().encode(result.metadata!).length);
    const parsed = JSON.parse(result.metadata!);
    expect(parsed.stale).toEqual(stale);
    expect(parsed.outputPublishedAt).toBeNull();
    expect(parsed.persistenceCompaction).toMatchObject({ overBudget: true,
      budgetBytes: getCronMetadataBudgetBytes(job), retainedTopLevelDiagnostics: 0,
      omittedTopLevelDiagnostics: 1 });
    expect(parsed.diagnostics).toEqual({});
    expect(warn).toHaveBeenCalledExactlyOnceWith("[cron-metadata] Consumer evidence exceeds persistence budget", {
      job: job ?? "default", budgetBytes: getCronMetadataBudgetBytes(job), persistedBytes: result.persistedBytes,
    });
  });
});

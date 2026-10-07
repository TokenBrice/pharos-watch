import { describe, expect, it } from "vitest";
import {
  compactCronMetadataForPersistence,
  MAX_PERSISTED_CRON_METADATA_BYTES,
} from "../cron-metadata-persistence";
import { buildResourcePressure } from "../cron-resource-pressure";

describe("compactCronMetadataForPersistence", () => {
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

  it("keeps metadata unchanged when it is below the global ceiling", () => {
    const metadata = JSON.stringify({ reason: "published", rowsWritten: 12 });
    expect(compactCronMetadataForPersistence(metadata)).toEqual({
      metadata,
      originalBytes: new TextEncoder().encode(metadata).length,
      persistedBytes: new TextEncoder().encode(metadata).length,
      compacted: false,
    });
  });

  it("compacts oversized rich results below 64 KiB while retaining bounded diagnostics", () => {
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
      diagnostics: Record<string, unknown>;
    };

    expect(result.compacted).toBe(true);
    expect(result.originalBytes).toBeGreaterThan(MAX_PERSISTED_CRON_METADATA_BYTES);
    expect(result.persistedBytes).toBeLessThanOrEqual(MAX_PERSISTED_CRON_METADATA_BYTES);
    expect(parsed.reason).toBe("stablecoin-publication");
    expect(parsed.persistenceCompaction.originalBytes).toBe(result.originalBytes);
    expect(parsed.diagnostics).toMatchObject({
      rowsRead: 410,
      rowsWritten: 364,
      providerDiagnostics: { count: 5_000 },
      fullAssets: { count: 410 },
      coverage: {
        expectedCount: 364,
        publishedCount: 364,
        omittedIdsCount: 100,
      },
    });
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
});

import { describe, expect, it } from "vitest";

import { decodeMeasuredLedgerRecord } from "@shared/lib/measured-execution-ledger";
import { buildDexLiquidityCronMetadata } from "../dex-liquidity/orchestrator-metadata";
import { initLiquidityFallbackCounters } from "../dex-liquidity/pool-helpers";
import type { DexLiquidityPostScoreAnalysis } from "../dex-liquidity/orchestrator-analysis";
import type { DexPricePersistenceDiagnostics, DexShadowAdmissionDiagnostics } from "../dex-liquidity/scoring";

function metadataParams(shadowAdmission: DexShadowAdmissionDiagnostics | null) {
  return {
    rowsRead: 4_000,
    rowsWritten: 300,
    stagedPoolsMerged: 0,
    stagedPoolsSkipped: 0,
    stagedPoolsSkippedByExactIdentity: 0,
    stagedPoolsSkippedByUniqueDerivedIdentity: 0,
    stagedPoolsSkippedByOptionalWildcardIdentity: 0,
    stagedPoolsSkippedByAuthoritativeProtocol: 0,
    stagedPoolSkipDimensions: [],
    poolRejections: [],
    directApiSourceSummary: {
      acceptedByProtocolChain: {},
      excludedByReason: {},
      circuitEvents: [],
      sourceWarnings: [],
      pagination: [],
    },
    sourceCoverage: {} as DexLiquidityPostScoreAnalysis["sourceCoverage"],
    challengerPublication: { publishedStablecoins: 0, skippedStablecoins: 0, missingTables: false },
    dexPriceDiagnostics: {} as DexPricePersistenceDiagnostics,
    failedSources: [],
    fallbackSignals: [],
    fallbackCounters: initLiquidityFallbackCounters(),
    shadowAdmission,
    persistence: {
      placeholderCount: 0,
      inactiveMetricRowsSkipped: 0,
      orphanRowsDeleted: 0,
      orphanCleanupFailed: false,
    },
    historicalSnapshot: {
      snapshotRowsWritten: 0,
      skipped: false,
      writeFailed: false,
      historyRowsPruned: 0,
      retentionPruneFailed: false,
    },
  };
}

/** Mirrors normalizeHistoryMetadata: only top-level scalars reach metadata_json. */
function survivingScalars(metadata: Record<string, unknown>): Record<string, unknown> {
  const scalars: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || typeof value === "number" || typeof value === "boolean") scalars[key] = value;
    else if (typeof value === "string") scalars[key] = value.slice(0, 240);
  }
  return scalars;
}

describe("dex liquidity cron metadata shadow admission emission", () => {
  const shadowAdmission: DexShadowAdmissionDiagnostics = {
    cycle: 1_700_000_100,
    targetGenerationId: "dex-shadow-measured-targets-1700000100",
    cohorts: {
      "uniswap-v3-quoter-v2@bsc": { eligible: 1, rejected: 0, published: 1, gateReason: null },
      "ethereum:76f08b0d:usd1-world-l": {
        eligible: 1,
        rejected: 1,
        published: 0,
        gateReason: "curve-stableswap:exact-pool-join-unresolved",
      },
      "ethereum:9ce4aaaa:dola-inverse": { eligible: 1, rejected: 0, published: 0, gateReason: "shadow-target-publication-failed" },
    },
  };

  it("emits the Phase 0.1 per-cohort report beside the existing diagnostics", () => {
    const metadata = buildDexLiquidityCronMetadata(metadataParams(shadowAdmission));
    expect(metadata.shadowAdmissionReport).toMatchObject({
      cycle: 1_700_000_100,
      targetGenerationId: "dex-shadow-measured-targets-1700000100",
      cohorts: {
        "uniswap-v3-quoter-v2@bsc": { state: "target-published" },
        "ethereum:76f08b0d:usd1-world-l": { state: "eligible-source-rejected" },
        "ethereum:9ce4aaaa:dola-inverse": { state: "target-publication-failed" },
      },
    });
    // Phase 0.2 seam remains intact next to the new report.
    expect(metadata.fallbackCounters).toBeDefined();
  });

  it("emits Record A chunks that survive the producer-history scalar filter", () => {
    const metadata = buildDexLiquidityCronMetadata(metadataParams(shadowAdmission));
    const persisted = survivingScalars(metadata);
    const serialized = JSON.stringify(persisted);
    expect(serialized.length).toBeLessThanOrEqual(2_000);
    const decoded = decodeMeasuredLedgerRecord(persisted);
    expect(decoded).toEqual({
      kind: "A",
      cycle: 1_700_000_100,
      targetGenerationId: "dex-shadow-measured-targets-1700000100",
      solanaTargetGenerationId: null,
      tronTargetGenerationId: null,
      cohorts: shadowAdmission.cohorts,
      truncatedCohorts: 0,
    });
  });

  it("emits no ledger keys or report on non-shadow-publication runs", () => {
    const metadata = buildDexLiquidityCronMetadata(metadataParams(null));
    expect(metadata.shadowAdmissionReport).toBeUndefined();
    expect(Object.keys(metadata).some((key) => key.startsWith("mxLedger"))).toBe(false);
  });
});

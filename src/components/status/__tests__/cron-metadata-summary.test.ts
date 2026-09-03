import { describe, expect, it } from "vitest";
import { summarizeCronMetadata } from "../cron-metadata-summary";

describe("summarizeCronMetadata", () => {
  it("surfaces when the redemption missing-capacity tail is within tolerance", () => {
    const summary = summarizeCronMetadata("sync-redemption-backstops", {
      synced: 146,
      configured: 146,
      resolved: 144,
      unresolved: 2,
      coverageRatio: 144 / 146,
      unresolvedMissingCapacity: 2,
      unresolvedCritical: 0,
      missingCapacityOkThreshold: 2,
      dynamic: 5,
      estimated: 139,
      static: 2,
    });

    expect(summary).toContain("missing-capacity tail 2 within 2-coin tolerance");
  });

  it("surfaces when the redemption missing-capacity tail exceeds tolerance", () => {
    const summary = summarizeCronMetadata("sync-redemption-backstops", {
      synced: 101,
      configured: 101,
      resolved: 98,
      unresolved: 3,
      coverageRatio: 98 / 101,
      unresolvedMissingCapacity: 3,
      unresolvedCritical: 0,
      missingCapacityOkThreshold: 2,
      dynamic: 0,
      estimated: 98,
      static: 3,
    });

    expect(summary).toContain("missing-capacity tail 3 exceeds 2-coin tolerance");
  });

  it("surfaces redemption availability impairments", () => {
    const summary = summarizeCronMetadata("sync-redemption-backstops", {
      synced: 148,
      configured: 148,
      resolved: 147,
      unresolved: 1,
      unresolvedMissingCapacity: 0,
      unresolvedCritical: 0,
      availabilityDegraded: 1,
      dynamic: 5,
      estimated: 142,
      static: 1,
    });

    expect(summary).toContain("availability impaired 1");
  });

  it("surfaces telegram safety source suppression metadata", () => {
    const summary = summarizeCronMetadata("dispatch-telegram-alerts", {
      safetyAlertSourceState: "wrong-generation",
      safetyAlertSourceAgeSeconds: 420,
      safetyAlertsSuppressed: true,
      safetyAlertSourceGeneration: "legacy-generation",
    });

    expect(summary).toContain("safety source wrong-generation");
    expect(summary).toContain("safety alerts suppressed");
    expect(summary).toContain("source age 420s");
  });

  it("surfaces snapshot supply coverage blockers", () => {
    expect(summarizeCronMetadata("snapshot-supply", {
      reason: "partial_snapshot_blocked",
      validRows: 343,
      expectedCount: 344,
      invalidSupplyIds: ["deuro-deuro"],
      missingActiveIds: ["deuro-deuro"],
    })).toEqual([
      "reason partial_snapshot_blocked",
      "active supply coverage 343/344",
      "invalid supply deuro-deuro",
      "missing active deuro-deuro",
    ]);
  });

  it("surfaces ambiguous Telegram effects and their age", () => {
    const summary = summarizeCronMetadata("telegram-degradation-watchdog", {
      pendingBacklog: {
        triggered: true,
        executionUnknown: 15,
        oldestExecutionUnknownAgeSec: 65_203,
        detail: "executionUnknown=15, sustainedSec=61200",
      },
      safetySource: { triggered: false },
      zeroSend: { triggered: false },
    });

    expect(summary).toContain("pending-delivery incident triggered");
    expect(summary).toContain("execution unknown 15");
    expect(summary).toContain("oldest ambiguous effect 65203s");
  });

  it("separates runtime pressure from scheduled-slot abandonment", () => {
    expect(summarizeCronMetadata("cron-duration-watchdog", {
      runtimeBreaching: [],
      slotAbandonmentBreaching: ["halfHourlyOffset"],
    })).toEqual([
      "runtime breaches none",
      "slot abandonment halfHourlyOffset",
    ]);
  });

  it("renders sentinel source status and nested duration metadata", () => {
    expect(summarizeCronMetadata("cron-sentinel", {
      mode: "daily",
      sources: {
        growth: { status: "ok", itemCount: 42 },
        duration: {
          status: "degraded",
          metadata: {
            runtimeBreaching: ["sync-dex-liquidity"],
            slotAbandonmentBreaching: [],
          },
        },
      },
    })).toEqual([
      "mode daily",
      "sources growth ok, duration degraded",
      "runtime breaches sync-dex-liquidity",
      "slot abandonment none",
    ]);
  });

  it("surfaces live-reserve artifact cleanup counts and warnings", () => {
    const summary = summarizeCronMetadata("sync-live-reserves", {
      synced: 100,
      failed: 0,
      skipped: 0,
      total: 100,
      artifactCleanup: {
        syncStateDeleted: 2,
        compositionDeleted: 1,
        breakerCacheDeleted: 3,
      },
      artifactCleanupWarningCount: 1,
    });

    expect(summary).toContain("artifact cleanup deleted sync 2, composition 1, breakers 3");
    expect(summary).toContain("artifact cleanup warnings 1");
  });

  it("surfaces live-reserve cursor tail state", () => {
    const summary = summarizeCronMetadata("sync-live-reserves", {
      synced: 10,
      failed: 0,
      skipped: 3,
      total: 13,
      runBudgetTruncated: true,
      deferredCoins: 3,
      nextCursorStablecoinId: "usdc-circle",
      cursorTailState: "complete",
      runBudgetTruncationCount: 2,
    });

    expect(summary).toContain("run budget truncated; deferred 3, resumes at usdc-circle");
    expect(summary).toContain("cursor tail complete, truncations 2");
  });
});

import { describe, expect, it } from "vitest";
import { summarizeCronMetadata } from "../cron-metadata-summary";

describe("summarizeCronMetadata", () => {
  it("does not invent numeric streaks when self-check counters are unavailable", () => {
    const summary = summarizeCronMetadata("status-self-check", {
      discrepancyStreak: null, probeFailureStreak: null, reason: "status-self-check-persistence-failed",
    });
    expect(summary.some((line) => line.includes("streak"))).toBe(false);
    expect(summary).toContain("reason status-self-check-persistence-failed");
  });

  it("separates observed global excess from named source quarantine", () => {
    expect(summarizeCronMetadata("sync-dex-liquidity", {
      sourceCoverage: {
        globalProtocolOverCapUsd: 60,
        protocolTvlQuarantine: { reason: "fallback-protocol-tvl-exceeds-headroom", poolCount: 1, tvlUsd: 50 },
      },
    })).toEqual([
      "protocol TVL quarantine 1 pools, 50 TVL excluded (fallback-protocol-tvl-exceeds-headroom)",
      "global protocol TVL excess 60 observed (not reduced)",
    ]);
  });
  it("summarizes unknown-job resource evidence without inventing heap or platform outcomes", () => {
    const resourcePressure = {
      phase: "read", observedAt: 100, bodyCapBytes: 4, cacheCapBytes: null,
      cacheEntryCapBytes: null, maxConcurrentDecodes: null, inputCapBytes: null, catalogMaxAssets: null,
      intakeBytes: 0, cacheBytes: null, rejectedBodies: 0, inputBytes: null, catalogAssets: null,
      intakeBasis: "actual-stream", cacheBasis: "unavailable", guard: "within-policy",
      platformOutcome: null, platformOutcomeSource: null,
      heapUsedBytes: null, heapUnavailableReason: "workers-runtime-no-heap-api",
    };
    expect(summarizeCronMetadata("unknown", { resourcePressure })).toEqual([
      "resource read @100: within-policy",
      "intake 0 bytes (actual-stream); estimated cache unavailable (unavailable)",
      "rejected bodies 0; platform unavailable; heap unavailable",
    ]);
    expect(summarizeCronMetadata("unknown", { resourcePressure: { heapUsedBytes: 0 } }))
      .toEqual(["resource evidence unavailable"]);
  });

  it("uses column reasons for unknown and metadata-free jobs", () => {
    expect(summarizeCronMetadata("unknown", undefined, "column-only")).toEqual(["reason column-only"]);
    expect(summarizeCronMetadata("unknown", { reason: "legacy" }, "canonical")).toEqual(["reason canonical"]);
    expect(summarizeCronMetadata("unknown", { reason: "legacy" })).toEqual(["reason legacy"]);
    expect(summarizeCronMetadata("snapshot-supply", { reason: "legacy" }, "canonical"))
      .toEqual(["reason canonical"]);
    expect(summarizeCronMetadata("unknown", undefined)).toEqual([]);
  });

  it("appends canonical findings without replacing specialized summaries or duplicating reasons", () => {
    const quality = { reason: "partial-input", reasons: ["partial-input", "coverage-gap"], sources: { reserves: { reason: "stale" } } };
    expect(summarizeCronMetadata("unknown", { quality, reason: "execution-failed" })).toEqual([
      "finding partial-input", "finding coverage-gap", "finding reserves:stale", "reason execution-failed",
    ]);
    const known = summarizeCronMetadata("snapshot-supply", { reason: "partial_snapshot_blocked", quality });
    expect(known.filter((line) => line === "reason partial_snapshot_blocked")).toHaveLength(1);
    expect(known).toContain("finding reserves:stale");
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

  describe.each(["cron-duration-watchdog", "cron-sentinel"])("%s breach evidence", (job) => {
    const summarize = (metadata: Record<string, unknown>) => summarizeCronMetadata(
      job,
      job === "cron-sentinel" ? { sources: { duration: { status: "ok", metadata } } } : metadata,
    );

    it.each([undefined, null, "invalid", {}, [null], [""], [" "], ["slow-job", 42]].map((value) => ({ value })))(
      "does not call missing or malformed arrays empty: $value",
      ({ value }) => {
        expect(summarize({ runtimeBreaching: value, slotAbandonmentBreaching: value })).toEqual(expect.arrayContaining([
          "runtime breaches unavailable", "slot abandonment unavailable",
        ]));
        expect(summarize({ runtimeBreaching: value, slotAbandonmentBreaching: value }).join(" ")).not.toContain("none");
      },
    );

    it("reserves none for validated empty arrays", () => {
      expect(summarize({ runtimeBreaching: [], slotAbandonmentBreaching: [] })).toEqual(expect.arrayContaining([
        "runtime breaches none", "slot abandonment none",
      ]));
    });

    it("keeps each partially available dimension independent", () => {
      expect(summarize({ runtimeBreaching: ["slow-job"] })).toEqual(expect.arrayContaining([
        "runtime breaches slow-job", "slot abandonment unavailable",
      ]));
      expect(summarize({ slotAbandonmentBreaching: ["missed-slot"] })).toEqual(expect.arrayContaining([
        "runtime breaches unavailable", "slot abandonment missed-slot",
      ]));
    });
  });

  it.each([
    { status: "error", metadata: { reason: "duration-query-failed" } },
    { status: "missing", reason: "source-state-missing", metadata: null },
    { status: "error", error: "Invalid persisted sentinel source state" },
  ])("preserves nested sentinel source status and reason: $status", (duration) => {
    const summary = summarizeCronMetadata("cron-sentinel", { sources: { duration } });
    expect(summary).toContain(`sources duration ${duration.status} (${duration.reason ?? duration.metadata?.reason ?? duration.error})`);
    expect(summary.join(" ")).not.toContain("none");
  });

});

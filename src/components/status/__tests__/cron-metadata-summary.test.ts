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

});

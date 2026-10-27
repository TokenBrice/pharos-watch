import { describe, expect, it } from "vitest";
import type {
  DigestEditorialCandidate,
  DigestGradeTransition,
  DigestInputData,
  DigestSafetyContext,
} from "@shared/types/digest";
import type {
  SafetyScoreV8PublicationIdentity,
  SafetyScoreV9PublicationIdentity,
} from "@shared/types/safety-score-publication";
import { buildWeeklyInputData } from "../weekly-recap/input-data";
import type { DailyDigestSourceRow } from "../weekly-recap/types";
import { buildWeeklyPrompt } from "../weekly-recap/prompt";

const START_SEC = 1_786_665_600;
const SAFETY_START_SEC = 1_784_916_000;
const SAFETY_PERIODS = {
  current: { start: SAFETY_START_SEC - 86_400, end: SAFETY_START_SEC + 6 * 86_400 },
  prior: { start: SAFETY_START_SEC - 8 * 86_400, end: SAFETY_START_SEC - 86_400 },
};

const v8Identity: SafetyScoreV8PublicationIdentity = {
  model: "v8",
  schemaVersion: 1,
  methodologyVersion: "8.17",
  evaluationBuildDigest: "a".repeat(64),
  baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
  publicationGenerationId: "report-cards:v8:1",
};

function candidate(
  id: string,
  kind: DigestEditorialCandidate["kind"],
  impactScore: number,
  symbol: string,
): DigestEditorialCandidate {
  return {
    id,
    kind,
    title: `${symbol} ${kind} signal`,
    symbols: [symbol],
    impactScore,
    novelty: "worsening",
    confidence: "high",
    artifactRisk: "low",
    headlineFacts: [`canonical impact ${impactScore}`],
    whyItMatters: "Fixture canonical candidate.",
  };
}

function digestInput(overrides: Partial<DigestInputData> = {}): DigestInputData {
  return {
    totalMcapUsd: 1_000_000_000,
    supplyCoverage: { complete: true, observedCount: 1, unavailableCount: 0 },
    mcap7dDelta: 0,
    activeDepegCount: 0,
    topDepegs: [],
    biggestSupplyChange: null,
    stabilityIndex: {
      score: 90,
      band: "BEDROCK",
      components: { severity: 0, breadth: 0, trend: 0 },
    },
    yesterdayIndex: null,
    blacklistActivity: {
      eventCount: 0,
      totalAmountUsd: 0,
      unpricedEventCount: 0,
      editorialEligible: false,
      topEvents: [],
    },
    ...overrides,
  };
}

function row(index: number, overrides: Partial<DigestInputData> = {}): DailyDigestSourceRow {
  return {
    generated_at: START_SEC + index * 86_400,
    digest_title: `Day ${index + 1}`,
    digest_text: "Daily fixture.",
    input_data: JSON.stringify(digestInput(overrides)),
  };
}

describe("weekly recap canonical candidate aggregation", () => {
  it("uses full DEWS totals for weekly maxima and counts regardless of presentation limits", () => {
    for (const limit of [0, 1, 5]) {
      const weekly = buildWeeklyInputData(Array.from({ length: 7 }, (_, index) => row(index, {
        dewsStress: {
          bandCounts: { calm: 0, watch: 0, alert: 8, warning: 0, danger: 0 },
          yesterdayBandCounts: { calm: 0, watch: 8, alert: 0, warning: 0, danger: 0 },
          alertPlusMcapUsd: (index + 1) * 100e6,
          alertPlusSupplyCoverage: { complete: true, observedCount: 8, unavailableCount: 0 },
          bandChangeCount: 8,
          elevatedCoins: Array.from({ length: limit }, () => ({ symbol: "COIN", band: "ALERT", score: 65, mcapUsd: 20e6 })),
          bandChanges: Array.from({ length: limit }, () => ({ symbol: "COIN", from: "WATCH", to: "ALERT", score: 65, topDriver: "pool" })),
        },
      })))!;
      expect(weekly.weeklySignals).toMatchObject({ maxAlertPlusMcapUsd: 700e6, totalDewsBandChanges: 56 });
      expect(buildWeeklyPrompt(weekly)).toContain("max ALERT+ mcap $700.00M; band-change observations 56");
    }
  });

  it("keeps unavailable DEWS market caps null, ordered after observed caps, with observed zero preserved", () => {
    const change = (symbol: string, score: number, mcapUsd?: number) => ({
      symbol, from: "WATCH", to: "ALERT", score, topDriver: "pool", ...(mcapUsd === undefined ? {} : { mcapUsd }),
    });
    const weekly = buildWeeklyInputData(Array.from({ length: 7 }, (_, index) => row(index, {
      dewsStress: {
        bandCounts: { calm: 0, watch: 0, alert: 1, warning: 0, danger: 0 },
        yesterdayBandCounts: null,
        elevatedCoins: [],
        bandChanges: index === 0
          ? [change("NOCAP_LOW", 50), change("NOCAP_HIGH", 90), change("ZERO", 70, 0), change("BIG", 60, 5e9), change("TIE_A", 80, 1e9), change("TIE_B", 85, 1e9)]
          : index === 1 ? [change("EXTRA1", 10, 1), change("EXTRA2", 11, 2), change("EXTRA3", 12, 3)] : [],
      },
    })))!;
    const rows = weekly.weeklySignals.topDewsChanges;
    expect(rows.map((r) => r.symbol)).toEqual(["BIG", "TIE_B", "TIE_A", "EXTRA3", "EXTRA2", "EXTRA1", "ZERO"]);
    expect(rows.find((r) => r.symbol === "ZERO")?.mcapUsd).toBe(0);

    const capped = buildWeeklyInputData(Array.from({ length: 7 }, (_, index) => row(index, {
      dewsStress: {
        bandCounts: { calm: 0, watch: 0, alert: 1, warning: 0, danger: 0 },
        yesterdayBandCounts: null, elevatedCoins: [],
        bandChanges: index === 0 ? [change("NOCAP_LOW", 50), change("NOCAP_HIGH", 90), change("OBS", 60, 2e6)] : [],
      },
    })))!;
    expect(capped.weeklySignals.topDewsChanges.map((r) => [r.symbol, r.mcapUsd])).toEqual([
      ["OBS", 2e6], ["NOCAP_HIGH", null], ["NOCAP_LOW", null],
    ]);
    const prompt = buildWeeklyPrompt(capped);
    expect(prompt).toContain("NOCAP_HIGH: WATCH -> ALERT, score 90, mcap unavailable (supply-unavailable), driver pool");
    expect(prompt).not.toContain("NOCAP_HIGH: WATCH -> ALERT, score 90, $0");
    expect(prompt).toContain("OBS: WATCH -> ALERT, score 60, $2.00M mcap");
  });

  it("carries a stored null seven-day change into the weekly evidence without restoring zero", () => {
    const rows = [0, 1, 2, 3, 4, 5, 6].map((index) => row(index, {
      mcap7dDelta: null, mcap7dDeltaCoverage: { coveredCoins: 0, totalCoins: 3, coveredMcapUsd: 0 },
    }));
    const weekly = buildWeeklyInputData(rows)!;
    expect(weekly.dailyDigests.map((digest) => digest.inputData.mcap7dDelta)).toEqual(Array(7).fill(null));
    expect(buildWeeklyPrompt(weekly)).not.toContain("7-day market cap change: +$0");
  });

  it.each(["legacy", "partial"] as const)("withholds the weekly full ALERT+ maximum for %s daily census evidence", (kind) => {
    const weekly = buildWeeklyInputData(Array.from({ length: 7 }, (_, index) => row(index, {
      dewsStress: {
        bandCounts: { calm: 0, watch: 0, alert: 6, warning: 0, danger: 0 },
        yesterdayBandCounts: null, bandChanges: [],
        elevatedCoins: [{ symbol: "COIN", band: "ALERT", score: 65, mcapUsd: 20e6 }],
        ...(kind === "partial" ? {
          alertPlusMcapUsd: 100e6,
          alertPlusSupplyCoverage: { complete: false, observedCount: 5, unavailableCount: 1 },
          bandChangeCount: null,
        } : {}),
      },
    })))!;
    expect(weekly.weeklySignals).toMatchObject({ maxAlertPlusMcapUsd: null, totalDewsBandChanges: null });
    expect(buildWeeklyPrompt(weekly)).toContain("max ALERT+ mcap unavailable");
    expect(buildWeeklyPrompt(weekly)).not.toContain("max ALERT+ mcap $");
  });
  it("keeps unavailable outcomes separate from resolved weekly accountability", () => {
    const statuses = ["hit", "missed", "expired", "pending", "unavailable"] as const;
    const weekly = buildWeeklyInputData(statuses.map((status, index) => row(index, {
      forwardLookOutcomes: [{ id: `outcome:${index}`, triggerId: "depeg", label: "Depeg", status, detail: "Evidence result" }],
    })));
    expect(weekly?.forwardLookScoreboard).toEqual({
      hit: 1, missed: 1, expired: 1, pending: 1, unavailable: 1,
    });
  });

  it("retains a weekly scoreboard when every outcome lacks evidence", () => {
    const weekly = buildWeeklyInputData(Array.from({ length: 5 }, (_, index) => row(index, {
      forwardLookOutcomes: [{ id: `outcome:${index}`, triggerId: "depeg", label: "Depeg", status: "unavailable", detail: "Collector unavailable" }],
    })));
    expect(weekly?.forwardLookScoreboard).toEqual({
      hit: 0, missed: 0, expired: 0, pending: 0, unavailable: 5,
    });
  });

  it("keeps a zero market-cap base undefined rather than inventing infinite growth", () => {
    const weekly = buildWeeklyInputData(Array.from({ length: 5 }, (_, index) => row(index, {
      totalMcapUsd: index * 1_000_000,
    })));
    expect(weekly?.mcapRange).toEqual({ start: 0, end: 4_000_000, netChange: 4_000_000, pctChange: null });
    expect(buildWeeklyPrompt(weekly!)).toContain("(N/A)");
    expect(buildWeeklyPrompt(weekly!)).not.toContain("Infinity");
  });

  it("computes prior-week deltas from independent daily values", () => {
    const current = Array.from({ length: 5 }, (_, index) => row(index, { totalMcapUsd: 200_000_000 }));
    const prior = Array.from({ length: 5 }, (_, index) => row(index - 7, {
      totalMcapUsd: 100_000_000,
      stabilityIndex: { score: 80, band: "BEDROCK", components: { severity: 0, breadth: 0, trend: 0 } },
    }));
    expect(buildWeeklyInputData(current, prior)?.weekOverWeekDeltas).toMatchObject({
      mcap: { current: 200_000_000, prior: 100_000_000, deltaPct: 100 },
      psi: { current: 90, prior: 80, delta: 10 },
      dataCoverage: { currentDays: 5, priorDays: 5 },
    });
  });

  it.each([5, 7])("keeps %s prior editions without PSI unavailable while preserving market-cap comparisons", (days) => {
    const current = Array.from({ length: 7 }, (_, index) => row(index, { totalMcapUsd: 200_000_000 }));
    const prior = Array.from({ length: days }, (_, index) => row(index - 7, {
      totalMcapUsd: 100_000_000, stabilityIndex: null,
    }));
    const weekly = buildWeeklyInputData(current, prior)!;
    expect(weekly.weekOverWeekDeltas).toMatchObject({
      mcap: { current: 200_000_000, prior: 100_000_000, deltaPct: 100 },
      psi: { current: 90, prior: null, delta: null, unavailableReason: "psi-observations-missing" },
      psiDominantBand: { current: "BEDROCK", prior: null },
      dataCoverage: { currentPsiDays: 7, priorPsiDays: 0 },
    });
    const prompt = buildWeeklyPrompt(weekly);
    expect(prompt).toContain("PSI midpoint: current 90.0 / prior unavailable / delta unavailable (psi-observations-missing)");
    expect(prompt).toContain("PSI dominant band: current BEDROCK / prior unavailable");
    expect(prompt).not.toContain("delta +90.0");
  });

  it("calculates depeg spike metrics from all observations independently of impact representatives", () => {
    const rows = Array.from({ length: 7 }, (_, index) => row(index));
    rows[0] = row(0, { topDepegs: [
      { stablecoinId: "coin", symbol: "COIN", startedAt: START_SEC, bps: -100, mcapUsd: 1_000_000_000 },
    ] });
    rows[1] = row(1, { topDepegs: [
      { stablecoinId: "coin", symbol: "COIN", startedAt: START_SEC, bps: -500, mcapUsd: 10_000_000 },
      { stablecoinId: "other", symbol: "OTHER", startedAt: START_SEC, bps: -400, mcapUsd: 10_000_000 },
    ] });
    const weekly = buildWeeklyInputData(rows)!;
    expect(weekly.weeklySignals.topDepegSignals.find((signal) => signal.symbol === "COIN")?.bps).toBe(100);
    expect(weekly.spikeMetrics.maxDepeg).toMatchObject({ symbol: "COIN", bps: 500 });
    expect(weekly.spikeMetrics.maxDepegImpact).toMatchObject({ symbol: "COIN", bps: 100, mcapUsd: 1_000_000_000 });
  });

  it("uses the magnitude of signed recovered depeg peaks for the weekly maximum", () => {
    const rows = Array.from({ length: 7 }, (_, index) => row(index));
    rows[0] = row(0, { resolvedDepegs: [
      { stablecoinId: "coin", symbol: "COIN", startedAt: START_SEC, peakBps: -900, mcapUsd: 10_000_000, durationHours: 5 },
    ] });
    rows[1] = row(1, { topDepegs: [{ symbol: "OTHER", bps: 400, mcapUsd: 10_000_000 }] });
    expect(buildWeeklyInputData(rows)?.spikeMetrics.maxDepeg).toMatchObject({ symbol: "COIN", bps: 900, kind: "resolved" });
  });

  it("rejects malformed grade transitions while preserving comparable valid transitions", () => {
    const identity = {
      model: "v8" as const, schemaVersion: 1 as const, methodologyVersion: "8.17",
      evaluationBuildDigest: "a".repeat(64), baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
      publicationGenerationId: "report-cards:v8:test",
    };
    const rows = Array.from({ length: 7 }, (_, index) => row(index));
    const input = JSON.parse(rows[2]!.input_data);
    input.gradeTransitions = [
      { mcapUsd: 1_000_000 },
      {
        historyId: "history:usdt:1", recordedAt: rows[2]!.generated_at, model: "v8", safetyScoreIdentity: identity,
        symbol: "USDT", fromGrade: "A", toGrade: "B", fromScore: 90, toScore: 80,
        currentDimensions: { peg: 95, liq: 80, resilience: null, decentralization: null }, mcapUsd: 2_000_000,
      },
    ];
    rows[2] = { ...rows[2]!, input_data: JSON.stringify(input) };
    const weekly = buildWeeklyInputData(rows, [], {
      status: "available", expectedModel: "v8", identity, publishedAt: START_SEC, reason: null,
    }, {
      current: { start: START_SEC, end: START_SEC + 7 * 86_400 },
      prior: { start: START_SEC - 7 * 86_400, end: START_SEC },
    });
    expect(weekly?.weeklySignals.topGradeTransitions.map((entry) => entry.historyId)).toEqual(["history:usdt:1"]);
    expect(weekly?.gradeTransitionCount).toBeNull(); // Legacy display rows cannot establish a full census.
  });

  it("ranks fresh criticals first but makes carried criticals compete on severity ahead of suppressed signals", () => {
    const chronicStartedAt = START_SEC - 30 * 86_400;
    const freshStartedAt = START_SEC + 86_400;
    const rows = Array.from({ length: 5 }, (_, index) => row(index));
    rows[2] = row(2, {
      editorialCandidates: [
        { ...candidate("liquidity:suppressed", "liquidity", 1_000_000_000, "SUP"), suppressReason: "known bad upstream quote" },
        candidate("liquidity:large", "liquidity", 100_000_000, "BIG"),
      ],
      activeDepegCount: 2,
      topDepegs: [
        { stablecoinId: "chronic", symbol: "CHR", bps: -2500, mcapUsd: 75_000_000, startedAt: chronicStartedAt },
        { stablecoinId: "fresh", symbol: "NEW", bps: -2500, mcapUsd: 75_000_000, startedAt: freshStartedAt },
      ],
    });
    const weekly = buildWeeklyInputData(rows);
    expect(weekly?.weeklySignals.riskLeaderboard.map((entry) => entry.id)).toEqual([
      `weekly:depeg:fresh:${freshStartedAt}`,
      "weekly:liquidity:large",
      `weekly:depeg:chronic:${chronicStartedAt}`,
      "weekly:liquidity:suppressed",
    ]);
    expect(weekly?.weeklySignals.riskLeaderboard[2]).toMatchObject({ critical: true, carriedOver: true });
  });

  it("orders depeg competitors by suppression, fresh criticality, severity, and impact", () => {
    const startedAt = START_SEC + 86_400;
    const rows = Array.from({ length: 5 }, (_, index) => row(index));
    rows[2] = row(2, {
      activeDepegCount: 3,
      topDepegs: [
        { stablecoinId: "suppressed-critical", symbol: "SUP", bps: -2500, mcapUsd: 3_000_000_000, startedAt, suppressReason: "known bad upstream quote" },
        { stablecoinId: "noncritical-large", symbol: "BIG", bps: -900, mcapUsd: 5_000_000_000, startedAt },
        { stablecoinId: "critical-small", symbol: "CRIT", bps: -2500, mcapUsd: 75_000_000, startedAt },
      ],
    });
    expect(buildWeeklyInputData(rows)?.weeklySignals.riskLeaderboard.map((entry) => entry.id)).toEqual([
      `weekly:depeg:critical-small:${startedAt}`,
      `weekly:depeg:noncritical-large:${startedAt}`,
      `weekly:depeg:suppressed-critical:${startedAt}`,
    ]);
  });

  it("deduplicates repeated observations by stable depeg event identity", () => {
    const chronicStartedAt = START_SEC - 86_400;
    const rows = Array.from({ length: 7 }, (_, index) => row(index, {
      activeDepegCount: 1,
      topDepegs: [{
        stablecoinId: "chronic-usd",
        symbol: "CHR",
        bps: -(200 + index * 50),
        mcapUsd: 100_000_000,
        startedAt: chronicStartedAt,
      }],
    }));
    const last = JSON.parse(rows[6]!.input_data) as DigestInputData;
    last.activeDepegCount = 2;
    last.topDepegs.push({
      stablecoinId: "fresh-usd",
      symbol: "NEW",
      bps: -300,
      mcapUsd: 50_000_000,
      startedAt: START_SEC + 6 * 86_400 - 3_600,
    });
    rows[6] = { ...rows[6]!, input_data: JSON.stringify(last) };

    const weekly = buildWeeklyInputData(rows);

    expect(weekly?.activeDepegObservationsThisWeek).toBe(8);
    expect(weekly?.weeklySignals.topDepegSignals).toHaveLength(2);
    expect(weekly?.weeklySignals.topDepegSignals.filter((signal) => signal.symbol === "CHR")).toHaveLength(1);
    expect(weekly?.weeklySignals.topDepegSignals.find((signal) => signal.symbol === "CHR")).toMatchObject({
      bps: 500,
      eventIdentity: `chronic-usd:${chronicStartedAt}`,
      carriedOver: true,
    });
  });

  it("uses persisted daily candidate impact units for weekly yield and liquidity ranking", () => {
    const rows = Array.from({ length: 5 }, (_, index) => row(index, {
      editorialCandidates: [
        candidate("yield:coin", "yield", 321, "YLD"),
        candidate("liquidity:coin", "liquidity", 654, "LIQ"),
      ],
    }));

    const weekly = buildWeeklyInputData(rows);
    const leaderboard = weekly?.weeklySignals.riskLeaderboard ?? [];

    expect(leaderboard.filter((signal) => signal.id === "weekly:yield:coin")).toHaveLength(1);
    expect(leaderboard.find((signal) => signal.id === "weekly:yield:coin")).toMatchObject({
      impactScore: 321,
      severityScore: 321,
    });
    expect(leaderboard.find((signal) => signal.id === "weekly:liquidity:coin")).toMatchObject({
      impactScore: 654,
      severityScore: 654,
    });
  });

  it("excludes the retracted USDS liquidity ingestion and records the withheld signal", () => {
    const incidentAt = 1_787_299_523;
    const rows = Array.from({ length: 5 }, (_, index) => row(index));
    rows[4] = row(4, {
      dataQuality: {
        generatedAt: incidentAt,
        stablecoinsCacheUpdatedAt: incidentAt - 60,
        stablecoinsCacheAgeSec: 60,
        windows: {
          blacklistActivity: { label: "rolling last 24h", start: incidentAt - 86_400, end: incidentAt },
          mintBurnFlows: { label: "rolling last 24h", start: incidentAt - 86_400, end: incidentAt },
          supplyVelocity: { label: "UTC snapshots", dates: [incidentAt] },
          psi: { label: "latest sample", sampleAt: incidentAt, dailySnapshotAt: incidentAt - 300 },
        },
      },
      liquidityShifts: [
        {
          symbol: "USDS",
          currentScore: 49,
          previousScore: 59,
          scoreDelta: -10,
          currentTvl: 13_715_691,
          previousTvl: 162_283_507,
          mcapUsd: 6_711_545_483,
          tvlChangePct: -0.915,
          expectedScoreDeltaFromTvl: -11,
          coverageClass: "primary",
          coverageConfidence: 1,
        },
        {
          symbol: "YLDS",
          currentScore: 51,
          previousScore: 60,
          scoreDelta: -9,
          currentTvl: 13_720_000,
          previousTvl: 20_000_000,
          mcapUsd: 500_000_000,
          tvlChangePct: -0.314,
          expectedScoreDeltaFromTvl: -5,
          coverageClass: "primary",
          coverageConfidence: 1,
        },
      ],
      editorialCandidates: [
        candidate("liquidity:usds", "liquidity", 67_115, "USDS"),
        candidate("liquidity:ylds", "liquidity", 4_500, "YLDS"),
      ],
    });
    rows[4] = {
      ...rows[4],
      generated_at: incidentAt,
      digest_title: "USDS Drained",
      digest_text: "USDS drained to $13.72M.",
    };

    const weekly = buildWeeklyInputData(rows);
    const incidentDay = weekly?.dailyDigests.find((digest) => digest.date === "2026-08-21");

    expect(weekly?.degradedSources).toContain("liquidity-shift-quarantined-signal:usds-sky:2026-08-21");
    expect(incidentDay).toMatchObject({ title: "", text: "" });
    expect(incidentDay?.inputData.liquidityShifts?.map((shift) => shift.symbol)).toEqual(["YLDS"]);
    expect(incidentDay?.inputData.editorialCandidates?.map((entry) => entry.id)).toEqual(["liquidity:ylds"]);
    expect(weekly?.weeklySignals.topLiquidityShifts.map((shift) => shift.symbol)).toEqual(["YLDS"]);
    expect(weekly?.weeklySignals.riskLeaderboard.some((signal) => signal.symbols.includes("USDS"))).toBe(false);
    expect(weekly?.weeklySignals.riskLeaderboard.some((signal) => signal.symbols.includes("YLDS"))).toBe(true);
  });
});

const v9Identity: SafetyScoreV9PublicationIdentity = {
  model: "v9",
  schemaVersion: 1,
  methodologyVersion: "9.0",
  policyId: "safety-score-v9",
  policyDigest: "c".repeat(64),
  evaluationBuildDigest: "d".repeat(64),
  baseInputGenerationId: `report-cards-input:v1:${"e".repeat(64)}`,
  publicationGenerationId: "report-cards:v9:current",
};
const pillar = {
  score: 80,
  evidenceLevel: "adequate",
  freshness: "current",
  reasons: [],
};

function v8Transition(recordedAt: number): DigestGradeTransition {
  return {
    historyId: "v8-organic",
    recordedAt,
    model: "v8",
    safetyScoreIdentity: v8Identity,
    symbol: "USDT",
    fromGrade: "A",
    toGrade: "B+",
    fromScore: 90,
    toScore: 84,
    currentDimensions: { peg: 95, liq: 90, resilience: null, decentralization: null },
    mcapUsd: 100_000_000,
  };
}

function v9Transition(
  recordedAt: number,
  identity: SafetyScoreV9PublicationIdentity = v9Identity,
): DigestGradeTransition {
  return {
    historyId: `v9-organic:${identity.evaluationBuildDigest}`,
    recordedAt,
    model: "v9",
    safetyScoreIdentity: {
      ...identity,
      baseInputGenerationId: `report-cards-input:v1:${"f".repeat(64)}`,
      publicationGenerationId: "report-cards:v9:prior",
    },
    symbol: "USDC",
    fromGrade: "A",
    toGrade: "A-",
    fromScore: 92,
    toScore: 89,
    currentPillars: { backing: pillar, exit: pillar, control: pillar },
    reasonCodes: [],
    caps: [],
    bindingCap: null,
    mcapUsd: 80_000_000,
  };
}

function available(identity: SafetyScoreV8PublicationIdentity | SafetyScoreV9PublicationIdentity): DigestSafetyContext {
  return {
    status: "available",
    expectedModel: identity.model,
    identity,
    publishedAt: 1_785_000_000,
    reason: null,
  };
}

function unavailable(reason = "v9-publication-held"): DigestSafetyContext {
  return {
    status: "unavailable",
    expectedModel: "v9",
    identity: null,
    publishedAt: null,
    reason,
  };
}

function safetyRow(
  index: number,
  transitions: DigestGradeTransition[] = [],
  authoredIdentity?: SafetyScoreV8PublicationIdentity | SafetyScoreV9PublicationIdentity,
): DailyDigestSourceRow {
  const censusIdentity = authoredIdentity ?? v9Identity;
  const identities = transitions.filter((entry) =>
    entry.model === censusIdentity.model &&
    entry.safetyScoreIdentity.evaluationBuildDigest === censusIdentity.evaluationBuildDigest)
    .map(({ historyId, recordedAt }) => ({ historyId, recordedAt }));
  return {
    generated_at: SAFETY_START_SEC + index * 86_400,
    digest_title: `Day ${index}`,
    digest_text: "Market context.",
    input_data: JSON.stringify(digestInput({
      totalMcapUsd: 180_000_000 + index,
      gradeTransitions: transitions,
      gradeTransitionAccounting: {
        complete: true, count: identities.length, identities, safetyScoreIdentity: censusIdentity,
        window: { start: SAFETY_START_SEC + index * 86_400 - 172_800, end: SAFETY_START_SEC + index * 86_400 + 1 },
      },
      ...(authoredIdentity ? { safetyContext: available(authoredIdentity) } : {}),
    })),
  };
}

describe("weekly recap safety identity", () => {
  it("keeps only organic transitions comparable with the active V9 policy/build", () => {
    const otherBuild = { ...v9Identity, evaluationBuildDigest: "1".repeat(64) };
    const rows = [
      safetyRow(0, [v8Transition(1_784_916_000)]),
      safetyRow(1, [v9Transition(1_785_002_400)]),
      safetyRow(2, [v9Transition(1_785_088_800, otherBuild)]),
      safetyRow(3, [v9Transition(1_785_002_400)]),
      safetyRow(4),
      safetyRow(5),
      safetyRow(6),
    ];

    const weekly = buildWeeklyInputData(rows, [], available(v9Identity), SAFETY_PERIODS);

    expect(weekly?.safetyContext).toMatchObject({
      status: "available",
      identity: v9Identity,
    });
    expect(weekly?.gradeTransitionCount).toBe(1);
    expect(weekly?.weeklySignals.topGradeTransitions).toHaveLength(1);
    expect(weekly?.weeklySignals.topGradeTransitions[0]).toMatchObject({
      historyId: `v9-organic:${v9Identity.evaluationBuildDigest}`,
      model: "v9",
      safetyScoreIdentity: {
        publicationGenerationId: "report-cards:v9:prior",
      },
    });
  });

  it("omits only safety movers when V9 is unavailable and restores V8 movers after rollback", () => {
    const rows = [
      safetyRow(0, [v8Transition(1_784_916_000)], v8Identity),
      ...Array.from({ length: 6 }, (_, index) => safetyRow(index + 1, [], v8Identity)),
    ];
    const degraded = buildWeeklyInputData(rows, [], unavailable("v9-identity-mismatch"), SAFETY_PERIODS);
    const restored = buildWeeklyInputData(rows, [], available(v8Identity), SAFETY_PERIODS);

    expect(degraded).toMatchObject({
      totalBlacklistEventsThisWeek: 0,
      gradeTransitionCount: null,
      degradedSources: ["safety-canonical-snapshot:v9-identity-mismatch"],
      metricUnavailableReasons: {
        gradeTransitions: ["safety-canonical-snapshot:v9-identity-mismatch"],
      },
    });
    expect(restored?.gradeTransitionCount).toBe(1);
    expect(restored?.weeklySignals.topGradeTransitions[0]).toMatchObject({
      historyId: "v8-organic",
      model: "v8",
    });
  });

  it("withholds both weekly transition counts when global canonical safety is unavailable", () => {
    const current = Array.from({ length: 7 }, (_, index) => safetyRow(index, [], v9Identity));
    const prior = Array.from({ length: 7 }, (_, index) => safetyRow(index - 7, [], v9Identity));
    const reason = "safety-canonical-snapshot:v9-publication-held";
    const weekly = buildWeeklyInputData(current, prior, unavailable(), SAFETY_PERIODS)!;

    expect(weekly).toMatchObject({
      gradeTransitionCount: null,
      metricUnavailableReasons: { gradeTransitions: [reason] },
      degradedSources: [reason],
      weekOverWeekDeltas: { gradeTransitions: { current: null, prior: null } },
    });
    expect(weekly.dailyDigests.every(({ inputData }) => inputData.degradedSources?.includes(reason))).toBe(true);
    const prompt = buildWeeklyPrompt(weekly);
    expect(prompt).toContain(`Risk transitions: N/A (${reason})`);
    expect(prompt).toContain("Risk transitions: current n/a / prior n/a");
    expect(prompt).not.toContain("Risk transitions: 0");
  });

  it.each(["complete", "legacy", "partial", "missing", "delayed"] as const)(
    "counts full organic identities once inside adjacent scheduled periods with %s editions",
    (mode) => {
      const { current, prior } = SAFETY_PERIODS;
      const event = (historyId: string, recordedAt: number) => ({ ...v9Transition(recordedAt), historyId });
      const events = [
        event("prior-start", prior.start),
        event("prior-last", current.start - 1),
        event("current-start", current.start),
        ...Array.from({ length: 8 }, (_, index) => event(`inner:${index}`, current.start + index + 1)),
        event("current-last", current.end - 1),
        event("next-start", current.end),
      ];
      const captures = (offset: number) => Array.from({ length: 7 }, (_, index) => {
        const captureAt = SAFETY_START_SEC + (index + offset) * 86_400;
        const captured = events.filter((entry) => entry.recordedAt >= captureAt - 172800 && entry.recordedAt < captureAt + 1);
        const source = safetyRow(index + offset, captured, v9Identity);
        const input = JSON.parse(source.input_data) as DigestInputData;
        input.gradeTransitions = captured.slice(0, 5); // Census remains complete beyond the editorial cap.
        return { ...source, input_data: JSON.stringify(input) };
      });
      const rows = captures(0);
      if (mode === "missing") rows.splice(2, 1);
      if (mode === "legacy" || mode === "partial" || mode === "delayed") {
        const input = JSON.parse(rows[6]!.input_data) as DigestInputData;
        if (mode === "legacy") delete input.gradeTransitionAccounting;
        if (mode === "partial") input.gradeTransitionAccounting = {
          complete: false, window: { start: current.end - 172800, end: current.end + 1 }, reason: "grade-transitions-query",
        };
        if (mode === "delayed" && input.gradeTransitionAccounting?.complete) {
          input.gradeTransitionAccounting.window.end = current.end - 10;
          input.gradeTransitionAccounting.identities = input.gradeTransitionAccounting.identities.filter(
            (entry) => entry.recordedAt < current.end - 10);
          input.gradeTransitionAccounting.count = input.gradeTransitionAccounting.identities.length;
        }
        rows[6] = { ...rows[6]!, input_data: JSON.stringify(input) };
      }
      const weekly = buildWeeklyInputData(rows, captures(-7), available(v9Identity), SAFETY_PERIODS)!;
      expect(weekly.gradeTransitionCount).toBe(mode === "complete" ? 10 : null);
      expect(weekly.weekOverWeekDeltas?.gradeTransitions).toEqual({
        current: mode === "complete" ? 10 : null, prior: 2,
      });
      if (mode === "complete") {
        const ids = weekly.weeklySignals.topGradeTransitions.map((entry) => entry.historyId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).not.toContain("prior-last");
        expect(ids).not.toContain("next-start");
        expect(ids).toContain("current-start");
        expect(ids).toContain("current-last");
        expect(buildWeeklyPrompt(weekly)).toContain("Organic transition event periods: current [");
      } else {
        expect(weekly.metricUnavailableReasons?.gradeTransitions?.length).toBeGreaterThan(0);
      }
    },
  );

  it("retains observed zero weekly transition counts when canonical safety is available", () => {
    const current = Array.from({ length: 7 }, (_, index) => safetyRow(index, [], v9Identity));
    const prior = Array.from({ length: 7 }, (_, index) => safetyRow(index - 7, [], v9Identity));
    const weekly = buildWeeklyInputData(current, prior, available(v9Identity), SAFETY_PERIODS)!;

    expect(weekly.gradeTransitionCount).toBe(0);
    expect(weekly.metricUnavailableReasons?.gradeTransitions).toBeUndefined();
    expect(weekly.degradedSources).toBeUndefined();
    expect(weekly.weekOverWeekDeltas?.gradeTransitions).toEqual({ current: 0, prior: 0 });
    const prompt = buildWeeklyPrompt(weekly);
    expect(prompt).toContain("Grade transitions: 0");
    expect(prompt).toContain("Grade transitions: current 0 / prior 0");
  });

  it("withholds natural-language copy whose authored safety identity is incompatible", () => {
    const priorV9Identity: SafetyScoreV9PublicationIdentity = {
      ...v9Identity,
      baseInputGenerationId: `report-cards-input:v1:${"1".repeat(64)}`,
      publicationGenerationId: "report-cards:v9:prior",
    };
    const incompatible = {
      ...safetyRow(0, [v8Transition(1_784_916_000)], v8Identity),
      digest_title: "USDT Held An A Grade",
      digest_text: "USDT's report card stayed A.",
    };
    const compatible = {
      ...safetyRow(1, [v9Transition(1_785_002_400)], priorV9Identity),
      digest_title: "USDC Moved On V9 Evidence",
      digest_text: "USDC's current policy series changed organically.",
    };
    const rows = [
      incompatible,
      compatible,
      safetyRow(2, [], priorV9Identity),
      safetyRow(3, [], priorV9Identity),
      safetyRow(4, [], priorV9Identity),
    ];

    const weekly = buildWeeklyInputData(rows, [], available(v9Identity), SAFETY_PERIODS);
    expect(weekly?.dailyDigests[0]).toMatchObject({ title: "", text: "" });
    expect(weekly?.dailyDigests[1]).toMatchObject({
      title: "USDC Moved On V9 Evidence",
      text: "USDC's current policy series changed organically.",
    });

    const prompt = buildWeeklyPrompt(weekly!);
    expect(prompt).not.toContain("USDT Held An A Grade");
    expect(prompt).not.toContain("USDT's report card stayed A.");
    expect(prompt).toContain("USDC Moved On V9 Evidence");
  });

  it("does not prime grade language when canonical safety context is unavailable", () => {
    const rows = [
      safetyRow(0, [v9Transition(1_784_916_000)], v9Identity),
      safetyRow(1, [], v9Identity),
      safetyRow(2, [], v9Identity),
      safetyRow(3, [], v9Identity),
      safetyRow(4, [], v9Identity),
      safetyRow(5, [], v9Identity),
      safetyRow(6, [], v9Identity),
    ];

    const weekly = buildWeeklyInputData(rows, [], unavailable(), SAFETY_PERIODS);
    const prompt = buildWeeklyPrompt(weekly!);

    expect(prompt).toContain("Risk transitions: N/A (safety-canonical-snapshot:v9-publication-held)");
    expect(prompt).not.toContain("Grade transitions:");
    expect(prompt).not.toContain("Top grade transitions by mcap");
  });

  it("places the latest capture-matched census and grade movers in one dated safety desk", () => {
    const rows = [0, 1, 2, 3, 4].map((index) => safetyRow(index, [], v9Identity));
    const latestInput = JSON.parse(rows[4]!.input_data) as DigestInputData;
    latestInput.safetyMap = {
      imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-07-26",
      freshness: "carried-forward",
      ageDays: 2,
      manifest: {
        date: "2026-07-26",
        asOfSec: 1_774_000_000,
        renderedAtSec: 1_774_001_000,
        edition: "daily",
        bytes: { png: 1_000_000 },
        mapSummary: {
          date: "2026-07-26",
          asOfSec: 1_774_000_000,
          methodologyVersion: "v9.4",
          gradedCount: 10,
          notRatedCount: 2,
          totalMcapUsd: 100_000_000_000,
          floorMcapByTier: { a: 1_000_000, other: 100_000 },
          tiers: [
            { tier: "A", range: "90-100", count: 2, mcapUsd: 70_000_000_000, sharePct: 70, leaders: [{ symbol: "USDT", score: 95, mcapUsd: 60_000_000_000 }] },
            { tier: "B", range: "80-89", count: 2, mcapUsd: 15_000_000_000, sharePct: 15, leaders: [] },
            { tier: "C", range: "70-79", count: 2, mcapUsd: 8_000_000_000, sharePct: 8, leaders: [] },
            { tier: "D", range: "60-69", count: 2, mcapUsd: 5_000_000_000, sharePct: 5, leaders: [] },
            { tier: "F", range: "0-59", count: 2, mcapUsd: 2_000_000_000, sharePct: 2, leaders: [] },
          ],
        },
      },
    };
    rows[4] = { ...rows[4]!, input_data: JSON.stringify(latestInput) };

    const weekly = buildWeeklyInputData(rows, [], available(v9Identity), SAFETY_PERIODS);
    const prompt = buildWeeklyPrompt(weekly!);

    expect(prompt).toContain("Safety desk:");
    expect(prompt).toContain("Safety Map census (carried-forward, age 2 days; depicts 2026-07-26 UTC)");
    expect(prompt).toContain("Grade movers this week: none recorded");
    expect(prompt).not.toContain("Top grade transitions by mcap");
  });
});

describe("weekly recap retracted USG edition quarantine", () => {
  // Live JSON-LD datePublished for /digest/2026-10-24/: 2026-10-24T08:05:25.000Z.
  const EDITION_AT = 1_792_829_125;
  const flows = (symbols: string[]) => ({
    gaugeScore: 40,
    gaugeBand: "WATCH",
    flightToQuality: { active: false, safeNetUsd: 0, riskyNetUsd: 0 },
    topPressure: symbols.map((symbol) => ({ symbol, intensity: symbol === "USG" ? -100 : 20, net24hUsd: symbol === "USG" ? -36_850_000 : 5_000_000 })),
  });
  const contaminated = (index: number, generatedAt: number, pressureSymbols: string[] = ["USG", "USDT"]) => ({
    ...row(index, {
      mintBurnFlows: flows(pressureSymbols),
      editorialCandidates: [
        candidate("mint-burn:usg:pressure", "mint-burn", 100, "USG"),
        candidate("mint-burn:usdt:pressure", "mint-burn", 50, "USDT"),
        candidate("depeg:usg", "depeg", 40, "USG"),
      ],
      changeSummary: {
        newSignals: [{ id: "mint-burn:usg:pressure", label: "USG", kind: "mint-burn", symbols: ["USG"], detail: "-$36.85M" }],
        worsenedSignals: [{ id: "mint-burn:usdt:pressure", label: "USDT", kind: "mint-burn", symbols: ["USDT"], detail: "ok" }],
        improvedSignals: [], resolvedSignals: [], repeatedSignals: [],
      },
      nextTriggers: [
        { id: "t-usg", label: "USG", metric: "supply-1d-usd", comparator: "abs-gte", thresholdLabel: "x", symbol: "USG", candidateId: "mint-burn:usg:pressure", rationale: "r", detail: "d" },
        { id: "t-usdt", label: "USDT", metric: "supply-1d-usd", comparator: "abs-gte", thresholdLabel: "x", symbol: "USDT", candidateId: "mint-burn:usdt:pressure", rationale: "r", detail: "d" },
      ],
      editorialAudit: {
        topCandidateIds: ["mint-burn:usg:pressure", "mint-burn:usdt:pressure"], usableCandidateIds: ["mint-burn:usg:pressure"],
        suppressedCandidateIds: [], momentumCandidateIds: [], leadCandidateId: "mint-burn:usg:pressure", leadCandidateTitle: "USG mint/burn pressure shifted",
      },
    }),
    generated_at: generatedAt,
    digest_title: "USG Burns",
    digest_text: "USG saw $36.85M of net burns.",
  });

  it.each([
    ["with a pressure row", ["USG", "USDT"]],
    ["candidate-only, no surviving pressure row", ["USDT"]],
  ])("removes the retracted edition's USG pressure %s but keeps unrelated evidence", (_name, pressureSymbols) => {
    const rows = [0, 1, 2, 3, 4, 5, 6].map((index) => row(index));
    rows[3] = contaminated(3, EDITION_AT, pressureSymbols);
    const stored = rows[3].input_data;
    const weekly = buildWeeklyInputData(rows)!;
    const day = weekly.dailyDigests.find((digest) => digest.inputData.mintBurnFlows)!;

    expect(weekly.degradedSources).toContain("mint-burn-pressure-quarantined-signal:usg-tangent:2026-10-24");
    expect(day).toMatchObject({ title: "", text: "" });
    expect(day.inputData.mintBurnFlows?.topPressure.map((entry) => entry.symbol)).not.toContain("USG");
    expect(day.inputData.mintBurnFlows?.gaugeScore).toBe(40);
    expect(day.inputData.editorialCandidates?.map((entry) => entry.id)).toEqual(["mint-burn:usdt:pressure", "depeg:usg"]);
    expect(day.inputData.changeSummary?.newSignals).toEqual([]);
    expect(day.inputData.changeSummary?.worsenedSignals.map((signal) => signal.id)).toEqual(["mint-burn:usdt:pressure"]);
    expect(day.inputData.nextTriggers?.map((trigger) => trigger.id)).toEqual(["t-usdt"]);
    expect(day.inputData.editorialAudit).toMatchObject({
      topCandidateIds: ["mint-burn:usdt:pressure"], usableCandidateIds: [], leadCandidateId: null,
    });
    expect(weekly.weeklySignals.topPressureSignals.some((signal) => signal.symbol === "USG")).toBe(false);
    expect(rows[3].input_data).toBe(stored);
  });

  it.each([EDITION_AT - 1, EDITION_AT + 1])("does not quarantine an adjacent edition second (%s)", (generatedAt) => {
    const rows = [0, 1, 2, 3, 4, 5, 6].map((index) => row(index));
    rows[3] = contaminated(3, generatedAt);
    const weekly = buildWeeklyInputData(rows)!;
    expect(weekly.degradedSources ?? []).not.toContain("mint-burn-pressure-quarantined-signal:usg-tangent:2026-10-24");
    expect(weekly.weeklySignals.topPressureSignals.some((signal) => signal.symbol === "USG")).toBe(true);
  });

  it("quarantines the same edition when it falls in the prior period", () => {
    const current = [0, 1, 2, 3, 4, 5, 6].map((index) => row(index));
    const prior = [0, 1, 2, 3, 4, 5, 6].map((index) => row(index));
    prior[2] = contaminated(2, EDITION_AT);
    const weekly = buildWeeklyInputData(current, prior)!;
    expect(weekly.degradedSources).toContain("mint-burn-pressure-quarantined-signal:usg-tangent:2026-10-24");
  });
});

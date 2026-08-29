import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { mockD1, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";

import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

vi.mock("@shared/lib/stablecoins/registry", async () => (await import("./daily-digest.test-support")).mockDailyDigestRegistryModule());
vi.mock("../../lib/stablecoins-cache", async () => (await import("./daily-digest.test-support")).mockDailyDigestStablecoinsCacheModule());
vi.mock("../../lib/safety-score-active-source", async () => (await import("./daily-digest.test-support")).mockDailyDigestSafetySourceModule());
vi.mock("../../lib/flight-to-quality-classification", async () => (await import("./daily-digest.test-support")).mockDailyDigestFlightToQualityModule());
vi.mock("../../lib/fetch-retry", async () => (await import("./daily-digest.test-support")).mockDailyDigestFetchRetryModule());
vi.mock("../../lib/twitter", async () => (await import("./daily-digest.test-support")).mockDailyDigestTwitterModule());

vi.mock("../../lib/digest-safety-map", async (importOriginal) => {
  const { mockDigestSafetyMapModule } = await import("./daily-digest.test-support");
  return mockDigestSafetyMapModule(await importOriginal<typeof import("../../lib/digest-safety-map")>());
});

vi.mock("../../lib/telegram-digest-appendices", async () => (await import("./daily-digest.test-support")).mockDailyDigestAppendicesModule());
vi.mock("../../lib/telegram-digest-outbox", async () => (await import("./daily-digest.test-support")).mockDailyDigestOutboxModule());

vi.mock("../telegram-digest-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../telegram-digest-transport")>();
  const { mockTelegramDigestTransportModule } = await import("./daily-digest.test-support");
  return mockTelegramDigestTransportModule(actual);
});

vi.mock("../../lib/circuit-breaker", async () => (await import("./daily-digest.test-support")).mockDailyDigestCircuitBreakerModule());

import { buildUserPrompt } from "../daily-digest/prompt";
import { classifyRegime } from "../daily-digest/prompt/regime";
import {
  parseDigestModelResponse,
  validateDigestModelOutput,
  type DigestValidationProfile,
  type ParsedDigestResponse,
} from "../daily-digest/response";

import {
  collectLiquidityShifts,
  collectActiveDepegs,
  collectResolvedDepegs,
  collectSupplyVelocity,
  collectMintBurnFlows,
} from "../daily-digest/collectors-market";
import {
  collectDewsStress,
  collectGradeTransitions,
  collectSafetyScores,
  collectYieldAnomalies,
} from "../daily-digest/collectors-risk";
import {
  collectCrossDayTrends,
  collectHistoricalContext,
  collectPsiContributors,
} from "../daily-digest/collectors-history";
import type { CollectorContext } from "../daily-digest/collectors-shared";
import { buildDigestIntelligence } from "../daily-digest/digest-intelligence";
import type { DigestInputData } from "@shared/types/digest";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";

import {
  loadActiveSafetyScoreSource,
} from "../../lib/safety-score-active-source";






import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";
import {
  canonicalSafetySource,
  makePublishedDewsTables,
  PUBLISHED_GAUGE_SCORE,
  publishedGaugeTable,
  type TestDewsRow,
} from "./daily-digest.test-support";

const DEFAULT_PARSED_EXTENDED = "T. T. T.\n\nT. T. T.\n\nT. T. T.";

function makeParsedFixture(
  opts: {
    extended?: string;
    text?: string;
    lead?: string;
    leadSignalId?: string;
    tone?: string;
  } = {},
): ParsedDigestResponse {
  return {
    digestTitle: "T",
    digestText: opts.text ?? "T.",
    digestExtended: opts.extended ?? DEFAULT_PARSED_EXTENDED,
    digestMeta: JSON.stringify({
      ...(opts.leadSignalId ? { leadSignalId: opts.leadSignalId } : {}),
      lead: opts.lead ?? "depeg",
      tone: opts.tone ?? "dry",
      coins: ["USDT"],
    }),
    strippedDashCount: 0,
    forbiddenPhraseHits: [],
    usedRawTextFallback: false,
  };
}

/**
 * Build a canonical Anthropic SSE streaming Response body for `text` as a
 * single text-delta. Matches what Anthropic actually emits when we set
 * `stream: true` on the /v1/messages call. Used to mock fetchWithRetry
 * responses in tests, since the production path now calls
 * `accumulateAnthropicStream` on the response body rather than `response.json()`.
 */







describe("parseDigestModelResponse meta normalization", () => {
  function parseLeadTone(leadValue: string, toneValue: string): { lead?: string; tone?: string } {
    const raw = JSON.stringify({
      title: "T",
      text: "T.",
      extended: "T. T. T.\n\nT. T. T.\n\nT. T. T.",
      meta: { lead: leadValue, tone: toneValue, coins: ["USDT"] },
    });
    const parsed = parseDigestModelResponse(raw);
    const meta = parsed.digestMeta ? (JSON.parse(parsed.digestMeta) as Record<string, string>) : {};
    return { lead: meta.lead, tone: meta.tone };
  }

  it.each([
    {
      label: "retains observed natural lead tokens",
      cases: ["gauge-flip", "psi-band-change", "issuer-concentration", "regime-divergence", "chain-migration", "reserve-event"]
        .map((lead) => ({ actual: parseLeadTone(lead, "dry").lead, expected: lead })),
    },
    {
      label: "retains observed natural tones",
      cases: ["sardonic", "observant", "forensic"]
        .map((tone) => ({ actual: parseLeadTone("depeg", tone).tone, expected: tone })),
    },
    {
      label: "collapses garbage to 'other'",
      cases: [
        { actual: parseLeadTone("asdfghjkl", "dry").lead, expected: "other" },
        { actual: parseLeadTone("depeg", "asdfghjkl").tone, expected: "other" },
      ],
    },
  ])("$label", ({ cases }) => {
    for (const { actual, expected } of cases) expect(actual).toBe(expected);
  });
});

describe("lead family variety check", () => {
  it.each([
    {
      label: "fires repeated-lead-family when family repeats 2 of last 3",
      recentLeads: ["psi-regime", "psi-band-change", "supply-reversal"],
      expected: true,
    },
    {
      label: "does not fire when lead families differ",
      recentLeads: ["depeg", "grade-transition", "ftq"],
      expected: false,
    },
  ])("$label", ({ recentLeads, expected }) => {
    const recentMeta = recentLeads.map((lead) => ({
      meta: { lead, tone: "dry" } as Record<string, unknown>,
      title: "x",
    }));
    const issues = validateDigestModelOutput(makeParsedFixture({ lead: "psi-streak" }), {
      kind: "daily",
      recentMeta,
    });
    expect(issues.some((issue) => issue.code === "repeated-lead-family")).toBe(expected);
  });
});

describe("forward-look voice guard", () => {
  it.each([
    {
      label: "flags missing forward-look when digest is purely retrospective",
      fixture: {
        extended: "USDT added $2B.\n\nUSDC pulled $500M.\n\nThe gap is now the story.",
        text: "USDT added $2B while USDC pulled $500M.",
      },
      expected: true,
    },
    {
      label: "does not flag when forward-look is present in extended",
      fixture: {
        extended: "USDT added $2B.\n\nUSDC pulled $500M.\n\nIf the gap holds next week, it is a rotation.",
      },
      expected: false,
    },
    {
      label: "does not flag when forward-look is only in the text hook",
      fixture: { extended: "A.\n\nB.\n\nC.", text: "Watch if USDT crosses $185B." },
      expected: false,
    },
  ])("$label", ({ fixture, expected }) => {
    const issues = validateDigestModelOutput(makeParsedFixture(fixture), { kind: "daily", recentMeta: [] });
    expect(issues.some((issue) => issue.code === "missing-forward-look")).toBe(expected);
  });
});

describe("lead requirement validator", () => {
  it.each([
    {
      label: "hard-fails when a required critical candidate is not the declared lead",
      fixture: {
        leadSignalId: "market:usdc-circle:weekly-supply",
        extended:
          "PMUSD stayed 5284 bps below peg on $65M.\n\nUSDC added $2B.\n\nIf PMUSD holds there next session, the peg stress remains the lead.",
      },
      issueCode: "lead-candidate-mismatch",
    },
    {
      label: "hard-fails when a required critical candidate is omitted from the copy",
      fixture: {
        leadSignalId: "depeg:pmusd-active",
        extended:
          "USDC added $2B.\n\nUSDT held steady.\n\nIf the flow reverses next session, the supply story changes.",
      },
      issueCode: "required-lead-missing",
    },
  ])("$label", ({ fixture, issueCode }) => {
    const issues = validateDigestModelOutput(makeParsedFixture(fixture), {
      kind: "daily",
      recentMeta: [],
      leadRequirements: [{
        candidateIds: ["depeg:pmusd-active"],
        severity: "hard",
        mentionTokens: ["PMUSD"],
        reason: "PMUSD critical depeg must lead",
      }],
    });
    expect(issues.some((issue) => issue.code === issueCode && issue.severity === "hard")).toBe(true);
  });
});

describe("opening-fingerprint voice guard", () => {
  it.each([
    {
      label: "flags PSI-verb opening when any of last 3 also opened that way",
      extended: "PSI ticked to 96 in BEDROCK.\n\nUSDC added $500M.\n\nReal closer.",
      recentText: ["PSI sits at 95. USDC hit ATH.", "USDT minted $2B. PSI unchanged.", "Flows rotated into gold. USDC weak."],
      expected: true,
    },
    {
      label: "does not flag when opening is structurally different",
      extended: "USDT just added $2B overnight.\n\nPSI drifted to 93.\n\nReal closer.",
      recentText: ["PSI sits at 95.", "PSI slipped to 93."],
      expected: false,
    },
  ])("$label", ({ extended, recentText, expected }) => {
    const recentMeta = recentText.map((rawText, index) => ({ meta: null, title: String(index), rawText }));
    const issues = validateDigestModelOutput(makeParsedFixture({ extended }), { kind: "daily", recentMeta });
    expect(issues.some((issue) => issue.code === "opening-pattern-repetition")).toBe(expected);
  });
});

describe("forbidden-tic voice guard", () => {
  it.each([
    ["flags plumbing metaphor anywhere in extended", "PSI held.\n\nThe plumbing flinched again.\n\nDone.", true],
    ["flags 'worth watching' in closer position", "Line one.\n\nLine two.\n\nLine three, worth monitoring into next week.", true],
    ["does NOT flag 'worth watching' mid-paragraph when last sentence is different", "A coin worth watching for mcap drift, plus five others. Real closer sentence here.\n\nLine two.\n\nLine three.", false],
    ["does not flag prose free of tics", "USDT added $3B.\n\nUSDC pulled $200M.\n\nThe gap is now the story.", false],
  ] as const)("%s", (_label, extended, expected) => {
    const issues = validateDigestModelOutput(makeParsedFixture({ extended }), { kind: "daily", recentMeta: [] });
    expect(issues.some((issue) => issue.code === "forbidden-tic")).toBe(expected);
  });
});

describe("tone cluster validator", () => {
  it.each([
    ["fires tone-cluster when same tone appears 3+ times in last 5", ["foreboding", "foreboding", "foreboding", "foreboding", "foreboding"], true],
    ["does not fire when spread across tones", ["dry", "sardonic", "foreboding", "clinical", "wistful"], false],
  ] as const)("%s", (_label, tones, expected) => {
    const recentMeta = tones.map((tone, index) => ({
      meta: { lead: "depeg", tone } as Record<string, unknown>,
      title: String(index),
    }));
    const issues = validateDigestModelOutput(makeParsedFixture({ tone: "foreboding" }), {
      kind: "daily",
      recentMeta,
    });
    expect(issues.some((issue) => issue.code === "tone-cluster")).toBe(expected);
  });
});

describe("digest intelligence enrichment", () => {
  const current: DigestInputData = {
    totalMcapUsd: 160_000_000,
    mcap7dDelta: 3_000_000,
    activeDepegCount: 1,
    topDepegs: [{ stablecoinId: "usdt-tether", symbol: "USDT", bps: -175, direction: "below", mcapUsd: 100_000_000 }],
    biggestSupplyChange: {
      id: "usdc-circle",
      symbol: "USDC",
      name: "USD Coin",
      changeUsd: 40_000_000,
      currentMcap: 60_000_000,
    },
    stabilityIndex: { score: 88, band: "STEADY", components: { severity: 4, breadth: 2, trend: -1 } },
    yesterdayIndex: { score: 90, band: "BEDROCK" },
    supplyVelocity: [{ coin: "USDC", change1d: 12_000_000, change7d: 40_000_000, signal: "accelerating" }],
    editorialCandidates: [
      {
        id: "depeg:usdt-tether:active",
        kind: "depeg",
        title: "USDT active 175 bps below peg",
        symbols: ["USDT"],
        impactScore: 17.5,
        novelty: "worsening",
        confidence: "high",
        artifactRisk: "low",
        headlineFacts: ["175 bps below peg", "$100M market cap"],
        whyItMatters: "Active peg stress is reader-relevant.",
      },
      {
        id: "supply:usdc:accelerating",
        kind: "supply",
        title: "USDC supply accelerating",
        symbols: ["USDC"],
        impactScore: 12,
        novelty: "accelerating",
        confidence: "high",
        artifactRisk: "low",
        headlineFacts: ["+$12M in 1d"],
        whyItMatters: "Supply velocity shows allocation.",
      },
    ],
  };

  it("builds risk tape, next triggers, changes, and prior-trigger outcomes", () => {
    const previous: DigestInputData = {
      ...current,
      dataQuality: {
        generatedAt: 1_772_668_800,
        stablecoinsCacheUpdatedAt: null,
        stablecoinsCacheAgeSec: null,
        windows: current.dataQuality?.windows ?? {
          blacklistActivity: { label: "x", start: 0, end: 0 },
          mintBurnFlows: { label: "x", start: 0, end: 0 },
          supplyVelocity: { label: "x", dates: [] },
          psi: { label: "x", sampleAt: null, dailySnapshotAt: null },
        },
      },
      topDepegs: [{ stablecoinId: "usdt-tether", symbol: "USDT", bps: -100, direction: "below", mcapUsd: 100_000_000 }],
      stabilityIndex: { score: 91, band: "BEDROCK", components: { severity: 2, breadth: 1, trend: 0 } },
      nextTriggers: [
        {
          id: "trigger:depeg:usdt",
          label: "USDT depeg widening",
          metric: "depeg-bps",
          comparator: "abs-gte",
          thresholdValue: 125,
          thresholdLabel: "125 bps off peg",
          symbol: "USDT",
          rationale: "A wider deviation raises severity.",
          detail: "If USDT reaches 125 bps off peg, severity rises.",
        },
      ],
    };

    const intelligence = buildDigestIntelligence(current, previous);

    expect(intelligence.riskTape?.some((item) => item.id === "risk-tape:depegs")).toBe(true);
    expect(intelligence.nextTriggers?.[0]).toMatchObject({ metric: "depeg-bps", symbol: "USDT" });
    expect(intelligence.changeSummary?.worsenedSignals[0]).toMatchObject({ label: "USDT depeg widened" });
    expect(intelligence.forwardLookOutcomes?.[0]).toMatchObject({ status: "hit", triggerId: "trigger:depeg:usdt" });
    expect(intelligence.calmNarrativeFrame?.label).toBe("Supply rotation");
  });

  it("keeps unavailable flight-to-quality classification explicit in prompt and risk tape", () => {
    const data: DigestInputData = {
      ...current,
      mintBurnFlows: {
        gaugeScore: 0,
        gaugeBand: "NEUTRAL",
        classificationSource: "unavailable",
        classificationReason: "identity-missing",
        safetyScoreIdentity: null,
        flightToQuality: { active: false, safeNetUsd: 0, riskyNetUsd: 0 },
        topPressure: [],
      },
    };

    const prompt = buildUserPrompt(data);
    const gauge = buildDigestIntelligence(data, null).riskTape?.find((item) => item.id === "risk-tape:gauge");

    expect(prompt).toContain("Flight-to-Quality: unavailable (identity-missing)");
    expect(prompt).not.toContain("Flight-to-Quality: inactive");
    expect(gauge).toMatchObject({
      detail: "Flight-to-quality classification unavailable (identity-missing).",
    });
  });

  it("evaluates a supply-7d trigger against the coin's weekly change when no velocity signal is emitted", () => {
    const previous: DigestInputData = {
      ...current,
      dataQuality: {
        generatedAt: 1_772_668_800,
        stablecoinsCacheUpdatedAt: null,
        stablecoinsCacheAgeSec: null,
        windows: current.dataQuality?.windows ?? {
          blacklistActivity: { label: "x", start: 0, end: 0 },
          mintBurnFlows: { label: "x", start: 0, end: 0 },
          supplyVelocity: { label: "x", dates: [] },
          psi: { label: "x", sampleAt: null, dailySnapshotAt: null },
        },
      },
      nextTriggers: [
        {
          id: "trigger:supply-7d:usdc",
          label: "USDC weekly supply move",
          metric: "supply-7d-usd",
          comparator: "abs-gte",
          thresholdValue: 30_000_000,
          thresholdLabel: "$30M 7d move",
          symbol: "USDC",
          rationale: "The largest weekly mover stays useful only if the move keeps scaling.",
          detail: "If USDC's 7d supply move clears $30M, the story has follow-through.",
        },
      ],
    };
    const today: DigestInputData = {
      ...current,
      supplyVelocity: [],
      supplyChanges7d: [{ coin: "USDC", change7d: 40_000_000 }],
    };

    const intelligence = buildDigestIntelligence(today, previous);

    expect(intelligence.forwardLookOutcomes?.[0]).toMatchObject({
      status: "hit",
      triggerId: "trigger:supply-7d:usdc",
    });
  });

  it("evaluates a supply-7d trigger against the coin's own velocity even when a different coin is the biggest weekly mover", () => {
    const previous: DigestInputData = {
      ...current,
      dataQuality: {
        generatedAt: 1_772_668_800,
        stablecoinsCacheUpdatedAt: null,
        stablecoinsCacheAgeSec: null,
        windows: current.dataQuality?.windows ?? {
          blacklistActivity: { label: "x", start: 0, end: 0 },
          mintBurnFlows: { label: "x", start: 0, end: 0 },
          supplyVelocity: { label: "x", dates: [] },
          psi: { label: "x", sampleAt: null, dailySnapshotAt: null },
        },
      },
      nextTriggers: [
        {
          id: "trigger:supply-7d:usdc",
          label: "USDC weekly supply move",
          metric: "supply-7d-usd",
          comparator: "abs-gte",
          thresholdValue: 30_000_000,
          thresholdLabel: "$30M 7d move",
          symbol: "USDC",
          rationale: "The largest weekly mover stays useful only if the move keeps scaling.",
          detail: "If USDC's 7d supply move clears $30M, the story has follow-through.",
        },
      ],
    };
    // Current day: USDT is now the biggest weekly mover, but USDC still moved $40M over 7d.
    const today: DigestInputData = {
      ...current,
      biggestSupplyChange: {
        id: "usdt-tether",
        symbol: "USDT",
        name: "Tether",
        changeUsd: 90_000_000,
        currentMcap: 100_000_000,
      },
    };

    const intelligence = buildDigestIntelligence(today, previous);

    expect(intelligence.forwardLookOutcomes?.[0]).toMatchObject({
      status: "hit",
      triggerId: "trigger:supply-7d:usdc",
    });
  });
});

describe("daily digest prompt contracts", () => {
  it("renders canonical V9 safety pillars without legacy dimensions", () => {
    const pillar = { score: 91, evidenceLevel: "strong" as const, freshness: "current" as const, reasons: [] };
    const cap = { kind: "redemption-access", limit: 82, reason: "Primary redemption remains eligibility-gated", binding: true };
    const prompt = buildUserPrompt({
      totalMcapUsd: 160_000_000, mcap7dDelta: 3_000_000, activeDepegCount: 0, topDepegs: [],
      biggestSupplyChange: null, stabilityIndex: null, yesterdayIndex: null,
      safetyScores: {
        model: "v9",
        mentionedCoins: [{
          symbol: "USDT", grade: "A+", score: 88,
          pillars: { backing: pillar, exit: { ...pillar, score: 86 }, control: { ...pillar, score: 84 } },
          reasonCodes: ["bounded-mechanism-review"], caps: [cap], bindingCap: cap,
        }],
        gradeDistribution: { "A+": 1 },
        provenance: {
          model: "v9", schemaVersion: 1, methodologyVersion: "9.0", policyId: "safety-score-v9",
          policyDigest: "a".repeat(64), evaluationBuildDigest: "b".repeat(64),
          baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`, publicationGenerationId: "report-cards:v9:1", publishedAt: 110,
        },
      },
    });

    expect(prompt).toContain("Safety Scores (V9");
    expect(prompt).toContain("backing=91, exit=86, control=84");
    expect(prompt).not.toContain("peg=95");
  });
});

describe("classifyRegime", () => {
  const baseData: DigestInputData = {
    totalMcapUsd: 200_000_000_000,
    mcap7dDelta: 1_000_000_000,
    activeDepegCount: 0,
    topDepegs: [],
    biggestSupplyChange: null,
    stabilityIndex: { score: 95, band: "BEDROCK", components: { severity: 0, breadth: 0, trend: 0 } },
    yesterdayIndex: null,
  };

  it.each([
    {
      label: "returns CALM when nothing is elevated",
      data: baseData,
      expected: "CALM",
    },
    {
      label: "returns CRISIS when FTQ is active",
      data: {
        ...baseData,
        mintBurnFlows: {
          gaugeScore: -20,
          gaugeBand: "CAUTIOUS",
          flightToQuality: { active: true, safeNetUsd: 200_000_000, riskyNetUsd: -200_000_000 },
          topPressure: [],
        },
      },
      expected: "CRISIS",
    },
    {
      label: "returns CRISIS when PSI band is TREMOR",
      data: {
        ...baseData,
        stabilityIndex: { score: 65, band: "TREMOR", components: { severity: 30, breadth: 5, trend: -3 } },
      },
      expected: "CRISIS",
    },
    {
      label: "returns TENSION when ALERT+ coins have material mcap",
      data: {
        ...baseData,
        dewsStress: {
          bandCounts: { calm: 100, watch: 10, alert: 2, warning: 1, danger: 0 },
          yesterdayBandCounts: { calm: 100, watch: 10, alert: 2, warning: 1, danger: 0 },
          bandChanges: [],
          elevatedCoins: [{ symbol: "USDT", band: "ALERT", score: 50, mcapUsd: 2_000_000_000 }],
        },
      },
      expected: "TENSION",
    },
    {
      label: "returns WATCHFUL when 1 unsuppressed active depeg is present",
      data: {
        ...baseData,
        activeDepegCount: 1,
        topDepegs: [{ symbol: "USDT", bps: 5, mcapUsd: 100_000_000_000 }],
      },
      expected: "WATCHFUL",
    },
  ] as const)("$label", ({ data, expected }) => {
    expect(classifyRegime(data as DigestInputData)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Collector unit tests
// ---------------------------------------------------------------------------

function makeCollectorCtx(db: D1Database): CollectorContext {
  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = nowSec - (nowSec % 86_400);
  const yesterdayTs = todayTs - 86_400;

  const trackedStablecoinAssets = [
    makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.9975, circulating: { peggedUSD: 100_000_000_000 }, circulatingPrevWeek: { peggedUSD: 95_000_000_000 } }),
    makeAsset({ id: "usdc-circle", symbol: "USDC", price: 0.99, circulating: { peggedUSD: 50_000_000_000 }, circulatingPrevWeek: { peggedUSD: 52_000_000_000 } }),
    makeAsset({ id: "dai-makerdao", symbol: "DAI", price: 1.05, circulating: { peggedUSD: 5_000_000 }, circulatingPrevWeek: { peggedUSD: 5_000_000 } }),
  ];
  const stablecoinAssetById = new Map(trackedStablecoinAssets.map((asset) => [asset.id, asset]));

  const mcapById = new Map<string, number>([["usdt-tether", 100_000_000_000], ["usdc-circle", 50_000_000_000], ["dai-makerdao", 5_000_000]]);

  return { db: db as unknown as D1Database, trackedStablecoinAssets, trackedStablecoinIds: new Set(trackedStablecoinAssets.map((asset) => asset.id)), coreAggregateStablecoinAssets: trackedStablecoinAssets, coreAggregateStablecoinIds: new Set(trackedStablecoinAssets.map((asset) => asset.id)), stablecoinAssetById, mcapById, stablecoinsCacheIsFresh: true, nowSec, todayTs, yesterdayTs };
}

describe("collectSafetyScores", () => {
  it("publishes only canonical V9 grades, pillars, reasons, caps, and full identity", async () => {
    const cap = { kind: "redemption-access", limit: 82, source: "structural" as const, reason: "Primary redemption remains eligibility-gated", binding: true };
    const pillar = { score: 91, evidenceLevel: "strong" as const, freshness: "current" as const, components: ["reserves"], reasons: [{ code: "bounded-mechanism-review" as const, message: "Reviewed reserve reporting is current", path: "pillars.backing" }] };
    const snapshot = makeWorkerReportCardsV9Response({ cards: [makeWorkerV9Card({
      id: "usdt-tether", grade: "A+", score: 88,
      pillars: { backing: pillar, exit: { ...pillar, score: 86, components: ["liquidity"] }, control: { ...pillar, score: 84, components: ["governance"] } },
      caps: [cap], bindingCap: cap, reasonCodes: ["bounded-mechanism-review"],
    })] });
    vi.mocked(loadActiveSafetyScoreSource).mockReset().mockResolvedValueOnce({
      kind: "v9",
      snapshot,
    });

    const result = await collectSafetyScores(makeCollectorCtx(mockD1([])), new Set(["USDT"]));

    expect(result.value.safetyContext).toMatchObject({ status: "available", expectedModel: "v9", identity: snapshot.safetyScoreIdentity });
    expect(result.value.safetyScores).toMatchObject({
      model: "v9",
      provenance: {
        ...snapshot.safetyScoreIdentity,
        publishedAt: snapshot.updatedAt,
      },
      mentionedCoins: [{
        symbol: "USDT",
        grade: "A+",
        score: 88,
        pillars: { backing: { score: 91 }, exit: { score: 86 }, control: { score: 84 } },
        reasonCodes: ["bounded-mechanism-review"],
        bindingCap: { kind: "redemption-access", limit: 82 },
      }],
    });
    expect(result.value.safetyScores).not.toHaveProperty("medianGrade");
    expect(result.value.safetyGrades).toHaveLength(1);
    expect(result.degradedReasons).toEqual([]);
  });
});

describe("collectGradeTransitions", () => {
  it("includes V2 organic grade transitions and canonical safety provenance", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);
    vi.mocked(loadActiveSafetyScoreSource).mockReset().mockResolvedValueOnce(canonicalSafetySource([{ id: "usdt-tether", overallGrade: "A", overallScore: 88 }]));
    const safetyResult = await collectSafetyScores(makeCollectorCtx(mockD1([])), new Set(["USDT"]));
    const db = mockD1([
      { match: "GROUP BY recorded_at HAVING COUNT(*) > 15", rows: [] },
      {
        match: "ORDER BY ABS(COALESCE(score, 0) - COALESCE(prev_score, 0)) DESC",
        rows: [{ history_id: "safety-score-history:v2:test", stablecoin_id: "usdt-tether", recorded_at: todayTs, model: "v9", identity_schema_version: 1, methodology_version: "9.0", policy_id: "safety-score-v9", policy_digest: "a".repeat(64), evaluation_build_digest: "b".repeat(64), base_input_generation_id: `report-cards-input:v1:${"b".repeat(64)}`, model_publication_generation_id: "report-cards:v9:1", transition_kind: "organic-grade-change", grade: "A-", score: 80, prev_grade: "A", prev_score: 85 }],
      },
    ]);
    const result = await collectGradeTransitions(makeCollectorCtx(db), safetyResult.value.safetyGrades, safetyResult.value.safetyIdentity);

    expect(result.value).toHaveLength(1);
    expect(result.value?.[0]).toMatchObject({ symbol: "USDT", fromGrade: "A", toGrade: "A-", safetyScoreIdentity: { model: "v9", methodologyVersion: "9.0", publicationGenerationId: "report-cards:v9:1" } });
    expect((db as MockD1Database).getHistory().some((entry) => entry.sql.includes("safety_grade_history"))).toBe(false);
    expect(result.degradedReasons).toEqual([]);
  });
});

describe("collectMintBurnFlows", () => {
  beforeEach(() => {
    vi.mocked(loadActiveSafetyScoreSource)
      .mockReset()
      .mockResolvedValue(canonicalSafetySource([]));
  });

  it("omits the block without degrading when no gauge has been published yet", async () => {
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: ["mint-burn-flows:v3:aggregate:24"],
      rows: [],
      first: null,
    }]);

    const result = await collectMintBurnFlows(makeCollectorCtx(db));

    expect(result.value).toBeUndefined();
    expect(result.degradedReasons).toEqual([]);
  });

  it("degrades when the published gauge is malformed", async () => {
    const db = mockD1([publishedGaugeTable({ value: '{"gauge":{"score":"nope"}}' })]);

    const result = await collectMintBurnFlows(makeCollectorCtx(db));

    expect(result.value).toBeUndefined();
    expect(result.degradedReasons).toEqual(["mint-burn-gauge-malformed"]);
  });

  it("degrades when the published gauge predates the current digest cycle", async () => {
    const db = mockD1([publishedGaugeTable({ ageSec: 25 * 3600 })]);

    const result = await collectMintBurnFlows(makeCollectorCtx(db));

    expect(result.value).toBeUndefined();
    expect(result.degradedReasons).toEqual(["mint-burn-gauge-expired"]);
  });

  it("still re-bins a stale publication but records the staleness", async () => {
    const db = mockD1([publishedGaugeTable({ ageSec: 3 * 3600 })]);

    const result = await collectMintBurnFlows(makeCollectorCtx(db));

    expect(result.value?.gaugeScore).toBe(PUBLISHED_GAUGE_SCORE);
    expect(result.degradedReasons).toEqual(["mint-burn-gauge-stale"]);
  });

  it.each([
    { label: "never derives the gauge from mint_burn_hourly" },
    { label: "re-bins the published Bank Run Gauge into the stored input" },
  ])("$label", async () => {
    const db = mockD1([publishedGaugeTable()]);

    const result = await collectMintBurnFlows(makeCollectorCtx(db));

    expect(result.value?.gaugeScore).toBe(PUBLISHED_GAUGE_SCORE);
    expect(result.value?.gaugeBand).toBe("HEALTHY");
    expect(result.value?.flightToQuality).toEqual({
      active: false,
      // PAXG is outside the digest's core aggregate universe but inside the
      // published gauge universe, so its net flow reaches the FTQ split.
      safeNetUsd: 150_000_000,
      riskyNetUsd: -3_000_000,
    });
    expect(result.value?.topPressure.map((row) => row.symbol)).toEqual(["USDT", "USDC"]);
    // One canonical loader serves both the digest collectors and the FTQ
    // classifier, so the suite's healthy source classifies here. The
    // fail-closed FTQ arms are covered by
    // daily-digest/__tests__/mint-burn-ftq.test.ts.
    expect(result.value?.classificationSource).toBe("safety-score-v9-publication");
    expect(result.value?.classificationReason).toBeNull();
    expect(result.value?.topChains).toEqual([
      { chainId: "ethereum", netUsd: 150_000_000 },
      { chainId: "arbitrum", netUsd: -3_000_000 },
    ]);
    const prompt = buildUserPrompt({
      totalMcapUsd: 1,
      mcap7dDelta: 0,
      activeDepegCount: 0,
      topDepegs: [],
      biggestSupplyChange: null,
      stabilityIndex: null,
      yesterdayIndex: null,
      mintBurnFlows: result.value!,
    });
    expect(prompt).toContain("Top chains by net flow");
    expect(
      (db as MockD1Database).getHistory().some((entry) => entry.sql.includes("mint_burn_hourly")),
    ).toBe(false);
  });
});

describe("collectActiveDepegs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sorts active depegs by absolute market impact and marks small chronic noise", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "dai-makerdao",
            symbol: "DAI",
            direction: "above",
            peak_deviation_bps: 500,
            started_at: nowSec - 8 * 86_400,
          },
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: -100,
            started_at: nowSec - 3600,
          },
        ],
      },
    ]);

    const result = await collectActiveDepegs(makeCollectorCtx(db));

    expect(result.value.topDepegs[0]).toMatchObject({
      symbol: "USDC",
      bps: -100,
      direction: "below",
    });
    expect(result.value.topDepegs[1].suppressReason).toContain("sub-$20M");
  });

  it("keeps critical live depegs unsuppressed and returns more than three prompt candidates", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "dai-makerdao",
            symbol: "DAI",
            direction: "above",
            peak_deviation_bps: 500,
            started_at: nowSec - 8 * 86_400,
          },
          {
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            direction: "below",
            peak_deviation_bps: -25,
            started_at: nowSec - 3600,
          },
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: -5200,
            started_at: nowSec - 10 * 86_400,
          },
          {
            stablecoin_id: "dai-makerdao",
            symbol: "DAI2",
            direction: "above",
            peak_deviation_bps: 150,
            started_at: nowSec - 3600,
          },
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    ctx.stablecoinAssetById.set("usdc-circle", { ...ctx.stablecoinAssetById.get("usdc-circle")!, price: 0.48 });
    ctx.stablecoinAssetById.set("usdt-tether", { ...ctx.stablecoinAssetById.get("usdt-tether")!, price: 0.97 });

    const result = await collectActiveDepegs(ctx);

    expect(result.value.topDepegs).toHaveLength(4);
    expect(result.value.topDepegs[0]).toMatchObject({
      symbol: "USDC",
      bps: -5200,
    });
    expect(result.value.topDepegs[0].suppressReason).toBeUndefined();
  });

  it("keeps the open event peak as authoritative while showing cache price as context", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -5568,
            peak_price: 0.443,
            peg_reference: 1,
            started_at: nowSec - 3600,
          },
        ],
      },
    ]);

    const result = await collectActiveDepegs(makeCollectorCtx(db));

    expect(result.value.activeDepegCount).toBe(1);
    expect(result.value.topDepegs[0]).toMatchObject({
      symbol: "USDC",
      bps: -5568,
      peakBps: -5568,
      currentPriceUsd: 0.99,
      peakPriceUsd: 0.443,
    });
  });

  it("reports monitored variant depegs without adding variants to monetary aggregates", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "susds-sky",
            symbol: "sUSDS",
            direction: "below",
            peak_deviation_bps: -125,
            started_at: nowSec - 3600,
          },
        ],
      },
    ]);
    const ctx = makeCollectorCtx(db);
    const variant = makeAsset({
      id: "susds-sky",
      symbol: "sUSDS",
      circulating: { peggedUSD: 1_000_000_000 },
    });
    ctx.trackedStablecoinAssets.push(variant);
    (ctx.trackedStablecoinIds as Set<string>).add(variant.id);
    ctx.stablecoinAssetById.set(variant.id, variant);
    ctx.mcapById.set(variant.id, 1_000_000_000);

    const result = await collectActiveDepegs(ctx);

    expect(ctx.coreAggregateStablecoinIds.has(variant.id)).toBe(false);
    expect(result.value.activeDepegCount).toBe(1);
    expect(result.value.topDepegs[0]).toMatchObject({ stablecoinId: "susds-sky", symbol: "sUSDS" });
  });

  it("filters frozen coins out of digest active depeg candidates", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "usr-resolv",
            symbol: "USR",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -9025,
            peak_price: 0.0975,
            peg_reference: 1,
            started_at: nowSec - 3600,
          },
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -100,
            peak_price: 0.99,
            peg_reference: 1,
            started_at: nowSec - 3600,
          },
        ],
      },
    ]);

    const result = await collectActiveDepegs(makeCollectorCtx(db));

    expect(result.value.activeDepegCount).toBe(1);
    expect(result.value.topDepegs).toHaveLength(1);
    expect(result.value.topDepegs[0]).toMatchObject({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
    });
    expect(result.value.topDepegs.some((depeg) => depeg.stablecoinId === "usr-resolv")).toBe(false);
  });

  it("keeps an open depeg event even when the cache price appears recovered", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -500,
            peak_price: 0.95,
            peg_reference: 1,
            started_at: nowSec - 3600,
          },
        ],
      },
    ]);

    const result = await collectActiveDepegs(makeCollectorCtx(db));

    expect(result.value.activeDepegCount).toBe(1);
    expect(result.value.topDepegs[0]).toMatchObject({
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      bps: -500,
      direction: "below",
      peakBps: -500,
      peakPriceUsd: 0.95,
      currentPriceUsd: 0.9975,
    });
  });

  it("falls back to stored peak severity when stablecoins cache freshness is expired", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -3000,
            peak_price: 0.7,
            peg_reference: 1,
            started_at: nowSec - 3600,
          },
        ],
      },
    ]);
    const ctx = makeCollectorCtx(db);
    ctx.stablecoinAssetById.set("usdc-circle", { ...ctx.stablecoinAssetById.get("usdc-circle")!, price: 0.999 });
    ctx.stablecoinsCacheIsFresh = false;

    const result = await collectActiveDepegs(ctx);

    expect(result.value.topDepegs[0]).toMatchObject({
      stablecoinId: "usdc-circle",
      bps: -3000,
      peakBps: -3000,
      severityBasis: "peak-fallback",
    });
    expect(result.value.topDepegs[0].currentBps).toBeUndefined();
    expect(result.value.topDepegs[0].currentPriceUsd).toBeUndefined();
    expect(result.value.topDepegs[0].suppressReason).toBeUndefined();
  });
});

describe("collectSupplyVelocity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits decelerating when a material weekly trend slows sharply", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);
    const yesterdayTs = todayTs - 86_400;
    const weekAgoTs = todayTs - 7 * 86_400;
    const db = mockD1([
      {
        match: "FROM supply_history WHERE stablecoin_id IN",
        rows: [
          { stablecoin_id: "usdt-tether", snapshot_date: todayTs, circulating_usd: 101_400_000_000 },
          { stablecoin_id: "usdt-tether", snapshot_date: yesterdayTs, circulating_usd: 101_350_000_000 },
          { stablecoin_id: "usdt-tether", snapshot_date: weekAgoTs, circulating_usd: 100_000_000_000 },
        ],
      },
    ]);

    const result = await collectSupplyVelocity(makeCollectorCtx(db));

    expect(result.value).toEqual([expect.objectContaining({ coin: "USDT", signal: "decelerating" })]);
  });
});

describe("collectPsiContributors", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns top 3 contributors sorted by marketImpact", async () => {
    const db = mockD1([
      {
        match: "SELECT input_snapshot, stored_at FROM stability_index_samples",
        first: {
          stored_at: Math.floor(Date.now() / 1000) - 600,
          input_snapshot: JSON.stringify({
            contributors: [
              { id: "usdt-tether", symbol: "USDT", bps: 10, mcapUsd: 100_000_000_000, ageDays: 1, factor: 1.5 },
              { id: "usdc-circle", symbol: "USDC", bps: 20, mcapUsd: 50_000_000_000, ageDays: 2, factor: 1.2 },
              { id: "dai-makerdao", symbol: "DAI", bps: 50, mcapUsd: 5_000_000, ageDays: 1, factor: 1.0 },
              { id: "frax-finance", symbol: "FRAX", bps: 30, mcapUsd: 1_000_000_000, ageDays: 3, factor: 2.0 },
            ],
          }),
        },
        rows: [],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectPsiContributors(ctx);

    expect(result).toBeDefined();
    expect(result!.value!.length).toBe(3);
    // Should be sorted by marketImpact descending
    expect(result!.value![0].marketImpact).toBeGreaterThanOrEqual(result!.value![1].marketImpact);
    expect(result!.value![1].marketImpact).toBeGreaterThanOrEqual(result!.value![2].marketImpact);
    // USDT should be first: |10| * 100B / 1e9 * 1.5 = 1500
    expect(result!.value![0].symbol).toBe("USDT");
  });

  it("returns undefined when no input_snapshot exists", async () => {
    const db = mockD1([
      {
        match: "SELECT input_snapshot, stored_at FROM stability_index_samples",
        first: null,
        rows: [],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectPsiContributors(ctx);
    expect(result.value).toBeUndefined();
  });

  it("returns undefined when contributors array is empty", async () => {
    const db = mockD1([
      {
        match: "SELECT input_snapshot, stored_at FROM stability_index_samples",
        first: { stored_at: Math.floor(Date.now() / 1000) - 600, input_snapshot: JSON.stringify({ contributors: [] }) },
        rows: [],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectPsiContributors(ctx);
    expect(result.value).toBeUndefined();
  });

  it("drops a stale sample and records the degradation instead of presenting old attribution", async () => {
    const db = mockD1([
      {
        match: "SELECT input_snapshot, stored_at FROM stability_index_samples",
        first: {
          stored_at: Math.floor(Date.now() / 1000) - 3 * 3600,
          input_snapshot: JSON.stringify({
            contributors: [{ id: "usdt-tether", symbol: "USDT", bps: 10, mcapUsd: 1e9, ageDays: 1, factor: 1 }],
          }),
        },
        rows: [],
      },
    ]);

    const result = await collectPsiContributors(makeCollectorCtx(db));
    expect(result.value).toBeUndefined();
    expect(result.degradedReasons).toContain("psi-contributors-stale");
  });

  it("marks the collector degraded when the query throws", async () => {
    const db = mockD1([
      {
        match: "SELECT input_snapshot, stored_at FROM stability_index_samples",
        rows: [],
        throwError: new Error("d1 unavailable"),
      },
    ]);

    const result = await collectPsiContributors(makeCollectorCtx(db));
    expect(result.value).toBeUndefined();
    expect(result.degradedReasons).toContain("psi-contributors-query");
  });
});

describe("silent-failure collectors return degradedReasons", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collectResolvedDepegs records resolved-depegs-query on failure", async () => {
    const db = mockD1([{ match: "depeg_events", rows: [], throwError: new Error("boom") }]);
    const result = await collectResolvedDepegs(makeCollectorCtx(db));
    expect(result.value).toBeUndefined();
    expect(result.degradedReasons).toContain("resolved-depegs-query");
  });

  it("collectLiquidityShifts records liquidity-shifts-query on failure", async () => {
    const db = mockD1([{ match: "dex_liquidity", rows: [], throwError: new Error("boom") }]);
    const result = await collectLiquidityShifts(makeCollectorCtx(db));
    expect(result.value).toBeUndefined();
    expect(result.degradedReasons).toContain("liquidity-shifts-query");
  });
});

describe("collectYieldAnomalies", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns yield anomalies filtered by is_best and mcap", async () => {
    const db = mockD1([
      {
        match: "FROM yield_data",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            current_apy: 8.5,
            apy_7d: 4.2,
            apy_30d: 3.8,
            warning_signals: JSON.stringify(["spike", "divergence"]),
          },
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            current_apy: 5.1,
            apy_7d: 4.9,
            apy_30d: 4.5,
            warning_signals: JSON.stringify(["tvl-outflow"]),
          },
          {
            stablecoin_id: "dai-makerdao",
            symbol: "DAI",
            current_apy: 12.0,
            apy_7d: 3.0,
            apy_30d: 2.5,
            warning_signals: JSON.stringify(["spike"]),
          },
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectYieldAnomalies(ctx);

    expect(result).toBeDefined();
    // DAI should be filtered out (mcap $5M < $10M threshold)
    expect(result!.value!.length).toBe(2);
    expect(result!.value!.every((r) => r.mcapUsd >= 10_000_000)).toBe(true);
    // Should be sorted by mcap * warnings.length descending
    expect(result!.value![0].symbol).toBe("USDT");
    expect(result!.value![0].warnings).toEqual(["spike", "divergence"]);
    const yieldSql = db.getHistory().find((entry) => entry.sql.includes("FROM yield_data"))?.sql;
    expect(yieldSql).toContain("publication_generation_id IS NULL OR publication_state = 'published'");
  });

  it("excludes staged and failed yield anomalies behaviorally", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
            const freshUpdatedAt = Math.floor(Date.now() / 1000) - 600;
      const insertYield = sqlite.prepare(
        `INSERT INTO yield_data (
          stablecoin_id, source_key, symbol, is_best, current_apy, apy_7d, apy_30d,
          yield_source, yield_type, data_source,
          warning_signals, publication_generation_id, publication_state, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Test source', 'lending', 'defillama', ?, ?, ?, ?)`,
      );
      insertYield.run("usdt-tether", "usdt-source", "USDT", 1, 12, 5, 4, JSON.stringify(["spike"]), "gen-failed", "failed", freshUpdatedAt);
      insertYield.run("dai-makerdao", "dai-source", "DAI", 1, 11, 4, 3, JSON.stringify(["spike"]), "gen-staged", "staged", freshUpdatedAt);
      insertYield.run(
        "usdc-circle",
        "usdc-source",
        "USDC",
        1,
        5.1,
        4.9,
        4.5,
        JSON.stringify(["tvl-outflow"]),
        "gen-published",
        "published",
        freshUpdatedAt,
      );

      const result = await collectYieldAnomalies(makeCollectorCtx(createSqliteD1(sqlite)));

      expect(result.value?.map((row) => row.symbol)).toEqual(["USDC"]);
    } finally {
      sqlite.close();
    }
  });

  it("returns undefined when no rows have warnings", async () => {
    const db = mockD1([
      {
        match: "FROM yield_data",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            current_apy: 4.0,
            apy_7d: 3.9,
            apy_30d: 3.8,
            warning_signals: "[]",
          },
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectYieldAnomalies(ctx);
    expect(result.value).toBeUndefined();
  });

  it("returns at most 5 results", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      stablecoin_id: `coin-${i}`,
      symbol: `C${i}`,
      current_apy: 10 + i,
      apy_7d: 5,
      apy_30d: 4,
      warning_signals: JSON.stringify(["spike"]),
    }));

    const mcapById = new Map<string, number>();
    for (let i = 0; i < 8; i++) mcapById.set(`coin-${i}`, 20_000_000_000);

    const db = mockD1([{ match: "FROM yield_data", rows }]);
    const ctx = makeCollectorCtx(db);
    // Override mcapById to include all coins
    for (let i = 0; i < 8; i++) ctx.mcapById.set(`coin-${i}`, 20_000_000_000);

    const result = await collectYieldAnomalies(ctx);
    expect(result).toBeDefined();
    expect(result!.value!.length).toBe(5);
  });
});

describe("collectLiquidityShifts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const COVERAGE = { coverage_class: "primary", coverage_confidence: 0.9, methodology_version: "6.1" };

  it("returns shifts with delta >= 8 sorted by |delta| * mcap", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);
    const yesterdayTs = todayTs - 86_400;
    const dayBeforeTs = yesterdayTs - 86_400;

    const db = mockD1([
      {
        match: "FROM dex_liquidity_history",
        rows: [
          { stablecoin_id: "usdt-tether", liquidity_score: 85, total_tvl_usd: 500_000_000, snapshot_date: yesterdayTs, ...COVERAGE },
          { stablecoin_id: "usdt-tether", liquidity_score: 75, total_tvl_usd: 480_000_000, snapshot_date: dayBeforeTs, ...COVERAGE },
          { stablecoin_id: "usdc-circle", liquidity_score: 70, total_tvl_usd: 300_000_000, snapshot_date: yesterdayTs, ...COVERAGE },
          { stablecoin_id: "usdc-circle", liquidity_score: 68, total_tvl_usd: 290_000_000, snapshot_date: dayBeforeTs, ...COVERAGE },
          { stablecoin_id: "dai-makerdao", liquidity_score: 50, total_tvl_usd: 1_000_000, snapshot_date: yesterdayTs, ...COVERAGE },
          { stablecoin_id: "dai-makerdao", liquidity_score: 30, total_tvl_usd: 800_000, snapshot_date: dayBeforeTs, ...COVERAGE },
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectLiquidityShifts(ctx);

    expect(result).toBeDefined();
    // USDT: delta=10 (>=8, mcap $100B) -> included
    // USDC: delta=2 (<8) -> excluded
    // DAI: delta=20 (>=8, but mcap $5M < $10M) -> excluded
    expect(result!.value!.length).toBe(1);
    expect(result!.value![0].symbol).toBe("USDT");
    expect(result!.value![0].scoreDelta).toBe(10);
    expect(result!.value![0].currentScore).toBe(85);
    expect(result!.value![0].previousScore).toBe(75);
    expect(result!.value![0].coverageClass).toBe("primary");
    expect(result!.value![0].tvlChangePct).toBeCloseTo(0.0417, 4);
  });

  it("returns undefined when no shifts exceed threshold", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);
    const yesterdayTs = todayTs - 86_400;
    const dayBeforeTs = yesterdayTs - 86_400;

    const db = mockD1([
      {
        match: "FROM dex_liquidity_history",
        rows: [
          { stablecoin_id: "usdt-tether", liquidity_score: 80, total_tvl_usd: 500_000_000, snapshot_date: yesterdayTs, ...COVERAGE },
          { stablecoin_id: "usdt-tether", liquidity_score: 78, total_tvl_usd: 480_000_000, snapshot_date: dayBeforeTs, ...COVERAGE },
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectLiquidityShifts(ctx);
    expect(result.value).toBeUndefined();
  });

  it("keeps a comparable collapse so the editorial layer can judge corroboration", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);
    const yesterdayTs = todayTs - 86_400;
    const dayBeforeTs = yesterdayTs - 86_400;

    const db = mockD1([
      {
        match: "FROM dex_liquidity_history",
        rows: [
          { stablecoin_id: "usdt-tether", liquidity_score: 75, total_tvl_usd: 13_720_000, snapshot_date: yesterdayTs, ...COVERAGE },
          { stablecoin_id: "usdt-tether", liquidity_score: 85, total_tvl_usd: 152_000_000, snapshot_date: dayBeforeTs, ...COVERAGE },
        ],
      },
    ]);

    const result = await collectLiquidityShifts(makeCollectorCtx(db));

    // A real 91% drain must survive collection; suppression is the candidate
    // layer's call, because only it can see prices, flows, and supply.
    expect(result.value![0].tvlChangePct).toBeCloseTo(-0.9097, 4);
    expect(result.degradedReasons).toEqual([]);
  });

  it("drops a pair that straddles a methodology version change", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);
    const yesterdayTs = todayTs - 86_400;
    const dayBeforeTs = yesterdayTs - 86_400;

    const db = mockD1([
      {
        match: "FROM dex_liquidity_history",
        rows: [
          { stablecoin_id: "usdt-tether", liquidity_score: 71, total_tvl_usd: 480_000_000, snapshot_date: yesterdayTs, ...COVERAGE, methodology_version: "6.0" },
          { stablecoin_id: "usdt-tether", liquidity_score: 85, total_tvl_usd: 500_000_000, snapshot_date: dayBeforeTs, ...COVERAGE, methodology_version: "5.91" },
        ],
      },
    ]);

    const result = await collectLiquidityShifts(makeCollectorCtx(db));

    expect(result.value).toBeUndefined();
    expect(result.degradedReasons).toContain("liquidity-shift-methodology-basis-change");
  });

  it("drops fallback-sourced rows the public API already marks untrendworthy", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);
    const yesterdayTs = todayTs - 86_400;
    const dayBeforeTs = yesterdayTs - 86_400;

    const db = mockD1([
      {
        match: "FROM dex_liquidity_history",
        rows: [
          { stablecoin_id: "usdt-tether", liquidity_score: 75, total_tvl_usd: 400_000_000, snapshot_date: yesterdayTs, coverage_class: "fallback", coverage_confidence: 0.5, methodology_version: "6.1" },
          { stablecoin_id: "usdt-tether", liquidity_score: 85, total_tvl_usd: 500_000_000, snapshot_date: dayBeforeTs, ...COVERAGE },
        ],
      },
    ]);

    const result = await collectLiquidityShifts(makeCollectorCtx(db));

    expect(result.value).toBeUndefined();
    expect(result.degradedReasons).toContain("liquidity-shift-non-trendworthy-coverage");
  });
});

describe("collectCrossDayTrends", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns PSI, mcap, and gauge trajectories from archived digests", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const makeDigestRow = (daysAgo: number, psiScore: number, band: string, mcap: number, gaugeScore?: number) => ({
      generated_at: nowSec - daysAgo * 86_400,
      input_data: JSON.stringify({
        totalMcapUsd: mcap,
        mcap7dDelta: 0,
        activeDepegCount: 0,
        topDepegs: [],
        biggestSupplyChange: null,
        stabilityIndex: { score: psiScore, band, components: { severity: 0, breadth: 0, trend: 0 } },
        yesterdayIndex: null,
        ...(gaugeScore != null
          ? {
              mintBurnFlows: {
                gaugeScore,
                gaugeBand: "STABLE",
                flightToQuality: { active: false, safeNetUsd: 0, riskyNetUsd: 0 },
                topPressure: [],
              },
            }
          : {}),
      }),
    });

    const db = mockD1([
      {
        match: "FROM daily_digest",
        rows: [
          makeDigestRow(0, 92, "BEDROCK", 200e9, -5),
          makeDigestRow(1, 91, "BEDROCK", 199e9, -3),
          makeDigestRow(2, 90, "STEADY", 198e9, -1),
          makeDigestRow(3, 89, "STEADY", 197e9),
          makeDigestRow(4, 88, "STEADY", 196e9),
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectCrossDayTrends(ctx);

    expect(result).toBeDefined();
    // PSI trajectory should be reversed to chronological
    expect(result!.value!.psiTrajectory.length).toBe(5);
    expect(result!.value!.psiTrajectory[0].score).toBe(88); // oldest first
    expect(result!.value!.psiTrajectory[4].score).toBe(92); // newest last
    // mcap trajectory
    expect(result!.value!.mcapTrajectory.length).toBe(5);
    expect(result!.value!.mcapTrajectory[0].mcapUsd).toBe(196e9);
    // gauge trajectory: only 3 entries have gauge data, exactly 3 points
    expect(result!.value!.gaugeTrajectory).toBeDefined();
    expect(result!.value!.gaugeTrajectory!.length).toBe(3);
  });

  it("returns null gauge trajectory when fewer than 3 gauge points", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const makeRow = (daysAgo: number) => ({
      generated_at: nowSec - daysAgo * 86_400,
      input_data: JSON.stringify({
        totalMcapUsd: 200e9,
        mcap7dDelta: 0,
        activeDepegCount: 0,
        topDepegs: [],
        biggestSupplyChange: null,
        stabilityIndex: { score: 90, band: "BEDROCK", components: { severity: 0, breadth: 0, trend: 0 } },
        yesterdayIndex: null,
        mintBurnFlows:
          daysAgo === 0
            ? {
                gaugeScore: -5,
                gaugeBand: "STABLE",
                flightToQuality: { active: false, safeNetUsd: 0, riskyNetUsd: 0 },
                topPressure: [],
              }
            : undefined,
      }),
    });

    const db = mockD1([
      {
        match: "FROM daily_digest",
        rows: [makeRow(0), makeRow(1), makeRow(2), makeRow(3)],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectCrossDayTrends(ctx);

    expect(result).toBeDefined();
    expect(result!.value!.psiTrajectory.length).toBe(4);
    // Only 1 gauge point -> should be null
    expect(result!.value!.gaugeTrajectory).toBeNull();
  });

  it("returns undefined when fewer than 3 digest entries", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM daily_digest",
        rows: [
          {
            generated_at: nowSec - 86_400,
            input_data: JSON.stringify({
              totalMcapUsd: 200e9,
              mcap7dDelta: 0,
              activeDepegCount: 0,
              topDepegs: [],
              biggestSupplyChange: null,
              stabilityIndex: null,
              yesterdayIndex: null,
            }),
          },
          {
            generated_at: nowSec - 2 * 86_400,
            input_data: JSON.stringify({
              totalMcapUsd: 199e9,
              mcap7dDelta: 0,
              activeDepegCount: 0,
              topDepegs: [],
              biggestSupplyChange: null,
              stabilityIndex: null,
              yesterdayIndex: null,
            }),
          },
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectCrossDayTrends(ctx);
    expect(result.value).toBeUndefined();
  });
});

describe("collectHistoricalContext", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes historical context with PSI precedent and band streak", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);
    const first = (match: string, value: Record<string, unknown> | null): MockTableConfig => ({ match, rows: [], first: value });
    const db = mockD1([
      first("SELECT COUNT(*) as cnt FROM stability_index", { cnt: 90 }),
      first("SELECT MIN(generated_at) as oldest FROM daily_digest", null),
      first("FROM daily_digest\n           WHERE json_extract(input_data", { generated_at: todayTs - 30 * 86_400 + 8 * 3600, psi_score: 89.0, psi_band: "STEADY" }),
      {
        match: "ORDER BY computed_at DESC LIMIT 90",
        rows: [0, 1, 2].map((daysAgo) => ({ computed_at: todayTs - daysAgo * 86_400, band: "BEDROCK" })).concat({ computed_at: todayTs - 3 * 86_400, band: "STEADY" }),
      },
      first("SELECT circulating_usd AS ath_mcap, snapshot_date FROM supply_history", { ath_mcap: 120_000_000, snapshot_date: todayTs - 60 * 86_400 }),
      first("ABS(s1.circulating_usd - s2.circulating_usd)", { snapshot_date: todayTs - 45 * 86_400, abs_change: 8_000_000 }),
    ]);

    const result = await collectHistoricalContext(makeCollectorCtx(db), 91.2, "BEDROCK", { id: "usdt-tether", symbol: "USDT", name: "Tether USD", changeUsd: 5_000_000, currentMcap: 100_000_000 });

    expect(result.value).toMatchObject({ psiBandStreak: 3, psiPrecedent: { lastSeenDaysAgo: 30 } });
  });
});

describe("collectDewsStress — topSignals enrichment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks the collector degraded instead of using a partial staged generation", async () => {
    const computedAt = Math.floor(Date.now() / 1000) - 600;
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [],
        first: {
          value: JSON.stringify({
            updatedAt: computedAt,
            source: "compute-dews",
            publishStatus: "published",
            coverageVersion: 2,
            expectedRowCount: 2,
            stablecoinIdsDigest: buildDewsStablecoinIdsDigest(["usdc-circle", "usdt-tether"]),
          }),
          updated_at: computedAt,
        },
      },
      {
        match: "pharos:stress-signals:published-exact",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            score: 65,
            band: "ALERT",
            signals_json: "{}",
            computed_at: computedAt,
          },
        ],
      },
    ]);
    const result = await collectDewsStress(makeCollectorCtx(db));

    expect(result.value).toBeUndefined();
    expect(result.degradedReasons).toContain("dews-published-generation");
  });

  it("returns topSignals on elevated coins when signals_json is provided", async () => {
    const computedAt = Math.floor(Date.now() / 1000) - 600;
    const dewsRows: TestDewsRow[] = [
      {
        stablecoin_id: "usdt-tether",
        score: 65,
        band: "ALERT",
        signals_json: JSON.stringify({
          supply: { value: 30, available: true },
          pool: { value: 80, available: true },
          liq: { value: 45, available: true },
          price: { value: 10, available: true },
        }),
        computed_at: computedAt,
      },
    ];
    const db = mockD1([
      ...makePublishedDewsTables(dewsRows),
      {
        match: "FROM stress_signal_history WHERE snapshot_date = ?",
        rows: [{ stablecoin_id: "usdt-tether", score: 25, band: "WATCH" }],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectDewsStress(ctx);

    expect(result).toBeDefined();
    expect(result!.value!.elevatedCoins.length).toBe(1);
    const elevated = result!.value!.elevatedCoins[0];
    expect(elevated.symbol).toBe("USDT");
    expect(elevated.topSignals).toBeDefined();
    expect(elevated.topSignals!.length).toBe(3); // top 3
    // Sorted descending by value
    expect(elevated.topSignals![0].value).toBeGreaterThanOrEqual(elevated.topSignals![1].value);
    expect(elevated.topSignals![1].value).toBeGreaterThanOrEqual(elevated.topSignals![2].value);
    // Pool (80) should be first
    expect(elevated.topSignals![0].name).toBe("pool balance drift");
  });

  it.each([
    {
      label: "returns empty topSignals when signals_json is missing",
      stablecoinId: "usdt-tether",
      signalsJson: "{}",
      history: [],
    },
    {
      label: "marks the digest degraded when persisted DEWS signals JSON is malformed",
      stablecoinId: "usdc-circle",
      signalsJson: '{"pool":',
      history: [{ stablecoin_id: "usdc-circle", score: 30, band: "WATCH" }],
      expectedTopDriver: "unknown",
      degradedReason: "dews-stress-signals-json",
    },
  ])("$label", async ({ stablecoinId, signalsJson, history, expectedTopDriver, degradedReason }) => {
    const computedAt = Math.floor(Date.now() / 1000) - 600;
    const db = mockD1([
      ...makePublishedDewsTables([{
        stablecoin_id: stablecoinId,
        score: 65,
        band: "ALERT",
        signals_json: signalsJson,
        computed_at: computedAt,
      }]),
      { match: "FROM stress_signal_history WHERE snapshot_date = ?", rows: history },
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await collectDewsStress(makeCollectorCtx(db));
      expect(result).toBeDefined();
      expect(result!.value!.elevatedCoins.length).toBe(1);
      if (expectedTopDriver) expect(result!.value!.bandChanges[0].topDriver).toBe(expectedTopDriver);
      else expect(result!.value!.elevatedCoins[0].topSignals).toEqual([]);
      if (degradedReason) expect(result!.degradedReasons).toContain(degradedReason);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.each([
    { label: "unwraps the v5.95 wrapped { signals, amplifiers } shape for elevatedCoins and bandChanges" },
    { label: "includes DEWS stress data with band changes in stored input" },
  ])("$label", async () => {
    const wrappedJson = JSON.stringify({
      signals: {
        supply: { value: 30, available: true },
        pool: { value: 80, available: true },
        liq: { value: 45, available: true },
      },
      amplifiers: { psi: 1.08, contagion: 1.15 },
    });
    const dewsRows: TestDewsRow[] = [
      {
        stablecoin_id: "usdt-tether",
        score: 65,
        band: "ALERT",
        signals_json: wrappedJson,
        computed_at: Math.floor(Date.now() / 1000) - 600,
      },
      {
        stablecoin_id: "usdc-circle",
        score: 62,
        band: "ALERT",
        signals_json: '{"pool":{"value":70,"available":true},"liq":{"value":50,"available":true}}',
        computed_at: Math.floor(Date.now() / 1000) - 600,
      },
      {
        stablecoin_id: "dai-makerdao",
        score: 8,
        band: "CALM",
        signals_json: '{"supply":{"value":5,"available":true}}',
        computed_at: Math.floor(Date.now() / 1000) - 600,
      },
    ];
    const db = mockD1([
      ...makePublishedDewsTables(dewsRows),
      {
        match: "FROM stress_signal_history WHERE snapshot_date = ?",
        rows: [
          { stablecoin_id: "usdt-tether", score: 25, band: "WATCH" },
          { stablecoin_id: "usdc-circle", score: 30, band: "WATCH" },
          { stablecoin_id: "dai-makerdao", score: 8, band: "CALM" },
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectDewsStress(ctx);

    expect(result).toBeDefined();
    // bandChanges must recover the top driver from the nested signals map.
    expect(result!.value!.bandChanges.length).toBe(2);
    expect(result!.value!.bandChanges[0].topDriver).toBe("pool balance drift");
    expect(result!.value!.bandCounts.calm).toBeGreaterThanOrEqual(1);
    expect(result!.value!.bandChanges.find((change) => change.symbol === "USDC")).toMatchObject({
      from: "WATCH",
      to: "ALERT",
    });
    // elevatedCoins must surface non-empty topSignals — previously the Object.entries
    // iteration hit {signals,amplifiers} and filtered everything out.
    const elevated = result!.value!.elevatedCoins[0];
    expect(elevated.topSignals!.length).toBe(3);
    expect(elevated.topSignals![0].name).toBe("pool balance drift");
  });

  it("produces identical elevatedCoins.topSignals for flat and wrapped shapes of the same signals", async () => {
    const signalsPayload = {
      supply: { value: 30, available: true },
      pool: { value: 80, available: true },
      liq: { value: 45, available: true },
    };
    const computedAt = Math.floor(Date.now() / 1000) - 600;
    const flatDb = mockD1([
      ...makePublishedDewsTables([
        {
          stablecoin_id: "usdt-tether",
          score: 65,
          band: "ALERT",
          signals_json: JSON.stringify(signalsPayload),
          computed_at: computedAt,
        },
      ]),
      { match: "FROM stress_signal_history WHERE snapshot_date = ?", rows: [] },
    ]);
    const wrappedDb = mockD1([
      ...makePublishedDewsTables([
        {
          stablecoin_id: "usdt-tether",
          score: 65,
          band: "ALERT",
          signals_json: JSON.stringify({
            signals: signalsPayload,
            amplifiers: { psi: 1, contagion: 1 },
          }),
          computed_at: computedAt,
        },
      ]),
      { match: "FROM stress_signal_history WHERE snapshot_date = ?", rows: [] },
    ]);

    const flat = await collectDewsStress(makeCollectorCtx(flatDb));
    const wrapped = await collectDewsStress(makeCollectorCtx(wrappedDb));
    expect(wrapped!.value!.elevatedCoins[0].topSignals).toEqual(flat!.value!.elevatedCoins[0].topSignals);
  });
});

describe("gate/retry correctness (Batch 3)", () => {
  const mentionOnlyProfile: DigestValidationProfile = {
    kind: "daily",
    recentMeta: [],
    leadRequirements: [
      { candidateIds: [], severity: "soft", mentionTokens: ["PMUSD"], reason: "ongoing critical, demoted" },
    ],
  };

  it.each([
    {
      label: "flags forbidden phrases as a soft issue instead of silently stripping them",
      parsed: () => {
        const parsed = makeParsedFixture({
          extended: "Meanwhile, USDT sits still at 3 bps. Watch for USDC next session if flows reverse hard tomorrow. The market held its line through the close today quietly.\n\nSupply held flat for a third session running now. Depth on the majors stayed intact through both sessions. Nothing in the flow data suggests stress building yet.\n\nDEWS stayed green across every tracked name today. The gauge sat at plus twelve through the close. Nobody moved more than ten million on the day.",
        });
        parsed.forbiddenPhraseHits = ["Meanwhile, "];
        return parsed;
      },
      profile: { kind: "daily", recentMeta: [] } satisfies DigestValidationProfile,
      expected: [{ code: "forbidden-phrase", present: true, severity: "soft" as const }],
      copyIncludes: "Meanwhile, ",
    },
    {
      label: "flags meta.coins entries the copy never mentions",
      parsed: () => {
        const parsed = makeParsedFixture();
        parsed.digestMeta = JSON.stringify({ lead: "depeg", tone: "dry", coins: ["USDT", "GHOST"] });
        parsed.digestText = "USDT held its peg with room to spare. Watch for tomorrow's flows next session.";
        return parsed;
      },
      profile: { kind: "daily", recentMeta: [] } satisfies DigestValidationProfile,
      expected: [{
        code: "meta-coins-mismatch",
        present: true,
        severity: "soft" as const,
        messageIncludes: "GHOST",
        messageExcludes: "USDT,",
      }],
    },
    {
      label: "validates mention-only requirements without pinning a lead",
      parsed: () => {
        const parsed = makeParsedFixture({ leadSignalId: "yield:usdc" });
        parsed.digestExtended = `PMUSD remains 2,950 bps under peg, unchanged. ${parsed.digestExtended}`;
        return parsed;
      },
      profile: mentionOnlyProfile,
      expected: [
        { code: "required-lead-missing", present: false },
        { code: "lead-candidate-mismatch", present: false },
      ],
    },
    {
      label: "flags a missing mention-only token as a soft issue",
      parsed: () => makeParsedFixture({ leadSignalId: "yield:usdc" }),
      profile: mentionOnlyProfile,
      expected: [
        { code: "required-lead-missing", present: true, severity: "soft" as const },
        { code: "lead-candidate-mismatch", present: false },
      ],
    },
  ])("$label", ({ parsed: buildParsed, profile, expected, ...testCase }) => {
    const parsed = buildParsed();
    const issues = validateDigestModelOutput(parsed, profile);
    for (const expectation of expected) {
      const hit = issues.find((issue) => issue.code === expectation.code);
      expect(hit != null).toBe(expectation.present);
      if ("severity" in expectation) expect(hit?.severity).toBe(expectation.severity);
      if ("messageIncludes" in expectation) expect(hit?.message).toContain(expectation.messageIncludes);
      if ("messageExcludes" in expectation) expect(hit?.message).not.toContain(expectation.messageExcludes);
    }
    if ("copyIncludes" in testCase) expect(parsed.digestExtended).toContain(testCase.copyIncludes);
  });
});

describe("editorial guards (Batch 7)", () => {
  const repeatedUsxTitles = [
    { meta: null, title: "USX Turns Twenty Days Old" },
    { meta: null, title: "USX Passes 450 Hours Broken" },
  ];

  it.each([
    {
      label: "flags a price/bps contradiction in one sentence",
      parsed: () => makeParsedFixture({ extended: `USX sits 5,783 bps below peg while the quote reads $0.997 as a courtesy. ${DEFAULT_PARSED_EXTENDED}` }),
      profile: { kind: "daily", recentMeta: [], depegFacts: [{ symbol: "USX", currentPriceUsd: 0.4217, currentBps: -5783 }] } satisfies DigestValidationProfile,
      expected: [{ code: "price-bps-mismatch", present: true, severity: "soft" as const, messageIncludes: "USX" }],
    },
    {
      label: "accepts a consistent price/bps pairing",
      parsed: () => makeParsedFixture({ extended: `USX sits 5,783 bps below peg at $0.42 with no bid in sight. ${DEFAULT_PARSED_EXTENDED}` }),
      profile: { kind: "daily", recentMeta: [], depegFacts: [{ symbol: "USX", currentPriceUsd: 0.4217, currentBps: -5783 }] } satisfies DigestValidationProfile,
      expected: [{ code: "price-bps-mismatch", present: false }],
    },
    {
      label: "flags fabricated movement claims against previous-edition facts",
      parsed: () => makeParsedFixture({ extended: `APXUSD narrowed from 3,650 bps yesterday, a recovery nobody measured. ${DEFAULT_PARSED_EXTENDED}` }),
      profile: { kind: "daily", recentMeta: [], prevDepegFacts: [{ symbol: "APXUSD", currentBps: -3159, bps: -3159 }] } satisfies DigestValidationProfile,
      expected: [{ code: "unverifiable-movement-claim", present: true }],
    },
    {
      label: "accepts movement claims the previous edition supports",
      parsed: () => makeParsedFixture({ extended: `APXUSD widened from 3,159 bps to 3,410 bps overnight. ${DEFAULT_PARSED_EXTENDED}` }),
      profile: { kind: "daily", recentMeta: [], prevDepegFacts: [{ symbol: "APXUSD", currentBps: -3159 }] } satisfies DigestValidationProfile,
      expected: [{ code: "unverifiable-movement-claim", present: false }],
    },
    {
      label: "flags the same coin in three consecutive titles and day-count titles",
      parsed: () => ({ ...makeParsedFixture(), digestTitle: "USX Enters Week Four" }),
      profile: { kind: "daily", recentMeta: repeatedUsxTitles } satisfies DigestValidationProfile,
      expected: [
        { code: "title-symbol-streak", present: true },
        { code: "title-day-counting", present: true },
      ],
    },
    {
      label: "does not flag a fresh subject or a first-day duration title",
      parsed: () => ({ ...makeParsedFixture(), digestTitle: "RLUSD Finds A Deeper Bid" }),
      profile: { kind: "daily", recentMeta: repeatedUsxTitles } satisfies DigestValidationProfile,
      expected: [
        { code: "title-symbol-streak", present: false },
        { code: "title-day-counting", present: false },
      ],
    },
    {
      label: "dedupes titles against the extended trailing window",
      parsed: () => ({ ...makeParsedFixture(), digestTitle: "USDC Touches Its Ceiling" }),
      profile: { kind: "daily", recentMeta: [], recentTitles: ["USDC Touches Its Ceiling"] } satisfies DigestValidationProfile,
      expected: [{ code: "repeated-title", present: true }],
    },
  ])("$label", ({ parsed: buildParsed, profile, expected }) => {
    const issues = validateDigestModelOutput(buildParsed(), profile);
    for (const expectation of expected) {
      const hit = issues.find((issue) => issue.code === expectation.code);
      expect(hit != null).toBe(expectation.present);
      if ("severity" in expectation) expect(hit?.severity).toBe(expectation.severity);
      if ("messageIncludes" in expectation) expect(hit?.message).toContain(expectation.messageIncludes);
    }
  });
});

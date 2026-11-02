import { describe, it, expect } from "vitest";
import type { DigestEditorialCandidate, DigestInputData } from "@shared/types/digest";
import type { StablecoinData } from "@shared/types/market";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  makeDigestSnapshotFixture,
  type DigestSnapshotDate,
  type DigestSnapshotFixture,
} from "../../test-helpers/__fixtures__/digest-snapshots";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { currentPegObservation, makeCollectorCtx } from "./daily-digest.test-support";
import { collectActiveDepegs } from "../daily-digest/collectors-market";
import { buildEditorialCandidates, compareEditorialCandidates } from "../daily-digest/editorial-candidates";
import { validateDigestModelOutput } from "../daily-digest/response";
import { buildCriticalDailyLeadRequirements } from "../daily-digest/critical-lead-requirements";
import { buildChangeSummary } from "../daily-digest/digest-change-summary";
import type { CollectorContext } from "../daily-digest/collectors-shared";

// Golden replay of the July 2026 "USX era": real stored DigestInputData from
// the production archive (trimmed to the fields the lead policy consumes).
// These fixtures reproduce the exact conditions of the 17-edition USX
// headline lock and the fabricated USDA recovery, and pin the fixed behavior.

function loadFixture(date: DigestSnapshotDate): DigestSnapshotFixture {
  return makeDigestSnapshotFixture(date);
}

interface DepegEventSeed {
  stablecoinId: string;
  symbol: string;
  peakBps: number;
  startedAt: number;
  mcapUsd: number;
  currentPriceUsd?: number;
  pegReference?: number;
}

function seedsFromFixture(inputData: DigestInputData): DepegEventSeed[] {
  return inputData.topDepegs.map((depeg) => ({
    stablecoinId: depeg.stablecoinId ?? depeg.symbol.toLowerCase(),
    symbol: depeg.symbol,
    peakBps: Math.abs(depeg.peakBps ?? depeg.bps),
    startedAt: depeg.startedAt ?? 0,
    mcapUsd: depeg.mcapUsd,
    currentPriceUsd: depeg.currentPriceUsd,
  }));
}

async function replayCollector(seeds: DepegEventSeed[], nowSec: number) {
  const rows = seeds.map((seed) => ({
    stablecoin_id: seed.stablecoinId,
    symbol: seed.symbol,
    peg_type: "peggedUSD",
    direction: "below",
    peak_deviation_bps: seed.peakBps,
    started_at: seed.startedAt,
    peak_price: null,
    peg_reference: seed.pegReference ?? 1,
  }));
  const stablecoinAssetById = new Map<string, StablecoinData>(
    seeds
      .filter((seed) => seed.currentPriceUsd != null)
      .map((seed) => [seed.stablecoinId, { id: seed.stablecoinId, price: seed.currentPriceUsd, priceObservedAt: nowSec } as StablecoinData]),
  );
  const ctx: CollectorContext = {
    db: mockD1([{ match: "depeg_events", rows }]),
    trackedStablecoinAssets: [],
    trackedStablecoinIds: new Set(seeds.map((seed) => seed.stablecoinId)),
    coreAggregateStablecoinAssets: [],
    coreAggregateStablecoinIds: new Set(),
    stablecoinAssetById,
    mcapById: new Map(seeds.map((seed) => [seed.stablecoinId, seed.mcapUsd])),
    currentPegObservationById: new Map(seeds.map((seed) => [seed.stablecoinId, currentPegObservation(seed.pegReference ?? 1)])),
    stablecoinsCacheIsFresh: true,
    nowSec,
    todayTs: nowSec - (nowSec % 86_400),
    yesterdayTs: nowSec - (nowSec % 86_400) - 86_400,
  };
  const result = await collectActiveDepegs(ctx);
  expect(result.degradedReasons).toEqual([]);
  return result.value;
}

function generatedAt(inputData: DigestInputData): number {
  const value = (inputData.dataQuality as { generatedAt?: number } | undefined)?.generatedAt;
  expect(typeof value).toBe("number");
  return value as number;
}

describe("daily-digest lead policy (golden replay of the July 2026 USX era)", () => {
  const fixture = loadFixture("2026-07-18");
  const nowSec = generatedAt(fixture.inputData);

  it.each(["2026-07-17", "2026-07-18"] as const)(
    "%s semantic fixture retains its competing signals and liquidity order under prospective risk tiers",
    (date) => {
      const replay = loadFixture(date);
      const candidates = buildEditorialCandidates(replay.inputData, replay.prevInputData);
      const candidateIds = candidates.map((candidate) => candidate.id);
      expect(candidateIds).toEqual(expect.arrayContaining([...replay.expectedCompetingCandidateIds]));
      // D-9 applies prospectively: none-risk PSI now precedes low-risk impact
      // leaders. Keep the historical fixture and published edition unchanged.
      expect(candidates[0]?.id).toBe("psi:bedrock");
      expect(candidates.filter((candidate) => candidate.kind === "liquidity").map((candidate) => candidate.id))
        .toEqual(replay.expectedLiquidityOrder);
    },
  );

  it("frozen usx-dforce no longer enters the active depeg set", async () => {
    const { topDepegs } = await replayCollector(seedsFromFixture(fixture.inputData), nowSec);
    expect(topDepegs.map((depeg) => depeg.stablecoinId)).not.toContain("usx-dforce");
  });

  it("scores severity on live deviation, not the frozen event peak", async () => {
    const { topDepegs } = await replayCollector(seedsFromFixture(fixture.inputData), nowSec);
    const apxusd = topDepegs.find((depeg) => depeg.stablecoinId === "apxusd-apyx");
    expect(apxusd).toBeDefined();
    // Stored peak claims -3159 bps; the live price ($0.8430) is -1570 bps.
    expect(apxusd?.currentBps).toBe(-1570);
    expect(apxusd?.severityBasis).toBe("current");
    expect(apxusd?.bps).toBe(-3159);
    // On the live basis this is neither a severe collapse nor suppressed.
    expect(apxusd?.suppressReason).toBeUndefined();
  });

  it("keeps a genuinely deep live depeg critical and unsuppressed", async () => {
    const { topDepegs } = await replayCollector(seedsFromFixture(fixture.inputData), nowSec);
    const pmusd = topDepegs.find((depeg) => depeg.stablecoinId === "pmusd-precious-metals");
    // pmUSD really does trade at ~$0.705 on $66M mcap: critical on live data.
    expect(pmusd?.currentBps).toBeLessThanOrEqual(-2500);
    expect(pmusd?.suppressReason).toBeUndefined();
  });

  it("hard lead requirement never targets a peak-only or frozen coin", async () => {
    const { topDepegs, activeDepegCount } = await replayCollector(seedsFromFixture(fixture.inputData), nowSec);
    const replayedInput: DigestInputData = { ...fixture.inputData, topDepegs, activeDepegCount };
    replayedInput.editorialCandidates = buildEditorialCandidates(replayedInput, fixture.prevInputData);
    const requirements = buildCriticalDailyLeadRequirements(replayedInput);
    const requiredIds = (requirements ?? []).flatMap((requirement) => requirement.candidateIds);
    expect(requiredIds).not.toContain("depeg:usx-dforce:active");
    expect(requiredIds).not.toContain("depeg:usda-avalon:active");
  });

  it("demotes the day-N chronic critical to a mention-only soft requirement", async () => {
    // Replaying Jul 18: the top eligible critical is pmUSD ($0.705 live on
    // $66M), weeks old and moving under the re-escalation threshold. Before
    // the lead quota, it would have been a hard pin every day — the exact
    // mechanism of the USX era.
    const current = await replayCollector(seedsFromFixture(fixture.inputData), nowSec);
    const previous = await replayCollector(seedsFromFixture(fixture.prevInputData as DigestInputData), nowSec - 86_400);
    const replayedInput: DigestInputData = { ...fixture.inputData, topDepegs: current.topDepegs };
    replayedInput.editorialCandidates = buildEditorialCandidates(replayedInput, fixture.prevInputData);
    const requirements = buildCriticalDailyLeadRequirements(replayedInput, {
      previousInputData: { ...(fixture.prevInputData as DigestInputData), topDepegs: previous.topDepegs },
      recentLeadSignalIds: ["depeg:pmusd-precious-metals:active", "depeg:pmusd-precious-metals:active"],
    });
    expect(requirements).toHaveLength(1);
    expect(requirements?.[0]?.severity).toBe("soft");
    expect(requirements?.[0]?.candidateIds).toEqual([]);
    expect(requirements?.[0]?.mentionTokens).toEqual(["PMUSD"]);
  });

  it("a fresh day-0 crash still produces a hard critical lead", async () => {
    const seeds: DepegEventSeed[] = [
      {
        stablecoinId: "synthetic-crash",
        symbol: "CRSH",
        peakBps: 5100,
        startedAt: nowSec - 3_600,
        mcapUsd: 60_000_000,
        currentPriceUsd: 0.49,
      },
    ];
    const { topDepegs, activeDepegCount } = await replayCollector(seeds, nowSec);
    expect(topDepegs[0]?.suppressReason).toBeUndefined();
    const input: DigestInputData = { ...fixture.inputData, topDepegs, activeDepegCount };
    input.editorialCandidates = buildEditorialCandidates(input, null);
    // A cleaner ordinary candidate cannot displace the independent hard lead.
    expect(input.editorialCandidates[0]?.id).toBe("psi:bedrock");
    const requirements = buildCriticalDailyLeadRequirements(input);
    expect(requirements?.[0]?.severity).toBe("hard");
    expect(requirements?.[0]?.candidateIds).toContain("depeg:synthetic-crash:active");
  });

  it("re-escalation overrides the lead quota; unchanged day-2 does not", async () => {
    const makeSeeds = (price: number): DepegEventSeed[] => [
      {
        stablecoinId: "synthetic-crash",
        symbol: "CRSH",
        peakBps: 5100,
        startedAt: nowSec - 40 * 3_600,
        mcapUsd: 60_000_000,
        currentPriceUsd: price,
      },
    ];
    const streakedHistory = ["depeg:synthetic-crash:active", "depeg:synthetic-crash:active"];
    const current = await replayCollector(makeSeeds(0.42), nowSec);
    const previousWorse = await replayCollector(makeSeeds(0.49), nowSec - 86_400);
    const input: DigestInputData = { ...fixture.inputData, topDepegs: current.topDepegs };
    input.editorialCandidates = buildEditorialCandidates(input, null);
    // Worsened 700 bps overnight: hard again despite the exhausted quota.
    const escalated = buildCriticalDailyLeadRequirements(input, {
      previousInputData: { ...fixture.inputData, dataQuality: { ...fixture.inputData.dataQuality!, generatedAt: nowSec - 86_400 }, topDepegs: previousWorse.topDepegs },
      recentLeadSignalIds: streakedHistory,
    });
    expect(escalated?.[0]?.severity).toBe("hard");
    // Unchanged since yesterday: quota applies, demoted to mention-only.
    const unchanged = buildCriticalDailyLeadRequirements(input, {
      previousInputData: { ...fixture.inputData, topDepegs: current.topDepegs },
      recentLeadSignalIds: streakedHistory,
    });
    expect(unchanged?.[0]?.severity).toBe("soft");
    expect(unchanged?.[0]?.mentionTokens).toEqual(["CRSH"]);
  });

  it("keeps opposite movements of same-symbol coins attached to their identities", () => {
    const depeg = (stablecoinId: string, bps: number, priceObservedAt: number) => ({
      ...fixture.inputData.topDepegs[0], stablecoinId, symbol: "USDA", bps, currentBps: bps,
      severityBasis: "current" as const, pegReference: 1, startedAt: 1, priceObservedAt,
    });
    const previous = { ...fixture.inputData, dataQuality: { ...fixture.inputData.dataQuality!, generatedAt: nowSec - 86_400 }, topDepegs: [depeg("usda-avalon", 3098, nowSec - 86_400), depeg("usda-alpha-partner", 503, nowSec - 86_400)] };
    const current = { ...fixture.inputData, topDepegs: [depeg("usda-alpha-partner", 603, nowSec), depeg("usda-avalon", 2898, nowSec)] };
    const summary = buildChangeSummary(current, previous);
    expect(summary.improvedSignals.filter((change) => change.kind === "depeg")).toEqual([
      { id: "change:depeg:usda-avalon:improved", label: "USDA depeg narrowed", kind: "depeg", symbols: ["USDA"], detail: "3098 bps to 2898 bps off peg." },
    ]);
    expect(summary.worsenedSignals.filter((change) => change.kind === "depeg")).toEqual([
      { id: "change:depeg:usda-alpha-partner:worsened", label: "USDA depeg widened", kind: "depeg", symbols: ["USDA"], detail: "503 bps to 603 bps off peg." },
    ]);
  });

  it("candidate novelty reflects the day-over-day delta instead of always 'worsening'", async () => {
    const currentSeeds = seedsFromFixture(fixture.inputData);
    const prevSeeds = fixture.prevInputData ? seedsFromFixture(fixture.prevInputData) : [];
    const current = await replayCollector(currentSeeds, nowSec);
    const previous = await replayCollector(prevSeeds, nowSec - 86_400);
    const currentInput: DigestInputData = { ...fixture.inputData, topDepegs: current.topDepegs };
    const previousInput: DigestInputData = {
      ...(fixture.prevInputData as DigestInputData),
      topDepegs: previous.topDepegs,
    };
    const candidates = buildEditorialCandidates(currentInput, previousInput);
    const apx = candidates.find((candidate) => candidate.id === "depeg:apxusd-apyx:active");
    // apxUSD moved ~$0.861 -> $0.843 (~-208 bps day-over-day): genuinely worsening.
    expect(apx?.novelty).toBe("worsening");
    const alphaPartner = candidates.find((candidate) => candidate.id === "depeg:usda-alpha-partner:active");
    expect(alphaPartner).toBeDefined();
    // usda-alpha-partner barely moved and is weeks old: no more perpetual "worsening".
    expect(alphaPartner?.novelty).not.toBe("worsening");
  });

  it("marks a stored peak as historical in the candidate and change-summary labels", () => {
    const at = 1_788_000_000;
    const data: DigestInputData = {
      totalMcapUsd: 250_000_000_000,
      mcap7dDelta: 1_000_000_000,
      activeDepegCount: 1,
      biggestSupplyChange: null,
      stabilityIndex: null,
      yesterdayIndex: null,
      dataQuality: {
        generatedAt: at, stablecoinsCacheUpdatedAt: at, stablecoinsCacheAgeSec: 0,
        windows: {
          blacklistActivity: { label: "rolling last 24h", start: at - 86_400, end: at },
          mintBurnFlows: { label: "unavailable", start: null, end: null },
          supplyVelocity: { label: "UTC snapshots", dates: [] },
          psi: { label: "latest sample", sampleAt: null, dailySnapshotAt: null },
        },
      },
      topDepegs: [{
        stablecoinId: "usdt-tether", symbol: "USDT", bps: -3000, direction: "below",
        mcapUsd: 1_500_000_000, startedAt: at - 10 * 3_600, ageHours: 10,
        impactScore: 4500, peakBps: 3000, severityBasis: "peak-fallback", quoteMode: "usd",
      }],
    };
    data.editorialCandidates = buildEditorialCandidates(data, null);
    const candidate = data.editorialCandidates.find((entry) => entry.id === "depeg:usdt-tether:active");
    expect(candidate?.suppressReason).toBeUndefined();
    // The title is published verbatim as the reader-facing "What changed" label,
    // so the stored peak must carry the same provenance as the prompt and tape.
    expect(candidate?.title).toContain("stored peak");
    expect(candidate?.title).not.toBe("USDT active 3000 bps below peg");
    const label = buildChangeSummary(data, null).newSignals
      .find((change) => change.id === "depeg:usdt-tether:active")?.label;
    expect(label).toContain("stored peak");
    // The same title repeats in later editions while the fallback persists.
    const repeated = buildChangeSummary(data, { ...data, editorialCandidates: data.editorialCandidates })
      .repeatedSignals.find((change) => change.id === "depeg:usdt-tether:active")?.label;
    expect(repeated).toContain("stored peak");
  });

  it("pins the critical coin's own candidate when two coins share a symbol", async () => {
    const at = Math.floor(Date.now() / 1000);
    const ctx = makeCollectorCtx(mockD1([{
      match: "FROM depeg_events",
      rows: [
        {
          stablecoin_id: "usda-alpha-partner", symbol: "USDA", peg_type: "peggedUSD",
          direction: "below", peak_deviation_bps: 5_120, started_at: at - 3 * 3_600,
          peak_price: null, peg_reference: 1,
        },
        {
          stablecoin_id: "usda-anzens", symbol: "USDA", peg_type: "peggedUSD",
          direction: "below", peak_deviation_bps: 2_140, started_at: at - 61 * 3_600,
          peak_price: null, peg_reference: 1,
        },
      ],
    }]));
    for (const asset of [
      makeAsset({ id: "usda-alpha-partner", symbol: "USDA", price: 0.488, priceObservedAt: ctx.nowSec }),
      makeAsset({ id: "usda-anzens", symbol: "USDA", price: 0.786, priceObservedAt: ctx.nowSec }),
    ]) {
      ctx.trackedStablecoinIds = new Set([...ctx.trackedStablecoinIds, asset.id]);
      ctx.stablecoinAssetById.set(asset.id, asset);
    }
    ctx.mcapById.set("usda-alpha-partner", 22_400_000);
    ctx.mcapById.set("usda-anzens", 104_000_000);

    const collected = await collectActiveDepegs(ctx);
    // Both USDA events are USD-quoted: the derived $1 reference makes these
    // live deviations (price against par), not stored-peak fallbacks.
    const byId = new Map(collected.value.topDepegs.map((depeg) => [depeg.stablecoinId, depeg]));
    expect(byId.get("usda-alpha-partner")).toMatchObject({ severityBasis: "current", currentBps: -5_120 });
    expect(byId.get("usda-anzens")).toMatchObject({ severityBasis: "current", currentBps: -2_140 });
    const input: DigestInputData = {
      ...fixture.inputData,
      activeDepegCount: collected.value.activeDepegCount,
      topDepegs: collected.value.topDepegs,
    };
    input.editorialCandidates = buildEditorialCandidates(input, null);
    // Artifact risk outranks impact, so the larger sub-critical coin's
    // candidate precedes the critical one.
    const depegCandidateIds = input.editorialCandidates
      .filter((entry) => entry.kind === "depeg")
      .map((entry) => entry.id);
    expect(depegCandidateIds).toEqual(["depeg:usda-anzens:active", "depeg:usda-alpha-partner:active"]);

    const [requirement] = buildCriticalDailyLeadRequirements(input) ?? [];
    expect(requirement?.severity).toBe("hard");
    expect(requirement?.candidateIds).toEqual(["depeg:usda-alpha-partner:active"]);
  });
});

describe("next-trigger lifecycle (Batch 4)", () => {
  const fixture18 = loadFixture("2026-07-18");

  it("builds evaluatable triggers for yield and liquidity candidates", async () => {
    const { buildNextTriggers } = await import("../daily-digest/digest-next-triggers");
    const input: DigestInputData = {
      ...fixture18.inputData,
      yieldAnomalies: [{ symbol: "USD1", currentApy: 25.6, apy7d: 9.1, apy30d: 8.4, warnings: ["spike"], mcapUsd: 2e9 }],
      liquidityShifts: [
        {
          symbol: "USDF",
          currentScore: 44,
          previousScore: 60,
          scoreDelta: -16,
          currentTvl: 1e8,
          previousTvl: 2e8,
          mcapUsd: 1.4e9,
          tvlChangePct: -0.5,
          expectedScoreDeltaFromTvl: -3.2,
          coverageClass: "primary",
          coverageConfidence: 0.9,
        },
      ],
      editorialCandidates: [
        {
          id: "yield:usd1",
          kind: "yield",
          title: "USD1 APY spike",
          symbols: ["USD1"],
          impactScore: 900,
          novelty: "new",
          confidence: "high",
          artifactRisk: "medium",
          headlineFacts: [],
          whyItMatters: "w",
        },
        {
          id: "liquidity:usdf",
          kind: "liquidity",
          title: "USDF depth loss",
          symbols: ["USDF"],
          impactScore: 800,
          novelty: "worsening",
          confidence: "medium",
          artifactRisk: "medium",
          headlineFacts: [],
          whyItMatters: "w",
        },
      ],
    };
    const triggers = buildNextTriggers(input, null);
    const yieldTrigger = triggers.find((trigger) => trigger.metric === "yield-apy");
    expect(yieldTrigger?.symbol).toBe("USD1");
    expect(yieldTrigger?.comparator).toBe("lte");
    const liquidityTrigger = triggers.find((trigger) => trigger.metric === "liquidity-score");
    expect(liquidityTrigger?.symbol).toBe("USDF");
    expect(liquidityTrigger?.thresholdValue).toBe(36);
  });
});

describe("depeg lifecycle flags (Batch 5)", () => {
  it("flags stalled collapses and chronic shallow events from the Jul 18 replay", async () => {
    const { classifyDepegLifecycle } = await import("../../lib/depeg-lifecycle");
    const fixture = loadFixture("2026-07-18");
    const { topDepegs } = await replayCollector(seedsFromFixture(fixture.inputData), generatedAt(fixture.inputData));
    const lifecycleRows = topDepegs.map((depeg) => ({
      stablecoinId: depeg.stablecoinId ?? depeg.symbol,
      symbol: depeg.symbol,
      ageHours: depeg.ageHours,
      currentBps: depeg.currentBps,
      mcapUsd: depeg.mcapUsd,
    }));
    lifecycleRows.push({
      stablecoinId: "chronic-fixture",
      symbol: "CHRONIC",
      ageHours: 40 * 24,
      currentBps: -100,
      mcapUsd: 50_000_000,
    });
    const flags = classifyDepegLifecycle(lifecycleRows);
    const byId = new Map(flags.map((flag) => [flag.stablecoinId, flag.kind]));
    // pmUSD: $0.705 live, event ~80 days old -> a stalled collapse awaiting review.
    expect(byId.get("pmusd-precious-metals")).toBe("stalled-collapse");
    // A long-open shallow deviation remains a chronic review flag.
    expect(byId.get("chronic-fixture")).toBe("chronic-shallow");
    // usda-avalon is frozen, so its live quote no longer enters the active replay.
    expect(byId.has("usda-avalon")).toBe(false);
    // apxUSD: -1,570 bps live -> neither shallow nor >=2,500; needs no ruling.
    expect(byId.has("apxusd-apyx")).toBe(false);
  });

  it("never flags rows without a live deviation", async () => {
    const { classifyDepegLifecycle } = await import("../../lib/depeg-lifecycle");
    const flags = classifyDepegLifecycle([
      { stablecoinId: "x", symbol: "X", ageHours: 24 * 40, currentBps: undefined, mcapUsd: 5e7 },
    ]);
    expect(flags).toHaveLength(0);
  });
});

describe("cause context + chronic ledger (Batch 8)", () => {
  it("attaches curated cause annotations for depeg coins within the lookback window", async () => {
    const { collectCauseContext } = await import("../daily-digest/cause-context");
    const nowSec = 1_784_361_907;
    // usdc-circle has curated depeg annotations (SVB 2023-03-11); an event
    // starting near that date picks them up, one starting years later does not.
    const svbEra = collectCauseContext(
      [{ stablecoinId: "usdc-circle", symbol: "USDC", bps: -1300, mcapUsd: 4e10, startedAt: Math.floor(Date.UTC(2023, 2, 12) / 1000) }],
      nowSec,
    );
    expect(svbEra?.some((entry) => entry.label.toLowerCase().includes("svb"))).toBe(true);
    const recent = collectCauseContext(
      [{ stablecoinId: "usdc-circle", symbol: "USDC", bps: -100, mcapUsd: 4e10, startedAt: nowSec - 86_400 }],
      nowSec,
    );
    expect(recent?.some((entry) => entry.label.toLowerCase().includes("svb")) ?? false).toBe(false);
  });

  it("builds the chronic ledger from multi-day depegs and formats the Telegram line", async () => {
    const { buildStandingConditions, formatStandingConditionsLine } = await import("../daily-digest/cause-context");
    const fixture = loadFixture("2026-07-18");
    const { topDepegs } = await replayCollector(seedsFromFixture(fixture.inputData), generatedAt(fixture.inputData));
    const conditions = buildStandingConditions(topDepegs);
    expect(conditions?.length).toBeGreaterThan(0);
    expect(conditions?.every((row) => row.ageDays >= 2)).toBe(true);
    const line = formatStandingConditionsLine(conditions);
    expect(line).toMatch(/^Standing: /);
    expect(line).toContain("pmUSD d");
    expect(formatStandingConditionsLine(undefined)).toBeNull();
  });
});

// Edition #179 (2026-08-21) led X and Telegram with "USDS bled 91% of its DEX
// liquidity to $13.72M in a day; a $6.71B coin now backs its on-chain exit with
// pocket change, and the composite score fell only ten points." The TVL number
// was a partial-ingestion artifact. These tests pin the editorial and
// publication gates that now stand between that data and a published claim.

const BASE = makeDigestSnapshotFixture("2026-07-18").inputData;

function inputWithShift(overrides: Partial<NonNullable<DigestInputData["liquidityShifts"]>[number]> = {}): DigestInputData {
  return {
    ...BASE,
    liquidityShifts: [
      {
        symbol: "USDS",
        currentScore: 46,
        previousScore: 56,
        scoreDelta: -10,
        currentTvl: 13_720_000,
        previousTvl: 152_000_000,
        mcapUsd: 6_710_000_000,
        tvlChangePct: -0.91,
        expectedScoreDeltaFromTvl: -11,
        coverageClass: "primary",
        coverageConfidence: 0.9,
        ...overrides,
      },
    ],
  };
}

describe("liquidity lead gating", () => {
  it("names an uncorroborated cliff as an unverified collapse", () => {
    const input = inputWithShift();
    input.topDepegs = [];
    input.supplyVelocity = [];
    input.mintBurnFlows = undefined;
    input.biggestSupplyChange = null;

    const candidate = buildEditorialCandidates(input).find((entry) => entry.id === "liquidity:usds");

    expect(candidate?.suppressReason).toContain("unverified single-source DEX TVL collapse");
    expect(candidate?.artifactRisk).toBe("high");
  });

  it("suppresses an ordinary uncorroborated move without calling it a collapse", () => {
    const input = inputWithShift({ currentTvl: 130_000_000, tvlChangePct: -0.14 });
    input.topDepegs = [];
    input.supplyVelocity = [];
    input.mintBurnFlows = undefined;
    input.biggestSupplyChange = null;

    const candidate = buildEditorialCandidates(input).find((entry) => entry.id === "liquidity:usds");

    expect(candidate?.suppressReason).toContain("no independent depeg, flow, or supply corroboration");
  });

  it("lets a corroborated collapse through, because a real drain is the story", () => {
    const input = inputWithShift();
    input.supplyVelocity = [];
    input.mintBurnFlows = undefined;
    input.biggestSupplyChange = null;
    input.topDepegs = [
      { symbol: "USDS", bps: -420, mcapUsd: 6_710_000_000, stablecoinId: "usds-sky", currentBps: -420 },
    ];

    const candidate = buildEditorialCandidates(input).find((entry) => entry.id === "liquidity:usds");

    expect(candidate?.suppressReason).toBeUndefined();
    expect(candidate?.headlineFacts.some((fact) => fact.includes("corroborated by active depeg"))).toBe(true);
  });

  it("does not accept DEWS as corroboration, because DEWS reads the same pool data", () => {
    const input = inputWithShift();
    input.topDepegs = [];
    input.supplyVelocity = [];
    input.mintBurnFlows = undefined;
    input.biggestSupplyChange = null;
    input.dewsStress = {
      bandCounts: { calm: 1, watch: 1, alert: 0, warning: 0, danger: 0 },
      yesterdayBandCounts: { calm: 2, watch: 0, alert: 0, warning: 0, danger: 0 },
      bandChanges: [{ symbol: "USDS", from: "CALM", to: "WATCH", score: 40, topDriver: "liq" }],
      elevatedCoins: [],
    };

    const candidate = buildEditorialCandidates(input).find((entry) => entry.id === "liquidity:usds");

    expect(candidate?.suppressReason).toContain("no independent");
  });

  it("clears suppression when an independent pipeline agrees", () => {
    const input = inputWithShift();
    input.topDepegs = [];
    input.mintBurnFlows = undefined;
    input.biggestSupplyChange = null;
    input.supplyVelocity = [{ coin: "USDS", change1d: -120_000_000, change7d: -400_000_000, signal: "accelerating" }];

    const candidate = buildEditorialCandidates(input).find((entry) => entry.id === "liquidity:usds");

    expect(candidate?.suppressReason).toBeUndefined();
    expect(candidate?.headlineFacts.some((fact) => fact.includes("corroborated by supply"))).toBe(true);
  });

  it("does not let market cap alone outrank a corroborated depeg", () => {
    const input = inputWithShift();
    input.supplyVelocity = [{ coin: "USDS", change1d: -120_000_000, change7d: -400_000_000, signal: "accelerating" }];

    const candidates = buildEditorialCandidates(input);
    const liquidityRank = candidates.findIndex((entry) => entry.id === "liquidity:usds");
    const topDepegRank = candidates.findIndex((entry) => entry.kind === "depeg" && !entry.suppressReason);

    expect(topDepegRank).toBeGreaterThanOrEqual(0);
    expect(topDepegRank).toBeLessThan(liquidityRank);
  });

  it("keeps every market-cap-scaled kind on one basis, so size cannot buy the lead", () => {
    // The #179 mechanism was arithmetic, not judgement: liquidity scored
    // |delta| * mcap/1e6 while depegs scored |bps| * mcap/1e9, a 1000x
    // advantage. DEWS band moves shared the inflated basis, and its liquidity
    // input reads the same dex_liquidity rows, so the same artifact could buy
    // the headline through DEWS instead.
    const input = inputWithShift();
    input.supplyVelocity = [{ coin: "USDS", change1d: -120_000_000, change7d: -400_000_000, signal: "accelerating" }];
    input.dewsStress = {
      bandCounts: { calm: 1, watch: 1, alert: 0, warning: 0, danger: 0 },
      yesterdayBandCounts: { calm: 2, watch: 0, alert: 0, warning: 0, danger: 0 },
      bandChanges: [
        { symbol: "USDS", from: "CALM", to: "WATCH", score: 40, topDriver: "liq", mcapUsd: 6_710_000_000 },
      ],
      elevatedCoins: [],
    };

    const candidates = buildEditorialCandidates(input);
    const dews = candidates.find((entry) => entry.kind === "dews");
    const liquidity = candidates.find((entry) => entry.id === "liquidity:usds");
    const depeg = candidates.find((entry) => entry.kind === "depeg" && !entry.suppressReason);

    // A one-rank DEWS move on a $6.71B coin is single digits, not thousands.
    expect(dews!.impactScore).toBeLessThan(10);
    expect(liquidity!.impactScore).toBeLessThan(100);
    expect(depeg!.impactScore).toBeGreaterThan(dews!.impactScore);
    expect(depeg!.impactScore).toBeGreaterThan(liquidity!.impactScore);
  });

  it("blocks publication when the model leads with a suppressed candidate", () => {
    const issues = validateDigestModelOutput(
      {
        digestTitle: "USDS Pool Empties, Score Shrugs",
        digestText: "$USDS bled 91% of its DEX liquidity to $13.72M in a day.",
        digestExtended: [
          "USDS shed nine tenths of its measured on-chain exit depth in a single print, and the composite score barely blinked.",
          "That gap between the raw number and the score is the tell. A $6.71B coin does not quietly lose its pool depth without a matching flow somewhere else, and nothing else moved today.",
          "Watch for the next liquidity print to confirm or retract the drop before treating it as a market event worth acting on.",
        ].join("\n\n"),
        digestMeta: JSON.stringify({ leadSignalId: "liquidity:usds" }),
        strippedDashCount: 0,
        usedRawTextFallback: false,
      },
      { kind: "daily", suppressedCandidateIds: ["liquidity:usds"] },
    );

    const blocking = issues.find((issue) => issue.code === "suppressed-lead");
    expect(blocking?.severity).toBe("hard");
  });
});

describe("editorial candidate total order", () => {
  function candidate(
    id: string,
    artifactRisk: DigestEditorialCandidate["artifactRisk"],
    impactScore: number,
    extra: Partial<DigestEditorialCandidate> = {},
  ): DigestEditorialCandidate {
    return {
      id, kind: "supply", title: id, symbols: [], artifactRisk, impactScore,
      novelty: "new", confidence: "high", headlineFacts: [], whyItMatters: id, ...extra,
    };
  }

  function permutations<T>(values: T[]): T[][] {
    if (values.length <= 1) return [values];
    return values.flatMap((value, index) =>
      permutations(values.filter((_, other) => other !== index)).map((rest) => [value, ...rest]));
  }

  it("replaces the concrete 25-point preference cycle with risk tiers in every permutation", () => {
    // Previously A beat B (20-point gap), B beat C (20), but C beat A (40).
    const cycle = [candidate("a", "low", 30), candidate("b", "medium", 50), candidate("c", "high", 70)];
    for (const order of permutations(cycle)) {
      expect(order.sort(compareEditorialCandidates).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    }
  });

  it("ranks eligibility, then none/low/medium/high risk, descending impact, then stable id", () => {
    const candidates = [
      candidate("suppressed", "none", 10_000, { suppressReason: "unverified" }),
      candidate("high", "high", 10_000),
      candidate("medium", "medium", 10_000, { kind: "liquidity" }),
      candidate("low", "low", 10_000, { kind: "yield" }),
      candidate("z", "none", 20),
      candidate("a", "none", 20),
      candidate("impact", "none", 21),
    ];
    expect(candidates.sort(compareEditorialCandidates).map((entry) => entry.id))
      .toEqual(["impact", "a", "z", "low", "medium", "high", "suppressed"]);
  });

  it("satisfies reflexivity, antisymmetry and transitivity across kinds, tiers and suppression", () => {
    const candidates = [
      candidate("none", "none", 0), candidate("low", "low", 30),
      candidate("medium", "medium", 50), candidate("high", "high", 70),
      candidate("liquidity", "medium", 10_000, { kind: "liquidity" }),
      candidate("yield", "low", 0, { kind: "yield" }),
      candidate("tie-a", "low", 30), candidate("tie-z", "low", 30),
      candidate("suppressed", "none", 10_000, { suppressReason: "unverified" }),
    ];
    for (const a of candidates) {
      expect(compareEditorialCandidates(a, a)).toBe(0);
      for (const b of candidates) {
        expect(Math.sign(compareEditorialCandidates(a, b)) + Math.sign(compareEditorialCandidates(b, a))).toBe(0);
        for (const c of candidates) {
          if (compareEditorialCandidates(a, b) <= 0 && compareEditorialCandidates(b, c) <= 0) {
            expect(compareEditorialCandidates(a, c)).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  });

  it("builds the same lead and full ordering for every admitted supply permutation", () => {
    const input = { ...BASE, supplyVelocity: [
      { coin: "Z", change1d: 30_000_000, change7d: 0, signal: "accelerating" as const },
      { coin: "A", change1d: 30_000_000, change7d: 0, signal: "accelerating" as const },
      { coin: "B", change1d: 50_000_000, change7d: 0, signal: "accelerating" as const },
    ] };
    const expected = buildEditorialCandidates(input).map((entry) => entry.id);
    for (const supplyVelocity of permutations(input.supplyVelocity)) {
      expect(buildEditorialCandidates({ ...input, supplyVelocity }).map((entry) => entry.id)).toEqual(expected);
    }
    expect(buildEditorialCandidates(input).filter((entry) => entry.kind === "supply").map((entry) => entry.id))
      .toEqual(["supply:b:accelerating", "supply:a:accelerating", "supply:z:accelerating"]);
  });
});

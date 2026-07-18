import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DigestInputData } from "@shared/types/digest";
import type { StablecoinData } from "@shared/types/market";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { collectActiveDepegs } from "../daily-digest/collectors-market";
import { buildEditorialCandidates } from "../daily-digest/editorial-candidates";
import { buildCriticalDailyLeadRequirements } from "../daily-digest/critical-lead-requirements";
import { buildChangeSummary } from "../daily-digest/digest-change-summary";
import type { CollectorContext } from "../daily-digest/collectors-shared";

// Golden replay of the July 2026 "USX era": real stored DigestInputData from
// the production archive (trimmed to the fields the lead policy consumes).
// These fixtures reproduce the exact conditions of the 17-edition USX
// headline lock and the fabricated USDA recovery, and pin the fixed behavior.

const FIXTURE_DIR = join(__dirname, "../../test-helpers/__fixtures__/digest-snapshots");

interface DigestSnapshotFixture {
  date: string;
  inputData: DigestInputData;
  prevInputData: DigestInputData | null;
}

const FIXTURES: Record<string, string> = {
  "2026-07-17": readFileSync(join(FIXTURE_DIR, "2026-07-17.json"), "utf8"),
  "2026-07-18": readFileSync(join(FIXTURE_DIR, "2026-07-18.json"), "utf8"),
};

function loadFixture(date: string): DigestSnapshotFixture {
  return JSON.parse(FIXTURES[date]) as DigestSnapshotFixture;
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
      .map((seed) => [seed.stablecoinId, { id: seed.stablecoinId, price: seed.currentPriceUsd } as StablecoinData]),
  );
  const ctx: CollectorContext = {
    db: mockD1([{ match: "depeg_events", rows }]),
    trackedStablecoinAssets: [],
    trackedStablecoinIds: new Set(seeds.map((seed) => seed.stablecoinId)),
    coreAggregateStablecoinAssets: [],
    coreAggregateStablecoinIds: new Set(),
    stablecoinAssetById,
    mcapById: new Map(seeds.map((seed) => [seed.stablecoinId, seed.mcapUsd])),
    nowSec,
    todayTs: nowSec - (nowSec % 86_400),
    yesterdayTs: nowSec - (nowSec % 86_400) - 86_400,
  };
  const result = await collectActiveDepegs(ctx);
  expect(result.degradedReason).toBeUndefined();
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

  it("frozen usx-dforce no longer enters the active depeg set", async () => {
    const { topDepegs } = await replayCollector(seedsFromFixture(fixture.inputData), nowSec);
    expect(topDepegs.map((depeg) => depeg.stablecoinId)).not.toContain("usx-dforce");
  });

  it("scores severity on live deviation, not the frozen event peak", async () => {
    const { topDepegs } = await replayCollector(seedsFromFixture(fixture.inputData), nowSec);
    const avalon = topDepegs.find((depeg) => depeg.stablecoinId === "usda-avalon");
    expect(avalon).toBeDefined();
    // Stored peak claims -3098 bps; the live price ($0.9821) is -179 bps.
    expect(avalon?.currentBps).toBe(-179);
    expect(avalon?.severityBasis).toBe("current");
    expect(avalon?.bps).toBe(-3098);
    // On the live basis this is a chronic shallow softness, not a critical
    // depeg: the age-based suppression rules apply again.
    expect(avalon?.suppressReason).toBeDefined();
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
      previousInputData: { ...fixture.inputData, topDepegs: previousWorse.topDepegs },
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

  it("change summary no longer fabricates cross-coin USDA movement", () => {
    // Jul 18's stored inputs contain usda-avalon (peak -3098) and
    // usda-alpha-partner (peak -503) — both symbol "USDA". The symbol-keyed
    // map published "USDA narrowed 3098 -> 503 bps" as fact.
    const summary = buildChangeSummary(fixture.inputData, fixture.prevInputData);
    const depegChanges = [...summary.improvedSignals, ...summary.worsenedSignals].filter(
      (change) => change.kind === "depeg",
    );
    for (const change of depegChanges) {
      expect(change.detail).not.toMatch(/3098 bps to 503 bps/);
    }
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
    // usda-alpha-partner barely moved and is weeks old: no more perpetual "worsening".
    expect(alphaPartner?.novelty).not.toBe("worsening");
  });
});

describe("next-trigger lifecycle (Batch 4)", () => {
  const fixture18 = loadFixture("2026-07-18");

  // Strip candidates so the fallback path (top depeg + PSI) arms deterministically
  // within TRIGGER_LIMIT regardless of what the fixture's candidate set produces.
  const bareInput: DigestInputData = { ...fixture18.inputData, editorialCandidates: [] };

  function inputWithTriggers(triggers: DigestInputData["nextTriggers"]): DigestInputData {
    return { ...bareInput, nextTriggers: triggers };
  }

  it("keeps an armed threshold sticky instead of chasing the metric", async () => {
    const { buildNextTriggers } = await import("../daily-digest/digest-next-triggers");
    const psi = (fixture18.inputData.stabilityIndex?.score ?? 90);
    // A deterioration target below the current score is genuinely pending.
    const previous = inputWithTriggers([
      {
        id: "trigger:psi-score",
        label: "PSI threshold",
        metric: "psi-score",
        comparator: "lte",
        thresholdValue: psi - 5,
        thresholdLabel: `${psi - 5} PSI`,
        rationale: "r",
        detail: "d",
      },
    ]);
    const triggers = buildNextTriggers(bareInput, previous);
    const psiTrigger = triggers.find((trigger) => trigger.id === "trigger:psi-score");
    expect(psiTrigger?.thresholdValue).toBe(psi - 5);
    expect(psiTrigger?.repeatedCount).toBe(1);
  });

  it("expires a perpetually-pending trigger after three editions and frees its slot", async () => {
    const { buildNextTriggers, buildForwardLookOutcomes } = await import("../daily-digest/digest-next-triggers");
    // The real corpus shape: the apxUSD widening trigger sat pending for 20
    // consecutive editions because its threshold could never be reached.
    const staleTrigger = {
      id: "trigger:depeg:apxusd-apyx",
      label: "APXUSD depeg widening",
      metric: "depeg-bps" as const,
      comparator: "abs-gte" as const,
      thresholdValue: 3650,
      thresholdLabel: "3650 bps off peg",
      symbol: "APXUSD",
      stablecoinId: "apxusd-apyx",
      rationale: "r",
      detail: "d",
      repeatedCount: 2,
    };
    const previous = inputWithTriggers([staleTrigger]);
    const triggers = buildNextTriggers(bareInput, previous);
    expect(triggers.find((trigger) => trigger.id === "trigger:depeg:apxusd-apyx")).toBeUndefined();
    const outcomes = buildForwardLookOutcomes(bareInput, previous);
    expect(outcomes.find((outcome) => outcome.triggerId === "trigger:depeg:apxusd-apyx")?.status).toBe("expired");
  });

  it("builds evaluatable triggers for yield and liquidity candidates", async () => {
    const { buildNextTriggers } = await import("../daily-digest/digest-next-triggers");
    const input: DigestInputData = {
      ...fixture18.inputData,
      yieldAnomalies: [{ symbol: "USD1", currentApy: 25.6, apy7d: 9.1, apy30d: 8.4, warnings: ["spike"], mcapUsd: 2e9 }],
      liquidityShifts: [
        { symbol: "USDF", currentScore: 44, previousScore: 60, scoreDelta: -16, currentTvl: 1e8, previousTvl: 2e8, mcapUsd: 1.4e9 },
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

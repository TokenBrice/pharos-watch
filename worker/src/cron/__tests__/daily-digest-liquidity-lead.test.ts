import { describe, it, expect } from "vitest";
import type { DigestEditorialCandidate, DigestInputData } from "@shared/types/digest";
import { makeDigestSnapshotFixture } from "../../test-helpers/__fixtures__/digest-snapshots";
import { buildEditorialCandidates, compareEditorialCandidates } from "../daily-digest/editorial-candidates";
import { validateDigestModelOutput } from "../daily-digest/response";

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

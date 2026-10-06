import { describe, expect, it } from "vitest";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import {
  assessV9Publication,
  buildSafetyScoreV9AcceptedPublicationBaseline,
  expiredMeasuredExitAssetIds,
  V9PublicationInputHealthSchema,
  type V9PublicationInputHealth,
} from "../safety-score-v9/publication-assessment";
import { canonicalV9RouteKey } from "@shared/lib/safety-score-v9/facts";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { buildSafetyScoreV9RouteReviews } from "../safety-score-v9/extension-routes";

const digest = (character: string) => character.repeat(64);

function candidate(
  cards:
    | SafetyScoreV9CurrentResponse["cards"][number]
    | SafetyScoreV9CurrentResponse["cards"] = makeWorkerV9Card({
      id: "alpha",
      score: 80,
      grade: "A-",
    }),
): SafetyScoreV9CurrentResponse {
  const cardList = Array.isArray(cards) ? cards : [cards];
  const notRatedIds = cardList
    .filter((card) => card.grade === "NR")
    .map((card) => card.id);
  const pipelineGapIds = cardList.filter((card) => card.ratingStatus === "pipeline-gap").map((card) => card.id);
  return {
    model: "v9-critical-path",
    schemaVersion: 6,
    lifecycle: "active",
    candidateId: `v9-rc-1`,
    policyVersion: "9.0",
    publicationGenerationId: "report-cards:v9:v1:test",
    baseInputGenerationId: `report-cards-input:v1:${digest("a")}`,
    factSetDigest: digest("b"),
    resultDigest: digest("c"),
    policy: { id: "safety-score-v9", semanticDigest: digest("d") },
    evaluationBuildDigest: digest("e"),
    sourceGenerations: { registry: "registry:test" },
    asOfSec: 1_700_000_000,
    publishedAtSec: 1_700_000_030,
    completeness: {
      expectedCount: cardList.length,
      ratedCount: cardList.length - notRatedIds.length - pipelineGapIds.length,
      notRatedCount: notRatedIds.length,
      notRatedIds,
      pipelineGapCount: pipelineGapIds.length, pipelineGapIds,
    },
    cards: cardList,
    foreignCauseGaps: [],
  };
}

function acceptedPublication(value = candidate()) {
  return buildSafetyScoreV9AcceptedPublicationBaseline(value);
}

function currentInputHealth(): V9PublicationInputHealth {
  return {
    dex: {
      state: "current",
      generationId: "dex-liquidity-1700000000",
      updatedAtSec: 1_700_000_000,
    },
    redemption: {
      state: "current",
      generationId: "redemption:test",
      updatedAtSec: 1_700_000_000,
    },
    liveReserves: { state: "available", coverageRatio: 1 },
  };
}

function producerFailedCard(args: { id?: string; score: number | null; grade: SafetyScoreV9CurrentResponse["cards"][number]["grade"] }) {
  return makeWorkerV9Card({ id: args.id ?? "alpha", score: null, grade: null, ratingStatus: "pipeline-gap" });
}

describe("Safety Score V9 publication assessment", () => {
  function measuredHistoryFixture() {
    const clockSec = 1_700_000_000;
    const fixedInput = makeV9FixedInput({ assetId: "alpha", clockSec });
    const observation = fixedInput.dexLiqMap.alpha!.exitRouteObservations![0]!;
    observation.evidenceKind = "measured-executable-depth";
    observation.confidence = "high";
    observation.observationHistory = {
      completeProducerCycleCount: 2,
      successfulObservationCount: 2,
      consecutiveSuccessCount: 2,
      observationWindowStartedAt: clockSec - 1_800,
      observationWindowEndedAt: clockSec,
      latestOperationalFailureAt: null,
      conservativeStatistic: "pointwise-minimum",
      conservativeCapacityCurve: observation.capacityCurve ?? [{
        requestedNotionalUsd: observation.requestedNotionalUsd,
        maxCostBps: observation.maxCostBps,
        executableUsd: observation.executableUsd,
        completionRatio: observation.completionRatio,
      }],
    };
    const card = makeWorkerV9Card({ id: "alpha", score: 81, grade: "A-" });
    card.breakdowns!.exit.primaryRoute!.key = canonicalV9RouteKey("dex", fixedInput.dexGenerationId, observation.routeId);
    // One affected root among 20 assets is below the ordinary partial gate.
    const publication = candidate([card, ...Array.from({ length: 19 }, (_, i) => makeWorkerV9Card({ id: `other-${i}` }))]);
    return { fixedInput, observation, card, publication, clockSec };
  }

  it("holds an expired mature quote window until refreshed evidence enters the exact input", () => {
    const { fixedInput, observation, publication, clockSec } = measuredHistoryFixture();
    const assess = () => assessV9Publication({
      inputHealth: currentInputHealth(),
      candidate: publication,
      // Stale-input admission must not depend on a prior score or build identity.
      acceptedPublication: null,
      coverageFloors: [],
      expiredMeasuredExitAssetIds: expiredMeasuredExitAssetIds(fixedInput, publication),
    });
    fixedInput.clockSec = clockSec + 10_800;
    expect(buildSafetyScoreV9RouteReviews(fixedInput, "alpha")[0]!.modelConfidence).toBe("high");
    expect(assess().decision).toBe("publish");
    fixedInput.clockSec++;
    expect(buildSafetyScoreV9RouteReviews(fixedInput, "alpha")[0]!.modelConfidence).toBe("medium");
    expect(assess()).toMatchObject({ decision: "hold", reasons: [{ code: "dex-stale" }], affectedAssetIds: ["alpha"] });

    // Recovery in the quote table cannot refresh a still-reused liquidity snapshot.
    const recoveredQuote = structuredClone(observation);
    recoveredQuote.observationHistory!.observationWindowEndedAt = fixedInput.clockSec;
    expect(assess().decision).toBe("hold");
    fixedInput.dexLiqMap.alpha!.exitRouteObservations = [recoveredQuote];
    expect(buildSafetyScoreV9RouteReviews(fixedInput, "alpha")[0]!.modelConfidence).toBe("high");
    expect(assess().decision).toBe("publish");
  });

  it("protects contributing backup routes, but ignores unused and zero-credit alternatives", () => {
    const { fixedInput, card, publication } = measuredHistoryFixture();
    fixedInput.clockSec += 10_801;
    const routeKey = card.breakdowns!.exit.primaryRoute!.key;
    card.breakdowns!.exit.primaryRoute!.key = "redemption:current:issuer";
    expect(expiredMeasuredExitAssetIds(fixedInput, publication)).toEqual([]);
    card.breakdowns!.exit.diversification = { routeKey, routeLabel: "Backup", bonus: 2 };
    expect(expiredMeasuredExitAssetIds(fixedInput, publication)).toEqual(["alpha"]);
    card.breakdowns!.exit.diversification.bonus = 0;
    expect(expiredMeasuredExitAssetIds(fixedInput, publication)).toEqual([]);
  });

  it.each(["primary", "backup"] as const)("keeps an expired former %s in the gate after a generation change and route reselection", (role) => {
    const { fixedInput, card, publication } = measuredHistoryFixture();
    publication.sourceGenerations.dex = fixedInput.dexGenerationId;
    if (role === "backup") {
      card.breakdowns!.exit.diversification = {
        routeKey: card.breakdowns!.exit.primaryRoute!.key, routeLabel: "Backup", bonus: 2,
      };
      card.breakdowns!.exit.primaryRoute!.key = "redemption:current:issuer";
    }
    const baseline = buildSafetyScoreV9AcceptedPublicationBaseline(publication);
    fixedInput.clockSec += 10_801;
    fixedInput.dexGenerationId = "dex-liquidity-next";
    card.breakdowns!.exit.primaryRoute!.key = "redemption:next:issuer";
    card.breakdowns!.exit.diversification = null;
    expect(expiredMeasuredExitAssetIds(fixedInput, publication, baseline)).toEqual([]);
    card.score = 79;
    card.grade = "B+";
    expect(expiredMeasuredExitAssetIds(fixedInput, publication, baseline)).toEqual(["alpha"]);
    publication.cards[0] = { ...card, score: null, grade: "NR", breakdowns: null };
    expect(expiredMeasuredExitAssetIds(fixedInput, publication, baseline)).toEqual(["alpha"]);
  });

  it("holds a rated-to-pipeline-gap transition when its former measured route expires", () => {
    const { fixedInput, publication, clockSec } = measuredHistoryFixture();
    publication.sourceGenerations.dex = fixedInput.dexGenerationId;
    const baseline = buildSafetyScoreV9AcceptedPublicationBaseline(publication);
    fixedInput.clockSec = clockSec + 10_801;
    fixedInput.dexGenerationId = "dex-liquidity-next";
    publication.cards[0] = producerFailedCard({ id: "alpha", score: null, grade: null });
    const expired = expiredMeasuredExitAssetIds(fixedInput, publication, baseline);
    expect(expired).toEqual(["alpha"]);
    expect(assessV9Publication({
      inputHealth: currentInputHealth(), candidate: publication,
      acceptedPublication: baseline, coverageFloors: [], expiredMeasuredExitAssetIds: expired,
    })).toEqual({ decision: "hold", reasons: [{ code: "dex-stale" }], affectedAssetIds: ["alpha"] });
  });

  it("rejects expired measured-route witnesses outside the candidate census", () => {
    const input = {
      inputHealth: currentInputHealth(), candidate: candidate(),
      acceptedPublication: null, coverageFloors: [],
    };
    expect(assessV9Publication(input).decision).toBe("publish");
    expect(() => assessV9Publication({
      ...input, expiredMeasuredExitAssetIds: ["missing-asset"],
    })).toThrow();
  });

  it("deduplicates stale DEX health and expired-route holds without dropping affected assets", () => {
    const { fixedInput, publication } = measuredHistoryFixture();
    fixedInput.clockSec += 10_801;
    const health = currentInputHealth();
    health.dex.state = "stale";
    expect(assessV9Publication({
      inputHealth: health, candidate: publication, acceptedPublication: null, coverageFloors: [],
      expiredMeasuredExitAssetIds: expiredMeasuredExitAssetIds(fixedInput, publication),
    })).toEqual({ decision: "hold", reasons: [{ code: "dex-stale" }], affectedAssetIds: ["alpha"] });
  });

  it.each([
    (observation: ExitRouteObservation) => { observation.observationHistory = undefined; },
    (observation: ExitRouteObservation) => { observation.observationHistory!.successfulObservationCount = 1; },
    (observation: ExitRouteObservation) => { observation.evidenceKind = "reserve-based-amm-simulation"; },
    (observation: ExitRouteObservation) => { observation.confidence = "medium"; },
  ])("does not relabel never-mature or non-measured evidence as an expired mature producer window", (change) => {
    const { fixedInput, observation, publication } = measuredHistoryFixture();
    fixedInput.clockSec += 10_801;
    change(observation);
    expect(expiredMeasuredExitAssetIds(fixedInput, publication)).toEqual([]);
  });

  it("continues to admit fresh adverse measurements after deterministic failures reset maturity", () => {
    const { fixedInput, observation, publication, card } = measuredHistoryFixture();
    const baseline = buildSafetyScoreV9AcceptedPublicationBaseline(publication);
    observation.observationHistory!.successfulObservationCount = 0;
    observation.observationHistory!.consecutiveSuccessCount = 0;
    observation.executableUsd = 0;
    observation.completionRatio = 0;
    card.score = 70;
    card.grade = "B";
    expect(assessV9Publication({
      inputHealth: currentInputHealth(), candidate: publication,
      acceptedPublication: baseline, coverageFloors: [],
      expiredMeasuredExitAssetIds: expiredMeasuredExitAssetIds(fixedInput, publication),
    }).decision).toBe("publish");
  });

  it.each([
    ["dex-stale", { dex: { state: "stale" as const } }],
    ["dex-unavailable", { dex: { state: "unavailable" as const } }],
    [
      "redemption-stale",
      { redemption: { state: "stale" as const } },
    ],
    [
      "redemption-unavailable",
      { redemption: { state: "unavailable" as const } },
    ],
    [
      "live-reserves-unavailable",
      { liveReserves: { state: "unavailable" as const, coverageRatio: null } },
    ],
  ] as Array<
    [
      string,
      {
        dex?: { state: "stale" | "unavailable" };
        redemption?: { state: "stale" | "unavailable" };
        liveReserves?: { state: "unavailable"; coverageRatio: null };
      },
    ]
  >)("holds a known global input failure: %s", (code, patch) => {
    const health = currentInputHealth();
    const inputHealth = {
      ...health,
      ...(patch.dex
        ? { dex: { ...health.dex, ...patch.dex } }
        : {}),
      ...(patch.redemption
        ? { redemption: { ...health.redemption, ...patch.redemption } }
        : {}),
      ...(patch.liveReserves
        ? { liveReserves: patch.liveReserves }
        : {}),
    };
    expect(
      assessV9Publication({
        inputHealth,
        candidate: candidate(),
        acceptedPublication: acceptedPublication(),
        coverageFloors: [],
      }),
    ).toMatchObject({
      decision: "hold",
      reasons: [{ code }],
    });
  });

  it("holds fulfilled live-reserve coverage below the calibrated 60% floor", () => {
    const assess = (coverageRatio: number) =>
      assessV9Publication({
        inputHealth: {
          ...currentInputHealth(),
          liveReserves: { state: "available", coverageRatio },
        },
        candidate: candidate(),
        acceptedPublication: acceptedPublication(),
        coverageFloors: [],
      });

    // Production baseline 2026-09-17: 173/212 admitted (0.816).
    expect(assess(0.816).decision).toBe("publish");
    expect(assess(0.6).decision).toBe("publish");
    expect(assess(0.599)).toMatchObject({
      decision: "hold",
      reasons: [{ code: "live-reserves-coverage-below-floor" }],
    });
  });

  it("accepts raw live-reserve coverage above one when admitted rows exceed the current registry denominator", () => {
    expect(
      V9PublicationInputHealthSchema.parse({
        ...currentInputHealth(),
        liveReserves: { state: "available", coverageRatio: 1.01 },
      }).liveReserves.coverageRatio,
    ).toBe(1.01);
  });

  it("does not hold non-applicable redemption or unrelated cron failures", () => {
    expect(
      assessV9Publication({
        inputHealth: {
          ...currentInputHealth(),
          redemption: {
            state: "not-applicable",
            generationId: null,
            updatedAtSec: null,
          },
        },
        candidate: candidate(),
        acceptedPublication: acceptedPublication(),
        coverageFloors: [],
      }),
    ).toEqual({
      decision: "publish",
      reasons: [],
      affectedAssetIds: [],
    });
  });

  it("holds the existing active-result and rateability coverage floors", () => {
    const result = assessV9Publication({
      inputHealth: currentInputHealth(),
      candidate: candidate(),
      acceptedPublication: acceptedPublication(),
      coverageFloors: [
        {
          id: "active-result-count",
          status: "fail",
          observed: 0,
          required: "= 1",
          detail: "missing result",
        },
        {
          id: "minimum-rateable-assets",
          status: "fail",
          observed: 0,
          required: ">= 1",
          detail: "below floor",
        },
      ],
    });
    expect(result).toMatchObject({
      decision: "hold",
      reasons: [
        {
          code: "coverage-floor-failed",
          floorIds: [
            "active-result-count",
            "minimum-rateable-assets",
          ],
        },
      ],
    });
  });


  it("counts direct quarantines without relying on a previous scoring identity", () => {
    const cards = Array.from({ length: 10 }, (_, index) =>
      index === 0
        ? producerFailedCard({
            id: `asset-${index}`,
            score: null,
            grade: "NR",
          })
        : makeWorkerV9Card({
            id: `asset-${index}`,
            score: 80,
            grade: "A-",
          }),
    );
    const accepted = candidate(
      cards.map((card) =>
        makeWorkerV9Card({
          id: card.id,
          score: 80,
          grade: "A-",
        }),
      ),
    );
    accepted.evaluationBuildDigest = digest("9");

    expect(
      assessV9Publication({
        inputHealth: currentInputHealth(),
        candidate: candidate(cards),
        acceptedPublication: null,
        coverageFloors: [],
        quarantinedAssetIds: ["asset-0"],
      }),
    ).toEqual({
      decision: "publish",
      reasons: [],
      affectedAssetIds: ["asset-0"],
    });

    expect(
      assessV9Publication({
        inputHealth: currentInputHealth(),
        candidate: candidate(
          cards.map((card, index) =>
            index === 1
              ? producerFailedCard({
                  id: card.id,
                  score: null,
                  grade: "NR",
                })
              : card,
          ),
        ),
        acceptedPublication: acceptedPublication(accepted),
        coverageFloors: [],
        quarantinedAssetIds: ["asset-0"],
        quarantineAffectedAssetIds: [
          "asset-0",
          "asset-1",
        ],
      }),
    ).toEqual({
      decision: "hold",
      reasons: ["asset-0", "asset-1"].map(assetId => ({
        code: "producer-failed-pipeline-gap", assetId, source: "reason",
        reasonCode: "missing-pillar-evidence", path: "asset-compilation", effect: "pipeline-gap",
      })),
      affectedAssetIds: ["asset-0", "asset-1"],
    });
  });

  it("counts downstream quarantine impact before capping the incident hold reasons", () => {
    const ids = Array.from({ length: 396 }, (_, index) => `asset-${String(index).padStart(3, "0")}`);
    const directIds = ids.slice(0, 39);
    const affectedIds = ids.slice(0, 59);
    const publication = candidate(ids.map((id, index) => index < 59
      ? producerFailedCard({ id, score: null, grade: null })
      : makeWorkerV9Card({ id, score: 80, grade: "A-" })));
    const input = {
      inputHealth: currentInputHealth(),
      candidate: publication,
      acceptedPublication: null,
      coverageFloors: [
        { id: "active-result-count", status: "pass" as const, observed: 396, required: "= 396", detail: "complete census" },
        { id: "minimum-rateable-assets", status: "pass" as const, observed: 337, required: ">= 271", detail: "rateability floor met" },
      ],
      quarantinedAssetIds: directIds,
    };

    // The direct failures alone fit within the 10% allowance.
    expect(assessV9Publication(input)).toEqual({
      decision: "publish",
      reasons: [],
      affectedAssetIds: directIds,
    });
    // Their dependent closure does not, even though both coverage floors pass.
    const assessment = assessV9Publication({
      ...input,
      quarantineAffectedAssetIds: affectedIds,
    });
    expect(assessment.decision).toBe("hold");
    expect(assessment.reasons).toEqual(affectedIds.slice(0, 24).map(assetId => ({
      code: "producer-failed-pipeline-gap", assetId, source: "reason",
      reasonCode: "missing-pillar-evidence", path: "asset-compilation", effect: "pipeline-gap",
    })));
    expect(assessment.affectedAssetIds).toEqual(affectedIds);
  });

  it("rejects a direct quarantine that names no candidate asset", () => {
    const input = {
      inputHealth: currentInputHealth(), candidate: candidate(),
      acceptedPublication: null, coverageFloors: [],
    };
    expect(assessV9Publication(input).decision).toBe("publish");
    expect(() => assessV9Publication({
      ...input, quarantinedAssetIds: ["missing-asset"],
    })).toThrow();
  });

  it.each([
    { ratingStatus: "rated", score: 80, grade: "A-" },
    { ratingStatus: "not-rated", score: null, grade: "NR" },
    { ratingStatus: "pipeline-gap", score: 0, grade: null },
    { ratingStatus: "pipeline-gap", score: null, grade: "NR" },
  ] satisfies Array<Partial<SafetyScoreV9CurrentResponse["cards"][number]>>)(
    "rejects a quarantine that is not a null-score/null-grade technical gap: %j", patch => {
      const card = producerFailedCard({ id: "alpha", score: null, grade: null });
      const input = {
        inputHealth: currentInputHealth(), candidate: candidate(card),
        acceptedPublication: null, coverageFloors: [], quarantinedAssetIds: ["alpha"],
      };
      expect(assessV9Publication(input).decision).toBe("hold");
      Object.assign(card, patch);
      expect(() => assessV9Publication(input)).toThrow();
    },
  );

  it.each([
    { affected: ["alpha", "missing-asset"] },
    { affected: [] },
  ])("rejects an incomplete or foreign quarantine-impact census: %j", ({ affected }) => {
    const cards = [
      producerFailedCard({ id: "alpha", score: null, grade: null }),
      ...Array.from({ length: 9 }, (_, index) => makeWorkerV9Card({ id: `healthy-${index}` })),
    ];
    const input = {
      inputHealth: currentInputHealth(), candidate: candidate(cards),
      acceptedPublication: null, coverageFloors: [], quarantinedAssetIds: ["alpha"],
    };
    expect(assessV9Publication(input)).toEqual({
      decision: "publish", reasons: [], affectedAssetIds: ["alpha"],
    });
    expect(() => assessV9Publication({
      ...input, quarantineAffectedAssetIds: affected,
    })).toThrow();
  });

});

import { describe, expect, it } from "vitest";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import {
  assessV9Publication,
  buildSafetyScoreV9AcceptedPublicationBaseline,
  expiredMeasuredExitAssetIds,
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
  return {
    model: "v9-critical-path",
    schemaVersion: 5,
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
      ratedCount: cardList.length - notRatedIds.length,
      notRatedCount: notRatedIds.length,
      notRatedIds,
    },
    cards: cardList,
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
    liveReserves: { state: "available" },
  };
}

function producerFailedCard(args: {
  id?: string;
  score: number | null;
  grade: SafetyScoreV9CurrentResponse["cards"][number]["grade"];
}) {
  const base = makeWorkerV9Card({
    id: args.id ?? "alpha",
    score: args.score,
    grade: args.grade,
  });
  return {
    ...base,
    scoreTrace: {
      ...base.scoreTrace,
      boundedUncertaintyAttribution: {
        semantics: "causal-bounded-uncertainty-v1" as const,
        items: [
          {
            source: "reason" as const,
            code: "missing-runtime-route-evidence" as const,
            path: "exit.runtime-route",
            message: "Runtime route producer failed.",
            responsibility: "producer-failed" as const,
          },
        ],
      },
    },
  };
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
      { liveReserves: { state: "unavailable" as const } },
    ],
  ] as Array<
    [
      string,
      {
        dex?: { state: "stale" | "unavailable" };
        redemption?: { state: "stale" | "unavailable" };
        liveReserves?: { state: "unavailable" };
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

  it("holds new producer-failed downgrades and NR transitions", () => {
    const downgrade = assessV9Publication({
      inputHealth: currentInputHealth(),
      candidate: candidate(
        producerFailedCard({ score: 70, grade: "B" }),
      ),
      acceptedPublication: acceptedPublication(),
      coverageFloors: [],
    });
    expect(downgrade).toMatchObject({
      decision: "hold",
      reasons: [{ code: "producer-failed-downgrade", assetId: "alpha" }],
    });

    const nr = assessV9Publication({
      inputHealth: currentInputHealth(),
      candidate: candidate(
        producerFailedCard({ score: null, grade: "NR" }),
      ),
      acceptedPublication: acceptedPublication(),
      coverageFloors: [],
    });
    expect(nr).toMatchObject({
      decision: "hold",
      reasons: [{ code: "producer-failed-nr", assetId: "alpha" }],
    });

    const newlyBindingNr = assessV9Publication({
      inputHealth: currentInputHealth(),
      candidate: candidate(
        producerFailedCard({ score: null, grade: "NR" }),
      ),
      acceptedPublication: acceptedPublication(
        candidate(producerFailedCard({ score: 70, grade: "B" })),
      ),
      coverageFloors: [],
    });
    expect(newlyBindingNr).toMatchObject({
      decision: "hold",
      reasons: [{ code: "producer-failed-nr", assetId: "alpha" }],
    });
  });

  it("publishes while at least 90% of assets remain free of new producer failures", () => {
    const acceptedCards = Array.from({ length: 10 }, (_, index) =>
      makeWorkerV9Card({
        id: `asset-${index}`,
        score: 80,
        grade: "A-",
      }),
    );
    const accepted = candidate(acceptedCards);
    const assessmentInput = {
      inputHealth: currentInputHealth(),
      acceptedPublication: acceptedPublication(accepted),
      coverageFloors: [],
    };

    expect(
      assessV9Publication({
        ...assessmentInput,
        candidate: candidate(
          acceptedCards.map((card, index) =>
            index === 0
              ? producerFailedCard({
                  id: card.id,
                  score: 70,
                  grade: "B",
                })
              : card,
          ),
        ),
      }),
    ).toEqual({
      decision: "publish",
      reasons: [],
      affectedAssetIds: ["asset-0"],
    });

    expect(
      assessV9Publication({
        ...assessmentInput,
        candidate: candidate(
          acceptedCards.map((card, index) =>
            index < 2
              ? producerFailedCard({
                  id: card.id,
                  score: 70,
                  grade: "B",
                })
              : card,
          ),
        ),
      }),
    ).toMatchObject({ decision: "hold" });
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
    ).toMatchObject({
      decision: "hold",
      affectedAssetIds: ["asset-0", "asset-1"],
    });
  });

  it("does not compare producer-failed deterioration across a scoring identity transition", () => {
    const priorIdentity = acceptedPublication();
    priorIdentity.evaluationBuildDigest = digest("9");

    expect(
      assessV9Publication({
        inputHealth: currentInputHealth(),
        candidate: candidate(
          producerFailedCard({ score: 70, grade: "B" }),
        ),
        acceptedPublication: priorIdentity,
        coverageFloors: [],
      }),
    ).toEqual({
      decision: "publish",
      reasons: [],
      affectedAssetIds: [],
    });
  });

  it("publishes chronic producer failure without a new effect and healthy measured adversity", () => {
    const chronicAccepted = candidate(
      producerFailedCard({ score: 70, grade: "B" }),
    );
    const chronicCandidate = candidate(
      producerFailedCard({ score: 70, grade: "B" }),
    );
    expect(
      assessV9Publication({
        inputHealth: currentInputHealth(),
        candidate: chronicCandidate,
        acceptedPublication: acceptedPublication(chronicAccepted),
        coverageFloors: [],
      }),
    ).toEqual({
      decision: "publish",
      reasons: [],
      affectedAssetIds: [],
    });

    expect(
      assessV9Publication({
        inputHealth: currentInputHealth(),
        candidate: candidate(
          makeWorkerV9Card({
            id: "alpha",
            score: 70,
            grade: "B",
          }),
        ),
        acceptedPublication: acceptedPublication(),
        coverageFloors: [],
      }),
    ).toEqual({
      decision: "publish",
      reasons: [],
      affectedAssetIds: [],
    });
  });
});

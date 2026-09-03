import { describe, expect, it } from "vitest";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import {
  assessV9Publication,
  buildSafetyScoreV9AcceptedPublicationBaseline,
  type V9PublicationInputHealth,
} from "../safety-score-v9/publication-assessment";

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

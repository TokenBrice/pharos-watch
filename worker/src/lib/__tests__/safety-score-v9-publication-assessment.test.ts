import { describe, expect, it } from "vitest";
import type { SafetyScoreV9Response } from "@shared/types/safety-score-v9-public";
import { makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import {
  assessV9Publication,
  type V9PublicationInputHealth,
} from "../safety-score-v9-publication-assessment";
import { buildSafetyScoreV9ShadowEnvelope } from "../safety-score-v9-shadow";

const digest = (character: string) => character.repeat(64);

function candidate(
  card = makeWorkerV9Card({ id: "alpha", score: 80, grade: "A-" }),
): SafetyScoreV9Response {
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
      expectedCount: 1,
      ratedCount: card.grade === "NR" ? 0 : 1,
      notRatedCount: card.grade === "NR" ? 1 : 0,
      notRatedIds: card.grade === "NR" ? [card.id] : [],
    },
    cards: [card],
  };
}

function acceptedEnvelope(value = candidate()) {
  return buildSafetyScoreV9ShadowEnvelope({
    candidate: value,
    expectedActiveIds: ["alpha"],
    compilerFactSchemaDigest: digest("f"),
    producerCapabilityDigest: digest("1"),
    coverageFloors: [],
  });
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
  score: number | null;
  grade: SafetyScoreV9Response["cards"][number]["grade"];
}) {
  const base = makeWorkerV9Card({
    id: "alpha",
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
        acceptedEnvelope: acceptedEnvelope(),
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
        acceptedEnvelope: acceptedEnvelope(),
        coverageFloors: [],
      }),
    ).toEqual({ decision: "publish", reasons: [] });
  });

  it("holds the existing active-result and rateability coverage floors", () => {
    const result = assessV9Publication({
      inputHealth: currentInputHealth(),
      candidate: candidate(),
      acceptedEnvelope: acceptedEnvelope(),
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
      acceptedEnvelope: acceptedEnvelope(),
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
      acceptedEnvelope: acceptedEnvelope(),
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
      acceptedEnvelope: {
        ...acceptedEnvelope(),
        candidate: candidate(
          producerFailedCard({ score: 70, grade: "B" }),
        ) as ReturnType<typeof acceptedEnvelope>["candidate"],
      },
      coverageFloors: [],
    });
    expect(newlyBindingNr).toMatchObject({
      decision: "hold",
      reasons: [{ code: "producer-failed-nr", assetId: "alpha" }],
    });
  });

  it("does not compare producer-failed deterioration across a scoring identity transition", () => {
    const priorIdentity = acceptedEnvelope();
    priorIdentity.candidate.evaluationBuildDigest = digest("9");

    expect(
      assessV9Publication({
        inputHealth: currentInputHealth(),
        candidate: candidate(
          producerFailedCard({ score: 70, grade: "B" }),
        ),
        acceptedEnvelope: priorIdentity,
        coverageFloors: [],
      }),
    ).toEqual({ decision: "publish", reasons: [] });
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
        acceptedEnvelope: {
          ...acceptedEnvelope(),
          candidate:
            chronicAccepted as ReturnType<
              typeof acceptedEnvelope
            >["candidate"],
        },
        coverageFloors: [],
      }),
    ).toEqual({ decision: "publish", reasons: [] });

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
        acceptedEnvelope: acceptedEnvelope(),
        coverageFloors: [],
      }),
    ).toEqual({ decision: "publish", reasons: [] });
  });
});

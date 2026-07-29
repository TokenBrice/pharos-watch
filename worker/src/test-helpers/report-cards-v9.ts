import {
  makeReportCardsV9Card,
  makeReportCardsV9Response as makeSharedReportCardsV9Response,
  type ReportCardsV9CardFixturePreset,
  type ReportCardsV9ResponseFixturePreset,
} from "@shared/test-utils/report-cards-v9";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import type {
  SafetyScoreV9CurrentCard,
  SafetyScoreV9CurrentResponse,
} from "@shared/types/safety-score-v9-public";

const digest = (character: string) => character.repeat(64);

const V9_CARD_PRESET = {
  defaultScore: 80,
  defaultQualityScore: 82,
  qualityScoreFromOverridePillars: true,
  defaultPegMultiplier: 0.98,
  defaultPegAdjustedScore: "score",
  pillarComponents: ["reviewed"],
  pillarOffsets: {
    backing: { offset: -2, minimum: 0 },
    exit: { offset: 0 },
    control: { offset: 2, maximum: 100 },
  },
  defaultWeakestPillar: "minimum",
  breakdowns: {
    nullWhenAnyPillarIsNull: true,
    backingComponent: {
      key: "reserve:reviewed",
      label: "Reviewed reserves",
    },
    exit: {
      stressRequest: {
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        comparisonWindowSec: 86_400,
      },
      primaryRoute: {
        key: "redemption:reviewed",
        label: "Protocol redemption",
        routeFamily: "protocol-redemption",
      },
    },
    controlComponent: {
      key: "control:reviewed",
      label: "Reviewed control",
      kind: "mint",
      posture: "distributed",
    },
  },
  accessPostureSignals: [],
  overridesBeforeDerivedValues: false,
} satisfies ReportCardsV9CardFixturePreset;

const V9_RESPONSE_PRESET = {
  safetyScoreIdentity: {
    model: "v9",
    schemaVersion: 1,
    methodologyVersion: "9.0",
    policyId: "safety-score-v9",
    policyDigest: digest("a"),
    evaluationBuildDigest: digest("b"),
    baseInputGenerationId: `report-cards-input:v1:${digest("c")}`,
    publicationGenerationId: "report-cards:v9:1",
  },
  defaultUpdatedAt: 110,
  asOfSec: 100,
  source: {
    candidateId: "candidate-v9.0",
    factSetDigest: digest("d"),
    resultDigest: digest("e"),
    sourceGenerations: { registry: "registry-1" },
  },
} satisfies ReportCardsV9ResponseFixturePreset;

export function makeWorkerV9Card(
  overrides: Partial<SafetyScoreV9CurrentCard> = {},
): SafetyScoreV9CurrentCard {
  return makeReportCardsV9Card(V9_CARD_PRESET, overrides);
}

export function makeWorkerReportCardsV9Response(
  overrides: Partial<ReportCardsV9Response> = {},
): ReportCardsV9Response {
  return makeSharedReportCardsV9Response(V9_RESPONSE_PRESET, makeWorkerV9Card, overrides);
}

export const makeReportCardsV9Response = makeWorkerReportCardsV9Response;

export function makeWorkerSafetyScoreV9Publication(
  overrides: Partial<SafetyScoreV9CurrentResponse> = {},
): SafetyScoreV9CurrentResponse {
  const projected = makeWorkerReportCardsV9Response(
    overrides.cards === undefined ? {} : { cards: overrides.cards },
  );
  return {
    model: "v9-critical-path",
    schemaVersion: 5,
    lifecycle: "active",
    candidateId: projected.source.candidateId,
    policyVersion: projected.methodology.version,
    publicationGenerationId:
      projected.safetyScoreIdentity.publicationGenerationId,
    baseInputGenerationId:
      projected.safetyScoreIdentity.baseInputGenerationId,
    factSetDigest: projected.source.factSetDigest,
    resultDigest: projected.source.resultDigest,
    policy: projected.methodology.policy,
    evaluationBuildDigest:
      projected.safetyScoreIdentity.evaluationBuildDigest,
    sourceGenerations: projected.source.sourceGenerations,
    asOfSec: projected.asOfSec,
    publishedAtSec: projected.updatedAt,
    completeness: projected.completeness,
    cards: projected.cards,
    ...overrides,
  };
}

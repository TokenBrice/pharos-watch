import {
  makeReportCardsV9Card,
  makeReportCardsV9Pillars,
  makeReportCardsV9NextResponse as makeSharedReportCardsV9NextResponse,
  makeReportCardsV9Response as makeSharedReportCardsV9Response,
  type ReportCardsV9NextResponseFixtureOverrides,
  type ReportCardsV9ResponseFixturePreset,
  type ReportCardsV9ResponseFixtureOverrides,
} from "@shared/test-utils/report-cards-v9";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import type { ReportCardsV9NextResponse } from "@shared/types/report-cards-v9-next";
import type {
  SafetyScoreV9CurrentCard,
  SafetyScoreV9CurrentResponse,
  SafetyScoreV9ResolvedCurrentCard,
} from "@shared/types/safety-score-v9-public";

const digest = (character: string) => character.repeat(64);

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
): SafetyScoreV9ResolvedCurrentCard {
  return makeReportCardsV9Card(overrides);
}

export function makeWorkerReportCardsV9Response(
  overrides: ReportCardsV9ResponseFixtureOverrides = {},
): ReportCardsV9Response {
  return makeSharedReportCardsV9Response(V9_RESPONSE_PRESET, makeWorkerV9Card, overrides);
}

export function makeWorkerReportCardsV9NextResponse(
  overrides: ReportCardsV9NextResponseFixtureOverrides = {},
): ReportCardsV9NextResponse {
  return makeSharedReportCardsV9NextResponse(V9_RESPONSE_PRESET, makeWorkerV9Card, overrides);
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
    schemaVersion: 7,
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
    foreignCauseGaps: projected.foreignCauseGaps,
    ...overrides,
  };
}

export const makeWorkerV9Pillars = makeReportCardsV9Pillars;

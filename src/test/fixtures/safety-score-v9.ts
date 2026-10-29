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
import type { SafetyScoreV9CurrentCard, SafetyScoreV9ResolvedCurrentCard } from "@shared/types/safety-score-v9-public";

const A64 = "a".repeat(64);
const B64 = "b".repeat(64);
const C64 = "c".repeat(64);
const D64 = "d".repeat(64);

const V9_RESPONSE_PRESET = {
  safetyScoreIdentity: {
    model: "v9",
    schemaVersion: 1,
    methodologyVersion: "9.0",
    policyId: "safety-score-v9",
    policyDigest: A64,
    evaluationBuildDigest: B64,
    baseInputGenerationId: `report-cards-input:v1:${C64}`,
    publicationGenerationId: "v9-publication-1",
  },
  defaultUpdatedAt: 1_752_534_060,
  asOfSec: 1_752_534_000,
  source: {
    candidateId: "safety-score-v9:v1:2026-07-15",
    factSetDigest: C64,
    resultDigest: D64,
    sourceGenerations: { reportCards: "source-1" },
  },
} satisfies ReportCardsV9ResponseFixturePreset;

export function makeV9Card(
  overrides: Partial<SafetyScoreV9CurrentCard> = {},
): SafetyScoreV9ResolvedCurrentCard {
  return makeReportCardsV9Card(overrides);
}

export function makeReportCardsV9Response(
  overrides: ReportCardsV9ResponseFixtureOverrides = {},
): ReportCardsV9Response {
  return makeSharedReportCardsV9Response(V9_RESPONSE_PRESET, makeV9Card, overrides);
}

export function makeReportCardsV9NextResponse(
  overrides: ReportCardsV9NextResponseFixtureOverrides = {},
): ReportCardsV9NextResponse {
  return makeSharedReportCardsV9NextResponse(V9_RESPONSE_PRESET, makeV9Card, overrides);
}

export const makeV9Pillars = makeReportCardsV9Pillars;

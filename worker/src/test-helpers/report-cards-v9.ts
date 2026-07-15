import { buildReportCardsV9DependencyGraph, type ReportCardsV9Response } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9Card } from "@shared/types/safety-score-v9-public";

const digest = (character: string) => character.repeat(64);

export function makeWorkerV9Card(overrides: Partial<SafetyScoreV9Card> = {}): SafetyScoreV9Card {
  const pillar = {
    score: 80,
    evidenceLevel: "adequate" as const,
    freshness: "current" as const,
    components: ["reviewed"],
    reasons: [],
  };
  return {
    id: "usdc-circle",
    score: 80,
    grade: "B-",
    qualityScore: 82,
    pegMultiplier: 0.98,
    pegAdjustedScore: 80,
    pillars: { backing: pillar, exit: pillar, control: pillar },
    weakestPillar: { pillar: "backing", score: 80 },
    caps: [],
    bindingCap: null,
    nrReasons: [],
    reasonCodes: [],
    evidence: { level: "adequate", freshness: "current", reasons: [] },
    accessPosture: {
      transfer: "restrictable",
      freezeExposure: "direct",
      primaryExit: "eligibility-gated",
      governance: "single-entity",
      unknownFields: [],
      signals: [],
      reasons: [],
    },
    dependencies: { serial: [], basket: [], cycleBlocked: false, reasonCodes: [] },
    stressStateDigest: null,
    ...overrides,
  };
}

export function makeWorkerReportCardsV9Response(
  overrides: Partial<ReportCardsV9Response> = {},
): ReportCardsV9Response {
  const cards = overrides.cards ?? [makeWorkerV9Card()];
  const identity = overrides.safetyScoreIdentity ?? {
    model: "v9" as const,
    schemaVersion: 1 as const,
    methodologyVersion: "candidate-v9.0",
    policyId: "safety-score-v9",
    policyDigest: digest("a"),
    evaluationBuildDigest: digest("b"),
    baseInputGenerationId: `report-cards-input:v1:${digest("c")}`,
    publicationGenerationId: "report-cards:v9:1",
  };
  return {
    model: "v9",
    schemaVersion: 1,
    lifecycle: "shadow",
    safetyScoreIdentity: identity,
    methodology: {
      version: identity.methodologyVersion,
      policy: { id: identity.policyId, semanticDigest: identity.policyDigest },
    },
    asOfSec: 100,
    updatedAt: 110,
    completeness: {
      expectedCount: cards.length,
      ratedCount: cards.filter((card) => card.grade !== "NR").length,
      notRatedCount: cards.filter((card) => card.grade === "NR").length,
      notRatedIds: cards.filter((card) => card.grade === "NR").map((card) => card.id).sort(),
    },
    source: {
      candidateId: "candidate-v9.0",
      factSetDigest: digest("d"),
      resultDigest: digest("e"),
      sourceGenerations: { registry: "registry-1" },
    },
    cards,
    dependencyGraph: buildReportCardsV9DependencyGraph(cards),
    ...overrides,
  };
}

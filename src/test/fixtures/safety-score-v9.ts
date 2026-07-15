import { buildReportCardsV9DependencyGraph, type ReportCardsV9Response } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9Card } from "@shared/types";

const A64 = "a".repeat(64);
const B64 = "b".repeat(64);
const C64 = "c".repeat(64);
const D64 = "d".repeat(64);

export function makeV9Card(overrides: Partial<SafetyScoreV9Card> = {}): SafetyScoreV9Card {
  const pillar = (score: number) => ({
    score,
    evidenceLevel: "adequate" as const,
    freshness: "current" as const,
    components: ["reviewed-component"],
    reasons: [],
  });
  return {
    id: "usdc-circle",
    score: 84,
    grade: "B+",
    qualityScore: 86,
    pegMultiplier: 0.98,
    pegAdjustedScore: 84,
    pillars: { backing: pillar(88), exit: pillar(82), control: pillar(84) },
    weakestPillar: { pillar: "exit", score: 82 },
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
      signals: ["issuer-controls"],
      reasons: [],
    },
    dependencies: { serial: [], basket: [], cycleBlocked: false, reasonCodes: [] },
    stressStateDigest: null,
    ...overrides,
  };
}

export function makeReportCardsV9Response(
  overrides: Partial<ReportCardsV9Response> = {},
): ReportCardsV9Response {
  const cards = overrides.cards ?? [makeV9Card()];
  const safetyScoreIdentity = overrides.safetyScoreIdentity ?? {
    model: "v9" as const,
    schemaVersion: 1 as const,
    methodologyVersion: "candidate-v9.0",
    policyId: "policy-v9",
    policyDigest: A64,
    evaluationBuildDigest: B64,
    baseInputGenerationId: `report-cards-input:v1:${C64}`,
    publicationGenerationId: "v9-publication-1",
  };
  return {
    model: "v9",
    schemaVersion: 1,
    lifecycle: "shadow",
    safetyScoreIdentity,
    methodology: {
      version: safetyScoreIdentity.methodologyVersion,
      policy: { id: safetyScoreIdentity.policyId, semanticDigest: safetyScoreIdentity.policyDigest },
    },
    asOfSec: 1_752_534_000,
    updatedAt: 1_752_534_060,
    completeness: {
      expectedCount: cards.length,
      ratedCount: cards.filter((card) => card.grade !== "NR").length,
      notRatedCount: cards.filter((card) => card.grade === "NR").length,
      notRatedIds: cards.filter((card) => card.grade === "NR").map((card) => card.id).sort(),
    },
    source: {
      candidateId: "candidate-v9.0-2026-07-15",
      factSetDigest: C64,
      resultDigest: D64,
      sourceGenerations: { reportCards: "source-1" },
    },
    cards,
    dependencyGraph: buildReportCardsV9DependencyGraph(cards),
    ...overrides,
  };
}

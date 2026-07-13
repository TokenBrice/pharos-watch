import { describe, expect, it } from "vitest";
import {
  buildSafetyScoreV9ShadowAttempt,
  buildSafetyScoreV9ShadowDay,
  type SafetyScoreV9ShadowEnvelope,
} from "../safety-score-v9-shadow";
import {
  SAFETY_SCORE_V9_RELEASE_WINDOW_DAYS,
  evaluateSafetyScoreV9ReleaseWindow,
  type SafetyScoreV9DailyCoverageSeries,
} from "../safety-score-v9-release-window";
import { buildPassingReleaseFixture } from "./safety-score-v9-release-fixtures";

const digest = (character: string) => character.repeat(64);
const fixture = buildPassingReleaseFixture();
const identity = fixture.identity;

function envelope(
  dayIndex: number,
  releaseFixture: ReturnType<typeof buildPassingReleaseFixture> = fixture,
): SafetyScoreV9ShadowEnvelope {
  const releaseIdentity = releaseFixture.identity;
  const coverageSeries = releaseFixture.evidence.releaseCoverageReport as SafetyScoreV9DailyCoverageSeries;
  const coverageIdentity = coverageSeries.entries[dayIndex]!.report.identities;
  const day = String(dayIndex + 1).padStart(2, "0");
  return {
    schemaVersion: 1,
    candidate: {
      model: "v9-critical-path",
      schemaVersion: 1,
      lifecycle: "candidate",
      candidateId: releaseIdentity.candidateId,
      policyVersion: releaseIdentity.policyVersion,
      publicationGenerationId: `v9:${dayIndex}`,
      publicationEpoch: releaseIdentity.publicationEpoch,
      baseInputGenerationId: coverageIdentity.baseInputGenerationId,
      factSetDigest: coverageIdentity.factSetDigest,
      resultDigest: coverageIdentity.scoreResultDigest,
      policy: { id: releaseIdentity.policyId, semanticDigest: releaseIdentity.policyDigest },
      evaluationBuildDigest: releaseIdentity.evaluationBuildDigest,
      sourceGenerations: { registry: "registry-1" },
      asOfSec: Date.parse(`2026-06-${day}T00:00:00Z`) / 1_000,
      publishedAtSec: Date.parse(`2026-06-${day}T00:01:00Z`) / 1_000,
      completeness: { expectedCount: 1, ratedCount: 0, notRatedCount: 1, notRatedIds: ["coin"] },
      cards: [
        {
          id: "coin",
          score: null,
          grade: "NR",
          qualityScore: null,
          pegMultiplier: null,
          pegAdjustedScore: null,
          pillars: {
            backing: { score: null, evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
            exit: { score: null, evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
            control: { score: null, evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
          },
          weakestPillar: null,
          caps: [],
          bindingCap: null,
          nrReasons: [{ code: "missing-pillar-evidence", message: "Missing evidence.", field: null, origin: "asset" }],
          reasonCodes: ["missing-pillar-evidence"],
          evidence: { level: "insufficient", freshness: "unknown", reasons: [] },
          accessPosture: {
            transfer: "unknown",
            freezeExposure: "unknown",
            primaryExit: "unknown",
            governance: "unknown",
            unknownFields: ["freezeExposure", "governance", "primaryExit", "transfer"],
            signals: [],
            reasons: [],
          },
          dependencies: { serial: [], basket: [], cycleBlocked: false, reasonCodes: [] },
          stressStateDigest: null,
        },
      ],
    },
    compilerFactSchemaDigest: releaseIdentity.compilerFactSchemaDigest,
    producerCapabilityDigest: releaseIdentity.producerCapabilityDigest,
    coverage: {
      expectedActiveCount: 1,
      observedResultCount: 1,
      presentExpectedCount: 1,
      ratedResultCount: 0,
      notRatedResultCount: 1,
      expectedActiveIdsDigest: digest("2"),
      presentExpectedIdsDigest: digest("2"),
      missingIds: [],
      unexpectedIds: [],
      duplicateIds: [],
      compilerExceptions: [],
      futureDatedEvidenceIds: [],
      coverageFloors: [],
      publicationRegression: false,
      unresolvedReleaseBlockers: [],
      unresolvedCriticalMovementIds: [],
    },
    replayArtifacts: [
      ["base-input", coverageIdentity.baseInputGenerationId, "3"],
      ["evaluation-build", releaseIdentity.evaluationBuildDigest, "4"],
      ["fact-set", coverageIdentity.factSetDigest, "5"],
      ["policy", releaseIdentity.policyDigest, "6"],
      ["result", coverageIdentity.scoreResultDigest, "7"],
    ].map(([kind, artifactIdentity, content]) => ({
      kind: kind as "base-input" | "evaluation-build" | "fact-set" | "policy" | "result",
      identity: artifactIdentity!,
      artifactRef: `d1:${content}`,
      contentSha256: digest(content!),
      byteLength: 1,
      compression: "gzip",
      verification: { status: "verified", observedContentSha256: digest(content!), verifiedAtSec: 1 },
    })),
  };
}

function qualifyingDays(releaseFixture: ReturnType<typeof buildPassingReleaseFixture> = fixture) {
  return Array.from({ length: SAFETY_SCORE_V9_RELEASE_WINDOW_DAYS }, (_, index) => {
    const day = String(index + 1).padStart(2, "0");
    const scheduledForSec = Date.parse(`2026-06-${day}T00:00:00Z`) / 1_000;
    const attempt = buildSafetyScoreV9ShadowAttempt({
      attemptId: `scheduled:${day}`,
      trigger: "scheduled",
      retryOfAttemptId: null,
      scheduledForSec,
      recordedAtSec: scheduledForSec + 61,
      outcome: "succeeded",
      startedAtSec: scheduledForSec,
      completedAtSec: scheduledForSec + 60,
      envelope: envelope(index, releaseFixture),
    });
    return buildSafetyScoreV9ShadowDay({
      utcDay: `2026-06-${day}`,
      expectedScheduledAttemptIds: [attempt.attemptId],
      attempts: [attempt],
    });
  });
}

describe("Safety Score V9 release window", () => {
  it("passes exactly 30 consecutive qualifying days with frozen identities", () => {
    const report = evaluateSafetyScoreV9ReleaseWindow({
      identity,
      evidence: fixture.evidence,
      days: qualifyingDays(),
    });
    expect(report.decision).toBe("gate-passed");
    expect(report.blockers).toEqual([]);
    expect(report.days).toHaveLength(30);
  });

  it("allows daily input identities to advance while every day's coverage floors pass", () => {
    const changingFixture = buildPassingReleaseFixture({
      dailyCoverageIdentities: [
        {
          utcDay: "2026-06-18",
          baseInputGenerationId: `report-cards-input:v1:${digest("8")}`,
          factSetDigest: digest("7"),
          evaluatedSetDigest: digest("6"),
          resultDigest: digest("5"),
          evaluationProjectionDigest: digest("4"),
          asOfSec: Date.parse("2026-06-18T00:00:00Z") / 1_000,
        },
      ],
    });

    const report = evaluateSafetyScoreV9ReleaseWindow({
      identity: changingFixture.identity,
      evidence: changingFixture.evidence,
      days: qualifyingDays(changingFixture),
    });

    expect(report.decision).toBe("gate-passed");
    expect(report.blockers).toEqual([]);
  });

  it("fails on a calendar gap, failed day, prerequisite, or capability drift", () => {
    const days = qualifyingDays();
    days.splice(4, 1);
    const driftAttempt = days[10]!.attempts[0]!;
    days[10] = buildSafetyScoreV9ShadowDay({
      utcDay: days[10]!.utcDay,
      expectedScheduledAttemptIds: [driftAttempt.attemptId],
      attempts: [
        {
          ...driftAttempt,
          identity: { ...driftAttempt.identity!, producerCapabilityDigest: digest("9") },
        },
      ],
    });
    const report = evaluateSafetyScoreV9ReleaseWindow({
      identity,
      evidence: { ...fixture.evidence, historicalValidationReport: null },
      days,
    });
    expect(report.decision).toBe("no-go");
    expect(report.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        "historical-validation-missing",
        "day-count-mismatch",
        "calendar-gap",
        "producer-capability-drift",
      ]),
    );
  });

  it("rejects a forged validation report digest even when its decision says pass", () => {
    const report = evaluateSafetyScoreV9ReleaseWindow({
      identity,
      evidence: {
        ...fixture.evidence,
        historicalValidationReport: {
          ...(fixture.evidence.historicalValidationReport as Record<string, unknown>),
          reportDigest: digest("9"),
        },
      },
      days: qualifyingDays(),
    });

    expect(report.decision).toBe("no-go");
    expect(report.blockers.map((blocker) => blocker.code)).toContain(
      "historical-validation-digest-mismatch",
    );
  });

  it("rejects a forged release-candidate seal digest", () => {
    const report = evaluateSafetyScoreV9ReleaseWindow({
      identity,
      evidence: {
        ...fixture.evidence,
        candidateSeal: {
          ...(fixture.evidence.candidateSeal as Record<string, unknown>),
          sealDigest: digest("8"),
        },
      },
      days: qualifyingDays(),
    });

    expect(report.decision).toBe("no-go");
    expect(report.blockers.map((blocker) => blocker.code)).toContain(
      "candidate-seal-digest-mismatch",
    );
  });

  it("binds the V9-9 coverage snapshot to every counted day", () => {
    const days = qualifyingDays();
    const target = days[17]!;
    const attempt = target.attempts[0]!;
    days[17] = buildSafetyScoreV9ShadowDay({
      utcDay: target.utcDay,
      expectedScheduledAttemptIds: [attempt.attemptId],
      attempts: [
        {
          ...attempt,
          identity: {
            ...attempt.identity!,
            baseInputGenerationId: `report-cards-input:v1:${digest("9")}`,
          },
        },
      ],
    });

    const report = evaluateSafetyScoreV9ReleaseWindow({
      identity,
      evidence: fixture.evidence,
      days,
    });

    expect(report.decision).toBe("no-go");
    expect(report.blockers).toContainEqual(
      expect.objectContaining({
        code: "release-snapshot-identity-mismatch",
        utcDay: target.utcDay,
      }),
    );
  });
});

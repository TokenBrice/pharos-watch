import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST,
} from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { computeV9CoverageEvaluationProjectionDigestFromEvaluatedSet } from "@shared/lib/safety-score-v9/coverage";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { SafetyScoreV9Response } from "@shared/types/safety-score-v9-public";
import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";
import {
  buildSafetyScoreV9Candidate,
  type SafetyScoreV9CandidatePipelineResult,
} from "../safety-score-v9-candidate";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9-extension";
import { verifySafetyScoreV9ReleaseAuthorization } from "../safety-score-v9-release-authorization";
import {
  computeSafetyScoreV9DailyCoverageSeriesDigest,
  type SafetyScoreV9DailyCoverageSeries,
} from "../safety-score-v9-release-window";
import {
  buildSafetyScoreV9DiffReport,
  buildSafetyScoreV9ShadowAttempt,
  buildSafetyScoreV9ShadowDay,
  buildSafetyScoreV9ShadowEnvelope,
  projectSafetyScoreV9ShadowEnvelopeCore,
  rebuildSafetyScoreV9ShadowEnvelope,
  type SafetyScoreV8ComparableSnapshot,
  type SafetyScoreV9ReplayArtifact,
  type SafetyScoreV9ReplayArtifactKind,
  type SafetyScoreV9ShadowDay,
} from "../safety-score-v9-shadow";
import {
  buildSafetyScoreV9ReplayArtifact,
  parseSafetyScoreV9ReplayArtifact,
  persistSafetyScoreV9ShadowState,
  type SafetyScoreV9StoredReplayArtifact,
} from "../safety-score-v9-store";
import { buildPassingReleaseFixture, fixtureDigest } from "./safety-score-v9-release-fixtures";

const MIGRATION_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/0200_safety_score_v9_shadow_history.sql",
);
const MIGRATION = readFileSync(MIGRATION_PATH, "utf8");
const END_DAY = "2026-06-30";
const CLOCK_SEC = 10_000;

function exactFixedInput(registryRevision = "registry:fixture", clockSec = CLOCK_SEC) {
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: ["alpha"],
    capturedAt: new Date(clockSec * 1_000).toISOString(),
    sourceGeneration: `report-cards:release-replay-fixture:${registryRevision}`,
    dexGenerationId: `dex-liquidity-${clockSec - 100}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec,
    updatedAt: clockSec,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: clockSec - 100, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap: {
      alpha: {
        liquidityScore: 90,
        concentrationHhi: 0.5,
        poolCount: 1,
        chainCount: 1,
        coverageClass: "primary",
        coverageConfidence: 1,
        liquidityEvidenceClass: "measured",
        hasMeasuredLiquidityEvidence: true,
        effectiveTvlUsd: 1_000_000,
        balanceMeasuredTvlUsd: 1_000_000,
        organicMeasuredTvlUsd: 1_000_000,
        methodologyVersion: "dex:fixture-v1",
        updatedAt: clockSec - 100,
      },
    },
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: { alpha: false },
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {
      alpha: {
        ethereum: {
          current: 10_000_000,
          circulatingPrevDay: 10_000_000,
          circulatingPrevWeek: 10_000_000,
          circulatingPrevMonth: 10_000_000,
        },
      },
    },
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

function createTestDatabase(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    ${MIGRATION}
  `);
  return { sqlite, db: createSqliteD1(sqlite) };
}

async function artifact(
  kind: SafetyScoreV9ReplayArtifactKind,
  identity: string,
  value: unknown,
): Promise<{ stored: SafetyScoreV9StoredReplayArtifact; reference: SafetyScoreV9ReplayArtifact }> {
  const stored = await buildSafetyScoreV9ReplayArtifact({
    kind,
    identity,
    value,
    createdAtSec: CLOCK_SEC + 1,
  });
  return { stored, reference: (await parseSafetyScoreV9ReplayArtifact(stored)).reference };
}

async function replayArtifacts(pipeline: SafetyScoreV9CandidatePipelineResult) {
  const first = await Promise.all([
    artifact("base-input", pipeline.candidate.baseInputGenerationId, pipeline.fixedInput),
    artifact("fact-set", pipeline.candidate.factSetDigest, {
      schemaVersion: 1,
      extension: pipeline.extension,
      compiledFacts: pipeline.compiledFacts,
    }),
    artifact("policy", pipeline.candidate.policy.semanticDigest, V9_CANDIDATE_POLICY_V1),
    artifact("evaluation-build", pipeline.candidate.evaluationBuildDigest, {
      manifest: SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST,
      compilerFactSchemaIdentity: pipeline.compilerFactSchemaIdentity,
      producerCapabilityIdentity: pipeline.producerCapabilityIdentity,
    }),
  ]);
  const envelopeWithoutResult = buildSafetyScoreV9ShadowEnvelope({
    candidate: pipeline.candidate,
    expectedActiveIds: ["alpha"],
    compilerFactSchemaDigest: pipeline.compilerFactSchemaDigest,
    producerCapabilityDigest: pipeline.producerCapabilityDigest,
    coverageFloors: [],
    replayArtifacts: first.map((entry) => entry.reference),
  });
  const envelopeCore = projectSafetyScoreV9ShadowEnvelopeCore(envelopeWithoutResult);
  const result = await artifact("result", pipeline.candidate.resultDigest, {
    schemaVersion: 2,
    evaluatedSet: pipeline.evaluatedSet,
    candidate: pipeline.candidate,
    envelopeCore,
  });
  return {
    artifacts: [...first.map((entry) => entry.stored), result.stored],
    envelope: rebuildSafetyScoreV9ShadowEnvelope({
      candidate: pipeline.candidate,
      core: envelopeCore,
      replayArtifacts: [...first.map((entry) => entry.reference), result.reference],
    }),
  };
}

function dayAt(index: number): { utcDay: string; scheduledForSec: number } {
  const scheduledForSec = Date.parse("2026-06-01T00:00:00.000Z") / 1_000 + index * 86_400;
  return { utcDay: new Date(scheduledForSec * 1_000).toISOString().slice(0, 10), scheduledForSec };
}

async function populatedFixture(options: { changedDayIndex?: number } = {}) {
  const fixedInput = exactFixedInput();
  const pipeline = buildSafetyScoreV9Candidate({
    fixedInput,
    extension: buildSafetyScoreV9BaselineExtension(fixedInput, {
      metaById: new Map([["alpha", { id: "alpha", mechanismArchetype: "fiat-cash" }]]),
    }),
    publishedAtSec: fixedInput.clockSec,
    publicationEpoch: 0,
    releaseCandidateId: "v9-rc-1",
  });
  const retained = await replayArtifacts(pipeline);
  const changedFixedInput = options.changedDayIndex === undefined
    ? null
    : exactFixedInput("registry:fixture-day-change", CLOCK_SEC + 1);
  const changedPipeline = changedFixedInput === null
    ? null
    : buildSafetyScoreV9Candidate({
        fixedInput: changedFixedInput,
        extension: buildSafetyScoreV9BaselineExtension(changedFixedInput, {
          metaById: new Map([["alpha", { id: "alpha", mechanismArchetype: "fiat-cash" }]]),
        }),
        publishedAtSec: changedFixedInput.clockSec,
        publicationEpoch: 0,
        releaseCandidateId: "v9-rc-1",
      });
  const changedRetained = changedPipeline === null ? null : await replayArtifacts(changedPipeline);
  const changedUtcDay = options.changedDayIndex === undefined ? null : dayAt(options.changedDayIndex).utcDay;
  const release = buildPassingReleaseFixture({
    policyId: pipeline.candidate.policy.id,
    policyVersion: pipeline.candidate.policyVersion,
    policyDigest: pipeline.candidate.policy.semanticDigest,
    compilerFactSchemaDigest: pipeline.compilerFactSchemaDigest,
    producerCapabilityDigest: pipeline.producerCapabilityDigest,
    publicationEpoch: pipeline.candidate.publicationEpoch,
    baseInputGenerationId: pipeline.candidate.baseInputGenerationId,
    factSetDigest: pipeline.candidate.factSetDigest,
    evaluatedSetDigest: pipeline.evaluatedSet.evaluatedSetDigest,
    resultDigest: pipeline.candidate.resultDigest,
    evaluationProjectionDigest: computeV9CoverageEvaluationProjectionDigestFromEvaluatedSet(
      pipeline.evaluatedSet,
      pipeline.producerCapabilityDigest,
    ),
    asOfSec: pipeline.compiledFacts.asOfSec,
    sourceFingerprints: pipeline.compiledFacts.sourceFingerprints,
    dailyCoverageIdentities:
      changedPipeline === null || changedUtcDay === null
        ? undefined
        : [
            {
              utcDay: changedUtcDay,
              baseInputGenerationId: changedPipeline.candidate.baseInputGenerationId,
              factSetDigest: changedPipeline.candidate.factSetDigest,
              evaluatedSetDigest: changedPipeline.evaluatedSet.evaluatedSetDigest,
              resultDigest: changedPipeline.candidate.resultDigest,
              evaluationProjectionDigest: computeV9CoverageEvaluationProjectionDigestFromEvaluatedSet(
                changedPipeline.evaluatedSet,
                changedPipeline.producerCapabilityDigest,
              ),
              asOfSec: changedPipeline.compiledFacts.asOfSec,
              sourceFingerprints: changedPipeline.compiledFacts.sourceFingerprints,
            },
          ],
  });
  const { sqlite, db } = createTestDatabase();
  const v8: SafetyScoreV8ComparableSnapshot = {
    model: "v8",
    publicationGenerationId: "v8:fixture",
    baseInputGenerationId: pipeline.candidate.baseInputGenerationId,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    evaluationBuildDigest: fixtureDigest("v8-build"),
    cards: [{ id: "alpha", score: null, grade: "NR", bindingCap: null, reasonCodes: [] }],
  };
  const days: SafetyScoreV9ShadowDay[] = [];
  for (let index = 0; index < 30; index += 1) {
    const selectedPipeline = index === options.changedDayIndex && changedPipeline !== null
      ? changedPipeline
      : pipeline;
    const selectedRetained = index === options.changedDayIndex && changedRetained !== null
      ? changedRetained
      : retained;
    const { utcDay, scheduledForSec } = dayAt(index);
    const attempt = buildSafetyScoreV9ShadowAttempt({
      attemptId: `release-window:${utcDay}`,
      trigger: "scheduled",
      retryOfAttemptId: null,
      scheduledForSec,
      startedAtSec: scheduledForSec + 1,
      completedAtSec: scheduledForSec + 2,
      recordedAtSec: scheduledForSec + 3,
      outcome: "succeeded",
      envelope: selectedRetained.envelope,
    });
    const day = buildSafetyScoreV9ShadowDay({
      utcDay,
      expectedScheduledAttemptIds: [attempt.attemptId],
      attempts: [attempt],
    });
    const diff = buildSafetyScoreV9DiffReport({
      generatedAtSec: scheduledForSec + 2,
      expectedActiveIds: ["alpha"],
      v8: { ...v8, baseInputGenerationId: selectedPipeline.candidate.baseInputGenerationId },
      v9: selectedRetained.envelope,
      topCutoffIds: new Set(["alpha"]),
      downstreamThresholds: [],
      supplyUsdById: { alpha: 10_000_000 },
    });
    await persistSafetyScoreV9ShadowState(db, {
      artifacts: selectedRetained.artifacts,
      attempt,
      day,
      envelope: selectedRetained.envelope,
      diff,
      updatedAtSec: scheduledForSec + 3,
    });
    days.push(day);
  }
  return { sqlite, db, pipeline, release, retained, days };
}

function verifyInput(fixture: Awaited<ReturnType<typeof populatedFixture>>) {
  return {
    db: fixture.db,
    identity: fixture.release.identity,
    evidence: fixture.release.evidence,
    windowEndUtcDay: END_DAY,
  };
}

describe("Safety Score V9 release authorization replay", () => {
  it("passes a fully cross-bound synthetic window after replaying all five artifacts per day", async () => {
    const fixture = await populatedFixture();
    const report = await verifySafetyScoreV9ReleaseAuthorization(verifyInput(fixture));

    expect(report.decision).toBe("gate-passed");
    expect(report.releaseWindowReport?.decision).toBe("gate-passed");
    expect(report.days).toHaveLength(30);
    expect(report.days.every((day) => day.verified && day.artifacts.length === 5)).toBe(true);
  });

  it("passes when day 18 advances to a new exact input generation with its own coverage report", async () => {
    const fixture = await populatedFixture({ changedDayIndex: 17 });

    const report = await verifySafetyScoreV9ReleaseAuthorization(verifyInput(fixture));

    expect(report.decision).toBe("gate-passed");
    expect(report.days[17]).toMatchObject({ verified: true, utcDay: "2026-06-18" });
    expect(report.days[17]!.baseInputGenerationId).not.toBe(report.days[16]!.baseInputGenerationId);
    expect(report.days[17]!.resultDigest).not.toBe(report.days[16]!.resultDigest);
  });

  it("fails closed on a forged external report digest before reading a release window", async () => {
    const fixture = await populatedFixture();
    const forged = structuredClone(
      fixture.release.evidence.releaseCoverageReport as SafetyScoreV9DailyCoverageSeries,
    );
    forged.entries[0]!.report.reportDigest = "9".repeat(64);
    const { seriesDigest: _seriesDigest, ...forgedPayload } = forged;
    forged.seriesDigest = computeSafetyScoreV9DailyCoverageSeriesDigest(forgedPayload);
    const report = await verifySafetyScoreV9ReleaseAuthorization({
      ...verifyInput(fixture),
      evidence: {
        ...fixture.release.evidence,
        releaseCoverageReport: forged,
      },
    });

    expect(report.decision).toBe("no-go");
    expect(report.releaseWindowReport).toBeNull();
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "release-evidence-no-go",
          detail: expect.stringContaining("release-coverage-digest-mismatch"),
        }),
      ]),
    );
  });

  it("reports missing and corrupt retained artifacts with their exact kind", async () => {
    const missing = await populatedFixture();
    missing.sqlite.prepare("DELETE FROM safety_score_v9_artifacts WHERE artifact_kind = 'policy'").run();
    const missingReport = await verifySafetyScoreV9ReleaseAuthorization(verifyInput(missing));
    expect(missingReport.decision).toBe("no-go");
    expect(missingReport.blockers).toContainEqual(
      expect.objectContaining({ code: "artifact-missing", artifactKind: "policy" }),
    );

    const corrupt = await populatedFixture();
    corrupt.sqlite
      .prepare(
        "UPDATE safety_score_v9_artifacts SET payload = '!' || substr(payload, 2) WHERE artifact_kind = 'base-input'",
      )
      .run();
    const corruptReport = await verifySafetyScoreV9ReleaseAuthorization(verifyInput(corrupt));
    expect(corruptReport.decision).toBe("no-go");
    expect(corruptReport.blockers).toContainEqual(
      expect.objectContaining({ code: "artifact-unreadable", artifactKind: "base-input" }),
    );
  });

  it("detects a stable candidate identity drift in one canonical day", async () => {
    const fixture = await populatedFixture();
    const driftedDay = structuredClone(fixture.days[10]!);
    const driftedAttempt = driftedDay.attempts[0]!;
    driftedAttempt.identity = {
      ...driftedAttempt.identity!,
      producerCapabilityDigest: fixtureDigest("drifted-producer"),
    };
    const rebuiltDay = buildSafetyScoreV9ShadowDay({
      utcDay: driftedDay.utcDay,
      expectedScheduledAttemptIds: driftedDay.projection.expectedScheduledAttemptIds,
      attempts: [driftedAttempt],
    });
    fixture.sqlite
      .prepare(
        `UPDATE safety_score_v9_shadow_attempts
         SET producer_capability_digest = ?, attempt_json = ?
         WHERE attempt_id = ?`,
      )
      .run(
        driftedAttempt.identity.producerCapabilityDigest,
        stableJsonStringifyV1(driftedAttempt),
        driftedAttempt.attemptId,
      );
    fixture.sqlite
      .prepare(
        `UPDATE safety_score_v9_shadow_days
         SET producer_capability_digest = ?, day_json = ?
         WHERE utc_day = ?`,
      )
      .run(
        driftedAttempt.identity.producerCapabilityDigest,
        stableJsonStringifyV1(rebuiltDay),
        rebuiltDay.utcDay,
      );

    const report = await verifySafetyScoreV9ReleaseAuthorization(verifyInput(fixture));
    expect(report.decision).toBe("no-go");
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: "attempt-identity-mismatch", utcDay: rebuiltDay.utcDay }),
    );
  });

  it("rejects an exact coverage identity drift on any counted day", async () => {
    const fixture = await populatedFixture();
    const driftedDay = structuredClone(fixture.days[17]!);
    const driftedAttempt = driftedDay.attempts[0]!;
    driftedAttempt.identity = {
      ...driftedAttempt.identity!,
      baseInputGenerationId: `report-cards-input:v1:${fixtureDigest("different-daily-base")}`,
    };
    const rebuiltDay = buildSafetyScoreV9ShadowDay({
      utcDay: driftedDay.utcDay,
      expectedScheduledAttemptIds: driftedDay.projection.expectedScheduledAttemptIds,
      attempts: [driftedAttempt],
    });
    fixture.sqlite
      .prepare(
        `UPDATE safety_score_v9_shadow_attempts
         SET base_input_generation_id = ?, attempt_json = ?
         WHERE attempt_id = ?`,
      )
      .run(
        driftedAttempt.identity.baseInputGenerationId,
        stableJsonStringifyV1(driftedAttempt),
        driftedAttempt.attemptId,
      );
    fixture.sqlite
      .prepare("UPDATE safety_score_v9_shadow_days SET day_json = ? WHERE utc_day = ?")
      .run(stableJsonStringifyV1(rebuiltDay), rebuiltDay.utcDay);

    const report = await verifySafetyScoreV9ReleaseAuthorization(verifyInput(fixture));

    expect(report.decision).toBe("no-go");
    expect(report.blockers).toContainEqual(
      expect.objectContaining({
        code: "daily-coverage-replay-mismatch",
        utcDay: rebuiltDay.utcDay,
      }),
    );
  });

  it("rejects a checksum-valid result artifact that no longer matches deterministic replay", async () => {
    const fixture = await populatedFixture();
    const original = fixture.retained.artifacts.find((entry) => entry.kind === "result")!;
    const parsed = await parseSafetyScoreV9ReplayArtifact<{
      schemaVersion: 2;
      evaluatedSet: Record<string, unknown>;
      candidate: SafetyScoreV9Response;
      envelopeCore: unknown;
    }>(original);
    const replacement = await buildSafetyScoreV9ReplayArtifact({
      kind: "result",
      identity: original.identity,
      value: {
        ...parsed.value,
        evaluatedSet: {
          ...parsed.value.evaluatedSet,
          evaluatedSetDigest: fixtureDigest("forged-evaluated-set"),
        },
      },
      createdAtSec: original.createdAtSec,
    });
    fixture.sqlite
      .prepare(
        `UPDATE safety_score_v9_artifacts
         SET artifact_key = ?, content_sha256 = ?, encoding = ?, uncompressed_bytes = ?,
             stored_bytes = ?, payload = ?, created_at_sec = ?, verified_at_sec = ?
         WHERE artifact_kind = 'result'`,
      )
      .run(
        replacement.artifactKey,
        replacement.contentSha256,
        replacement.encoding,
        replacement.uncompressedBytes,
        replacement.storedBytes,
        replacement.payload,
        replacement.createdAtSec,
        replacement.verifiedAtSec,
      );

    const report = await verifySafetyScoreV9ReleaseAuthorization(verifyInput(fixture));
    expect(report.decision).toBe("no-go");
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "evaluated-set-replay-mismatch", artifactKind: "result" }),
        expect.objectContaining({ code: "envelope-replay-mismatch" }),
      ]),
    );
  });
});

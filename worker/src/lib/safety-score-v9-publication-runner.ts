import { V9_MINIMUM_RATEABLE_ASSETS } from "@shared/types/safety-score-v9-coverage";
import type {
  V9PublicationHealth,
  V9PublicationHoldReason,
} from "@shared/types/report-cards-v9";
import {
  normalizeSafetyScoreV9CompilerInput,
  type SafetyScoreV9CompilerInput,
} from "./safety-score-v9-native-input";
import {
  buildSafetyScoreV9PublicationFromNormalizedInput,
} from "./safety-score-v9-candidate";
import {
  assessV9Publication,
  type V9PublicationCoverageFloor,
} from "./safety-score-v9-publication-assessment";
import {
  loadSafetyScoreV9Publication,
  loadSafetyScoreV9PublicationHealth,
  persistSafetyScoreV9Publication,
  persistSafetyScoreV9PublicationAttempt,
  type V9PublicationAttempt,
} from "./safety-score-v9-publication-store";
import type { V9AssetQuarantine } from "./safety-score-v9-fact-set";
import { logWorkerEvent } from "./structured-log";
import type { SafetyScoreV9TransferMaterialityGeneration } from "./safety-score-v9-transfer-materiality";

export const SAFETY_SCORE_V9_PUBLICATION_TIMEOUT_MS = 2 * 60_000;
export const SAFETY_SCORE_V9_PUBLICATION_ATTEMPT_PREFIX =
  "safety-score-v9-publication";

type SafetyScoreV9PublicationFailureStage =
  | "base-input"
  | "v9-enrichment"
  | "compile"
  | "publication-gate"
  | "publication-write"
  | "aborted";

export interface RunSafetyScoreV9PublicationInput {
  db: D1Database;
  fixedInput: unknown;
  prepareFixedInput?: (
    fixedInput: Readonly<SafetyScoreV9CompilerInput>,
    signal: AbortSignal,
  ) => Promise<unknown>;
  signal?: AbortSignal;
  nowSec?: number;
  transferMaterialityGeneration?: SafetyScoreV9TransferMaterialityGeneration | null;
}

export type SafetyScoreV9PublicationRunResult =
  | {
      status: "published";
      attemptId: string;
      publicationGenerationId: string;
      candidateId: string;
      outcome: "clean" | "partial";
      quarantines: readonly V9AssetQuarantine[];
      affectedAssetIds: readonly string[];
    }
  | {
      status: "held";
      attemptId: string;
      attemptedPublicationGenerationId: string;
      reasons: V9PublicationHoldReason[];
      quarantines: readonly V9AssetQuarantine[];
      affectedAssetIds: readonly string[];
    }
  | {
      status: "failed";
      attemptId: string;
      stage: SafetyScoreV9PublicationFailureStage;
      code: string;
      message: string;
    };

function fixedInputWithoutV9Enrichment(
  input: Readonly<SafetyScoreV9CompilerInput>,
) {
  const {
    safetyScoreV9SupplyAttributionById: _v9SupplyAttribution,
    evidenceJournalById: _evidenceJournal,
    supplyAttributionJournalById: _supplyAttributionJournal,
    pegProvenanceById: _pegProvenance,
    ...baseInput
  } = input;
  return baseInput;
}

function sameBaseInput(
  left: Readonly<SafetyScoreV9CompilerInput>,
  right: Readonly<SafetyScoreV9CompilerInput>,
): boolean {
  return (
    left.baseInputGenerationId === right.baseInputGenerationId &&
    left.sourceGeneration === right.sourceGeneration &&
    JSON.stringify(fixedInputWithoutV9Enrichment(left)) ===
      JSON.stringify(fixedInputWithoutV9Enrichment(right))
  );
}

function fallbackNowSec(): number {
  return Math.max(0, Math.floor(Date.now() / 1_000));
}

function nowSecAtLeast(minimum: number, override?: number): number {
  const value = override ?? fallbackNowSec();
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      "Safety Score v9 publication clock must be epoch seconds",
    );
  }
  return Math.max(minimum, value);
}

function observationCoverageFloors(
  observedCount: number,
  expectedCount: number,
  rateableCount: number,
): V9PublicationCoverageFloor[] {
  const exactCount = observedCount === expectedCount;
  return [
    {
      id: "active-result-count",
      status: exactCount ? "pass" : "fail",
      observed: observedCount,
      required: `= ${expectedCount}`,
      detail: exactCount
        ? "The V9 publication contains one result for every active asset"
        : "The V9 publication result count does not match the active registry",
    },
    {
      id: "minimum-rateable-assets",
      status:
        rateableCount >= V9_MINIMUM_RATEABLE_ASSETS
          ? "pass"
          : "fail",
      observed: rateableCount,
      required: `>= ${V9_MINIMUM_RATEABLE_ASSETS}`,
      detail:
        rateableCount >= V9_MINIMUM_RATEABLE_ASSETS
          ? "The V9 publication meets the active-asset rateability floor"
          : "The V9 publication is below the active-asset rateability floor",
    },
  ];
}

function safeFailure(
  error: unknown,
  stage: SafetyScoreV9PublicationFailureStage,
): { code: string; message: string } {
  const name = error instanceof Error && error.name ? error.name : "Error";
  const rawMessage = error instanceof Error ? error.message : String(error);
  return {
    code: `safety-score-v9-publication-${stage}-${name}`.slice(0, 160),
    message: (
      rawMessage.trim() || "Safety Score v9 publication attempt failed"
    ).slice(0, 500),
  };
}

function combinedPublicationSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(
    SAFETY_SCORE_V9_PUBLICATION_TIMEOUT_MS,
  );
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function heldPublicationHealth(args: {
  attemptedAtSec: number;
  reasons: V9PublicationHoldReason[];
  acceptedPublication: Awaited<
    ReturnType<typeof loadSafetyScoreV9Publication>
  >;
  previousHealth: V9PublicationHealth | null;
}): V9PublicationHealth {
  return {
    schemaVersion: 1,
    status: "held",
    acceptedPublicationGenerationId:
      args.acceptedPublication?.publicationGenerationId ??
      args.previousHealth?.acceptedPublicationGenerationId ??
      null,
    acceptedAtSec:
      args.acceptedPublication?.publishedAtSec ??
      args.previousHealth?.acceptedAtSec ??
      null,
    attemptedAtSec: args.attemptedAtSec,
    heldSinceSec:
      args.previousHealth?.status === "held"
        ? args.previousHealth.heldSinceSec
        : args.attemptedAtSec,
    reasons: args.reasons,
  };
}

function publicationAttempt(args: {
  attemptedAtSec: number;
  outcome: V9PublicationAttempt["outcome"];
  publicationGenerationId: string | null;
  quarantines: readonly V9AssetQuarantine[];
  affectedAssetIds: readonly string[];
  failure?: V9PublicationAttempt["failure"];
}): V9PublicationAttempt {
  return {
    schemaVersion: 1,
    attemptedAtSec: args.attemptedAtSec,
    outcome: args.outcome,
    publicationGenerationId: args.publicationGenerationId,
    quarantines: [...args.quarantines],
    affectedAssetIds: [...args.affectedAssetIds],
    ...(args.failure ? { failure: args.failure } : {}),
  };
}

async function persistFailedPublicationAttempt(args: {
  db: D1Database;
  attemptedAtSec: number;
  failure: NonNullable<V9PublicationAttempt["failure"]>;
  signal: AbortSignal;
}): Promise<void> {
  if (args.signal.aborted) return;
  try {
    await persistSafetyScoreV9PublicationAttempt(args.db, {
      publicationAttempt: publicationAttempt({
        attemptedAtSec: args.attemptedAtSec,
        outcome: "failed",
        publicationGenerationId: null,
        quarantines: [],
        affectedAssetIds: [],
        failure: args.failure,
      }),
      publicationClockSec: args.attemptedAtSec,
      signal: args.signal,
    });
  } catch (error) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "safety_score_v9_failed_attempt_persist_failed",
      job: "compute-safety-score-v9",
      message: "Safety Score V9 failed attempt metadata could not be persisted",
      metadata: {
        attemptedAtSec: args.attemptedAtSec,
        stage: args.failure.stage,
        code: safeFailure(error, "publication-write").code,
        message: safeFailure(error, "publication-write").message,
      },
    });
  }
}

function logPublicationGenerationDeltas(
  candidate: Awaited<ReturnType<typeof loadSafetyScoreV9Publication>>,
  accepted: Awaited<ReturnType<typeof loadSafetyScoreV9Publication>>,
): void {
  if (candidate === null || accepted === null) return;
  const acceptedById = new Map(accepted.cards.map((card) => [card.id, card]));
  const primaryRouteChurn: Array<Record<string, unknown>> = [];
  const capacityChanges: Array<Record<string, unknown>> = [];
  const pillarChanges: Array<Record<string, unknown>> = [];
  for (const card of candidate.cards) {
    const prior = acceptedById.get(card.id);
    if (
      prior === undefined ||
      !("breakdowns" in card) ||
      !("breakdowns" in prior) ||
      card.breakdowns === null ||
      prior.breakdowns === null
    ) {
      continue;
    }
    const candidatePrimary = card.breakdowns.exit.primaryRoute?.key ?? null;
    const acceptedPrimary = prior.breakdowns.exit.primaryRoute?.key ?? null;
    const candidateCapacity =
      card.breakdowns.exit.primaryRoute?.capacity?.executableUsd ?? null;
    const acceptedCapacity =
      prior.breakdowns.exit.primaryRoute?.capacity?.executableUsd ?? null;
    if (
      candidatePrimary !== acceptedPrimary &&
      primaryRouteChurn.length < 20
    ) {
      primaryRouteChurn.push({
        assetId: card.id,
        acceptedPrimary,
        candidatePrimary,
        exitScoreDelta:
          card.breakdowns.exit.publishedScore -
          prior.breakdowns.exit.publishedScore,
      });
    }
    if (
      candidateCapacity !== acceptedCapacity &&
      capacityChanges.length < 20
    ) {
      capacityChanges.push({
        assetId: card.id,
        acceptedCapacityUsd: acceptedCapacity,
        candidateCapacityUsd: candidateCapacity,
        deltaUsd:
          candidateCapacity === null || acceptedCapacity === null
            ? null
            : candidateCapacity - acceptedCapacity,
      });
    }
    for (const pillar of ["backing", "exit", "control"] as const) {
      const delta =
        card.breakdowns[pillar].publishedScore -
        prior.breakdowns[pillar].publishedScore;
      if (Math.abs(delta) >= 1 && pillarChanges.length < 20) {
        pillarChanges.push({ assetId: card.id, pillar, delta });
      }
    }
  }
  if (
    primaryRouteChurn.length === 0 &&
    capacityChanges.length === 0 &&
    pillarChanges.length === 0
  ) return;
  logWorkerEvent({
    scope: "lib",
    level:
      primaryRouteChurn.some(
        (item) =>
          typeof item.exitScoreDelta === "number" &&
          Math.abs(item.exitScoreDelta) >= 10,
      ) ||
      capacityChanges.some((item) => {
        const acceptedCapacity = item.acceptedCapacityUsd;
        const candidateCapacity = item.candidateCapacityUsd;
        return (
          typeof acceptedCapacity === "number" &&
          acceptedCapacity >= 100_000 &&
          typeof candidateCapacity === "number" &&
          candidateCapacity <= acceptedCapacity * 0.5
        );
      })
        ? "warn"
        : "info",
    event: "safety_score_v9_generation_delta",
    job: "compute-safety-score-v9",
    message: "Safety Score V9 route or pillar state changed between accepted generations",
    metadata: {
      acceptedPublicationGenerationId: accepted.publicationGenerationId,
      candidatePublicationGenerationId: candidate.publicationGenerationId,
      primaryRouteChurn,
      capacityChanges,
      pillarChanges,
    },
  });
}

export async function runSafetyScoreV9Publication(
  input: RunSafetyScoreV9PublicationInput,
): Promise<SafetyScoreV9PublicationRunResult> {
  let stage: SafetyScoreV9PublicationFailureStage = "base-input";
  let attemptedAtSec = fallbackNowSec();
  let attemptId = `${SAFETY_SCORE_V9_PUBLICATION_ATTEMPT_PREFIX}:${attemptedAtSec}`;
  const publicationSignal = combinedPublicationSignal(input.signal);

  try {
    if (
      input.nowSec !== undefined &&
      (!Number.isInteger(input.nowSec) || input.nowSec < 0)
    ) {
      throw new Error(
        "Safety Score v9 publication clock must be epoch seconds",
      );
    }
    let fixedInput = normalizeSafetyScoreV9CompilerInput(input.fixedInput);
    attemptedAtSec = nowSecAtLeast(fixedInput.clockSec, input.nowSec);
    attemptId = `${SAFETY_SCORE_V9_PUBLICATION_ATTEMPT_PREFIX}:${attemptedAtSec}`;

    stage = "v9-enrichment";
    if (input.prepareFixedInput) {
      const preparedFixedInput = normalizeSafetyScoreV9CompilerInput(
        await input.prepareFixedInput(fixedInput, publicationSignal),
      );
      if (!sameBaseInput(preparedFixedInput, fixedInput)) {
        throw new Error(
          "Safety Score v9 preparation changed the authoritative fixed input",
        );
      }
      fixedInput = preparedFixedInput;
    }

    stage = "compile";
    const pipeline = buildSafetyScoreV9PublicationFromNormalizedInput({
      fixedInput,
      publishedAtSec: fixedInput.clockSec,
      transferMaterialityGeneration: input.transferMaterialityGeneration ?? null,
    });
    const publication = pipeline.candidate;
    const coverageFloors = observationCoverageFloors(
      publication.cards.length,
      fixedInput.activeAssetIds.length,
      publication.completeness.ratedCount,
    );

    stage = "publication-gate";
    let acceptedPublication: Awaited<
      ReturnType<typeof loadSafetyScoreV9Publication>
    > = null;
    let previousHealth: V9PublicationHealth | null = null;
    let assessment;
    try {
      [acceptedPublication, previousHealth] = await Promise.all([
        loadSafetyScoreV9Publication(input.db, publicationSignal),
        loadSafetyScoreV9PublicationHealth(input.db, publicationSignal),
      ]);
      logPublicationGenerationDeltas(publication, acceptedPublication);
      assessment = assessV9Publication({
        inputHealth: fixedInput.v9PublicationInputHealth,
        candidate: publication,
        acceptedPublication,
        coverageFloors,
        quarantinedAssetIds: pipeline.quarantines.map(
          (quarantine) => quarantine.assetId,
        ),
        quarantineAffectedAssetIds:
          pipeline.quarantineAffectedAssetIds,
      });
    } catch (error) {
      assessment = {
        decision: "hold" as const,
        reasons: [
          {
            code: "assessment-failed" as const,
            detail: safeFailure(error, "publication-gate").message.slice(
              0,
              240,
            ),
          },
        ],
        affectedAssetIds: pipeline.quarantineAffectedAssetIds,
      };
    }

    if (assessment.decision === "hold") {
      await persistSafetyScoreV9Publication(input.db, {
        publicationHealth: heldPublicationHealth({
          attemptedAtSec: fixedInput.clockSec,
          reasons: assessment.reasons,
          acceptedPublication,
          previousHealth,
        }),
        publicationAttempt: publicationAttempt({
          attemptedAtSec: fixedInput.clockSec,
          outcome: "held",
          publicationGenerationId: null,
          quarantines: pipeline.quarantines,
          affectedAssetIds: assessment.affectedAssetIds,
        }),
        publicationClockSec: fixedInput.clockSec,
        signal: publicationSignal,
      });
      return {
        status: "held",
        attemptId,
        attemptedPublicationGenerationId:
          publication.publicationGenerationId,
        reasons: assessment.reasons,
        quarantines: pipeline.quarantines,
        affectedAssetIds: assessment.affectedAssetIds,
      };
    }

    if (
      fixedInput.baseInputGenerationId !==
      publication.baseInputGenerationId
    ) {
      throw new Error(
        "Accepted Safety Score v9 input does not match the publication base generation",
      );
    }
    stage = "publication-write";
    const partial = assessment.affectedAssetIds.length > 0;
    await persistSafetyScoreV9Publication(input.db, {
      publication,
      publicationHealth: {
        schemaVersion: 1,
        status: "current",
        acceptedPublicationGenerationId:
          publication.publicationGenerationId,
        acceptedAtSec: fixedInput.clockSec,
        attemptedAtSec: fixedInput.clockSec,
        heldSinceSec: null,
        reasons: [],
      },
      publicationAttempt: publicationAttempt({
        attemptedAtSec: fixedInput.clockSec,
        outcome: partial
          ? "published-partial"
          : "published-clean",
        publicationGenerationId:
          publication.publicationGenerationId,
        quarantines: pipeline.quarantines,
        affectedAssetIds: assessment.affectedAssetIds,
      }),
      publicationClockSec: fixedInput.clockSec,
      signal: publicationSignal,
    });
    return {
      status: "published",
      attemptId,
      publicationGenerationId: publication.publicationGenerationId,
      candidateId: publication.candidateId,
      outcome: partial ? "partial" : "clean",
      quarantines: pipeline.quarantines,
      affectedAssetIds: assessment.affectedAssetIds,
    };
  } catch (error) {
    const failureStage: SafetyScoreV9PublicationFailureStage =
      publicationSignal.aborted ? "aborted" : stage;
    const failure = safeFailure(error, failureStage);
    await persistFailedPublicationAttempt({
      db: input.db,
      attemptedAtSec,
      failure: {
        stage: failureStage,
        ...failure,
      },
      signal: publicationSignal,
    });
    return {
      status: "failed",
      attemptId,
      stage: failureStage,
      ...failure,
    };
  }
}

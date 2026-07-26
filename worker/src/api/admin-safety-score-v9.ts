import {
  SAFETY_SCORE_V9_ADMIN_RESPONSE_SCHEMA_VERSION,
  SafetyScoreV9AdminResponseSchema,
  type SafetyScoreV9AdminResponse,
} from "@shared/types/safety-score-v9-admin";
import {
  SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION,
  SafetyScoreV9MovementReviewRequestSchema,
  SafetyScoreV9MovementReviewResponseSchema,
} from "@shared/types/safety-score-v9-review";
import {
  SafetyScorePublicationIdentitySchema,
  SafetyScoreV8PublicationIdentitySchema,
  SafetyScoreV9PublicationIdentitySchema,
} from "@shared/types/safety-score-publication";
import { z } from "zod";
import { parseRequestJsonWithSchema } from "../lib/api-utils";
import { isWellFormedIdempotencyKey } from "../lib/idempotency";
import {
  adminErrorResponse,
  adminJsonResponse,
  makeAdminRoute,
  makeIdempotentAdminRoute,
  type AdminRouteContext,
} from "../lib/route-wrappers";
import {
  loadLatestSafetyScoreV9DiffReport,
  loadLatestSafetyScoreV9ShadowEnvelope,
  loadSafetyScoreV9PublicationHealth,
  loadSafetyScoreV9ShadowHistory,
} from "../lib/safety-score-v9-store";
import {
  createSafetyScoreV9MovementReview,
  loadSafetyScoreV9MovementReviews,
  persistSafetyScoreV9MovementReview,
  SafetyScoreV9MovementReviewConflictError,
} from "../lib/safety-score-v9-movement-reviews";
import {
  executeSafetyScoreHistoryBoundaryOperation,
  type SafetyScoreHistoryBoundaryOperationInput,
  type SafetyScoreHistoryBoundaryOperationResult,
} from "../lib/safety-score-history-boundary-operation";

export const SAFETY_SCORE_HISTORY_BOUNDARY_REQUEST_SCHEMA_VERSION = 1;
export const SAFETY_SCORE_HISTORY_BOUNDARY_RESPONSE_SCHEMA_VERSION = 1;

const SafetyScoreHistoryBoundaryRequestBaseSchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_HISTORY_BOUNDARY_REQUEST_SCHEMA_VERSION),
    recordedAtSec: z.number().int().nonnegative(),
  })
  .strict();

export const SafetyScoreHistoryBoundaryRequestSchema = z.discriminatedUnion("operation", [
  SafetyScoreHistoryBoundaryRequestBaseSchema.extend({
    operation: z.literal("activate-v9"),
    expectedIdentity: SafetyScoreV9PublicationIdentitySchema,
  }).strict(),
  SafetyScoreHistoryBoundaryRequestBaseSchema.extend({
    operation: z.literal("rollback-v8"),
    expectedIdentity: SafetyScoreV8PublicationIdentitySchema,
  }).strict(),
  SafetyScoreHistoryBoundaryRequestBaseSchema.extend({
    operation: z.literal("restore-v9"),
    expectedIdentity: SafetyScoreV9PublicationIdentitySchema,
  }).strict(),
]);

export const SafetyScoreHistoryBoundaryResponseSchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_HISTORY_BOUNDARY_RESPONSE_SCHEMA_VERSION),
    status: z.literal("recorded"),
    operation: z.enum(["activate-v9", "rollback-v8", "restore-v9"]),
    transitionKind: z.enum(["methodology-boundary-baseline", "rollback-baseline", "restoration-baseline"]),
    identity: SafetyScorePublicationIdentitySchema,
    recordedAtSec: z.number().int().nonnegative(),
    cardCount: z.number().int().nonnegative(),
    changes: z.number().int().nonnegative(),
  })
  .strict();

export interface SafetyScoreHistoryBoundaryRouteDependencies {
  executeBoundary?: (
    db: D1Database,
    input: SafetyScoreHistoryBoundaryOperationInput,
  ) => Promise<SafetyScoreHistoryBoundaryOperationResult>;
  nowSec?: () => number;
}

function unavailable(reason: Extract<SafetyScoreV9AdminResponse, { status: "unavailable" }>["reason"]): Response {
  return adminJsonResponse(
    SafetyScoreV9AdminResponseSchema.parse({
      schemaVersion: SAFETY_SCORE_V9_ADMIN_RESPONSE_SCHEMA_VERSION,
      status: "unavailable",
      reason,
    }),
  );
}

function candidateAndDiffMatch(
  envelope: Awaited<ReturnType<typeof loadLatestSafetyScoreV9ShadowEnvelope>>,
  diff: Awaited<ReturnType<typeof loadLatestSafetyScoreV9DiffReport>>,
): boolean {
  if (envelope === null || diff === null) return false;
  const candidate = envelope.candidate;
  const identity = diff.v9Identity;
  return (
    identity.candidateId === candidate.candidateId &&
    identity.policyVersion === candidate.policyVersion &&
    identity.publicationGenerationId === candidate.publicationGenerationId &&
    identity.baseInputGenerationId === candidate.baseInputGenerationId &&
    identity.factSetDigest === candidate.factSetDigest &&
    identity.policyId === candidate.policy.id &&
    identity.policyDigest === candidate.policy.semanticDigest &&
    identity.evaluationBuildDigest === candidate.evaluationBuildDigest &&
    identity.resultDigest === candidate.resultDigest
  );
}

export const handleAdminSafetyScoreV9 = makeAdminRoute<AdminRouteContext>(
  "route-admin-safety-score-v9",
  async ({ db, request }) => {
    try {
      const envelope = await loadLatestSafetyScoreV9ShadowEnvelope(db, request.signal);
      if (envelope === null) return unavailable("shadow-envelope-unavailable");
      const publicationHealth = await loadSafetyScoreV9PublicationHealth(
        db,
        request.signal,
      );
      if (publicationHealth === null) {
        return unavailable("stored-shadow-invalid");
      }
      if (
        publicationHealth.acceptedPublicationGenerationId !==
          envelope.candidate.publicationGenerationId ||
        publicationHealth.acceptedAtSec !== envelope.candidate.publishedAtSec
      ) {
        return unavailable("stored-shadow-invalid");
      }

      const diff = await loadLatestSafetyScoreV9DiffReport(db, request.signal);
      if (diff === null) return unavailable("shadow-diff-unavailable");
      if (!candidateAndDiffMatch(envelope, diff)) return unavailable("shadow-generation-mismatch");

      const history = await loadSafetyScoreV9ShadowHistory(db, { signal: request.signal });
      if (history.length === 0) return unavailable("shadow-history-unavailable");
      const movementReviews = await loadSafetyScoreV9MovementReviews(
        db,
        diff.cards.flatMap((card) => (card.review.key ? [card.review.key] : [])),
        request.signal,
      );

      return adminJsonResponse(
        SafetyScoreV9AdminResponseSchema.parse({
          schemaVersion: SAFETY_SCORE_V9_ADMIN_RESPONSE_SCHEMA_VERSION,
          status: "available",
          publicationHealth,
          envelope,
          diff,
          movementReviews,
          history,
        }),
      );
    } catch {
      return unavailable("stored-shadow-invalid");
    }
  },
);

async function handleAdminSafetyScoreV9MovementReviewTrusted({ db, request }: AdminRouteContext): Promise<Response> {
  if (!isWellFormedIdempotencyKey(request.headers.get("Idempotency-Key"))) {
    return adminErrorResponse(400, "A valid Idempotency-Key header between 8 and 128 characters is required");
  }

  const parsed = await parseRequestJsonWithSchema(request, SafetyScoreV9MovementReviewRequestSchema, {
    invalidJsonMessage: "Invalid Safety Score v9 movement review body",
    bodyTooLargeMessage: "Safety Score v9 movement review body is too large",
    formatSchemaError: (issues) => issues[0]?.message ?? "Invalid Safety Score v9 movement review body",
    responseOptions: { noStore: true },
    maxBytes: 16 * 1024,
  });
  if (parsed instanceof Response) return parsed;

  try {
    const diff = await loadLatestSafetyScoreV9DiffReport(db, request.signal);
    if (diff === null) {
      return adminErrorResponse(409, "No Safety Score v9 shadow diff is available for review");
    }
    const review = createSafetyScoreV9MovementReview({
      request: parsed,
      diff,
      reviewedAtSec: Math.floor(Date.now() / 1_000),
    });
    const result = await persistSafetyScoreV9MovementReview(db, review, request.signal);
    return adminJsonResponse(
      SafetyScoreV9MovementReviewResponseSchema.parse({
        schemaVersion: SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION,
        ...result,
      }),
      { status: result.status === "recorded" ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof SafetyScoreV9MovementReviewConflictError) {
      return adminErrorResponse(409, error.message);
    }
    if (error instanceof Error && /does not require review|has no asset/.test(error.message)) {
      return adminErrorResponse(400, error.message);
    }
    return adminErrorResponse(503, "Safety Score v9 movement review could not be recorded");
  }
}

export const handleAdminSafetyScoreV9MovementReview = makeIdempotentAdminRoute<AdminRouteContext>(
  "route-admin-safety-score-v9-review",
  "admin-safety-score-v9-review",
  handleAdminSafetyScoreV9MovementReviewTrusted,
);

export function createHandleAdminSafetyScoreV9HistoryBoundary(
  dependencies: SafetyScoreHistoryBoundaryRouteDependencies = {},
): (context: AdminRouteContext) => Promise<Response> {
  const executeBoundary = dependencies.executeBoundary ?? executeSafetyScoreHistoryBoundaryOperation;
  const currentTimeSec = dependencies.nowSec ?? (() => Math.floor(Date.now() / 1_000));

  return makeIdempotentAdminRoute<AdminRouteContext>(
    "route-admin-safety-score-v9-history-boundary",
    "admin-safety-score-v9-history-boundary",
    async ({ db, request }) => {
      if (!isWellFormedIdempotencyKey(request.headers.get("Idempotency-Key"))) {
        return adminErrorResponse(400, "A valid Idempotency-Key header between 8 and 128 characters is required");
      }

      const parsed = await parseRequestJsonWithSchema(request, SafetyScoreHistoryBoundaryRequestSchema, {
        invalidJsonMessage: "Invalid Safety Score history boundary body",
        bodyTooLargeMessage: "Safety Score history boundary body is too large",
        formatSchemaError: (issues) => issues[0]?.message ?? "Invalid Safety Score history boundary body",
        responseOptions: { noStore: true },
        maxBytes: 16 * 1024,
      });
      if (parsed instanceof Response) return parsed;

      try {
        const result = await executeBoundary(db, {
          operation: parsed.operation,
          expectedIdentity: parsed.expectedIdentity,
          recordedAtSec: parsed.recordedAtSec,
          createdAtSec: currentTimeSec(),
          signal: request.signal,
        });
        return adminJsonResponse(
          SafetyScoreHistoryBoundaryResponseSchema.parse({
            schemaVersion: SAFETY_SCORE_HISTORY_BOUNDARY_RESPONSE_SCHEMA_VERSION,
            status: "recorded",
            ...result,
          }),
          { status: 201 },
        );
      } catch (error) {
        if (
          error instanceof Error &&
          (
            /boundary source identity does not match the approved identity/.test(error.message) ||
            /boundary source has no eligible cards/.test(error.message)
          )
        ) {
          return adminErrorResponse(409, error.message);
        }
        return adminErrorResponse(503, "Safety Score history boundary could not be recorded");
      }
    },
  );
}

/**
 * Bounded operator action only. Activation remains a separate runbook step;
 * this handler never writes or removes the public activation marker.
 */
export const handleAdminSafetyScoreV9HistoryBoundary = createHandleAdminSafetyScoreV9HistoryBoundary();

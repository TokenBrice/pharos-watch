import { errorResponse, jsonResponse, parseRequestJsonWithSchema } from "../../lib/api-utils";
import { reserveFeedbackRateLimit } from "../../lib/rate-limit";
import { safeErrorMessage } from "../../lib/safe-error-message";
import { resolveStablecoinId } from "@shared/lib/stablecoin-id-registry";
import {
  FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS,
  FEEDBACK_RATE_LIMIT_WINDOW_SEC,
  FeedbackBodySchema,
  type FeedbackBody,
  type FeedbackEnv,
  type PreparedFeedbackSubmission,
  type ValidatedFeedbackSubmission,
} from "./types";
import { logWorkerEvent } from "../../lib/structured-log";

const FEEDBACK_DEPENDENCY_RETRY_AFTER_SEC = 60;
export const FEEDBACK_REQUEST_MAX_BYTES = 16 * 1024;

export async function parseFeedbackRequest(request: Request): Promise<FeedbackBody | Response> {
  return parseRequestJsonWithSchema(request, FeedbackBodySchema, {
    maxBytes: FEEDBACK_REQUEST_MAX_BYTES,
    formatSchemaError: (issues) => issues[0]?.message ?? "Invalid feedback data",
  });
}

export function validateFeedbackSubmission(feedback: FeedbackBody): ValidatedFeedbackSubmission | Response {
  if (feedback.website) return jsonResponse({ ok: true });

  if (feedback.type === "bug" || feedback.type === "feature-request") {
    const title = feedback.title?.trim() ?? "";
    if (title.length < 3 || title.length > 100) {
      return errorResponse(400, "Title must be 3–100 characters");
    }
    feedback = {
      ...feedback,
      title,
    };
  }

  let canonicalStablecoinId: string | undefined;
  if (feedback.stablecoinId) {
    const resolved = resolveStablecoinId(feedback.stablecoinId);
    if (!resolved) {
      return errorResponse(400, "Invalid stablecoinId");
    }
    canonicalStablecoinId = resolved.canonicalId;
    feedback = {
      ...feedback,
      stablecoinId: resolved.canonicalId,
    };
  }

  return {
    feedback: {
      ...feedback,
      contactHandle: feedback.contactHandle?.trim() || undefined,
    },
    canonicalStablecoinId,
  };
}

export async function prepareFeedbackSubmission(
  db: D1Database,
  request: Request,
  env: FeedbackEnv,
  validated: ValidatedFeedbackSubmission,
): Promise<PreparedFeedbackSubmission | Response> {
  if (!env.FEEDBACK_IP_SALT) {
    logWorkerEvent({
      scope: "api",
      level: "error",
      event: "feedback_config_missing",
      route: "feedback",
      source: "env",
      message: "Feedback IP salt secret not configured",
      metadata: { configKey: "FEEDBACK_IP_SALT" },
    });
    return errorResponse(503, "Service misconfigured");
  }

  if (!env.GITHUB_PAT) {
    logWorkerEvent({
      scope: "api",
      level: "error",
      event: "feedback_config_missing",
      route: "feedback",
      source: "env",
      message: "Feedback GitHub token secret not configured",
      metadata: { configKey: "GITHUB_PAT" },
    });
    return errorResponse(503, "Feedback service temporarily unavailable");
  }

  let rateLimitReservation;
  try {
    rateLimitReservation = await reserveFeedbackRateLimit(
      db,
      resolveFeedbackClientIp(request),
      env.FEEDBACK_IP_SALT,
      FEEDBACK_RATE_LIMIT_WINDOW_SEC,
      FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS,
    );
  } catch (error) {
    logWorkerEvent({
      scope: "api",
      level: "error",
      event: "feedback_rate_limit_dependency_unavailable",
      route: "feedback",
      source: "feedback_rate_limit",
      message: "Feedback rate-limit dependency unavailable",
      error: safeErrorMessage(error),
    });
    return errorResponse(503, "Feedback service temporarily unavailable. Please try again.", {
      retryAfterSec: FEEDBACK_DEPENDENCY_RETRY_AFTER_SEC,
    });
  }

  if (!rateLimitReservation) {
    return errorResponse(429, "Too many submissions. Please wait a few minutes.");
  }

  return {
    feedback: validated.feedback,
    pat: env.GITHUB_PAT,
    canonicalStablecoinId: validated.canonicalStablecoinId,
    rateLimitReservation,
  };
}

// Exported for unit tests; not part of the public handler surface.
export function resolveFeedbackClientIp(request: Request): string {
  // CF-Connecting-IP is injected by the Cloudflare edge for every real inbound
  // request and cannot be spoofed by the client. We deliberately do NOT fall
  // back to the client-controlled X-Forwarded-For header — trusting it would let
  // a caller rotate the IP-scoped rate-limit bucket. If CF-Connecting-IP is
  // absent (e.g. off-edge), all such requests collapse into one fixed sentinel
  // bucket rather than attacker-chosen ones.
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

import { errorResponse, jsonResponse } from "../../lib/api-utils";
import { checkFeedbackRateLimit } from "../../lib/rate-limit";
import { resolveStablecoinId } from "@shared/lib/stablecoin-id-registry";
import {
  FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS,
  FEEDBACK_RATE_LIMIT_WINDOW_SEC,
  FeedbackBodySchema,
  type FeedbackBody,
  type FeedbackEnv,
  type PreparedFeedbackSubmission,
} from "./types";

export async function parseFeedbackRequest(request: Request): Promise<FeedbackBody | Response> {
  try {
    const raw = await request.json();
    const result = FeedbackBodySchema.safeParse(raw);
    if (!result.success) {
      return errorResponse(400, result.error.issues[0]?.message ?? "Invalid feedback data");
    }
    return result.data;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
}

export async function prepareFeedbackSubmission(
  db: D1Database,
  request: Request,
  env: FeedbackEnv,
  feedback: FeedbackBody,
): Promise<PreparedFeedbackSubmission | Response> {
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

  const contactHandle = feedback.contactHandle?.trim() ?? "";
  if (feedback.contactConsent) {
    if (!feedback.contactChannel) {
      return errorResponse(400, "Choose Telegram or X for follow-up contact");
    }
    if (contactHandle.length < 2 || contactHandle.length > 100) {
      return errorResponse(400, "Contact handle must be 2–100 characters");
    }
    feedback = {
      ...feedback,
      contactHandle,
    };
  } else if (feedback.contactChannel || contactHandle) {
    feedback = {
      ...feedback,
      contactConsent: false,
      contactChannel: undefined,
      contactHandle: undefined,
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

  if (!env.FEEDBACK_IP_SALT) {
    console.error("[feedback] FEEDBACK_IP_SALT secret not configured");
    return errorResponse(503, "Service misconfigured");
  }

  if (!env.GITHUB_PAT) {
    console.error("[feedback] GITHUB_PAT secret not configured");
    return errorResponse(503, "Feedback service temporarily unavailable");
  }

  const allowed = await checkFeedbackRateLimit(
    db,
    resolveFeedbackClientIp(request),
    env.FEEDBACK_IP_SALT,
    FEEDBACK_RATE_LIMIT_WINDOW_SEC,
    FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS,
  );
  if (!allowed) {
      return errorResponse(429, "Too many submissions. Please wait a few minutes.");
  }

  return {
    feedback,
    pat: env.GITHUB_PAT,
    submissionId: "",
    canonicalStablecoinId,
    repositoryId: env.GITHUB_REPO_NODE_ID,
    discussionCategoryId: env.GITHUB_DISCUSSION_CATEGORY_ID,
  };
}

function resolveFeedbackClientIp(request: Request): string {
  const forwardedFor = request.headers.get("X-Forwarded-For");
  return request.headers.get("CF-Connecting-IP") ?? forwardedFor?.split(",")[0]?.trim() ?? "unknown";
}

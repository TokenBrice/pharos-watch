import type {
  ApiKeySelfServeIssueResponse,
  ApiKeySelfServePendingResponse,
} from "@shared/types";
import {
  SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
  SELF_SERVE_DEPENDENCY_RETRY_AFTER_SEC,
} from "@shared/lib/ops-limits";
import { errorResponse, jsonResponse } from "../../lib/api-utils";

const SELF_SERVE_BASE_URL = "https://api.pharos.watch" as const;
const SELF_SERVE_RETRY_GUIDANCE = "Respect Retry-After on 429 responses and add jitter to polling intervals.";
const SELF_SERVE_PENDING_MESSAGE = "If this address can receive verification email, check your inbox to continue.";

export interface SelfServeKeyNameSource {
  organization: string | null;
  requester_name: string | null;
  normalized_email: string;
}

export interface IssuedSelfServeKeySummary {
  keyPrefix: string;
  maskedToken: string;
  expiresAt: number | null;
}

export function buildSelfServeKeyName(row: SelfServeKeyNameSource): string {
  const owner = row.organization || row.requester_name || row.normalized_email;
  return `Self-serve: ${owner}`.slice(0, 80);
}

export function issuedPublicResponse(issuedKey: IssuedSelfServeKeySummary, token: string): Response {
  const responseBody: ApiKeySelfServeIssueResponse = {
    status: "issued",
    key: {
      keyPrefix: issuedKey.keyPrefix,
      maskedToken: issuedKey.maskedToken,
      tier: "self-serve",
      trafficClass: "external",
      rateLimitPerMinute: SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
      expiresAt: issuedKey.expiresAt,
    },
    token,
    usage: {
      baseUrl: SELF_SERVE_BASE_URL,
      headerName: "X-API-Key",
      retryGuidance: SELF_SERVE_RETRY_GUIDANCE,
    },
  };
  return jsonResponse(responseBody, { status: 201, noStore: true });
}

export function pendingPublicResponse(): Response {
  const responseBody: ApiKeySelfServePendingResponse = {
    status: "pending_verification",
    message: SELF_SERVE_PENDING_MESSAGE,
  };
  return jsonResponse(responseBody, { status: 202, noStore: true });
}

export function selfServeError(status: number, message: string, retryAfterSec?: number): Response {
  return errorResponse(status, message, { noStore: true, retryAfterSec });
}

export function selfServeUnavailable(): Response {
  return selfServeError(
    503,
    "API key self-serve is temporarily unavailable. Please try again.",
    SELF_SERVE_DEPENDENCY_RETRY_AFTER_SEC,
  );
}

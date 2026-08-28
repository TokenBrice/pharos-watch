import type {
  ApiKeySelfServeIssueResponse,
  ApiKeySelfServePendingResponse,
} from "@shared/types";
import {
  SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
  SELF_SERVE_DEPENDENCY_RETRY_AFTER_SEC,
} from "@shared/lib/ops-limits";
import {
  PUBLIC_API_HOST,
  PUBLIC_API_KEY_HEADER,
  PUBLIC_API_RETRY_GUIDANCE,
} from "@shared/lib/public-api-contract";
import { errorResponse, jsonResponse } from "../../lib/api-response";

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
      baseUrl: PUBLIC_API_HOST,
      headerName: PUBLIC_API_KEY_HEADER,
      retryGuidance: PUBLIC_API_RETRY_GUIDANCE,
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

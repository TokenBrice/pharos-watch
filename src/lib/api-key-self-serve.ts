import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import {
  SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
} from "@shared/lib/ops-limits";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import type {
  ApiKeySelfServeIssueResponse,
  ApiKeySelfServePendingResponse,
  ApiKeySelfServeRequest,
} from "@shared/types";
import { buildApiUrl } from "@/lib/api";

const VERIFICATION_TOKEN_PREFIX = "akv_";

interface ApiErrorPayload {
  error?: string;
  message?: string;
}

function isApiKeySelfServeIssueResponse(payload: unknown): payload is ApiKeySelfServeIssueResponse {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Partial<ApiKeySelfServeIssueResponse>;
  const key = candidate.key;
  return candidate.status === "issued"
    && typeof candidate.token === "string"
    && candidate.token.trim().length > 0
    && !!key
    && typeof key === "object"
    && typeof key.keyPrefix === "string"
    && key.keyPrefix.trim().length > 0
    && typeof key.maskedToken === "string"
    && key.maskedToken.trim().length > 0
    && key.tier === "self-serve"
    && key.trafficClass === "external"
    && key.rateLimitPerMinute === SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE
    && (typeof key.expiresAt === "number" || key.expiresAt === null);
}

async function readJson<T>(response: Response): Promise<T | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function resolveErrorMessage(status: number, payload: ApiErrorPayload | null): string {
  return payload?.error ?? payload?.message ?? `Request failed with status ${status}`;
}

export async function submitApiKeyRequest(
  body: ApiKeySelfServeRequest,
): Promise<ApiKeySelfServePendingResponse> {
  const response = await fetch(buildApiUrl(API_PATHS.apiKeyRequests()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`,
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson<ApiKeySelfServePendingResponse | ApiErrorPayload>(response);
  if (!response.ok || !payload || !("status" in payload) || payload.status !== "pending_verification") {
    throw new Error(resolveErrorMessage(response.status, payload && !("status" in payload) ? payload : null));
  }
  return payload;
}

export async function verifyApiKeyRequestToken(token: string): Promise<ApiKeySelfServeIssueResponse> {
  const response = await fetch(buildApiUrl(API_PATHS.apiKeyRequestVerify()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`,
    },
    body: JSON.stringify({ token }),
  });
  const payload = await readJson<unknown>(response);
  if (!response.ok) {
    const errorPayload = payload && typeof payload === "object" && !("status" in payload)
      ? payload as ApiErrorPayload
      : null;
    throw new Error(resolveErrorMessage(response.status, errorPayload));
  }
  if (!isApiKeySelfServeIssueResponse(payload)) {
    throw new Error("Verification succeeded, but the API key was not returned. Please contact support via the link on the API page before leaving this page.");
  }
  return payload;
}

function parseHashVerificationToken(hash: string): string | null {
  const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!rawHash.startsWith(VERIFICATION_TOKEN_PREFIX)) return null;
  try {
    return decodeURIComponent(rawHash).trim();
  } catch {
    return null;
  }
}

function scrubHashVerificationToken(hash: string): string {
  return parseHashVerificationToken(hash) ? "" : hash;
}

export function readVerificationTokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return parseHashVerificationToken(window.location.hash);
}

export function stripVerificationTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const nextHash = scrubHashVerificationToken(window.location.hash);
  if (nextHash === window.location.hash) return;
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${nextHash}`,
  );
}

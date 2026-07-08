import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE } from "@shared/lib/ops-limits";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import {
  ApiKeySelfServePendingResponseSchema,
  buildApiKeySelfServeIssueResponseSchema,
} from "@shared/types/api-key-requests";
import type {
  ApiKeySelfServeIssueResponse,
  ApiKeySelfServePendingResponse,
  ApiKeySelfServeRequest,
} from "@shared/types";
import { ApiFetchError, apiFetch } from "@/lib/api";
import type { SchemaLike } from "@/lib/schema-like";

const ApiKeySelfServeIssueResponseSchema = buildApiKeySelfServeIssueResponseSchema(
  SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
);

const VERIFICATION_TOKEN_PREFIX = "akv_";
const VERIFICATION_TOKEN_SESSION_STORAGE_KEY = "pharos:api-key-verify-token";

interface ApiErrorPayload {
  error?: string;
  message?: string;
}

function parseApiErrorPayload(bodyText: string | null): ApiErrorPayload | null {
  if (!bodyText) return null;
  try {
    const payload = JSON.parse(bodyText) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    if ("status" in payload) {
      return null;
    }
    return payload as ApiErrorPayload;
  } catch {
    return null;
  }
}

function resolveErrorMessage(status: number, payload: ApiErrorPayload | null): string {
  return payload?.error ?? payload?.message ?? `Request failed with status ${status}`;
}

async function postSelfServeJson<T>(path: string, body: unknown, schema: SchemaLike<T>): Promise<T> {
  try {
    return await apiFetch<T>(path, schema, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof ApiFetchError) {
      throw new Error(resolveErrorMessage(error.status, parseApiErrorPayload(error.bodyText)));
    }
    throw error;
  }
}

export async function submitApiKeyRequest(
  body: ApiKeySelfServeRequest,
): Promise<ApiKeySelfServePendingResponse> {
  return postSelfServeJson(API_PATHS.apiKeyRequests(), body, ApiKeySelfServePendingResponseSchema);
}

export async function verifyApiKeyRequestToken(token: string): Promise<ApiKeySelfServeIssueResponse> {
  return postSelfServeJson(
    API_PATHS.apiKeyRequestVerify(),
    { token },
    ApiKeySelfServeIssueResponseSchema,
  );
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

function scrubQueryVerificationToken(search: string): string {
  if (!search.includes("verify=")) return search;
  const params = new URLSearchParams(search);
  if (!params.has("verify")) return search;
  params.delete("verify");
  const next = params.toString();
  return next ? `?${next}` : "";
}

export function readVerificationTokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const hashToken = parseHashVerificationToken(window.location.hash);
  if (hashToken) return hashToken;
  try {
    const storedToken = window.sessionStorage?.getItem(VERIFICATION_TOKEN_SESSION_STORAGE_KEY)?.trim() ?? null;
    if (storedToken?.startsWith(VERIFICATION_TOKEN_PREFIX)) {
      window.sessionStorage.removeItem(VERIFICATION_TOKEN_SESSION_STORAGE_KEY);
      return storedToken;
    }
  } catch {
    // Storage can be disabled in privacy-restricted browsers; the hash path
    // above remains the best-effort fallback.
  }
  return null;
}

export function stripQueryVerificationTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const nextSearch = scrubQueryVerificationToken(window.location.search);
  if (nextSearch === window.location.search) return;
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${nextSearch}${window.location.hash}`,
  );
}

export function stripVerificationTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const nextSearch = scrubQueryVerificationToken(window.location.search);
  const nextHash = scrubHashVerificationToken(window.location.hash);
  if (nextSearch === window.location.search && nextHash === window.location.hash) return;
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${nextSearch}${nextHash}`,
  );
}

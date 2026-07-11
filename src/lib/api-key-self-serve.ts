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
import { ApiFetchError, SchemaValidationError, apiFetch } from "@/lib/api";
import type { SchemaLike } from "@/lib/schema-like";

const ApiKeySelfServeIssueResponseSchema = buildApiKeySelfServeIssueResponseSchema(
  SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
);

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
  try {
    return await postSelfServeJson(
      API_PATHS.apiKeyRequestVerify(),
      { token },
      ApiKeySelfServeIssueResponseSchema,
    );
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new Error(
        "Verification succeeded, but the API key was not returned. Please contact support via the link on the API page before leaving this page.",
      );
    }
    throw error;
  }
}

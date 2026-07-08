import { afterEach, describe, expect, it, vi } from "vitest";
import { SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE } from "@shared/lib/ops-limits";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import {
  ApiKeySelfServePendingResponseSchema,
  buildApiKeySelfServeIssueResponseSchema,
} from "@shared/types/api-key-requests";
import type { ApiKeySelfServeRequest, ApiKeySelfServeIssueResponse } from "@shared/types";
import { DEFAULT_API_REQUEST_TIMEOUT_MS, SchemaValidationError } from "../api";
import { submitApiKeyRequest, verifyApiKeyRequestToken } from "../api-key-self-serve";

const ApiKeySelfServeIssueResponseSchema = buildApiKeySelfServeIssueResponseSchema(
  SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
);

const ORIGINAL_FORCE_SITE_DATA_PROXY = process.env.NEXT_PUBLIC_FORCE_SITE_DATA_PROXY;

afterEach(() => {
  if (ORIGINAL_FORCE_SITE_DATA_PROXY === undefined) {
    delete process.env.NEXT_PUBLIC_FORCE_SITE_DATA_PROXY;
  } else {
    process.env.NEXT_PUBLIC_FORCE_SITE_DATA_PROXY = ORIGINAL_FORCE_SITE_DATA_PROXY;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function legacyIsPendingResponse(payload: unknown): boolean {
  return !!payload
    && typeof payload === "object"
    && "status" in payload
    && payload.status === "pending_verification";
}

function legacyIsIssueResponse(payload: unknown): payload is ApiKeySelfServeIssueResponse {
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

function issuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "issued",
    token: "ak_live_secret",
    key: {
      keyPrefix: "ak_live",
      maskedToken: "ak_live_****",
      tier: "self-serve",
      trafficClass: "external",
      rateLimitPerMinute: SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
      expiresAt: 123,
    },
    usage: {
      baseUrl: "https://api.pharos.watch",
      headerName: "X-API-Key",
      retryGuidance: "Respect Retry-After.",
    },
    ...overrides,
  };
}

function issuePayloadWithKey(overrides: Record<string, unknown>): Record<string, unknown> {
  const payload = issuePayload();
  return {
    ...payload,
    key: {
      ...(payload.key as Record<string, unknown>),
      ...overrides,
    },
  };
}

function requestBody(): ApiKeySelfServeRequest {
  return {
    email: "builder@example.com",
    useCase: "Read public stablecoin analytics for an internal monitor.",
    expectedCadence: "hourly",
    acceptedTerms: true,
  };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("api key self-serve response schemas", () => {
  it.each([
    { status: "pending_verification", message: "Check your email." },
    { status: "pending_verification" },
    { status: "pending_verification", message: 42 },
    { status: "pending_verification", extra: true },
    { status: "issued", message: "wrong status" },
    { message: "missing status" },
    null,
    [],
    "pending_verification",
  ])("matches the legacy pending-response guard for %#", (payload) => {
    expect(ApiKeySelfServePendingResponseSchema.safeParse(payload).success).toBe(
      legacyIsPendingResponse(payload),
    );
  });

  it.each([
    issuePayload(),
    issuePayload({ usage: undefined }),
    issuePayload({ usage: { unexpected: true } }),
    issuePayload({ token: "  ak_live_secret  " }),
    issuePayloadWithKey({ keyPrefix: "  ak_live  " }),
    issuePayloadWithKey({ maskedToken: "  ak_live_****  " }),
    issuePayloadWithKey({ expiresAt: null }),
    issuePayload({ status: "pending_verification" }),
    issuePayload({ token: "" }),
    issuePayload({ token: "   " }),
    issuePayload({ token: 123 }),
    issuePayload({ key: null }),
    issuePayload({ key: "not an object" }),
    issuePayloadWithKey({ keyPrefix: "" }),
    issuePayloadWithKey({ keyPrefix: "   " }),
    issuePayloadWithKey({ maskedToken: "" }),
    issuePayloadWithKey({ maskedToken: "   " }),
    issuePayloadWithKey({ tier: "admin" }),
    issuePayloadWithKey({ trafficClass: "site" }),
    issuePayloadWithKey({ rateLimitPerMinute: SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE + 1 }),
    issuePayloadWithKey({ rateLimitPerMinute: String(SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE) }),
    issuePayloadWithKey({ expiresAt: undefined }),
    issuePayloadWithKey({ expiresAt: "123" }),
    null,
    [],
    "issued",
  ])("matches the legacy issue-response guard for %#", (payload) => {
    expect(ApiKeySelfServeIssueResponseSchema.safeParse(payload).success).toBe(
      legacyIsIssueResponse(payload),
    );
  });
});

describe("api key self-serve requests", () => {
  it("submits a request and returns the pending response", async () => {
    const body = { status: "pending_verification", message: "Check your email." };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(body));

    await expect(submitApiKeyRequest(requestBody())).resolves.toEqual(body);
  });

  it("verifies a token and returns the issued API key response", async () => {
    const body = issuePayload();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(body));

    await expect(verifyApiKeyRequestToken("akv_token")).resolves.toEqual(body);
  });

  it("preserves error JSON body messages from failed submissions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "Please use a longer use case." }, { status: 400 }),
    );

    await expect(submitApiKeyRequest(requestBody())).rejects.toThrow("Please use a longer use case.");
  });

  it("preserves message fields from failed verification responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ message: "Verification link expired." }, { status: 410 }),
    );

    await expect(verifyApiKeyRequestToken("akv_expired")).rejects.toThrow("Verification link expired.");
  });

  it("falls back to status text when an error JSON body carries a status field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ status: "blocked", error: "Blocked request." }, { status: 403 }),
    );

    await expect(submitApiKeyRequest(requestBody())).rejects.toThrow("Request failed with status 403");
  });

  it("rejects malformed success bodies through schema validation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(issuePayloadWithKey({ rateLimitPerMinute: SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE + 1 })),
    );

    await expect(verifyApiKeyRequestToken("akv_token")).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("uses the shared request timeout and aborts the POST", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new DOMException("timed out", "TimeoutError"));
          });
        }),
    );

    const requestPromise = submitApiKeyRequest(requestBody());
    const rejection = expect(requestPromise).rejects.toMatchObject({
      name: "TimeoutError",
      message: `API request timed out after ${DEFAULT_API_REQUEST_TIMEOUT_MS}ms`,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_API_REQUEST_TIMEOUT_MS);

    await rejection;
  });

  it("keeps the public API Accept marker on self-serve POST requests", async () => {
    vi.stubGlobal("window", { location: { hostname: "pharos.watch" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ status: "pending_verification", message: "Check your email." }),
    );

    await submitApiKeyRequest(requestBody());

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get("Accept")).toContain(PHAROS_WEB_ACCEPT_MARKER);
  });

  it("keeps POST requests off same-origin site-data paths", async () => {
    process.env.NEXT_PUBLIC_FORCE_SITE_DATA_PROXY = "true";
    vi.stubGlobal("window", { location: { hostname: "127.0.0.1" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ status: "pending_verification", message: "Check your email." }),
    );

    await submitApiKeyRequest(requestBody());

    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/api-key-requests");
    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain("/_site-data/");
  });
});

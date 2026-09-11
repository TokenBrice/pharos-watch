import { afterEach, describe, expect, it, vi } from "vitest";
import { SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE } from "@shared/lib/ops-limits";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import {
  ApiKeySelfServePendingResponseSchema,
  buildApiKeySelfServeIssueResponseSchema,
} from "@shared/types/api-key-requests";
import type { ApiKeySelfServeRequest } from "@shared/types";
import { submitApiKeyRequest, verifyApiKeyRequestToken } from "../api-key-self-serve";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../request-lifecycle";
import { jsonResponse, mockFetch } from "@shared/test-utils/mock-fetch";

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

/** Schema-valid issue payload; overrides mutate one field at a time. */
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

describe("api key self-serve response schemas", () => {
  it.each([
    { name: "pending status with a message", accepted: true, payload: { status: "pending_verification", message: "ok" } },
    { name: "pending status alone", accepted: true, payload: { status: "pending_verification" } },
    {
      name: "pending status with an unvalidated message type",
      accepted: true,
      payload: { status: "pending_verification", message: 42 },
    },
    {
      name: "pending status with unknown passthrough fields",
      accepted: true,
      payload: { status: "pending_verification", extra: true },
    },
    { name: "issued status", accepted: false, payload: { status: "issued", message: "wrong status" } },
    { name: "absent status", accepted: false, payload: { message: "missing status" } },
    { name: "null", accepted: false, payload: null },
    { name: "array", accepted: false, payload: [] },
    { name: "bare status string", accepted: false, payload: "pending_verification" },
  ])("pending-response acceptance is $accepted for $name", ({ payload, accepted }) => {
    expect(ApiKeySelfServePendingResponseSchema.safeParse(payload).success).toBe(accepted);
  });

  it.each([
    { name: "the complete issued payload", accepted: true, payload: issuePayload() },
    { name: "an omitted usage block", accepted: true, payload: issuePayload({ usage: undefined }) },
    { name: "an unrecognized usage block", accepted: true, payload: issuePayload({ usage: { unexpected: true } }) },
    { name: "a padded token", accepted: true, payload: issuePayload({ token: "  ak_live_secret  " }) },
    { name: "a padded key prefix", accepted: true, payload: issuePayloadWithKey({ keyPrefix: "  ak_live  " }) },
    { name: "a padded masked token", accepted: true, payload: issuePayloadWithKey({ maskedToken: "  ak_live_****  " }) },
    { name: "a non-expiring key", accepted: true, payload: issuePayloadWithKey({ expiresAt: null }) },
    { name: "a pending status", accepted: false, payload: issuePayload({ status: "pending_verification" }) },
    { name: "an empty token", accepted: false, payload: issuePayload({ token: "" }) },
    { name: "a whitespace-only token", accepted: false, payload: issuePayload({ token: "   " }) },
    { name: "a numeric token", accepted: false, payload: issuePayload({ token: 123 }) },
    { name: "a null key", accepted: false, payload: issuePayload({ key: null }) },
    { name: "a non-object key", accepted: false, payload: issuePayload({ key: "not an object" }) },
    { name: "an empty key prefix", accepted: false, payload: issuePayloadWithKey({ keyPrefix: "" }) },
    { name: "a whitespace-only key prefix", accepted: false, payload: issuePayloadWithKey({ keyPrefix: "   " }) },
    { name: "an empty masked token", accepted: false, payload: issuePayloadWithKey({ maskedToken: "" }) },
    { name: "a whitespace-only masked token", accepted: false, payload: issuePayloadWithKey({ maskedToken: "   " }) },
    { name: "an escalated tier", accepted: false, payload: issuePayloadWithKey({ tier: "admin" }) },
    { name: "an internal traffic class", accepted: false, payload: issuePayloadWithKey({ trafficClass: "site" }) },
    {
      name: "a rate limit above the self-serve allowance",
      accepted: false,
      payload: issuePayloadWithKey({ rateLimitPerMinute: SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE + 1 }),
    },
    {
      name: "a stringified rate limit",
      accepted: false,
      payload: issuePayloadWithKey({ rateLimitPerMinute: String(SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE) }),
    },
    { name: "an absent expiry", accepted: false, payload: issuePayloadWithKey({ expiresAt: undefined }) },
    { name: "a stringified expiry", accepted: false, payload: issuePayloadWithKey({ expiresAt: "123" }) },
    { name: "null", accepted: false, payload: null },
    { name: "array", accepted: false, payload: [] },
    { name: "bare status string", accepted: false, payload: "issued" },
  ])("issue-response acceptance is $accepted for $name", ({ payload, accepted }) => {
    expect(ApiKeySelfServeIssueResponseSchema.safeParse(payload).success).toBe(accepted);
  });
});

describe("api key self-serve requests", () => {
  it("posts the submitted fields as a JSON body to the request endpoint", async () => {
    const body = { status: "pending_verification", message: "Check your email." };
    const fetchSpy = mockFetch([{ match: "/api/api-key-requests", body }], { requireMatch: true });

    await expect(submitApiKeyRequest(requestBody())).resolves.toEqual(body);

    const history = fetchSpy.getHistory();
    expect(history).toHaveLength(1);
    expect(new URL(history[0].url).pathname).toBe("/api/api-key-requests");
    expect(history[0].method).toBe("POST");
    expect(history[0].headers["content-type"]).toContain("application/json");
    expect(JSON.parse(history[0].body ?? "null")).toEqual(requestBody());
  });

  it("sends exactly the supplied token to the verification endpoint", async () => {
    const body = issuePayload();
    const fetchSpy = mockFetch([{ match: "/api/api-key-requests/verify", body }], { requireMatch: true });

    await expect(verifyApiKeyRequestToken("akv_token")).resolves.toEqual(body);

    const history = fetchSpy.getHistory();
    expect(history).toHaveLength(1);
    expect(new URL(history[0].url).pathname).toBe("/api/api-key-requests/verify");
    expect(history[0].method).toBe("POST");
    expect(JSON.parse(history[0].body ?? "null")).toEqual({ token: "akv_token" });
  });

  it("preserves error JSON body messages from failed submissions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "Please use a longer use case." }, 400),
    );

    await expect(submitApiKeyRequest(requestBody())).rejects.toThrow("Please use a longer use case.");
  });

  it("preserves message fields from failed verification responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ message: "Verification link expired." }, 410),
    );

    await expect(verifyApiKeyRequestToken("akv_expired")).rejects.toThrow("Verification link expired.");
  });

  it("falls back to status text when an error JSON body carries a status field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ status: "blocked", error: "Blocked request." }, 403),
    );

    await expect(submitApiKeyRequest(requestBody())).rejects.toThrow("Request failed with status 403");
  });

  it("rejects malformed success bodies with the operator-facing message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(issuePayloadWithKey({ rateLimitPerMinute: SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE + 1 })),
    );

    // Schema validation rejects the payload; the verify path maps it to the
    // legacy support-facing copy so the form never shows raw schema errors.
    await expect(verifyApiKeyRequestToken("akv_token")).rejects.toThrow("API key was not returned");
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
      message: `API request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);

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

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKeySelfServeRequestAdminListResponse, ApiKeySelfServeRequestAdminSummary } from "@shared/types";

const { useApiKeyRequestsMock } = vi.hoisted(() => ({
  useApiKeyRequestsMock: vi.fn(),
}));

vi.mock("@/hooks/use-api-key-requests", () => ({
  useApiKeyRequests: useApiKeyRequestsMock,
}));

const { ApiKeyRequestsPanel } = await import("../api-key-requests-panel");

const GENERATED_AT = 1_700_000_000;

function makeRequest(overrides: Partial<ApiKeySelfServeRequestAdminSummary> = {}): ApiKeySelfServeRequestAdminSummary {
  return {
    requestId: overrides.requestId ?? "akr_hidden_durable_id",
    status: overrides.status ?? "pending_verification",
    email: overrides.email ?? "requester@example.com",
    requesterName: overrides.requesterName ?? "Requester",
    organization: overrides.organization ?? "Integration Lab",
    projectUrl: overrides.projectUrl ?? "https://example.com",
    useCase: overrides.useCase ?? "Read-only analytics workflow for monitored stablecoin data.",
    intendedEndpoints: overrides.intendedEndpoints ?? ["/api/stablecoins"],
    expectedCadence: overrides.expectedCadence ?? "hourly",
    expectedVolume: overrides.expectedVolume ?? "100 requests/day",
    acceptedTerms: overrides.acceptedTerms ?? true,
    emailVerified: overrides.emailVerified ?? false,
    linkedKeyId: overrides.linkedKeyId ?? null,
    linkedKeyPrefix: overrides.linkedKeyPrefix ?? null,
    linkedKeyActive: overrides.linkedKeyActive ?? null,
    linkedKeyExpiresAt: overrides.linkedKeyExpiresAt ?? null,
    rateLimitPerMinute: overrides.rateLimitPerMinute ?? 30,
    selfServeExpiresAt: overrides.selfServeExpiresAt ?? null,
    riskScore: overrides.riskScore ?? 0,
    riskReasons: overrides.riskReasons ?? [],
    claimStatus: overrides.claimStatus ?? "pending_verification",
    verificationSentAt: overrides.verificationSentAt ?? GENERATED_AT - 60,
    verificationExpiresAt: overrides.verificationExpiresAt ?? GENERATED_AT + 1800,
    issuedAt: overrides.issuedAt ?? null,
    rejectedAt: overrides.rejectedAt ?? null,
    createdAt: overrides.createdAt ?? GENERATED_AT - 120,
    updatedAt: overrides.updatedAt ?? GENERATED_AT - 60,
  };
}

function renderPanel(
  requests: ApiKeySelfServeRequestAdminSummary[] = [makeRequest()],
  refetch = vi.fn().mockResolvedValue(undefined),
) {
  const data: ApiKeySelfServeRequestAdminListResponse = {
    generatedAt: GENERATED_AT,
    requests,
  };
  useApiKeyRequestsMock.mockReturnValue({
    data,
    error: null,
    isLoading: false,
    isFetching: false,
    refetch,
  });
  render(<ApiKeyRequestsPanel />);
  return { refetch };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ApiKeyRequestsPanel", () => {
  it("uses server-side status and limit query options", () => {
    renderPanel();

    expect(useApiKeyRequestsMock).toHaveBeenLastCalledWith({ status: undefined, limit: 50 });

    fireEvent.click(screen.getByRole("button", { name: "Pending" }));

    expect(useApiKeyRequestsMock).toHaveBeenLastCalledWith({ status: "pending_verification", limit: 50 });
  });

  it("does not render durable request ids in the admin cards or notices", async () => {
    const request = makeRequest({ requestId: "akr_do_not_show" });
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("prompt", vi.fn(() => "abuse review"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      requestId: request.requestId,
      status: "rejected",
      claimStatus: "released",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    renderPanel([request]);

    expect(screen.queryByText(request.requestId)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => {
      expect(screen.getByText("Request marked rejected; claim released.")).toBeTruthy();
    });
    expect(screen.queryByText(request.requestId)).toBeNull();
  });

  it("requires confirmation and sends reason plus idempotency header for mutations", async () => {
    const request = makeRequest({ requestId: "akr_mutation_target" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      requestId: request.requestId,
      status: "rejected",
      claimStatus: "released",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("prompt", vi.fn(() => "manual abuse review"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "uuid-for-test" });

    renderPanel([request]);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("X-Pharos-Admin")).toBe("1");
    expect(headers.get("Idempotency-Key")).toBe("api-key-request:reject:akr_mutation_target:uuid-for-test");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ reason: "manual abuse review" });
  });
});

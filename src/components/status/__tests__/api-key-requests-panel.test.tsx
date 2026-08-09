// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKeySelfServeRequestAdminListResponse, ApiKeySelfServeRequestAdminSummary } from "@shared/types";
import { buildAdminMutationReceiptMetadata } from "../admin-mutation-feedback";
import type { AdminMutationIntentExecution } from "../admin-mutation-intent";

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
  it("serializes successful receipts without retaining response bodies or raw output", () => {
    const secret = "ph_live_one_time_secret";
    const execution = {
      httpStatus: 201,
      idempotentReplay: false,
      executionCertainty: "confirmed",
      idempotencyKey: "intent-key",
      data: { token: secret },
      output: JSON.stringify({ token: secret }),
    } as AdminMutationIntentExecution;

    const receipt = buildAdminMutationReceiptMetadata(execution);
    const serialized = JSON.stringify(receipt);

    expect(receipt).toEqual({
      httpStatus: 201,
      idempotentReplay: false,
      executionCertainty: "confirmed",
      idempotencyKey: "intent-key",
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("data");
    expect(serialized).not.toContain("output");
  });

  it("uses server-side status and limit query options", () => {
    renderPanel();

    expect(useApiKeyRequestsMock).toHaveBeenLastCalledWith({ status: "pending_verification", limit: 50 });
    expect(screen.getByRole("button", { name: "Pending" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "All" }));

    expect(useApiKeyRequestsMock).toHaveBeenLastCalledWith({ status: undefined, limit: 50 });
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("returns focus to the request action when confirmation is cancelled", async () => {
    renderPanel();
    const trigger = screen.getByRole("button", { name: "Reject pending request" });
    trigger.focus();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.className).toContain("min-h-11");
  });

  it("renders triage summary and request-level next action guidance", () => {
    renderPanel([
      makeRequest(),
      makeRequest({
        requestId: "akr_issued_cleanup",
        status: "issued",
        claimStatus: "issued",
        linkedKeyActive: false,
        linkedKeyExpiresAt: GENERATED_AT - 60,
        issuedAt: GENERATED_AT - 30,
      }),
    ]);

    const summary = screen.getByLabelText("Request triage summary");
    expect(within(summary).getByText("Displayed")).toBeTruthy();
    expect(within(summary).getByText("Claim cleanup")).toBeTruthy();
    expect(within(summary).getByText("safe to release")).toBeTruthy();
    expect(screen.getByText(/Waiting on email verification/i)).toBeTruthy();
    expect(screen.getByText(/Release the stale claim to unblock a future self-serve request/i)).toBeTruthy();
    expect((screen.getAllByRole("button", { name: "Release stale claim" })[0] as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getAllByRole("button", { name: "Release stale claim" })[1] as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("wraps hostile project values within narrow request cards", () => {
    const projectUrl = `https://example.invalid/${"unbroken-project-segment".repeat(10)}`;
    renderPanel([makeRequest({ projectUrl })]);

    const projectValue = screen.getByText(projectUrl);
    expect(projectValue.className).toContain("break-all");
    expect(projectValue.parentElement?.className).toContain("min-w-0");
  });

  it("does not render durable request ids in the admin cards or notices", async () => {
    const request = makeRequest({ requestId: "akr_do_not_show" });
    vi.stubGlobal("crypto", { randomUUID: () => "uuid-for-test" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              requestId: request.requestId,
              status: "rejected",
              claimStatus: "released",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );
    renderPanel([request]);

    expect(screen.queryByText(request.requestId)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reject pending request" }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "abuse review" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(screen.getByText("Request marked rejected; claim released.")).toBeTruthy();
    });
    expect(screen.queryByText(request.requestId)).toBeNull();
  });

  it("requires confirmation and sends reason plus idempotency header for mutations", async () => {
    const request = makeRequest({ requestId: "akr_mutation_target" });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          requestId: request.requestId,
          status: "rejected",
          claimStatus: "released",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "uuid-for-test" });

    renderPanel([request]);
    fireEvent.click(screen.getByRole("button", { name: "Reject pending request" }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "manual abuse review" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Pharos-Admin")).toBe("1");
    expect(headers.get("Idempotency-Key")).toBe("api-key-request:reject:akr_mutation_target:uuid-for-test");
    expect(JSON.parse(String(init?.body))).toEqual({ reason: "manual abuse review" });
  });

  it("reconciles an uncertain mutation with the same intent key and reports replay metadata", async () => {
    const request = makeRequest({ requestId: "akr_uncertain_target" });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection closed"))
      .mockImplementationOnce(async (_input, init) => {
        const idempotencyKey = new Headers(init?.headers).get("Idempotency-Key") ?? "";
        return new Response(
          JSON.stringify({
            ok: true,
            requestId: request.requestId,
            status: "rejected",
            claimStatus: "released",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
              "X-Idempotent-Replay": "true",
              "X-Execution-Certainty": "confirmed",
            },
          },
        );
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "uncertain-uuid" });
    renderPanel([request]);

    fireEvent.click(screen.getByRole("button", { name: "Reject pending request" }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "manual abuse review" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await screen.findByText("Outcome unknown");
    fireEvent.click(screen.getByRole("button", { name: "Retry same intent" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const firstKey = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Idempotency-Key");
    const secondKey = new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Idempotency-Key");
    expect(secondKey).toBe(firstKey);
    expect(await screen.findByText("Request marked rejected; claim released.")).toBeTruthy();
    expect(screen.getByText(/replay yes · certainty confirmed/)).toBeTruthy();
  });

  it("labels issued-key rejection and stale claim release by their effect", async () => {
    const request = makeRequest({
      requestId: "akr_release_target",
      status: "issued",
      linkedKeyActive: true,
      linkedKeyExpiresAt: GENERATED_AT + 3600,
      claimStatus: "issued",
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          requestId: request.requestId,
          status: "issued",
          claimStatus: "released",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "uuid-for-release-test" });

    renderPanel([request]);

    expect(screen.getByRole("button", { name: "Reject + deactivate key" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Release stale claim" }) as HTMLButtonElement).disabled).toBe(true);

    useApiKeyRequestsMock.mockReturnValue({
      data: {
        generatedAt: GENERATED_AT,
        requests: [
          {
            ...request,
            linkedKeyActive: false,
          },
        ],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    });

    cleanup();
    render(<ApiKeyRequestsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Release stale claim" }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "inactive key cleanup" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(String(url)).toContain("/api/admin/api-key-requests-admin/akr_release_target/release-claim");
    expect(headers.get("Idempotency-Key")).toBe(
      "api-key-request:release-claim:akr_release_target:uuid-for-release-test",
    );
    expect(JSON.parse(String(init?.body))).toEqual({ reason: "inactive key cleanup" });
  });

  it("announces admin list fetch failures as alerts", () => {
    useApiKeyRequestsMock.mockReturnValue({
      data: null,
      error: new Error("admin list failed"),
      isLoading: false,
      isFetching: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    });

    render(<ApiKeyRequestsPanel />);

    expect(screen.getByRole("alert").textContent).toContain("admin list failed");
  });
});

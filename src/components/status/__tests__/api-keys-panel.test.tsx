// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ApiKeyListResponse, ApiKeySummary } from "@shared/types";

const { useApiKeysMock } = vi.hoisted(() => ({
  useApiKeysMock: vi.fn(),
}));

vi.mock("@/hooks/use-api-keys", () => ({
  useApiKeys: useApiKeysMock,
}));

const { ApiKeysPanel } = await import("../api-keys-panel");

const GENERATED_AT = 1_700_000_000;

function makeKey(overrides: Partial<ApiKeySummary> = {}): ApiKeySummary {
  return {
    id: overrides.id ?? 1,
    keyPrefix: overrides.keyPrefix ?? "0123456789abcdef",
    maskedToken: overrides.maskedToken ?? "ph_live_0123456789abcdef_********",
    name: overrides.name ?? "Ops Key",
    ownerEmail: overrides.ownerEmail ?? "ops@pharos.watch",
    tier: overrides.tier ?? "standard",
    trafficClass: overrides.trafficClass ?? "external",
    rateLimitPerMinute: overrides.rateLimitPerMinute ?? 120,
    isActive: overrides.isActive ?? true,
    expiresAt: overrides.expiresAt === undefined ? GENERATED_AT + (14 * 24 * 60 * 60) : overrides.expiresAt,
    createdAt: overrides.createdAt ?? GENERATED_AT - 100,
    updatedAt: overrides.updatedAt ?? GENERATED_AT - 50,
    lastUsedAt: overrides.lastUsedAt ?? null,
    lastUsedRoute: overrides.lastUsedRoute ?? null,
  };
}

function renderPanel(keys: ApiKeySummary[], refetch = vi.fn().mockResolvedValue(undefined)) {
  const data: ApiKeyListResponse = {
    generatedAt: GENERATED_AT,
    keys,
  };
  useApiKeysMock.mockReturnValue({
    data,
    error: null,
    isLoading: false,
    refetch,
  });
  render(<ApiKeysPanel />);
  return { refetch };
}

function requestIdempotencyKey(callIndex: number): string | null {
  const fetchMock = vi.mocked(fetch);
  const [, init] = fetchMock.mock.calls[callIndex] ?? [];
  return new Headers(init?.headers).get("Idempotency-Key");
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ApiKeysPanel", () => {
  it("represents the default create expiry as omitted expiresAt", async () => {
    const token = "ph_live_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      key: makeKey({ id: 2, name: "Digest Key" }),
      token,
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    const { refetch } = renderPanel([]);

    fireEvent.click(screen.getByRole("button", { name: /create read key/i }));
    expect(screen.getByText(/Default 90 days from creation/i)).toBeTruthy();
    fireEvent.change(screen.getAllByLabelText("Name")[0], { target: { value: "Digest Key" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String((init as RequestInit).body));

    expect(body).not.toHaveProperty("expiresAt");
    expect(requestIdempotencyKey(0)).toBeTruthy();
    expect(await screen.findByText(token)).toBeTruthy();
    await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
  });

  it("renders inventory summary and copy action for one-time tokens", async () => {
    const token = "ph_live_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      key: makeKey({ id: 2, name: "Digest Key" }),
      token,
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));

    renderPanel([
      makeKey({ id: 1, name: "Expired", expiresAt: GENERATED_AT - 3600 }),
      makeKey({ id: 2, name: "Soon", expiresAt: GENERATED_AT + (2 * 24 * 60 * 60) }),
      makeKey({ id: 3, name: "Permanent", expiresAt: null }),
    ]);

    const summary = screen.getByLabelText("API key inventory summary");
    expect(within(summary).getByText("Total keys")).toBeTruthy();
    expect(within(summary).getByText("Expiring soon")).toBeTruthy();
    expect(within(summary).getByText("Non-expiring")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /create read key/i }));
    fireEvent.change(screen.getAllByLabelText("Name")[0], { target: { value: "Digest Key" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    expect(await screen.findByText(token)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(token));
  });

  it("requires explicit token acknowledgement and restores focus to the create trigger", async () => {
    const token = "ph_live_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ key: makeKey({ id: 2, name: "Digest Key" }), token }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderPanel([]);

    const createTrigger = screen.getByRole("button", { name: /create read key/i });
    fireEvent.click(createTrigger);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Digest Key" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await screen.findByRole("dialog");
    const finish = screen.getByRole("button", { name: "Finish" }) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I copied this token/i));
    expect(finish.disabled).toBe(false);
    fireEvent.click(finish);

    await waitFor(() => expect(screen.queryByText(token)).toBeNull());
    expect(document.activeElement).toBe(createTrigger);
  });

  it("coalesces a double create click into one request", async () => {
    const token = "ph_live_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let resolveResponse!: (response: Response) => void;
    const responseGate = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.mocked(fetch).mockReturnValue(responseGate);
    renderPanel([]);

    fireEvent.click(screen.getByRole("button", { name: /create read key/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Digest Key" } });
    const createButton = screen.getByRole("button", { name: /create key/i });
    fireEvent.click(createButton);
    fireEvent.click(createButton);

    expect(fetchMock).toHaveBeenCalledOnce();
    resolveResponse(
      new Response(JSON.stringify({ key: makeKey({ id: 2, name: "Digest Key" }), token }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await screen.findByText(token)).toBeTruthy();
  });

  it("retries an uncertain create with the same key and routes a redacted replay to recovery", async () => {
    const fetchMock = vi
      .mocked(fetch)
      .mockRejectedValueOnce(new TypeError("connection closed"))
      .mockImplementationOnce(async (_input, init) => {
        const idempotencyKey = new Headers(init?.headers).get("Idempotency-Key") ?? "";
        return new Response(
          JSON.stringify({
            key: makeKey({ id: 2, name: "Digest Key" }),
            tokenUnavailableOnReplay: true,
            recovery: "Rotate the identified API key to issue a new token.",
          }),
          {
            status: 201,
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
              "X-Idempotent-Replay": "true",
            },
          },
        );
      });
    renderPanel([]);

    fireEvent.click(screen.getByRole("button", { name: /create read key/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Digest Key" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await screen.findByText("Outcome unknown");
    const originalKey = requestIdempotencyKey(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry same intent" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(requestIdempotencyKey(1)).toBe(originalKey);
    expect(await screen.findByRole("heading", { name: /confirmed; token unavailable/i })).toBeTruthy();
    expect(screen.getByText(/replay yes/i)).toBeTruthy();
  });

  it("opens focused recovery when a successful replay cannot return the one-time token", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      key: makeKey({ id: 2, name: "Digest Key" }),
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    const { refetch } = renderPanel([]);

    fireEvent.click(screen.getByRole("button", { name: /create read key/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Digest Key" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: /Created Digest Key confirmed; token unavailable/i })).toBeTruthy();
    expect(screen.getByText(/plaintext token was not returned/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Rotate Digest Key \(ID 2\) now/i })).toBeTruthy();
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("sends explicit null for a non-expiring create exception", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      key: makeKey({ id: 3, name: "Permanent", expiresAt: null }),
      token: "ph_live_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));

    renderPanel([]);

    fireEvent.click(screen.getByRole("button", { name: /create read key/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Permanent" } });
    fireEvent.change(screen.getByLabelText("Expiry Policy"), { target: { value: "non-expiring" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String((init as RequestInit).body));

    expect(body.expiresAt).toBeNull();
  });

  it("converts custom expiry inputs to epoch seconds on save", async () => {
    const expectedEpoch = Math.floor(new Date(2026, 3, 10, 12, 30, 0, 0).getTime() / 1000);
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      key: makeKey({ expiresAt: expectedEpoch }),
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    renderPanel([makeKey()]);

    fireEvent.click(screen.getByRole("button", { name: /^Edit Ops Key/ }));
    fireEvent.change(screen.getByLabelText("Expires At"), { target: { value: "2026-04-10T12:30" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save changes to Ops Key/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String((init as RequestInit).body));

    expect(body.expiresAt).toBe(expectedEpoch);
    expect(requestIdempotencyKey(0)).toBeTruthy();
  });

  it("confirms rotate and deactivate with exact object effects and unique accessible names", async () => {
    const first = makeKey({ id: 1, name: "Ops Key" });
    const second = makeKey({
      id: 2,
      name: "Digest Key",
      keyPrefix: "fedcba9876543210",
      maskedToken: "ph_live_fedcba9876543210_********",
    });
    const token = "ph_live_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const fetchMock = vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ key: first, token }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderPanel([first, second]);

    expect(screen.getByRole("button", { name: /^Rotate Ops Key .*ID 1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Rotate Digest Key .*ID 2/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Deactivate Ops Key .*ID 1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Deactivate Digest Key .*ID 2/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Rotate Ops Key .*ID 1/ }));
    expect(screen.getByText(/Replaces the secret and prefix immediately/i)).toBeTruthy();
    expect(screen.getByText(/If it is lost, rotate again/i)).toBeTruthy();
    expect(screen.getByText(/High.*live credential mutation/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Confirm rotate of Ops Key \(ID 1\)/i }));

    expect(await screen.findByText(token)).toBeTruthy();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/api-keys/1/rotate");
    expect(requestIdempotencyKey(0)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/intentionally dismissing this token/i));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss token" }));
    fireEvent.click(screen.getByRole("button", { name: /^Deactivate Ops Key .*ID 1/ }));
    expect(screen.getByText(/Sets this key inactive immediately/i)).toBeTruthy();
    expect(screen.getByText(/Set isActive=true through the audited API-key update endpoint/i)).toBeTruthy();
    expect(screen.getByText(/Moderate.*live credential mutation/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Confirm deactivate of Ops Key \(ID 1\)/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/admin/api-keys/1/deactivate");
    expect(requestIdempotencyKey(1)).toBeTruthy();
  });

  it("reconciles an uncertain rotation with the same key and opens exact-key recovery", async () => {
    const apiKey = makeKey();
    const fetchMock = vi
      .mocked(fetch)
      .mockRejectedValueOnce(new TypeError("connection closed"))
      .mockImplementationOnce(async (_input, init) => {
        const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
        return new Response(
          JSON.stringify({
            key: apiKey,
            tokenUnavailableOnReplay: true,
            recovery: "Rotate the identified API key to issue a new token.",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": key,
              "X-Idempotent-Replay": "true",
            },
          },
        );
      });
    renderPanel([apiKey]);

    fireEvent.click(screen.getByRole("button", { name: /^Rotate Ops Key/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm rotate of Ops Key/i }));
    await screen.findByText("Outcome unknown");
    const originalKey = requestIdempotencyKey(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry same intent" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(requestIdempotencyKey(1)).toBe(originalKey);
    expect(await screen.findByRole("heading", { name: /Rotated Ops Key confirmed; token unavailable/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rotate Ops Key (ID 1) now" })).toBeTruthy();
  });

  it("retries an uncertain update with its original payload and idempotency key", async () => {
    const updated = makeKey({ tier: "partner" });
    const fetchMock = vi
      .mocked(fetch)
      .mockRejectedValueOnce(new TypeError("connection closed"))
      .mockImplementationOnce(async (_input, init) => {
        const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
        return new Response(JSON.stringify({ key: updated }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
            "X-Idempotent-Replay": "true",
          },
        });
      });
    renderPanel([makeKey()]);

    fireEvent.click(screen.getByRole("button", { name: /^Edit Ops Key/ }));
    fireEvent.change(screen.getByLabelText("Tier"), { target: { value: "partner" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save changes to Ops Key/ }));
    await screen.findByText("Outcome unknown");
    const originalKey = requestIdempotencyKey(0);
    const originalBody = vi.mocked(fetch).mock.calls[0]?.[1]?.body;
    fireEvent.click(screen.getByRole("button", { name: "Retry same intent" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(requestIdempotencyKey(1)).toBe(originalKey);
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.body).toBe(originalBody);
    expect(await screen.findByText("Updated Ops Key.")).toBeTruthy();
  });

  it("shows definite failures separately from uncertain outcomes", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "API key name is invalid" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderPanel([]);

    fireEvent.click(screen.getByRole("button", { name: /create read key/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bad" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    expect(await screen.findByText("Action failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry same intent" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start new create intent" })).toBeTruthy();
  });

  it("offers a local retry when API key inventory loading fails", () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    useApiKeysMock.mockReturnValue({
      data: null,
      error: new Error("inventory unavailable"),
      isLoading: false,
      isFetching: false,
      refetch,
    });
    render(<ApiKeysPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Retry API key inventory" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("renders expired, expiring soon, inactive, and non-expiring states distinctly", () => {
    renderPanel([
      makeKey({ id: 1, name: "Expired", expiresAt: GENERATED_AT - 3600 }),
      makeKey({ id: 2, name: "Soon", expiresAt: GENERATED_AT + (2 * 24 * 60 * 60) }),
      makeKey({ id: 3, name: "Inactive", isActive: false, expiresAt: GENERATED_AT + (30 * 24 * 60 * 60) }),
      makeKey({ id: 4, name: "Permanent", expiresAt: null }),
    ]);

    expect(screen.getByText("expired")).toBeTruthy();
    expect(screen.getByText("expiring soon")).toBeTruthy();
    expect(screen.getByText("inactive")).toBeTruthy();
    expect(screen.getAllByText("non-expiring exception").length).toBeGreaterThan(0);
    expect(screen.getByText(/Expired 1h ago at/i)).toBeTruthy();
  });
});

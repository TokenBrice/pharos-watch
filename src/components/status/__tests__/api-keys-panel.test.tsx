// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApiKeyListResponse, ApiKeySummary } from "@shared/types";

const { useApiKeysMock } = vi.hoisted(() => ({
  useApiKeysMock: vi.fn(),
}));

vi.mock("@/hooks/use-api-keys", () => ({
  useApiKeys: useApiKeysMock,
}));

const { ApiKeysPanel } = await import("../api-keys-panel");

const ADMIN_ACCESS = "ops-proxy" as const;
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
  render(<ApiKeysPanel adminAccess={ADMIN_ACCESS} />);
  return { refetch };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ApiKeysPanel", () => {
  it("represents the default create expiry as omitted expiresAt", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      key: makeKey({ id: 2, name: "Digest Key" }),
      token: "ph_live_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    const { refetch } = renderPanel([]);

    expect(screen.getByText(/Default 90 days from creation/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Digest Key" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String((init as RequestInit).body));

    expect(body).not.toHaveProperty("expiresAt");
    await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
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

    fireEvent.change(screen.getByLabelText("Expires At"), { target: { value: "2026-04-10T12:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String((init as RequestInit).body));

    expect(body.expiresAt).toBe(expectedEpoch);
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

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ApiKeyListResponse, ApiKeySummary } from "@shared/types";

const { useApiKeysMock, useApiKeyAuditLogMock } = vi.hoisted(() => ({
  useApiKeysMock: vi.fn(),
  useApiKeyAuditLogMock: vi.fn(),
}));

vi.mock("@/hooks/use-api-keys", () => ({
  useApiKeys: useApiKeysMock,
}));

vi.mock("@/hooks/use-api-key-audit-log", () => ({
  useApiKeyAuditLog: useApiKeyAuditLogMock,
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
    expiresAt: overrides.expiresAt === undefined ? GENERATED_AT + 2 * 24 * 60 * 60 : overrides.expiresAt,
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
  useApiKeyAuditLogMock.mockReturnValue({
    data: { entries: [] },
    error: null,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ApiKeysPanel", () => {
  it("represents the default create expiry as omitted expiresAt", async () => {
    const token = "ph_live_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const fetchMock = vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          key: makeKey({ id: 2, name: "Digest Key" }),
          token,
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
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
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          key: makeKey({ id: 2, name: "Digest Key" }),
          token,
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    renderPanel([
      makeKey({ id: 1, name: "Expired", expiresAt: GENERATED_AT - 3600 }),
      makeKey({ id: 2, name: "Soon", expiresAt: GENERATED_AT + 2 * 24 * 60 * 60 }),
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
    const copy = screen.getByRole("button", { name: "Copy to clipboard" });
    expect(copy.className).toContain("size-11");
    fireEvent.click(copy);

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
    const fetchMock = vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          key: makeKey({ id: 2, name: "Digest Key" }),
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const { refetch } = renderPanel([]);

    fireEvent.click(screen.getByRole("button", { name: /create read key/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Digest Key" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(
      await screen.findByRole("heading", { name: /Created Digest Key confirmed; token unavailable/i }),
    ).toBeTruthy();
    expect(screen.getByText(/plaintext token was not returned/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Rotate Digest Key \(ID 2\) now/i })).toBeTruthy();
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("sends explicit null for a non-expiring create exception", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          key: makeKey({ id: 3, name: "Permanent", expiresAt: null }),
          token: "ph_live_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

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
    const fetchMock = vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          key: makeKey({ expiresAt: expectedEpoch }),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

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
      makeKey({ id: 2, name: "Soon", expiresAt: GENERATED_AT + 2 * 24 * 60 * 60 }),
      makeKey({ id: 3, name: "Inactive", isActive: false, expiresAt: GENERATED_AT + 30 * 24 * 60 * 60 }),
      makeKey({ id: 4, name: "Permanent", expiresAt: null }),
    ]);

    expect(screen.getByText("expired")).toBeTruthy();
    expect(screen.getByText("expiring soon")).toBeTruthy();
    expect(screen.getByText("inactive")).toBeTruthy();
    expect(screen.getAllByText("non-expiring exception").length).toBeGreaterThan(0);
    expect(screen.getByText(/Expired 1h ago at/i)).toBeTruthy();
  });

  it("defaults to the attention queue and searches every operator-facing identity field", () => {
    renderPanel([
      makeKey({ id: 1, name: "Routine Active", expiresAt: GENERATED_AT + 30 * 24 * 60 * 60 }),
      makeKey({
        id: 2,
        name: "Route Beacon",
        ownerEmail: "beacon@example.invalid",
        keyPrefix: "beacon-prefix",
        maskedToken: "ph_live_beacon-prefix_********",
        tier: "priority",
        lastUsedRoute: "/api/beacon/latest",
      }),
    ]);

    expect(screen.queryByText("Routine Active")).toBeNull();
    expect(screen.getByText("Route Beacon")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "beacon@example.invalid latest" } });
    expect(screen.getByText("Route Beacon")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "beacon-prefix priority" } });
    expect(screen.getByText("Route Beacon")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "" } });
    expect(screen.getByText("Routine Active")).toBeTruthy();
  });

  it("combines expiration, owner, tier, and traffic filters and resets to attention", () => {
    renderPanel([
      makeKey({
        id: 1,
        name: "Priority External",
        ownerEmail: "priority@example.invalid",
        tier: "priority",
        trafficClass: "external",
      }),
      makeKey({
        id: 2,
        name: "Standard Site",
        ownerEmail: "site@example.invalid",
        tier: "standard",
        trafficClass: "site",
        expiresAt: GENERATED_AT + 20 * 24 * 60 * 60,
        isActive: false,
      }),
      makeKey({ id: 3, name: "Unassigned", ownerEmail: null, expiresAt: null }),
    ]);

    fireEvent.change(screen.getByLabelText("Expiration"), { target: { value: "next-7-days" } });
    expect(screen.getByText("Priority External")).toBeTruthy();
    expect(screen.queryByText("Standard Site")).toBeNull();

    fireEvent.change(screen.getByLabelText("Owner filter"), { target: { value: "priority@example.invalid" } });
    fireEvent.change(screen.getByLabelText("Tier filter"), { target: { value: "priority" } });
    fireEvent.change(screen.getByLabelText("Traffic filter"), { target: { value: "external" } });
    expect(screen.getByText("Priority External")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    expect(screen.getByText("Standard Site")).toBeTruthy();
    expect(screen.getByText("Unassigned")).toBeTruthy();
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("attention");
  });

  it("sorts deterministically and paginates inventories larger than 25 rows", () => {
    const keys = Array.from({ length: 30 }, (_, index) =>
      makeKey({
        id: index + 1,
        name: `Key ${String(index + 1).padStart(2, "0")}`,
        isActive: false,
        keyPrefix: `prefix-${index + 1}`,
        maskedToken: `ph_live_prefix-${index + 1}_********`,
      }),
    );
    renderPanel(keys);

    expect(screen.getByText("Key 01")).toBeTruthy();
    expect(screen.queryByText("Key 26")).toBeNull();
    expect(screen.getByRole("navigation", { name: "API key inventory pagination" }).textContent).toContain(
      "Showing 1-25 of 30 matching keys",
    );

    fireEvent.click(screen.getByRole("button", { name: "Go to next API key page" }));
    expect(screen.getByText("Key 26")).toBeTruthy();
    expect(screen.queryByText("Key 01")).toBeNull();

    fireEvent.change(screen.getByLabelText("Rows"), { target: { value: "50" } });
    expect(screen.getByText("Key 01")).toBeTruthy();
    expect(screen.getByText("Key 30")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "name" } });
    fireEvent.click(screen.getByRole("button", { name: "Sort descending" }));
    const tableRows = within(screen.getByRole("table", { name: "API key inventory" }))
      .getAllByRole("row")
      .slice(1);
    expect(within(tableRows[0]).getByText("Key 30")).toBeTruthy();
  });

  it("mounts one focused selected-key editor with selected disclosure semantics and audit history", async () => {
    useApiKeyAuditLogMock.mockReturnValue({
      data: {
        entries: [
          {
            id: 91,
            apiKeyId: 1,
            action: "rotated",
            actor: "admin",
            detail: { source: "operator" },
            createdAt: GENERATED_AT - 60,
          },
        ],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    });
    renderPanel([
      makeKey(),
      makeKey({ id: 2, name: "Digest Key", keyPrefix: "digest", maskedToken: "ph_live_digest_********" }),
    ]);

    const inventoryShell = screen.getByTestId("api-keys-table");
    expect(inventoryShell.className).toContain("table-header-sticky");
    const viewport = inventoryShell.querySelector('[data-slot="table-viewport"]');
    expect(viewport?.className).toContain("overflow-x-auto");
    expect(viewport?.className).toContain("overflow-y-auto");
    expect(screen.getByRole("columnheader", { name: "Actions" }).className).toContain("sticky");

    const opsEdit = screen.getByRole("button", { name: /^Edit Ops Key/ });
    expect(opsEdit.hasAttribute("aria-controls")).toBe(false);
    fireEvent.click(opsEdit);
    const opsRegion = screen.getByRole("region", { name: "Ops Key" });
    await waitFor(() => expect(document.activeElement).toBe(opsRegion));
    expect(opsEdit.getAttribute("aria-expanded")).toBe("true");
    expect(opsEdit.getAttribute("aria-controls")).toBe("api-key-detail-panel-1");
    expect(opsEdit.closest("tr")?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Audit history" })).toBeTruthy();
    expect(screen.getByText("Rotated")).toBeTruthy();
    expect(screen.getByText("Actor: admin")).toBeTruthy();

    const digestEdit = screen.getByRole("button", { name: /^Edit Digest Key/ });
    fireEvent.click(digestEdit);
    expect(screen.queryByRole("heading", { name: "Ops Key" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Digest Key" })).toBeTruthy();
    expect(screen.getAllByLabelText("Tier")).toHaveLength(1);
    expect(useApiKeyAuditLogMock).toHaveBeenLastCalledWith(2);

    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(document.activeElement).toBe(digestEdit));
  });

  it("shows audit loading and unavailable states with a local retry", async () => {
    const retryAudit = vi.fn().mockResolvedValue(undefined);
    useApiKeyAuditLogMock.mockReturnValue({
      data: undefined,
      error: new Error("audit store unavailable"),
      isLoading: false,
      isFetching: false,
      refetch: retryAudit,
    });
    renderPanel([makeKey()]);

    fireEvent.click(screen.getByRole("button", { name: /^Edit Ops Key/ }));
    expect(screen.getByText("Audit history unavailable")).toBeTruthy();
    expect(screen.getByText("audit store unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry audit history" }));
    expect(retryAudit).toHaveBeenCalledOnce();

    cleanup();
    useApiKeyAuditLogMock.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
      isFetching: true,
      refetch: retryAudit,
    });
    renderPanel([makeKey({ id: 2, name: "Loading Key" })]);
    fireEvent.click(screen.getByRole("button", { name: /^Edit Loading Key/ }));
    expect(screen.getByText("Loading audit history...")).toBeTruthy();
  });
});

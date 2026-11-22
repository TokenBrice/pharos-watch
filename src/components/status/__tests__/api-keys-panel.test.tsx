// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  GENERATED_AT, ONE_TIME_TOKEN, getApiKeyAuditLogMock, keyResponse,
  makeKey, renderPanel, requestIdempotencyKey, setAuditLog,
} from "./api-keys-panel-harness";

const btn = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const clickBtn = (name: string | RegExp) => fireEvent.click(btn(name));
const jsonResp = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function openCreateAndSubmit(name = "Digest Key", configure?: () => void) {
  const trigger = btn(/create read key/i);
  fireEvent.click(trigger);
  fireEvent.change(screen.getAllByLabelText("Name")[0], { target: { value: name } });
  configure?.();
  clickBtn(/create key/i);
  return trigger;
}

function mockUncertainReplay(body: unknown) {
  return vi.mocked(fetch)
    .mockRejectedValueOnce(new TypeError("connection closed"))
    .mockImplementationOnce(async (_input, init) =>
      jsonResp(body, 200, { "Idempotency-Key": new Headers(init?.headers).get("Idempotency-Key") ?? "", "X-Idempotent-Replay": "true" }),
    );
}

describe("ApiKeysPanel create and token recovery", () => {
  it("represents default create expiry as omitted expiresAt and requires explicit token acknowledgement", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(keyResponse({ key: makeKey({ id: 2, name: "Digest Key" }), token: ONE_TIME_TOKEN }));
    const { refetch } = renderPanel([]);

    const createTrigger = openCreateAndSubmit("Digest Key", () => {
      expect(screen.getByText(/Default 90 days from creation/i)).toBeTruthy();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty("expiresAt");
    expect(requestIdempotencyKey(0)).toBeTruthy();
    expect(await screen.findByText(ONE_TIME_TOKEN)).toBeTruthy();
    await waitFor(() => expect(refetch).toHaveBeenCalledOnce());

    const finish = btn("Finish");
    expect(finish.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I copied this token/i));
    expect(finish.disabled).toBe(false);
    fireEvent.click(finish);
    await waitFor(() => expect(screen.queryByText(ONE_TIME_TOKEN)).toBeNull());
    expect(document.activeElement).toBe(createTrigger);
  });

  it("coalesces a double create click into one request", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.mocked(fetch).mockReturnValue(new Promise<Response>((r) => { resolveResponse = r; }));
    renderPanel([]);
    clickBtn(/create read key/i);
    fireEvent.change(screen.getAllByLabelText("Name")[0], { target: { value: "Digest Key" } });
    const createButton = btn(/create key/i);
    fireEvent.click(createButton);
    fireEvent.click(createButton);
    expect(fetchMock).toHaveBeenCalledOnce();
    resolveResponse(keyResponse({ key: makeKey({ id: 2, name: "Digest Key" }), token: ONE_TIME_TOKEN }));
    expect(await screen.findByText(ONE_TIME_TOKEN)).toBeTruthy();
  });

  it("retries an uncertain create with the same key and routes a redacted replay to recovery", async () => {
    const fetchMock = mockUncertainReplay({ key: makeKey({ id: 2, name: "Digest Key" }), tokenUnavailableOnReplay: true, recovery: "Rotate the identified API key to issue a new token." });
    renderPanel([]);
    openCreateAndSubmit();
    await screen.findByText("Outcome unknown");
    const originalKey = requestIdempotencyKey(0);
    clickBtn("Retry same intent");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(requestIdempotencyKey(1)).toBe(originalKey);
    expect(await screen.findByRole("heading", { name: /confirmed; token unavailable/i })).toBeTruthy();
    expect(screen.getByText(/replay yes/i)).toBeTruthy();
  });

  it("opens focused recovery on missing plaintext token and rotates the recovered key back to the trigger", async () => {
    const recovered = makeKey({ id: 2, name: "Digest Key" });
    const replacementToken = "ph_live_cccccccccccccccc_dddddddddddddddddddddddddddddddd";
    const fetchMock = vi.mocked(fetch)
      .mockResolvedValueOnce(keyResponse({ key: recovered }))
      .mockResolvedValueOnce(keyResponse({ key: recovered, token: replacementToken }, { status: 200 }));
    const { refetch } = renderPanel([makeKey({ id: 9, name: "Unrelated Key" })]);

    const createTrigger = openCreateAndSubmit();
    expect(await screen.findByRole("heading", { name: /Created Digest Key confirmed; token unavailable/i })).toBeTruthy();
    expect(screen.getByText(/plaintext token was not returned/i)).toBeTruthy();
    expect(refetch).toHaveBeenCalledOnce();

    fireEvent.click(await screen.findByRole("button", { name: /Rotate Digest Key \(ID 2\) now/i }));
    clickBtn(/Confirm rotate of Digest Key \(ID 2\)/i);
    expect(await screen.findByText(replacementToken)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/admin/api-keys/2/rotate");

    fireEvent.click(screen.getByLabelText(/I copied this token/i));
    clickBtn("Finish");
    await waitFor(() => expect(screen.queryByText(replacementToken)).toBeNull());
    expect(document.activeElement).toBe(createTrigger);
  });

  it("sends explicit null for non-expiring creates and applies commercial/institutional presets", async () => {
    const fetchMock = vi.mocked(fetch)
      .mockResolvedValueOnce(keyResponse({ key: makeKey({ id: 3, name: "Permanent", expiresAt: null }), token: ONE_TIME_TOKEN }))
      .mockResolvedValueOnce(keyResponse({ key: makeKey({ id: 4, name: "Commercial Key", plan: "commercial" }), token: ONE_TIME_TOKEN }));
    renderPanel([]);

    openCreateAndSubmit("Permanent", () => fireEvent.change(screen.getByLabelText("Expiry Policy"), { target: { value: "non-expiring" } }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).expiresAt).toBeNull();
    cleanup();

    renderPanel([]);
    openCreateAndSubmit("Commercial Key", () => {
      clickBtn("Commercial");
      expect((screen.getByLabelText("Plan") as HTMLSelectElement).value).toBe("commercial");
      clickBtn("Institutional");
      expect((screen.getByLabelText("Plan") as HTMLSelectElement).value).toBe("institutional");
      expect((screen.getByLabelText("Rate Limit / Minute") as HTMLInputElement).value).toBe("600");
      clickBtn("Commercial");
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ tier: "standard", plan: "commercial", rateLimitPerMinute: 120, monthlyRequestQuota: null });
  });

  it("shows and filters the Plan unset badge for standard keys without a plan", () => {
    renderPanel([
      makeKey({ id: 1, name: "Legacy Partner", tier: "standard", plan: null }),
      makeKey({ id: 2, name: "Commercial Desk", tier: "standard", plan: "commercial" }),
      makeKey({ id: 3, name: "Supporter Wallet", tier: "donor", plan: null, expiresAt: null }),
    ]);
    const table = within(screen.getByRole("table"));
    expect(table.getAllByText("Plan unset")).toHaveLength(1);
    expect(table.getByText("commercial")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Plan filter"), { target: { value: "__unset__" } });
    expect(screen.getByText("Legacy Partner")).toBeTruthy();
    expect(screen.queryByText(/Commercial Desk|Supporter Wallet/)).toBeNull();
  });
});

describe("ApiKeysPanel lifecycle mutations", () => {
  it("converts custom expiry inputs to epoch seconds on save", async () => {
    const expectedEpoch = Math.floor(new Date(2026, 3, 10, 12, 30, 0, 0).getTime() / 1000);
    const fetchMock = vi.mocked(fetch).mockResolvedValue(jsonResp({ key: makeKey({ expiresAt: expectedEpoch }) }));
    renderPanel([makeKey()]);
    clickBtn(/^Edit Ops Key/);
    fireEvent.change(screen.getByLabelText("Expires at"), { target: { value: "2026-04-10T12:30" } });
    clickBtn(/^Save changes to Ops Key/);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).expiresAt).toBe(expectedEpoch);
    expect(requestIdempotencyKey(0)).toBeTruthy();
  });

  it("confirms rotate and deactivate with exact object effects and unique accessible names", async () => {
    const first = makeKey({ id: 1, name: "Ops Key" });
    const second = makeKey({ id: 2, name: "Digest Key", keyPrefix: "digest-prefix", maskedToken: "ph_live_digest-prefix_********" });
    const token = "ph_live_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const fetchMock = vi.mocked(fetch).mockResolvedValue(jsonResp({ key: first, token }));
    renderPanel([first, second]);

    for (const re of [/^Rotate Ops Key .*ID 1/, /^Rotate Digest Key .*ID 2/, /^Deactivate Ops Key .*ID 1/, /^Deactivate Digest Key .*ID 2/]) expect(btn(re)).toBeTruthy();
    clickBtn(/^Rotate Ops Key .*ID 1/);
    expect(screen.getByText(/Replaces the secret and prefix immediately/i)).toBeTruthy();
    expect(screen.getByText(/If it is lost, rotate again/i)).toBeTruthy();
    expect(screen.getByText(/High.*live credential mutation/i)).toBeTruthy();
    clickBtn(/Confirm rotate of Ops Key \(ID 1\)/i);
    expect(await screen.findByText(token)).toBeTruthy();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/api-keys/1/rotate");
    expect(requestIdempotencyKey(0)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/intentionally dismissing this token/i));
    clickBtn("Dismiss token");
    clickBtn(/^Deactivate Ops Key .*ID 1/);
    expect(screen.getByText(/Sets this key inactive immediately/i)).toBeTruthy();
    expect(screen.getByText(/Set isActive=true through the audited API-key update endpoint/i)).toBeTruthy();
    expect(screen.getByText(/Moderate.*live credential mutation/i)).toBeTruthy();
    clickBtn(/Confirm deactivate of Ops Key \(ID 1\)/i);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/admin/api-keys/1/deactivate");
    expect(requestIdempotencyKey(1)).toBeTruthy();
  });

  it("reconciles uncertain rotation and update with the same idempotency key and payload", async () => {
    const apiKey = makeKey();
    const rotMock = mockUncertainReplay({ key: apiKey, tokenUnavailableOnReplay: true, recovery: "Rotate the identified API key to issue a new token." });
    renderPanel([apiKey]);
    clickBtn(/^Rotate Ops Key/);
    clickBtn(/Confirm rotate of Ops Key/i);
    await screen.findByText("Outcome unknown");
    const rotKey = requestIdempotencyKey(0);
    clickBtn("Retry same intent");
    await waitFor(() => expect(rotMock).toHaveBeenCalledTimes(2));
    expect(requestIdempotencyKey(1)).toBe(rotKey);
    expect(await screen.findByRole("heading", { name: /Rotated Ops Key confirmed; token unavailable/i })).toBeTruthy();
    expect(btn("Rotate Ops Key (ID 1) now")).toBeTruthy();
    cleanup();

    vi.mocked(fetch).mockReset();
    const updMock = mockUncertainReplay({ key: makeKey({ tier: "partner" }) });
    renderPanel([makeKey()]);
    clickBtn(/^Edit Ops Key/);
    fireEvent.change(screen.getByLabelText("Tier"), { target: { value: "partner" } });
    clickBtn(/^Save changes to Ops Key/);
    await screen.findByText("Outcome unknown");
    const updKey = requestIdempotencyKey(0);
    const updBody = updMock.mock.calls[0]?.[1]?.body;
    clickBtn("Retry same intent");
    await waitFor(() => expect(updMock).toHaveBeenCalledTimes(2));
    expect([requestIdempotencyKey(1), updMock.mock.calls[1]?.[1]?.body]).toEqual([updKey, updBody]);
    expect(await screen.findByText("Updated Ops Key.")).toBeTruthy();
  });

  it("shows definite failures separately from uncertain outcomes", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResp({ error: "API key name is invalid" }, 400));
    renderPanel([]);
    openCreateAndSubmit("Bad");
    expect(await screen.findByText("Action failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry same intent" })).toBeNull();
    expect(btn("Start new create intent")).toBeTruthy();
  });
});

describe("ApiKeysPanel editor and audit history", () => {
  it("preserves donor tier when renaming and saving a supporter key", async () => {
    const donor = makeKey({ tier: "donor", expiresAt: null });
    const renamed = { ...donor, name: "Renamed supporter" };
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce(keyResponse({ key: renamed }, { status: 200 }));
    renderPanel([donor]);

    clickBtn(/^Edit Ops Key/);
    expect((screen.getByLabelText("Tier") as HTMLSelectElement).value).toBe("donor");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: renamed.name } });
    clickBtn(/^Save changes to Ops Key/);
    expect(await screen.findByText("Updated Renamed supporter.")).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/admin/api-keys/1/update");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: renamed.name, ownerEmail: donor.ownerEmail, tier: "donor", plan: null,
      rateLimitPerMinute: donor.rateLimitPerMinute, monthlyRequestQuota: null, expiresAt: null,
    });
  });

  it("mounts one focused selected-key editor with audit history and handles loading/error states", async () => {
    setAuditLog({ data: { entries: [{ id: 91, apiKeyId: 1, action: "rotated", actor: "admin", detail: { source: "operator" }, createdAt: GENERATED_AT - 60 }] } });
    renderPanel([makeKey(), makeKey({ id: 2, name: "Digest Key", keyPrefix: "digest", maskedToken: "ph_live_digest_********" })]);

    const opsEdit = btn(/^Edit Ops Key/);
    expect(opsEdit.hasAttribute("aria-controls")).toBe(false);
    fireEvent.click(opsEdit);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Ops Key" })));
    expect([opsEdit.getAttribute("aria-expanded"), opsEdit.getAttribute("aria-controls"), opsEdit.closest("tr")?.getAttribute("aria-selected")])
      .toEqual(["true", "api-key-detail-panel-1", "true"]);
    expect(screen.getByRole("heading", { name: "Audit history" })).toBeTruthy();
    expect(screen.getByText("Rotated")).toBeTruthy();
    expect(screen.getByText("Actor: admin")).toBeTruthy();

    const digestEdit = btn(/^Edit Digest Key/);
    fireEvent.click(digestEdit);
    expect(screen.queryByRole("heading", { name: "Ops Key" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Digest Key" })).toBeTruthy();
    expect(screen.getAllByLabelText("Tier")).toHaveLength(1);
    expect(getApiKeyAuditLogMock()).toHaveBeenLastCalledWith(2);

    clickBtn("Close details");
    await waitFor(() => expect(document.activeElement).toBe(digestEdit));
    cleanup();

    const retryAudit = setAuditLog({ error: new Error("audit store unavailable") });
    renderPanel([makeKey()]);
    clickBtn(/^Edit Ops Key/);
    expect(screen.getByText("Audit history unavailable")).toBeTruthy();
    expect(screen.getByText("audit store unavailable")).toBeTruthy();
    clickBtn("Retry audit history");
    expect(retryAudit).toHaveBeenCalledOnce();
    cleanup();

    setAuditLog({ isLoading: true, isFetching: true });
    renderPanel([makeKey({ id: 2, name: "Loading Key" })]);
    clickBtn(/^Edit Loading Key/);
    expect(screen.getByText("Loading audit history...")).toBeTruthy();
  });
});

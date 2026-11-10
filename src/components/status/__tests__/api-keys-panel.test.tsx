// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  GENERATED_AT,
  ONE_TIME_TOKEN,
  getApiKeyAuditLogMock,
  keyResponse,
  makeKey,
  renderPanel,
  requestIdempotencyKey,
  setAuditLog,
} from "./api-keys-panel-harness";

describe("ApiKeysPanel create and token recovery", () => {
  it("represents the default create expiry as omitted expiresAt", async () => {
    const fetchMock = vi
      .mocked(fetch)
      .mockResolvedValue(keyResponse({ key: makeKey({ id: 2, name: "Digest Key" }), token: ONE_TIME_TOKEN }));
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
    expect(await screen.findByText(ONE_TIME_TOKEN)).toBeTruthy();
    await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
  });

  it("requires explicit token acknowledgement and restores focus to the create trigger", async () => {
    vi.mocked(fetch).mockResolvedValue(
      keyResponse({ key: makeKey({ id: 2, name: "Digest Key" }), token: ONE_TIME_TOKEN }),
    );
    renderPanel([]);

    const createTrigger = screen.getByRole("button", { name: /create read key/i });
    fireEvent.click(createTrigger);
    fireEvent.change(screen.getAllByLabelText("Name")[0], { target: { value: "Digest Key" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await screen.findByRole("dialog");
    const finish = screen.getByRole("button", { name: "Finish" }) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I copied this token/i));
    expect(finish.disabled).toBe(false);
    fireEvent.click(finish);

    await waitFor(() => expect(screen.queryByText(ONE_TIME_TOKEN)).toBeNull());
    expect(document.activeElement).toBe(createTrigger);
  });

  it("coalesces a double create click into one request", async () => {
    let resolveResponse!: (response: Response) => void;
    const responseGate = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.mocked(fetch).mockReturnValue(responseGate);
    renderPanel([]);

    fireEvent.click(screen.getByRole("button", { name: /create read key/i }));
    fireEvent.change(screen.getAllByLabelText("Name")[0], { target: { value: "Digest Key" } });
    const createButton = screen.getByRole("button", { name: /create key/i });
    fireEvent.click(createButton);
    fireEvent.click(createButton);

    expect(fetchMock).toHaveBeenCalledOnce();
    resolveResponse(keyResponse({ key: makeKey({ id: 2, name: "Digest Key" }), token: ONE_TIME_TOKEN }));
    expect(await screen.findByText(ONE_TIME_TOKEN)).toBeTruthy();
  });

  it("retries an uncertain create with the same key and routes a redacted replay to recovery", async () => {
    const fetchMock = vi
      .mocked(fetch)
      .mockRejectedValueOnce(new TypeError("connection closed"))
      .mockImplementationOnce(async (_input, init) =>
        keyResponse(
          {
            key: makeKey({ id: 2, name: "Digest Key" }),
            tokenUnavailableOnReplay: true,
            recovery: "Rotate the identified API key to issue a new token.",
          },
          {
            headers: {
              "Idempotency-Key": new Headers(init?.headers).get("Idempotency-Key") ?? "",
              "X-Idempotent-Replay": "true",
            },
          },
        ),
      );
    renderPanel([]);

    fireEvent.click(screen.getByRole("button", { name: /create read key/i }));
    fireEvent.change(screen.getAllByLabelText("Name")[0], { target: { value: "Digest Key" } });
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
    const fetchMock = vi.mocked(fetch).mockResolvedValue(keyResponse({ key: makeKey({ id: 2, name: "Digest Key" }) }));
    const { refetch } = renderPanel([]);

    fireEvent.click(screen.getByRole("button", { name: /create read key/i }));
    fireEvent.change(screen.getAllByLabelText("Name")[0], { target: { value: "Digest Key" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(
      await screen.findByRole("heading", { name: /Created Digest Key confirmed; token unavailable/i }),
    ).toBeTruthy();
    expect(screen.getByText(/plaintext token was not returned/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Rotate Digest Key \(ID 2\) now/i })).toBeTruthy();
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("rotates the recovered key itself and hands the replacement token back to the create trigger", async () => {
    const recovered = makeKey({ id: 2, name: "Digest Key" });
    const replacementToken = "ph_live_cccccccccccccccc_dddddddddddddddddddddddddddddddd";
    const fetchMock = vi
      .mocked(fetch)
      .mockResolvedValueOnce(keyResponse({ key: recovered }))
      .mockResolvedValueOnce(keyResponse({ key: recovered, token: replacementToken }, { status: 200 }));
    renderPanel([makeKey({ id: 9, name: "Unrelated Key" })]);

    const createTrigger = screen.getByRole("button", { name: /create read key/i });
    fireEvent.click(createTrigger);
    fireEvent.change(screen.getAllByLabelText("Name")[0], { target: { value: "Digest Key" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    fireEvent.click(await screen.findByRole("button", { name: /Rotate Digest Key \(ID 2\) now/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm rotate of Digest Key \(ID 2\)/i }));

    expect(await screen.findByText(replacementToken)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/admin/api-keys/2/rotate");

    fireEvent.click(screen.getByLabelText(/I copied this token/i));
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    await waitFor(() => expect(screen.queryByText(replacementToken)).toBeNull());
    expect(document.activeElement).toBe(createTrigger);
  });

  it("sends explicit null for a non-expiring create exception", async () => {
    const fetchMock = vi
      .mocked(fetch)
      .mockResolvedValue(
        keyResponse({ key: makeKey({ id: 3, name: "Permanent", expiresAt: null }), token: ONE_TIME_TOKEN }),
      );

    renderPanel([]);

    fireEvent.click(screen.getByRole("button", { name: /create read key/i }));
    fireEvent.change(screen.getAllByLabelText("Name")[0], { target: { value: "Permanent" } });
    fireEvent.change(screen.getByLabelText("Expiry Policy"), { target: { value: "non-expiring" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String((init as RequestInit).body));

    expect(body.expiresAt).toBeNull();
  });
});

describe("ApiKeysPanel lifecycle mutations", () => {
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
    fireEvent.change(screen.getByLabelText("Expires at"), { target: { value: "2026-04-10T12:30" } });
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
      keyPrefix: "digest-prefix",
      maskedToken: "ph_live_digest-prefix_********",
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
});

describe("ApiKeysPanel editor and audit history", () => {
  it("preserves donor tier when renaming and saving a supporter key", async () => {
    const donor = makeKey({ tier: "donor", expiresAt: null });
    const renamed = { ...donor, name: "Renamed supporter" };
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce(keyResponse({ key: renamed }, { status: 200 }));
    renderPanel([donor]);

    fireEvent.click(screen.getByRole("button", { name: /^Edit Ops Key/ }));
    expect((screen.getByLabelText("Tier") as HTMLSelectElement).value).toBe("donor");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: renamed.name } });
    fireEvent.click(screen.getByRole("button", { name: /^Save changes to Ops Key/ }));

    expect(await screen.findByText("Updated Renamed supporter.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/admin/api-keys/1/update");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: renamed.name,
      ownerEmail: donor.ownerEmail,
      tier: "donor",
      rateLimitPerMinute: donor.rateLimitPerMinute,
      expiresAt: null,
    });
  });

  it("mounts one focused selected-key editor with selected disclosure semantics and audit history", async () => {
    setAuditLog({
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
    });
    renderPanel([
      makeKey(),
      makeKey({ id: 2, name: "Digest Key", keyPrefix: "digest", maskedToken: "ph_live_digest_********" }),
    ]);

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
    expect(getApiKeyAuditLogMock()).toHaveBeenLastCalledWith(2);

    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(document.activeElement).toBe(digestEdit));
  });

  it("shows audit loading and unavailable states with a local retry", async () => {
    const retryAudit = setAuditLog({ error: new Error("audit store unavailable") });
    renderPanel([makeKey()]);

    fireEvent.click(screen.getByRole("button", { name: /^Edit Ops Key/ }));
    expect(screen.getByText("Audit history unavailable")).toBeTruthy();
    expect(screen.getByText("audit store unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry audit history" }));
    expect(retryAudit).toHaveBeenCalledOnce();

    cleanup();
    setAuditLog({ isLoading: true, isFetching: true });
    renderPanel([makeKey({ id: 2, name: "Loading Key" })]);
    fireEvent.click(screen.getByRole("button", { name: /^Edit Loading Key/ }));
    expect(screen.getByText("Loading audit history...")).toBeTruthy();
  });
});

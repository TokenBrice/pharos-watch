// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ApiKeysPanel,
  GENERATED_AT,
  makeKey,
  renderPanel,
  requestIdempotencyKey,
} from "./api-keys-panel-harness";

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

});

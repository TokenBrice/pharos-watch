// @vitest-environment jsdom

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  GENERATED_AT,
  makeKey,
  renderPanel,
  requestIdempotencyKey,
} from "./api-keys-panel-harness";

describe("ApiKeysPanel create and token recovery", () => {
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

});

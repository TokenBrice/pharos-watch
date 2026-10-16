// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackModal } from "@/components/feedback-modal";
import {
  mockFetch,
  type MockFetchOutcome,
  type MockFetchSpy,
} from "@shared/test-utils/mock-fetch";

let fetchMock: MockFetchSpy;

function installFetch(outcomes: MockFetchOutcome[] = [{ body: { ok: true } }]): void {
  fetchMock = mockFetch([{
    match: "/api/feedback",
    outcomes,
  }], { requireMatch: true });
}

vi.mock("@/lib/api", () => ({
  buildApiUrl: (path: string) => `https://api.example.test${path}`,
}));

describe("FeedbackModal", () => {
  beforeEach(() => {
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("submits the current page URL after mounting closed", async () => {
    window.history.replaceState(null, "", "/stablecoin/usdc?panel=overview#top");

    const { rerender } = render(
      <FeedbackModal
        open={false}
        onOpenChange={vi.fn()}
        defaultType="data-correction"
        stablecoinId="usdc"
        stablecoinName="USDC"
      />,
    );

    window.history.replaceState(null, "", "/stablecoin/usdc?panel=proof#source");

    rerender(
      <FeedbackModal
        open={true}
        onOpenChange={vi.fn()}
        defaultType="data-correction"
        stablecoinId="usdc"
        stablecoinName="USDC"
      />,
    );

    await screen.findByText("/stablecoin/usdc?panel=proof#source");

    fireEvent.change(screen.getByLabelText("What is wrong?"), {
      target: { value: "The current reserve source is stale." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      pageUrl: "/stablecoin/usdc?panel=proof#source",
    });
    expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
  });

  it("reuses the idempotency key when an unchanged submission is retried", async () => {
    installFetch([new TypeError("network down"), { body: { ok: true } }]);
    render(<FeedbackModal open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Chart broken" } });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "The chart does not render after loading." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByText("Network error. Please try again.");

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByText("Thanks — submitted!");

    const firstKey = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get("Idempotency-Key");
    const secondKey = new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).get("Idempotency-Key");
    expect(secondKey).toBe(firstKey);
  });

  it.each([
    [503, "Feedback service temporarily unavailable. Please try again."],
  ])("reuses the idempotency key after a retryable HTTP %i", async (status, message) => {
    installFetch([{ body: { error: message }, status }, { body: { ok: true } }]);
    render(<FeedbackModal open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Chart broken" } });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "The chart does not render after loading." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByText(message);

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByText("Thanks — submitted!");

    const firstKey = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get("Idempotency-Key");
    const secondKey = new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).get("Idempotency-Key");
    expect(secondKey).toBe(firstKey);
  });
});

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackModal } from "@/components/feedback-modal";

const fetchMock = vi.fn();

vi.mock("@/lib/api", () => ({
  buildApiUrl: (path: string) => `https://api.example.test${path}`,
}));

describe("FeedbackModal", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
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
  });
});

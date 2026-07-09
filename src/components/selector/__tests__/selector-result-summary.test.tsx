// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import type { SelectorInput } from "@shared/lib/selector";

import { SelectorResultSummary } from "@/components/selector/selector-result-summary";
import { SelectorSnapshotBanner } from "@/components/selector/selector-snapshot-banner";

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: React.forwardRef<HTMLAnchorElement, { href: string; children: React.ReactNode }>(function MockLink(
      { href, children, ...rest },
      ref,
    ) {
      return React.createElement("a", { ref, href, ...rest }, children);
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const input: SelectorInput = {
  profile: "treasury",
  pegCurrency: "USD",
  horizon: "6mplus",
  depegTolerance: "zero",
  composability: "none",
  exitSpeed: "any",
  minApy: null,
  yieldNativeOnly: false,
  decentralization: "any",
  custodyOk: "any",
};

describe("SelectorResultSummary", () => {
  it("renders trust banners, handoff chips, answer chips, and share privacy copy", () => {
    const onEditAnswer = vi.fn();

    render(
      <SelectorResultSummary
        profile="treasury"
        input={input}
        universe={{ active: 12, surviving: 3 }}
        shortlistCount={2}
        screenerHandoffHref="/screener/?dewsMax=60"
        onAdjust={vi.fn()}
        onEditAnswer={onEditAnswer}
        onCopyShareLink={vi.fn().mockResolvedValue(undefined)}
        copyShareDisabled
        copyShareDisabledReason="Trading data is stale."
        lowConfidence
        coverageWarnings={{ sparse: true }}
        usedRelaxedFallback
        relaxedReasons={["exit speed"]}
        filterChips={[{ label: "DEWS", value: "60 max" }]}
        answerChips={[{ key: "peg", label: "Peg", value: "USD" }]}
        priorityLabels={["Safety", "Resilience", "Dependency Risk"]}
        sessionRecovery={{ message: "A previous Selector result is available.", onRestore: vi.fn() }}
      />,
    );

    expect(screen.getByText(/Low-confidence shortlist/i)).toBeTruthy();
    expect(screen.getByText(/Sparse coverage/i)).toBeTruthy();
    expect(screen.getByText(/Relaxed fallback used/i)).toBeTruthy();
    expect(screen.getByText(/Share links store these answers/i)).toBeTruthy();
    expect(screen.getByText(/^DEWS$/i)).toBeTruthy();
    expect(screen.getByText(/^60 max$/i)).toBeTruthy();
    expect(screen.queryByText(/Selector constraints cannot be expressed/i)).toBeNull();
    expect(screen.getByText(/Safety, Resilience, Dependency Risk/i)).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: /Next actions/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Export JSON/i })).toBeNull();

    const share = screen.getByRole("button", { name: /Copy share link/i });
    expect(share.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Edit peg:\s*USD/i }));
    expect(onEditAnswer).toHaveBeenCalledWith("peg");
  });

  it("announces share copy errors and exposes manual fallback URL", async () => {
    render(
      <SelectorResultSummary
        profile="treasury"
        input={input}
        universe={{ active: 12, surviving: 3 }}
        shortlistCount={2}
        screenerHandoffHref="/screener/"
        onAdjust={vi.fn()}
        onCopyShareLink={vi.fn().mockRejectedValue(new Error("Clipboard denied"))}
        copyShareDisabled={false}
        shareFallbackUrl="https://pharos.watch/screener/picker/?sid=abc"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Copy share link/i }));

    expect((await screen.findByRole("alert")).textContent).toContain("Clipboard denied");
    expect(screen.getByDisplayValue("https://pharos.watch/screener/picker/?sid=abc")).toBeTruthy();
  });

  it("clears the copied share-link feedback timer on unmount", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const { unmount } = render(
      <SelectorResultSummary
        profile="treasury"
        input={input}
        universe={{ active: 12, surviving: 3 }}
        shortlistCount={2}
        screenerHandoffHref="/screener/"
        onAdjust={vi.fn()}
        onCopyShareLink={vi.fn().mockResolvedValue(undefined)}
        copyShareDisabled={false}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Copy share link/i }));
      await Promise.resolve();
    });
    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});

describe("SelectorSnapshotBanner", () => {
  it("renders snapshot comparison deltas with aria-busy loading support", () => {
    render(
      <SelectorSnapshotBanner
        mode="frozen"
        capturedAt={1_700_000_000_000}
        comparison={{
          status: "changed",
          summary: "Rank order changed against current data.",
          deltas: [{ label: "USDC rank", previous: 1, current: 2 }],
        }}
      />,
    );

    expect(screen.getByText(/Rank order changed/i)).toBeTruthy();
    expect(screen.getByText("Unverified client snapshot")).toBeTruthy();
    expect(screen.getByText(/did not reproduce its scores from canonical source data/i)).toBeTruthy();
    expect(screen.getByText(/USDC rank/i)).toBeTruthy();
    expect(screen.getByText(/1 → 2/i)).toBeTruthy();
  });
});

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import type { SelectorInput } from "@shared/lib/selector";

import {
  SelectorResultSummary,
  type SelectorResultSummaryProps,
} from "@/components/selector/selector-result-summary";
import { SelectorSnapshotBanner } from "@/components/selector/selector-snapshot-banner";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

afterEach(() => {
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

function summaryProps(
  overrides: Partial<SelectorResultSummaryProps> = {},
): SelectorResultSummaryProps {
  return {
    profile: "treasury",
    input,
    universe: { active: 12, surviving: 3 },
    shortlistCount: 2,
    screenerHandoffHref: "/screener/",
    onAdjust: vi.fn(),
    onCopyShareLink: vi.fn().mockResolvedValue(undefined),
    copyShareDisabled: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const shareButton = () => screen.getByRole("button", { name: /Copy share link|Creating link|Link copied/i });

describe("SelectorResultSummary", () => {
  it("renders trust banners, handoff chips, answer chips, and blocks a disabled share", () => {
    const onEditAnswer = vi.fn();
    const onCopyShareLink = vi.fn().mockResolvedValue(undefined);

    render(
      <SelectorResultSummary
        {...summaryProps({
          screenerHandoffHref: "/screener/?dewsMax=60",
          onEditAnswer,
          onCopyShareLink,
          copyShareDisabled: true,
          copyShareDisabledReason: "Trading data is stale.",
          lowConfidence: true,
          coverageWarnings: { sparse: true },
          usedRelaxedFallback: true,
          relaxedReasons: ["exit speed"],
          filterChips: [{ label: "DEWS", value: "60 max" }],
          answerChips: [{ key: "peg", label: "Peg", value: "USD" }],
          priorityLabels: ["Safety", "Resilience", "Dependency Risk"],
          sessionRecovery: { message: "A previous Selector result is available.", onRestore: vi.fn() },
        })}
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

    const share = shareButton();
    expect(share.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Trading data is stale.");

    fireEvent.click(share);
    expect(onCopyShareLink).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Edit peg:\s*USD/i }));
    expect(onEditAnswer).toHaveBeenCalledWith("peg");
  });

  it("announces share copy errors and exposes manual fallback URL", async () => {
    render(
      <SelectorResultSummary
        {...summaryProps({
          onCopyShareLink: vi.fn().mockRejectedValue(new Error("Clipboard denied")),
          shareFallbackUrl: "https://pharos.watch/screener/picker/?sid=abc",
        })}
      />,
    );

    fireEvent.click(shareButton());

    expect((await screen.findByRole("alert")).textContent).toContain("Clipboard denied");
    expect(screen.getByDisplayValue("https://pharos.watch/screener/picker/?sid=abc")).toBeTruthy();
  });

  it("blocks a second submission while the share link is pending", async () => {
    const pending = deferred<void>();
    const onCopyShareLink = vi.fn().mockReturnValue(pending.promise);

    render(<SelectorResultSummary {...summaryProps({ onCopyShareLink })} />);

    fireEvent.click(shareButton());

    const busy = screen.getByRole("button", { name: /Creating link/i });
    expect(busy).toHaveProperty("disabled", true);
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Creating share link.");

    fireEvent.click(busy);
    expect(onCopyShareLink).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });

    expect(screen.getByRole("button", { name: /Link copied/i })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Share link copied.");
  });

  it("returns the copied feedback to idle after the reset window", async () => {
    vi.useFakeTimers();

    render(<SelectorResultSummary {...summaryProps()} />);

    await act(async () => {
      fireEvent.click(shareButton());
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: /Link copied/i })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2499);
    });
    expect(screen.getByRole("button", { name: /Link copied/i })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("button", { name: /^Copy share link$/i })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("clears the outstanding copied-feedback timer on unmount", async () => {
    vi.useFakeTimers();

    const { unmount } = render(<SelectorResultSummary {...summaryProps()} />);
    const baseline = vi.getTimerCount();

    await act(async () => {
      fireEvent.click(shareButton());
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: /Link copied/i })).toBeTruthy();
    expect(vi.getTimerCount()).toBe(baseline + 1);

    unmount();

    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("clears the error announcement and fallback when a retry succeeds", async () => {
    const onCopyShareLink = vi
      .fn()
      .mockRejectedValueOnce(new Error("Clipboard denied"))
      .mockResolvedValueOnce(undefined);

    render(
      <SelectorResultSummary
        {...summaryProps({
          onCopyShareLink,
          shareFallbackUrl: "https://pharos.watch/screener/picker/?sid=abc",
        })}
      />,
    );

    fireEvent.click(shareButton());
    expect((await screen.findByRole("alert")).textContent).toContain("Clipboard denied");

    await act(async () => {
      fireEvent.click(shareButton());
      await Promise.resolve();
    });

    expect(onCopyShareLink).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByDisplayValue("https://pharos.watch/screener/picker/?sid=abc")).toBeNull();
    expect(screen.getByRole("button", { name: /Link copied/i })).toBeTruthy();
  });
});

describe("SelectorSnapshotBanner", () => {
  it("labels server-recomputed snapshots as Pharos-verified", () => {
    render(<SelectorSnapshotBanner mode="frozen" trust="verified" capturedAt={1_700_000_000_000} />);

    expect(screen.getByText("Pharos-verified snapshot")).toBeTruthy();
    expect(screen.getByText(/recomputed this snapshot from canonical source data/i)).toBeTruthy();
    expect(screen.queryByText("Unverified client snapshot")).toBeNull();
  });

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

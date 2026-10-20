// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import type { SelectorInput } from "@shared/lib/selector";

import {
  SelectorResultSummary,
  type SelectorResultSummaryProps,
} from "@/components/selector/selector-result-summary";
import { SelectorSnapshotBanner } from "@/components/selector/selector-snapshot-banner";
import { SelectorSkippedDisclosure } from "@/components/selector/selector-skipped-disclosure";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
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
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

});

describe("SelectorSnapshotBanner", () => {
  it("labels server-recomputed snapshots as Pharos-verified", () => {
    render(<SelectorSnapshotBanner mode="frozen" trust="verified" capturedAt={1_700_000_000_000} />);

    expect(screen.getByText("Pharos-verified snapshot")).toBeTruthy();
    expect(screen.getByText(/recomputed this snapshot from canonical source data/i)).toBeTruthy();
    expect(screen.queryByText("Unverified client snapshot")).toBeNull();
  });

});

describe("SelectorSkippedDisclosure", () => {
  it("presents unavailable freeze-control evidence without exposing its diagnostic key", () => {
    render(<SelectorSkippedDisclosure coins={[{
      id: "usdc-circle", symbol: "USDC", missingSignals: ["insufficient-control-evidence"],
    }]} />);
    expect(screen.getByText("USDC")).toBeTruthy();
    expect(screen.getByText(/missing:.*freeze-control evidence/i)).toBeTruthy();
    expect(screen.queryByText(/insufficient-control-evidence/)).toBeNull();
  });
});

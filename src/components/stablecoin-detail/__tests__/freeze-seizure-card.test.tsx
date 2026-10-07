// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-blacklist-events", () => ({
  useBlacklistSummary: vi.fn(),
}));

import { FreezeSeizureModule, type FreezeSeizureModuleProps } from "../freeze-seizure-card";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
import type { BlacklistabilityClientSummary } from "@/lib/stablecoin-detail-blacklistability-client";
import type { TransferReviewView } from "@/lib/transfer-review";
import type { ApiQueryWithMetaResult } from "@/hooks/use-api-query";
import type { BlacklistSummaryResponse } from "@shared/types";

type UsageResult = ApiQueryWithMetaResult<BlacklistSummaryResponse>;

const SUMMARY: BlacklistabilityClientSummary = {
  status: "freezable",
  statusLabel: "Freezable",
  statusToneClass: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  statusNote: "A reviewed issuer or protocol control can freeze or seize this token in holders' wallets.",
  evidence: "The canonical implementation exposes owner-only addBlackList and destroyBlackFunds.",
  basisLabel: "Sourced review",
  sourceFreeRationale: null,
  upstreamLabel: null,
  sources: [{ label: "Verified USDT source", url: "https://example.com/usdt" }],
  reviewedAt: "2026-08-08",
};

function deployment(chainName: string, scope: string, scopeLabel: string, posture: string, postureLabel: string) {
  return {
    key: `${chainName}:0x1`,
    chainId: chainName.toLowerCase(),
    chainName,
    scope,
    scopeLabel,
    posture,
    postureLabel,
    evidence: `${chainName} deployment reviewed.`,
    sources: [],
  };
}

const TRANSFER_REVIEW: TransferReviewView = {
  reviewedAt: "2026-07-01",
  mixedPosture: true,
  deployments: [
    deployment("Ethereum", "canonical", "Canonical", "restrictable", "Restrictable"),
    deployment("Plasma", "material-bridge", "Bridged", "permissionless", "Permissionless"),
    deployment("Solana", "material-bridge", "Bridged", "permissionless", "Permissionless"),
  ],
};

function usageResult(result: Partial<UsageResult>) {
  vi.mocked(useBlacklistSummary).mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
    dataUpdatedAt: 0,
    ...result,
  } as unknown as UsageResult);
}

function statsFor(symbol: string, values: { events: number; addresses: number; frozen: number; destroyed: number }) {
  return {
    data: {
      stats: {
        perCoinTotalEvents: { [symbol]: values.events },
        perCoinFrozenAddressCount: { [symbol]: values.addresses },
        perCoinFrozenTotal: { [symbol]: values.frozen },
        perCoinDestroyedTotal: { [symbol]: values.destroyed },
      },
    },
    dataUpdatedAt: Date.now(),
  } as unknown as Partial<UsageResult>;
}

function renderModule(props: Partial<FreezeSeizureModuleProps> = {}) {
  return render(<FreezeSeizureModule summary={SUMMARY} symbol="USDT" variant="tile" {...props} />);
}

function rail() {
  return screen.getByRole("img");
}

describe("FreezeSeizureModule", () => {
  beforeEach(() => {
    vi.mocked(useBlacklistSummary).mockReset();
    usageResult({});
  });

  it("renders nothing without a review", () => {
    const { container, rerender } = render(<FreezeSeizureModule summary={null} symbol="USDT" variant="tile" />);
    expect(container.firstChild).toBeNull();
    rerender(<FreezeSeizureModule symbol="USDT" variant="tile" />);
    expect(container.firstChild).toBeNull();
  });

  it("owns the freeze-seizure anchor as an h3 module with the status chip in its header", () => {
    const { container } = renderModule();
    const section = container.querySelector("section#freeze-seizure");
    expect(section).toBeTruthy();
    const heading = screen.getByRole("heading", { level: 3 });
    expect(section?.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(section?.textContent).toContain(SUMMARY.statusLabel);
  });

  it("puts the review basis in the chip row as the confidence chip", () => {
    renderModule({ summary: { ...SUMMARY, basisLabel: "Rationale only", sources: [] } });
    expect(screen.getByText("Rationale only")).toBeTruthy();
    expect(rail().textContent).not.toContain("Rationale only");
  });

  it("draws a possible freeze path as not established, never as not freezable", () => {
    renderModule({ summary: { ...SUMMARY, status: "possible", statusLabel: "Possible" } });
    const drawn = rail();
    expect(drawn.textContent).toContain("Not established");
    expect(drawn.textContent).not.toMatch(/freezable/i);
    expect(drawn.getAttribute("aria-label")).not.toMatch(/freezable/i);
  });

  it("feeds an inherited power from the named upstream asset", () => {
    renderModule({
      summary: { ...SUMMARY, status: "inherited", statusLabel: "Inherited", upstreamLabel: "USD Coin" },
    });
    const text = rail().textContent ?? "";
    expect(text).toContain("USD Coin");
    expect(text.indexOf("USD Coin")).toBeLessThan(text.indexOf("Inherited"));
    expect(rail().getAttribute("aria-label")).toContain("USD Coin");
  });

  it("keeps an unnamed inherited power to one station rather than inventing an upstream", () => {
    renderModule({ summary: { ...SUMMARY, status: "inherited", statusLabel: "Inherited", upstreamLabel: null } });
    expect(rail().textContent).toContain("Inherited");
    expect(rail().textContent).not.toMatch(/upstream/i);
  });

  it("omits the scope station when there is no transfer review", () => {
    renderModule({ transferReview: null });
    expect(rail().textContent).not.toMatch(/scope/i);
    expect(document.querySelectorAll("details")).toHaveLength(1);
  });

  it("groups the transfer review by scope and posture and lists every deployment in a fold", () => {
    renderModule({ transferReview: TRANSFER_REVIEW });
    // One chip per scope × posture pair; the chains behind it ride along.
    expect(screen.getByTitle("Ethereum")).toBeTruthy();
    expect(screen.getByTitle("Plasma, Solana")).toBeTruthy();
    expect(rail().getAttribute("aria-label")).toContain("2 bridged deployments permissionless");

    for (const chain of ["Ethereum", "Plasma", "Solana"]) {
      const row = screen.getByText(chain, { selector: "li span" });
      expect(row.closest("details")?.hasAttribute("open")).toBe(false);
    }
  });

  it("omits the used station for a coin the freeze tracker does not watch, without fetching", () => {
    usageResult(statsFor("DAI", { events: 4, addresses: 2, frozen: 500, destroyed: 0 }));
    renderModule({ symbol: "DAI" });
    expect(rail().textContent).not.toMatch(/used/i);
    expect(vi.mocked(useBlacklistSummary).mock.calls.every(([options]) => options?.enabled === false)).toBe(true);
  });

  it("never prints a zero while a watched coin's usage is loading or unavailable", () => {
    usageResult({ isLoading: true });
    const { unmount } = renderModule();
    expect(rail().textContent).not.toMatch(/used/i);
    expect(rail().textContent).not.toMatch(/\d/);
    unmount();

    usageResult({ error: new Error("offline") });
    renderModule();
    expect(rail().textContent).not.toMatch(/used/i);
    expect(rail().textContent).not.toMatch(/\d/);
  });

  it("draws observed usage for a watched coin and drops zero-valued figures", () => {
    usageResult(statsFor("USDT", { events: 9, addresses: 3, frozen: 1_000_000, destroyed: 0 }));
    renderModule();
    const label = rail().getAttribute("aria-label") ?? "";
    expect(label).toMatch(/used/i);
    expect(label).toContain("3 addresses");
    expect(label).not.toMatch(/destroyed/i);
    expect(rail().textContent).not.toMatch(/\b0\b/);
  });

  it("states a watched coin with no recorded event in words, not as zero", () => {
    usageResult(statsFor("USDT", { events: 0, addresses: 0, frozen: 0, destroyed: 0 }));
    renderModule();
    expect(rail().getAttribute("aria-label")).toMatch(/used/i);
    expect(rail().textContent).not.toMatch(/\d/);
  });

  it("merges the evidence, the rationale and the citations into one collapsed fold", () => {
    renderModule({ summary: { ...SUMMARY, sourceFreeRationale: "Resolved by the resolver." } });

    const fold = screen.getByText(SUMMARY.evidence).closest("details");
    expect(fold).toBeTruthy();
    expect(fold?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("Resolved by the resolver.").closest("details")).toBe(fold);
    const link = screen.getByText("Verified USDT source").closest("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/usdt");
    expect(link?.closest("details")).toBe(fold);
    // Two notes plus one source.
    expect(fold?.querySelector("summary")?.textContent).toContain("(3)");
    expect(document.querySelectorAll("details")).toHaveLength(1);
  });

  it("keeps the merged provenance fold for a source-free review and states the missing source inside it", () => {
    renderModule({
      summary: { ...SUMMARY, basisLabel: "Rationale only", sources: [], sourceFreeRationale: "Resolved by the resolver." },
    });

    const fold = screen.getByText(SUMMARY.evidence).closest("details");
    const summaryLine = fold?.querySelector("summary")?.textContent ?? "";
    expect(summaryLine).toContain("Review notes & sources");
    // The evidence plus the source statement.
    expect(summaryLine).toContain("(2)");
    expect(screen.getByText("No public source.").closest("details")).toBe(fold);
    expect(screen.getByText(/Resolved by the resolver\./).closest("details")).toBe(fold);
    expect(document.querySelectorAll("details")).toHaveLength(1);
  });

  it("says the review cites no source when it carries neither sources nor a rationale", () => {
    renderModule({ summary: { ...SUMMARY, basisLabel: "Unsourced", sources: [], sourceFreeRationale: null } });
    const fold = screen.getByText(SUMMARY.evidence).closest("details");
    expect(fold?.textContent).toContain("No public source.");
    expect(fold?.querySelector("summary")?.textContent).toContain("(2)");
  });

  it("stamps the review date outside the fold and omits it when the review carries none", () => {
    const { unmount } = renderModule();
    const endsWithDate = (node: Element | null) => node?.textContent?.trim().endsWith(SUMMARY.reviewedAt!) === true;
    // The innermost element carrying the date; its wrappers repeat the same text.
    const stamp = screen.getByText(
      (_, element) => element?.tagName === "SPAN" && endsWithDate(element) && !Array.from(element.children).some(endsWithDate),
    );
    expect(stamp.closest("details")).toBeNull();
    unmount();

    renderModule({ summary: { ...SUMMARY, reviewedAt: null } });
    expect(document.body.textContent).not.toContain(SUMMARY.reviewedAt!);
  });
});

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YieldSourceSheet } from "@/components/yield-source-sheet";
import type { YieldRanking } from "@shared/types";

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  SheetFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/yield-history-chart", () => ({
  YieldHistoryChart: ({ externalSourceKey }: { externalSourceKey: string }) => (
    <div data-testid="yield-history-chart">{externalSourceKey}</div>
  ),
}));

vi.mock("@/components/yield-source-link", () => ({
  YieldSourceLink: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <div>{name}</div>,
}));

function makeRanking(id: string, bestSourceKey: string, altSourceKey: string): YieldRanking {
  return {
    id,
    name: id === "usdc" ? "USD Coin" : "Tether",
    symbol: id.toUpperCase(),
    apy30d: 0.05,
    yieldSource: `${id}-best`,
    yieldSourceUrl: `https://example.com/${id}/best`,
    yieldType: "lending-vault",
    benchmarkRate: 0.02,
    benchmarkLabel: "UST",
    benchmarkSelectionMode: "native",
    benchmarkIsFallback: false,
    sourceTvlUsd: 1_000_000,
    provenance: {
      sourceKey: bestSourceKey,
      confidenceTier: "high",
      method: "best-source",
      upstreamIds: [],
      selectedAt: null,
    },
    altSources: [
      {
        sourceKey: altSourceKey,
        yieldSource: `${id}-alt`,
        yieldSourceUrl: `https://example.com/${id}/alt`,
        yieldType: "lending-vault",
        apy30d: 0.04,
        sourceTvlUsd: 500_000,
      },
    ],
  } as unknown as YieldRanking;
}

describe("YieldSourceSheet", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("resets the selected source when the ranking changes", () => {
    const onOpenChange = vi.fn();
    const usdc = makeRanking("usdc", "best-usdc", "alt-usdc");
    const usdt = makeRanking("usdt", "best-usdt", "alt-usdt");
    const { rerender } = render(
      <YieldSourceSheet
        ranking={usdc}
        logo={undefined}
        riskFreeRate={0.02}
        medianApy={0.03}
        open
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /usdc-alt/i }));
    expect(screen.getByTestId("yield-history-chart").textContent).toContain("alt-usdc");

    rerender(
      <YieldSourceSheet
        ranking={usdt}
        logo={undefined}
        riskFreeRate={0.02}
        medianApy={0.03}
        open
        onOpenChange={onOpenChange}
      />,
    );

    expect(screen.getByTestId("yield-history-chart").textContent).toContain("best-usdt");
  });
});

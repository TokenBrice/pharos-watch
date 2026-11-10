// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CoverageLensSummary } from "@/components/coverage-lens-summary";
import { buildCoverageRow } from "@/lib/coverage";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import { cleanupFrontendTest } from "@/test-utils/frontend";

function row(id: string, cap: number | null) {
  return buildCoverageRow({
    coin: makeStablecoinMeta({ id }), marketCapUsd: cap ?? 0, marketCapAvailable: cap != null,
    hasPegCoverage: true, safetyScore: null, safetyRatingStatus: "not-rated", dexCoverageClass: null,
    hasYieldCoverage: false, flowCoverageStatus: null,
  });
}

afterEach(cleanupFrontendTest);

describe("CoverageLensSummary", () => {
  it("uses active market cap only for a complete observed universe", () => {
    const rows = [row("one", 100), row("two", 100)];
    render(<CoverageLensSummary rows={rows} filteredRows={[rows[0]]} search="one" filter="all" />);
    expect(screen.getByText(/of active market cap/).textContent).toContain("50%");
    expect(screen.getByText(/in the current result set/).textContent).toContain("$100");
  });

  it("qualifies partial ratios and dollar subtotals as known market cap", () => {
    const rows = [row("known", 100), row("unknown", null)];
    render(<CoverageLensSummary rows={rows} filteredRows={rows} search="" filter="all" />);
    expect(screen.getByText(/of known market cap/).textContent).toContain("100%");
    expect(screen.getByText(/in the current result set/).textContent).toMatch(/\$100(?:\.00)? known market cap/);
  });

  it("does not fabricate zero currency or percentage when all caps are unavailable", () => {
    const rows = [row("unknown", null)];
    render(<CoverageLensSummary rows={rows} filteredRows={rows} search="" filter="all" />);
    expect(screen.getByText(/of known market cap/).textContent).toContain("n/a");
    expect(screen.getByText(/in the current result set/).textContent).toContain("n/a");
    expect(screen.queryByText(/\$0|0%/)).toBeNull();
  });

  it("preserves explicit-zero observations without inventing a zero-denominator ratio", () => {
    const rows = [row("zero", 0)];
    render(<CoverageLensSummary rows={rows} filteredRows={rows} search="" filter="all" />);
    expect(screen.getByText(/of active market cap/).textContent).toContain("n/a");
    expect(screen.getByText(/in the current result set/).textContent).toContain("$0");
  });

  it("keeps an entirely unobserved result set unavailable even with a known universe subtotal", () => {
    const rows = [row("known", 100), row("unknown", null)];
    render(<CoverageLensSummary rows={rows} filteredRows={[rows[1]]} search="unknown" filter="all" />);
    expect(screen.getByText(/of known market cap/).textContent).toContain("n/a");
    expect(screen.getByText(/in the current result set/).textContent).toContain("n/a");
    expect(screen.queryByText(/\$0|0%/)).toBeNull();
  });

  it("does not attach a known-market-cap basis to an empty result set", () => {
    const rows = [row("known", 100)];
    render(<CoverageLensSummary rows={rows} filteredRows={[]} search="none" filter="all" />);
    const summary = screen.getByText(/in the current result set/).textContent ?? "";
    expect(summary).toContain("n/a");
    expect(summary).not.toContain("known market cap");
  });

  it("never rounds a nonzero share down to 0%", () => {
    const rows = [row("big", 60_000_000_000), row("tiny", 1_000_000)];
    render(<CoverageLensSummary rows={rows} filteredRows={[rows[1]]} search="tiny" filter="all" />);
    const share = screen.getByText(/of active market cap/).textContent ?? "";
    expect(share).toContain("<1%");
    expect(share).not.toContain("0%");
  });

  it("never rounds a partial universe up to 100%", () => {
    const rows = [row("big", 299_999_000_000), row("tiny", 1_000_000)];
    render(<CoverageLensSummary rows={rows} filteredRows={[rows[0]]} search="big" filter="all" />);
    const share = screen.getByText(/of active market cap/).textContent ?? "";
    expect(share).toContain(">99%");
    expect(share).not.toContain("100%");
  });
});

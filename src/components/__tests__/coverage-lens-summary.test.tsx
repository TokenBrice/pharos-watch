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
    hasPegCoverage: true, safetyScore: null, dexCoverageClass: null,
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
});

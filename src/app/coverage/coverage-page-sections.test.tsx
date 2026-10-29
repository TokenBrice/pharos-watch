// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CoverageMatrixCard, CoverageSafetyScoreDataCard } from "@/components/coverage/coverage-page-sections";
import { buildCoverageRow } from "@/lib/coverage";
import { logosById } from "@/lib/logos";
import { buildDataCoverageModel } from "@/lib/safety-score-data-coverage";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import type { StablecoinMeta } from "@shared/types";
import { CoverageCoinIdentity } from "@/components/coverage/coverage-coin-identity";
import { makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

function makeCoverageRow(index: number, overrides: Partial<Parameters<typeof buildCoverageRow>[0]> = {}) {
  return buildCoverageRow({
    coin: {
      id: `coin-${index}`,
      name: `Coin ${index}`,
      symbol: `C${index}`,
      flags: {
        pegCurrency: "USD",
        backing: "rwa-backed",
        governance: "centralized",
        yieldBearing: false,
        rwa: false,
        navToken: false,
      },
    } satisfies StablecoinMeta,
    marketCapUsd: 1_000_000 + index,
    hasPegCoverage: true,
    consensusSources: ["a", "b", "c"],
    priceConfidence: "high",
    safetyScore: 80,
    safetyRatingStatus: "rated",
    dexCoverageClass: "primary",
    hasYieldCoverage: true,
    flowCoverageStatus: "full",
    dependencyCoverage: { kind: "dependent", upstreamCount: 1, dependentCount: 0 },
    liveReserveFresh: true,
    ...overrides,
  });
}

type CoverageMatrixModel = Parameters<typeof CoverageMatrixCard>[0];

function makeMatrixModel(overrides: Partial<CoverageMatrixModel> = {}): CoverageMatrixModel {
  const rows = [makeCoverageRow(1)];
  return {
    logos: logosById,
    rows,
    filter: "all",
    setFilter: () => {},
    sort: "market-cap",
    setSort: () => {},
    search: "",
    setSearch: () => {},
    filteredRows: rows,
    hasActiveFilters: false,
    resetFilters: () => {},
    unavailableFeatures: [],
    dataUpdatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("CoverageCoinIdentity", () => {
  it.each(["mobile", "table"] as const)("preserves observed cap, including zero, in the %s identity", (variant) => {
    const cases = [
      { marketCapUsd: 100, marketCapAvailable: true, label: "$100" },
      { marketCapUsd: 0, marketCapAvailable: true, label: "$0" },
      { marketCapUsd: 0, marketCapAvailable: false, label: "Mcap -" },
    ];
    for (const fixture of cases) {
      const { container, unmount } = render(
        <CoverageCoinIdentity row={makeCoverageRow(1, fixture)} logoSize={24} variant={variant} />,
      );
      expect(container.textContent).toContain(fixture.label);
      if (fixture.marketCapAvailable) expect(container.textContent).not.toContain("Mcap -");
      else expect(container.textContent).not.toContain("$0");
      unmount();
    }
  });
});

describe("CoverageMatrixCard", () => {
  it("renders unavailable feed warnings without counting them as ordinary gaps", () => {
    const rows = [makeCoverageRow(1, { dataAvailability: { redemption: false } })];
    const { container } = render(
      <CoverageMatrixCard {...makeMatrixModel({ rows, filteredRows: rows, unavailableFeatures: ["redemption"] })} />,
    );
    const view = within(container);

    expect(view.getByRole("status").textContent).toContain("Data n/a");
    expect(view.getByRole("status").textContent).toContain("Backstop");
    expect(
      view.getAllByLabelText(/Data unavailable\. Redemption backstop coverage data is unavailable/).length,
    ).toBeGreaterThan(0);
    expect(
      view.queryByLabelText(/Not covered\. No modeled redemption-backstop route is currently configured/),
    ).toBeNull();
  });

  it("pages long results 20 at a time with an honest count and a URL page", () => {
    window.history.replaceState(null, "", "/coverage/");
    const rows = Array.from({ length: 30 }, (_value, index) => makeCoverageRow(index + 1));
    const { container } = render(<CoverageMatrixCard {...makeMatrixModel({ rows, filteredRows: rows })} />);

    expect(container.textContent).toContain("Showing 1–20 of 30 coins");
    expect(screen.getAllByText("C20").length).toBeGreaterThan(0);
    expect(screen.queryByText("C21")).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Go to next page" })[0]);

    expect(window.location.search).toBe("?page=2");
    expect(container.textContent).toContain("Showing 21–30 of 30 coins");
    expect(screen.getAllByText("C30").length).toBeGreaterThan(0);
    expect(screen.queryByText("C20")).toBeNull();
    window.history.replaceState(null, "", "/coverage/");
  });

});

describe("CoverageSafetyScoreDataCard", () => {
  it.each([true, false])("labels a mixed-status cohort as assessed with rated membership %s", (hasRated) => {
    const cards = [
      ...(hasRated ? [makeV9Card({ id: "rated" })] : []),
      makeV9Card({ id: "nr", score: null, ratingStatus: "not-rated" }),
      makeReportCardsV9PipelineGapCard("control", "A", { id: "gap" }),
    ];
    const model = buildDataCoverageModel(makeReportCardsV9Response({ cards }));
    const { container } = render(<CoverageSafetyScoreDataCard safetyScoreDataCoverage={model} />);
    expect(container.textContent).toContain(`${hasRated ? 3 : 2} assets are assessed`);
    expect(container.textContent).not.toMatch(/assets? (?:is|are) scored|Assets scored/);
    expect(container.textContent).toContain(`${hasRated ? 1 : 0} rated (0 partial) · 1 not rated · 1 unrated pipeline gap`);
    expect(screen.getByText("Assets assessed")).toBeTruthy();
  });

  it("renders the score-input summary and expandable detail on the coverage page", () => {
    const safetyScoreDataCoverage = buildDataCoverageModel(
      makeReportCardsV9Response({ cards: [makeV9Card({ id: "asset-a" })] }),
    );

    const { container } = render(
      <CoverageSafetyScoreDataCard safetyScoreDataCoverage={safetyScoreDataCoverage} />,
    );

    expect(screen.getByRole("heading", { name: "Score input coverage" })).toBeTruthy();
    expect(container.textContent).toContain("1 asset is assessed");
    expect(screen.getByText(/Coverage detail|Which inputs are missing/)).toBeTruthy();
    expect(screen.getByText("Inputs evaluated")).toBeTruthy();
  });

  it("shows the three server-computed numbers and keeps unavailable distinct from zero", () => {
    const reviewedAt = Date.parse("2026-10-03T00:00:00Z") / 1000;
    const evidence = {
      semantics: "open-question-v1" as const,
      totals: { questions: 6, open: 3, issuer: 2, documentation: 1, obligations: 269 },
      owners: [
        { responsibility: "unresearched" as const, questions: 2, obligations: 4 },
        { responsibility: "mixed" as const, questions: 1, obligations: 1 },
      ],
      reasons: [
        { code: "unresolved-control-identity" as const, bucket: "open" as const, questions: 3, obligations: 6 },
        { code: "missing-reserve-composition" as const, bucket: "issuer" as const, questions: 2, obligations: 3 },
      ],
      documentation: {
        questions: 1,
        datums: 256,
        facts: 250,
        reasons: [{ reason: "no-scoring-path" as const, datums: 256 }],
      },
      issuer: {
        questions: 2,
        assets: 1,
        oldestReviewedAtSec: reviewedAt,
        newestReviewedAtSec: reviewedAt,
      },
      byCard: [],
    };
    const safetyScoreDataCoverage = buildDataCoverageModel(
      makeReportCardsV9Response({
        cards: [makeV9Card({ id: "asset-a" })],
        openEvidence: evidence,
      }),
    );

    const { container } = render(
      <CoverageSafetyScoreDataCard safetyScoreDataCoverage={safetyScoreDataCoverage} />,
    );

    expect(container.textContent).toContain(
      "3 open questions · 2 not disclosed by issuers · 1 documentation gap.",
    );
    expect(container.textContent).toContain("269 evidence obligations behind them · 256 of which documentation");
    expect(container.textContent).toContain("Open questions · Controlling entity not identified");
    expect(container.textContent).toContain("Not disclosed by issuers · Reserve composition not published");
    expect(container.textContent).toContain("Documentation gaps · No scoring path");
    expect(container.textContent).toContain("256 datums");
    expect(container.textContent).toContain(
      "Not disclosed by issuers. Reviewed Oct 3, 2026; the issuer does not publish this datum.",
    );
    expect(container.textContent).not.toContain("unavailable for this publication");
  });

  it("says the question counts are unavailable when the payload predates open evidence", () => {
    const safetyScoreDataCoverage = buildDataCoverageModel(
      makeReportCardsV9Response({ cards: [makeV9Card({ id: "asset-a" })] }),
    );

    const { container } = render(
      <CoverageSafetyScoreDataCard safetyScoreDataCoverage={safetyScoreDataCoverage} />,
    );

    expect(container.textContent).toContain("Open-question counts are unavailable for this publication.");
    expect(container.textContent).toContain("Evidence obligations");
    expect(container.textContent).toContain("Unavailable for this publication");
    expect(container.textContent).toContain("They are unavailable, not zero.");
    expect(container.textContent).not.toMatch(/0 open questions/);
  });
});

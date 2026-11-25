// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  CoverageMatrixCard,
  CoveragePricingSourcesCard,
  CoverageSafetyScoreDataCard,
} from "@/components/coverage/coverage-page-sections";
import { buildCoverageRow } from "@/lib/coverage";
import { logosById } from "@/lib/logos";
import { buildDataCoverageModel } from "@/lib/safety-score-data-coverage";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { CoverageCoinIdentity } from "@/components/coverage/coverage-coin-identity";
import { makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";

const NO_SCORING_PATH_LABEL = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.documentation!.reasons.find(
  (entry) => entry.reason === "no-scoring-path",
)!.publicLabel;

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
    dataAsOfMs: 1_700_000_000_000,
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

  it("labels the matrix clock from the oldest contributing producer generation", () => {
    const { container } = render(<CoverageMatrixCard {...makeMatrixModel()} />);

    expect(container.textContent).toMatch(/Updated \d/);
    expect(container.textContent).not.toMatch(/Fetched \d/);
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

  it("keeps column headers concise with a table-level column guide and sticky first column", () => {
    const { container } = render(<CoverageMatrixCard {...makeMatrixModel()} />);
    const table = container.querySelector("table")!;
    expect(table.getAttribute("aria-describedby")).toBe("coverage-matrix-column-guide");
    expect(document.getElementById("coverage-matrix-column-guide")?.textContent).toContain("Safety Score:");

    const headers = [...table.querySelectorAll("thead th")];
    expect(headers[0].className).toContain("sticky");
    expect(headers[0].className).toContain("left-0");
    // No 30-word description prose repeated inside every <th>.
    for (const th of headers) {
      expect((th.textContent ?? "").split(/\s+/).length).toBeLessThanOrEqual(4);
    }
  });

  it("supports click-to-sort headers synced to sort state and marks body rows as scan-intent", () => {
    const setSort = vi.fn();
    const { container, rerender } = render(
      <CoverageMatrixCard {...makeMatrixModel({ sort: "market-cap", setSort })} />,
    );
    const table = container.querySelector("table")!;
    const stablecoinHeader = table.querySelector("thead th")!;
    expect(stablecoinHeader.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(within(stablecoinHeader as HTMLElement).getByRole("button"));
    expect(setSort).toHaveBeenCalledWith("name");

    const safetySortButton = within(table).getByRole("button", {
      name: "Sort by Safety Score (weakest first)",
    });
    fireEvent.click(safetySortButton);
    expect(setSort).toHaveBeenCalledWith("weakest-safety");

    // Freezable has no weakest-* sort key and stays non-sortable.
    const freezableHeader = [...table.querySelectorAll("thead th")].find((th) =>
      th.textContent?.includes("Freezable"),
    )!;
    expect(freezableHeader.getAttribute("aria-sort")).toBeNull();
    expect(within(freezableHeader as HTMLElement).queryByRole("button")).toBeNull();

    rerender(<CoverageMatrixCard {...makeMatrixModel({ sort: "weakest-safety", setSort })} />);
    const activeSafetyHeader = [...table.querySelectorAll("thead th")].find((th) =>
      th.textContent?.includes("Safety"),
    )!;
    expect(activeSafetyHeader.getAttribute("aria-sort")).toBe("ascending");

    const bodyRow = table.querySelector("tbody tr")!;
    expect(bodyRow.getAttribute("data-row-intent")).toBe("scan");
    const stickyBodyHead = bodyRow.querySelector('th[scope="row"]')!;
    expect(stickyBodyHead.className).toContain("group-hover:bg-[var(--table-row-hover)]");
    expect(stickyBodyHead.className).toContain("min-[1360px]:shadow-none");
  });

  it("exposes a 1-tap coin link outside summary in mobile cards and toggles status legend cleanly", () => {
    const { container } = render(<CoverageMatrixCard {...makeMatrixModel()} />);
    const view = within(container);

    const mobileCard = container.querySelector("article.pharos-card-shell")!;
    const coinLink = within(mobileCard as HTMLElement).getByRole("link");
    expect(coinLink.getAttribute("href")).toBe("/stablecoin/coin-1/");
    expect(coinLink.closest("summary")).toBeNull();

    const legendToggle = view.getByRole("button", { name: "Status legend" });
    expect(legendToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(legendToggle);
    expect(legendToggle.getAttribute("aria-expanded")).toBe("true");
  });

});

describe("CoveragePricingSourcesCard", () => {
  it("renders a compact horizontal meter strip with inline Protocol badges and no nested rounded-xl override card", () => {
    const { container } = render(
      <CoveragePricingSourcesCard
        pricingSources={[
          { name: "coingecko", count: 140 },
          { name: "defillama", count: 120 },
        ]}
        authoritativeSources={[{ name: "protocol-redeem", count: 4 }]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Where Pharos gets its prices" })).toBeTruthy();
    expect(container.textContent).toContain("140");
    expect(container.textContent).toContain("Authoritative overrides");
    expect(container.textContent).toContain("Protocol");
    const cardContent = container.querySelector('[data-slot="card-content"]')!;
    expect(cardContent.querySelectorAll(".rounded-xl").length).toBe(0);
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
        { code: "missing-reserve-composition" as const, bucket: "issuer" as const, questions: 2, obligations: 3 },
        { code: "unresolved-control-identity" as const, bucket: "open" as const, questions: 3, obligations: 6 },
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
      byCard: [
        {
          id: "asset-a",
          openBucketQuestionsCarried: 3,
          inheritedOpenBucketQuestionsCarried: 0,
          openBucketObligationsCarried: 6,
          documentationObligationsCarried: 256,
        },
      ],
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
    expect(container.textContent).toContain(`Documentation gaps · ${NO_SCORING_PATH_LABEL}`);
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

    expect(container.textContent).toContain("Open-question counts are unavailable for this publication, not zero.");
    expect(container.textContent).toContain("Evidence obligations");
    expect(container.textContent).toContain("Unavailable for this publication");
    expect(container.textContent).not.toMatch(/0 open questions/);
  });
});

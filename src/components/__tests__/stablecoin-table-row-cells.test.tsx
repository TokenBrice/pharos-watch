import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StablecoinTableRowCells } from "@/components/stablecoin-table-row-cells";
import { buildStablecoinTableRowModel } from "@/components/stablecoin-table-row-model";
import type { StablecoinTableRowCellProps } from "@/components/stablecoin-table-row-types";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { buildV9SafetyTableMap } from "@/lib/safety-score-v9-consumers";
import { makeReportCardsV9Response } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import { getScoreColor } from "@/lib/severity-colors";

function buildRow(): StablecoinTableRowCellProps {
  const coin = makeStablecoin({
    id: "usdc-circle",
    symbol: "USDC",
    price: 1.02,
    pegType: "peggedUSD",
  });
  const pegSummary = makePegSummaryCoin({
    id: coin.id,
    symbol: coin.symbol,
    currentDeviationBps: -50,
  });
  return {
    coin,
    rank: 1,
    density: "spacious",
    densityConfig: { rowHeight: 52, iconSize: 28 },
    variant: "default",
    isVisible: (column) => column === "peg",
    pegScores: new Map([[coin.id, pegSummary]]),
    dexLiquidity: undefined,
    reportCards: undefined,
    showPinnedControl: false,
    isPinned: false,
    onPrefetch: () => undefined,
  };
}

describe("StablecoinTableRowCells peg deviation", () => {
  it.each([
    makeReportCardsV9PipelineGapCard("control", "A"),
    makeReportCardsV9PartialCard("exit", "B"),
  ])("preserves $ratingStatus when rendering actual mobile and desktop safety cells", (card) => {
    const row = buildRow();
    const response = makeReportCardsV9Response({ cards: [card] });
    const table = buildV9SafetyTableMap(response, response.safetyScoreIdentity);
    if (table.status !== "available") throw new Error(table.reason);
    row.reportCards = table.value;
    row.isVisible = (column) => column === "grade";
    const model = buildStablecoinTableRowModel({
      coin: row.coin, pegScores: row.pegScores, reportCards: row.reportCards,
      density: row.density, variant: "default",
    });
    const html = renderToStaticMarkup(<table><tbody><tr><StablecoinTableRowCells row={row} model={model} /></tr></tbody></table>);
    expect(html).toContain("Partial evidence: pipeline gap");
    if (card.grade === null) {
      expect(html).toContain("Pipeline gap");
      expect(html).not.toContain("Safety grade NR");
      expect(html).not.toContain("Pharos grade: F");
      expect(html).not.toContain("(0/100)");
    } else {
      expect(html).toContain(`Pharos grade: ${card.grade}`);
    }
  });
  it("renders the published bps instead of recomputing from a newer price", () => {
    const row = buildRow();
    const model = buildStablecoinTableRowModel({
      coin: row.coin,
      pegScores: row.pegScores,
      dexLiquidity: row.dexLiquidity,
      reportCards: row.reportCards,
      density: row.density,
      variant: row.variant ?? "default",
    });
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <tr>
            <StablecoinTableRowCells row={row} model={model} />
          </tr>
        </tbody>
      </table>,
    );

    expect(html).toContain("-50 bps");
    expect(html).not.toContain("+200 bps");
  });
});

describe("StablecoinTableRowCells supply availability", () => {
  function renderSupply(circulating: Record<string, number>, prevDay: Record<string, number> = { peggedUSD: 100 }) {
    const row = buildRow();
    row.coin.circulating = circulating;
    row.coin.circulatingPrevDay = prevDay;
    row.coin.circulatingPrevWeek = { peggedUSD: 100 };
    row.isVisible = (column) => ["mcap", "change24h", "change7d"].includes(column);
    const model = buildStablecoinTableRowModel({
      coin: row.coin, density: row.density, variant: "default",
    });
    return renderToStaticMarkup(
      <table><tbody><tr><StablecoinTableRowCells row={row} model={model} /></tr></tbody></table>,
    );
  }

  it("renders unavailable supply without a numeric market cap, contraction, or sparkline", () => {
    const html = renderSupply({});
    expect(html).toContain("Supply unavailable");
    expect(html).not.toContain("$0");
    expect(html).not.toContain("-100");
    expect(html).not.toContain("<svg");
  });

  it("renders explicit zero as $0 and a real -100% contraction", () => {
    const html = renderSupply({ peggedUSD: 0 });
    expect(html).toContain("$0");
    expect(html).toContain("-100.00%");
    expect(html).not.toContain("Supply unavailable");
  });

  it("does not connect a supply sparkline across absent middle history", () => {
    const html = renderSupply({ peggedUSD: 150 }, {});
    expect(html).toContain("+50.00%");
    expect(html).not.toContain("<polyline");
    expect(html).not.toContain("<path");
  });
});

describe("StablecoinTableRowCells liquidity availability", () => {
  it.each([0, null, 75])("preserves liquidity score %s in mobile and desktop cells", (liquidityScore) => {
    const row = buildRow();
    row.isVisible = (column) => column === "name" || column === "liquidity";
    row.dexLiquidity = { [row.coin.id]: makeDexLiquidityData({ liquidityScore }) };
    const model = buildStablecoinTableRowModel({
      coin: row.coin, dexLiquidity: row.dexLiquidity, density: row.density, variant: "default",
    });
    const html = renderToStaticMarkup(
      <table><tbody><tr><StablecoinTableRowCells row={row} model={model} /></tr></tbody></table>,
    );
    const spans = [...html.matchAll(/<span class="([^"]+)">([^<]*)<\/span>/g)];
    const expectedValue = liquidityScore === null ? "—" : String(liquidityScore);
    const expectedClass = liquidityScore === null ? "text-muted-foreground" : getScoreColor(liquidityScore);
    // Mobile's compact Liq badge and the standalone desktop liquidity cell.
    const liquiditySpans = spans.filter(([, className, value]) =>
      value === expectedValue && className.includes(expectedClass),
    );
    expect(liquiditySpans.length).toBeGreaterThanOrEqual(2);
    expect(model.liquidityScore).toBe(liquidityScore);
  });
});

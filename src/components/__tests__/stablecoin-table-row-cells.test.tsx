import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StablecoinTableRowCells } from "@/components/stablecoin-table-row-cells";
import { buildStablecoinTableRowModel } from "@/components/stablecoin-table-row-model";
import type { StablecoinTableRowCellProps } from "@/components/stablecoin-table-row-types";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { makeStablecoin } from "@shared/test-utils/stablecoin";

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

// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ImgHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";
import { LiquidityTable } from "@/components/liquidity-table";
import type { LiquidityRow } from "@/components/liquidity-table-logic";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import { CLIENT_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { summarizeDexVolumeWindow } from "@shared/lib/dex-volume-availability";

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => createElement("img", { ...props, alt: props.alt ?? "" }),
}));

function renderTable(rows: LiquidityRow[]) {
  return render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(LiquidityTable, { rows, logos: undefined, searchQuery: "", onRowClick: () => {} }),
    ),
  );
}

function rowFor(symbol: string): HTMLElement {
  return screen.getByRole("link", { name: `Open ${symbol} liquidity detail` });
}

describe("LiquidityTable", () => {
  it("labels NR with the producer reason, never infers one, and does not rank NR rows", () => {
    const [rated, labelled, legacy] = CLIENT_ACTIVE_STABLECOINS;
    renderTable([
      { meta: legacy, liq: makeDexLiquidityData({ liquidityScore: null, liquidityScoreUnavailableReason: null }) },
      { meta: labelled, liq: makeDexLiquidityData({ liquidityScore: null, liquidityScoreUnavailableReason: "activity-stale" }) },
      { meta: rated, liq: makeDexLiquidityData({ liquidityScore: 64 }) },
    ]);

    const ratedCells = within(rowFor(rated.symbol)).getAllByRole("cell");
    expect(ratedCells[0].textContent).toBe("1");

    const labelledRow = rowFor(labelled.symbol);
    expect(within(labelledRow).getAllByRole("cell")[0].textContent).toBe("—");
    expect(within(labelledRow).getByLabelText("NR: 24h volume stale").getAttribute("data-reason-code")).toBe("activity-stale");

    const legacyRow = rowFor(legacy.symbol);
    expect(within(legacyRow).getAllByRole("cell")[0].textContent).toBe("—");
    const plain = within(legacyRow).getByLabelText("NR");
    expect(plain.textContent).toBe("NR");
    expect(plain.hasAttribute("data-reason-code")).toBe(false);
  });

  it("shows a partial lower bound in-cell, but a dash when the admitted sum rounds to $0.00", () => {
    const [withBound, emptyBound] = CLIENT_ACTIVE_STABLECOINS;
    const asOfSec = 1_800_000_000;
    const window = (volumeUsd: number) => summarizeDexVolumeWindow(
      [
        { volumeUsd, observedAtSec: asOfSec - 60, tvlUsd: 600 },
        { volumeUsd: null, observedAtSec: null, tvlUsd: 400 },
      ],
      "24h",
      { asOfSec, maxObservationAgeSec: 72 * 3600 },
    ).availability;
    renderTable([
      { meta: withBound, liq: makeDexLiquidityData({ liquidityScore: 50, totalVolume24hUsd: null, volume24hAvailability: window(1_234) }) },
      { meta: emptyBound, liq: makeDexLiquidityData({ liquidityScore: 40, totalVolume24hUsd: null, volume24hAvailability: window(0.001) }) },
    ]);

    expect(rowFor(withBound.symbol).textContent).toContain("≥ $1.23K");
    expect(rowFor(emptyBound.symbol).textContent).not.toContain("≥");
  });
});

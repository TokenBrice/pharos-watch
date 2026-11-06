// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ImgHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";
import { LiquidityTable } from "@/components/liquidity-table";
import type { LiquidityRow } from "@/components/liquidity-table-logic";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import { CLIENT_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { summarizeDexVolumeWindow } from "@shared/lib/dex-volume-availability";

vi.mock("next/link", async () => (await import("@/test-utils/frontend")).createNextLinkMock());

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => <img {...props} alt={props.alt ?? ""} />,
}));

const prefetch = vi.fn();
vi.mock("@/hooks/use-prefetch-stablecoin", () => ({ usePrefetchStablecoin: () => prefetch }));

const renderTable = (rows: LiquidityRow[]) =>
  render(<LiquidityTable rows={rows} logos={undefined} searchQuery="" onRowClick={() => {}} />);

const rowFor = (symbol: string) =>
  screen.getByRole("link", { name: `Open ${symbol} liquidity detail` }).closest("tr")!;

describe("LiquidityTable", () => {
  it("labels NR with the producer reason, never infers one, and does not rank NR rows", () => {
    const [rated, labelled, legacy] = CLIENT_ACTIVE_STABLECOINS;
    renderTable([
      { meta: legacy, liq: makeDexLiquidityData({ liquidityScoreUnavailableReason: null }) },
      { meta: labelled, liq: makeDexLiquidityData({ liquidityScoreUnavailableReason: "activity-stale" }) },
      { meta: rated, liq: makeDexLiquidityData({ liquidityScore: 64 }) },
    ]);

    const row = rowFor(rated.symbol), link = within(row).getByRole("link");
    expect(link.getAttribute("href")).toBe(`/stablecoin/${rated.id}/`);
    expect(row.getAttribute("tabindex")).toBeNull();
    expect(screen.getAllByRole("row")).toContain(row);
    expect(screen.getAllByRole("columnheader")).toHaveLength(14);
    fireEvent.focus(link);
    fireEvent.mouseEnter(row);
    expect(prefetch.mock.calls).toEqual([[rated.id], [rated.id]]);
    const ratedCells = within(row).getAllByRole("cell");
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
    renderTable(([
      [withBound, 50, 1_234], [emptyBound, 40, 0.001],
    ] as const).map(([meta, liquidityScore, volume]) => ({
      meta, liq: makeDexLiquidityData({ liquidityScore, totalVolume24hUsd: null, volume24hAvailability: window(volume) }),
    })));

    expect(rowFor(withBound.symbol).textContent).toContain("≥ $1.23K");
    expect(rowFor(emptyBound.symbol).textContent).not.toContain("≥");
  });
});

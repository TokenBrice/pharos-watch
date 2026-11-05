// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RatioSchema } from "@shared/types/ratio";
import { makeCoin } from "@/hooks/__tests__/chain-profile-fixtures";
import { StablecoinTable } from "./stablecoin-table";

vi.mock("next/link", async () => (await import("@/test-utils/frontend")).createNextLinkMock());

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <span>{name}</span>,
}));

function renderCoins(coins = [makeCoin()], backingFilter: "crypto-backed" | null = null) {
  render(<StablecoinTable coins={coins} backingFilter={backingFilter} />);
}

describe("Chain detail StablecoinTable", () => {
  it("renders the filtered table with its caption and coin supply values", () => {
    renderCoins([
      makeCoin(),
      makeCoin({
        id: "dai-maker",
        name: "DAI",
        symbol: "DAI",
        supplyUsd: 400_000_000,
        chainShare: RatioSchema.parse(0.4),
        backing: "crypto-backed",
      }),
    ], "crypto-backed");

    expect(screen.getByRole("table")).toBeTruthy();
    for (const text of ["Stablecoins deployed on this chain", "$500.0M", "$400.0M"]) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByText("All Stablecoins").textContent).toContain("Crypto");
  });

  it("keeps native table semantics and one identity link per row", () => {
    push.mockClear();
    renderCoins();
    const link = screen.getByRole("link", { name: /USD Coin \(USDC\).*on chain/i });
    const row = link.closest("tr")!;
    expect(link.getAttribute("href")).toBe("/stablecoin/usdc-circle/");
    expect(screen.getByRole("link")).toBe(link);
    expect(screen.getAllByRole("row")).toContain(row);
    expect(screen.getAllByRole("columnheader")).toHaveLength(6);
    expect(screen.getAllByRole("cell")).toHaveLength(6);
    expect(row.getAttribute("tabindex")).toBeNull();
    fireEvent.click(row.cells[0]);
    expect(push).toHaveBeenCalledExactlyOnceWith("/stablecoin/usdc-circle/");
  });

  it("prints a nonzero share below 0.05% as <0.1%, not 0.0%", () => {
    renderCoins([makeCoin({
      id: "trusd-tori",
      name: "trUSD",
      symbol: "trUSD",
      supplyUsd: 71_571_257.67,
      chainShare: RatioSchema.parse(0.0004967482853156454),
    })]);

    for (const text of ["<0.1%", "$71.6M"]) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText("0.0%")).toBeNull();
  });

  it("prints a positive sub-dollar supply as <$1, not $0", () => {
    renderCoins([makeCoin({ id: "pyusd-paypal", name: "PYUSD", symbol: "PYUSD", supplyUsd: 0.2309, chainShare: RatioSchema.parse(0.0001) })]);

    expect(screen.queryByText("$0")).toBeNull();
    expect(screen.getByText("<$1")).toBeTruthy();
    expect(screen.getByRole("link", { name: /<\$1 on chain/ })).toBeTruthy();
  });
});

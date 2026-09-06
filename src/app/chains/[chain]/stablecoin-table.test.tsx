// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RatioSchema } from "@shared/types/ratio";
import { makeCoin } from "@/hooks/__tests__/chain-profile-fixtures";
import { StablecoinTable } from "./stablecoin-table";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <span>{name}</span>,
}));

describe("Chain detail StablecoinTable", () => {
  beforeEach(() => {
    push.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders through the shared table foundation with stable identity", () => {
    render(
      <StablecoinTable
        coins={[
          makeCoin(),
          makeCoin({
            id: "dai-maker",
            name: "DAI",
            symbol: "DAI",
            supplyUsd: 400_000_000,
            chainShare: RatioSchema.parse(0.4),
            backing: "crypto-backed",
          }),
        ]}
        backingFilter="crypto-backed"
      />,
    );

    const shell = screen.getByTestId("chain-detail-stablecoins-table");
    const table = screen.getByRole("table");
    const caption = screen.getByText("Stablecoins deployed on this chain");

    expect(shell.getAttribute("data-table-id")).toBe("chain-detail-stablecoins");
    expect(shell.className).toContain("pharos-density-compact");
    expect(shell.className).toContain("text-card-foreground");
    expect(table.parentElement?.getAttribute("data-slot")).toBe("table-viewport");
    expect(table.parentElement?.querySelector("[data-slot='table-container']")).toBeNull();
    expect(caption.closest("caption")?.className).toContain("sr-only");
    expect(screen.getByText("All Stablecoins").textContent).toContain("Crypto");
    expect(screen.getByText("#").closest("th")?.getAttribute("data-slot")).toBe("table-head");
    expect(screen.getByText("$400.0M").closest("td")?.getAttribute("data-slot")).toBe("table-cell");
  });

  it("preserves clickable row link behavior and keyboard activation", () => {
    render(<StablecoinTable coins={[makeCoin()]} backingFilter={null} />);

    const row = screen.getByRole("link", { name: /USD Coin \(USDC\).*on chain/i });

    expect(row.getAttribute("tabindex")).toBe("0");

    fireEvent.click(row);
    expect(push).toHaveBeenLastCalledWith("/stablecoin/usdc-circle/");

    push.mockClear();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(push).toHaveBeenLastCalledWith("/stablecoin/usdc-circle/");

    push.mockClear();
    fireEvent.keyDown(row, { key: " " });
    expect(push).toHaveBeenLastCalledWith("/stablecoin/usdc-circle/");
  });
});

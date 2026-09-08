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

  it("renders the filtered table with its caption and coin supply values", () => {
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

    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("Stablecoins deployed on this chain")).toBeTruthy();
    expect(screen.getByText("All Stablecoins").textContent).toContain("Crypto");
    expect(screen.getByText("$500.0M")).toBeTruthy();
    expect(screen.getByText("$400.0M")).toBeTruthy();
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

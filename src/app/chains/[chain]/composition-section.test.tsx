// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RatioSchema } from "@shared/types/ratio";
import { makeCoin } from "@/hooks/__tests__/chain-profile-fixtures";
import { CompositionSection } from "./composition-section";
import { buildChainRouteViewModel } from "./view-model";

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <span>{name}</span>,
}));

describe("Chain profile composition", () => {
  it("labels a positive sub-dollar supply as <$1, not $0", () => {
    const coin = makeCoin({ id: "fusd-exsat", name: "FUSD", symbol: "FUSD", supplyUsd: 0.2843, chainShare: RatioSchema.parse(1) });
    render(<CompositionSection model={buildChainRouteViewModel([coin], coin.supplyUsd)} />);

    expect(screen.queryByText(/\$0\b/)).toBeNull();
    expect(document.body.textContent).toContain("<$1");
  });

  it("prints a nonzero share below 0.05% as <0.1%", () => {
    const sliver = makeCoin({ id: "trusd-tori", name: "trUSD", symbol: "trUSD", supplyUsd: 764_201, chainShare: RatioSchema.parse(0.0001364) });
    const leader = makeCoin({ supplyUsd: 5_598_729_074, chainShare: RatioSchema.parse(0.9998636) });
    render(<CompositionSection model={buildChainRouteViewModel([leader, sliver], leader.supplyUsd + sliver.supplyUsd)} />);

    expect(screen.getAllByText(/<0\.1%/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^0\.0%/)).toBeNull();
  });

  it("keeps a positive pooled rest total out of the $0 bucket", () => {
    const coins = [
      ...Array.from({ length: 10 }, (_, index) => makeCoin({
        id: `large-${index}`,
        name: `Large ${index}`,
        symbol: `L${index}`,
        supplyUsd: 100,
        chainShare: RatioSchema.parse(0.1),
      })),
      makeCoin({ id: "small-a", name: "Small A", symbol: "SA", supplyUsd: 0.05, chainShare: RatioSchema.parse(0.00005) }),
      makeCoin({ id: "small-b", name: "Small B", symbol: "SB", supplyUsd: 0.0405, chainShare: RatioSchema.parse(0.00004) }),
    ];
    render(<CompositionSection model={buildChainRouteViewModel(coins, coins.reduce((sum, coin) => sum + coin.supplyUsd, 0))} />);

    const others = screen.getByText("+2 others").parentElement!;
    expect(others.textContent).toContain("<0.1%");
    expect(others.textContent).toContain("<$1");
    expect(others.textContent).not.toContain("$0");
  });
});

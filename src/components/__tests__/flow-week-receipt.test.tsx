// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FlowWeekReceipt } from "@/components/flow-week-receipt";
import { makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";

describe("FlowWeekReceipt", () => {
  it("carries the week (the hero owns the 24h receipt), the leaders and the scope caveat", () => {
    const { container } = render(
      <FlowWeekReceipt
        coins={[
          makeMintBurnFlowCoin({ stablecoinId: "usdc-circle", symbol: "USDC", netFlow24hUsd: 25_000_000, netFlow7dUsd: 40_000_000 }),
          makeMintBurnFlowCoin({ stablecoinId: "usdt-tether", symbol: "USDT", netFlow24hUsd: -9_000_000, netFlow7dUsd: -5_000_000 }),
        ]}
        weeklyHourly={[
          { hourTs: 1, mintVolumeUsd: 10_000_000, burnVolumeUsd: 3_000_000, netFlowUsd: 7_000_000, valuation: "complete" },
        ]}
        scopeLabel="Configured issuance chains"
      />,
    );

    expect(screen.getByText("Printed 7d")).toBeTruthy();
    expect(screen.getByText("$10.00M")).toBeTruthy();
    expect(screen.getByText("Shredded 7d")).toBeTruthy();
    expect(screen.getByText("$3.00M")).toBeTruthy();
    expect(screen.getByText("+$35.00M")).toBeTruthy();
    expect(container.textContent).not.toMatch(/Printed 24h|Shredded 24h|Net 24h/);
    // Leaders share the fold's 7-day window.
    expect(screen.getByText("Top net minter, 7d")).toBeTruthy();
    expect(screen.getByText("USDC +$40.00M")).toBeTruthy();
    expect(screen.getByText("USDT -$5.00M")).toBeTruthy();
    expect(screen.getByText("Coverage metadata unavailable")).toBeTruthy();
    expect(screen.getByText(/not market-wide supply creation or redemption/)).toBeTruthy();
  });

  it("renders weekly volumes as NR without hourly data, never $0", () => {
    render(<FlowWeekReceipt coins={[makeMintBurnFlowCoin()]} weeklyHourly={[]} scopeLabel="Configured issuance chains" />);

    expect(screen.getAllByText("NR")).toHaveLength(2);
    expect(screen.queryByText("$0.00")).toBeNull();
  });
});

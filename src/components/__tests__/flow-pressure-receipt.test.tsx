// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FlowPressureReceipt } from "@/components/flow-pressure-receipt";
import type { MintBurnCoinFlow, MintBurnGauge, MintBurnHourlyBucket } from "@shared/types";

afterEach(() => cleanup());

const gauge: MintBurnGauge = {
  score: 12,
  band: "normal",
  flightToQuality: false,
  flightIntensity: 0,
  trackedCoins: 2,
  trackedMcapUsd: 80_000_000_000,
};

function coin(symbol: string, netFlow24hUsd: number): MintBurnCoinFlow {
  return {
    stablecoinId: symbol.toLowerCase(),
    symbol,
    flowIntensity: 0,
    netFlow24hUsd,
    mintVolume24hUsd: netFlow24hUsd > 0 ? netFlow24hUsd : 0,
    burnVolume24hUsd: netFlow24hUsd < 0 ? Math.abs(netFlow24hUsd) : 0,
    mintCount24h: netFlow24hUsd > 0 ? 1 : 0,
    burnCount24h: netFlow24hUsd < 0 ? 1 : 0,
    netFlow7dUsd: netFlow24hUsd * 2,
    netFlow30dUsd: netFlow24hUsd * 3,
    netFlow90dUsd: netFlow24hUsd * 4,
    largestEvent24h: null,
    coverage: {
      startBlock: 1,
      lastSyncedBlock: 2,
      lagBlocks: null,
      historyStartAt: 1_700_000_000,
      has24hWindow: true,
      has30dWindow: true,
      has90dWindow: true,
      isPartial: false,
      status: "full",
    },
  };
}

describe("FlowPressureReceipt", () => {
  it("renders exact receipt rows and the configured-chain scope caveat", () => {
    const weeklyHourly: MintBurnHourlyBucket[] = [
      { hourTs: 1, mintVolumeUsd: 10_000_000, burnVolumeUsd: 3_000_000, netFlowUsd: 7_000_000 },
    ];

    render(createElement(FlowPressureReceipt, {
      gauge,
      coins: [coin("USDC", 25_000_000), coin("DAI", -9_000_000)],
      weeklyHourly,
      scopeLabel: "Configured issuance chains",
      syncWarning: null,
    }));

    expect(screen.getByRole("heading", { name: "Printer and shredder accounting" })).toBeTruthy();
    expect(screen.getByText("Printed 24h")).toBeTruthy();
    expect(screen.getByText("Shredded 24h")).toBeTruthy();
    expect(screen.getByText("Configured issuance chains")).toBeTruthy();
    expect(screen.getByText(/not market-wide supply creation or redemption/i)).toBeTruthy();
    expect(screen.getByText(/USDC/)).toBeTruthy();
    expect(screen.getByText(/DAI/)).toBeTruthy();
  });
});

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { MintBurnCoinFlow, MintBurnGauge } from "@shared/types";
import { FlowBrrrOverview } from "@/components/flow-brrr-overview";
import { MINT_BURN_COVERAGE_UNKNOWN_NOTE } from "@shared/lib/mint-burn-valuation-display";
import { formatSignedCurrency } from "@shared/lib/format";

vi.mock("@/components/flow-machine-scene", () => ({
  FlowMachineScene: ({ statusText }: { statusText: string }) => <div role="status">{statusText}</div>,
}));
afterEach(cleanup);

function legacyCoin(netFlow24hUsd: number): MintBurnCoinFlow {
  return {
    stablecoinId: "test", symbol: "TEST", has24hActivity: true,
    mintVolume24hUsd: 200 + Math.max(netFlow24hUsd, 0),
    burnVolume24hUsd: 200 + Math.max(-netFlow24hUsd, 0),
    mintCount24h: 1, burnCount24h: 1, netFlow24hUsd,
    netFlow7dUsd: netFlow24hUsd, netFlow30dUsd: netFlow24hUsd, netFlow90dUsd: netFlow24hUsd,
    netFlowDirection24h: null, pressureShiftScore: null, pressureShiftState: "nr",
    baselineDailyNetUsd: null, baselineDailyAbsUsd: null, baselineDataDays: null, largestEvent24h: null,
    valuation: {
      window24h: { completeness: "unknown", mintCompleteness: "unknown", burnCompleteness: "unknown",
        unpricedMintEventCount: 0, unpricedBurnEventCount: 0 },
      baseline: "unknown", netFlow7d: "unknown", netFlow30d: "unknown", netFlow90d: "unknown",
    },
  };
}

describe("FlowBrrrOverview", () => {
  it.each([100, -100, 0])("keeps the unknown-coverage net %s visible without inventing a scene direction", (net) => {
    const { container } = render(<FlowBrrrOverview gauge={null} coins={[legacyCoin(net)]} />);
    expect(screen.getByRole("status").textContent).toBe("Net direction unavailable");
    expect(container.textContent).toContain("coverage unknown");
    expect(container.textContent).toContain("$");
    expect(container.textContent).not.toContain("Net minting");
    expect(container.textContent).not.toContain("Net burning");
    expect(container.textContent).not.toContain("Balanced flow");
    const signedNet = [...container.querySelectorAll("[title]")]
      .find((node) => node.getAttribute("title") === MINT_BURN_COVERAGE_UNKNOWN_NOTE);
    expect(signedNet?.textContent).toContain(formatSignedCurrency(net));
    expect(signedNet?.textContent).toContain("*");
  });

  it("keeps a mild worsening calm and reserves the red tint for the STRESS/CRISIS bands", () => {
    const gauge = (score: number, band: string) =>
      ({ score, band, intensitySemantics: "signed-v2", flightToQuality: false, flightIntensity: null,
        trackedCoins: 1, trackedMcapUsd: 1 }) as MintBurnGauge;
    const mild = render(<FlowBrrrOverview gauge={gauge(-17, "CAUTIOUS")} coins={[legacyCoin(100)]} />);
    expect(mild.container.querySelector("h3")?.className).toContain("text-foreground");
    const panel = (root: HTMLElement) =>
      root.querySelector('[aria-label="Mint and burn pressure gauges"]')?.firstElementChild?.className ?? "";
    expect(screen.getByText("Pressure worsening").className).toContain("text-amber-700");
    expect(panel(mild.container)).not.toContain("bg-red-500/10");
    mild.unmount();
    const crisis = render(<FlowBrrrOverview gauge={gauge(-80, "CRISIS")} coins={[legacyCoin(-100)]} />);
    expect(crisis.container.querySelector("h3")?.className).toContain("text-foreground");
    expect(screen.getByText("Pressure worsening").className).toContain("text-red-700");
    expect(panel(crisis.container)).toContain("bg-red-500/10");
  });
});

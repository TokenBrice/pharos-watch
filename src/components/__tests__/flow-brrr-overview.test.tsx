// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { MintBurnCoinFlow } from "@shared/types";
import { FlowBrrrOverview } from "@/components/flow-brrr-overview";
import { MINT_BURN_COVERAGE_UNKNOWN_NOTE } from "@/lib/mint-burn-valuation-display";
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
});

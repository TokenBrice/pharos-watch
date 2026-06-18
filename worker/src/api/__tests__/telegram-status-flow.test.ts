import { describe, it, expect } from "vitest";

import { buildStatusMessage } from "../telegram-webhook-messages";
import type { StatusForCoin } from "../telegram-webhook-status";

function baseStatus(overrides: Partial<StatusForCoin> = {}): StatusForCoin {
  return {
    stablecoinId: "usdc-circle",
    priceUsd: 1,
    priceUpdatedAt: Math.floor(Date.now() / 1000),
    supplyUsd: null,
    stablecoinsUpdatedAt: null,
    dews: null,
    safety: null,
    liquidity: null,
    yield: null,
    flow: null,
    depeg: { status: "stable" },
    ...overrides,
  };
}

describe("buildStatusMessage 24h mint/burn flow line (C122)", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  it("renders a signed Flow 24h line when flow is present", () => {
    const msg = buildStatusMessage(
      "USDC",
      baseStatus({ flow: { netFlowUsd: 12_300_000, updatedAt: nowSec, stale: false } }),
    );
    expect(msg).toContain("Flow 24h: +$12");
  });

  it("renders $0 for zero net flow (tracked coin, no events)", () => {
    const msg = buildStatusMessage(
      "USDC",
      baseStatus({ flow: { netFlowUsd: 0, updatedAt: nowSec, stale: false } }),
    );
    expect(msg).toContain("Flow 24h: $0");
  });

  it("renders a negative net flow with a minus sign", () => {
    const msg = buildStatusMessage(
      "USDC",
      baseStatus({ flow: { netFlowUsd: -4_000_000, updatedAt: nowSec, stale: false } }),
    );
    expect(msg).toContain("Flow 24h: -$4");
  });

  it("omits the line for untracked coins (flow null), without an n/a placeholder", () => {
    const msg = buildStatusMessage("USDC", baseStatus({ flow: null }));
    expect(msg).not.toContain("Flow 24h");
  });
});

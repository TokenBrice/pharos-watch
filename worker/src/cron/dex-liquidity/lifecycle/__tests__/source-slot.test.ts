import { describe, expect, it } from "vitest";
import { decideDexLiquiditySourceSlot, dexLiquidityStageSourceSlotForConsumerSlot } from "../source-slot";

describe("DEX source-slot lifecycle", () => {
  it.each([
    ["writing", true, null, false, "wait"],
    ["failed", true, null, true, "wait"],
    ["failed", false, null, false, "recover"],
    ["missing", false, null, true, "recover"],
    ["ready", false, null, false, "consume"],
    ["consumed", false, "dex-liquidity-10", false, "reuse"],
    ["ready", false, "dex-liquidity-10", false, "reuse"],
  ] as const)("decides source state %s with live=%s and accepted=%s", (manifestState, activeStageRun, accepted, expired, action) => {
    expect(decideDexLiquiditySourceSlot({
      manifestState, activeStageRun, syncStartedAt: 10, lastStageRunStatus: null,
    }, accepted, expired)).toMatchObject({ action });
  });

  it.each([16, 46])("maps the :%i consumer to the same hour's :10 producer", (minute) => {
    const consumerSlot = Date.UTC(2026, 9, 18, 10, minute) / 1000;
    const sourceSlot = Date.UTC(2026, 9, 18, 10, 10) / 1000;

    expect(dexLiquidityStageSourceSlotForConsumerSlot(consumerSlot)).toBe(sourceSlot);
  });
});

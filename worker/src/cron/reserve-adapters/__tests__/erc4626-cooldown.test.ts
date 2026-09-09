import { beforeEach, describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem/utils";
import { jsonResponse } from "@shared/test-utils/mock-fetch";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { resetRpcMocks } from "./helpers/rpc-mock";
import { mockErc4626Rpc, runTrackedVault } from "./erc4626-single-asset.test-support";

const cooldownSelector = toFunctionSelector("cooldownDuration()");
const windowSelector = toFunctionSelector("getUnstakeWindow()");
const withLocks = (config: LiveReservesConfig): LiveReservesConfig => ({
  ...config,
  params: { ...config.params, redemptionLock: [
    { selector: "cooldownDuration()", kind: "cooldown-seconds" },
    { selector: windowSelector, kind: "unstake-window-seconds" },
    { selector: "paused()", kind: "paused-bool" },
  ] },
});
function mockLocks(cooldown: bigint | null, paused = 0, window = 172800) {
  mockErc4626Rpc({ idleBalance: 100_000_000n, paused, extraHandlers: [({ call }) => {
    if (call?.data !== cooldownSelector && call?.data !== windowSelector) return undefined;
    const value = call.data === cooldownSelector ? cooldown : BigInt(window);
    return value == null ? null : jsonResponse({ result: `0x${value.toString(16).padStart(64, "0")}` });
  }] });
}

describe("ERC4626 redemption locks", () => {
  beforeEach(resetRpcMocks);
  it("bounds fully backed capacity by the live cooldown, without adding the withdrawal window", async () => {
    mockLocks(1728000n);
    const result = await runTrackedVault("syrupusdc-maple", withLocks);
    expect(result.metadata?.redemption).toMatchObject({ capacityKind: "documented-bound", capacityRatioOfSupply: 1, settlementDelaySec: 1728000, routeStatus: "open" });
    expect(result.metadata?.unstakeWindowSec).toBe(172800);
  });
  it("publishes paused evidence as degraded without losing reserve composition", async () => {
    mockLocks(86400n, 1);
    const result = await runTrackedVault("syrupusdc-maple", withLocks);
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "paused", settlementDelaySec: 86400 });
    expect(result.slices).toEqual([expect.objectContaining({ pct: 100 })]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "erc4626-redemption-paused", effect: "degraded" }));
  });
  it("does not invent a lock when no lock is configured", async () => {
    mockErc4626Rpc({ idleBalance: 100_000_000n });
    const result = await runTrackedVault("syrupusdc-maple");
    expect(result.metadata?.redemption).toMatchObject({ capacityKind: "live-direct", routeStatus: "open" });
    expect(result.metadata?.redemption).not.toHaveProperty("settlementDelaySec");
  });
  it("permits immediate redemption when both cooldown and window are disabled", async () => {
    mockLocks(0n, 0, 0);
    const result = await runTrackedVault("syrupusdc-maple", withLocks);
    expect(result.metadata?.redemption).toMatchObject({ capacityKind: "live-direct", settlementDelaySec: 0 });
  });
  it("does not present asynchronous request backing as executable redemption capacity", async () => {
    mockErc4626Rpc({ idleBalance: 100_000_000n });
    const result = await runTrackedVault("syrupusdc-maple", (config) => ({
      ...config, params: { ...config.params, redemptionRoute: "async-request" },
    }));
    expect(result.metadata?.redemption).toMatchObject({
      capacityKind: "documented-bound", settlementBoundUnproven: true, capacityRatioOfSupply: 1,
    });
    expect(result.metadata?.redemption).not.toHaveProperty("settlementDelaySec");
  });
  it("does not interpret a malformed pause word as an open or paused route", async () => {
    mockLocks(86400n, 2);
    await expect(runTrackedVault("syrupusdc-maple", withLocks)).rejects.toThrow(/redemption lock paused\(\) unreadable/);
  });
  it.each([null, 2n ** 200n])("rejects unreadable or unsafe lock durations (%s)", async (cooldown) => {
    mockLocks(cooldown);
    await expect(runTrackedVault("syrupusdc-maple", withLocks)).rejects.toThrow(/redemption lock.*malformed or unreadable/);
  });
});

import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem/utils";
import { jsonResponse } from "@shared/test-utils/mock-fetch";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { installErc4626Network, runTrackedVault } from "./erc4626-single-asset.test-support";
import { resolveRedemptionCapacity } from "../../../lib/redemption-backstop/capacity";
import { liveSnapshot } from "../../../lib/__tests__/redemption-backstop-sources.test-support";

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
  installErc4626Network({ idleBalance: 100_000_000n, paused, extraHandlers: [({ call }) => {
    if (call?.data !== cooldownSelector && call?.data !== windowSelector) return undefined;
    const value = call.data === cooldownSelector ? cooldown : BigInt(window);
    return value == null ? null : jsonResponse({ result: `0x${value.toString(16).padStart(64, "0")}` });
  }] });
}

describe("ERC4626 redemption locks", () => {
  it("bounds fully backed capacity by the live cooldown, without adding the withdrawal window", async () => {
    mockLocks(1728000n);
    const result = await runTrackedVault("syrupusdc-maple", withLocks);
    expect(result.metadata?.redemption).toMatchObject({ capacityKind: "documented-bound", capacityRatioOfSupply: 1, settlementDelaySec: 1728000, routeStatus: "open", routeStatusSource: "onchain" });
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
    installErc4626Network({ idleBalance: 100_000_000n });
    const result = await runTrackedVault("syrupusdc-maple");
    expect(result.metadata?.redemption).toMatchObject({ capacityKind: "live-direct", routeStatus: "unknown" });
    expect(result.metadata?.redemption).not.toHaveProperty("settlementDelaySec");
  });
  it("permits immediate redemption when both cooldown and window are disabled", async () => {
    mockLocks(0n, 0, 0);
    const result = await runTrackedVault("syrupusdc-maple", withLocks);
    expect(result.metadata?.redemption).toMatchObject({ capacityKind: "live-direct", settlementDelaySec: 0 });
  });
  it("does not present asynchronous request backing as executable redemption capacity", async () => {
    installErc4626Network({ idleBalance: 100_000_000n });
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

describe("ERC4626 asset-targeted redemption locks", () => {
  const fxSave = "0x7743e50f534a7f9f1791dde7dcd89f7783eefc39";
  const fxSp = "0x65c9a641afceb9c0e6034e558a319488fa0fa3be";
  const coolDownSelector = toFunctionSelector("redeemCoolDownPeriod()");
  function mockFxSave(cooldown: bigint | null) {
    installErc4626Network({
      vault: fxSave, asset: fxSp, decimals: 18, idleBalance: 0n,
      totalAssets: 70n * 10n ** 24n, totalSupply: 63n * 10n ** 24n, convertedAssets: 70n * 10n ** 24n,
      extraHandlers: [({ call }) => {
        if (call?.data !== coolDownSelector) return undefined;
        // Only the underlying fxSP pool exposes the cooldown getter.
        if (call.to?.toLowerCase() !== fxSp || cooldown == null) return null;
        return jsonResponse({ result: `0x${cooldown.toString(16).padStart(64, "0")}` });
      }],
    });
  }

  it("reads the fxSP cooldown from the reviewed asset and bounds full backing instead of zero idle", async () => {
    mockFxSave(3600n);
    const result = await runTrackedVault("fxsave-f-x-protocol");
    expect(result.metadata?.redemption).toMatchObject({
      capacityKind: "documented-bound", capacityRatioOfSupply: 1, settlementDelaySec: 3600,
    });
  });
  it("publishes non-par fxSP units as a ratio that the consumer values against USD supply", async () => {
    mockFxSave(3600n);
    const result = await runTrackedVault("fxsave-f-x-protocol");
    // 70M fxSP units are not $70M; withholding the unit amount keeps the
    // consumer from reading 70M / 72.8M (96.15%) instead of the measured 100%.
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
    const now = Math.floor(Date.now() / 1_000);
    const supplyUsd = 72_800_000;
    const capacity = await resolveRedemptionCapacity(
      {} as D1Database, "fxsave-f-x-protocol", { kind: "reserve-sync-metadata" }, supplyUsd, now,
      { reserveSnapshotMetadata: liveSnapshot("fxsave-f-x-protocol", {
        ...result.metadata, freshnessMode: "not-applicable",
      }, { fetchedAt: now - 60, source: "erc4626-single-asset", sourceModel: "single-bucket" }) },
    );
    expect(capacity.immediateCapacityUsd).toBe(supplyUsd);
    expect(capacity.immediateCapacityRatio).toBe(1);
  });
  it("fails closed when the asset cooldown is unreadable", async () => {
    mockFxSave(null);
    await expect(runTrackedVault("fxsave-f-x-protocol")).rejects.toThrow(/redemption lock.*malformed or unreadable/);
  });
  it("rejects an asset-targeted lock without a reviewed expected asset", async () => {
    mockFxSave(3600n);
    await expect(runTrackedVault("fxsave-f-x-protocol", (config) => ({
      ...config,
      params: { ...config.params, slice: { name: "fxSP stability-pool shares", risk: "medium" } },
    }))).rejects.toThrow(/expectedAssetAddress/);
  });
});

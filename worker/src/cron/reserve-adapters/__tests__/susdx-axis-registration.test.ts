import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StablecoinMetaAssetSchema } from "@shared/lib/stablecoins/schema";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { REDEMPTION_BACKSTOP_POLICY_ENTRIES } from "@shared/lib/redemption-backstop-configs/policies";
import { resolveRedemptionCapacity } from "../../../lib/redemption-backstop/capacity";
import { liveSnapshot } from "../../../lib/__tests__/redemption-backstop-sources.test-support";
import type { AdapterRpcValue } from "./reserve-adapter.test-support";
import { runAdapter } from "./reserve-adapter.test-support";

const coin = StablecoinMetaAssetSchema.parse({
  ...JSON.parse(readFileSync("shared/data/stablecoins/coins/susdx-axis.json", "utf8")),
  ...JSON.parse(readFileSync("shared/data/stablecoins/domains/reserves/susdx-axis.json", "utf8")),
});
const VAULT = "0xeb892628d1e58bc475a6dcb7f5dbc4f591632aa4";
const ASSET = "0xa1fa7777974312f7d801a8880714a218f76233f8";
const TOTAL_ASSETS = "0x00000000000000000000000000000000000000000022bce5aa4731bab0c0b143";
const TOTAL_SUPPLY = "0x0000000000000000000000000000000000000000002192c0a30a2c3c525fac8e";
const BALANCE = "0x0000000000000000000000000000000000000000002418311ff94d58cc0d0ac0";
const CONVERT_SUPPLY = `0x07a2d13a${BigInt(TOTAL_SUPPLY).toString(16).padStart(64, "0")}`;
const BALANCE_CALL = `0x70a08231${VAULT.slice(2).padStart(64, "0")}`;
const block = { number: 26143058, timestamp: 1791406799, hash: "0x30c540e0d79bcb658b321dd9d310c4bf000c048981907a0edc434d9d07f28941" };

// Raw asset/supply/active-assets/held-cash/decimals/cooldown captures:
// keyless Dwellir block 26143058, 2026-10-07T20:59:59Z; observations captured
// at 21:00:37.560Z and 21:01:21.675Z (RS7 axis-accounting/claim-book pins).
// Whole-supply conversion is a synthetic consistency boundary (the saved
// conversion call observed one WAD). Unknown pause and reverted previews are
// explicit negative boundary fixtures, not claims of observed route openness.
function run(overrides: Record<string, AdapterRpcValue> = {}) {
  return runAdapter("erc4626-single-asset", coin, {
    nowSec: block.timestamp + 60,
    ctx: { observedBlock: { chain: "ethereum", ...block } },
    network: {
      block,
      rpc: {
        [`${VAULT}:0x38d52e0f`]: `0x${ASSET.slice(2).padStart(64, "0")}`,
        [`${VAULT}:0x01e1d114`]: TOTAL_ASSETS,
        [`${VAULT}:0x18160ddd`]: TOTAL_SUPPLY,
        [`${VAULT}:${CONVERT_SUPPLY}`]: TOTAL_ASSETS,
        [`${ASSET}:${BALANCE_CALL}`]: BALANCE,
        [`${ASSET}:0x313ce567`]: 18n,
        [`${VAULT}:0x313ce567`]: 18n,
        [`${VAULT}:cooldownDuration()`]: 604800n,
        [`${VAULT}:0x5c975abb`]: null,
        [`${VAULT}:previewRedeem(uint256)`]: null,
        [`${VAULT}:previewWithdraw(uint256)`]: null,
        ...overrides,
      },
    },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("sUSDx registered active-share USDx reader", () => {
  it("admits one reviewed wrapper category from active assets, not full cash or queued liabilities", async () => {
    const { result, network } = await run();
    expect(result.slices).toMatchObject([{
      sourceKey: `erc4626-single-asset:ethereum:${ASSET}`,
      pct: 100, coinId: "usdx-axis", depType: "wrapper", risk: "high",
    }]);
    expect(result.slices).toHaveLength(1);
    expect(coin.reserves?.map(({ sourceKey }) => sourceKey)).toContain(result.slices[0].sourceKey);
    expect(result.metadata?.totalAssetsRaw).toBe(BigInt(TOTAL_ASSETS).toString());
    expect(result.metadata?.unknownExposurePct).toBe(0);
    expect(result.metadata?.redemption).toMatchObject({
      capacityKind: "documented-bound", settlementBoundUnproven: true, routeStatus: "unknown",
      settlementDelaySec: 604800,
    });
    const config = getRedemptionBackstopConfig("susdx-axis");
    expect(config?.capacityModel.kind).toBe("unquantified");
    expect(REDEMPTION_BACKSTOP_POLICY_ENTRIES).toContainEqual(expect.objectContaining({
      kind: "unused-live-redemption-telemetry", stablecoinId: "susdx-axis",
    }));
    const db = { prepare: () => { throw new Error("Unquantified active-share route must not query capacity"); } } as unknown as D1Database;
    const capacity = await resolveRedemptionCapacity(db, "susdx-axis", config!.capacityModel, 100_000_000, block.timestamp + 60, {
      reserveSnapshotMetadata: liveSnapshot("susdx-axis", result.metadata, {
        fetchedAt: block.timestamp + 60, source: "erc4626-single-asset",
      }),
    });
    expect(capacity).toMatchObject({
      immediateCapacityUsd: null, scoringCapacityUsd: null, eventualCapacityUsd: null,
      resolutionState: "missing-capacity",
    });
    expect(network.rpcCalls.some(({ selector }) => selector === "0x4cdad506" || selector === "0x0a28a477")).toBe(false);
  });

  it("withholds the snapshot for an asset identity mismatch", async () => {
    await expect(run({ [`${VAULT}:0x38d52e0f`]: "0x1111111111111111111111111111111111111111" })).rejects.toThrow();
  });

  it("withholds unreadable active-share assets instead of importing the full cash balance", async () => {
    await expect(run({ [`${VAULT}:0x01e1d114`]: null })).rejects.toThrow();
  });

  it("withholds unreadable configured cooldown rather than claiming a settlement bound", async () => {
    await expect(run({ [`${VAULT}:cooldownDuration()`]: null })).rejects.toThrow();
  });

  it("retains an unattributed strategy remainder if current cash falls below active assets", async () => {
    const { result } = await run({ [`${ASSET}:${BALANCE_CALL}`]: BigInt(TOTAL_ASSETS) / 2n });
    expect(result.slices.filter(({ coinId }) => coinId === "usdx-axis")[0].pct).toBeLessThan(100);
    expect(result.slices.find(({ coinId }) => coinId === undefined)?.risk).toBe("high");
    expect(Number(result.metadata?.unknownExposurePct)).toBeGreaterThan(0);
  });
});

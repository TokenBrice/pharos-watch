import { describe, expect, it } from "vitest";
import { runAdapter, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const ADDRESSES = {
  hub: "0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF",
  baseToken: "0x46850aD61C2B7d64d08c9C754F45254596696984",
  implementation: "0xe6ee2cd3e4f2b3844689aa1be176e4dff744a6f9",
  otherToken: "0x00000000000000000000000000000000000000ab",
} as const;

const TOTAL_SUPPLY = 200_750_740_926_947_878_099_813_249n;
const BRIDGED_SUPPLY = 2_135_653_492_985_000_000_000_000n;
const PYUSD_BALANCE = 202_886_394_432_337n;
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BALANCE_CALL = `0x70a08231${ADDRESSES.hub.slice(2).toLowerCase().padStart(64, "0")}`;
const MALFORMED_BOOL = `0x${"12".repeat(33)}`;


function usdaiNetwork(overrides: {
  baseToken?: string;
  balance?: bigint;
  totalSupply?: bigint;
  bridgedSupply?: bigint;
  paused?: bigint | string;
  implementation?: string;
} = {}): AdapterNetworkSpec {
  return {
    rpc: {
      [`${ADDRESSES.hub}:0xc55dae63`]: overrides.baseToken ?? ADDRESSES.baseToken,
      [`${ADDRESSES.baseToken}:${BALANCE_CALL}`]: overrides.balance ?? PYUSD_BALANCE,
      [`${ADDRESSES.hub}:0x18160ddd`]: overrides.totalSupply ?? TOTAL_SUPPLY,
      [`${ADDRESSES.hub}:0x11c301e0`]: overrides.bridgedSupply ?? BRIDGED_SUPPLY,
      [`${ADDRESSES.hub}:0x5c975abb`]: overrides.paused ?? 0n,
      [`${ADDRESSES.hub}:${IMPLEMENTATION_SLOT}`]: overrides.implementation ?? ADDRESSES.implementation,
    },
  };
}

async function fetchFixture(overrides: Parameters<typeof usdaiNetwork>[0] = {}) {
  return runAdapter("usdai-hub", "usdai-usd-ai", {
    network: usdaiNetwork(overrides),
    nowSec: 1_757_000_000,
  });
}

describe("usdai-hub adapter", () => {
  it("emits the measured 100% PYUSD slice and complete bridge-safe liability", async () => {
    const { result } = await fetchFixture();

    expect(result.slices).toEqual([
      {
        name: "PYUSD held by the canonical USDai hub",
        pct: 100,
        risk: "low",
        coinId: "pyusd-paypal",
        depType: "collateral",
      },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalSupplyRaw: TOTAL_SUPPLY.toString(),
      supplyUsd: 202_886_394.41993288,
      totalReserveUsd: 202_886_394.432337,
      collateralizationRatio: expect.closeTo(1.000000000061126, 12),
      details: {
        bridgedSupplyRaw: BRIDGED_SUPPLY.toString(),
        bridgeSafeLiabilityRaw: (TOTAL_SUPPLY + BRIDGED_SUPPLY).toString(),
        paused: false,
      },
      redemption: {
        capacityUsd: 202_886_394.432337,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
      },
    });
  });

  it("keeps bridge-safe coverage at one while a transfer advances the head", async () => {
    let head = 100;
    const spec = usdaiNetwork({ balance: 100_000000n, totalSupply: 100n * 10n ** 18n, bridgedSupply: 0n });
    spec.block = { number: 100, timestamp: 1_757_000_000 };
    spec.rpc!["eth_getBlockByNumber:latest"] = () => ({ number: head++, timestamp: 1_757_000_000 });
    spec.rpc![`${ADDRESSES.hub}:0x18160ddd`] = ({ block }) => {
      const number = block === "latest" ? head : Number.parseInt(block.slice(2), 16);
      head += 1;
      return (number === 100 ? 100n : 80n) * 10n ** 18n;
    };
    spec.rpc![`${ADDRESSES.hub}:0x11c301e0`] = ({ block }) =>
      (block === "0x64" ? 0n : 20n) * 10n ** 18n;
    const { result, network } = await runAdapter("usdai-hub", "usdai-usd-ai", { network: spec, nowSec: 1_757_000_000 });
    expect(head).toBeGreaterThan(100);
    expect(result.metadata).toMatchObject({
      collateralizationRatio: 1,
      supplyUsd: 100,
      observedBlock: { chain: "arbitrum", number: 100, timestamp: 1_757_000_000 },
    });
    expect(network.rpcCalls.some((call) => call.method === "eth_getStorageAt")).toBe(true);
    expect(new Set(network.rpcCalls.map((call) => call.block))).toEqual(new Set(["0x64"]));
  });

  it("retains the original implementation and adverse pause when latest crosses an upgrade", async () => {
    const spec = usdaiNetwork();
    spec.block = { number: 100, timestamp: 1_757_000_000 };
    spec.rpc![`${ADDRESSES.hub}:${IMPLEMENTATION_SLOT}`] = ({ block }) =>
      block === "0x64" ? ADDRESSES.implementation : ADDRESSES.otherToken;
    spec.rpc![`${ADDRESSES.hub}:0x5c975abb`] = ({ block }) => block === "0x64" ? 1n : 0n;
    const { result } = await runAdapter("usdai-hub", "usdai-usd-ai", { network: spec, nowSec: 1_757_000_000 });
    expect(result.metadata?.details).toMatchObject({ implementationAddress: ADDRESSES.implementation, paused: true });
    expect(result.metadata?.redemption?.routeStatus).toBe("paused");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "route-paused", effect: "degraded" }));
  });

  it("withholds the observation when its numeric supply read is unavailable", async () => {
    const spec = usdaiNetwork();
    spec.block = { number: 100, timestamp: 1_757_000_000 };
    spec.rpc![`${ADDRESSES.hub}:0x18160ddd`] = ({ block }) => block === "latest" ? TOTAL_SUPPLY : null;
    await expect(runAdapter("usdai-hub", "usdai-usd-ai", { network: spec, nowSec: 1_757_000_000 }))
      .rejects.toThrow("totalSupply() returned malformed");
  });

  it("fails closed when baseToken() does not resolve to the pinned PYUSD", async () => {
    await expect(fetchFixture({ baseToken: ADDRESSES.otherToken })).rejects.toThrow("baseToken() identity mismatch");
  });

  it("fails closed when the implementation slot drifts", async () => {
    await expect(fetchFixture({ implementation: ADDRESSES.otherToken })).rejects.toThrow("EIP-1967 implementation identity mismatch");
  });

  it("publishes PYUSD below bridge-safe liabilities as degraded", async () => {
    const { result } = await fetchFixture({ balance: PYUSD_BALANCE - 20_000n });
    expect(result.slices[0].pct).toBe(100);
    expect(result.metadata?.collateralizationRatio).toBeLessThan(1);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" }));
  });

  it("preserves redemption telemetry and marks a paused hub as paused", async () => {
    const { result } = await fetchFixture({ paused: 1n });

    expect(result.slices).toHaveLength(1);
    expect(result.metadata?.redemption).toMatchObject({
      routeStatus: "paused",
      routeStatusSource: "onchain",
      routeStatusReason: "USDai hub paused() returned true on-chain",
      capacityUsd: 202_886_394.432337,
    });
    expect(result.metadata?.details).toMatchObject({ paused: true });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "route-paused", effect: "degraded" }));
  });

  it("rejects malformed ABI payloads instead of publishing a partial snapshot", async () => {
    await expect(fetchFixture({ paused: MALFORMED_BOOL })).rejects.toThrow("paused() returned malformed bool payload");
  });

  it("retains bridged liabilities when canonical supply is zero", async () => {
    const { result } = await fetchFixture({ totalSupply: 0n });
    expect(result.metadata?.supplyUsd).toBe(Number(BRIDGED_SUPPLY) / 1e18);
  });

  it("publishes zero total liabilities without inventing a ratio", async () => {
    const { result } = await fetchFixture({ totalSupply: 0n, bridgedSupply: 0n });
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ effect: "degraded" }));
  });
});

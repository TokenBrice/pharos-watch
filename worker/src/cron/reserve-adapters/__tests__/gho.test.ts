import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { encodeAddress, encodeUint256 } from "../../../lib/evm-selectors";
import { adaptGhoFacilitators, type GhoFacilitatorData } from "../gho";
import type { AdapterNetworkSpec, AdapterRpcCall } from "./reserve-adapter.test-support";
import { runAdapter } from "./reserve-adapter.test-support";

const CORE = "0x1111111111111111111111111111111111111111";
const GSM = "0x2222222222222222222222222222222222222222";
const MODULE = "0x3333333333333333333333333333333333333333";
const GHO_TOKEN = "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f";
const UNIT = 10n ** 18n;
function sample(): GhoFacilitatorData {
  return {
    facilitators: [
      { address: CORE, label: "CoreGhoDirectMinter", bucketLevel: 100n * UNIT, bucketCapacity: 200n * UNIT },
      { address: GSM, label: "GhoDirectFacilitator GSMs Mainnet", bucketLevel: 100n * UNIT, bucketCapacity: 200n * UNIT },
    ],
    trackedModules: [{
      address: MODULE, facilitatorAddress: GSM, label: "USDC GSM", coinId: "usdc-circle", depType: "collateral",
      risk: "low", currentBackingGho: 100n * UNIT, isFrozen: false, isSeized: false, buyFeeBps: 7,
    }],
    totalSupply: 200n * UNIT,
  };
}

const CONFIG: LiveReservesConfig = {
  adapter: "gho", version: 2, semantics: "protocol-reserve",
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
  params: { gsmModules: [{ address: MODULE, facilitatorAddress: GSM, label: "USDC GSM", coinId: "usdc-circle", depType: "collateral" }] },
};
const COIN = { id: "gho-aave", liveReservesConfig: CONFIG } as StablecoinMeta;
function facilitatorResponse(label: string): string {
  const hex = Buffer.from(label).toString("hex");
  return `0x${[32n, 200n * UNIT, 100n * UNIT, 96n, BigInt(label.length)].map(encodeUint256).join("")}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
}

function makeNetwork(options: {
  totalSupply?: bigint;
  frozen?: bigint | null;
  seized?: bigint;
  available?: bigint | null;
} = {}): AdapterNetworkSpec {
  const backing =
    options.available === null
      ? null
      : `0x${encodeUint256(options.available ?? 100n * UNIT)}${encodeUint256(0n)}`;
  return {
    block: { timestamp: 1_800_000_000 },
    rpc: {
      [`ethereum:eth_call:${GHO_TOKEN}:0x18160ddd`]: options.totalSupply ?? 200n * UNIT,
      [`ethereum:eth_call:${GHO_TOKEN}:0x1ec90f2e`]: `0x${encodeUint256(32n)}${encodeUint256(2n)}${encodeAddress(CORE)}${encodeAddress(GSM)}`,
      [`ethereum:eth_call:${GHO_TOKEN}:0xd46ec0ed`]: (call: AdapterRpcCall) =>
        call.data.toLowerCase().includes(CORE.slice(2).toLowerCase())
          ? facilitatorResponse("CoreGhoDirectMinter")
          : facilitatorResponse("GhoDirectFacilitator GSMs Mainnet"),
      [`ethereum:eth_call:${MODULE}:0x9abeb940`]: 0n,
      [`ethereum:eth_call:${MODULE}:0x4101d9f4`]: 0n,
      [`ethereum:eth_call:${MODULE}:0x236fc8ad`]: options.frozen === null ? null : options.frozen ?? 0n,
      [`ethereum:eth_call:${MODULE}:0x476cce03`]: backing,
      [`ethereum:eth_call:${MODULE}:0x80bc659a`]: options.seized ?? 0n,
      "ethereum:eth_call:0x9abeb940": 0n,
      "ethereum:eth_call:0x4101d9f4": 0n,
      "ethereum:eth_call:0x236fc8ad": options.frozen === null ? null : options.frozen ?? 0n,
      "ethereum:eth_call:0x476cce03": backing,
      "ethereum:eth_call:0x80bc659a": options.seized ?? 0n,
    },
  };
}

describe("GHO parent-local exposure", () => {
  it("keeps Core at 50% when GSM replaces its own 100 of 200 issuance", () => {
    const result = adaptGhoFacilitators(sample());
    expect(result.slices.find((slice) => slice.name === "CoreGhoDirectMinter")?.pct).toBe(50);
    expect(result.slices.find((slice) => slice.coinId === "usdc-circle")?.pct).toBe(50);
    expect(result.slices.some((slice) => slice.name === "GhoDirectFacilitator GSMs Mainnet")).toBe(false);
  });

  it("retains uncovered GSM exposure and unobserved issuance as unknown without inflating Core", () => {
    const data = sample();
    data.trackedModules[0].currentBackingGho = 40n * UNIT;
    data.totalSupply = 250n * UNIT;
    const result = adaptGhoFacilitators(data);
    expect(result.slices.find((slice) => slice.name === "CoreGhoDirectMinter")?.pct).toBe(40);
    expect(result.slices.find((slice) => slice.coinId === "usdc-circle")?.pct).toBe(16);
    expect(result.metadata?.unknownExposurePct).toBe(44);
  });

  it("does not attribute backing from a module whose parent is absent", () => {
    const data = sample();
    data.facilitators = data.facilitators.slice(0, 1);
    const result = adaptGhoFacilitators(data);
    expect(result.slices.some((slice) => slice.coinId === "usdc-circle")).toBe(false);
    expect(result.metadata?.unknownExposurePct).toBe(50);
  });

  it("caps combined GSM coverage locally without diluting another facilitator", () => {
    const data = sample();
    data.trackedModules.push({ ...data.trackedModules[0], address: CORE, label: "USDT GSM", coinId: "usdt-tether" });
    const result = adaptGhoFacilitators(data);
    expect(result.slices.find((slice) => slice.name === "CoreGhoDirectMinter")?.pct).toBe(50);
    expect(result.slices.find((slice) => slice.coinId === "usdc-circle")?.pct).toBe(25);
    expect(result.slices.find((slice) => slice.coinId === "usdt-tether")?.pct).toBe(25);
  });

  it("preserves measured issuance but degrades when it exceeds the supply observation", () => {
    const data = sample();
    data.totalSupply = 150n * UNIT;
    const result = adaptGhoFacilitators(data);
    expect(result.metadata?.totalReserveUsd).toBe(200);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "facilitator-issuance-exceeds-supply", effect: "degraded" })]));
  });
});

describe("GHO fetch boundary", () => {
  it("preserves dependency identity and local attribution through RPC decoding", async () => {
    const { result, network } = await runAdapter("gho", COIN, {
      network: makeNetwork(),
      nowSec: 1_800_000_000,
    });
    expect(network.rpcCalls.length).toBeGreaterThan(0);
    expect(result.slices.find((slice) => slice.coinId === "usdc-circle")).toMatchObject({
      sourceKey: "gho:0x3333333333333333333333333333333333333333",
      pct: 50,
      depType: "collateral",
    });
    expect(result.slices.find((slice) => slice.name === "CoreGhoDirectMinter")?.pct).toBe(50);
  });

  it("keeps an unfrozen, unseized route open with zero liquidity", async () => {
    const { result } = await runAdapter("gho", COIN, {
      network: makeNetwork({ available: 0n }),
      nowSec: 1_800_000_000,
    });
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "open", capacityUsd: 0 });
  });

  it("reports unreadable status as unknown, not paused, and excludes capacity", async () => {
    const { result } = await runAdapter("gho", COIN, {
      network: makeNetwork({ frozen: null }),
      nowSec: 1_800_000_000,
    });
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "unknown", capacityUsd: 0 });
  });

  it("does not label all routes paused when another configured module is unreadable", async () => {
    const config = { ...CONFIG, params: { gsmModules: [
      { address: MODULE, facilitatorAddress: GSM, label: "USDC GSM", coinId: "usdc-circle", depType: "collateral" },
      { address: CORE, facilitatorAddress: GSM, label: "Unreadable GSM" },
    ] } };
    const { result } = await runAdapter("gho", { ...COIN, liveReservesConfig: config }, {
      network: makeNetwork({ available: null, seized: 1n }),
      nowSec: 1_800_000_000,
    });
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "unknown", capacityUsd: 0 });
  });

  it("publishes explicit seizure as paused and degraded rather than throwing", async () => {
    const { result } = await runAdapter("gho", COIN, {
      network: makeNetwork({ seized: 1n }),
      nowSec: 1_800_000_000,
    });
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "paused", capacityUsd: 0 });
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "tracked-gsm-seized", effect: "degraded" }),
    ]));
  });
});

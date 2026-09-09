vi.mock("../../../lib/evm-rpc", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/evm-rpc")>(),
  fetchEvmBlockNumber: vi.fn(async () => 123),
  fetchEvmBlockTimestamp: vi.fn(async () => 1_800_000_000),
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { encodeAddress, encodeUint256 } from "../../../lib/evm-selectors";
import { adaptGhoFacilitators, fetchGhoReserves, type GhoFacilitatorData } from "../gho";
import type * as Helpers from "../helpers";

const rpc = vi.hoisted(() => ({ raw: vi.fn(), uint256: vi.fn() }));
vi.mock("../helpers", async () => {
  const actual = await vi.importActual<typeof Helpers>("../helpers");
  // The hoisted mock factory runs before static imports are initialized.
  const { makeOnchainCallersMock } = await import("./helpers/onchain-callers-mock");
  return { ...actual, makeOnchainCallers: makeOnchainCallersMock(rpc) };
});

const CORE = "0x1111111111111111111111111111111111111111";
const GSM = "0x2222222222222222222222222222222222222222";
const MODULE = "0x3333333333333333333333333333333333333333";
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
const COIN = { id: "gho-aave" } as StablecoinMeta;
function facilitatorResponse(label: string): string {
  const hex = Buffer.from(label).toString("hex");
  return `0x${[32n, 200n * UNIT, 100n * UNIT, 96n, BigInt(label.length)].map(encodeUint256).join("")}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
}

beforeEach(() => {
  rpc.uint256.mockReset().mockImplementation(async ({ data }: { data: string }) => data === "0x18160ddd" ? 200n * UNIT : 100n * UNIT);
  rpc.raw.mockReset().mockImplementation(async ({ data }: { data: string }) => {
    if (data === "0x1ec90f2e") return `0x${encodeUint256(32n)}${encodeUint256(2n)}${encodeAddress(CORE)}${encodeAddress(GSM)}`;
    if (data === `0xd46ec0ed${encodeAddress(CORE)}`) return facilitatorResponse("CoreGhoDirectMinter");
    if (data === `0xd46ec0ed${encodeAddress(GSM)}`) return facilitatorResponse("GhoDirectFacilitator GSMs Mainnet");
    if (data === "0x476cce03") return `0x${encodeUint256(0n)}${encodeUint256(0n)}`;
    return `0x${encodeUint256(0n)}`;
  });
});

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
    const result = await fetchGhoReserves(COIN, CONFIG, new AbortController().signal);
    expect(result.slices.find((slice) => slice.coinId === "usdc-circle")).toMatchObject({ pct: 50, depType: "collateral" });
    expect(result.slices.find((slice) => slice.name === "CoreGhoDirectMinter")?.pct).toBe(50);
  });

  it("keeps an unfrozen, unseized route open with zero liquidity", async () => {
    rpc.uint256.mockImplementation(async ({ data }: { data: string }) => data === "0x18160ddd" ? 200n * UNIT : 0n);
    const result = await fetchGhoReserves(COIN, CONFIG, new AbortController().signal);
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "open", capacityUsd: 0 });
  });

  it("reports unreadable status as unknown, not paused, and excludes capacity", async () => {
    const original = rpc.raw.getMockImplementation()!;
    rpc.raw.mockImplementation(async (request: { data: string }) => request.data === "0x236fc8ad" ? null : original(request));
    const result = await fetchGhoReserves(COIN, CONFIG, new AbortController().signal);
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "unknown", capacityUsd: 0 });
  });

  it("does not label all routes paused when another configured module is unreadable", async () => {
    const config = { ...CONFIG, params: { gsmModules: [
      { address: MODULE, facilitatorAddress: GSM, label: "USDC GSM", coinId: "usdc-circle" },
      { address: CORE, facilitatorAddress: GSM, label: "Unreadable GSM" },
    ] } };
    const original = rpc.raw.getMockImplementation()!;
    rpc.raw.mockImplementation(async (request: { contract: string; data: string }) => {
      if (request.contract === CORE && request.data === "0x476cce03") return null;
      if (request.data === "0x80bc659a") return `0x${encodeUint256(1n)}`;
      return original(request);
    });
    const result = await fetchGhoReserves(COIN, config, new AbortController().signal);
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "unknown", capacityUsd: 0 });
  });

  it("publishes explicit seizure as paused and degraded rather than throwing", async () => {
    const original = rpc.raw.getMockImplementation()!;
    rpc.raw.mockImplementation(async (request: { data: string }) => request.data === "0x80bc659a" ? `0x${encodeUint256(1n)}` : original(request));
    const result = await fetchGhoReserves(COIN, CONFIG, new AbortController().signal);
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "paused", capacityUsd: 0 });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "tracked-gsm-seized", effect: "degraded" })]));
  });
});

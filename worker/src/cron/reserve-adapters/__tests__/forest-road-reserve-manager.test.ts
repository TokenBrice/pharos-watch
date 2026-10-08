import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { fetchForestRoadReserveManagerReserves } from "../forest-road-reserve-manager";
import type { OnchainMulticall3Call } from "../onchain";
import type * as EvmRpc from "../../../lib/evm-rpc";
import type * as Onchain from "../onchain";

const transport = vi.hoisted(() => ({ storage: vi.fn(), multicall: vi.fn() }));
vi.mock("../../../lib/evm-rpc", async (importOriginal) => ({
  ...await importOriginal<typeof EvmRpc>(),
  fetchEvmStorageAtBlock: transport.storage,
}));
vi.mock("../onchain", async (importOriginal) => ({
  ...await importOriginal<typeof Onchain>(),
  fetchOnchainMulticall3: transport.multicall,
}));

const MANAGER = "0x8317736611b542ddb4a820fe344b621a904bdd48";
const TOKEN = "0xcc07e7c4e5e35affd47b351e420a22c667d7f83d";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const IMPLEMENTATION = "0x99b4dfa4e1344273d5335bd90de1dea3a02b9c3a";
const BLOCK = { chain: "ethereum", number: 26143056, timestamp: 1791406775 };
const SCALE = 1_000_000_000_000n;
const coin: ReserveAdapterCoin = {
  id: "usdfr-forest-road", name: "Forest Road USDfr", symbol: "USDfr",
  flags: { backing: "rwa-backed", governance: "centralized", rwa: true, pegCurrency: "USD", yieldBearing: false, navToken: false },
  contracts: [{ chain: "ethereum", address: TOKEN, decimals: 18 }],
};
// Wave A deliberately does not register the adapter key; the callable reader consumes the profile directly.
const config: LiveReservesConfig = {
  adapter: "curated-validated", version: 1, semantics: "collateral-mix",
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
  params: { managerAddress: MANAGER, managerImplementation: IMPLEMENTATION, usdcAddress: USDC, tokenAddress: TOKEN },
};

// Raw outputs saved at Ethereum 26143056, 2026-10-07T20:59:35Z (keyless Dwellir).
// Accounting and identity records: agents/lrr/evidence/RS5/usdfr-pinned-{accounting,identity}.json.
const RAW_ACCOUNTING = {
  "0x11af8243": "0x000000000000000000000000000000000000000000001d68658ba1111eb8a000",
  "0x6af2fa06": "0x00000000000000000000000000000000000000000000000000000020558f466a",
  "0x6fa4a33b": "0x000000000000000000000000000000000000000000042821266f267ffbd7f6ee",
  "0x02df9274": "0x0000000000000000000000000000000000000000000445898bfac7911a9096ee",
  "0xb5984016": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0x18160ddd": "0x00000000000000000000000000000000000000000004416bf3fbecc495302e21",
  "0x70a082310000000000000000000000008317736611b542ddb4a820fe344b621a904bdd48":
    "0x00000000000000000000000000000000000000000000000000000020558f466a",
  "0xd0a6c794": "0x0000000000000000000000000000000000000000000445898bfac7911a9096ee",
  "0x3e413bee": "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0x5c975abb": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0xe2d252ad": `0x${"0".repeat(1152)}`,
};
function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
let overrides: Record<string, string | null>;
function run(target = coin, profile = config) {
  return fetchForestRoadReserveManagerReserves(target, profile, new AbortController().signal, { observedBlock: BLOCK });
}

beforeEach(() => {
  overrides = {};
  transport.storage.mockReset();
  transport.multicall.mockReset();
  transport.storage.mockResolvedValue("0x00000000000000000000000099b4dfa4e1344273d5335bd90de1dea3a02b9c3a");
  transport.multicall.mockImplementation(async (options: { calls: readonly OnchainMulticall3Call[]; blockNumberOrTag: number }) => {
    if (options.blockNumberOrTag !== BLOCK.number) throw new Error("fixture block mismatch");
    return options.calls.map((call) => {
      const raw = call.label in overrides ? overrides[call.label] :
        call.label === "usdcDecimals" ? word(6n) : call.label === "tokenDecimals" ? word(18n) :
        RAW_ACCOUNTING[call.data as keyof typeof RAW_ACCOUNTING];
      return { label: call.label, success: raw != null, returnData: raw ?? "0x" };
    });
  });
});

describe("Forest Road measured accounting", () => {
  it("replays accrued face and reconciles 6/18 units without treating credit as USDC", async () => {
    const result = await run();
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(5164083.856308362, 6);
    expect(result.metadata?.supplyTokens).toBeCloseTo(5144648.48236683, 6);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.00377778462574, 12);
    expect(result.metadata?.sourceTimestamp).toBe(BLOCK.timestamp);
    expect(result.metadata?.ratioSkewSec).toBe(0);
    expect(result.metadata?.details?.accruedDeployedCredit18Raw).toBe("5025209449802361906657006");
    const credit = result.slices.find((slice) => slice.assetClass === "private-credit")!;
    expect(credit.risk).toBe("high");
    expect(credit.coinId).toBeUndefined();
    expect(credit.depType).toBeUndefined();
    expect(credit.maturityDaysMax).toBeUndefined();
    expect(credit.liquidityHorizon).toBe("unknown");
    expect(result.metadata?.details).toMatchObject({ creditBorrowerIdentity: "unknown", creditValuation: "unverified", holderPriority: "unknown" });
    expect(result.slices.find((slice) => slice.coinId === "usdc-circle")?.pct).toBeCloseTo(2.689236084661043, 6);
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBe(100);
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.immediateRedeemableUsd).toBeUndefined();
  });

  it("subtracts impairment exactly once from accrued deployed face and retains adverse CR", async () => {
    const gross = BigInt(RAW_ACCOUNTING["0x6fa4a33b"]);
    const impaired = 100_000n * 10n ** 18n;
    const total = BigInt(RAW_ACCOUNTING["0x02df9274"]) - impaired;
    overrides = { impairment: word(impaired), totalBacking: word(total), recognizedBacking: word(total) };
    const result = await run();
    expect(result.metadata?.details?.netPrivateCredit18Raw).toBe((gross - impaired).toString());
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(5064083.856308362, 6);
    expect(result.metadata?.collateralizationRatio).toBeLessThan(1);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "forest-road-credit-impairment", effect: "degraded" }),
      expect.objectContaining({ code: "forest-road-backing-shortfall", effect: "degraded" }),
    ]));
  });

  it("rejects impairment underflow even if a fabricated aggregate would reconcile", async () => {
    overrides.impairment = word(BigInt(RAW_ACCOUNTING["0x6fa4a33b"]) + 1n);
    await expect(run()).rejects.toThrow(/impairment exceeds/);
  });

  it.each(["idleReserve", "totalBacking", "recognizedBacking"])("rejects a divergent %s getter", async (label) => {
    overrides[label] = word(1n);
    await expect(run()).rejects.toThrow(/reconcile|recognized backing/);
  });

  it("rejects physical custody loss rather than substituting the idle ledger", async () => {
    overrides.actualUSDC = word(BigInt(RAW_ACCOUNTING["0x6af2fa06"]) - 1n);
    await expect(run()).rejects.toThrow(/custody below/);
  });

  it("excludes donations from both slice amounts and collateralization", async () => {
    overrides.actualUSDC = word(BigInt(RAW_ACCOUNTING["0x6af2fa06"]) + 10_000_000n);
    const result = await run();
    expect(result.metadata?.details?.unrecognizedUSDC6Raw).toBe("10000000");
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(5164083.856308362, 6);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.00377778462574, 12);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "forest-road-unrecognized-usdc-surplus", effect: "info" }));
  });

  it("withholds the whole composition during active frozen-snapshot delivery", async () => {
    overrides.deliveryActive = `0x${"0".repeat(17 * 64)}${word(1n).slice(2)}`;
    await expect(run()).rejects.toThrow(/active accrual delivery/);
  });

  it.each(["0x", word(0n), `0x${"0".repeat(17 * 64)}${word(2n).slice(2)}`])("rejects malformed delivery %s", async (raw) => {
    overrides.deliveryActive = raw;
    await expect(run()).rejects.toThrow();
  });

  it.each(["idleUSDC", "actualUSDC", "deployedPrincipal", "impairment", "supply", "recognizedBacking", "deliveryActive"])(
    "never turns an absent %s getter into zero", async (label) => {
      overrides[label] = null;
      await expect(run()).rejects.toThrow();
    });

  it("retains an observed zero idle balance with a complete positive credit book", async () => {
    const credit = BigInt(RAW_ACCOUNTING["0x6fa4a33b"]);
    overrides = { idleUSDC: word(0n), actualUSDC: word(0n), idleReserve: word(0n), totalBacking: word(credit), recognizedBacking: word(credit) };
    const result = await run();
    expect(result.slices.find((slice) => slice.coinId === "usdc-circle")?.pct).toBe(0);
    expect(result.slices.find((slice) => slice.assetClass === "private-credit")?.pct).toBe(100);
  });

  it("retains observed zero credit after complete impairment instead of inventing assets", async () => {
    const idle = BigInt(RAW_ACCOUNTING["0x6af2fa06"]) * SCALE;
    overrides = { impairment: RAW_ACCOUNTING["0x6fa4a33b"], totalBacking: word(idle), recognizedBacking: word(idle) };
    const result = await run();
    expect(result.slices.find((slice) => slice.assetClass === "private-credit")?.pct).toBe(0);
    expect(result.metadata?.details?.netPrivateCredit18Raw).toBe("0");
    expect(result.metadata?.collateralizationRatio).toBeLessThan(1);
  });

  it.each(["supply", "totalBacking"])("rejects zero %s", async (label) => {
    if (label === "supply") overrides.supply = word(0n);
    else overrides = { idleReserve: word(0n), idleUSDC: word(0n), actualUSDC: word(0n), deployedPrincipal: word(0n), totalBacking: word(0n), recognizedBacking: word(0n) };
    await expect(run()).rejects.toThrow(/zero backing or supply/);
  });

  it.each(["usdcDecimals", "tokenDecimals"])("rejects decimal drift for %s", async (label) => {
    overrides[label] = word(7n);
    await expect(run()).rejects.toThrow(/decimals drift/);
  });

  it("rejects USDC pointer drift and manager implementation drift/absence", async () => {
    overrides.usdc = word(1n);
    await expect(run()).rejects.toThrow(/USDC identity drift/);
    overrides = {};
    transport.storage.mockResolvedValue(word(1n));
    await expect(run()).rejects.toThrow(/implementation drift/);
    transport.storage.mockResolvedValue(null);
    await expect(run()).rejects.toThrow(/implementation drift/);
  });

  it("rejects token inventory and configured identity drift", async () => {
    await expect(run({ ...coin, contracts: [{ chain: "ethereum", address: USDC, decimals: 18 }] })).rejects.toThrow(/identity drift/);
    await expect(run({ ...coin, contracts: [...coin.contracts!, { chain: "base", address: TOKEN, decimals: 18 }] })).rejects.toThrow(/identity drift/);
    await expect(run(coin, { ...config, params: { ...config.params, managerImplementation: TOKEN } })).rejects.toThrow(/profile drift/);
  });

  it("retains a pure liability shortfall without clamping the ratio to par", async () => {
    overrides.supply = word(6_000_000n * 10n ** 18n);
    const result = await run();
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(5164083.856308362 / 6_000_000, 12);
    expect(result.metadata?.details?.principalImpairment18Raw).toBe("0");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "forest-road-backing-shortfall", effect: "degraded" }));
  });

  it.each(["idleReserve", "idleUSDC", "deployedPrincipal", "impairment", "totalBacking", "recognizedBacking", "supply", "actualUSDC"])(
    "rejects a multiword %s result rather than silently truncating", async (label) => {
      overrides[label] = `${word(0n)}${word(0n).slice(2)}`;
      await expect(run()).rejects.toThrow(/malformed uint256/);
    });

  it("rejects a foreign-chain anchor instead of reading an unrelated block height", async () => {
    await expect(fetchForestRoadReserveManagerReserves(coin, config, new AbortController().signal, {
      observedBlock: { ...BLOCK, chain: "base" },
    })).rejects.toThrow(/chain mismatch/);
  });

  it.each(["rpcUrl", "fallbackRpcUrl"])("rejects plaintext %s overrides", async (key) => {
    await expect(run(coin, {
      ...config, params: { ...config.params, [key]: "http://ethereum-rpc.publicnode.com" },
    })).rejects.toThrow();
  });

  it.each(["rpcUrl", "fallbackRpcUrl"])("accepts HTTPS %s overrides without changing measured accounting", async (key) => {
    const result = await run(coin, {
      ...config, params: { ...config.params, [key]: "https://ethereum-rpc.publicnode.com" },
    });
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(5164083.856308362, 6);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.00377778462574, 12);
  });
});

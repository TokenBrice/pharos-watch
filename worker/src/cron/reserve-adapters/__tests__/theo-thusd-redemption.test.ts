import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type * as OnchainModule from "../onchain";
import type * as EvmRpcModule from "../../../lib/evm-rpc";
import { fetchTheoThusdRedemptionReserves } from "../theo-thusd-redemption";
import { fetchOnchainMulticall3 } from "../onchain";
import { fetchEvmBlockNumber, fetchEvmBlockHeader } from "../../../lib/evm-rpc";

vi.mock("../onchain", async (importOriginal) => ({
  ...await importOriginal<typeof OnchainModule>(),
  fetchOnchainMulticall3: vi.fn(),
}));
vi.mock("../../../lib/evm-rpc", async (importOriginal) => ({
  ...await importOriginal<typeof EvmRpcModule>(),
  fetchEvmBlockNumber: vi.fn(),
  fetchEvmBlockHeader: vi.fn(),
}));
const word = (value: bigint | number) => `0x${BigInt(value).toString(16).padStart(64, "0")}` as `0x${string}`;
const addressWord = (address: string) => `0x${address.slice(2).padStart(64, "0")}` as `0x${string}`;
const coin = {
  id: "thusd-theo",
  reserves: [{ name: "Gold carry", pct: 73.3, risk: "high" }, { name: "thBILL and liquidity", pct: 26.7, risk: "low" }],
  reserveReview: { reviewedAt: "2026-09-30", compositionAsOf: "2026-09-29" },
} as StablecoinMeta;
const config: LiveReservesConfig = {
  adapter: "theo-thusd-redemption", version: 1, semantics: "collateral-mix",
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "alchemy" } },
};
let reads: Record<string, `0x${string}` | null>;
beforeEach(() => {
  vi.mocked(fetchEvmBlockNumber).mockResolvedValue(26088429);
  vi.mocked(fetchEvmBlockHeader).mockResolvedValue({
    number: 26088429, timestamp: 1790748096, hash: `0x${"11".repeat(32)}`,
  });
  reads = {
    thusd: addressWord("0xa3fe5c7596024e6811e14f029937d5bd8ae485b3"),
    destination: addressWord("0xec417ccb6dd26868cca993a92f37217b1d4b3c2f"),
    paused: word(0), cap: word(200_000_000000n), redeemed: word(0), fee: word(5), maxFee: word(10),
    thusdDecimals: word(6), supply: word(132370676056526n),
    "USDC:supported": word(1), "USDC:balance": word(360760446791n), "USDC:allowance": word(200400000000n), "USDC:decimals": word(6),
    "USDT:supported": word(1), "USDT:balance": word(20000000000n), "USDT:allowance": word(400300000000n), "USDT:decimals": word(6),
  };
  vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ calls, blockNumberOrTag }) => {
    if (blockNumberOrTag !== 26088429) throw new Error("fixture must be read at producing block");
    return calls.map(({ label }) => ({ label, success: reads[label] != null, returnData: reads[label] ?? "0x" }));
  });
});
const run = () => fetchTheoThusdRedemptionReserves(coin, config, new AbortController().signal);

describe("Theo allowance-limited executed rail", () => {
  it("measures 220400 across blocks without replacing curated backing or supply", async () => {
    const result = await run();
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 220400, feeBps: 5, routeStatus: "open", routeStatusSource: "onchain", settlementDelaySec: 0, sourceTimestamp: 1790748096, blockNumber: 26088429 });
    expect(result.slices).toEqual(coin.reserves);
    expect(result.metadata?.details).toMatchObject({ reserveReview: coin.reserveReview, balanceOnlyCapacityUsd: 380760.446791, maxRedeemPerBlockThusd: 200000 });
    expect(result.metadata?.totalReserveUsd).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
  });
  it("takes minima per asset before summing, preserving six-decimal amounts", async () => {
    reads["USDC:balance"] = word(1_000001n);
    reads["USDC:allowance"] = word((1n << 256n) - 1n);
    reads["USDT:balance"] = word(9_000000n);
    reads["USDT:allowance"] = word(2_000002n);
    expect((await run()).metadata?.redemption?.capacityUsd).toBe(3.000003);
  });
  it("excludes an unsupported output but retains the other allowance-bound asset", async () => {
    reads["USDT:supported"] = word(0);
    expect((await run()).metadata?.redemption?.capacityUsd).toBe(200400);
  });
  it("retains multi-block float when current-block headroom is exhausted", async () => {
    reads.redeemed = reads.cap;
    const result = await run();
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 220400, routeStatus: "open" });
    expect(result.metadata?.details?.remainingThisBlockThusd).toBe(0);
  });
  it.each(["paused", "zero-cap", "unsupported"])("reports measured zero for %s", async (state) => {
    if (state === "paused") reads.paused = word(1);
    if (state === "zero-cap") reads.cap = word(0);
    if (state === "unsupported") reads["USDC:supported"] = reads["USDT:supported"] = word(0);
    const result = await run();
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 0, routeStatus: "paused", routeStatusSource: "onchain" });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "theo-redemption-rail-closed", effect: "degraded" }));
  });
  it("reports empty allowances as adverse measured zero rather than missing capacity", async () => {
    reads["USDC:allowance"] = reads["USDT:allowance"] = word(0);
    const result = await run();
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 0, routeStatus: "degraded" });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "theo-redemption-buffer-empty", effect: "degraded" }));
  });
  it.each([
    ["thusd", addressWord("0x0000000000000000000000000000000000000001")],
    ["destination", addressWord("0x0000000000000000000000000000000000000001")],
    ["thusdDecimals", word(18)], ["USDT:decimals", word(18)],
    ["USDT:supported", word(2)], ["USDT:balance", "0xabc"],
    ["fee", word(11)], ["maxFee", word(11)], ["redeemed", word(200001000000n)],
    ["USDT:allowance", null],
  ] as const)("fails closed on invalid required %s read", async (label, value) => {
    reads[label] = value;
    await expect(run()).rejects.toThrow("theo-thusd-redemption");
  });
  it("fails before capacity publication when the numbered block header is unavailable", async () => {
    vi.mocked(fetchEvmBlockHeader).mockResolvedValue(null);
    await expect(run()).rejects.toThrow(/observation block header/);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../../../lib/evm-rpc", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/evm-rpc")>(),
  fetchEvmRpcBatch: vi.fn(),
}));
import { fetchEvmRpcBatch } from "../../../lib/evm-rpc";
import { fetchMocDocReserves } from "../moc-doc";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";

const WAD = 10n ** 18n;
const now = 1_800_000_000;
const word = (value: bigint | number | string) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const block = { number: "0x100", hash: `0x${"ab".repeat(32)}`, timestamp: word(now - 30) };
const coin = {
  id: "doc-money-on-chain",
  contracts: [{ chain: "rootstock", address: "0xe700691da7b9851f2f35f8b8182c69c53ccad9db", decimals: 18 }],
} as StablecoinMeta;
const config = {
  adapter: "moc-doc", version: 1, semantics: "single-asset",
  inputs: { primary: { kind: "onchain-evm", chain: "rootstock", rpcMode: "public-rpc" } },
  params: { rpcUrl: "https://public-node.rsk.co" },
} satisfies LiveReservesConfig;

function accounting(collateral = 200n * WAD): unknown[] {
  const price = 50_000n * WAD;
  const supply = 2_000_000n * WAD;
  const locked = supply * WAD / price;
  return [
    "0x8cf0035b1d1bcd6821f563b3db0530ef59c5d226", "0xf65be577b252a41887e2f1a19b576a0925201186",
    "0x437221b50b0066186e58412b0ba940441a7b7df5", "0xa7e86af8eb19e3dab8e7353cb27d286372aac87d",
    "0xce2a128cc73e5d98355aafb2595647f2d3171faa", "0xf773b590af754d597770937fa8ea7abdf2668370",
    "0xb9c42efc8ec54490a37ca91c423f7285fa01e257", "0xe700691da7b9851f2f35f8b8182c69c53ccad9db",
    "0xe2927a0620b82a66d67f678fc9b826b0e01b1bfd",
    collateral, collateral, collateral, supply, supply, price, 0n, locked,
    collateral > locked ? collateral - locked : 0n, collateral * WAD / locked,
    3, 0, supply, 104n * WAD / 100n, 1, WAD, WAD, 0, 15n * WAD / 10n,
  ].map((value, i) => i === 15 ? `${word(price)}${word(1).slice(2)}${word(250).slice(2)}` : word(value));
}

function run(values = accounting(), closing = block) {
  vi.mocked(fetchEvmRpcBatch).mockResolvedValueOnce([block]).mockResolvedValueOnce(values).mockResolvedValueOnce([closing]);
  return fetchMocDocReserves(coin, config, AbortSignal.timeout(5_000), { nowSec: now });
}

beforeEach(() => vi.resetAllMocks());

describe("MoC DOC accounted rBTC", () => {
  it("proves complete canonical collateral and preserves senior DOC/junior BPRO accounting", async () => {
    const result = await run();
    expect(result.slices).toEqual([{ sourceKey: "moc-doc:rbtc", name: "Rootstock BTC (rBTC) collateral", pct: 100, risk: "medium" }]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable", totalReserveUsd: 10_000_000, supplyUsd: 2_000_000, collateralizationRatio: 5,
      details: { docLockedRbtcRaw: (40n * WAD).toString(), juniorBproResidualRbtcRaw: (160n * WAD).toString() },
      redemption: { capacityUsd: 2_000_000, routeStatus: "open" },
    });
    expect(result.warnings).toBeUndefined();
    expectValidAdapterOutput("moc-doc", result);
    const reads = vi.mocked(fetchEvmRpcBatch).mock.calls[1][1];
    expect(reads.every((call) => call.params[call.params.length - 1] === block.number)).toBe(true);
  });

  it("does not count unaccounted rBTC donations as backing", async () => {
    const values = accounting();
    values[11] = word(250n * WAD);
    expect((await run(values)).metadata?.totalReserveUsd).toBe(10_000_000);
  });

  it("caps missing custody collateral and degrades rather than hiding insolvency", async () => {
    const values = accounting();
    values[11] = word(20n * WAD);
    const result = await run(values);
    expect(result.metadata?.collateralizationRatio).toBe(0.5);
    expect(result.warnings?.map((w) => w.code)).toEqual(["moc-doc-custody-deficit", "reserve-undercollateralized"]);
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 0, routeStatus: "degraded" });
  });

  it("retains a valid undercollateralized state as degraded evidence", async () => {
    const result = await run(accounting(20n * WAD));
    expect(result.metadata?.collateralizationRatio).toBe(0.5);
    expect(result.metadata?.details).toMatchObject({ juniorBproResidualRbtcRaw: "0" });
    expect(result.warnings?.map((w) => w.code)).toContain("reserve-undercollateralized");
  });

  it.each([
    [0, word(1), "implementation"],
    [7, word(1), "identity"],
    [13, word(WAD), "accounting state"],
    [16, word(1), "reconcile"],
    [26, word(1), "accounting state"],
    [15, `${word(50_000n * WAD)}${word(0).slice(2)}${word(250).slice(2)}`, "oracle"],
  ])("fails closed for invalid read %i", async (index, value, error) => {
    const values = accounting();
    values[index as number] = value;
    await expect(run(values)).rejects.toThrow(String(error));
  });

  it("degrades paused state and withholds executable capacity", async () => {
    const values = accounting();
    values[20] = word(1);
    const result = await run(values);
    expect(result.warnings?.map((w) => w.code)).toContain("moc-doc-protocol-state");
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 0, routeStatus: "paused" });
  });

  it.each([48n * WAD, 60n * WAD])("withholds capacity at or below protection even above liquidation coverage", async (collateral) => {
    const result = await run(accounting(collateral));
    expect(result.warnings?.map((warning) => warning.code)).toContain("moc-doc-protection-mode");
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 0, routeStatus: "degraded" });
  });

  it("permits capacity strictly above protection coverage", async () => {
    const result = await run(accounting(60n * WAD + WAD / 100n));
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 2_000_000, routeStatus: "open" });
  });

  it("rejects reorged or stale block evidence", async () => {
    await expect(run(accounting(), { ...block, hash: `0x${"cd".repeat(32)}` })).rejects.toThrow("pinned block changed");
    vi.mocked(fetchEvmRpcBatch).mockResolvedValueOnce([{ ...block, timestamp: word(now - 601) }]);
    await expect(fetchMocDocReserves(coin, config, AbortSignal.timeout(5_000), { nowSec: now })).rejects.toThrow("stale/future");
  });
});

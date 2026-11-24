import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CURVE_POOL_CONFIGS, type CurvePoolConfig } from "@shared/lib/curve-pool-configs";
import { fetchCurveOnchainPrices } from "../curve-onchain";
import { configuredPrimaryUpstreamKeys } from "../../cron/dex-liquidity/price-lineage";
import curveExpandedPostA19 from "@shared/lib/__tests__/fixtures/curve-expanded-post-a19.json";

vi.mock("../evm-rpc", () => ({
  fetchEvmBlockNumber: vi.fn(),
  fetchEvmBlockTimestamp: vi.fn(),
  fetchEvmCallHexAtBlock: vi.fn(),
  fetchEvmRpcBatch: vi.fn(),
}));
import { fetchEvmBlockNumber, fetchEvmBlockTimestamp, fetchEvmCallHexAtBlock, fetchEvmRpcBatch } from "../evm-rpc";
const mockEvmCall = vi.mocked(fetchEvmCallHexAtBlock);
const mockRpcBatch = vi.mocked(fetchEvmRpcBatch);
const mockBlockNumber = vi.mocked(fetchEvmBlockNumber);
const mockBlockTimestamp = vi.mocked(fetchEvmBlockTimestamp);

const FRESH_BLOCK_NUMBER = 19_000_000;
const NOW = 1_800_000_000_000;
const FRESH_BLOCK_TIMESTAMP = 1_799_999_970;
const PAR_MARK = { price: 1, observedAt: NOW / 1000 };
const THREE_POOL_ADDRESS = "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7";
const U18 = 10n ** 18n;
const addr = (n: number) => `0x${String(n).padStart(40, "0")}`;

const hexWord = (value: bigint | number | string): `0x${string}` =>
  `0x${BigInt(value).toString(16).padStart(64, "0")}` as `0x${string}`;

const makeCurveConfig = (overrides: Partial<CurvePoolConfig> = {}): CurvePoolConfig => ({
  stablecoinId: "usdt-tether", poolAddress: THREE_POOL_ADDRESS,
  inputIndex: 1, outputIndex: 2, inputDecimals: 6, outputDecimals: 6,
  chain: "ethereum", terminalQuoteAsset: "USDC", ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mockBlockNumber.mockResolvedValue(FRESH_BLOCK_NUMBER);
  mockBlockTimestamp.mockResolvedValue(FRESH_BLOCK_TIMESTAMP);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("fetchCurveOnchainPrices", () => {
  it("preserves all post-A19 RPC calldata, pinned blocks and route clocks", async () => {
    const baselineRoutes: CurvePoolConfig[] = (curveExpandedPostA19.routes as Omit<CurvePoolConfig, "terminalQuoteAsset">[])
      .map((route) => ({ ...route, terminalQuoteAsset: "USDC" }));
    const baselineByPool = new Map(baselineRoutes.map((r) => [`${r.poolAddress}:${r.outputIndex}`, r]));
    mockEvmCall.mockImplementation(async (_chain, address, calldata) => {
      const outIdx = Number(BigInt(`0x${calldata.slice(74, 138)}`));
      const route = baselineByPool.get(`${address}:${outIdx}`) ?? CURVE_POOL_CONFIGS.find((c) => c.poolAddress === address)!;
      return hexWord((route.outputDecimals === 2 ? 100n : 1n) * 10n ** BigInt(route.outputDecimals));
    });
    const baseline = await fetchCurveOnchainPrices(baselineRoutes, PAR_MARK);
    const baselineCalls = [...mockEvmCall.mock.calls];
    mockEvmCall.mockClear();
    mockRpcBatch.mockResolvedValue([hexWord(10n ** 24n), hexWord(10n ** 24n), hexWord(10n ** 21n), hexWord(10n ** 22n)]);
    const matching = await fetchCurveOnchainPrices(
      CURVE_POOL_CONFIGS.filter((c) => baselineByPool.has(`${c.poolAddress}:${c.outputIndex}`)), PAR_MARK,
    );
    expect(baseline.kind).toBe("ok");
    expect(baseline.value.prices.size).toBe(baselineRoutes.length);
    expect(mockEvmCall.mock.calls).toStrictEqual(baselineCalls);
    expect(matching).toStrictEqual(baseline);
    const full = await fetchCurveOnchainPrices(CURVE_POOL_CONFIGS, PAR_MARK);
    expect(full.kind).toBe("ok");
    expect(full.value.prices.size).toBe(baselineRoutes.length);
    expect(full.value.sellGuardRejections).toEqual([]);
    expect([...full.value.observedAtByCoinId.values()]).toEqual(Array(baselineRoutes.length).fill(FRESH_BLOCK_TIMESTAMP));
  });

  it("keeps audited Curve route configs explicit and uniquely keyed per route", () => {
    const keys = CURVE_POOL_CONFIGS.map((c) => `${c.stablecoinId}:${c.chain}:${c.poolAddress.toLowerCase()}:${c.inputIndex}:${c.outputIndex}`);
    expect(new Set(keys).size).toBe(keys.length);
    const pmusdRoutes = CURVE_POOL_CONFIGS.filter((c) => c.stablecoinId === "pmusd-precious-metals");
    expect(pmusdRoutes.map((c) => c.hop?.viaStablecoinId)).toEqual(["crvusd-curve", "frxusd-frax"]);
    expect(pmusdRoutes.every((c) => c.sellGuard?.minSellDepthQuoteTokens === 25_000 && c.sellGuard.impactQuoteTokens === 10_000)).toBe(true);
    const upstream = configuredPrimaryUpstreamKeys("pmusd-precious-metals");
    for (const k of [
      "ethereum:0xecb0f0d68c19bdaadaebe24f6752a4db34e2c2cb", "ethereum:0xbf5047039f2980c21eb5692c790bad8a9533b900",
      "ethereum:0x13e12bb0e6a2f1a3d6901a59a9d585e89a6243e1", "ethereum:0x4dece678ceceb27446b35c672dc7d61f30bad69e", "venue:bitstamp",
    ]) expect(upstream.has(k)).toBe(true);
  });

  it.each([
    [70_123, 3_501_403, 407, 3_948, true, null],
    [10_000, 3_501_403, 407, 3_948, false, "insufficient-sell-depth"],
    [70_123, 50_000, 407, 3_948, false, "input-balance"],
    [70_123, 3_501_403, 407, 3_700, false, "impact"],
    [null, 0, 0, 0, false, "rpc"],
  ] as const)("pmUSD sellGuard (%s/%s/%s/%s -> %s, %s)", async (quoteDepth, inputBal, smallOut, impactOut, accepted, reason) => {
    const pmusd = CURVE_POOL_CONFIGS.find(({ poolAddress }) => poolAddress === "0xEcb0F0d68C19BdAaDAEbE24f6752A4Db34e2c2cb")!;
    const crvusd = CURVE_POOL_CONFIGS.find(({ stablecoinId }) => stablecoinId === "crvusd-curve")!;
    mockEvmCall.mockImplementation(async (_c, a) => hexWord(a === pmusd.poolAddress ? 2_444_903_644_452_049_000n : U18));
    mockRpcBatch.mockResolvedValue(quoteDepth === null ? [hexWord(70_123n * U18), "0x", hexWord(407n * U18), hexWord(3_948n * U18)]
      : [quoteDepth, inputBal, smallOut, impactOut].map((v) => hexWord(BigInt(v) * U18)));
    const outcome = await fetchCurveOnchainPrices([pmusd, crvusd], PAR_MARK);
    expect(outcome.value.prices.has(pmusd.stablecoinId)).toBe(accepted);
    expect(outcome.value.prices.get(crvusd.stablecoinId)).toBe(1);
    expect(mockRpcBatch.mock.calls[0]?.[1].map(({ params }) => params[1])).toEqual(Array(4).fill("0x121eac0"));
    expect(outcome.value.sellGuardRejections).toEqual(reason
      ? [expect.objectContaining({ stablecoinId: pmusd.stablecoinId, poolAddress: pmusd.poolAddress, reason })] : []);
  });

  it("combines passing pmUSD routes via exit-depth weighted median, oldest clock, and unioned pool lineage", async () => {
    const pmusdRoutes = CURVE_POOL_CONFIGS.filter(({ stablecoinId }) => stablecoinId === "pmusd-precious-metals");
    const crvusd = CURVE_POOL_CONFIGS.find(({ stablecoinId }) => stablecoinId === "crvusd-curve")!;
    const frxusd = { ...CURVE_POOL_CONFIGS.find(({ stablecoinId }) => stablecoinId === "frxusd-frax")!, chain: "arbitrum" };
    mockBlockNumber.mockImplementation(async (c) => (c === "ethereum" ? 100 : 200));
    mockBlockTimestamp.mockImplementation(async (c) => (c === "ethereum" ? 1_799_999_980 : 1_799_999_850));
    mockEvmCall.mockImplementation(async (_c, a) => hexWord(
      a === pmusdRoutes[0]!.poolAddress ? 2_444_987_775_061_124_694n
        : a === pmusdRoutes[1]!.poolAddress ? 2_450_980_392_156_862_745n : U18));
    const batch = (q: number, inp: number, sm: number, imp: number) => [q, inp, sm, imp].map((v) => hexWord(BigInt(v) * U18));
    mockRpcBatch
      .mockResolvedValueOnce(batch(70_123, 3_501_403, 407, 3_948))
      .mockResolvedValueOnce(batch(65_177, 3_262_285, 406, 3_928));
    const both = await fetchCurveOnchainPrices([...pmusdRoutes, crvusd, frxusd], PAR_MARK);
    expect(both.value.prices.get("pmusd-precious-metals")).toBeCloseTo(0.409, 3);
    expect(both.value.observedAtByCoinId.get("pmusd-precious-metals")).toBe(1_799_999_850);
    expect(both.value.routeTypeByCoinId.get("pmusd-precious-metals")).toBe("chained-hop");
    expect(both.value.hopDepthByCoinId.get("pmusd-precious-metals")).toBe(2);
    expect(both.value.pricePoolKeysByCoinId.get("pmusd-precious-metals")).toEqual([
      `ethereum:${pmusdRoutes[0]!.poolAddress.toLowerCase()}`, `ethereum:${crvusd.poolAddress.toLowerCase()}`,
      `ethereum:${pmusdRoutes[1]!.poolAddress.toLowerCase()}`, `arbitrum:${frxusd.poolAddress.toLowerCase()}`,
    ]);
    mockRpcBatch
      .mockResolvedValueOnce(batch(10_000, 3_501_403, 407, 3_948))
      .mockResolvedValueOnce(batch(65_177, 3_262_285, 406, 3_928));
    const oneLeft = await fetchCurveOnchainPrices([...pmusdRoutes, crvusd, frxusd], PAR_MARK);
    expect(oneLeft.value.prices.get("pmusd-precious-metals")).toBeCloseTo(0.408, 3);
    expect(oneLeft.value.sellGuardRejections).toEqual([expect.objectContaining({
      poolAddress: pmusdRoutes[0]!.poolAddress, reason: "insufficient-sell-depth",
    })]);
  });

  it("uses depth-weighted median across 3 routes and falls back to median when depth is unavailable", async () => {
    const routes = [1, 2, 3].map((n) => makeCurveConfig({ stablecoinId: "multi", poolAddress: addr(n) }));
    mockEvmCall.mockResolvedValueOnce(hexWord(1_000_000)).mockResolvedValueOnce(hexWord(998_004)).mockResolvedValueOnce(hexWord(800_000));
    mockRpcBatch.mockResolvedValueOnce([hexWord(70_000_000_000n)]).mockResolvedValueOnce([hexWord(65_000_000_000n)]).mockResolvedValueOnce([hexWord(40_000_000_000n)]);
    expect((await fetchCurveOnchainPrices(routes, PAR_MARK)).value.prices.get("multi")).toBeCloseTo(1.002, 3);
    mockEvmCall.mockResolvedValueOnce(hexWord(1_000_000)).mockResolvedValueOnce(hexWord(800_000));
    mockRpcBatch.mockResolvedValue(null);
    expect((await fetchCurveOnchainPrices(routes.slice(0, 2), PAR_MARK)).value.prices.get("multi")).toBeCloseTo(1.125, 3);
  });

  it.each([null, { price: 0.87, observedAt: NOW / 1000 - 301 }])("withholds Curve prices without a fresh USDC/USD mark", async (mark) => {
    const outcome = await fetchCurveOnchainPrices([makeCurveConfig()], mark);
    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.prices.size).toBe(0);
    expect(mockEvmCall).not.toHaveBeenCalled();
  });

  it("parses get_dy response into implied price", async () => {
    mockEvmCall.mockResolvedValue(hexWord(999000));
    const config = makeCurveConfig();
    const outcome = await fetchCurveOnchainPrices([config], PAR_MARK);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.size).toBe(1);
    expect(outcome.value.prices.get("usdt-tether")).toBeCloseTo(1.001, 3);
    expect(outcome.value.observedAtByCoinId.get("usdt-tether")).toBe(FRESH_BLOCK_TIMESTAMP);
    expect(outcome.value.routeTypeByCoinId.get("usdt-tether")).toBe("direct");
    expect(outcome.value.hopDepthByCoinId.get("usdt-tether")).toBe(0);
    expect(mockEvmCall).toHaveBeenCalledWith("ethereum", config.poolAddress, expect.any(String), FRESH_BLOCK_NUMBER, expect.any(Object));
  });

  it("computes correct implied price with different decimals (DAI 18 decimals)", async () => {
    mockEvmCall.mockResolvedValue(hexWord("1001000000000000000"));
    const outcome = await fetchCurveOnchainPrices([makeCurveConfig({ stablecoinId: "dai-makerdao", outputIndex: 0, outputDecimals: 18 })], PAR_MARK);
    expect(outcome.value.prices.get("dai-makerdao")).toBeCloseTo(0.999, 3);
  });

  it("sizes get_dy quotes up for low-decimal outputs (GUSD 2-decimal artifact)", async () => {
    mockEvmCall.mockResolvedValue(hexWord(9997));
    const config = makeCurveConfig({
      stablecoinId: "gusd-gemini", poolAddress: "0x4f062658EaAF2C1ccf8C8e36D6824CDf41167956",
      inputIndex: 2, outputIndex: 0, outputDecimals: 2, useUnderlying: true,
    });
    const outcome = await fetchCurveOnchainPrices([config], PAR_MARK);
    expect(BigInt(`0x${(mockEvmCall.mock.calls[0][2] as string).slice(-64)}`)).toBe(100n * 10n ** 6n);
    expect(outcome.value.prices.get("gusd-gemini")).toBeCloseTo(100 / 99.97, 8);
    expect(outcome.value.prices.get("gusd-gemini")).not.toBeCloseTo(1 / 0.99, 8);
  });

  it("keeps 1-unit quotes for outputs with >= 6 decimals", async () => {
    mockEvmCall.mockResolvedValue(hexWord(999000));
    await fetchCurveOnchainPrices([makeCurveConfig()], PAR_MARK);
    expect(BigInt(`0x${(mockEvmCall.mock.calls[0][2] as string).slice(-64)}`)).toBe(10n ** 6n);
  });

  it("returns no-data outcome when RPC returns null for every pool", async () => {
    mockEvmCall.mockResolvedValue(null);
    const outcome = await fetchCurveOnchainPrices([makeCurveConfig()], PAR_MARK);
    expect(outcome.kind).toBe("no-data");
    expect(outcome.value.prices.size).toBe(0);
  });

  it("uses get_dy_underlying selector when useUnderlying is true", async () => {
    mockEvmCall.mockResolvedValue(hexWord("999000000000000000"));
    const config = makeCurveConfig({
      stablecoinId: "lusd-liquity", poolAddress: "0xEd279fDD11cA84bEef15AF5D39BB4d4bEE23F0cA",
      inputIndex: 2, outputIndex: 0, outputDecimals: 18, useUnderlying: true,
    });
    const outcome = await fetchCurveOnchainPrices([config], PAR_MARK);
    expect(outcome.value.prices.get("lusd-liquity")).toBeCloseTo(1.001, 3);
    expect((mockEvmCall.mock.calls[0][2] as string).startsWith("0x07211ef7")).toBe(true);
  });

  const crvusdHopBase = makeCurveConfig({
    stablecoinId: "crvusd-curve", poolAddress: "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E",
    inputIndex: 0, outputIndex: 1, inputDecimals: 6, outputDecimals: 18,
  });
  const ghoHop = makeCurveConfig({
    stablecoinId: "gho-aave", poolAddress: "0x0001000100010001000100010001000100010001",
    inputIndex: 0, outputIndex: 1, inputDecimals: 18, outputDecimals: 18, hop: { viaStablecoinId: "crvusd-curve" },
  });

  it("resolves hop prices by multiplying with via-token price", async () => {
    mockEvmCall.mockResolvedValueOnce(hexWord("999000000000000000")).mockResolvedValueOnce(hexWord("998000000000000000"));
    const outcome = await fetchCurveOnchainPrices([crvusdHopBase, ghoHop], PAR_MARK);
    expect(outcome.value.prices.get("crvusd-curve")).toBeCloseTo(1.001, 3);
    expect(outcome.value.prices.get("gho-aave")).toBeCloseTo((1 / 0.998) * (1 / 0.999), 3);
    expect(outcome.value.routeTypeByCoinId.get("gho-aave")).toBe("one-hop");
    expect(outcome.value.hopDepthByCoinId.get("gho-aave")).toBe(1);
  });

  it.each(["usat-tether", "usdq-quantoz"])(
    "converts the authored %s USDT ratio to USD and preserves the older parent clock", async (id) => {
      const target = CURVE_POOL_CONFIGS.find((config) => config.stablecoinId === id)!;
      const usdt = { ...CURVE_POOL_CONFIGS.find((config) => config.stablecoinId === "usdt-tether")!, chain: "arbitrum" };
      mockBlockTimestamp.mockImplementation(async (chain) => chain === "arbitrum" ? 1_799_999_800 : 1_799_999_980);
      mockEvmCall.mockImplementation(async (_chain, address) => hexWord(
        address === target.poolAddress ? 10n ** BigInt(target.outputDecimals) : 1_020_000n,
      ));
      const outcome = await fetchCurveOnchainPrices([target, usdt], { price: 0.87, observedAt: 1_799_999_750 });
      expect(outcome.value.prices.get(id)).toBeCloseTo(0.87 / 1.02, 8);
      expect(outcome.value.pricePoolKeysByCoinId.get(id)).toEqual([
        `ethereum:${target.poolAddress.toLowerCase()}`, `arbitrum:${usdt.poolAddress.toLowerCase()}`,
      ]);
      expect(outcome.value.routeTypeByCoinId.get(id)).toBe("one-hop");
      expect(outcome.value.hopDepthByCoinId.get(id)).toBe(1);
      expect(outcome.value.observedAtByCoinId.get(id)).toBe(1_799_999_750);
    },
  );

  it.each(["missing", "stale"] as const)("withholds USDT-reference quotes when USDT is %s", async (dependency) => {
    const targets = CURVE_POOL_CONFIGS.filter((config) => ["usat-tether", "usdq-quantoz"].includes(config.stablecoinId));
    const usdt = { ...CURVE_POOL_CONFIGS.find((config) => config.stablecoinId === "usdt-tether")!, chain: "arbitrum" };
    mockBlockTimestamp.mockImplementation(async (chain) => chain === "arbitrum" ? 1_799_999_699 : 1_799_999_980);
    mockEvmCall.mockImplementation(async (_chain, address) => {
      const config = targets.find((target) => target.poolAddress === address) ?? usdt;
      return hexWord(10n ** BigInt(config.outputDecimals));
    });
    const outcome = await fetchCurveOnchainPrices(dependency === "missing" ? targets : [...targets, usdt], PAR_MARK);
    expect(outcome.value.prices.size).toBe(0);
  });

  it("pins each cross-chain hop and propagates the older dependency timestamp", async () => {
    mockBlockNumber.mockImplementation(async (chain) => chain === "ethereum" ? 100 : 200);
    mockBlockTimestamp.mockImplementation(async (chain) => chain === "ethereum" ? 1_799_999_800 : 1_799_999_980);
    const via = makeCurveConfig({ stablecoinId: "via", chain: "ethereum" });
    const dependent = makeCurveConfig({
      stablecoinId: "dependent", chain: "arbitrum",
      poolAddress: "0x0000000000000000000000000000000000000002",
      hop: { viaStablecoinId: "via" },
    });
    mockEvmCall.mockResolvedValue(hexWord(1_000_000));
    const outcome = await fetchCurveOnchainPrices([dependent, via], PAR_MARK);
    expect([...outcome.value.prices]).toEqual([["dependent", 1], ["via", 1]]);
    expect([...outcome.value.observedAtByCoinId]).toEqual([
      ["dependent", 1_799_999_800], ["via", 1_799_999_800],
    ]);
    expect(mockEvmCall.mock.calls.map(([chain, target, , block]) => [chain, target, block]))
      .toEqual([["arbitrum", dependent.poolAddress, 200], ["ethereum", via.poolAddress, 100]]);
    expect(mockBlockTimestamp.mock.calls.map(([chain, block]) => [chain, block]))
      .toEqual([["arbitrum", 200], ["ethereum", 100]]);
  });

  it("resolves one-hop prices even when via config appears later", async () => {
    mockEvmCall.mockResolvedValueOnce(hexWord("998000000000000000")).mockResolvedValueOnce(hexWord("999000000000000000"));
    const outcome = await fetchCurveOnchainPrices([ghoHop, crvusdHopBase], PAR_MARK);
    expect(outcome.value.prices.get("gho-aave")).toBeCloseTo((1 / 0.998) * (1 / 0.999), 3);
  });

  it("excludes hop coin when via-token RPC fails", async () => {
    mockEvmCall.mockResolvedValueOnce(null).mockResolvedValueOnce(hexWord("998000000000000000"));
    const outcome = await fetchCurveOnchainPrices([crvusdHopBase, ghoHop], PAR_MARK);
    expect(outcome.value.prices.has("crvusd-curve")).toBe(false);
    expect(outcome.value.prices.has("gho-aave")).toBe(false);
  });

  it("truncates oversized Vyper return data to first uint256 word", async () => {
    const vyperHex = (`0x${hexWord("984321781412057132").slice(2)}00000002${"0".repeat(120)}000f4240${"0".repeat(56)}`) as `0x${string}`;
    expect(vyperHex.length).toBeGreaterThan(66);
    mockEvmCall.mockResolvedValue(vyperHex);
    const outcome = await fetchCurveOnchainPrices([makeCurveConfig({
      stablecoinId: "lusd-liquity", poolAddress: "0xEd279fDD11cA84bEef15AF5D39BB4d4bEE23F0cA",
      inputIndex: 2, outputIndex: 0, outputDecimals: 18, useUnderlying: true,
    })], PAR_MARK);
    expect(outcome.value.prices.get("lusd-liquity")).toBeCloseTo(1.016, 2);
  });

  it("returns upstream-error outcome when every RPC call throws", async () => {
    mockEvmCall.mockRejectedValue(new Error("network down"));
    const outcome = await fetchCurveOnchainPrices([makeCurveConfig()], PAR_MARK);
    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.prices.size).toBe(0);
  });

  it("returns ok with partial=true when some pools throw but others succeed", async () => {
    mockEvmCall.mockResolvedValueOnce(hexWord(999000)).mockRejectedValueOnce(new Error("rpc broke"));
    const outcome = await fetchCurveOnchainPrices([makeCurveConfig(), makeCurveConfig({ stablecoinId: "usdc-usd-coin", inputIndex: 0, outputIndex: 1 })], PAR_MARK);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.size).toBe(1);
    expect(outcome.value.prices.get("usdt-tether")).toBeCloseTo(1.001, 3);
  });

  const hopToken = (id: string, n: number, extra: Partial<CurvePoolConfig> = {}) => makeCurveConfig({
    stablecoinId: id, poolAddress: addr(n), inputIndex: 0, outputIndex: 1, inputDecimals: 18, outputDecimals: 18, ...extra,
  });

  it("excludes chained hops unless the dependent config explicitly opts in", async () => {
    mockEvmCall.mockResolvedValue(hexWord(U18));
    const outcome = await fetchCurveOnchainPrices([
      hopToken("token-c", 3), hopToken("token-b", 2, { hop: { viaStablecoinId: "token-c" } }), hopToken("token-a", 1, { hop: { viaStablecoinId: "token-b" } }),
    ], PAR_MARK);
    expect(outcome.value.prices.has("token-b")).toBe(true);
    expect(outcome.value.prices.has("token-a")).toBe(false);
  });

  it("resolves chained hops when maxHopDepth explicitly allows them", async () => {
    mockEvmCall.mockResolvedValueOnce(hexWord("997000000000000000")).mockResolvedValueOnce(hexWord("998000000000000000")).mockResolvedValueOnce(hexWord("999000000000000000"));
    const outcome = await fetchCurveOnchainPrices([
      hopToken("token-a", 1, { hop: { viaStablecoinId: "token-b" }, routeType: "chained-hop", maxHopDepth: 2 }),
      hopToken("token-b", 2, { hop: { viaStablecoinId: "token-c" } }), hopToken("token-c", 3),
    ], PAR_MARK);
    expect(outcome.value.prices.get("token-a")).toBeCloseTo((1 / 0.997) * (1 / 0.998) * (1 / 0.999), 3);
    expect(outcome.value.routeTypeByCoinId.get("token-a")).toBe("chained-hop");
    expect(outcome.value.hopDepthByCoinId.get("token-a")).toBe(2);
  });

  it("fails closed when hop configs form a cycle", async () => {
    mockEvmCall.mockResolvedValue(hexWord(U18));
    const outcome = await fetchCurveOnchainPrices([
      hopToken("token-a", 1, { hop: { viaStablecoinId: "token-b" }, routeType: "chained-hop", maxHopDepth: 2 }),
      hopToken("token-b", 2, { hop: { viaStablecoinId: "token-a" }, routeType: "chained-hop", maxHopDepth: 2 }),
    ], PAR_MARK);
    expect(outcome.kind).toBe("no-data");
    expect(outcome.value.prices.size).toBe(0);
  });

  it("fails closed when a hop references a missing via config", async () => {
    mockEvmCall.mockResolvedValue(hexWord(U18));
    const outcome = await fetchCurveOnchainPrices([hopToken("token-a", 1, { hop: { viaStablecoinId: "token-b" } })], PAR_MARK);
    expect(outcome.kind).toBe("no-data");
    expect(outcome.value.prices.has("token-a")).toBe(false);
  });

  it("emits route metadata for explicit trusted-wrapper routes", async () => {
    mockEvmCall.mockResolvedValue(hexWord(U18));
    const outcome = await fetchCurveOnchainPrices([hopToken("wrapper-token", 1, { routeType: "trusted-wrapper" })], PAR_MARK);
    expect(outcome.value.prices.get("wrapper-token")).toBe(1);
    expect(outcome.value.routeTypeByCoinId.get("wrapper-token")).toBe("trusted-wrapper");
    expect(outcome.value.hopDepthByCoinId.get("wrapper-token")).toBe(0);
  });

  it("stamps each priced coin with the block timestamp as observedAt", async () => {
    mockEvmCall.mockResolvedValue(hexWord(999000));
    const outcome = await fetchCurveOnchainPrices([makeCurveConfig(), makeCurveConfig({ stablecoinId: "usdc-usd-coin", inputIndex: 0, outputIndex: 1 })], PAR_MARK);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.observedAtByCoinId.get("usdt-tether")).toBe(FRESH_BLOCK_TIMESTAMP);
    expect(outcome.value.observedAtByCoinId.get("usdc-usd-coin")).toBe(FRESH_BLOCK_TIMESTAMP);
    expect(mockBlockNumber).toHaveBeenCalledTimes(1);
    expect(mockBlockTimestamp).toHaveBeenCalledTimes(1);
  });

  it.each([[300, "ok", 1], [301, "upstream-error", 0]] as const)(
    "applies the block freshness cutoff at age %s", async (age, kind, size) => {
      mockBlockTimestamp.mockResolvedValue(1_800_000_000 - age);
      mockEvmCall.mockResolvedValue(hexWord(1_000_000));
      const outcome = await fetchCurveOnchainPrices([makeCurveConfig()], PAR_MARK);
      expect(outcome.kind).toBe(kind);
      expect(outcome.value.prices.size).toBe(size);
      if (age === 300) expect(outcome.value.prices.get("usdt-tether")).toBe(1);
    },
  );

  it("returns upstream-error when block number RPC fails", async () => {
    mockBlockNumber.mockResolvedValue(null);
    const outcome = await fetchCurveOnchainPrices([makeCurveConfig()], PAR_MARK);
    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.prices.size).toBe(0);
    expect(mockEvmCall).not.toHaveBeenCalled();
  });
});

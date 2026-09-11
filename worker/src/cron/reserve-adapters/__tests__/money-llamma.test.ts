import { describe, expect, it } from "vitest";
import type { Abi } from "abitype";
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toFunctionSelector } from "viem/utils";
import { expectWarnings, runAdapter, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const CONTROLLER = "0x1337F001E280420EcCe9E7B934Fa07D67fdb62CD";
const MONEY = "0x69420f9E38a4e60a62224C489be4BF7a94402496";
const WBTC = "0x0000000000000000000000000000000000000001";
const WETH = "0x0000000000000000000000000000000000000002";
const WSTETH = "0x0000000000000000000000000000000000000003";
const OP1 = "0x00000000000000000000000000000000000000a1";
const OP2 = "0x00000000000000000000000000000000000000a2";
const OP3 = "0x00000000000000000000000000000000000000a3";
const AMM1 = "0x00000000000000000000000000000000000000b1";
const AMM2 = "0x00000000000000000000000000000000000000b2";
const AMM3 = "0x00000000000000000000000000000000000000b3";
const BANDS_Y_SELECTOR = toFunctionSelector("bands_y(int256)");
const BANDS_X_SELECTOR = toFunctionSelector("bands_x(int256)");

const CONTROLLER_ABI = parseAbi([
  "function get_market_count() view returns (uint256)",
  "function get_all_markets() view returns (address[])",
]);
const OPERATOR_ABI = parseAbi([
  "function COLLATERAL_TOKEN() view returns (address)",
  "function AMM() view returns (address)",
  "function total_debt() view returns (uint256)",
]);
const LLAMMA_ABI = parseAbi([
  "function min_band() view returns (int256)",
  "function max_band() view returns (int256)",
  "function bands_x(int256) view returns (uint256)",
  "function bands_y(int256) view returns (uint256)",
]);
const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

function word(value: bigint | number): `0x${string}` {
  return encodeAbiParameters(parseAbiParameters("uint256"), [BigInt(value)]);
}

function intWord(value: bigint): `0x${string}` {
  return encodeAbiParameters(parseAbiParameters("int256"), [value]);
}

function addressWord(address: `0x${string}`): `0x${string}` {
  return encodeAbiParameters(parseAbiParameters("address"), [address]);
}

function stringWord(value: string): `0x${string}` {
  return encodeAbiParameters(parseAbiParameters("string"), [value]);
}

function addressListWord(addresses: readonly `0x${string}`[]): `0x${string}` {
  return encodeAbiParameters(parseAbiParameters("address[]"), [addresses]);
}

const NOW_SEC = 1_757_003_600;
const PRICE_ENDPOINT = "https://coins.llama.fi/prices/current";

interface Scenario {
  moneyPrice?: number;
  arbitrumDebt: [bigint, bigint];
  baseDebt: bigint;
  missingPriceFor?: string;
}

interface MoneyNetworkOptions {
  /**
   * Route the arbitrum WBTC market's bands by selector and widen its span to
   * `0..wbtcMaxBand`, so a realistic census exercises many Multicall3 pages
   * without 1 500 hand-written routes.
   */
  wbtcMaxBand?: number;
}

const ARB_SUPPLY = 5_000_000n * 10n ** 18n;
const BASE_SUPPLY = 5_000_000n * 10n ** 18n;
const OP_SUPPLY = 100n * 10n ** 18n;

function moneyNetwork(
  scenario: Partial<Scenario> = {},
  marketCountOverride = 2,
  options: MoneyNetworkOptions = {},
): AdapterNetworkSpec {
  const moneyPrice = scenario.moneyPrice ?? 1;
  const [arbDebt1, arbDebt2] = scenario.arbitrumDebt ?? [1_000n * 10n ** 18n, 0n];
  const baseDebt = scenario.baseDebt ?? 500n * 10n ** 18n;
  const rpc: NonNullable<AdapterNetworkSpec["rpc"]> = {};

  const put = (
    chain: string,
    contract: string,
    abi: Abi,
    fn: string,
    args: readonly unknown[],
    result: `0x${string}`,
  ) => {
    const data = encodeFunctionData({ abi, functionName: fn, args });
    rpc[`${chain}:${contract}:${data}`] = result;
  };

  // Arbitrum: WBTC market (2 bands) + WETH market (2 bands).
  put("arbitrum", CONTROLLER, CONTROLLER_ABI, "get_market_count", [], word(marketCountOverride));
  put("arbitrum", CONTROLLER, CONTROLLER_ABI, "get_all_markets", [], addressListWord([OP1, OP2]));
  put("arbitrum", MONEY, ERC20_ABI, "totalSupply", [], word(ARB_SUPPLY));
  put("arbitrum", OP1, OPERATOR_ABI, "COLLATERAL_TOKEN", [], addressWord(WBTC));
  put("arbitrum", OP1, OPERATOR_ABI, "AMM", [], addressWord(AMM1));
  put("arbitrum", OP1, OPERATOR_ABI, "total_debt", [], word(arbDebt1));
  put("arbitrum", WBTC, ERC20_ABI, "symbol", [], stringWord("WBTC"));
  put("arbitrum", WBTC, ERC20_ABI, "decimals", [], word(8n));
  put("arbitrum", AMM1, LLAMMA_ABI, "min_band", [], intWord(0n));
  const wbtcMaxBand = options.wbtcMaxBand ?? 1;
  put("arbitrum", AMM1, LLAMMA_ABI, "max_band", [], intWord(BigInt(wbtcMaxBand)));
  if (options.wbtcMaxBand == null) {
    put("arbitrum", AMM1, LLAMMA_ABI, "bands_y", [0n], word(500_000n * 10n ** 12n));
    put("arbitrum", AMM1, LLAMMA_ABI, "bands_x", [0n], word(0n));
    put("arbitrum", AMM1, LLAMMA_ABI, "bands_y", [1n], word(1n * 10n ** 18n));
    put("arbitrum", AMM1, LLAMMA_ABI, "bands_x", [1n], word(0n));
  } else {
    // Every band answers identically: the wide-span case only measures how the
    // census is batched, not per-band values.
    rpc[`arbitrum:${AMM1}:bands_y(int256)`] = word(500_000n * 10n ** 12n);
    rpc[`arbitrum:${AMM1}:bands_x(int256)`] = word(0n);
  }
  put("arbitrum", OP2, OPERATOR_ABI, "COLLATERAL_TOKEN", [], addressWord(WETH));
  put("arbitrum", OP2, OPERATOR_ABI, "AMM", [], addressWord(AMM2));
  put("arbitrum", OP2, OPERATOR_ABI, "total_debt", [], word(arbDebt2));
  put("arbitrum", WETH, ERC20_ABI, "symbol", [], stringWord("WETH"));
  put("arbitrum", WETH, ERC20_ABI, "decimals", [], word(18n));
  put("arbitrum", AMM2, LLAMMA_ABI, "min_band", [], intWord(-1n));
  put("arbitrum", AMM2, LLAMMA_ABI, "max_band", [], intWord(0n));
  put("arbitrum", AMM2, LLAMMA_ABI, "bands_y", [-1n], word(0n));
  put("arbitrum", AMM2, LLAMMA_ABI, "bands_x", [-1n], word(0n));
  put("arbitrum", AMM2, LLAMMA_ABI, "bands_y", [0n], word(10n * 10n ** 18n));
  put("arbitrum", AMM2, LLAMMA_ABI, "bands_x", [0n], word(0n));

  // Base: wstETH market (1 band).
  put("base", CONTROLLER, CONTROLLER_ABI, "get_market_count", [], word(1n));
  put("base", CONTROLLER, CONTROLLER_ABI, "get_all_markets", [], addressListWord([OP3]));
  put("base", MONEY, ERC20_ABI, "totalSupply", [], word(BASE_SUPPLY));
  put("base", OP3, OPERATOR_ABI, "COLLATERAL_TOKEN", [], addressWord(WSTETH));
  put("base", OP3, OPERATOR_ABI, "AMM", [], addressWord(AMM3));
  put("base", OP3, OPERATOR_ABI, "total_debt", [], word(baseDebt));
  put("base", WSTETH, ERC20_ABI, "symbol", [], stringWord("WSTETH"));
  put("base", WSTETH, ERC20_ABI, "decimals", [], word(18n));
  put("base", AMM3, LLAMMA_ABI, "min_band", [], intWord(5n));
  put("base", AMM3, LLAMMA_ABI, "max_band", [], intWord(5n));
  put("base", AMM3, LLAMMA_ABI, "bands_y", [5n], word(50n * 10n ** 18n));
  put("base", AMM3, LLAMMA_ABI, "bands_x", [5n], word(2n * 10n ** 18n));

  // Optimism: no markets.
  put("optimism", CONTROLLER, CONTROLLER_ABI, "get_market_count", [], word(0n));
  put("optimism", CONTROLLER, CONTROLLER_ABI, "get_all_markets", [], addressListWord([]));
  put("optimism", MONEY, ERC20_ABI, "totalSupply", [], word(OP_SUPPLY));

  const priceMap = new Map<string, number>([
    [`arbitrum:${WBTC.toLowerCase()}`, 100_000],
    [`arbitrum:${WETH.toLowerCase()}`, 3_000],
    [`base:${WSTETH.toLowerCase()}`, 4_000],
    [`arbitrum:${MONEY.toLowerCase()}`, moneyPrice],
    [`base:${MONEY.toLowerCase()}`, moneyPrice],
    [`optimism:${MONEY.toLowerCase()}`, moneyPrice],
  ]);
  const missing = scenario.missingPriceFor?.toLowerCase();
  if (missing === "money:arbitrum") {
    priceMap.delete(`arbitrum:${MONEY.toLowerCase()}`);
  } else if (missing) {
    for (const key of priceMap.keys()) {
      if (key.endsWith(`:${missing}`)) priceMap.delete(key);
    }
  }

  const json: NonNullable<AdapterNetworkSpec["json"]> = {};
  const addPriceRoute = (assets: readonly string[]) => {
    const sorted = [...assets].sort();
    const coins = Object.fromEntries(
      sorted
        .filter((asset) => priceMap.has(asset))
        .map((asset) => [asset, { price: priceMap.get(asset), timestamp: NOW_SEC, confidence: 1 }]),
    );
    json[`${PRICE_ENDPOINT}/${sorted.join(",")}`] = { coins };
  };
  addPriceRoute([`arbitrum:${WBTC.toLowerCase()}`, `arbitrum:${WETH.toLowerCase()}`]);
  addPriceRoute([`base:${WSTETH.toLowerCase()}`]);
  addPriceRoute([
    `arbitrum:${MONEY.toLowerCase()}`,
    `base:${MONEY.toLowerCase()}`,
    `optimism:${MONEY.toLowerCase()}`,
  ]);

  return { rpc, json, block: { timestamp: 1_757_000_000 } };
}

async function fetchFixture(scenario: Partial<Scenario> = {}, marketCountOverride = 2) {
  return (await runAdapter("money-llamma", "money-defi-money", {
    network: moneyNetwork(scenario, marketCountOverride),
    nowSec: NOW_SEC,
  })).result;
}

describe("money-llamma adapter", () => {
  it("census across all three chains into priced collateral slices against MONEY debt", async () => {
    const output = await fetchFixture();

    expect(output.slices).toHaveLength(3);
    const byKey = Object.fromEntries(output.slices.map((slice) => [slice.sourceKey, slice]));
    expect(byKey["money-llamma:wbtc"]).toEqual({
      sourceKey: "money-llamma:wbtc",
      name: "Custodied BTC (WBTC)",
      pct: expect.closeTo(150_000 / 380_000 * 100, 1),
      risk: "medium",
    });
    expect(byKey["money-llamma:weth"]).toEqual({
      sourceKey: "money-llamma:weth",
      name: "ETH",
      pct: expect.closeTo(30_000 / 380_000 * 100, 1),
      risk: "very-low",
    });
    expect(byKey["money-llamma:wsteth"]).toEqual({
      sourceKey: "money-llamma:wsteth",
      name: "wstETH",
      pct: expect.closeTo(200_000 / 380_000 * 100, 1),
      risk: "low",
    });
    expect(output.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalReserveUsd: 380_000,
      totalLiabilitiesUsd: 1_500,
      supplyTokens: 10_000_100,
      supplyUsd: 10_000_100,
      moneyPriceUsd: 1,
      marketCount: 3,
      observedBlock: { chain: "arbitrum", number: expect.any(Number), timestamp: 1_757_000_000 },
    });
    expect(output.metadata?.collateralizationRatio).toBeCloseTo(380_000 / 1_500, 5);
    expect(output.metadata?.details).toMatchObject({
      proofKind: "defi-money-llamma-onchain-census",
      liabilityValuation: "market",
      softLiquidatedMoneyTokens: 2,
    });
    expect(output.metadata?.allChainBlocks).toHaveLength(3);
    expectWarnings(output, []);
  });

  it("publishes an off-par MONEY price as info and market-values the debt", async () => {
    const output = await fetchFixture({ moneyPrice: 1.02 });

    expect(output.metadata?.moneyPriceUsd).toBe(1.02);
    expect(output.metadata?.totalLiabilitiesUsd).toBeCloseTo(1_500 * 1.02, 5);
    expectWarnings(output, ["money-off-par"]);
  });

  it("values the MONEY debt liability at par when DefiLlama has no MONEY price", async () => {
    // The adapter reads its MONEY quote from the first chain leg; with no
    // usable quote the debt falls back to par while collateral stays
    // DefiLlama-priced.
    const output = await fetchFixture({ missingPriceFor: "money:arbitrum" });

    expect(output.metadata?.moneyPriceUsd).toBeUndefined();
    expect(output.metadata?.totalReserveUsd).toBe(380_000);
    expect(output.metadata?.totalLiabilitiesUsd).toBe(1_500);
    expect(output.metadata?.supplyUsd).toBe(10_000_100);
    expect(output.metadata?.collateralizationRatio).toBeCloseTo(380_000 / 1_500, 5);
    expect(output.metadata?.details).toMatchObject({ liabilityValuation: "par" });
    expectWarnings(output, ["liability-valued-at-par"]);
  });

  it("degrades instead of erroring when collateral no longer covers debt (E4)", async () => {
    const output = await fetchFixture({ baseDebt: 400_000n * 10n ** 18n });

    expect(output.metadata?.totalLiabilitiesUsd).toBeCloseTo(400_000 + 1_000, 5);
    expect(output.metadata?.collateralizationRatio).toBeLessThan(1);
    expectWarnings(output, ["reserve-undercollateralized"]);
  });

  it("fails closed when a collateral token has no DefiLlama price", async () => {
    await expect(fetchFixture({ missingPriceFor: WSTETH })).rejects.toThrow("missing DefiLlama price");
  });

  it("fails closed when the controller market list disagrees with its count", async () => {
    await expect(fetchFixture({}, 3)).rejects.toThrow("get_all_markets returned 2 entries for count 3");
  });

  it("fits a wide band span into bounded Multicall3 pages", async () => {
    const run = await runAdapter("money-llamma", "money-defi-money", {
      network: moneyNetwork({}, 2, { wbtcMaxBand: 1_500 }),
      nowSec: NOW_SEC,
    });
    const arbitrumUrl = run.network.chainRpcs.get("arbitrum")?.rpcUrl ?? "";
    expect(arbitrumUrl).not.toBe("");
    // 1 501 bands x (y + x) = 3 002 band reads on top of the two block reads
    // and the head/operators/metadata rounds. They must fit two Multicall3
    // pages (2 000 calls each); per-band or 500-call batching would make this
    // count larger.
    const arbitrumPosts = run.network.requests.filter((request) => request.url.startsWith(arbitrumUrl)).length;
    expect(arbitrumPosts).toBe(2 + 3 + 2);
    expect(run.network.rpcCalls.filter((call) =>
      !call.viaMulticall && (call.selector === BANDS_Y_SELECTOR || call.selector === BANDS_X_SELECTOR)
    )).toHaveLength(0);
    expect(run.network.unmatched).toHaveLength(0);
    expect(run.result.metadata?.details).toMatchObject({ bandReadCount: 1_501 + 2 + 1 });
  });
});

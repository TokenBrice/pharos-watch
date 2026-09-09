import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Abi } from "abitype";
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters } from "viem/utils";
import { fetchMoneyReserves } from "../money-llamma";

const multicallCall = vi.hoisted(() => vi.fn());
const defillamaPrices = vi.hoisted(() => vi.fn());
const pinnedPlan = vi.hoisted(() => vi.fn());

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchOnchainMulticall3: multicallCall,
    fetchDefiLlamaPrices: defillamaPrices,
  };
});

vi.mock("../evm-observation-plan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../evm-observation-plan")>();
  return {
    ...actual,
    pinnedBlockPlan: pinnedPlan,
  };
});

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

const CONFIG = {
  adapter: "money-llamma" as const,
  version: 1,
  semantics: "collateral-mix" as const,
  breakerScope: "money-defi-money",
  inputs: {
    primary: { kind: "onchain-evm" as const, chain: "arbitrum", rpcMode: "public-rpc" as const },
  },
};

interface Scenario {
  moneyPrice?: number;
  arbitrumDebt: [bigint, bigint];
  baseDebt: bigint;
  missingPriceFor?: string;
}

const ARB_SUPPLY = 5_000_000n * 10n ** 18n;
const BASE_SUPPLY = 5_000_000n * 10n ** 18n;
const OP_SUPPLY = 100n * 10n ** 18n;

function installReads(scenario: Partial<Scenario> = {}): void {
  const moneyPrice = scenario.moneyPrice ?? 1;
  const [arbDebt1, arbDebt2] = scenario.arbitrumDebt ?? [1_000n * 10n ** 18n, 0n];
  const baseDebt = scenario.baseDebt ?? 500n * 10n ** 18n;

  const values = new Map<string, `0x${string}`>();

  const put = (chain: string, contract: string, abi: Abi, fn: string, args: readonly unknown[], result: `0x${string}`) => {
    values.set(`${chain}:${contract.toLowerCase()}:${encodeFunctionData({ abi, functionName: fn, args })}`, result);
  };

  // Arbitrum: WBTC market (2 bands) + WETH market (2 bands).
  put("arbitrum", CONTROLLER, CONTROLLER_ABI, "get_market_count", [], word(2n));
  put("arbitrum", CONTROLLER, CONTROLLER_ABI, "get_all_markets", [], addressListWord([OP1, OP2]));
  put("arbitrum", MONEY, ERC20_ABI, "totalSupply", [], word(ARB_SUPPLY));
  put("arbitrum", OP1, OPERATOR_ABI, "COLLATERAL_TOKEN", [], addressWord(WBTC));
  put("arbitrum", OP1, OPERATOR_ABI, "AMM", [], addressWord(AMM1));
  put("arbitrum", OP1, OPERATOR_ABI, "total_debt", [], word(arbDebt1));
  put("arbitrum", WBTC, ERC20_ABI, "symbol", [], stringWord("WBTC"));
  put("arbitrum", WBTC, ERC20_ABI, "decimals", [], word(8n));
  put("arbitrum", AMM1, LLAMMA_ABI, "min_band", [], intWord(0n));
  put("arbitrum", AMM1, LLAMMA_ABI, "max_band", [], intWord(1n));
  put("arbitrum", AMM1, LLAMMA_ABI, "bands_y", [0n], word(500_000n * 10n ** 12n));
  put("arbitrum", AMM1, LLAMMA_ABI, "bands_x", [0n], word(0n));
  put("arbitrum", AMM1, LLAMMA_ABI, "bands_y", [1n], word(1n * 10n ** 18n));
  put("arbitrum", AMM1, LLAMMA_ABI, "bands_x", [1n], word(0n));
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

  multicallCall.mockImplementation(
    async ({ calls, chain }: { calls: Array<{ label: string; contract: string; data: string }>; chain: string }) =>
      calls.map((call) => {
        const value = values.get(`${chain}:${call.contract.toLowerCase()}:${call.data}`);
        return { label: call.label, success: value != null, returnData: value ?? "0x" };
      }),
  );

  let blockCounter = 0;
  pinnedPlan.mockImplementation(async ({ chain }: { chain: string }) => {
    blockCounter += 1;
    return {
      observedBlock: { chain, number: 280_000_000 + blockCounter, timestamp: 1_757_000_000 },
      ctx: { observedBlock: { chain, number: 280_000_000 + blockCounter, timestamp: 1_757_000_000 } },
    };
  });

  const priceMap = new Map<string, number>([
    [WBTC.toLowerCase(), 100_000],
    [WETH.toLowerCase(), 3_000],
    [WSTETH.toLowerCase(), 4_000],
    ["money:arbitrum", moneyPrice],
    ["money:base", moneyPrice],
    ["money:optimism", moneyPrice],
  ]);
  if (scenario.missingPriceFor) {
    priceMap.delete(scenario.missingPriceFor.toLowerCase());
  }
  defillamaPrices.mockImplementation(async (assets: Array<{ key: string }>) => {
    return new Map(assets.map((asset) => [asset.key, priceMap.get(asset.key.toLowerCase())]).filter(([, v]) => v != null) as Array<[string, number]>);
  });
}

async function fetchFixture() {
  return fetchMoneyReserves({ id: "money-defi-money" } as never, CONFIG as never, new AbortController().signal);
}

describe("money-llamma adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installReads();
  });

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
    expect(output.warnings).toBeUndefined();
  });

  it("publishes an off-par MONEY price as info and market-values the debt", async () => {
    installReads({ moneyPrice: 1.02 });

    const output = await fetchFixture();

    expect(output.metadata?.moneyPriceUsd).toBe(1.02);
    expect(output.metadata?.totalLiabilitiesUsd).toBeCloseTo(1_500 * 1.02, 5);
    expect(output.warnings).toEqual([
      expect.objectContaining({ code: "money-off-par", effect: "info", severity: "info" }),
    ]);
  });

  it("values the MONEY debt liability at par when DefiLlama has no MONEY price", async () => {
    // The adapter reads its MONEY quote from the first chain leg; with no
    // usable quote the debt falls back to par while collateral stays
    // DefiLlama-priced.
    installReads({ missingPriceFor: "money:arbitrum" });

    const output = await fetchFixture();

    expect(output.metadata?.moneyPriceUsd).toBeUndefined();
    expect(output.metadata?.totalReserveUsd).toBe(380_000);
    expect(output.metadata?.totalLiabilitiesUsd).toBe(1_500);
    expect(output.metadata?.supplyUsd).toBe(10_000_100);
    expect(output.metadata?.collateralizationRatio).toBeCloseTo(380_000 / 1_500, 5);
    expect(output.metadata?.details).toMatchObject({ liabilityValuation: "par" });
    expect(output.warnings).toEqual([
      expect.objectContaining({ code: "liability-valued-at-par", effect: "info", severity: "info" }),
    ]);
  });

  it("degrades instead of erroring when collateral no longer covers debt (E4)", async () => {
    installReads({ baseDebt: 400_000n * 10n ** 18n });

    const output = await fetchFixture();

    expect(output.metadata?.totalLiabilitiesUsd).toBeCloseTo(400_000 + 1_000, 5);
    expect(output.metadata?.collateralizationRatio).toBeLessThan(1);
    expect(output.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" }),
      ]),
    );
  });

  it("fails closed when a collateral token has no DefiLlama price", async () => {
    installReads({ missingPriceFor: WSTETH });

    await expect(fetchFixture()).rejects.toThrow("missing DefiLlama price");
  });

  it("fails closed when the controller market list disagrees with its count", async () => {
    const values = new Map<string, `0x${string}`>();
    values.set(
      `arbitrum:${CONTROLLER.toLowerCase()}:${encodeFunctionData({ abi: CONTROLLER_ABI, functionName: "get_market_count" })}`,
      word(3n),
    );
    values.set(
      `arbitrum:${CONTROLLER.toLowerCase()}:${encodeFunctionData({ abi: CONTROLLER_ABI, functionName: "get_all_markets" })}`,
      addressListWord([OP1, OP2]),
    );
    values.set(
      `arbitrum:${MONEY.toLowerCase()}:${encodeFunctionData({ abi: ERC20_ABI, functionName: "totalSupply" })}`,
      word(ARB_SUPPLY),
    );
    multicallCall.mockImplementation(
      async ({ calls, chain }: { calls: Array<{ label: string; contract: string; data: string }>; chain: string }) =>
        calls.map((call) => {
          const value = values.get(`${chain}:${call.contract.toLowerCase()}:${call.data}`);
          return { label: call.label, success: true, returnData: value ?? "0x" };
        }),
    );

    await expect(fetchFixture()).rejects.toThrow("get_all_markets returned 2 entries for count 3");
  });
});

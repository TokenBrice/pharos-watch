import { describe, it, expect } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  resolveBaseSymbol,
  bucketForAsset,
  adaptFirmMarkets,
  fetchDolaInverseReserves,
  listUnexpectedDolaAssets,
  type FirmMarket,
} from "../dola-inverse";
import { expectValidAdapterOutput, installAdapterNetwork } from "./reserve-adapter.test-support";

function makeMarket(symbol: string, totalDebt = 1_000_000): FirmMarket {
  return { name: `${symbol} Market`, underlying: { symbol }, totalDebt, borrowPaused: false };
}

const PSM_ADDRESS = "0x4dfd662622d766304cb539e66f893c4defa19398";
const SUSDS_ADDRESS = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd";
const USDS_ADDRESS = "0xdc035d45d973e3ec169d2276ddab16f1e407384f";
const DOLA_ADDRESS = "0x865377367054516e17014ccded1e7d814edc9ce4";
const VAULT_SELECTOR = "0xfbfa77cf";
const COLLATERAL_SELECTOR = "0xd8dfeb45";
const DOLA_SELECTOR = "0x92c592d0";
const SUPPLY_SELECTOR = "0x047fc9aa";
const SELL_FEE_BPS_SELECTOR = "0x23cbe1f3";
const MAX_WITHDRAW_DATA = `0xce96cb77${PSM_ADDRESS.slice(2).padStart(64, "0")}`;
const DOLA_ENDPOINT = "https://www.inverse.finance/api/f2/fixed-markets";
const DOLA_LIVE_CONFIG = {
  adapter: "dola-inverse",
  version: 1,
  semantics: "collateral-mix",
  inputs: { primary: { kind: "http-json", url: DOLA_ENDPOINT } },
} as never;

function word(hexBody: string): string {
  return `0x${hexBody.replace(/^0x/, "").padStart(64, "0")}`;
}

function dolaNetwork(options: {
  vault?: string | null;
  collateral?: string | null;
  dola?: string | null;
  supply?: bigint | null;
  maxWithdraw?: bigint | null;
  sellFeeBps?: bigint | null;
} = {}) {
  return installAdapterNetwork({
    chains: { ethereum: "https://rpc.example" },
    json: {
      [DOLA_ENDPOINT]: {
        markets: [makeMarket("wstETH", 1_000_000)],
        timestamp: 1_776_330_494,
      },
    },
    rpc: {
      [`${PSM_ADDRESS}:${VAULT_SELECTOR}`]: options.vault === undefined ? word(SUSDS_ADDRESS) : options.vault,
      [`${PSM_ADDRESS}:${COLLATERAL_SELECTOR}`]:
        options.collateral === undefined ? word(USDS_ADDRESS) : options.collateral,
      [`${PSM_ADDRESS}:${DOLA_SELECTOR}`]: options.dola === undefined ? word(DOLA_ADDRESS) : options.dola,
      [`${PSM_ADDRESS}:${SUPPLY_SELECTOR}`]: options.supply === undefined ? 0n : options.supply,
      [`${PSM_ADDRESS}:${SELL_FEE_BPS_SELECTOR}`]: options.sellFeeBps === undefined ? 20n : options.sellFeeBps,
      [`${SUSDS_ADDRESS}:${MAX_WITHDRAW_DATA}`]:
        options.maxWithdraw === undefined ? 0n : options.maxWithdraw,
    },
  });
}

async function runDola(options: Parameters<typeof dolaNetwork>[0] = {}, db?: D1Database) {
  const network = dolaNetwork(options);
  const result = await fetchDolaInverseReserves(
    { id: "dola-inverse-finance" } as never,
    DOLA_LIVE_CONFIG,
    new AbortController().signal,
    { chainRpcs: network.chainRpcs, nowSec: 1_776_330_494, db },
  );
  return { result, network };
}

/** Stablecoins-cache D1 fixture keyed the way the registry publishes DOLA. */
function dolaCacheDb(circulating: number) {
  return mockD1([{
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: ["stablecoins"],
    rows: [{
      key: "stablecoins",
      value: JSON.stringify({
        peggedAssets: [{ id: "dola-inverse-finance", symbol: "DOLA", circulating: { peggedUSD: circulating } }],
      }),
      updated_at: 1_776_330_494 - 600,
    }],
  }]);
}

describe("resolveBaseSymbol", () => {
  it.each([
    ["yv-DOLA-sUSDe", "sUSDe"],
    ["yv-sDOLA-scrvUSD", "scrvUSD"],
    ["yv-reUSD-sDOLA", "reUSD"],
    ["yv-WETH", "WETH"],
    ["DOLA-sUSDe clp", "sUSDe"],
    ["DOLA-wstUSR lp", "wstUSR"],
    ["sDOLA-scrvUSD clp", "scrvUSD"],
    ["reUSD-sDOLA clp", "reUSD"],
    ["yv-DOLA-FraxPyUSD lp", "FraxPyUSD lp"],
    ["WBTC", "WBTC"],
    ["INV", "INV"],
  ])("resolves %s to %s", (symbol, expected) => {
    expect(resolveBaseSymbol(makeMarket(symbol))).toBe(expected);
  });
});

describe("bucketForAsset", () => {
  it("classifies stablecoin assets", () => {
    for (const asset of ["sUSDe", "DAI", "USDC", "PYUSD", "USR", "DOLA-FRAXBP"]) {
      expect(bucketForAsset(asset)).toBe("stablecoin");
    }
  });

  it("classifies ETH/LST assets", () => {
    for (const asset of ["WETH", "wstETH", "rETH", "weETH"]) {
      expect(bucketForAsset(asset)).toBe("eth-lst");
    }
  });

  it("classifies BTC assets", () => {
    for (const asset of ["WBTC", "cbBTC", "tBTC"]) {
      expect(bucketForAsset(asset)).toBe("btc");
    }
  });

  it("classifies governance assets", () => {
    for (const asset of ["INV", "CRV", "CVX"]) {
      expect(bucketForAsset(asset)).toBe("governance");
    }
  });

  it("classifies unknown assets as other", () => {
    expect(bucketForAsset("UNKNOWN_TOKEN")).toBe("other");
  });
});

describe("adaptFirmMarkets", () => {
  it("produces correct bucket slices from mixed collateral", () => {
    const result = adaptFirmMarkets({
      markets: [
        makeMarket("wstETH", 5_000_000),
        makeMarket("sUSDe", 3_000_000),
        makeMarket("WBTC", 2_000_000),
      ],
      timestamp: 1000,
    });

    expect(result.slices).toHaveLength(3);
    const ethSlice = result.slices.find((s) => s.name.includes("ETH"));
    const stableSlice = result.slices.find((s) => s.name === "sUSDe collateral");
    const btcSlice = result.slices.find((s) => s.name.includes("BTC"));
    expect(ethSlice?.pct).toBe(50);
    expect(stableSlice).toMatchObject({
      pct: 30,
      coinId: "susde-ethena",
      depType: "collateral",
    });
    expect(btcSlice?.pct).toBe(20);
  });

  it("maps reUSD-paired markets to the tracked Resupply dependency", () => {
    const result = adaptFirmMarkets({
      markets: [
        makeMarket("reUSD-sDOLA clp", 1_500_000),
        makeMarket("yv-reUSD-sDOLA", 500_000),
        makeMarket("sDOLA-scrvUSD clp", 2_000_000),
      ],
      timestamp: 1000,
    }, 4_000_000);

    const reusdSlice = result.slices.find((s) => s.name === "reUSD collateral");
    expect(reusdSlice).toMatchObject({
      pct: 50,
      coinId: "reusd-resupply",
      depType: "collateral",
      risk: "high",
    });
    const scrvusdSlice = result.slices.find((s) => s.name === "scrvUSD collateral");
    expect(scrvusdSlice).toMatchObject({ pct: 50, coinId: "scrvusd-curve" });
    expect(result.metadata?.unknownExposurePct).toBe(0);
    expect(listUnexpectedDolaAssets({
      markets: [
        makeMarket("reUSD-sDOLA clp", 1_500_000),
        makeMarket("yv-reUSD-sDOLA", 500_000),
        makeMarket("sDOLA-scrvUSD clp", 2_000_000),
      ],
      timestamp: 1000,
    })).toEqual([]);
  });

  it("includes non-FiRM issuance in unknown exposure rather than normalizing it away", () => {
    const result = adaptFirmMarkets({ markets: [makeMarket("wstETH", 60)], timestamp: 1000 }, 100);
    expect(result.metadata?.unknownExposurePct).toBe(40);
    expect(result.slices).toContainEqual({ sourceKey: "dola-inverse:unattributed", name: "Unattributed non-FiRM issuance", pct: 40, risk: "high" });
  });

  it("filters out zero-debt markets", () => {
    const result = adaptFirmMarkets({
      markets: [
        makeMarket("wstETH", 1_000_000),
        makeMarket("WBTC", 0),
      ],
      timestamp: 1000,
    });

    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].name).toContain("ETH");
    expect(result.slices[0].pct).toBe(100);
  });

  it("includes activeMarkets in metadata", () => {
    const result = adaptFirmMarkets({
      markets: [
        makeMarket("wstETH", 1_000_000),
        makeMarket("WBTC", 0),
        makeMarket("INV", 500_000),
      ],
      timestamp: 12345,
    });

    expect(result.metadata?.activeMarkets).toBe(2);
    expect(result.metadata?.totalMarkets).toBe(3);
    expect(result.metadata?.timestamp).toBe(12345);
    expect(result.metadata?.sourceTimestamp).toBe(12345);
    expect(result.metadata?.freshnessMode).toBe("verified");
    expect(result.metadata?.redemption).toBeUndefined();
    expectValidAdapterOutput("dola-inverse", result);
  });

  it("normalizes millisecond API timestamps before validation", () => {
    const result = adaptFirmMarkets({
      markets: [makeMarket("wstETH", 1_000_000)],
      timestamp: 1_776_330_494_053,
    });

    expect(result.metadata?.timestamp).toBe(1_776_330_494);
    expect(result.metadata?.sourceTimestamp).toBe(1_776_330_494);
    expect(result.metadata?.freshnessMode).toBe("verified");
    expectValidAdapterOutput("dola-inverse", result);
  });

  it("assigns correct risk levels to each bucket", () => {
    const result = adaptFirmMarkets({
      markets: [
        makeMarket("sUSDe", 1_000_000),
        makeMarket("wstETH", 1_000_000),
        makeMarket("WBTC", 1_000_000),
        makeMarket("INV", 1_000_000),
      ],
      timestamp: 1000,
    });

    const riskByPrefix: Record<string, string> = {};
    for (const s of result.slices) {
      const prefix = s.name.split(" (")[0];
      riskByPrefix[prefix] = s.risk;
    }
    expect(riskByPrefix["sUSDe collateral"]).toBe("high");
    expect(riskByPrefix["ETH / Liquid staking"]).toBe("low");
    expect(riskByPrefix["BTC"]).toBe("medium");
    expect(riskByPrefix["Governance tokens"]).toBe("very-high");
  });

  it("treats prototype-key symbols as unknown collateral instead of tracked stablecoins", () => {
    const result = adaptFirmMarkets({
      markets: [
        makeMarket("toString", 1_000_000),
        makeMarket("sUSDe", 1_000_000),
      ],
      timestamp: 1000,
    });

    expect(result.slices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceKey: "dola-inverse:susde",
        name: "sUSDe collateral",
        pct: 50,
        risk: "high",
        coinId: "susde-ethena",
      }),
      expect.objectContaining({
        sourceKey: "dola-inverse:other",
        name: "Other collateral",
        pct: 50,
        risk: "high",
      }),
    ]));
    expect(result.slices.find((slice) => slice.name === "toString collateral")).toBeUndefined();
    expectValidAdapterOutput("dola-inverse", result);
  });
});

describe("fetchDolaInverseReserves PSM redemption telemetry", () => {
  it("publishes the measured zero capacity without claiming the route is open", async () => {
    // The PSM has been empty since 2025-12-10. It is not paused — it has
    // nothing to pay out — so neither "open" nor "paused" is an honest claim.
    const { result } = await runDola({ supply: 0n, maxWithdraw: 0n });

    expect(result.metadata).toMatchObject({
      psmSupplyRaw: "0",
      psmVaultWithdrawableRaw: "0",
      redemption: {
        capacityUsd: 0,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        feeBps: 20,
      },
    });
    expect(result.metadata?.redemption?.routeStatus).toBeUndefined();
    expect(result.metadata?.redemption?.routeStatusSource).toBeUndefined();
    expect(result.metadata?.redemption?.routeStatusReason).toBeUndefined();
    expectValidAdapterOutput("dola-inverse", result);
  });

  it("reports the route open and binds capacity to the lower of supply() and vault maxWithdraw()", async () => {
    const { result } = await runDola({ supply: 5_000n * 10n ** 18n, maxWithdraw: 8_000n * 10n ** 18n });

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 5_000,
      capacityKind: "live-direct",
      routeStatus: "open",
      routeStatusSource: "onchain",
      feeBps: 20,
    });
    expect(result.metadata?.redemption?.routeStatusReason).toContain("supply()");
    expect(result.metadata?.redemption?.sourceUrls).toContain(
      "https://docs.inverse.finance/inverse-finance/inverse-finance/products/peg-stability-module",
    );
    expectValidAdapterOutput("dola-inverse", result);
  });

  it("binds capacity to the vault leg when the sUSDS vault cannot pay out the full accounted supply", async () => {
    const { result } = await runDola({ supply: 9_000n * 10n ** 18n, maxWithdraw: 1_500n * 10n ** 18n });
    expect(result.metadata?.redemption?.capacityUsd).toBe(1_500);
  });

  it("withholds the whole redemption block when the PSM vault identity no longer matches sUSDS", async () => {
    const { result } = await runDola({
      vault: word("0x1111111111111111111111111111111111111111"),
      supply: 5_000n * 10n ** 18n,
    });

    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.psmSupplyRaw).toBeUndefined();
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "dola-psm-unreadable", effect: "info" })]),
    );
    expectValidAdapterOutput("dola-inverse", result);
  });


  it("measures non-FiRM issuance from the fresh stablecoins cache instead of degrading", async () => {
    const { result } = await runDola({}, dolaCacheDb(1_500_000));

    expect(result.warnings ?? []).not.toContainEqual(expect.objectContaining({ code: "dola-supply-unavailable" }));
    expect(result.metadata).toMatchObject({ supplyUsd: 1_500_000 });
    expect(result.slices.find((slice) => slice.sourceKey === "dola-inverse:unattributed")?.pct).toBeCloseTo(33.3, 1);
    expectValidAdapterOutput("dola-inverse", result);
  });

  it("withholds the whole redemption block when supply() cannot be read", async () => {
    const { result } = await runDola({ supply: null });

    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "dola-psm-unreadable" })]),
    );
  });

  it("still publishes capacity when the sellFeeBps() read fails", async () => {
    const { result } = await runDola({
      supply: 5_000n * 10n ** 18n,
      maxWithdraw: 5_000n * 10n ** 18n,
      sellFeeBps: null,
    });

    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 5_000, routeStatus: "open" });
    expect(result.metadata?.redemption?.feeBps).toBeUndefined();
    expectValidAdapterOutput("dola-inverse", result);
  });

  it("rejects a sellFeeBps() reading outside the contract's own bps denominator", async () => {
    const { result } = await runDola({
      supply: 5_000n * 10n ** 18n,
      maxWithdraw: 5_000n * 10n ** 18n,
      sellFeeBps: 10_001n,
    });

    expect(result.metadata?.redemption?.feeBps).toBeUndefined();
  });

  it("fails closed when the FiRM payload drops its markets field", async () => {
    const network = installAdapterNetwork({
      chains: { ethereum: "https://rpc.example" },
      json: { [DOLA_ENDPOINT]: { timestamp: 1_776_330_494 } },
      rpc: {
        [`${PSM_ADDRESS}:${VAULT_SELECTOR}`]: word(SUSDS_ADDRESS),
        [`${PSM_ADDRESS}:${COLLATERAL_SELECTOR}`]: word(USDS_ADDRESS),
        [`${PSM_ADDRESS}:${DOLA_SELECTOR}`]: word(DOLA_ADDRESS),
        [`${PSM_ADDRESS}:${SUPPLY_SELECTOR}`]: 0n,
        [`${PSM_ADDRESS}:${SELL_FEE_BPS_SELECTOR}`]: 20n,
        [`${SUSDS_ADDRESS}:${MAX_WITHDRAW_DATA}`]: 0n,
      },
    });

    await expect(fetchDolaInverseReserves(
      { id: "dola-inverse-finance" } as never,
      DOLA_LIVE_CONFIG,
      new AbortController().signal,
      { chainRpcs: network.chainRpcs, nowSec: 1_776_330_494 },
    )).rejects.toThrow(/markets|findIndex/i);
  });
});

describe("listUnexpectedDolaAssets", () => {
  it("returns empty array when all assets are known", () => {
    const result = listUnexpectedDolaAssets({
      markets: [makeMarket("wstETH"), makeMarket("USDC")],
      timestamp: 1000,
    });
    expect(result).toEqual([]);
  });

  it("returns unknown asset symbols", () => {
    const result = listUnexpectedDolaAssets({
      markets: [makeMarket("wstETH"), makeMarket("MAGIC_TOKEN", 500)],
      timestamp: 1000,
    });
    expect(result).toEqual(["MAGIC_TOKEN"]);
  });

  it("ignores zero-debt markets", () => {
    const result = listUnexpectedDolaAssets({
      markets: [makeMarket("MAGIC_TOKEN", 0)],
      timestamp: 1000,
    });
    expect(result).toEqual([]);
  });
});

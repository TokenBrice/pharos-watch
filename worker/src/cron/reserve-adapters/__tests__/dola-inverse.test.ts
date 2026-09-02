import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const { makeOnchainCallersMock } = await import("./helpers/onchain-callers-mock");
  const fetchOnchainUint256 = vi.fn();
  const fetchOnchainRawCall = vi.fn();
  return {
    ...actual,
    fetchJsonAdapterInput: vi.fn(),
    fetchOnchainUint256,
    fetchOnchainRawCall,
    makeOnchainCallers: makeOnchainCallersMock({
      uint256: fetchOnchainUint256,
      raw: fetchOnchainRawCall,
    }),
  };
});

import { fetchJsonAdapterInput, fetchOnchainRawCall, fetchOnchainUint256 } from "../helpers";
import {
  resolveBaseSymbol,
  bucketForAsset,
  adaptFirmMarkets,
  fetchDolaInverseReserves,
  listUnexpectedDolaAssets,
  type FirmMarket,
} from "../dola-inverse";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";

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
const DOLA_LIVE_CONFIG = {
  adapter: "dola-inverse",
  version: 1,
  semantics: "collateral-mix",
  inputs: { primary: { kind: "http-json", url: "https://www.inverse.finance/api/f2/fixed-markets" } },
} as never;

function word(hexBody: string): string {
  return `0x${hexBody.replace(/^0x/, "").padStart(64, "0")}`;
}

/**
 * Route the mocked callers by contract and selector: the adapter fires the
 * three identity reads, supply(), maxWithdraw() and sellFeeBps() concurrently,
 * so ordered mock queues would be fragile here.
 */
function primeDolaPsmMocks(options: {
  vault?: string | null;
  collateral?: string | null;
  dola?: string | null;
  supply?: bigint | null;
  maxWithdraw?: bigint | null;
  sellFeeBps?: bigint | null;
} = {}) {
  const vault = options.vault === undefined ? word(SUSDS_ADDRESS) : options.vault;
  const collateral = options.collateral === undefined ? word(USDS_ADDRESS) : options.collateral;
  const dola = options.dola === undefined ? word(DOLA_ADDRESS) : options.dola;
  vi.mocked(fetchOnchainRawCall).mockImplementation((args: unknown) => {
    const { contract, data } = args as { contract: string; data: string };
    if (contract !== PSM_ADDRESS) return Promise.resolve(null);
    if (data === VAULT_SELECTOR) return Promise.resolve(vault);
    if (data === COLLATERAL_SELECTOR) return Promise.resolve(collateral);
    if (data === DOLA_SELECTOR) return Promise.resolve(dola);
    return Promise.resolve(null);
  });
  vi.mocked(fetchOnchainUint256).mockImplementation((args: unknown) => {
    const { contract, data } = args as { contract: string; data: string };
    if (contract === PSM_ADDRESS && data === SUPPLY_SELECTOR) {
      return Promise.resolve(options.supply === undefined ? 0n : options.supply);
    }
    if (contract === PSM_ADDRESS && data === SELL_FEE_BPS_SELECTOR) {
      return Promise.resolve(options.sellFeeBps === undefined ? 20n : options.sellFeeBps);
    }
    if (contract === SUSDS_ADDRESS && data === MAX_WITHDRAW_DATA) {
      return Promise.resolve(options.maxWithdraw === undefined ? 0n : options.maxWithdraw);
    }
    return Promise.resolve(null);
  });
  vi.mocked(fetchJsonAdapterInput).mockResolvedValue({
    markets: [makeMarket("wstETH", 1_000_000)],
    timestamp: 1_776_330_494,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  primeDolaPsmMocks();
});

describe("resolveBaseSymbol", () => {
  it("extracts asset from Yearn DOLA vault: yv-DOLA-sUSDe → sUSDe", () => {
    expect(resolveBaseSymbol(makeMarket("yv-DOLA-sUSDe"))).toBe("sUSDe");
  });

  it("extracts asset from Yearn staked DOLA vault: yv-sDOLA-scrvUSD → scrvUSD", () => {
    expect(resolveBaseSymbol(makeMarket("yv-sDOLA-scrvUSD"))).toBe("scrvUSD");
  });

  it("extracts asset from Yearn reUSD/staked-DOLA vault: yv-reUSD-sDOLA → reUSD", () => {
    expect(resolveBaseSymbol(makeMarket("yv-reUSD-sDOLA"))).toBe("reUSD");
  });

  it("handles Yearn non-DOLA vault: yv-WETH → WETH", () => {
    expect(resolveBaseSymbol(makeMarket("yv-WETH"))).toBe("WETH");
  });

  it("extracts asset from Curve CLP: DOLA-sUSDe clp → sUSDe", () => {
    expect(resolveBaseSymbol(makeMarket("DOLA-sUSDe clp"))).toBe("sUSDe");
  });

  it("extracts asset from Curve LP: DOLA-wstUSR lp → wstUSR", () => {
    expect(resolveBaseSymbol(makeMarket("DOLA-wstUSR lp"))).toBe("wstUSR");
  });

  it("extracts asset from staked-DOLA Curve CLP: sDOLA-scrvUSD clp → scrvUSD", () => {
    expect(resolveBaseSymbol(makeMarket("sDOLA-scrvUSD clp"))).toBe("scrvUSD");
  });

  it("extracts asset from reUSD/staked-DOLA Curve CLP: reUSD-sDOLA clp → reUSD", () => {
    expect(resolveBaseSymbol(makeMarket("reUSD-sDOLA clp"))).toBe("reUSD");
  });

  it("handles Yearn FraxPyUSD LP: yv-DOLA-FraxPyUSD lp → FraxPyUSD lp", () => {
    expect(resolveBaseSymbol(makeMarket("yv-DOLA-FraxPyUSD lp"))).toBe("FraxPyUSD lp");
  });

  it("returns plain symbol unchanged: WBTC → WBTC", () => {
    expect(resolveBaseSymbol(makeMarket("WBTC"))).toBe("WBTC");
  });

  it("returns non-DOLA prefix unchanged: INV → INV", () => {
    expect(resolveBaseSymbol(makeMarket("INV"))).toBe("INV");
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
    });

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
        name: "sUSDe collateral",
        pct: 50,
        risk: "high",
        coinId: "susde-ethena",
      }),
      expect.objectContaining({
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
    primeDolaPsmMocks({ supply: 0n, maxWithdraw: 0n });
    const result = await fetchDolaInverseReserves({ id: "dola-inverse-finance" } as never, DOLA_LIVE_CONFIG, new AbortController().signal);

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
    primeDolaPsmMocks({ supply: 5_000n * 10n ** 18n, maxWithdraw: 8_000n * 10n ** 18n });
    const result = await fetchDolaInverseReserves({ id: "dola-inverse-finance" } as never, DOLA_LIVE_CONFIG, new AbortController().signal);

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
    primeDolaPsmMocks({ supply: 9_000n * 10n ** 18n, maxWithdraw: 1_500n * 10n ** 18n });
    const result = await fetchDolaInverseReserves({ id: "dola-inverse-finance" } as never, DOLA_LIVE_CONFIG, new AbortController().signal);

    expect(result.metadata?.redemption?.capacityUsd).toBe(1_500);
  });

  it("withholds the whole redemption block when the PSM vault identity no longer matches sUSDS", async () => {
    primeDolaPsmMocks({ vault: word("0x1111111111111111111111111111111111111111"), supply: 5_000n * 10n ** 18n });
    const result = await fetchDolaInverseReserves({ id: "dola-inverse-finance" } as never, DOLA_LIVE_CONFIG, new AbortController().signal);

    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.psmSupplyRaw).toBeUndefined();
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "dola-psm-unreadable", effect: "info" })]),
    );
    expectValidAdapterOutput("dola-inverse", result);
  });

  it("withholds the whole redemption block when supply() cannot be read", async () => {
    primeDolaPsmMocks({ supply: null });
    const result = await fetchDolaInverseReserves({ id: "dola-inverse-finance" } as never, DOLA_LIVE_CONFIG, new AbortController().signal);

    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "dola-psm-unreadable" })]),
    );
  });

  it("still publishes capacity when the sellFeeBps() read fails", async () => {
    primeDolaPsmMocks({ supply: 5_000n * 10n ** 18n, maxWithdraw: 5_000n * 10n ** 18n, sellFeeBps: null });
    const result = await fetchDolaInverseReserves({ id: "dola-inverse-finance" } as never, DOLA_LIVE_CONFIG, new AbortController().signal);

    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 5_000, routeStatus: "open" });
    expect(result.metadata?.redemption?.feeBps).toBeUndefined();
    expectValidAdapterOutput("dola-inverse", result);
  });

  it("rejects a sellFeeBps() reading outside the contract's own bps denominator", async () => {
    primeDolaPsmMocks({ supply: 5_000n * 10n ** 18n, maxWithdraw: 5_000n * 10n ** 18n, sellFeeBps: 10_001n });
    const result = await fetchDolaInverseReserves({ id: "dola-inverse-finance" } as never, DOLA_LIVE_CONFIG, new AbortController().signal);

    expect(result.metadata?.redemption?.feeBps).toBeUndefined();
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

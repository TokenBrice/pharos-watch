import { describe, it, expect } from "vitest";
import { mockD1Strict } from "@shared/test-utils/mock-d1";
import { DASHBOARD_SOURCE_MAX_AGE_SEC } from "@shared/types/live-reserve-adapter-policy";
import firmMarketsCapture from "./fixtures/dola-fixed-markets-2026-09-29.json";
import firmLedgerCapture from "./fixtures/dola-firm-ledger-2026-10-17.json";
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
  return { name: `${symbol} Market`, underlying: { symbol }, totalDebt, dolaLiquidity: 0, borrowPaused: false };
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
const REPAYMENTS_ENDPOINT = "https://www.inverse.finance/api/transparency/repayments-v2?v=3";
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
  repayments?: unknown;
  markets?: FirmMarket[];
  marketRpc?: Record<string, bigint | null>;
} = {}) {
  return installAdapterNetwork({
    chains: { ethereum: "https://rpc.example" },
    json: {
      [DOLA_ENDPOINT]: {
        markets: options.markets ?? [makeMarket("wstETH", 1_000_000)],
        timestamp: 1_776_330_494,
      },
      [REPAYMENTS_ENDPOINT]: options.repayments ?? {
        timestamp: 1_776_330_494,
        lastBlock: 23_000_000,
        badDebts: { DOLA: { frontierBadDebtBalance: 100_000 } },
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
      ...options.marketRpc,
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
function dolaCacheDb(circulating: number, price: number | null = 1) {
  return mockD1Strict([{
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: ["stablecoins"],
    rows: [{
      key: "stablecoins",
      value: JSON.stringify({
        peggedAssets: [{ id: "dola-inverse-finance", symbol: "DOLA", price, circulating: { peggedUSD: circulating } }],
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

  it("classifies unknown assets as other", () => {
    expect(bucketForAsset("UNKNOWN_TOKEN")).toBe("other");
  });
});

describe("adaptFirmMarkets", () => {
  it("maps the identified staked yBOLD collateral while preserving unknown collateral", () => {
    const payload = { markets: [makeMarket("ysyBOLD", 80), makeMarket("UNKNOWN", 20)], timestamp: 1_776_330_494 };
    const result = adaptFirmMarkets(payload, 100);
    expect(result.slices).toContainEqual({
      sourceKey: "dola-inverse:ysybold", name: "ysyBOLD collateral", pct: 80,
      risk: "medium", coinId: "ybold-yearn", depType: "collateral",
    });
    expect(result.metadata?.unknownExposurePct).toBe(20);
    expect(listUnexpectedDolaAssets(payload)).toEqual(["UNKNOWN"]);
  });

  it("recognizes sinvUSD without treating its governance backing as generic stable collateral", () => {
    const payload = {
      markets: [makeMarket("sinvUSD", 80), makeMarket("UNKNOWN", 20)],
      timestamp: 1_776_330_494,
    };
    const result = adaptFirmMarkets(payload, 100);
    expect(result.slices).toContainEqual({
      sourceKey: "dola-inverse:sinvusd",
      name: "sinvUSD collateral (sINV-backed stablecoin vault)",
      pct: 80,
      risk: "high",
    });
    expect(result.metadata?.unknownExposurePct).toBe(20);
    expect(listUnexpectedDolaAssets(payload)).toEqual(["UNKNOWN"]);
  });

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

  it("keeps issuer-captured LP debt unlinked and links only direct sUSDe debt", () => {
    const result = adaptFirmMarkets(firmMarketsCapture, 108_602_244.0893683);
    expect(result.slices.filter((slice) => slice.coinId)).toEqual([
      expect.objectContaining({ sourceKey: "dola-inverse:susde", pct: 0.4, coinId: "susde-ethena", depType: "collateral" }),
    ]);
    const lpSlices = result.slices.filter((slice) => slice.sourceKey?.startsWith("dola-inverse:lp:"));
    expect(lpSlices).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: "dola-inverse:lp:dola-susde", pct: 51.7 }),
      expect.objectContaining({ sourceKey: "dola-inverse:lp:dola-susds", pct: 5.7 }),
      expect.objectContaining({ sourceKey: "dola-inverse:lp:sdola-scrvusd", pct: 4.2 }),
      expect.objectContaining({ sourceKey: "dola-inverse:lp:reusd-sdola", pct: 2.7 }),
    ]));
    for (const slice of lpSlices) {
      expect(slice.coinId).toBeUndefined();
      expect(slice.depType).toBeUndefined();
    }
    expect(result.metadata?.unknownExposurePct).toBeGreaterThan(98);
  });

  it("nets the complete pinned FiRM idle inventory from both claims and the denominator without reserve credit", () => {
    const gross = firmLedgerCapture._evidence.grossClaimsDola;
    const frontier = firmLedgerCapture._evidence.frontierBadDebtDola;
    const result = adaptFirmMarkets(firmLedgerCapture, gross, frontier);
    const debt = firmLedgerCapture.markets.reduce((sum, market) => sum + market.totalDebt, 0);
    const idle = firmLedgerCapture.markets.reduce((sum, market) => sum + market.dolaLiquidity, 0);
    const net = gross - idle;
    const residual = net - debt - frontier;
    expect(idle).toBeCloseTo(38_462_480.39385918, 6);
    expect(result.metadata).toMatchObject({
      inventoryComplete: true, inventoryReconciled: true,
      totalDebtDola: debt, grossClaimsDola: gross, firmIdleDola: idle,
      nettedOwnDola: idle, netClaimsDola: net,
      unclassifiedResidualUsd: residual, frontierBadDebtUsd: frontier,
    });
    expect(debt + frontier + residual + idle).toBeCloseTo(gross, 6);
    expect(residual).toBeCloseTo(537_392.03701814, 6);
    expect(result.slices.find(row => row.sourceKey === "dola-inverse:unattributed")).toMatchObject({
      name: "Unresolved issuance and backing reconciliation residual", pct: 0.7,
      unclassifiedResidual: true, residualReason: "insufficient-evidence",
    });
    // One-decimal normalization assigns the ordinary rounding remainder to the largest slice.
    expect(result.slices.find(row => row.sourceKey === "dola-inverse:lp:dola-susde")?.pct).toBe(71.5);
    expect(result.slices.some(row => /idle|non-FiRM/i.test(row.name))).toBe(false);
    expect(result.slices.reduce((sum, row) => sum + row.pct, 0)).toBeCloseTo(100, 1);
    expect(result.metadata).not.toHaveProperty("totalReserveUsd");
  });

  it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "withholds inventory netting for an unreadable market balance (%s)", (dolaLiquidity) => {
      const result = adaptFirmMarkets({
        markets: [{ ...makeMarket("wstETH", 60), dolaLiquidity }], timestamp: 1000,
      }, 100);
      expect(result.metadata?.firmIdleDola).toBeNull();
      expect(result.metadata?.nettedOwnDola).toBe(0);
      expect(result.metadata?.netClaimsDola).toBe(100);
      expect(result.metadata?.unclassifiedResidualUsd).toBe(40);
    },
  );

  it("does not clamp excessive inventory into a favorable net denominator", () => {
    const result = adaptFirmMarkets({
      markets: [{ ...makeMarket("wstETH", 60), dolaLiquidity: 41 }], timestamp: 1000,
    }, 100);
    expect(result.metadata?.inventoryReconciled).toBe(false);
    expect(result.metadata?.nettedOwnDola).toBe(0);
    expect(result.metadata?.unclassifiedResidualUsd).toBe(40);
  });

  it("does not turn LP symbols or Yearn LP wrappers into direct stablecoin claims", () => {
    const result = adaptFirmMarkets({
      markets: [
        makeMarket("reUSD-sDOLA clp", 150),
        makeMarket("yv-reUSD-sDOLA", 50),
        makeMarket("sDOLA-scrvUSD clp", 200),
        makeMarket("reUSD", 100),
        { ...makeMarket("sUSDe", 100), underlying: { symbol: "sUSDe", isLP: true } },
      ],
      timestamp: 1000,
    }, 600);
    expect(result.slices.filter((slice) => slice.coinId)).toEqual([
      expect.objectContaining({ coinId: "reusd-resupply", pct: 16.7 }),
    ]);
    expect(result.metadata?.unknownExposurePct).toBeCloseTo(500 / 600 * 100);
  });

  it("keeps unresolved issuance in unknown exposure rather than normalizing it away", () => {
    const result = adaptFirmMarkets({ markets: [makeMarket("wstETH", 60)], timestamp: 1000 }, 100);
    expect(result.metadata?.unknownExposurePct).toBe(40);
    expect(result.metadata?.frontierBadDebtUsd).toBeNull();
    expect(result.slices.find(row => row.sourceKey === "dola-inverse:unattributed")?.pct).toBe(40);
    expect(result.slices.some(row => row.sourceKey === "dola-inverse:frontier-bad-debt")).toBe(false);
  });

  it("splits only measured Frontier bad debt against the same supply denominator", () => {
    const result = adaptFirmMarkets({ markets: [makeMarket("wstETH", 60)], timestamp: 1000 }, 100, 7);
    expect(result.slices.find(row => row.sourceKey === "dola-inverse:frontier-bad-debt")).toMatchObject({
      pct: 7, risk: "very-high", assetClass: "private-credit",
    });
    expect(result.slices.find(row => row.sourceKey === "dola-inverse:unattributed")).toMatchObject({
      unclassifiedResidual: true, residualReason: "insufficient-evidence",
    });
    expect(result.slices.find(row => row.sourceKey === "dola-inverse:unattributed")?.pct).toBe(33);
    expect(result.metadata?.unknownExposurePct).toBe(33);
    expect(result.metadata?.unclassifiedResidualDisposition).toBe("insufficient-evidence");
  });

  it.each([null, -1, Number.NaN, Number.POSITIVE_INFINITY, 41])(
    "keeps the whole unresolved tail unknown for an invalid or unreconciled debt balance (%s)",
    (balance) => {
      const result = adaptFirmMarkets({ markets: [makeMarket("wstETH", 60)], timestamp: 1000 }, 100, balance);
      expect(result.metadata?.frontierBadDebtUsd).toBeNull();
      expect(result.metadata?.unknownExposurePct).toBe(40);
      expect(result.slices.find(row => row.sourceKey === "dola-inverse:unattributed")?.pct).toBe(40);
      expect(result.slices.some(row => row.sourceKey === "dola-inverse:frontier-bad-debt")).toBe(false);
    },
  );

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
  it("converts provider USD circulation to face units before netting idle DOLA", async () => {
    const { result } = await runDola({
      markets: [{ ...makeMarket("wstETH", 1_000_000), dolaLiquidity: 400_000 }],
    }, dolaCacheDb(1_600_000, 0.8));
    expect(result.metadata).toMatchObject({
      supplyUsd: 1_600_000, dolaPriceUsd: 0.8,
      grossClaimsDola: 2_000_000, nettedOwnDola: 400_000,
      netClaimsDola: 1_600_000, unclassifiedResidualUsd: 500_000,
    });
  });

  it("withholds face-unit reconciliation when the cached price is unavailable", async () => {
    const { result } = await runDola({}, dolaCacheDb(1_500_000, null));
    expect(result.metadata?.grossClaimsDola).toBeNull();
    expect(result.metadata?.nettedOwnDola).toBe(0);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "dola-price-unavailable", effect: "degraded" }));
  });

  it("repairs the issuer's invalid-feed zero debt and omitted inventory using both contract reads", async () => {
    const address = "0xc0086ff652c67f43f00f0f9c69ef6c33640c8ccf";
    const balanceData = `0x70a08231${address.slice(2).padStart(64, "0")}`;
    const { result } = await runDola({
      markets: [{ ...makeMarket("yv-DOLA-USR", 0), address, hasNowInvalidFeed: true, dolaLiquidity: undefined }],
      marketRpc: {
        [`${address}:0xfc7b9c18`]: 88_012207824144463745n,
        [`${DOLA_ADDRESS}:${balanceData}`]: 919_458840034266274740n,
      },
    }, dolaCacheDb(1_500_000));
    expect(result.metadata).toMatchObject({ maskedFeedMarkets: 1, repairedFeedMarkets: 1, inventoryComplete: true });
    expect(result.metadata?.totalDebtDola).toBeCloseTo(88.01220782414447);
    expect(result.metadata?.nettedOwnDola).toBeCloseTo(919.4588400342663);
  });

  it("does not treat an unreadable masked feed as zero inventory", async () => {
    const address = "0xc0086ff652c67f43f00f0f9c69ef6c33640c8ccf";
    const balanceData = `0x70a08231${address.slice(2).padStart(64, "0")}`;
    const { result } = await runDola({
      markets: [{ ...makeMarket("yv-DOLA-USR", 0), address, hasNowInvalidFeed: true }],
      marketRpc: { [`${address}:0xfc7b9c18`]: null, [`${DOLA_ADDRESS}:${balanceData}`]: 0n },
    }, dolaCacheDb(1_500_000));
    expect(result.metadata).toMatchObject({ repairedFeedMarkets: 0, inventoryComplete: false, nettedOwnDola: 0 });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "dola-inventory-unreconciled", effect: "degraded" }));
  });

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
    expect(result.slices.find((slice) => slice.sourceKey === "dola-inverse:unattributed")?.pct).toBeCloseTo(26.7, 1);
    expect(result.slices.find((slice) => slice.sourceKey === "dola-inverse:frontier-bad-debt")?.pct).toBeCloseTo(6.7, 1);
    expectValidAdapterOutput("dola-inverse", result);
  });

  it.each([
    { status: 503, body: "" },
    { timestamp: 1_776_330_494, lastBlock: 23_000_000, badDebts: { DOLA: { frontierBadDebtBalance: 500_001 } } },
    { timestamp: 1_776_330_494 - DASHBOARD_SOURCE_MAX_AGE_SEC - 1, lastBlock: 23_000_000, badDebts: { DOLA: { frontierBadDebtBalance: 100_000 } } },
    { timestamp: 1_776_330_495, lastBlock: 23_000_000, badDebts: { DOLA: { frontierBadDebtBalance: 100_000 } } },
    { timestamp: 1_776_330_494, badDebts: { DOLA: { frontierBadDebtBalance: 100_000 } } },
  ])("fails closed to the whole unknown tail for an unusable repayments response %#", async (repayments) => {
    const { result } = await runDola({ repayments }, dolaCacheDb(1_500_000));
    expect(result.metadata?.frontierBadDebtUsd).toBeNull();
    expect(result.slices.some(row => row.sourceKey === "dola-inverse:frontier-bad-debt")).toBe(false);
    expect(result.metadata?.unknownExposurePct).toBeCloseTo(100 / 3);
    expect(result.slices.find(row => row.sourceKey === "dola-inverse:unattributed")?.pct).toBeCloseTo(33.3, 1);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "dola-frontier-bad-debt-unavailable" }));
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

  it("ignores zero-debt markets", () => {
    const result = listUnexpectedDolaAssets({
      markets: [makeMarket("MAGIC_TOKEN", 0)],
      timestamp: 1000,
    });
    expect(result).toEqual([]);
  });
});

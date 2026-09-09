/**
 * Adapter payload fixtures shared between an adapter's own test file and the
 * cross-adapter canonical direct-asset risk suite
 * (`canonical-direct-asset-risk.test.ts`), so both exercise the same recorded
 * input instead of drifting copies.
 *
 * Adapter imports are type-only: importers keep full control of their own
 * `vi.mock("../helpers")` wiring, and this module never evaluates an adapter.
 */
import type { adaptBtcfi } from "../btcfi";
import type { adaptCollateralPositions } from "../collateral-positions-api";
import type { UsdtbBackingAndSupplyPayload } from "../usdtb-transparency";

/**
 * Mento analytics API payload: reserve collateral percentages plus the CDP
 * trove rows for the four Mento CDP stablecoins (one closed trove included).
 */
export const MENTO_RESERVE_COMPOSITION_PAYLOAD = {
  collateral: {
    assets: [
      { symbol: "sUSDS", percentage: 50 },
      { symbol: "EURC", percentage: 10 },
      { symbol: "axlEUROC", percentage: 5 },
      { symbol: "CELO", percentage: 15 },
      { symbol: "USDGLO", percentage: 5 },
      { symbol: "stETH", percentage: 3 },
      { symbol: "USDT", percentage: 3 },
      { symbol: "USDT0", percentage: 1 },
      { symbol: "USDC", percentage: 2 },
      { symbol: "axlUSDC", percentage: 1 },
      { symbol: "AUSD", percentage: 4 },
      { symbol: "WETH", percentage: 1 },
    ],
  },
  cdp_troves: {
    troves: [
      {
        stablecoin: "GBPm",
        collateral_token: "USDm",
        collateral_usd: 173_427.5,
        debt_usd: 82_821.25,
        ratio: 2.09,
        status: "active",
      },
      {
        stablecoin: "GBPm",
        collateral_token: "USDm",
        collateral_usd: 40_000,
        debt_usd: 20_000,
        ratio: 2,
        status: "active",
      },
      {
        stablecoin: "JPYm",
        collateral_token: "USDm",
        collateral_usd: 171_960.48,
        debt_usd: 105_336.2,
        ratio: 1.63,
        status: "active",
      },
      {
        stablecoin: "CHFm",
        collateral_token: "USDm",
        collateral_usd: 143_361.85,
        debt_usd: 90_307.02,
        ratio: 1.59,
        status: "active",
      },
      {
        stablecoin: "XOFm",
        collateral_token: "USDm",
        collateral_usd: 25_000,
        debt_usd: 12_500,
        ratio: 2,
        status: "active",
      },
      {
        stablecoin: "GBPm",
        collateral_token: "USDm",
        collateral_usd: 1_000,
        debt_usd: 500,
        ratio: 2,
        status: "closed",
      },
    ],
  },
};

/** Captured 2026-07-09 from GET https://usdtb.money/api/transparency/backing-and-supply/current */
export const USDTB_BACKING_AND_SUPPLY_PAYLOAD: UsdtbBackingAndSupplyPayload = {
  assetsInMotion: 9115451.68,
  backingAssets: {
    BUIDL: [{ amount: 767603510.39, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
    "BUIDL-I": [{ amount: 0, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
    USDC: [{ amount: 0.000458, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
    USDT: [{ amount: 0, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
    USDtb: [{ amount: 0, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
  },
  lastUpdatedAt: "2026-07-09T16:08:11.000Z",
  supply: 775334449.6661826,
};

/** BTCFi market deposit rows keyed to the handler rows below (last row is the stable side). */
export const BTCFI_MARKET_ROWS: Parameters<typeof adaptBtcfi>[0] = [
  { token_handler_id: 0, deposit_value: "5000" },
  { token_handler_id: 1, deposit_value: "3000" },
  { token_handler_id: 2, deposit_value: "1000" },
  { token_handler_id: 3, deposit_value: "1000" },
];

export const BTCFI_HANDLER_ROWS: Parameters<typeof adaptBtcfi>[1] = [
  { id: 0, symbol: "WBTC", isStable: false },
  { id: 1, symbol: "BTCB", isStable: false },
  { id: 2, symbol: "CBBTC", isStable: false },
  { id: 3, symbol: "BtcUSD", isStable: true },
];

/**
 * Collateral-positions API shape: one open position per asset, with a
 * governance-token tail small enough to fold away under a nonzero minimum
 * slice percentage.
 */
export const COLLATERAL_POSITIONS_BY_ASSET: Parameters<typeof adaptCollateralPositions>[0] = {
  "0xbtc": {
    address: "0xBTC",
    name: "Wrapped BTC",
    symbol: "WBTC",
    decimals: 8,
    positions: [
      { collateralBalance: "500000000", closed: false, denied: false },
    ],
  },
  "0xeth": {
    address: "0xETH",
    name: "Wrapped Ether",
    symbol: "WETH",
    decimals: 18,
    positions: [
      { collateralBalance: "200000000000000000000", closed: false, denied: false },
    ],
  },
  "0xgno": {
    address: "0xGNO",
    name: "Gnosis",
    symbol: "GNO",
    decimals: 18,
    positions: [
      { collateralBalance: "1000000000000000000", closed: false, denied: false },
    ],
  },
};

export const COLLATERAL_POSITION_PRICES: Parameters<typeof adaptCollateralPositions>[1] = {
  "0xbtc": { price: { usd: 100000 } },
  "0xeth": { price: { usd: 2000 } },
  "0xgno": { price: { usd: 200 } },
};

/** Minimum slice percentage the recorded positions payload is aggregated with. */
export const COLLATERAL_POSITION_MIN_SLICE_PCT = 5;

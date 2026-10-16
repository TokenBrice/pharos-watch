import type {
  KavaBankSupplyPayload,
  KavaBlockPayload,
  KavaCdpParamsPayload,
  KavaCdpPrincipalPayload,
  KavaCdpTotalsPayload,
  KavaPricefeedPricesPayload,
} from "../kava-cdp";

const LCD_ORIGIN = "https://api.kava.io";
const TOTAL_COLLATERAL_URL = `${LCD_ORIGIN}/kava/cdp/v1beta1/totalCollateral`;

// Captured 2026-09-09 from the public Kava LCD (https://api.data.kava.io).
const TOTAL_COLLATERAL: KavaCdpTotalsPayload = {
  total_collateral: [
    { collateral_type: "bnb-a", amount: { denom: "bnb", amount: "249610005372" } },
    { collateral_type: "btcb-a", amount: { denom: "btcb", amount: "6256568578" } },
    { collateral_type: "busd-a", amount: { denom: "busd", amount: "86207769963709" } },
    { collateral_type: "busd-b", amount: { denom: "busd", amount: "10000000000" } },
    { collateral_type: "hard-a", amount: { denom: "hard", amount: "0" } },
    { collateral_type: "hbtc-a", amount: { denom: "hbtc", amount: "65000000000" } },
    { collateral_type: "swp-a", amount: { denom: "swp", amount: "0" } },
    { collateral_type: "ukava-a", amount: { denom: "ukava", amount: "40002642242977" } },
    { collateral_type: "usdt-a", amount: { denom: "erc20/tether/usdt", amount: "102797461579" } },
    { collateral_type: "xrpb-a", amount: { denom: "xrpb", amount: "172157183731604" } },
  ],
};

const TOTAL_PRINCIPAL: KavaCdpPrincipalPayload = {
  total_principal: [
    { collateral_type: "bnb-a", amount: { denom: "usdx", amount: "354264229965" } },
    { collateral_type: "btcb-a", amount: { denom: "usdx", amount: "1639014011659" } },
    { collateral_type: "busd-a", amount: { denom: "usdx", amount: "837987882801" } },
    { collateral_type: "busd-b", amount: { denom: "usdx", amount: "89533890" } },
    { collateral_type: "xrpb-a", amount: { denom: "usdx", amount: "744848610287" } },
    { collateral_type: "ukava-a", amount: { denom: "usdx", amount: "140555725875" } },
    { collateral_type: "hard-a", amount: { denom: "usdx", amount: "5804835" } },
    { collateral_type: "hbtc-a", amount: { denom: "usdx", amount: "3672104985666" } },
    { collateral_type: "swp-a", amount: { denom: "usdx", amount: "4889684" } },
    { collateral_type: "usdt-a", amount: { denom: "usdx", amount: "99397193555" } },
  ],
};

const CDP_PARAMS: KavaCdpParamsPayload = {
  params: {
    collateral_params: [
      { denom: "bnb", type: "bnb-a", spot_market_id: "bnb:usd", conversion_factor: "8", liquidation_ratio: "1.500000000000000000" },
      { denom: "btcb", type: "btcb-a", spot_market_id: "btc:usd", conversion_factor: "8", liquidation_ratio: "1.500000000000000000" },
      { denom: "busd", type: "busd-a", spot_market_id: "busd:usd", conversion_factor: "8", liquidation_ratio: "1.010000000000000000" },
      { denom: "busd", type: "busd-b", spot_market_id: "busd:usd", conversion_factor: "8", liquidation_ratio: "1.100000000000000000" },
      { denom: "xrpb", type: "xrpb-a", spot_market_id: "xrp:usd", conversion_factor: "8", liquidation_ratio: "1.500000000000000000" },
      { denom: "ukava", type: "ukava-a", spot_market_id: "kava:usd", conversion_factor: "6", liquidation_ratio: "1.500000000000000000" },
      { denom: "hard", type: "hard-a", spot_market_id: "hard:usd", conversion_factor: "6", liquidation_ratio: "1.500000000000000000" },
      { denom: "hbtc", type: "hbtc-a", spot_market_id: "btc:usd", conversion_factor: "8", liquidation_ratio: "1.500000000000000000" },
      { denom: "swp", type: "swp-a", spot_market_id: "swp:usd", conversion_factor: "6", liquidation_ratio: "1.500000000000000000" },
      { denom: "erc20/tether/usdt", type: "usdt-a", spot_market_id: "usdt:usd", conversion_factor: "6", liquidation_ratio: "1.010000000000000000" },
    ],
  },
};

const PRICEFEED_PRICES: KavaPricefeedPricesPayload = {
  prices: [
    { market_id: "bnb:usd", price: "741.384999999999977262" },
    { market_id: "btc:usd", price: "78662.295000000002910383" },
    { market_id: "busd:usd", price: "1.000000000000000000" },
    { market_id: "hard:usd", price: "0.001000000000000000" },
    { market_id: "kava:usd", price: "0.060665000000000001" },
    { market_id: "usdt:usd", price: "1.000000000000000000" },
    { market_id: "usdx:usd", price: "0.660000000000000000" },
    { market_id: "xrp:usd", price: "1.420849999999999976" },
  ],
};

const BANK_SUPPLY: KavaBankSupplyPayload = {
  amount: { denom: "usdx", amount: "10001377482335" },
};

const BLOCK_TIME_ISO = "2026-09-09T16:04:00.753265572Z";
const BLOCK_TIME_SEC = Math.floor(Date.parse(BLOCK_TIME_ISO) / 1000);

const LATEST_BLOCK: KavaBlockPayload = {
  block: { header: { chain_id: "kava_2222-10", height: "22494995", time: BLOCK_TIME_ISO } },
};
const KAVA_LCD_FIXTURES: Record<string, unknown> = {
  [TOTAL_COLLATERAL_URL]: TOTAL_COLLATERAL,
  [`${LCD_ORIGIN}/kava/cdp/v1beta1/totalPrincipal`]: TOTAL_PRINCIPAL,
  [`${LCD_ORIGIN}/kava/cdp/v1beta1/params`]: CDP_PARAMS,
  [`${LCD_ORIGIN}/kava/pricefeed/v1beta1/prices`]: PRICEFEED_PRICES,
  [`${LCD_ORIGIN}/cosmos/bank/v1beta1/supply/by_denom?denom=usdx`]: BANK_SUPPLY,
  [`${LCD_ORIGIN}/cosmos/base/tendermint/v1beta1/blocks/latest`]: LATEST_BLOCK,
};

function kavaNetwork(overrides: Record<string, unknown> = {}) {
  return { json: { ...KAVA_LCD_FIXTURES, ...overrides } };
}
export {
  BANK_SUPPLY,
  BLOCK_TIME_ISO,
  BLOCK_TIME_SEC,
  CDP_PARAMS,
  KAVA_LCD_FIXTURES,
  LATEST_BLOCK,
  PRICEFEED_PRICES,
  TOTAL_COLLATERAL,
  TOTAL_COLLATERAL_URL,
  TOTAL_PRINCIPAL,
  kavaNetwork,
};

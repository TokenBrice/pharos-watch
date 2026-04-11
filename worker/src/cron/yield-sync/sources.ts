export {
  fetchBeefySources,
  fetchBimaSusbdSource,
  fetchBprotocolLqtyOnlySource, fetchCurveScrvusdCurrentRateSource,
  fetchHashnoteUsycSource,
  fetchMorphoVaultSources,
  fetchOndoUsdyOracleSource,
  fetchPendleMarketSources,
  fetchYearnKongSources,
} from "./sources-optional-protocols";
export {
  fetchAaveV3SupplyRates,
  fetchCompoundV3SupplyRates,
  fetchOnChainRates,
  type AaveV3RateResult,
  type AaveV3RateTarget,
  type CompoundV3SupplyRateResult,
  type OnChainRateResult,
  type OptionalRpcFamilyTelemetry,
} from "./sources-rpc";
export { loadDlStablecoinPools } from "./sources-dl";
export {
  getPriceDerivedApy,
  loadRiskFreeRateRegistry,
  loadRiskFreeRateSnapshot,
} from "./sources-riskfree";

export const COMPOUND_V3_COMETS = [
  { stablecoinId: "usdc-circle", chain: "ethereum", comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", symbol: "USDC" },
  { stablecoinId: "usdt-tether", chain: "ethereum", comet: "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840", symbol: "USDT" },
  { stablecoinId: "usdc-circle", chain: "base", comet: "0xb125E6687d4313864e53df431d5425969c15Eb2F", symbol: "USDC" },
  { stablecoinId: "usdc-circle", chain: "arbitrum", comet: "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA", symbol: "USDC" },
] as const;

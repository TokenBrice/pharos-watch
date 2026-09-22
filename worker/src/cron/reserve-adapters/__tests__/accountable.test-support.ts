import captures from "./fixtures/accountable-captures.json";

export function makeTimestampedYuzuPayload(reserves: Record<string, unknown> = {}) {
  return {
    collateralization: 1,
    ts: "1787848065315",
    reserves: {
      total_reserves: 1_000,
      total_supply: 1_000,
      exposure_split_ts: "2026.08.24 07:31:16 UTC",
      exposure_split: { Liquidity_Buffer: { "": 1_000 } },
      timeline: [{ ts: "1787600794262", reserves: 1_000 }],
      ...reserves,
    },
  };
}

export const USN_DEPLOYMENT_CAPTURE = captures.usnDeployment;
export const APYX_2026_07_27_PAYLOAD = captures.apyx20260727;
export const YUZU_SIGNED_EXPOSURE_CAPTURE = captures.yuzuSignedExposure;
export const NEUTRL_TYPE_SPLIT_CAPTURE = captures.neutrlTypeSplit;
export const TORI_ASSET_BREAKDOWN_CAPTURE = captures.toriAssetBreakdown;

export const ACCOUNTABLE_MAPPING_CASES = [
  {
    name: "type breakdown", collateralization: 1.0595, ts: "1773304804848", bucket: "type",
    buckets: { "Liquid Bonds": 8_971_650.68, "Short Term Cash": 4_398_374.55 },
    params: { bucket: "type", riskMap: { "Liquid Bonds": "high", "Short Term Cash": "very-low" } },
    expected: [{ name: "Liquid Bonds", pct: 67.1, risk: "high" }, { name: "Short Term Cash", pct: 32.9, risk: "very-low" }],
  },
  {
    name: "reserves_split breakdown", collateralization: 1.00007, ts: "1773337492853", bucket: "reserves_split",
    buckets: [{ name: "Copper", value: 28_058_537.09 }, { name: "Fireblocks", value: 9_964_626 }, { name: "Insurance Fund", value: 656_796.7 }, { name: "Insurance Fund Usage", value: 20_000 }, { name: "Binance", value: 1_181.38 }, { name: "Ethereum Chain", value: 7.96 }],
    params: { bucket: "reserves_split", riskMap: { Copper: "medium", Fireblocks: "medium", "Insurance Fund": "low", "Insurance Fund Usage": "very-high", Binance: "high" } },
    expected: [{ name: "Copper", pct: 72.5, risk: "medium" }, { name: "Fireblocks", pct: 25.7, risk: "medium" }, { name: "Insurance Fund", pct: 1.7, risk: "low" }, { name: "Insurance Fund Usage", pct: 0.1, risk: "very-high" }],
  },
  {
    name: "deployment object buckets", collateralization: 1.013, ts: "1773337732067", bucket: "deployment",
    buckets: { "Private Credit (Fasanara FTAC)": 60, "DeFi Lending": 20, "CLOs (JAAA)": 15, "Funding Rate (BTC)": 5 },
    params: { bucket: "deployment", riskMap: { "Private Credit (Fasanara FTAC)": "high", "DeFi Lending": "medium", "CLOs (JAAA)": "high", "Funding Rate (BTC)": "high" } },
    expected: [{ name: "Private Credit (Fasanara FTAC)", pct: 60, risk: "high" }, { name: "DeFi Lending", pct: 20, risk: "medium" }, { name: "CLOs (JAAA)", pct: 15, risk: "high" }, { name: "Funding Rate (BTC)", pct: 5, risk: "high" }],
  },
  {
    name: "type_split buckets and renameMap", collateralization: 1.01, ts: "1773337561984", bucket: "type_split",
    buckets: { Stablecoin: 220, ETH: 10, "OTC Aggregate": 15, Other: 5 },
    params: { bucket: "type_split", riskMap: { Stablecoin: "low", ETH: "very-low", "OTC Aggregate": "high", Other: "high" }, renameMap: { Stablecoin: "Stablecoin reserves" } },
    expected: [{ name: "Stablecoin reserves", pct: 88, risk: "low" }, { name: "OTC Aggregate", pct: 6, risk: "high" }, { name: "ETH", pct: 4, risk: "very-low" }, { name: "Other", pct: 2, risk: "high" }],
  },
  {
    name: "single-pass renameMap", collateralization: 1, ts: "1773304804848", bucket: "type",
    buckets: { A: 60, B: 40 },
    params: { bucket: "type", riskMap: { A: "low", B: "high" }, renameMap: { A: "B", B: "C" } },
    expected: [{ name: "B", pct: 60, risk: "low" }, { name: "C", pct: 40, risk: "high" }],
  },
  {
    name: "nested exposure_split values", collateralization: 1.06, ts: "1773336724281", bucket: "exposure_split",
    buckets: { "[Ethena]_sUSDe_Loop": { "": 50 }, "[Maple]_syrupUSDT_Loop": { "": 30 }, "[Fluid]_fUSDT0": { "": 20 } },
    params: { bucket: "exposure_split", riskMap: { "[Ethena]_sUSDe_Loop": "high", "[Maple]_syrupUSDT_Loop": "high", "[Fluid]_fUSDT0": "low" }, renameMap: { "[Fluid]_fUSDT0": "Fluid fUSDT0" } },
    expected: [{ name: "[Ethena]_sUSDe_Loop", pct: 50, risk: "high" }, { name: "[Maple]_syrupUSDT_Loop", pct: 30, risk: "high" }, { name: "Fluid fUSDT0", pct: 20, risk: "low" }],
  },
  {
    name: "product-scoped protocol_split values", collateralization: 1.002, ts: "1778509189684", bucket: "protocol_split",
    buckets: { hoUSDT: { hoUSDT: 3_676_711.58 }, USDT0: { USDT0: 25_184.45 }, USDC: { Morpho: 586_637.21 }, masterUSD: { masterUSD: 2_001_257.2 } },
    params: { bucket: "protocol_split", riskMap: { hoUSDT: "high", USDT0: "low", USDC: "medium", masterUSD: "high" }, coinIdMap: { hoUSDT: "usdt-tether", USDT0: "usdt-tether", USDC: "usdc-circle" }, depTypeMap: { hoUSDT: "wrapper", USDT0: "wrapper", USDC: "collateral" }, renameMap: { hoUSDT: "hoUSDT strategy exposure", USDT0: "USDT0 reserves", USDC: "Morpho USDC lending exposure", masterUSD: "masterUSD strategy exposure" } },
    expected: [{ name: "hoUSDT strategy exposure", pct: 58.5, risk: "high", coinId: "usdt-tether", depType: "wrapper" }, { name: "masterUSD strategy exposure", pct: 31.8, risk: "high" }, { name: "Morpho USDC lending exposure", pct: 9.3, risk: "medium", coinId: "usdc-circle", depType: "collateral" }, { name: "USDT0 reserves", pct: 0.4, risk: "low", coinId: "usdt-tether", depType: "wrapper" }],
  },
] as const;
export const APYX_RESERVE_PARAMS = {
  bucket: "reserves_split",
  riskMap: { STRC: "high", "Cash & Equivalents": "very-low", "Protocol Owned Liquidity": "high", Inventory: "high", Other: "high" },
} as const;

export function makeApyxGuardPayload() {
  return {
    res: "ok",
    data: { collateralization: 1, ts: "1789502434250", reserves: {
      total_reserves: 100, total_supply: 100, inventory: 20, pol: 10,
      reserves_split: [{ name: "STRC", value: 70 }, { name: "Inventory", value: 20 }, { name: "Protocol Owned Liquidity", value: 10 }],
    } },
  };
}

import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { appendLinkedVariantParentYieldSources, appendPoolFamilyYieldSources, enforceExternalOpportunityTvlEligibility } from "../resolve-helpers";
import { resolveYieldTypeLabel } from "../evaluation-arbitration";
import { deriveYieldSourceRole } from "../decision-public";
import { matchAllDlPools } from "../../yield-helpers";
import { YIELD_POOL_MAP } from "../../../lib/yield-config/yield-config";
import type { DlPool, ResolvedYield, ResolvedYieldCandidate, ResolvedYieldEntry } from "../types";
import type { EvaluatedYieldSource } from "../evaluation-types";
import { buildHistoryKey, evaluateYieldSources } from "../evaluation";
import { baseEvaluationInput } from "../../__tests__/yield-evaluation.test-support";

function pool(overrides: Partial<DlPool> = {}): DlPool {
  return { pool: "test-pool", symbol: "USDC", chain: "Ethereum", project: "aave-v3", apy: 4, apyBase: 4, apyReward: null, tvlUsd: 2_000_000, stablecoin: true, exposure: "single", ...overrides } as DlPool;
}
function source(overrides: Partial<ResolvedYield> = {}): ResolvedYield {
  return { currentApy: 4, apyBase: 4, apyReward: null, sourcePool: "test-pool", sourceTvlUsd: 2_000_000, dataSource: "defillama", exchangeRate: null, sourceKey: "test-pool", chain: "Ethereum", ...overrides };
}
function resolve(dlPools: DlPool[], supplementalCandidates: ResolvedYieldCandidate[] = [], supplies = new Map<string, number>()): ResolvedYieldEntry[] {
  const resolved: ResolvedYieldEntry[] = [];
  appendPoolFamilyYieldSources({ resolved, dlPools, supplementalCandidates, safetyScores: new Map(), safetySnapshotAvailable: false, stablecoinSupplyById: supplies, stablecoinSupplyMapState: "ok" });
  return resolved;
}
function evaluated(entry: ResolvedYieldEntry): EvaluatedYieldSource {
  const startSec = Math.floor(Date.now() / 1000);
  return evaluateYieldSources(baseEvaluationInput({
    startSec,
    resolved: [{ ...entry, yield: { ...entry.yield!, sourceObservedAt: startSec } }],
    safetyScores: new Map([[entry.id, { score: 80, grade: "B+" }]]),
    stablecoinSupplyById: new Map([[entry.id, 1_000_000]]),
  })).evaluatedSources[0];
}

describe("yield identity and ownership boundaries", () => {
  it("does not attach Axis USDx to Hex Trust even with a matching ticker", () => {
    const candidates = ["0xa1fa7777974312f7d801a8880714a218f76233f8", "0xf8750b54d86be7ae9e32b4a0c826811198d63313"].map((address) => ({ symbol: "USDX", chain: "ethereum", address, yield: source({ sourceKey: address, dataSource: "protocol-api", yieldType: "fixed-yield" }) }));
    const resolved = resolve([], candidates);
    expect(resolved.map((entry) => [entry.id, entry.yield?.sourceKey])).toEqual([
      ["usdx-axis", candidates[0].address],
      ["usdx-hex-trust", candidates[1].address],
    ]);
  });

  it("assigns each addressed USDx pool to its issuer and rejects ambiguous Ethereum tickers", () => {
    const pools = [
      pool({ pool: "axis-usdx", symbol: "USDX", underlyingTokens: ["0xa1fa7777974312f7d801a8880714a218f76233f8"] }),
      pool({ pool: "hex-usdx", symbol: "USDX", underlyingTokens: ["0xf8750b54d86be7ae9e32b4a0c826811198d63313"] }),
      pool({ pool: "unknown-usdx", symbol: "USDX", underlyingTokens: ["0x0000000000000000000000000000000000000001"] }),
      pool({ pool: "ambiguous-usdx", symbol: "USDX", tvlUsd: 9_000_000 }),
    ];
    const resolved = resolve(pools);
    expect(resolved.map((entry) => [entry.id, entry.yield?.sourcePool]).sort()).toEqual([
      ["usdx-axis", "axis-usdx"],
      ["usdx-hex-trust", "hex-usdx"],
    ]);
  });

  it("types auto deposit rows before the final absent-supply gate", () => {
    const resolved = resolve([pool()]);
    expect(resolved.find((entry) => entry.id === "usdc-circle")?.yield?.yieldType).toBe("lending-opportunity");
    const count = resolved.length;
    expect(enforceExternalOpportunityTvlEligibility(resolved, new Map())["supply-unavailable"]).toBe(count);
    expect(resolved).toEqual([]);
  });

  it("uses the candidate chain floor during discovery, not the coin's first deployment", () => {
    const resolved = resolve([
      pool({ pool: "thin-ethereum", tvlUsd: 90_000 }),
      pool({ pool: "eligible-solana", chain: "Solana", tvlUsd: 60_000 }),
    ], [], new Map([["usdc-circle", 1_000_000]]));
    expect(resolved.find((entry) => entry.id === "usdc-circle")?.yield?.sourceKey).toBe("eligible-solana");
  });

  it("gates tracked opportunities but not native receipts and uses each candidate chain", () => {
    const resolved: ResolvedYieldEntry[] = [
      { id: "missing", symbol: "M", yield: source({ yieldType: resolveYieldTypeLabel({ id: "zchf-frankencoin", dataSource: "defillama" }) }) },
      { id: "native", symbol: "N", yield: source({ yieldType: "lending-vault" }) },
      { id: "deposit", symbol: "D", yield: source({ yieldType: "lending-opportunity", chain: "Ethereum", sourceTvlUsd: 60_000 }) },
      { id: "deposit", symbol: "D", yield: source({ yieldType: "lending-opportunity", chain: "Solana", sourceTvlUsd: 60_000 }) },
    ];
    expect(enforceExternalOpportunityTvlEligibility(resolved, new Map([["deposit", 1_000_000]]))).toEqual({ "supply-unavailable": 1, "tvl-null": 0, "tvl-thin": 1 });
    expect(resolved.map((entry) => [entry.id, entry.yield?.chain])).toEqual([["native", "Ethereum"], ["deposit", "Solana"]]);
  });

  it("keeps a symbol-only receipt pool external until holder ownership is curated", () => {
    const receipt = pool({ symbol: "GTUSDCP", project: "morpho-blue" });
    const entries = resolve([receipt]);
    const own = entries.find((entry) => entry.id === "gtusdcp-gauntlet")!;
    expect(own.yield?.yieldType).toBe("lending-opportunity");
    expect(own.yield?.yieldSource).toBe("Morpho Blue");
    expect(deriveYieldSourceRole(evaluated(own), { isSelected: true })).not.toBe("canonical-holder");
    expect(resolveYieldTypeLabel({ id: own.id, dataSource: "defillama", pool: receipt })).toBe("lending-vault");
    expect(resolveYieldTypeLabel({ id: own.id, dataSource: "defillama-auto", explicitType: "lending-vault", pool: receipt })).toBe("lending-vault");
    expect(resolveYieldTypeLabel({ id: "usdc-circle", dataSource: "defillama-auto", pool: receipt })).toBe("lending-opportunity");
    expect(resolveYieldTypeLabel({ id: own.id, dataSource: "defillama-auto", pool: { ...receipt, chain: "Solana" } })).toBe("lending-opportunity");
  });

  it("rejects a namesake receipt pool with contradictory supplied deposit addresses", () => {
    const entries = resolve([pool({ symbol: "GTUSDCP", project: "morpho-blue", underlyingTokens: ["0x0000000000000000000000000000000000000001"] })]);
    expect(entries.filter((entry) => entry.id === "gtusdcp-gauntlet")).toEqual([]);
  });

  it("requires a pin for ambiguous same-chain receipt pools", () => {
    const entries = resolve([pool({ pool: "one", symbol: "GTUSDCP", project: "morpho-blue" }), pool({ pool: "two", symbol: "GTUSDCP", project: "morpho-blue", tvlUsd: 9_000_000 })]);
    expect(entries.filter((entry) => entry.id === "gtusdcp-gauntlet")).toEqual([]);
  });

  it("prefers the steakUSDT pin to its larger unrelated namesake", () => {
    const correct = pool({ pool: YIELD_POOL_MAP["steakusdt-steakhouse"], symbol: "STEAKUSDT", project: "morpho-blue", tvlUsd: 75_000_000 });
    const other = pool({ pool: "ded5a855-23c1-459d-8390-ba2707fac7c5", symbol: "STEAKUSDT", project: "morpho-blue", tvlUsd: 86_000_000 });
    expect(matchAllDlPools("steakusdt-steakhouse", "steakUSDT", [other, correct], YIELD_POOL_MAP, {}).map((entry) => entry.pool)).toEqual([correct.pool]);
  });

  it("keeps sDOLA native and projects its yield to DOLA only as a deposit opportunity", () => {
    const own = pool({ pool: YIELD_POOL_MAP["sdola-inverse-finance"], symbol: "SDOLA", project: "inverse-finance-firm" });
    const collateralMarket = pool({ pool: "curve-market", symbol: "SDOLA", project: "curve-llamalend", apy: 0, underlyingTokens: ["0xb45ad160634c528cc3d2926d9807104fa3157305"] });
    expect(matchAllDlPools("sdola-inverse-finance", "sDOLA", [collateralMarket, own], YIELD_POOL_MAP, {}).map((entry) => entry.pool)).toEqual([own.pool]);
    const entries: ResolvedYieldEntry[] = [{ id: "sdola-inverse-finance", symbol: "sDOLA", yield: source({ sourceKey: own.pool, sourcePool: own.pool, yieldType: resolveYieldTypeLabel({ id: "sdola-inverse-finance", dataSource: "defillama" }) }) }];
    appendLinkedVariantParentYieldSources(entries);
    expect(deriveYieldSourceRole(evaluated(entries[0]), { isSelected: true })).toBe("canonical-holder");
    expect(entries.find((entry) => entry.id === "dola-inverse-finance")?.yield?.yieldType).toBe("lending-opportunity");
  });

  it("resolves Ethereum Frankencoin Savings as external and keeps Gnosis as an alternative", () => {
    expect(TRACKED_META_BY_ID.get("zchf-frankencoin")?.flags.yieldBearing).not.toBe(true);
    const entries = resolve([
      pool({ pool: "8b427366-7bfb-4c61-88be-8dc004fdc3da", symbol: "ZCHF", project: "frankencoin", apy: 3.5, tvlUsd: 14_100_000 }),
      pool({ pool: "75ff7280-15a9-4111-9b68-25254d741529", symbol: "ZCHF", chain: "Gnosis", project: "frankencoin", apy: 3.5, tvlUsd: 1_390_000 }),
    ], [], new Map([["zchf-frankencoin", 40_000_000]]));
    const id = "zchf-frankencoin";
    const incumbent = "75ff7280-15a9-4111-9b68-25254d741529";
    const startSec = Math.floor(Date.now() / 1000);
    const resolved = entries.filter((entry) => entry.id === id)
      .map((entry) => ({ ...entry, yield: { ...entry.yield!, sourceObservedAt: startSec } }));
    const result = evaluateYieldSources(baseEvaluationInput({
      startSec,
      resolved,
      safetyScores: new Map([[id, { score: 80, grade: "B+" }]]),
      stablecoinSupplyById: new Map([[id, 40_000_000]]),
      prevBestSourceKeyByCoin: new Map([[id, incumbent]]),
      sourceHistory: new Map(resolved.map((entry) => [
        buildHistoryKey(id, entry.yield.sourceKey),
        Array.from({ length: 30 }, (_, day) => ({
          stablecoin_id: id, source_key: entry.yield.sourceKey,
          recorded_at: startSec - (day + 1) * 86400,
          is_best: entry.yield.sourceKey === incumbent ? 1 : 0,
          apy: 3.5, source_tvl_usd: entry.yield.sourceTvlUsd,
          data_source: entry.yield.dataSource, yield_source: entry.yield.yieldSource ?? null,
          yield_type: entry.yield.yieldType ?? null,
        })),
      ])),
    }));
    const candidates = result.evaluatedSources;
    const winner = result.bestSourceKeyByCoin.get(id);
    expect(winner).toBe("8b427366-7bfb-4c61-88be-8dc004fdc3da");
    expect(candidates.find((entry) => entry.sourceKey === incumbent)).toMatchObject({ rejected: false });
    expect(candidates.find((entry) => entry.sourceKey === winner)?.yieldSource).toBe("Frankencoin Savings");
    expect(candidates.map((entry) => deriveYieldSourceRole(entry, { isSelected: entry.sourceKey === winner }))).toEqual(["external-opportunity", "external-opportunity"]);
  });

  it("fails closed for a missing native pin and a contradictory fallback underlying", () => {
    const generic = pool({ symbol: "NATIVE", underlyingTokens: ["0xwrong"] });
    expect(matchAllDlPools("native", "NATIVE", [generic], { native: "missing" }, {})).toEqual([]);
    expect(matchAllDlPools("native", "NATIVE", [generic], {}, {}, { contractAddresses: ["0xright"] })).toEqual([]);
    expect(matchAllDlPools("native", "NATIVE", [{ ...generic, underlyingTokens: null }], {}, {}, { contractAddresses: ["0xright"] }).map((entry) => entry.pool)).toEqual([generic.pool]);
  });

  it("does not promote the captured Royco APYUSD tranche into holder or linked parent yield", () => {
    const address = "0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a";
    const pools = [
      pool({ pool: "a87d5ef5-0b7b-4cd5-a3f8-0edb973844b8", symbol: "APYUSD", project: "morpho-blue", apy: 0, apyBase: 0, tvlUsd: 16_087_735, underlyingTokens: [address] }),
      pool({ pool: "2dfba4ef-85eb-4715-a5ba-075293f206bd", symbol: "APYUSD", project: "morpho-blue", apy: 0, apyBase: 0, tvlUsd: 7_231_894, underlyingTokens: [address] }),
      pool({ pool: "a061ebd7-b5db-57e9-9361-99504b710165", symbol: "SRROYAPYUSD", project: "royco-v2", apy: 19.71813, apyBase: 19.71813, tvlUsd: 3_003_715, underlyingTokens: [address] }),
    ];
    const matches = matchAllDlPools("apyusd-apyx", "apyUSD", pools, YIELD_POOL_MAP, {}, { contractAddresses: [address] });
    const entries: ResolvedYieldEntry[] = matches.map((match) => ({
      id: "apyusd-apyx", symbol: "apyUSD",
      yield: source({ sourceKey: match.pool, currentApy: match.apy, yieldType: "nav-appreciation" }),
    }));
    appendLinkedVariantParentYieldSources(entries);
    expect(matches).toEqual([]);
    expect(entries.filter((entry) => ["apyusd-apyx", "apxusd-apyx"].includes(entry.id))).toEqual([]);
    expect(matchAllDlPools("apyusd-apyx", "apyUSD", [pools[2]], YIELD_POOL_MAP, {}, { contractAddresses: [address] })).toEqual([]);
  });

  it("restores captured Strata and Ethereum USTB holder pools without loosening ambiguity", () => {
    const strata = pool({ pool: "843be062-d836-43ef-9670-c78d6ecb60bf", symbol: "SRUSDE", project: "strata-markets", apy: 4.06751, apyBase: 4.06751, tvlUsd: 18_597_898, underlyingTokens: ["0x4c9edd5852cd905f086c759e8383e09bff1e68b3"] });
    const ustb = pool({ pool: "1910847a-f8b5-40ce-a1ab-1dafdded5fbb", symbol: "USTB", project: "invesco-ustb", apy: 3.43211, apyBase: 3.43211, tvlUsd: 537_864_341, underlyingTokens: ["0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e"] });
    const pools = [strata, ustb,
      pool({ pool: "0f23649e-44fb-45be-b8b6-8ff28a0c0917", symbol: "USTB", apy: 0, apyBase: 0, tvlUsd: 26_349_744, underlyingTokens: ustb.underlyingTokens }),
      { ...ustb, pool: "8db7cb71-f2b7-45c7-bbff-f32c88ef7b81", chain: "Plume Mainnet", tvlUsd: 3_464_553, underlyingTokens: ["0xe4fa682f94610ccd170680cc3b045d77d9e528a8"] },
    ];
    for (const [id, expected] of [["srusde-strata", strata], ["ustb-superstate", ustb]] as const) {
      const meta = TRACKED_META_BY_ID.get(id)!;
      const matches = matchAllDlPools(id, meta.symbol, pools, YIELD_POOL_MAP, {}, { contractAddresses: meta.contracts?.map((contract) => contract.address) });
      expect(matches).toEqual([{ pool: expected.pool, apy: expected.apy, apyBase: expected.apyBase, apyReward: null, tvlUsd: expected.tvlUsd }]);
    }
  });

  it("does not quote Venus gross returns for HedgeCore holders after quarantine", () => {
    const venus = pool({ pool: "89eba1e5-1b1b-47b6-958b-38138a04c244", symbol: "USDC", chain: "BSC", project: "venus-core-pool", apy: 3.8333 });
    expect(matchAllDlPools("susd-hedgecore", "sUSD", [venus], YIELD_POOL_MAP, {}, { contractAddresses: ["0xbe1922750760c4cae69edb6fe79a22ae9b62a23d"] })).toEqual([]);
  });
});

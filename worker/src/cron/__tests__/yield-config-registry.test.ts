import { describe, expect, it } from "vitest";
import { FROZEN_IDS, PRE_LAUNCH_STABLECOINS, TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { isActiveStablecoinMeta, isPreLaunchStablecoinMeta } from "@shared/lib/stablecoins/status";
import { EXPLICIT_YIELD_SOURCE_POOL_MAP } from "../../lib/yield-config/yield-config-explicit-pools";
import {
  AUTO_LENDING_POOL_MAP,
  AUTO_LENDING_SAFETY_BYPASS_IDS,
  AUTO_LENDING_COLLISION_BLOCKLIST,
  isAutoLendingCollisionBlockedForStablecoin,
  LENDING_PROTOCOL_ALLOWLIST,
  LENDING_PROTOCOL_LABELS,
} from "../../lib/yield-config/yield-config-lending-protocols";
import { YIELD_OPPORTUNITY_EXCLUSIONS } from "../../lib/yield-config/yield-opportunity-exclusions";
import {
  ON_CHAIN_RATE_CONFIGS,
  PRICE_DERIVED_FALLBACK_IDS,
  RATE_DERIVED_CONFIGS,
} from "../../lib/yield-config/yield-config-rate-sources";
import { YIELD_ADAPTER_MANIFEST } from "../../lib/yield-config/yield-config";
import { YIELD_POOL_MAP } from "../../lib/yield-config/yield-config-pools";
import { YIELD_VARIANT_MAP } from "../../lib/yield-config/yield-config-variants";
import {
  DIRECT_PROTOCOL_API_STRATEGIES,
  INTENTIONAL_GAP_REASONS,
  YIELD_ADAPTER_LIFECYCLE,
} from "../../lib/yield-config/yield-config-rate-sources";
import { isPriceDerivedYieldEligible } from "../../lib/yield-config/yield-config-registry";
import { buildOnChainSourceKey } from "../../lib/yield-utils";

const onChainIds = new Set(ON_CHAIN_RATE_CONFIGS.map((config) => config.stablecoinId));
const autoLendingPoolsById: Readonly<Partial<Record<string, string>>> = AUTO_LENDING_POOL_MAP;
const rateDerivedIds = new Set(RATE_DERIVED_CONFIGS.map((config) => config.stablecoinId));
const intentionalGapIds = new Set(
  YIELD_ADAPTER_MANIFEST.filter((entry) => entry.status === "intentional-gap")
    .map((entry) => entry.stablecoinId),
);
const directProtocolApiIds = new Set(Object.keys(DIRECT_PROTOCOL_API_STRATEGIES));
const trackedCoinsById = new Map(TRACKED_STABLECOINS.map((coin) => [coin.id, coin] as const));

function hasRuntimeYieldStrategy(stablecoinId: string, navToken: boolean) {
    return (
    Boolean(YIELD_POOL_MAP[stablecoinId]) ||
    Boolean(YIELD_VARIANT_MAP[stablecoinId]) ||
    onChainIds.has(stablecoinId) ||
    ((navToken || PRICE_DERIVED_FALLBACK_IDS.has(stablecoinId))
      && isPriceDerivedYieldEligible(stablecoinId, INTENTIONAL_GAP_REASONS[stablecoinId])) ||
    rateDerivedIds.has(stablecoinId) ||
    Boolean(autoLendingPoolsById[stablecoinId]) ||
    directProtocolApiIds.has(stablecoinId) ||
    intentionalGapIds.has(stablecoinId)
  );
}

describe("yield config registry", () => {
  it("bounds opportunity exclusion re-reviews to fourteen days with owner and evidence", () => {
    for (const entry of YIELD_OPPORTUNITY_EXCLUSIONS) {
      const span = Date.parse(entry.nextReviewAt) - Date.parse(entry.reviewedAt);
      expect(span).toBeGreaterThan(0);
      expect(span).toBeLessThanOrEqual(14 * 86_400_000);
      expect(Date.parse(entry.since)).toBeLessThanOrEqual(Date.parse(entry.reviewedAt));
      expect(entry.owner).toBe("ops");
      expect(entry.reason).toContain("https://");
    }
  });

  const activeYieldCoins = TRACKED_STABLECOINS.filter(
    (coin) => coin.flags.yieldBearing && isActiveStablecoinMeta(coin),
  );

  it("gives every active yield-bearing coin a runtime strategy", () => {
    const uncovered = activeYieldCoins
      .filter((coin) => !hasRuntimeYieldStrategy(coin.id, coin.flags.navToken))
      .map((coin) => coin.id);

    expect(uncovered).toEqual([]);
  });

  it("requires yieldConfig metadata for every active yield-bearing coin", () => {
    const missing = activeYieldCoins
      .filter((coin) => !intentionalGapIds.has(coin.id))
      .filter((coin) => !coin.yieldConfig)
      .map((coin) => coin.id);

    expect(missing).toEqual([]);
  });

  it("does not expose stale PikuDAO USP native DeFiLlama pool coverage", () => {
    expect(YIELD_POOL_MAP["usp-pikudao"]).toBeUndefined();
    expect(YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === "usp-pikudao")?.strategies).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "native-pool",
          sourceKey: "2fb2f840-9be7-4de9-b29a-ea928205c476",
        }),
      ]),
    );
  });

  it("keeps deterministic on-chain configs unique and attached to tracked contracts or reviewed rate providers", () => {
    const ids = ON_CHAIN_RATE_CONFIGS.map((config) => config.stablecoinId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));

    for (const config of ON_CHAIN_RATE_CONFIGS) {
      const coin = TRACKED_STABLECOINS.find((entry) => entry.id === config.stablecoinId);
      expect(coin, config.stablecoinId).toBeDefined();
      if (!coin?.flags.yieldBearing) {
        const variant = YIELD_VARIANT_MAP[config.stablecoinId];
        expect(variant?.variantAddress?.toLowerCase(), config.stablecoinId).toBe(config.contract.toLowerCase());
        expect(variant?.variantChain, config.stablecoinId).toBe(config.chain);
      } else if (config.stablecoinId === "xgld-unitas") {
        // XGLD's reviewed provider is separate from the tracked token; its rate
        // measures XAUt per XGLD, and gold-denominated assets are not USD TVL.
        expect(config).toEqual({
          stablecoinId: "xgld-unitas",
          chain: "bsc",
          contract: "0x7bbe7fdcd6bdffd7f767a9531b6210b87b3e46e7",
          selector: "0x3ba0b9a9",
          decimals: 6,
          inputAmount: `0x${"0".repeat(64)}`,
        });
      } else {
        const contract = coin.contracts?.find(
          (entry) => entry.chain === config.chain
            && entry.address.toLowerCase() === config.contract.toLowerCase(),
        );
        expect(contract, `${config.stablecoinId}: canonical rate contract`).toBeDefined();
        if (contract && config.selector === "0x07a2d13a") {
          if (contract.decimals === null) {
            throw new Error(`${config.stablecoinId}: canonical rate contract requires known decimals`);
          }
          expect(BigInt(config.inputAmount), `${config.stablecoinId}: one whole vault share`)
            .toBe(10n ** BigInt(contract.decimals));
        }
        if (config.tvlRead) {
          expect(coin.flags.pegCurrency, `${config.stablecoinId}: totalAssets is USD TVL`).toBe("USD");
        }
      }
      expect((coin?.contracts ?? []).length, config.stablecoinId).toBeGreaterThan(0);
      expect(config.selector, config.stablecoinId).toMatch(/^0x[0-9a-fA-F]{8}$/);
      expect(BigInt(config.inputAmount), config.stablecoinId).toBeGreaterThanOrEqual(0n);
      expect(config.decimals, config.stablecoinId).toBeGreaterThan(0);
    }
  });

  it("keeps frozen coins out of every curated yield registry", () => {
    for (const id of FROZEN_IDS) {
      expect(YIELD_POOL_MAP[id], id).toBeUndefined();
      expect(YIELD_VARIANT_MAP[id], id).toBeUndefined();
      expect(ON_CHAIN_RATE_CONFIGS.some((entry) => entry.stablecoinId === id), id).toBe(false);
      expect(RATE_DERIVED_CONFIGS.some((entry) => entry.stablecoinId === id), id).toBe(false);
      expect(YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === id), id).toBeUndefined();
    }
  });

  it("projects every authored source into its yield-bearing manifest entry", () => {
    const assertStrategy = (stablecoinId: string, kind: string, sourceKey: string | null, label?: string) => {
      const entry = YIELD_ADAPTER_MANIFEST.find((row) => row.stablecoinId === stablecoinId);
      if (!entry) return;
      const matches = entry.strategies.filter((strategy) => strategy.kind === kind);
      expect(matches, stablecoinId).toHaveLength(1);
      expect(matches[0], stablecoinId).toMatchObject({ sourceKey, ...(label ? { label } : {}) });
    };
    for (const [id, pool] of Object.entries(YIELD_POOL_MAP)) assertStrategy(id, "native-pool", pool);
    for (const config of ON_CHAIN_RATE_CONFIGS) {
      assertStrategy(config.stablecoinId, "deterministic-onchain", buildOnChainSourceKey(config.stablecoinId));
    }
    for (const config of RATE_DERIVED_CONFIGS) assertStrategy(config.stablecoinId, "rate-derived", "rate-derived");
    for (const [id, config] of Object.entries(DIRECT_PROTOCOL_API_STRATEGIES)) {
      assertStrategy(id, "protocol-api", config.sourceKey, config.label);
    }
    for (const entry of YIELD_ADAPTER_MANIFEST) {
      const reason = INTENTIONAL_GAP_REASONS[entry.stablecoinId];
      expect(entry.status, entry.stablecoinId).toBe(reason ? "intentional-gap" : "covered");
      if (reason) {
        assertStrategy(entry.stablecoinId, "intentional-gap", null);
        expect(entry.strategies.find((strategy) => strategy.kind === "intentional-gap")?.rationale).toBe(reason);
      }
    }
  });

  it("labels every allowed lending protocol", () => {
    for (const protocol of LENDING_PROTOCOL_ALLOWLIST) expect(LENDING_PROTOCOL_LABELS[protocol], protocol).toBeTruthy();
  });

  it("keeps rate-derived configs unique", () => {
    const ids = RATE_DERIVED_CONFIGS.map((config) => config.stablecoinId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it("requires every safety-bypass id to have a deterministic lending override", () => {
    for (const stablecoinId of AUTO_LENDING_SAFETY_BYPASS_IDS) {
      expect(autoLendingPoolsById[stablecoinId], stablecoinId).toBeTruthy();
    }
  });

  it("exports a unified manifest entry for every yield-bearing stablecoin", () => {
    const manifestIds = new Set(YIELD_ADAPTER_MANIFEST.map((entry) => entry.stablecoinId));
    const yieldBearingIds = new Set(
      TRACKED_STABLECOINS
        .filter(
          (coin) => coin.flags.yieldBearing
            && (isActiveStablecoinMeta(coin) || isPreLaunchStablecoinMeta(coin)),
        )
        .map((coin) => coin.id),
    );

    expect(manifestIds).toEqual(yieldBearingIds);
    expect(YIELD_ADAPTER_MANIFEST.every((entry) => entry.strategies.length > 0)).toBe(true);
    const orderedIds = YIELD_ADAPTER_MANIFEST.map((entry) => entry.stablecoinId);
    expect(orderedIds).toEqual([...orderedIds].sort((a, b) => a.localeCompare(b)));
    for (const { strategies } of YIELD_ADAPTER_MANIFEST) {
      const priorities = strategies.map((strategy) => strategy.priority);
      expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    }
  });

  it("keeps pre-launch assets out of deterministic lending overrides", () => {
    for (const stablecoin of PRE_LAUNCH_STABLECOINS) {
      expect(autoLendingPoolsById[stablecoin.id], stablecoin.id).toBeUndefined();
      expect(AUTO_LENDING_SAFETY_BYPASS_IDS.has(stablecoin.id), stablecoin.id).toBe(false);
    }
  });

  it("keeps rejected gross holder-yield pins absent and the HedgeCore gap effective", () => {
    expect(YIELD_POOL_MAP["sbold-k3-capital"]).toBeUndefined();
    expect(EXPLICIT_YIELD_SOURCE_POOL_MAP["sbold-k3-capital"]).toBeUndefined();
    expect(YIELD_POOL_MAP["susd-hedgecore"]).toBeUndefined();
    expect(YIELD_ADAPTER_LIFECYCLE["susd-hedgecore"]?.lifecycle).toBe("intentional-gap");
    expect(isPriceDerivedYieldEligible("susd-hedgecore", INTENTIONAL_GAP_REASONS["susd-hedgecore"])).toBe(false);
  });

  it("records auto-lending same-symbol collision blocks", () => {
    expect(Object.keys(AUTO_LENDING_COLLISION_BLOCKLIST).sort()).toEqual([
      "cusd-celo",
      "dusd-alto",
      "nusd-nexus",
      "sdola-inverse-finance",
      "usda-alpha-partner",
      "usda-avalon",
      "usdcx-movement",
      "usdx-kava",
      "usx-dforce",
      "vusd-virtue",
      "xusd-straitsx",
    ]);

    expect(isAutoLendingCollisionBlockedForStablecoin("dusd-alto", {
      pool: "a5f9e3ff-9601-553d-a020-60870b3e3f19",
      project: "yearn-finance",
      chain: "Ethereum",
      symbol: "FRXUSDDUSD",
      underlyingTokens: ["0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29", "0x63d74d22E689C715a04F2C13962b1f77F443d35b"],
    })).toBe(true);
    expect(isAutoLendingCollisionBlockedForStablecoin("sdola-inverse-finance", {
      pool: "98fcaeb8-6e0a-4552-8f42-41d801a48528",
      project: "yearn-finance",
      chain: "Ethereum",
      symbol: "REUSDSDOLA",
      underlyingTokens: ["0x57aB1E0003F623289CD798B1824Be09a793e4Bec", "0xb45ad160634c528Cc3D2926d9807104FA3157305"],
    })).toBe(true);
    // The multi-asset pins are pool-scoped: another Yearn vault with the same
    // symbol stays eligible, and a candidate without a pool id cannot match.
    expect(isAutoLendingCollisionBlockedForStablecoin("dusd-alto", {
      pool: "00000000-1111-2222-3333-444444444444",
      project: "yearn-finance",
      chain: "Ethereum",
      symbol: "FRXUSDDUSD",
    })).toBe(false);
    expect(isAutoLendingCollisionBlockedForStablecoin("dusd-alto", {
      project: "yearn-finance",
      chain: "Ethereum",
      symbol: "FRXUSDDUSD",
    })).toBe(false);

    expect(isAutoLendingCollisionBlockedForStablecoin("usdx-kava", {
      project: "clearpool-lending",
      chain: "Flare",
      symbol: "USDX",
      underlyingTokens: ["0x4A771cC1a39fDd8AA08B8eA51F7FD412e73b3d2B"],
    })).toBe(true);
    expect(isAutoLendingCollisionBlockedForStablecoin("vusd-virtue", {
      project: "curvance",
      chain: "Monad",
      symbol: "VUSD",
      underlyingTokens: ["0x8d3F1518F8B516f6542E17f48e3f8589EcABc365"],
    })).toBe(true);
    expect(isAutoLendingCollisionBlockedForStablecoin("usdx-hex-trust", {
      project: "clearpool-lending",
      chain: "Flare",
      symbol: "USDX",
      underlyingTokens: ["0x4a771cc1a39fdd8aa08b8ea51f7fd412e73b3d2b"],
    })).toBe(false);
    expect(isAutoLendingCollisionBlockedForStablecoin("nusd-nexus", {
      project: "pendle",
      chain: "Ethereum",
      symbol: "NUSD",
      underlyingTokens: ["0xe556aba6fe6036275ec1f87eda296be72c811bce"],
    })).toBe(true);
  });

  it("distinguishes EFFR APY sources from EFFR PYS benchmark overrides", () => {
    const effrApyConfigs = RATE_DERIVED_CONFIGS.filter((entry) => entry.label.toUpperCase().includes("EFFR"));
    const effrOverrideOnlyConfigs = RATE_DERIVED_CONFIGS.filter(
      (entry) => entry.benchmarkOverrideKey === "USD_EFFR" && !entry.label.toUpperCase().includes("EFFR"),
    );

    for (const config of effrApyConfigs) {
      expect(config.benchmarkCurrency, config.stablecoinId).toBe("USD_EFFR");
      expect(config.benchmarkOverrideKey, config.stablecoinId).toBe("USD_EFFR");
    }

    expect(effrOverrideOnlyConfigs.length).toBeGreaterThan(0);
    for (const config of effrOverrideOnlyConfigs) {
      expect(config.benchmarkOverrideKey, config.stablecoinId).toBe("USD_EFFR");
      expect(config.benchmarkCurrency, config.stablecoinId).toBeUndefined();
    }
  });

  it("uses the return reference rather than benchmark availability for USD-price fallback eligibility", () => {
    expect(isPriceDerivedYieldEligible("xgld-unitas")).toBe(false);
    const gold = YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === "xgld-unitas");
    expect(gold?.strategies.some((entry) => entry.kind === "deterministic-onchain")).toBe(true);
    expect(gold?.strategies.some((entry) => entry.kind === "price-derived")).toBe(false);
    expect(PRICE_DERIVED_FALLBACK_IDS.has("xgld-unitas")).toBe(false);
    expect(PRICE_DERIVED_FALLBACK_IDS.has("usdb-blast")).toBe(true);
    expect(isPriceDerivedYieldEligible("usdb-blast", INTENTIONAL_GAP_REASONS["usdb-blast"])).toBe(false);
    // usdb-blast is frozen, so its fallback membership no longer yields a manifest entry.
    expect(YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === "usdb-blast")).toBeUndefined();
    for (const id of ["fpi-frax", "isc-international-stable-currency", "sdai-sky"]) {
      expect(isPriceDerivedYieldEligible(id), id).toBe(true);
      expect(YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === id)
        ?.strategies.some((entry) => entry.kind === "price-derived"), id).toBe(true);
    }
  });

  it("keeps intentional gaps attached to tracked coins", () => {
    for (const stablecoinId of Object.keys(INTENTIONAL_GAP_REASONS)) {
      expect(trackedCoinsById.has(stablecoinId), stablecoinId).toBe(true);
    }

  });

  it("keeps exact-pool overrides separate from the yield-bearing manifest", () => {
    const manifestIds = new Set(YIELD_ADAPTER_MANIFEST.map((entry) => entry.stablecoinId));
    const trackedById = new Map(TRACKED_STABLECOINS.map((coin) => [coin.id, coin]));
    const nonYieldBearingExplicitPoolIds = Object.keys(EXPLICIT_YIELD_SOURCE_POOL_MAP)
      .filter((stablecoinId) => !trackedById.get(stablecoinId)?.flags.yieldBearing);

    for (const stablecoinId of nonYieldBearingExplicitPoolIds) {
      expect(manifestIds.has(stablecoinId), stablecoinId).toBe(false);
    }
  });
});

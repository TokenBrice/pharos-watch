import { describe, expect, it } from "vitest";
import { PRE_LAUNCH_STABLECOINS, TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { isActiveStablecoinMeta, isPreLaunchStablecoinMeta } from "@shared/lib/stablecoins/status";
import {
  EXPLICIT_YIELD_SOURCE_POOL_MAP,
  AUTO_LENDING_POOL_MAP,
  AUTO_LENDING_SAFETY_BYPASS_IDS,
  AUTO_LENDING_COLLISION_BLOCKLIST,
  isAutoLendingCollisionBlockedForStablecoin,
  LENDING_PROTOCOL_ALLOWLIST,
  LENDING_PROTOCOL_LABELS,
  ON_CHAIN_RATE_CONFIGS,
  PRICE_DERIVED_FALLBACK_IDS,
  RATE_DERIVED_CONFIGS,
  YIELD_SOURCE_REGISTRY,
  YIELD_ADAPTER_MANIFEST,
  YIELD_POOL_MAP,
  YIELD_VARIANT_MAP,
} from "../../lib/yield-config/yield-config";
import {
  INTENTIONAL_GAP_REASONS,
  QUARANTINED_DETERMINISTIC_PROBE_CONFIGS,
  YIELD_ADAPTER_LIFECYCLE,
} from "../../lib/yield-config/yield-config-rate-sources";

const onChainIds = new Set(ON_CHAIN_RATE_CONFIGS.map((config) => config.stablecoinId));
const rateDerivedIds = new Set(RATE_DERIVED_CONFIGS.map((config) => config.stablecoinId));
const intentionalGapIds = new Set(
  YIELD_ADAPTER_MANIFEST.filter((entry) => entry.status === "intentional-gap")
    .map((entry) => entry.stablecoinId),
);
const directProtocolApiIds = new Set(
  YIELD_SOURCE_REGISTRY
    .filter((entry) => entry.directProtocolApiLabel)
    .map((entry) => entry.stablecoinId),
);
const trackedCoinsById = new Map(TRACKED_STABLECOINS.map((coin) => [coin.id, coin] as const));
const NON_YIELD_BEARING_ONCHAIN_IDS = new Set(["bold-liquity", "usdf-falcon"]);
const WAVE_1_DETERMINISTIC_PROMOTION_IDS = [
  "gtusdc-gauntlet",
  "susdc-spark",
  "susdt-spark",
  "syrupusdc-maple",
  "syrupusdt-maple",
  "yvusdc-yearn",
  "sgho-aave",
  "wsrusd-reservoir",
  "stcusd-cap",
  "savusd-avant",
  "yousd-yield-optimizer",
] as const;
const WAVE_1_RATE_DERIVED_IDS = [
  "fusd-finchain",
  "safo-spiko-usd",
  "spkcc-spiko",
] as const;
const ONE_E18_INPUT_AMOUNT = 10n ** 18n;

function hasRuntimeYieldStrategy(stablecoinId: string, navToken: boolean) {
    return (
    Boolean(YIELD_POOL_MAP[stablecoinId]) ||
    Boolean(YIELD_VARIANT_MAP[stablecoinId]) ||
    onChainIds.has(stablecoinId) ||
    navToken ||
    PRICE_DERIVED_FALLBACK_IDS.has(stablecoinId) ||
    rateDerivedIds.has(stablecoinId) ||
    Boolean(AUTO_LENDING_POOL_MAP[stablecoinId]) ||
    directProtocolApiIds.has(stablecoinId) ||
    intentionalGapIds.has(stablecoinId)
  );
}

describe("yield config registry", () => {
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

  it("keeps deterministic on-chain configs unique and attached to tracked contracts", () => {
    const ids = ON_CHAIN_RATE_CONFIGS.map((config) => config.stablecoinId);
    expect(new Set(ids).size).toBe(ids.length);

    for (const config of ON_CHAIN_RATE_CONFIGS) {
      const coin = TRACKED_STABLECOINS.find((entry) => entry.id === config.stablecoinId);
      expect(coin, config.stablecoinId).toBeDefined();
      if (!NON_YIELD_BEARING_ONCHAIN_IDS.has(config.stablecoinId)) {
        expect(coin?.flags.yieldBearing, config.stablecoinId).toBe(true);
      }
      expect((coin?.contracts ?? []).length, config.stablecoinId).toBeGreaterThan(0);
    }
  });

  it("wires A7A5 through the RUB key-rate derived source", () => {
    const config = RATE_DERIVED_CONFIGS.find((entry) => entry.stablecoinId === "a7a5-old-vector");
    expect(config).toMatchObject({
      spreadBps: 100,
      benchmarkCurrency: "RUB",
      benchmarkOverrideKey: "RUB",
    });
    expect(INTENTIONAL_GAP_REASONS["a7a5-old-vector"]).toBeUndefined();
    expect(YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === "a7a5-old-vector")).toMatchObject({
      status: "covered",
      strategies: expect.arrayContaining([
        expect.objectContaining({ kind: "rate-derived" }),
      ]),
    });
  });

  it("keeps base AZND non-yield-bearing while retaining the exact loAZND identity", () => {
    const coin = trackedCoinsById.get("aznd-mu-digital");
    const manifest = YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === "aznd-mu-digital");

    expect(coin?.flags).toMatchObject({ yieldBearing: false, navToken: false });
    expect(ON_CHAIN_RATE_CONFIGS.some((entry) => entry.stablecoinId === "aznd-mu-digital")).toBe(false);
    expect(YIELD_VARIANT_MAP["aznd-mu-digital"]).toMatchObject({
      variantSymbol: "loAZND",
      variantChain: "monad",
      variantAddress: "0x9c82eB49B51F7Dc61e22Ff347931CA32aDc6cd90",
    });
    expect(manifest).toBeUndefined();
  });

  it("promotes Wave 1 tracked vaults to deterministic on-chain readers", () => {
    const configsById = new Map(ON_CHAIN_RATE_CONFIGS.map((config) => [config.stablecoinId, config] as const));
    const unsupportedLocalTargets = WAVE_1_DETERMINISTIC_PROMOTION_IDS.filter((stablecoinId) => {
      const coin = trackedCoinsById.get(stablecoinId);
      return !coin
        || !isActiveStablecoinMeta(coin)
        || !coin.flags.yieldBearing
        || !coin.flags.navToken
        || !coin.yieldConfig
        || (coin.contracts ?? []).length === 0;
    });

    expect(unsupportedLocalTargets).toEqual([]);

    for (const stablecoinId of WAVE_1_DETERMINISTIC_PROMOTION_IDS) {
      const config = configsById.get(stablecoinId);
      expect(config, stablecoinId).toBeDefined();
      if (!config) continue;

      const coin = trackedCoinsById.get(stablecoinId);
      const hasMatchingContract = coin?.contracts?.some(
        (contract) =>
          contract.chain === config.chain &&
          contract.address.toLowerCase() === config.contract.toLowerCase(),
      );
      expect(hasMatchingContract, `${stablecoinId} ${config.chain} ${config.contract}`).toBe(true);
      expect(config.selector, stablecoinId).toMatch(/^0x[0-9a-fA-F]{8}$/);
      expect(BigInt(config.inputAmount), stablecoinId).toBeGreaterThan(0n);
      expect(config.decimals, stablecoinId).toBeGreaterThan(0);

      const manifestEntry = YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === stablecoinId);
      expect(manifestEntry?.status, stablecoinId).toBe("covered");
      expect(manifestEntry?.strategies, stablecoinId).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "deterministic-onchain",
            sourceKey: `onchain:${stablecoinId}`,
          }),
        ]),
      );
    }

    expect(configsById.get("gtusdc-gauntlet")).toMatchObject({
      decimals: 6,
      inputAmount: expect.any(String),
    });
    expect(BigInt(configsById.get("gtusdc-gauntlet")?.inputAmount ?? "0")).toBe(ONE_E18_INPUT_AMOUNT);
  });

  it("keeps rate-derived configs unique", () => {
    const ids = RATE_DERIVED_CONFIGS.map((config) => config.stablecoinId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("wires Wave 1 rate-derived coverage through active manifest entries", () => {
    const configsById = new Map(RATE_DERIVED_CONFIGS.map((config) => [config.stablecoinId, config] as const));

    for (const stablecoinId of WAVE_1_RATE_DERIVED_IDS) {
      const coin = trackedCoinsById.get(stablecoinId);
      expect(coin?.status ?? "active", stablecoinId).toBe("active");
      expect(coin?.flags.yieldBearing, stablecoinId).toBe(true);
      expect(configsById.has(stablecoinId), stablecoinId).toBe(true);
      expect(INTENTIONAL_GAP_REASONS[stablecoinId], stablecoinId).toBeUndefined();

      const manifestEntry = YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === stablecoinId);
      expect(manifestEntry?.status, stablecoinId).toBe("covered");
      expect(manifestEntry?.strategies, stablecoinId).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "rate-derived",
            sourceKey: "rate-derived",
          }),
        ]),
      );
    }

    for (const stablecoinId of ["safo-spiko-usd", "spkcc-spiko"] as const) {
      expect(configsById.get(stablecoinId), stablecoinId).toMatchObject({
        spreadBps: 0,
      });
      expect(configsById.get(stablecoinId)?.benchmarkCurrency ?? "USD", stablecoinId).toBe("USD");
    }
  });

  it("requires every safety-bypass id to have a deterministic lending override", () => {
    for (const stablecoinId of AUTO_LENDING_SAFETY_BYPASS_IDS) {
      expect(AUTO_LENDING_POOL_MAP[stablecoinId], stablecoinId).toBeTruthy();
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
  });

  it("marks intentional manifest gaps explicitly instead of leaving them implicit", () => {
    for (const stablecoinId of ["pusd-polaris"]) {
      expect(
        YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === stablecoinId),
      ).toMatchObject({
        status: "intentional-gap",
        strategies: [
          expect.objectContaining({
            kind: "intentional-gap",
          }),
        ],
      });
    }
  });

  it("wires the Base Dollar Stability Pool standalone source", () => {
    expect(YIELD_SOURCE_REGISTRY.find((entry) => entry.stablecoinId === "bd-basedollar")).toMatchObject({
      directProtocolApiLabel: "Base Dollar Stability Pools (interest-only)",
      directProtocolApiSourceKey: "onchain:bd-basedollar",
    });
    expect(
      YIELD_SOURCE_REGISTRY.find((entry) => entry.stablecoinId === "bd-basedollar")?.intentionalGapReason,
    ).toBeUndefined();
    expect(YIELD_ADAPTER_LIFECYCLE["bd-basedollar"]).toBeUndefined();
    // BD itself is not yield-bearing: the source concerns an opt-in Stability
    // Pool opportunity, so it belongs in the source registry rather than the
    // yield-bearing asset manifest.
    expect(YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === "bd-basedollar")).toBeUndefined();
  });

  it("keeps pre-launch assets out of deterministic lending overrides", () => {
    for (const stablecoin of PRE_LAUNCH_STABLECOINS) {
      expect(AUTO_LENDING_POOL_MAP[stablecoin.id], stablecoin.id).toBeUndefined();
      expect(AUTO_LENDING_SAFETY_BYPASS_IDS.has(stablecoin.id), stablecoin.id).toBe(false);
    }
  });

  it("documents the quarantined deterministic adapters in the manifest", () => {
    const quarantined = YIELD_ADAPTER_MANIFEST
      .filter((entry) => entry.deterministicQuarantineReason)
      .map((entry) => entry.stablecoinId)
      .sort();

    expect(quarantined).toEqual(["scrvusd-curve", "ustb-superstate"]);
  });

  it("keeps quarantined deterministic probe configs inactive until manually restored", () => {
    const probeIds = QUARANTINED_DETERMINISTIC_PROBE_CONFIGS.map((config) => config.stablecoinId);

    expect(probeIds).toEqual([]);
    expect(onChainIds.has("reusd-re-protocol")).toBe(false);
    expect(onChainIds.has("ustb-superstate")).toBe(false);
    expect(probeIds).not.toContain("ustb-superstate");
  });

  it("tracks current quarantine review windows in typed lifecycle metadata", () => {
    expect(YIELD_ADAPTER_LIFECYCLE["scrvusd-curve"]).toMatchObject({
      lifecycle: "quarantined",
      reason: expect.objectContaining({ nextReviewAt: "2026-10-09" }),
    });
    expect(YIELD_ADAPTER_LIFECYCLE["reusd-re-protocol"]).toBeUndefined();
    expect(YIELD_ADAPTER_LIFECYCLE["ustb-superstate"]).toMatchObject({
      lifecycle: "quarantined",
      reason: expect.objectContaining({ code: "token-not-erc4626", nextReviewAt: "2026-10-15" }),
    });
  });

  it("wires Re Protocol yield to reUSD itself and the official price API", () => {
    expect(YIELD_POOL_MAP["reusd-re-protocol"]).toBeUndefined();
    expect(YIELD_VARIANT_MAP["reusd-re-protocol"]).toBeUndefined();
    expect(
      YIELD_SOURCE_REGISTRY.find((entry) => entry.stablecoinId === "reusd-re-protocol"),
    ).toMatchObject({
      directProtocolApiLabel: "Re Protocol Basis-Plus (reUSD)",
      directProtocolApiSourceKey: "protocol-api:re-protocol-reusd",
    });
  });

  it("moves tracked savings-wrapper runtime ownership from the parent ids to the child ids", () => {
    for (const stablecoinId of [
      "usde-ethena",
      "usds-sky",
      "dai-makerdao",
      "frxusd-frax",
      "crvusd-curve",
      "avusd-avant",
      "gho-aave",
      "dola-inverse-finance",
    ]) {
      expect(YIELD_POOL_MAP[stablecoinId], stablecoinId).toBeUndefined();
      expect(YIELD_VARIANT_MAP[stablecoinId], stablecoinId).toBeUndefined();
    }

    expect(YIELD_POOL_MAP["susde-ethena"]).toBe("66985a81-9c51-46ca-9977-42b4fe7bc6df");
    expect(YIELD_POOL_MAP["usd3-3jane"]).toBe("f8cd444e-d99f-4132-b234-fd3482bf8806");
    expect(YIELD_POOL_MAP["susds-sky"]).toBe("d8c4eff5-c8a9-46fc-a888-057c4c668e72");
    expect(YIELD_POOL_MAP["sdai-sky"]).toBe("13392973-be6e-4b2f-bce9-4f7dd53d1c3a");
    expect(YIELD_POOL_MAP["sfrxusd-frax"]).toBe("42523cca-14b0-44f6-95fb-4781069520a5");
    expect(YIELD_POOL_MAP["scrvusd-curve"]).toBe("5fd328af-4203-471b-bd16-1705c726d926");
    expect(YIELD_POOL_MAP["savusd-avant"]).toBe("c74227a1-e738-4021-bbe1-13363815aecb");
  });

  it("includes high-TVL stablecoin lending protocols from 2026-03-25 audit", () => {
    const tierAProtocols = [
      "wildcat-protocol", "tectonic", "upshift", "venus-flux",
      "avantis", "cap", "resupply", "zerobase-cedefi",
    ];
    for (const slug of tierAProtocols) {
      expect(LENDING_PROTOCOL_ALLOWLIST.has(slug), slug).toBe(true);
      expect(LENDING_PROTOCOL_LABELS[slug], slug).toBeTruthy();
    }
  });

  it("pins current exact lending venues for newer coverage candidates", () => {
    expect(LENDING_PROTOCOL_ALLOWLIST.has("felix-cdp")).toBe(true);
    expect(LENDING_PROTOCOL_ALLOWLIST.has("sovryn-dex")).toBe(true);
    for (const protocol of [
      "autofinance",
      "neverland",
      "metrom",
      "mystic-finance-lending",
      "bitway",
      "frankencoin",
    ]) {
      expect(LENDING_PROTOCOL_ALLOWLIST.has(protocol), protocol).toBe(true);
      expect(LENDING_PROTOCOL_LABELS[protocol], protocol).toBeTruthy();
    }
    expect(AUTO_LENDING_POOL_MAP).toMatchObject({
      "feusd-felix": "2bae7cf8-d278-4b27-9959-7f5f92c6f14b",
      "dllr-sovryn": "436e4129-667b-44d6-8322-ea59ce9b587c",
      "tgbp-tokenised": "61a6a976-f70f-4f38-b4a4-a5d3fda6832c",
      "reusd-resupply": "02c7722b-dfd6-415b-8292-01dddb88c6fc",
      "xusd-babelfish": "59901fb6-d071-4923-822a-af871670a7fb",
      "usda-anzens": "fa66f3f5-24ba-4929-8549-9b811b68ef48",
      "usdx-hex-trust": "be50b874-8147-440d-b8ca-f2c202e9ed64",
    });
    expect(AUTO_LENDING_POOL_MAP["doc-money-on-chain"]).toBeUndefined();
    expect(AUTO_LENDING_POOL_MAP["pmusd-precious-metals"]).toBeUndefined();
  });

  it("allows Wave 2 category-gated thin-chain and app-chain lenders", () => {
    const wave2Protocols = {
      "aries-markets": "Aries Markets",
      "blend-pools-v2": "Blend",
      current: "Current",
      curvance: "Curvance",
      "scallop-lend": "Scallop",
      tydro: "Tydro",
      bifi: "BiFi",
      fraxlend: "Fraxlend v1",
    };

    for (const [protocol, label] of Object.entries(wave2Protocols)) {
      expect(LENDING_PROTOCOL_ALLOWLIST.has(protocol), protocol).toBe(true);
      expect(LENDING_PROTOCOL_LABELS[protocol], protocol).toBe(label);
    }
  });

  it("records auto-lending same-symbol collision blocks", () => {
    expect(Object.keys(AUTO_LENDING_COLLISION_BLOCKLIST).sort()).toEqual([
      "cusd-celo",
      "nusd-nexus",
      "usda-alpha-partner",
      "usda-avalon",
      "usdcx-movement",
      "usdx-kava",
      "usx-dforce",
      "vusd-virtue",
      "xusd-straitsx",
    ]);

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

  it("includes Aave v4 in lending discovery allowlist labels", () => {
    expect(LENDING_PROTOCOL_ALLOWLIST.has("aave-v4")).toBe(true);
    expect(LENDING_PROTOCOL_LABELS["aave-v4"]).toBe("Aave v4");
  });

  it("pins May 2026 native wrapper and rate-derived coverage without using invalid DL pools", () => {
    expect(YIELD_POOL_MAP).toMatchObject({
      "gtusdc-gauntlet": "a306885c-001e-4479-9ae8-459a56527bc1",
      "susdc-spark": "c5c74dd1-995c-4445-9d84-3e710bad7d52",
      "susdt-spark": "a5d67f7e-5b51-4a9d-969d-caf051a7f5a4",
      "sgho-aave": "ff2a68af-030c-4697-b0a1-b62a738eaef0",
      "ybold-yearn": "4c29f645-12db-461f-a1d7-16900d624271",
      "yvusdc-yearn": "7d89af7a-24c9-4292-aa38-7c71b05fbd6d",
    });

    // DefiLlama currently exposes AA_FalconXUSDC as a multi-exposure, zero-APY
    // tranche row, so it must not be pinned through the single-exposure DL pool lane.
    expect(YIELD_POOL_MAP["aa-falconx-mev-capital"]).toBeUndefined();

    for (const stablecoinId of [
      "cgusd-cygnus-finance",
      "usdn-noble",
      "benji-franklin-templeton",
      "wtgxx-wisdomtree",
      "ustbl-spiko",
      "eutbl-spiko",
      "witry-brix",
    ]) {
      expect(rateDerivedIds.has(stablecoinId), stablecoinId).toBe(true);
    }

    for (const stablecoinId of ["cgusd-cygnus-finance", "usdn-noble"]) {
      expect(intentionalGapIds.has(stablecoinId), stablecoinId).toBe(false);
      expect(YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === stablecoinId)).toMatchObject({
        status: "covered",
        strategies: [
          expect.objectContaining({
            kind: "rate-derived",
          }),
        ],
      });
    }
  });

  it("wires USDGO to an EFFR-linked rate-derived source", () => {
    const coin = trackedCoinsById.get("usdgo-osl");
    const config = RATE_DERIVED_CONFIGS.find((entry) => entry.stablecoinId === "usdgo-osl");

    expect(coin?.yieldConfig).toMatchObject({
      yieldSource: "USDGO EFFR-linked reserve yield",
      yieldType: "governance-set",
    });
    expect(config).toMatchObject({
      stablecoinId: "usdgo-osl",
      spreadBps: 38,
      benchmarkCurrency: "USD_EFFR",
      benchmarkOverrideKey: "USD_EFFR",
    });
    expect(intentionalGapIds.has("usdgo-osl")).toBe(false);
    expect(INTENTIONAL_GAP_REASONS["usdgo-osl"]).toBeUndefined();
  });

  it("distinguishes EFFR APY sources from EFFR PYS benchmark overrides", () => {
    const effrApyConfigs = RATE_DERIVED_CONFIGS.filter((entry) => entry.label.toUpperCase().includes("EFFR"));
    const effrOverrideOnlyConfigs = RATE_DERIVED_CONFIGS.filter(
      (entry) => entry.benchmarkOverrideKey === "USD_EFFR" && !entry.label.toUpperCase().includes("EFFR"),
    );

    expect(effrApyConfigs.length).toBeGreaterThan(0);
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

  it("wires TRY and tokenized-treasury benchmark overrides for rate-derived rows", () => {
    const configsById = new Map(RATE_DERIVED_CONFIGS.map((entry) => [entry.stablecoinId, entry] as const));

    expect(configsById.get("witry-brix")).toMatchObject({
      stablecoinId: "witry-brix",
      spreadBps: 0,
      benchmarkCurrency: "TRY",
    });

    for (const stablecoinId of [
      "buidl-blackrock",
      "cgusd-cygnus-finance",
      "ylds-figure",
      "mtbill-midas",
      "usdn-noble",
      "ousg-ondo-finance",
      "susd-solayer",
      "benji-franklin-templeton",
      "wtgxx-wisdomtree",
      "ustbl-spiko",
      "fusd-finchain",
      "usdgo-osl",
    ]) {
      expect(configsById.get(stablecoinId), stablecoinId).toMatchObject({
        benchmarkOverrideKey: "USD_EFFR",
      });
    }

    expect(configsById.get("eutbl-spiko")).toMatchObject({
      benchmarkCurrency: "EUR",
      benchmarkOverrideKey: "EUR",
    });
    expect(configsById.get("uktbl-spiko")).toMatchObject({
      benchmarkCurrency: "GBP",
      benchmarkOverrideKey: "GBP",
    });
  });

  it("wires mMEV to the Midas NAV oracle protocol source", () => {
    expect(directProtocolApiIds.has("mmev-midas")).toBe(true);
    expect(YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === "mmev-midas")).toMatchObject({
      status: "covered",
      strategies: expect.arrayContaining([
        expect.objectContaining({
          kind: "protocol-api",
          sourceKey: "protocol-api:midas-mmev-nav-oracle",
        }),
      ]),
    });
  });

  it("wires v8.16 coverage additions to runtime source keys", () => {
    // silk-shade-protocol left this pin list when it was quarantined on
    // 2026-08-18 (invalid upstream supply); the manifest only covers active coins.
    for (const stablecoinId of [
      "fpi-frax",
      "isc-international-stable-currency",
    ]) {
      const coin = TRACKED_STABLECOINS.find((entry) => entry.id === stablecoinId);
      expect(coin?.flags.yieldBearing, stablecoinId).toBe(true);
      expect(coin?.flags.navToken, stablecoinId).toBe(true);
      expect(intentionalGapIds.has(stablecoinId), stablecoinId).toBe(false);
      expect(YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === stablecoinId)).toMatchObject({
        status: "covered",
        strategies: [
          expect.objectContaining({
            kind: "price-derived",
            sourceKey: "price-derived",
          }),
        ],
      });
    }

    for (const stablecoinId of ["cgusd-cygnus-finance", "usdn-noble"]) {
      expect(rateDerivedIds.has(stablecoinId), stablecoinId).toBe(true);
      expect(intentionalGapIds.has(stablecoinId), stablecoinId).toBe(false);
      expect(YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === stablecoinId)).toMatchObject({
        status: "covered",
        strategies: [
          expect.objectContaining({
            kind: "rate-derived",
            sourceKey: "rate-derived",
          }),
        ],
      });
    }
  });

  it("does not keep unreachable STBT in the intentional gap inventory", () => {
    expect(trackedCoinsById.has("stbt-matrixdock")).toBe(false);
    expect(INTENTIONAL_GAP_REASONS["stbt-matrixdock"]).toBeUndefined();
    expect(
      YIELD_SOURCE_REGISTRY.some((entry) => entry.stablecoinId === "stbt-matrixdock"),
    ).toBe(false);
    expect(
      YIELD_ADAPTER_MANIFEST.some((entry) => entry.stablecoinId === "stbt-matrixdock"),
    ).toBe(false);
  });

  it("pins sBOLD's Liquity alt source to the explicit K3 wrapper label", () => {
    expect(EXPLICIT_YIELD_SOURCE_POOL_MAP["sbold-k3-capital"]).toContainEqual(
      expect.objectContaining({
        poolId: "dac71f4f-7b97-463a-b19f-9796c56c21f1",
        yieldSource: "Liquity Stability Pool (via K3 sBOLD)",
        yieldType: "lending-vault",
        dataSource: "defillama-auto",
        expectedProject: "liquity-v2",
        expectedChain: "ethereum",
      }),
    );
  });

  it("keeps exact-pool overrides separate from the yield-bearing manifest", () => {
    const manifestIds = new Set(YIELD_ADAPTER_MANIFEST.map((entry) => entry.stablecoinId));
    const trackedById = new Map(TRACKED_STABLECOINS.map((coin) => [coin.id, coin]));
    const nonYieldBearingExplicitPoolIds = Object.keys(EXPLICIT_YIELD_SOURCE_POOL_MAP)
      .filter((stablecoinId) => !trackedById.get(stablecoinId)?.flags.yieldBearing);

    expect(nonYieldBearingExplicitPoolIds).toContain("xaut-tether");
    for (const stablecoinId of nonYieldBearingExplicitPoolIds) {
      expect(manifestIds.has(stablecoinId), stablecoinId).toBe(false);
    }
  });

  it("wires Zephyr yield only to the ZYS share wrapper", () => {
    expect(
      YIELD_SOURCE_REGISTRY.find((entry) => entry.stablecoinId === "zys-zephyr-protocol"),
    ).toMatchObject({
      directProtocolApiLabel: "Zephyr Scanner ZYS returns",
    });

    expect(
      YIELD_SOURCE_REGISTRY.find((entry) => entry.stablecoinId === "zsd-zephyr-protocol")?.directProtocolApiLabel,
    ).toBeUndefined();
    expect(
      TRACKED_STABLECOINS.find((entry) => entry.id === "zsd-zephyr-protocol")?.flags.yieldBearing,
    ).not.toBe(true);
  });
});

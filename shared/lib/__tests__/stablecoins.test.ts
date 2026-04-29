import { describe, expect, it } from "vitest";
import deadStablecoinAsset from "../../data/dead-stablecoins.json";
import canonicalOrderAsset from "../../data/stablecoins/canonical-order.json";
import perCoinGeneratedAsset from "../../data/stablecoins/coins.generated.json";
import commodityAsset from "../../data/stablecoins/commodity.json";
import nonUsdAsset from "../../data/stablecoins/non-usd.json";
import preLaunchAsset from "../../data/stablecoins/pre-launch.json";
import usdMajorAsset from "../../data/stablecoins/usd-major.json";
import usdMinorAsset from "../../data/stablecoins/usd-minor.json";
import { hasReserveDisplayBadgeForAdapter } from "../live-reserve-display";
import { LiveReservesConfigSchema } from "../live-reserve-adapters";
import { LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS } from "../live-reserve-adapters-schemas";
import { CANONICAL_ETH_RESERVE_RISK } from "../reserve-asset-risk";
import {
  ACTIVE_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  TRACKED_META_BY_ID,
  TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins";
import { getVariants, isTrackedVariant } from "@shared/lib/stablecoins";
import {
  parseCanonicalOrderAsset,
  parseDeadStablecoinAssets,
  parseStablecoinMetaAssets,
} from "../stablecoins/schema";

function makeStablecoinAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "schema-test-usd",
    name: "Schema Test USD",
    symbol: "STUSD",
    flags: {
      backing: "rwa-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
    ...overrides,
  };
}

describe("tracked stablecoin metadata", () => {
  it("loads all JSON registry assets through the shared schemas", () => {
    const usdMajor = parseStablecoinMetaAssets(usdMajorAsset, "usd-major");
    const usdMinor = parseStablecoinMetaAssets(usdMinorAsset, "usd-minor");
    const nonUsd = parseStablecoinMetaAssets(nonUsdAsset, "non-usd");
    const commodity = parseStablecoinMetaAssets(commodityAsset, "commodity");
    const preLaunch = parseStablecoinMetaAssets(preLaunchAsset, "pre-launch");
    const perCoinGenerated = parseStablecoinMetaAssets(perCoinGeneratedAsset, "coins.generated");
    const canonicalOrder = parseCanonicalOrderAsset(canonicalOrderAsset, "canonical-order");

    expect(usdMajor).toHaveLength(0);
    expect(usdMinor).toHaveLength(0);
    expect(nonUsd).toHaveLength(0);
    expect(commodity).toHaveLength(0);
    expect(preLaunch).toHaveLength(0);
    expect(perCoinGenerated).toHaveLength(217);
    expect(canonicalOrder).toHaveLength(217);
    expect(
      usdMajor.length + usdMinor.length + nonUsd.length + commodity.length + preLaunch.length + perCoinGenerated.length,
    ).toBe(canonicalOrder.length);
    expect(parseDeadStablecoinAssets(deadStablecoinAsset, "dead-stablecoins")).toHaveLength(88);
  });

  it("keeps canonical order references limited to known tracked IDs", () => {
    const knownIds = new Set([
      ...parseStablecoinMetaAssets(perCoinGeneratedAsset, "coins.generated"),
    ].map((coin) => coin.id));

    expect(parseCanonicalOrderAsset(canonicalOrderAsset, "canonical-order").filter((id) => !knownIds.has(id))).toEqual([]);
  });

  it("keeps pre-launch metadata in per-coin assets", () => {
    const legacyShellCoins = [
      ...parseStablecoinMetaAssets(usdMajorAsset, "usd-major"),
      ...parseStablecoinMetaAssets(usdMinorAsset, "usd-minor"),
      ...parseStablecoinMetaAssets(nonUsdAsset, "non-usd"),
      ...parseStablecoinMetaAssets(commodityAsset, "commodity"),
      ...parseStablecoinMetaAssets(preLaunchAsset, "pre-launch"),
    ];
    const perCoinGenerated = parseStablecoinMetaAssets(perCoinGeneratedAsset, "coins.generated");
    const preLaunchCoins = perCoinGenerated.filter((coin) => coin.status === "pre-launch");

    expect(legacyShellCoins).toEqual([]);
    expect(preLaunchCoins).toHaveLength(11);
    expect(preLaunchCoins.every((coin) => coin.status === "pre-launch")).toBe(true);
  });

  it("keeps active and pre-launch partitions aligned after the JSON migration", () => {
    expect(TRACKED_STABLECOINS).toHaveLength(217);
    expect(ACTIVE_STABLECOINS).toHaveLength(205);
    expect(PRE_LAUNCH_STABLECOINS.map((coin) => coin.id)).toEqual([
      "usdpt-western-union",
      "roughrider-bnd",
      "fiusd-fiserv",
      "eur-qivalis",
      "pusd-polaris",
      "pgold-polaris",
      "usg-tangent",
      "klarnausd-klarna",
      "bd-basedollar",
      "trusd-tori",
      "rgbp-revolut",
    ]);
  });

  it("keeps the active registry free of standalone algorithmic backing classifications", () => {
    const algorithmicIds = ACTIVE_STABLECOINS
      .filter((coin) => coin.flags.backing === "algorithmic")
      .map((coin) => coin.id);

    expect(algorithmicIds).toEqual([]);
  });

  it("tracks the fifteen current implementation-scope variants", () => {
    const variantIds = ACTIVE_STABLECOINS
      .filter((coin) => isTrackedVariant(coin.id))
      .map((coin) => coin.id);

    expect(variantIds).toEqual([
      "susde-ethena",
      "susds-sky",
      "stusds-sky",
      "sdai-sky",
      "susdai-usd-ai",
      "busd0-usual",
      "stkgho-umbrella-aave",
      "stcusd-cap",
      "scrvusd-curve",
      "sfrxusd-frax",
      "cusdo-openeden",
      "syusd-aegis",
      "sbold-k3-capital",
      "msy-main-street",
      "said-gaib",
    ]);
  });

  it("keeps tracked variant parents active and canonical", () => {
    for (const coin of ACTIVE_STABLECOINS.filter((entry) => entry.variantOf != null)) {
      const parent = TRACKED_META_BY_ID.get(coin.variantOf!);
      expect(parent, coin.id).toBeDefined();
      expect(parent?.status, coin.id).not.toBe("pre-launch");
      expect(coin.pegReferenceId, coin.id).toBe(coin.variantOf);
    }
  });

  it("keeps only USDS with two tracked child variants", () => {
    expect(getVariants("usds-sky").map((coin) => coin.id)).toEqual(["susds-sky", "stusds-sky"]);
  });

  it("rejects malformed stablecoin assets with readable schema errors", () => {
    expect(() => parseStablecoinMetaAssets([{
      id: "broken-coin",
      name: "Broken Coin",
      symbol: "BROKE",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: false,
      },
    }], "broken.json")).toThrowError(/broken\.json/);
  });

  it("enforces contract decimals as finite integers from 0 through 255", () => {
    expect(parseStablecoinMetaAssets([
      makeStablecoinAsset({
        contracts: [{ chain: "ethereum", address: "0x0", decimals: 0 }],
      }),
    ], "decimals-zero.json")[0]?.contracts?.[0]?.decimals).toBe(0);

    for (const decimals of [-1, 1.5, 256, Infinity]) {
      expect(() => parseStablecoinMetaAssets([
        makeStablecoinAsset({
          contracts: [{ chain: "ethereum", address: "0x0", decimals }],
        }),
      ], `decimals-${decimals}.json`)).toThrowError(/decimals/);
    }
  });

  it("enforces dependency weights as finite positive fractions", () => {
    for (const weight of [0, -0.1, 1.01, Infinity]) {
      expect(() => parseStablecoinMetaAssets([
        makeStablecoinAsset({
          dependencies: [{ id: "usdc-circle", weight }],
        }),
      ], `dependency-${weight}.json`)).toThrowError(/weight/);
    }
  });

  it("enforces reserve percentages as finite positive percentages", () => {
    for (const pct of [0, -1, 100.1, Infinity]) {
      expect(() => parseStablecoinMetaAssets([
        makeStablecoinAsset({
          reserves: [{ name: "Cash", pct, risk: "low" }],
        }),
      ], `reserve-${pct}.json`)).toThrowError(/pct/);
    }
  });

  it("enforces commodity ounces as finite positive values", () => {
    for (const commodityOunces of [0, -1, Infinity]) {
      expect(() => parseStablecoinMetaAssets([
        makeStablecoinAsset({ commodityOunces }),
      ], `commodity-${commodityOunces}.json`)).toThrowError(/commodityOunces/);
    }
  });

  it("rejects malformed dead stablecoin assets with readable schema errors", () => {
    expect(() => parseDeadStablecoinAssets([{
      id: "broken-dead-coin",
      name: "Broken Dead Coin",
      symbol: "DEAD",
      pegCurrency: "USD",
      causeOfDeath: "algorithmic-failure",
      deathDate: "2025-01-01",
      sourceUrl: "https://example.com",
    }], "dead-broken.json")).toThrowError(/dead-broken\.json/);
  });

  it("rejects malformed dead stablecoin ids", () => {
    expect(() => parseDeadStablecoinAssets([{
      id: "Broken Dead Coin",
      name: "Broken Dead Coin",
      symbol: "DEAD",
      pegCurrency: "USD",
      causeOfDeath: "algorithmic-failure",
      deathDate: "2025-01-01",
      obituary: "Broken",
      sourceUrl: "https://example.com",
      sourceLabel: "Example",
    }], "dead-id-broken.json")).toThrowError(/id/);
  });

  it("does not attach a CoinGecko slug to M by M0 when the base token is not contract-resolved on CoinGecko", () => {
    const coin = TRACKED_META_BY_ID.get("m-m0");

    expect(coin).toBeDefined();
    expect(coin?.geckoId).toBeUndefined();
    expect(coin?.contracts?.some(
      (contract) => contract.chain === "ethereum" && contract.address.toLowerCase() === "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b",
    )).toBe(true);
  });

  it("classifies BOLD yield as a native wrapper over the Liquity Stability Pool", () => {
    const coin = TRACKED_META_BY_ID.get("bold-liquity");

    expect(coin).toBeDefined();
    expect(coin?.yieldConfig).toMatchObject({
      yieldSource: "Liquity Stability Pool (via Yearn yBOLD)",
      yieldType: "lending-vault",
    });
  });

  it("keeps base USDAI on the curated PYUSD reserve path while sUSDai owns the mixed protocol feed", () => {
    const usdai = TRACKED_META_BY_ID.get("usdai-usd-ai");
    const susdai = TRACKED_META_BY_ID.get("susdai-usd-ai");

    expect(usdai?.reserves).toEqual([
      {
        name: "PYUSD (PayPal USD)",
        pct: 100,
        risk: "low",
        coinId: "pyusd-paypal",
      },
    ]);
    expect(usdai?.liveReservesConfig).toMatchObject({
      adapter: "curated-validated",
      semantics: "single-asset",
      breakerScope: "usdai-usd-ai",
      display: {
        url: "https://usd.ai/usdai",
        label: "USD.AI USDai",
      },
      inputs: {
        primary: {
          kind: "onchain-evm",
          chain: "arbitrum",
          rpcMode: "public-rpc",
        },
      },
    });

    expect(susdai?.liveReservesConfig).toMatchObject({
      adapter: "usdai-proof-of-reserves",
      breakerScope: "susdai-usd-ai",
      display: {
        url: "https://app.usd.ai/reserves",
        label: "USD.AI Reserves",
      },
      inputs: {
        primary: {
          kind: "http-json",
          url: "https://api.usd.ai/usdai/dashboard/proof-of-reserves?chainId=42161",
        },
      },
    });
    expect(susdai?.pegReferenceId).toBe("usdai-usd-ai");
  });

  it("uses explicit breaker scopes when a live-reserve adapter is reused across multiple coins", () => {
    const liveCoins = TRACKED_STABLECOINS.filter((coin) => coin.liveReservesConfig);
    const adapterUsage = new Map<string, string[]>();

    for (const coin of liveCoins) {
      const adapter = coin.liveReservesConfig!.adapter;
      const existing = adapterUsage.get(adapter);
      if (existing) {
        existing.push(coin.id);
      } else {
        adapterUsage.set(adapter, [coin.id]);
      }
    }

    const reusedAdapters = new Set(
      Array.from(adapterUsage.entries())
        .filter(([, ids]) => ids.length > 1)
        .map(([adapter]) => adapter),
    );

    const missingScopes = liveCoins
      .filter((coin) => reusedAdapters.has(coin.liveReservesConfig!.adapter))
      .filter((coin) => !coin.liveReservesConfig!.breakerScope)
      .map((coin) => `${coin.id}:${coin.liveReservesConfig!.adapter}`);

    expect(missingScopes).toEqual([]);
  });

  it("keeps curated-validated live reserve configs aligned with an onchain tracked contract", () => {
    const issues = TRACKED_STABLECOINS
      .filter((coin) => coin.liveReservesConfig?.adapter === "curated-validated")
      .flatMap((coin) => {
        const config = coin.liveReservesConfig!;
        const primary = config.inputs.primary;
        if (primary.kind !== "onchain-evm" && primary.kind !== "onchain-solana") {
          return [`${coin.id}:primary:${primary.kind}`];
        }

        const expectedChain = primary.kind === "onchain-solana"
          ? "solana"
          : primary.chain;
        const hasMatchingContract = coin.contracts?.some(
          (contract) => contract.chain === expectedChain
            && (
              primary.kind === "onchain-solana"
                ? contract.address.length > 0
                : contract.address.startsWith("0x")
            ),
        ) ?? false;
        const contractKey = expectedChain;
        return hasMatchingContract ? [] : [`${coin.id}:contract:${contractKey}`];
      });

    expect(issues).toEqual([]);
  });

  it("does not let one breaker scope cover multiple distinct live-reserve source configs", () => {
    const liveCoins = TRACKED_STABLECOINS.filter((coin) => coin.liveReservesConfig);
    const scopeSourceGroups = new Map<string, Set<string>>();

    for (const coin of liveCoins) {
      const config = coin.liveReservesConfig!;
      const scope = config.breakerScope ?? config.adapter;
      const sourceIdentity = JSON.stringify({
        adapter: config.adapter,
        version: config.version,
        semantics: config.semantics,
        inputs: config.inputs,
        params: config.params ?? null,
      });
      const existing = scopeSourceGroups.get(scope);
      if (existing) {
        existing.add(sourceIdentity);
      } else {
        scopeSourceGroups.set(scope, new Set([sourceIdentity]));
      }
    }

    const overlappingScopes = Array.from(scopeSourceGroups.entries())
      .filter(([, sourceIds]) => sourceIds.size > 1)
      .map(([scope]) => scope);

    expect(overlappingScopes).toEqual([]);
  });

  it("keeps configured live reserve inputs compatible with adapter input-kind constraints", () => {
    const issues = TRACKED_STABLECOINS
      .filter((coin) => coin.liveReservesConfig)
      .flatMap((coin) => {
        const config = coin.liveReservesConfig!;
        const parsed = LiveReservesConfigSchema.safeParse(config);
        const allowedKinds = LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS[config.adapter] as readonly string[];
        const invalidKinds = [
          config.inputs.primary.kind,
          ...(config.inputs.fallbacks ?? []).map((fallback) => fallback.kind),
        ].filter((kind) => !allowedKinds.includes(kind));

        return [
          ...(parsed.success ? [] : [`${coin.id}:schema:${parsed.error.issues[0]?.message ?? "invalid"}`]),
          ...invalidKinds.map((kind) => `${coin.id}:${config.adapter}:${kind}`),
        ];
      });

    expect(issues).toEqual([]);
  });

  it("gives business-day NAV oracles enough freshness headroom for weekends", () => {
    const maxAgeSec = 4 * 24 * 60 * 60;
    const businessDayNavIds = [
      "ousg-ondo-finance",
      "mtbill-midas",
    ];

    const underConfigured = businessDayNavIds.flatMap((id) => {
      const params = TRACKED_META_BY_ID.get(id)?.liveReservesConfig?.params;
      const maxOracleAgeSec = typeof params === "object" && params !== null && !Array.isArray(params)
        ? (params as { maxOracleAgeSec?: unknown }).maxOracleAgeSec
        : undefined;

      return typeof maxOracleAgeSec === "number" && maxOracleAgeSec >= maxAgeSec
        ? []
        : [`${id}:${maxOracleAgeSec ?? "missing"}`];
    });

    expect(underConfigured).toEqual([]);
  });

  it("assigns a reserve display badge to every configured live-reserve adapter", () => {
    const missingBadgeAdapters = TRACKED_STABLECOINS
      .filter((coin) => coin.liveReservesConfig)
      .map((coin) => coin.liveReservesConfig!.adapter)
      .filter((adapter, index, adapters) => adapters.indexOf(adapter) === index)
      .filter((adapter) => !hasReserveDisplayBadgeForAdapter(adapter));

    expect(missingBadgeAdapters).toEqual([]);
  });

  it("keeps direct ETH and WETH reserve mappings aligned with the canonical ETH risk tier", () => {
    const mismatches: string[] = [];

    for (const coin of TRACKED_STABLECOINS) {
      for (const slice of coin.reserves ?? []) {
        if (slice.name !== "ETH" && slice.name !== "WETH" && slice.name !== "WETH (wrapped Ether)") continue;
        if (slice.risk !== CANONICAL_ETH_RESERVE_RISK) {
          mismatches.push(`${coin.id}:reserve:${slice.name}:${slice.risk}`);
        }
      }

      const config = coin.liveReservesConfig;
      const params = config?.params;
      if (!params || typeof params !== "object" || Array.isArray(params)) continue;

      const maybeBranches = (params as { branches?: Array<{ name?: string; risk?: string }> }).branches;
      if (Array.isArray(maybeBranches)) {
        for (const branch of maybeBranches) {
          if (branch?.name !== "WETH") continue;
          if (branch.risk !== CANONICAL_ETH_RESERVE_RISK) {
            mismatches.push(`${coin.id}:branch:${branch.name}:${branch.risk ?? "missing"}`);
          }
        }
      }

      const maybeLabel = (params as { label?: string; risk?: string }).label;
      if (maybeLabel === "ETH" && (params as { risk?: string }).risk !== CANONICAL_ETH_RESERVE_RISK) {
        mismatches.push(`${coin.id}:single-asset:ETH:${(params as { risk?: string }).risk ?? "missing"}`);
      }

      const riskMap = (params as { riskMap?: Record<string, string> }).riskMap;
      if (riskMap?.ETH && riskMap.ETH !== CANONICAL_ETH_RESERVE_RISK) {
        mismatches.push(`${coin.id}:risk-map:ETH:${riskMap.ETH}`);
      }
    }

    expect(mismatches).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { DETAIL_PROVIDER_VALUES } from "../../types/core";
import deadStablecoinAsset from "../../data/dead-stablecoins.json";
import canonicalOrderAsset from "../../data/stablecoins/canonical-order.json";
import perCoinGeneratedAsset from "../../data/stablecoins/coins.generated.json";
import commodityAsset from "../../data/stablecoins/commodity.json";
import nonUsdAsset from "../../data/stablecoins/non-usd.json";
import preLaunchAsset from "../../data/stablecoins/pre-launch.json";
import usdMajorAsset from "../../data/stablecoins/usd-major.json";
import usdMinorAsset from "../../data/stablecoins/usd-minor.json";
import { DEAD_STABLECOINS } from "../dead-stablecoins";
import { hasReserveDisplayBadgeForAdapter } from "../live-reserve-display";
import { LiveReservesConfigSchema } from "../live-reserve-adapters";
import { LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS } from "../live-reserve-adapters-schemas";
import { CANONICAL_ETH_RESERVE_RISK } from "../reserve-asset-risk";
import {
  ACTIVE_META_BY_ID,
  ACTIVE_STABLECOINS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  TRACKED_META_BY_ID,
  TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/registry";
import { createVariantRelationshipHelpers } from "../stablecoins/variant-relationships";
import { isActiveStablecoinMeta } from "../stablecoins/status";
import type { StablecoinMeta, VariantKind } from "../../types";
import {
  findStablecoinCatalogInvariantIssues,
  parseCanonicalOrderAsset,
  parseDeadStablecoinAssets,
  parseStablecoinMetaAssets,
} from "../stablecoins/schema";

function hasTrackedVariantMeta(
  meta: StablecoinMeta | undefined,
): meta is StablecoinMeta & { variantOf: string; variantKind: VariantKind } {
  return meta?.variantOf != null && meta.variantKind != null && isActiveStablecoinMeta(meta);
}

const { getVariants, isTrackedVariant } = createVariantRelationshipHelpers({
  activeMetaById: ACTIVE_META_BY_ID,
  activeStablecoins: ACTIVE_STABLECOINS,
  hasTrackedVariantMeta,
});

const EXPECTED_TRACKED_STABLECOIN_COUNT = 410;

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
    expect(perCoinGenerated).toHaveLength(TRACKED_META_BY_ID.size);
    expect(canonicalOrder).toHaveLength(TRACKED_META_BY_ID.size);
    expect(
      usdMajor.length + usdMinor.length + nonUsd.length + commodity.length + preLaunch.length + perCoinGenerated.length,
    ).toBe(canonicalOrder.length);
    // Raw JSON length vs. the production DEAD_STABLECOINS export: catches the schema
    // parser silently dropping or duplicating rows (DEAD_STABLECOINS.length alone would
    // be a tautology, since it's built from the same parse call on the same asset).
    expect(deadStablecoinAsset).toHaveLength(DEAD_STABLECOINS.length);
    expect(new Set(DEAD_STABLECOINS.map((coin) => coin.id)).size).toBe(DEAD_STABLECOINS.length);
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
    expect(preLaunchCoins).toHaveLength(PRE_LAUNCH_STABLECOINS.length);
    expect(preLaunchCoins.map((coin) => coin.id).sort()).toEqual(PRE_LAUNCH_STABLECOINS.map((coin) => coin.id).sort());
    expect(preLaunchCoins.every((coin) => coin.status === "pre-launch")).toBe(true);
  });

  it("keeps active and pre-launch partitions aligned after the JSON migration", () => {
    const inactiveStablecoinCount = PRE_LAUNCH_STABLECOINS.length + FROZEN_STABLECOINS.length;
    const partitionIds = [...ACTIVE_STABLECOINS, ...PRE_LAUNCH_STABLECOINS, ...FROZEN_STABLECOINS]
      .map((coin) => coin.id);

    // Deliberate addition tripwire: bump this expected total when adding a tracked coin.
    expect(TRACKED_STABLECOINS).toHaveLength(EXPECTED_TRACKED_STABLECOIN_COUNT);
    expect(ACTIVE_STABLECOINS).toHaveLength(TRACKED_STABLECOINS.length - inactiveStablecoinCount);
    expect(ACTIVE_STABLECOINS.length + inactiveStablecoinCount).toBe(TRACKED_STABLECOINS.length);
    expect(new Set(partitionIds).size).toBe(TRACKED_STABLECOINS.length);
    expect(PRE_LAUNCH_STABLECOINS.map((coin) => coin.id)).toEqual([
      "roughrider-bnd",
      "fiusd-fiserv",
      "eur-qivalis",
      "pusd-polaris",
      "pgold-polaris",
      "klarnausd-klarna",
      "bd-basedollar",
      "mmxn-moneta-digital",
      "trusd-tori",
      "rgbp-revolut",
      "jpysc-sbi-startale",
      "usdb-bridge",
      "hkdap-anchorpoint",
      "hkd-hsbc",
      "okrw-hashed",
      "arc-anq",
      "brl-b3",
      "usdf-flipcash",
      "hkdr-rd-technologies",
      "brd-volpon",
      "krw1-bdacs",
      "rusd-revolut",
      "brl-itau",
      "usd-nubank",
      "krw-imbank",
      "gynusd-gyndore",
      "gelt-tether",
      "tgld-tenbin",
      "ejpy-jbfd",
      "aed-rakbank",
      "bils-bitsofgold",
      "kusd-kerne",
      "ousd-open-standard",
    ]);
  });

  it("keeps tracked registry metadata free of standalone algorithmic backing classifications", () => {
    const algorithmicIds = TRACKED_STABLECOINS
      .filter((coin) => coin.flags.backing === "algorithmic")
      .map((coin) => coin.id);

    expect(algorithmicIds).toEqual([]);
  });

  it("accepts supported fuzzy launch date formats", () => {
    const accepted = ["2026", "2026-05", "2026-05-27", "2026-Q2", "2026-H1"];

    for (const value of accepted) {
      expect(parseStablecoinMetaAssets([
        makeStablecoinAsset({
          launchDate: value,
          announcedDate: value,
          expectedLaunchDate: value,
          milestones: [{ date: value, type: "milestone", title: "Launch milestone" }],
          dateHistory: [{ date: value, setOn: "2026-01-15" }],
        }),
      ], `accepted ${value}`)[0]).toMatchObject({
        launchDate: value,
        announcedDate: value,
        expectedLaunchDate: value,
      });
    }
  });

  it("rejects unsupported launch date formats", () => {
    const rejected = ["2026-13", "2026-02-30", "2026-Q5", "2026-H3", "H1 2026", "2026/05/27"];

    for (const value of rejected) {
      expect(() => parseStablecoinMetaAssets([
        makeStablecoinAsset({ expectedLaunchDate: value }),
      ], `rejected ${value}`)).toThrow(/Expected YYYY/);
    }
  });

  it("keeps dateHistory setOn strict while allowing fuzzy historical dates", () => {
    expect(parseStablecoinMetaAssets([
      makeStablecoinAsset({ dateHistory: [{ date: "2026-H2", setOn: "2026-06-28" }] }),
    ], "dateHistory fuzzy date")).toHaveLength(1);

    expect(() => parseStablecoinMetaAssets([
      makeStablecoinAsset({ dateHistory: [{ date: "2026-H2", setOn: "2026-H1" }] }),
    ], "dateHistory fuzzy setOn")).toThrow(/Expected YYYY-MM-DD/);
  });

  it("requires http URLs for external evidence fields", () => {
    const cases: Array<{ label: string; overrides: Record<string, unknown> }> = [
      {
        label: "proofOfReserves",
        overrides: { proofOfReserves: { type: "independent-audit", url: "ftp://example.com/report.pdf" } },
      },
      {
        label: "links",
        overrides: { links: [{ label: "Docs", url: "/docs" }] },
      },
      {
        label: "mica references",
        overrides: { mica: { status: "authorized", references: [{ label: "Register", url: "mailto:issuer@example.com" }] } },
      },
      {
        label: "milestone source",
        overrides: {
          milestones: [{ date: "2026-01-01", type: "milestone", title: "Milestone", sourceUrl: "ftp://example.com" }],
        },
      },
      {
        label: "featured content url",
        overrides: {
          featuredContent: [{ type: "article", url: "/article", title: "Article" }],
        },
      },
    ];

    for (const { label, overrides } of cases) {
      expect(() => parseStablecoinMetaAssets([
        makeStablecoinAsset(overrides),
      ], `bad ${label}`)).toThrow(/Expected an http\(s\) URL/);
    }
  });

  it("allows local or http featured content images only", () => {
    expect(parseStablecoinMetaAssets([
      makeStablecoinAsset({
        featuredContent: [{
          type: "article",
          url: "https://example.com/article",
          title: "Article",
          image: "/featured/example.png",
        }],
      }),
    ], "local featured image")).toHaveLength(1);

    expect(parseStablecoinMetaAssets([
      makeStablecoinAsset({
        featuredContent: [{
          type: "article",
          url: "https://example.com/article",
          title: "Article",
          image: "https://example.com/image.png",
        }],
      }),
    ], "remote featured image")).toHaveLength(1);

    expect(() => parseStablecoinMetaAssets([
      makeStablecoinAsset({
        featuredContent: [{
          type: "article",
          url: "https://example.com/article",
          title: "Article",
          image: "ftp://example.com/image.png",
        }],
      }),
    ], "bad featured image")).toThrow(/Invalid input/);
  });

  it("tracks the current implementation-scope variants", () => {
    const variantIds = ACTIVE_STABLECOINS
      .filter((coin) => isTrackedVariant(coin.id))
      .map((coin) => coin.id);

    expect(variantIds).toEqual([
      "susdt-spark",
      "steakusdt-steakhouse",
      "susdc-spark",
      "gtusdcp-gauntlet",
      "gtusdc-gauntlet",
      "yvusdc-yearn",
      "steakusdc-steakhouse",
      "bbqusdc-steakhouse",
      "srusde-strata",
      "susde-ethena",
      "susds-sky",
      "stusds-sky",
      "susd1plus-lorenzo",
      "sdai-sky",
      "aa-falconx-mev-capital",
      "susdd-tron-dao-reserve",
      "susdai-usd-ai",
      "busd0-usual",
      "sgho-aave",
      "stkgho-umbrella-aave",
      "stcusd-cap",
      "scrvusd-curve",
      "sdola-inverse-finance",
      "asusdf-astherus",
      "sfrxusd-frax",
      "savusd-avant",
      "cusdo-openeden",
      "syusd-aegis",
      "sbold-k3-capital",
      "ybold-yearn",
      "fxsave-f-x-protocol",
      "susn-noon",
      "syzusd-yuzu",
      "sdusd-dtrinity",
      "srusd-reservoir",
      "syrupusdc-maple",
      "syrupusdt-maple",
      "zys-zephyr-protocol",
      "autousd-auto-finance",
      "eearn-ember",
      "yusd-yieldfi",
      "said-gaib",
      "apyusd-apyx",
      "stusd-stoneyield",
      "hbusdt-hyperbeat",
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

  it("keeps multi-variant parents explicit", () => {
    expect(getVariants("usds-sky").map((coin) => coin.id)).toEqual(["susds-sky", "stusds-sky"]);
    expect(getVariants("bold-liquity").map((coin) => coin.id)).toEqual(["sbold-k3-capital", "ybold-yearn"]);
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

  it("rejects static dependency and reserve self-links", () => {
    expect(() => parseStablecoinMetaAssets([
      makeStablecoinAsset({ dependencies: [{ id: "schema-test-usd", weight: 1 }] }),
    ], "self-dependency.json")).toThrowError(/cannot reference the stablecoin itself/);
    expect(() => parseStablecoinMetaAssets([
      makeStablecoinAsset({
        reserves: [{ name: "Self", pct: 100, risk: "low", coinId: "schema-test-usd" }],
      }),
    ], "self-reserve.json")).toThrowError(/cannot reference the stablecoin itself/);
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

  it("validates detailProvider through the canonical metadata enum schema", () => {
    for (const detailProvider of DETAIL_PROVIDER_VALUES) {
      expect(parseStablecoinMetaAssets([
        makeStablecoinAsset({ detailProvider }),
      ], `detail-provider-${detailProvider}.json`)[0]?.detailProvider).toBe(detailProvider);
    }

    expect(() => parseStablecoinMetaAssets([
      makeStablecoinAsset({ detailProvider: "coinmarketcap" }),
    ], "detail-provider-broken.json")).toThrowError(/detailProvider/);
  });

  it("reports duplicate IDs and canonical-order drift through the shared invariant helper", () => {
    expect(findStablecoinCatalogInvariantIssues({
      canonicalOrder: ["alpha-usd", "alpha-usd", "ghost-usd"],
      stablecoins: [
        { id: "alpha-usd" },
        { id: "alpha-usd" },
        { id: "beta-usd" },
      ],
    })).toEqual({
      duplicateStablecoinIds: ["alpha-usd"],
      duplicateCanonicalOrderIds: ["alpha-usd"],
      missingCanonicalOrderIds: ["beta-usd"],
      unknownCanonicalOrderIds: ["ghost-usd"],
    });
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

  it("keeps BOLD itself as non-yield-bearing metadata", () => {
    const coin = TRACKED_META_BY_ID.get("bold-liquity");

    expect(coin).toBeDefined();
    expect(coin?.yieldConfig).toBeUndefined();
  });

  it("keeps base USDAI on the curated supply path while sUSDai owns the mixed protocol reserve feed", () => {
    const usdai = TRACKED_META_BY_ID.get("usdai-usd-ai");
    const susdai = TRACKED_META_BY_ID.get("susdai-usd-ai");

    expect(usdai?.reserves).toEqual([
      {
        name: "PYUSD (PayPal USD) held by USDai contract",
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

import { describe, expect, it } from "vitest";
import deadStablecoinAsset from "../../data/dead-stablecoins.json";
import canonicalOrderAsset from "../../data/stablecoins/canonical-order.json";
import commodityAsset from "../../data/stablecoins/commodity.json";
import nonUsdAsset from "../../data/stablecoins/non-usd.json";
import usdMajorAsset from "../../data/stablecoins/usd-major.json";
import usdMinorAsset from "../../data/stablecoins/usd-minor.json";
import { hasReserveDisplayBadgeForAdapter } from "../live-reserve-display";
import { CANONICAL_ETH_RESERVE_RISK } from "../reserve-asset-risk";
import {
  ACTIVE_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  TRACKED_META_BY_ID,
  TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins";
import {
  parseCanonicalOrderAsset,
  parseDeadStablecoinAssets,
  parseStablecoinMetaAssets,
} from "../stablecoins/schema";

describe("tracked stablecoin metadata", () => {
  it("loads all JSON registry assets through the shared schemas", () => {
    const usdMajor = parseStablecoinMetaAssets(usdMajorAsset, "usd-major");
    const usdMinor = parseStablecoinMetaAssets(usdMinorAsset, "usd-minor");
    const nonUsd = parseStablecoinMetaAssets(nonUsdAsset, "non-usd");
    const commodity = parseStablecoinMetaAssets(commodityAsset, "commodity");
    const canonicalOrder = parseCanonicalOrderAsset(canonicalOrderAsset, "canonical-order");

    expect(usdMajor).toHaveLength(29);
    expect(usdMinor).toHaveLength(113);
    expect(nonUsd).toHaveLength(40);
    expect(commodity).toHaveLength(10);
    expect(canonicalOrder).toHaveLength(192);
    expect(usdMajor.length + usdMinor.length + nonUsd.length + commodity.length).toBe(canonicalOrder.length);
    expect(parseDeadStablecoinAssets(deadStablecoinAsset, "dead-stablecoins")).toHaveLength(87);
  });

  it("keeps canonical order references limited to known tracked IDs", () => {
    const knownIds = new Set([
      ...parseStablecoinMetaAssets(usdMajorAsset, "usd-major"),
      ...parseStablecoinMetaAssets(usdMinorAsset, "usd-minor"),
      ...parseStablecoinMetaAssets(nonUsdAsset, "non-usd"),
      ...parseStablecoinMetaAssets(commodityAsset, "commodity"),
    ].map((coin) => coin.id));

    expect(parseCanonicalOrderAsset(canonicalOrderAsset, "canonical-order").filter((id) => !knownIds.has(id))).toEqual([]);
  });

  it("keeps active and pre-launch partitions unchanged after the JSON migration", () => {
    expect(TRACKED_STABLECOINS).toHaveLength(192);
    expect(ACTIVE_STABLECOINS).toHaveLength(182);
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
    ]);
  });

  it("keeps the active registry free of standalone algorithmic backing classifications", () => {
    const algorithmicIds = ACTIVE_STABLECOINS
      .filter((coin) => coin.flags.backing === "algorithmic")
      .map((coin) => coin.id);

    expect(algorithmicIds).toEqual([]);
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

  it("rejects malformed dead stablecoin assets with readable schema errors", () => {
    expect(() => parseDeadStablecoinAssets([{
      name: "Broken Dead Coin",
      symbol: "DEAD",
      pegCurrency: "USD",
      causeOfDeath: "algorithmic-failure",
      deathDate: "2025-01-01",
      sourceUrl: "https://example.com",
    }], "dead-broken.json")).toThrowError(/dead-broken\.json/);
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

        const hasMatchingContract = coin.contracts?.some(
          (contract) => contract.chain === (primary.kind === "onchain-solana" ? "solana" : primary.chain)
            && (
              primary.kind === "onchain-solana"
                ? contract.address.length > 0
                : contract.address.startsWith("0x")
            ),
        ) ?? false;
        const contractKey = primary.kind === "onchain-solana" ? "solana" : primary.chain;
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

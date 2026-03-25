import { describe, expect, it } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import {
  AUTO_LENDING_POOL_MAP,
  AUTO_LENDING_SAFETY_BYPASS_IDS,
  LENDING_PROTOCOL_ALLOWLIST,
  LENDING_PROTOCOL_LABELS,
  ON_CHAIN_RATE_CONFIGS,
  PRICE_DERIVED_FALLBACK_IDS,
  RATE_DERIVED_CONFIGS,
  YIELD_ADAPTER_MANIFEST,
  YIELD_POOL_MAP,
  YIELD_VARIANT_MAP,
} from "../yield-config";

const onChainIds = new Set(ON_CHAIN_RATE_CONFIGS.map((config) => config.stablecoinId));
const rateDerivedIds = new Set(RATE_DERIVED_CONFIGS.map((config) => config.stablecoinId));

function hasRuntimeYieldStrategy(stablecoinId: string, navToken: boolean) {
  return (
    Boolean(YIELD_POOL_MAP[stablecoinId]) ||
    Boolean(YIELD_VARIANT_MAP[stablecoinId]) ||
    onChainIds.has(stablecoinId) ||
    navToken ||
    PRICE_DERIVED_FALLBACK_IDS.has(stablecoinId) ||
    rateDerivedIds.has(stablecoinId) ||
    Boolean(AUTO_LENDING_POOL_MAP[stablecoinId])
  );
}

describe("yield config registry", () => {
  const activeYieldCoins = TRACKED_STABLECOINS.filter(
    (coin) => coin.flags.yieldBearing && coin.status !== "pre-launch",
  );

  it("gives every active yield-bearing coin a runtime strategy", () => {
    const uncovered = activeYieldCoins
      .filter((coin) => !hasRuntimeYieldStrategy(coin.id, coin.flags.navToken))
      .map((coin) => coin.id);

    expect(uncovered).toEqual([]);
  });

  it("requires yieldConfig metadata for every active yield-bearing coin", () => {
    const missing = activeYieldCoins
      .filter((coin) => !coin.yieldConfig)
      .map((coin) => coin.id);

    expect(missing).toEqual([]);
  });

  it("keeps deterministic on-chain configs unique and attached to tracked contracts", () => {
    const ids = ON_CHAIN_RATE_CONFIGS.map((config) => config.stablecoinId);
    expect(new Set(ids).size).toBe(ids.length);

    for (const config of ON_CHAIN_RATE_CONFIGS) {
      const coin = TRACKED_STABLECOINS.find((entry) => entry.id === config.stablecoinId);
      expect(coin, config.stablecoinId).toBeDefined();
      expect(coin?.flags.yieldBearing, config.stablecoinId).toBe(true);
      expect((coin?.contracts ?? []).length, config.stablecoinId).toBeGreaterThan(0);
    }
  });

  it("requires every safety-bypass id to have a deterministic lending override", () => {
    for (const stablecoinId of AUTO_LENDING_SAFETY_BYPASS_IDS) {
      expect(AUTO_LENDING_POOL_MAP[stablecoinId], stablecoinId).toBeTruthy();
    }
  });

  it("exports a unified manifest entry for every configured yield adapter surface", () => {
    const manifestIds = new Set(YIELD_ADAPTER_MANIFEST.map((entry) => entry.stablecoinId));
    const configuredIds = new Set([
      ...Object.keys(YIELD_VARIANT_MAP),
      ...Object.keys(YIELD_POOL_MAP),
      ...ON_CHAIN_RATE_CONFIGS.map((config) => config.stablecoinId),
      ...RATE_DERIVED_CONFIGS.map((config) => config.stablecoinId),
      ...PRICE_DERIVED_FALLBACK_IDS,
      ...Object.keys(AUTO_LENDING_POOL_MAP),
      "dusd-dtrinity",
      "reusd-re-protocol",
    ]);

    expect(manifestIds).toEqual(configuredIds);
  });

  it("documents the quarantined deterministic adapters in the manifest", () => {
    const quarantined = YIELD_ADAPTER_MANIFEST
      .filter((entry) => entry.deterministicQuarantineReason)
      .map((entry) => entry.stablecoinId)
      .sort();

    expect(quarantined).toEqual(["dusd-dtrinity", "reusd-re-protocol"]);
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
});

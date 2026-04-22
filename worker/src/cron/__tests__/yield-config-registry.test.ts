import { describe, expect, it } from "vitest";
import { PRE_LAUNCH_STABLECOINS, TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import {
  EXPLICIT_YIELD_SOURCE_POOL_MAP,
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

  it("exports a unified manifest entry for every yield-bearing stablecoin", () => {
    const manifestIds = new Set(YIELD_ADAPTER_MANIFEST.map((entry) => entry.stablecoinId));
    const yieldBearingIds = new Set(
      TRACKED_STABLECOINS
        .filter((coin) => coin.flags.yieldBearing)
        .map((coin) => coin.id),
    );

    expect(manifestIds).toEqual(yieldBearingIds);
    expect(YIELD_ADAPTER_MANIFEST.every((entry) => entry.strategies.length > 0)).toBe(true);
  });

  it("marks intentional manifest gaps explicitly instead of leaving them implicit", () => {
    for (const stablecoinId of ["bd-basedollar", "pusd-polaris", "trusd-tori", "usg-tangent"]) {
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

    expect(quarantined).toEqual(["dusd-dtrinity", "reusd-re-protocol", "scrvusd-curve"]);
  });

  it("moves tracked savings-wrapper runtime ownership from the parent ids to the child ids", () => {
    for (const stablecoinId of ["usde-ethena", "usds-sky", "dai-makerdao", "frxusd-frax", "crvusd-curve"]) {
      expect(YIELD_POOL_MAP[stablecoinId], stablecoinId).toBeUndefined();
      expect(YIELD_VARIANT_MAP[stablecoinId], stablecoinId).toBeUndefined();
    }

    expect(YIELD_POOL_MAP["susde-ethena"]).toBe("66985a81-9c51-46ca-9977-42b4fe7bc6df");
    expect(YIELD_POOL_MAP["susds-sky"]).toBe("d8c4eff5-c8a9-46fc-a888-057c4c668e72");
    expect(YIELD_POOL_MAP["sdai-sky"]).toBe("13392973-be6e-4b2f-bce9-4f7dd53d1c3a");
    expect(YIELD_POOL_MAP["sfrxusd-frax"]).toBe("42523cca-14b0-44f6-95fb-4781069520a5");
    expect(YIELD_POOL_MAP["scrvusd-curve"]).toBe("5fd328af-4203-471b-bd16-1705c726d926");
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
});

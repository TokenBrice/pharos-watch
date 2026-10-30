import { describe, expect, it } from "vitest";
import { buildRedemptionBackstopRegistry, type RedemptionBackstopConfigManifestEntry } from "@shared/lib/redemption-backstop-configs/manifest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { resolveReviewedRedemptionSettlementDelay } from "@shared/lib/redemption-backstop-configs/settlement";
import {
  REDEMPTION_BACKSTOP_CONFIGS,
  getRedemptionBackstopConfig,
  resolveReviewedRedemptionSettlement,
} from "@shared/lib/redemption-backstops";

const entries = Object.entries(REDEMPTION_BACKSTOP_CONFIGS);

describe("redemption backstop config consistency", () => {
  it("uses every reviewed settlement override as the canonical public model", () => {
    const clockSec = Date.UTC(2026, 9, 8) / 1_000;
    const reviewed = entries.filter(([, config]) => config.v9RouteReviewTerms?.settlementModel != null);
    expect(reviewed.length).toBeGreaterThan(0);
    for (const [id, config] of reviewed) {
      expect(resolveReviewedRedemptionSettlement(config, clockSec), id).toBe(
        config.v9RouteReviewTerms?.settlementModel,
      );
    }
  });

  it.each(["slvon-ondo", "iauon-ondo"])("does not apply the %s USDon review before its evidence date", (id) => {
    const config = getRedemptionBackstopConfig(id)!;
    const reviewed = config.v9RouteReviewTerms!;
    const reviewClockSec = Date.parse(`${reviewed.reviewedAt}T00:00:00Z`) / 1_000;
    // The current documentary route never promises completed settlement, on
    // either side of its evidence date.
    for (const clockSec of [reviewClockSec - 1, reviewClockSec + 86_400]) {
      expect(resolveReviewedRedemptionSettlement(config, clockSec)).toBe("immediate");
      expect(resolveReviewedRedemptionSettlementDelay(reviewed, clockSec)).toBeUndefined();
    }
    // Isolate the admission guard with a completion-bound fixture; this is not
    // a claim that the real Ondo route has an atomic completed endpoint.
    const datedCompletionFixture = {
      ...config,
      v9RouteReviewTerms: {
        ...reviewed,
        settlementModel: "atomic" as const,
        settlementDelaySec: 0,
        missingScoringFields: reviewed.missingScoringFields!.filter((field) => field !== "settlement"),
      },
    };
    expect(resolveReviewedRedemptionSettlement(datedCompletionFixture, reviewClockSec - 1)).toBe("immediate");
    expect(resolveReviewedRedemptionSettlement(datedCompletionFixture, reviewClockSec + 86_400)).toBe("atomic");
  });

  it("algorithmic backing excludes offchain-issuer route", () => {
    const violations = entries
      .filter(([id, c]) => {
        const meta = TRACKED_META_BY_ID.get(id);
        return meta?.flags.backing === "algorithmic" && c.routeFamily === "offchain-issuer";
      })
      .map(([id]) => id);
    expect(violations).toEqual([]);
  });

  it("delta-neutral protocols must not use supply-full capacity", () => {
    const DELTA_NEUTRAL_KEYWORDS = [
      "delta-neutral",
      "delta neutral",
      "funding rate arbitrage",
      "COIN-M perpetual short",
    ];

    const violations = entries
      .filter(([id, c]) => {
        const meta = TRACKED_META_BY_ID.get(id);
        if (!meta?.pegMechanism || c.capacityModel.kind !== "supply-full") return false;
        const peg = meta.pegMechanism.toLowerCase();
        return DELTA_NEUTRAL_KEYWORDS.some((kw) => peg.includes(kw.toLowerCase()));
      })
      .map(([id]) => id);
    expect(violations).toEqual([]);
  });

  it("rejects an injected wrong-family manifest before exposing a registry", () => {
    const config = getRedemptionBackstopConfig("usdc-circle")!;
    const manifest: RedemptionBackstopConfigManifestEntry[] = [{
      name: "fixture-queue", filePath: "shared/fixture-queue.ts",
      allowedRouteFamilies: ["queue-redeem"],
      entries: [{ id: "alpha", config, sourceFilePath: "shared/fixture-row.ts" }],
    }];
    expect(() => buildRedemptionBackstopRegistry(manifest)).toThrow();
    expect(buildRedemptionBackstopRegistry([{ ...manifest[0]!, allowedRouteFamilies: [config.routeFamily] }])["alpha"]).toEqual(config);
  });

  it("rejects same-family and cross-family shadowing without mutating source metadata", () => {
    const config = getRedemptionBackstopConfig("usdc-circle")!;
    const replacement = { ...config, settlementModel: "days" as const };
    const manifest: RedemptionBackstopConfigManifestEntry[] = [{
      name: "fixture-issuer", filePath: "shared/fixture-issuer.ts", allowedRouteFamilies: [config.routeFamily],
      entries: [
        { id: "alpha", config, sourceFilePath: "shared/base-source.ts" },
        { id: "alpha", config: replacement, sourceFilePath: "shared/reviewed-source.ts" },
      ],
    }];
    const authored = structuredClone(manifest);
    expect(() => buildRedemptionBackstopRegistry(manifest)).toThrow(/alpha/);
    expect(manifest).toEqual(authored);
    expect(() => buildRedemptionBackstopRegistry([
      { ...manifest[0]!, entries: [manifest[0]!.entries[0]!] },
      { ...manifest[0]!, name: "other-owner", filePath: "shared/other-owner.ts", entries: [manifest[0]!.entries[1]!] },
    ])).toThrow();
  });

  // --- Cross-family invariants (TG-3) ---

  it("stablecoin-redeem and psm-swap should not use opaque execution", () => {
    const violations = entries
      .filter(
        ([, c]) =>
          (c.routeFamily === "stablecoin-redeem" || c.routeFamily === "psm-swap") && c.executionModel === "opaque",
      )
      .map(([id, c]) => `${id}: ${c.routeFamily} + opaque`);
    expect(violations).toEqual([]);
  });

  it("expanded shared configs receive per-coin reviewed docs instead of shared first-id docs", () => {
    const expectedPrimaryUrls = new Map([
      ["a7a5-old-vector", "https://www.a7a5.io/"],
      ["gusd-gate", "https://www.gate.com/staking/USDT?isDebtType=1&pid=33"],
      ["usyc-hashnote", "https://usyc.hashnote.com/"],
      ["zarp-zarp", "https://www.zarpstablecoin.com/"],
      ["cetes-etherfuse", "https://app.etherfuse.com/legal/proof-of-reserves"],
    ]);

    for (const [id, expectedUrl] of expectedPrimaryUrls) {
      expect(REDEMPTION_BACKSTOP_CONFIGS[id]?.docs?.[0]?.url).toBe(expectedUrl);
    }
  });

  // Registry-derived invariants cannot catch a curation edit that swaps a coin
  // onto another family the same module also allows (psm-and-basket permits
  // both). These reviewed rows pin the published route shape by value.
  it.each([
    ["usdc-circle", "offchain-issuer", "supply-ratio", "dynamic-or-unclear"],
    ["usdcv-societe-generale-forge", "offchain-issuer", "supply-full", "dynamic-or-unclear"],
    ["chfau-allunity", "offchain-issuer", "supply-full", "fee-bps"],
    ["m-m0", "offchain-issuer", "supply-full", "dynamic-or-unclear"],
    ["usdcx-movement", "queue-redeem", "unquantified", "dynamic-or-unclear"],
    ["usdn-noble", "queue-redeem", "unquantified", "dynamic-or-unclear"],
    ["usdon-ondo", "psm-swap", "unquantified", "dynamic-or-unclear"],
    ["swanusd-swan", "psm-swap", "reserve-sync-metadata", "fee-bps"],
    ["dai-makerdao", "psm-swap", "reserve-sync-metadata", "fee-bps"],
    ["usds-sky", "psm-swap", "reserve-sync-metadata", "fee-bps"],
    ["gho-aave", "psm-swap", "reserve-sync-metadata", "fee-bps"],
    ["lisusd-lista", "psm-swap", "supply-ratio", "fee-bps"],
    ["usdd-tron-dao-reserve", "psm-swap", "reserve-sync-metadata", "fee-bps"],
    ["honey-berachain", "basket-redeem", "reserve-sync-metadata", "dynamic-or-unclear"],
    ["eusd-electronic-usd", "basket-redeem", "reserve-sync-metadata", "fee-bps"],
    ["usde-ethena", "stablecoin-redeem", "reserve-sync-metadata", "fee-bps"],
    ["ousd-origin-protocol", "stablecoin-redeem", "reserve-sync-metadata", "fee-bps"],
    ["frxusd-frax", "stablecoin-redeem", "reserve-sync-metadata", "dynamic-or-unclear"],
  ] as const)("%s keeps its reviewed route shape (%s / %s / %s)", (id, routeFamily, capacityKind, costKind) => {
    const config = REDEMPTION_BACKSTOP_CONFIGS[id];
    expect(config?.routeFamily).toBe(routeFamily);
    expect(config?.capacityModel.kind).toBe(capacityKind);
    expect(config?.costModel.kind).toBe(costKind);
  });

  it("binds swanUSD's PSM exit to the same-run freePsmAssets telemetry, never to supply", () => {
    const config = REDEMPTION_BACKSTOP_CONFIGS["swanusd-swan"]!;
    expect(config.outputAssets).toEqual(["usds-sky"]);
    expect(config.capacityModel).toEqual({
      kind: "reserve-sync-metadata",
      basis: "live-direct-telemetry",
      requiredOutputAssetKeys: ["usds-sky"],
    });
    // The only reviewed term gap was capacity; live telemetry closes it, so no
    // bounded-terms-gap may be re-introduced here.
    expect(config.v9RouteReviewTerms).toBeUndefined();
    // No supply-ratio or fixed-USD fallback can stand in for a same-run read.
    expect(config.capacityModel).not.toHaveProperty("fallbackRatio");
    expect(config.capacityModel).not.toHaveProperty("fallbackUsd");
    for (const doc of config.docs ?? []) expect(doc.supports?.length, doc.url).toBeGreaterThan(0);
    // The separate collateral-redemption rail is documented in notes only; one
    // route config per id means it must never become configured capacity.
    expect(config.notes?.some((note) => note.includes("redeem(borrower"))).toBe(true);
  });

  it("non-issuer documented supply-full routes do not force issuer-term capacity basis", () => {
    const violations = entries
      .filter(
        ([, c]) =>
          c.capacityModel.kind === "supply-full" &&
          c.capacityModel.basis === "issuer-term-redemption" &&
          c.routeFamily !== "offchain-issuer" &&
          c.routeFamily !== "stablecoin-redeem",
      )
      .map(([id, c]) => `${id}: ${c.routeFamily}`);
    expect(violations).toEqual([]);
  });

});

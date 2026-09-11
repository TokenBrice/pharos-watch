import { describe, expect, it } from "vitest";
import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { resolveCapacityConfidence, resolveFeeConfidence } from "@shared/lib/redemption-backstop-confidence";
import { REDEMPTION_BACKSTOP_CONFIG_MANIFEST } from "@shared/lib/redemption-backstop-configs";
import { configsFromBackstopEntries } from "@shared/lib/redemption-backstop-configs/factory";
import { RedemptionBackstopConfigSchema } from "@shared/lib/redemption-backstop-configs/schema";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  REDEMPTION_BACKSTOP_CONFIGS,
  resolveReviewedRedemptionSettlement,
} from "@shared/lib/redemption-backstops";
import type {
  RedemptionAccessModel,
  RedemptionExecutionModel,
  RedemptionRouteFamily,
  RedemptionSettlementModel,
} from "@shared/types";

const entries = Object.entries(REDEMPTION_BACKSTOP_CONFIGS);
const familyModules = REDEMPTION_BACKSTOP_CONFIG_MANIFEST;

describe("redemption backstop config consistency", () => {
  it("every config parses through the shared schema", () => {
    const violations = entries.flatMap(([id, config]) => {
      const result = RedemptionBackstopConfigSchema.safeParse(config);
      if (result.success) return [];
      return result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
        return `${id}: ${path}: ${issue.message}`;
      });
    });

    expect(violations).toEqual([]);
  });

  it("uses every reviewed settlement override as the canonical public model", () => {
    const clockSec = Date.UTC(2026, 8, 5) / 1_000;
    const reviewed = entries.filter(([, config]) => config.v9RouteReviewTerms?.settlementModel != null);
    expect(reviewed.length).toBeGreaterThan(0);
    for (const [id, config] of reviewed) {
      expect(resolveReviewedRedemptionSettlement(config, clockSec), id).toBe(
        config.v9RouteReviewTerms?.settlementModel,
      );
    }
  });

  it("every config ID exists in TRACKED_META_BY_ID", () => {
    const missing = entries.filter(([id]) => !TRACKED_META_BY_ID.has(id)).map(([id]) => id);
    expect(missing).toEqual([]);
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

  it("family modules do not shadow ids across files", () => {
    const seenById = new Map<string, string>();
    const duplicates: string[] = [];

    for (const moduleEntry of familyModules) {
      for (const { id, overrideReason } of moduleEntry.entries) {
        const previous = seenById.get(id);
        if (previous && (previous !== moduleEntry.name || !overrideReason)) {
          duplicates.push(`${id}: ${previous}, ${moduleEntry.name}`);
          continue;
        }
        seenById.set(id, moduleEntry.name);
      }
    }

    expect(duplicates).toEqual([]);
    expect(seenById.size).toBe(Object.keys(REDEMPTION_BACKSTOP_CONFIGS).length);
  });

  it("family modules only contain their declared route families", () => {
    const violations = familyModules.flatMap((moduleEntry) =>
      Object.entries(configsFromBackstopEntries(moduleEntry.entries))
        .filter(([, config]) => {
          const allowedRouteFamilies: readonly RedemptionRouteFamily[] = moduleEntry.allowedRouteFamilies;
          return !allowedRouteFamilies.includes(config.routeFamily);
        })
        .map(([id, config]) => `${moduleEntry.name}:${id}:${config.routeFamily}`),
    );

    expect(violations).toEqual([]);
  });

  it("every config resolves to an explicit confidence tier", () => {
    const violations = entries
      .filter(([, config]) => {
        const capacityConfidence = resolveCapacityConfidence(config.capacityModel);
        const feeConfidence = resolveFeeConfidence(config.costModel);
        return !capacityConfidence || !feeConfidence;
      })
      .map(([id]) => id);

    expect(violations).toEqual([]);
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

  it("every route family has at least one configured coin", () => {
    const families: RedemptionRouteFamily[] = [
      "stablecoin-redeem",
      "basket-redeem",
      "collateral-redeem",
      "psm-swap",
      "queue-redeem",
      "offchain-issuer",
    ];
    for (const family of families) {
      const count = entries.filter(([, c]) => c.routeFamily === family).length;
      expect(count, `${family} should have at least 1 config`).toBeGreaterThanOrEqual(1);
    }
  });

  it("every dynamic-or-unclear cost model has a fee description", () => {
    const violations = entries
      .filter(([, c]) => c.costModel.kind === "dynamic-or-unclear" && !c.costModel.feeDescription)
      .map(([id]) => id);
    expect(violations).toEqual([]);
  });

  it("documented-bound routes always carry reviewedAt and explicit docs", () => {
    const violations = entries
      .filter(
        ([, c]) =>
          c.capacityModel.confidence === "documented-bound" && (!c.reviewedAt || !c.docs || c.docs.length === 0),
      )
      .map(([id, c]) => `${id}: reviewedAt=${c.reviewedAt ?? "missing"} docs=${c.docs?.length ?? 0}`);
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

  it("reserve-sync routes point only at adapters with redeemable-capacity telemetry and reviewed docs", () => {
    const violations = entries
      .filter(([, c]) => c.capacityModel.kind === "reserve-sync-metadata")
      .flatMap(([id, c]) => {
        const adapterKey = TRACKED_META_BY_ID.get(id)?.liveReservesConfig?.adapter;
        if (!adapterKey) return [`${id}: missing live-reserves adapter`];
        const definition = getLiveReserveAdapterDefinition(adapterKey);
        if (!definition) return [`${id}: adapter ${adapterKey} definition not found`];
        const telemetry = definition.redemptionTelemetry;
        const issues: string[] = [];
        if (telemetry.capacity === "none") {
          issues.push(`${id}: adapter ${adapterKey} has no capacity telemetry`);
        }
        if (!c.reviewedAt) {
          issues.push(`${id}: missing reviewedAt`);
        }
        if (!c.docs || c.docs.length === 0) {
          issues.push(`${id}: missing docs[]`);
        }
        return issues;
      });
    expect(violations).toEqual([]);
  });

  it("every access model appears in at least one config", () => {
    const models: RedemptionAccessModel[] = ["permissionless-onchain", "whitelisted-onchain", "issuer-api", "manual"];
    for (const model of models) {
      // "manual" may not currently be used — skip it
      if (model === "manual") continue;
      const count = entries.filter(([, c]) => c.accessModel === model).length;
      expect(count, `${model} should appear in at least 1 config`).toBeGreaterThanOrEqual(1);
    }
  });

  it("every settlement model appears in at least one config", () => {
    const models: RedemptionSettlementModel[] = ["atomic", "immediate", "same-day", "days", "queued"];
    for (const model of models) {
      const count = entries.filter(([, c]) => c.settlementModel === model).length;
      expect(count, `${model} should appear in at least 1 config`).toBeGreaterThanOrEqual(1);
    }
  });

  it("every execution model appears in at least one config", () => {
    const models: RedemptionExecutionModel[] = [
      "deterministic-onchain",
      "deterministic-basket",
      "rules-based-nav",
      "opaque",
    ];
    for (const model of models) {
      const count = entries.filter(([, c]) => c.executionModel === model).length;
      expect(count, `${model} should appear in at least 1 config`).toBeGreaterThanOrEqual(1);
    }
  });
});

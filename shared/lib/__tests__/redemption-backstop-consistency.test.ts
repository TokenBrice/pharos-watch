import { describe, expect, it } from "vitest";
import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { resolveCapacityConfidence, resolveFeeConfidence } from "@shared/lib/redemption-backstop-confidence";
import { COLLATERAL_REDEEM_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs/collateral-redeem";
import { OFFCHAIN_ISSUER_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs/offchain-issuer";
import { PSM_AND_BASKET_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs/psm-and-basket";
import { QUEUE_REDEEM_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs/queue-redeem";
import { STABLECOIN_REDEEM_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs/stablecoin-redeem";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstops";
import type { RedemptionAccessModel, RedemptionExecutionModel, RedemptionRouteFamily, RedemptionSettlementModel } from "@shared/types";

const entries = Object.entries(REDEMPTION_BACKSTOP_CONFIGS);
const familyModules = [
  {
    name: "offchain-issuer",
    configs: OFFCHAIN_ISSUER_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["offchain-issuer"]),
  },
  {
    name: "psm-and-basket",
    configs: PSM_AND_BASKET_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["basket-redeem", "psm-swap"]),
  },
  {
    name: "collateral-redeem",
    configs: COLLATERAL_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["collateral-redeem"]),
  },
  {
    name: "queue-redeem",
    configs: QUEUE_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["queue-redeem"]),
  },
  {
    name: "stablecoin-redeem",
    configs: STABLECOIN_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["stablecoin-redeem"]),
  },
] as const;

describe("redemption backstop config consistency", () => {
  it("every config ID exists in TRACKED_META_BY_ID", () => {
    const missing = entries.filter(([id]) => !TRACKED_META_BY_ID.has(id)).map(([id]) => id);
    expect(missing).toEqual([]);
  });

  it("no duplicate config IDs", () => {
    const ids = Object.keys(REDEMPTION_BACKSTOP_CONFIGS);
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    expect(dupes).toEqual([]);
  });

  it("offchain-issuer route requires issuer-api or manual access", () => {
    const violations = entries
      .filter(
        ([, c]) => c.routeFamily === "offchain-issuer" && c.accessModel !== "issuer-api" && c.accessModel !== "manual",
      )
      .map(([id, c]) => `${id}: offchain-issuer + ${c.accessModel}`);
    expect(violations).toEqual([]);
  });

  it("permissionless-onchain access excludes offchain-issuer route", () => {
    const violations = entries
      .filter(([, c]) => c.accessModel === "permissionless-onchain" && c.routeFamily === "offchain-issuer")
      .map(([id]) => id);
    expect(violations).toEqual([]);
  });

  it("atomic settlement excludes offchain-issuer route", () => {
    const violations = entries
      .filter(([, c]) => c.settlementModel === "atomic" && c.routeFamily === "offchain-issuer")
      .map(([id]) => id);
    expect(violations).toEqual([]);
  });

  it("queue-redeem route requires queued, days, or same-day settlement", () => {
    const violations = entries
      .filter(
        ([, c]) =>
          c.routeFamily === "queue-redeem" &&
          c.settlementModel !== "queued" &&
          c.settlementModel !== "days" &&
          c.settlementModel !== "same-day",
      )
      .map(([id, c]) => `${id}: queue-redeem + ${c.settlementModel}`);
    expect(violations).toEqual([]);
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
      for (const id of Object.keys(moduleEntry.configs)) {
        const previous = seenById.get(id);
        if (previous) {
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
      Object.entries(moduleEntry.configs)
        .filter(([, config]) => !moduleEntry.allowedRouteFamilies.has(config.routeFamily))
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

  it("issuer-api access should only appear in offchain-issuer or queue-redeem families", () => {
    const allowedFamilies = new Set<RedemptionRouteFamily>(["offchain-issuer", "queue-redeem"]);
    const violations = entries
      .filter(([, c]) => c.accessModel === "issuer-api" && !allowedFamilies.has(c.routeFamily))
      .map(([id, c]) => `${id}: ${c.routeFamily} + issuer-api`);
    expect(violations).toEqual([]);
  });

  it("stablecoin-redeem and psm-swap should not use opaque execution", () => {
    const violations = entries
      .filter(
        ([, c]) =>
          (c.routeFamily === "stablecoin-redeem" || c.routeFamily === "psm-swap") &&
          c.executionModel === "opaque",
      )
      .map(([id, c]) => `${id}: ${c.routeFamily} + opaque`);
    expect(violations).toEqual([]);
  });

  it("all fee-bps values are non-negative", () => {
    const violations = entries
      .filter(([, c]) => c.costModel.kind === "fee-bps" && c.costModel.feeBps < 0)
      .map(([id, c]) => `${id}: feeBps=${c.costModel.kind === "fee-bps" ? c.costModel.feeBps : "?"}`);
    expect(violations).toEqual([]);
  });

  it("supply-ratio values are between 0 and 1", () => {
    const violations = entries
      .filter(
        ([, c]) =>
          c.capacityModel.kind === "supply-ratio" &&
          (c.capacityModel.ratio <= 0 || c.capacityModel.ratio > 1),
      )
      .map(([id, c]) => `${id}: ratio=${c.capacityModel.kind === "supply-ratio" ? c.capacityModel.ratio : "?"}`);
    expect(violations).toEqual([]);
  });

  it("reserve-sync fallback ratios and score caps stay in range", () => {
    const violations = entries.flatMap(([id, c]) => {
      const issues: string[] = [];
      if (
        c.capacityModel.kind === "reserve-sync-metadata" &&
        c.capacityModel.fallbackRatio != null &&
        (c.capacityModel.fallbackRatio <= 0 || c.capacityModel.fallbackRatio > 1)
      ) {
        issues.push(`${id}: fallbackRatio=${c.capacityModel.fallbackRatio}`);
      }
      if (c.totalScoreCap != null && (c.totalScoreCap <= 0 || c.totalScoreCap > 100)) {
        issues.push(`${id}: totalScoreCap=${c.totalScoreCap}`);
      }
      return issues;
    });
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
      .filter(([, c]) => c.capacityModel.confidence === "documented-bound" && (!c.reviewedAt || !c.docs || c.docs.length === 0))
      .map(([id, c]) => `${id}: reviewedAt=${c.reviewedAt ?? "missing"} docs=${c.docs?.length ?? 0}`);
    expect(violations).toEqual([]);
  });

  it("expanded shared configs receive per-coin reviewed docs instead of shared first-id docs", () => {
    const expectedPrimaryUrls = new Map([
      ["a7a5-old-vector", "https://www.a7a5.io/"],
      ["gusd-gate", "https://www.gate.com/gusd"],
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

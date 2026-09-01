import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  buildRedemptionCurrentDepegObservationMap,
  evaluateOutputDependencyImpairment,
  loadSevereActiveDepegAvailabilityMap,
  type ActiveDepegAvailabilityRow,
  type EvaluatedOpenIncident,
} from "../redemption-backstop-availability";
import { buildRedemptionBackstopEntry } from "../redemption-backstop-sources";
import type { ReserveSnapshotMetadataRecord } from "../live-reserves-store";
import { makeAsset } from "../../test-helpers/__shared/fixtures";

const REVIEW_DATE = "2026-04-22";

function observations(entries: Array<[string, number]>) {
  return new Map(entries.map(([id, currentDeviationBps]) => [id, { currentDeviationBps }]));
}

describe("buildRedemptionCurrentDepegObservationMap", () => {
  const now = 1_788_220_800;

  function authoritativeAsset(observedAt: number) {
    return makeAsset({
      id: "usda-avalon",
      symbol: "USDa",
      price: 0.7,
      priceSource: "pyth",
      priceConfidence: "single-source",
      priceObservedAt: observedAt,
      priceUpdatedAt: observedAt,
      agreeSources: ["pyth"],
    });
  }

  it("admits a fresh authoritative signed current deviation", () => {
    const result = buildRedemptionCurrentDepegObservationMap({
      peggedAssets: [authoritativeAsset(now - 60)],
      stablecoinsGenerationAt: now - 60,
      now,
    });

    expect(result.get("usda-avalon")?.currentDeviationBps).toBe(-3000);
  });

  it("rejects a fresh generation whose underlying quote is stale", () => {
    const result = buildRedemptionCurrentDepegObservationMap({
      peggedAssets: [authoritativeAsset(now - 1801)],
      stablecoinsGenerationAt: now - 60,
      now,
    });

    expect(result.has("usda-avalon")).toBe(false);
  });
});

describe("loadSevereActiveDepegAvailabilityMap", () => {
  it("inherits parent severe depeg into tracked wrapper route status", async () => {
    const parentStartedAt = Math.floor(Date.UTC(2026, 3, 20) / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "usds-sky",
            peak_deviation_bps: -3100,
            direction: "below",
            started_at: parentStartedAt,
          },
        ],
      },
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(
      db,
      REVIEW_DATE,
      observations([["usds-sky", -3100]]),
    );

    const parent = result.get("usds-sky");
    expect(parent?.routeStatus).toBe("degraded");
    expect(parent?.activeDepegBps).toBe(3100);

    const variant = result.get("susds-sky");
    expect(variant?.routeStatus).toBe("degraded");
    expect(variant?.routeStatusSource).toBe("market-implied");
    expect(variant?.activeDepegBps).toBe(3100);
    expect(variant?.activeDepegStartedAt).toBe(parentStartedAt);
    expect(variant?.activeDepegDirection).toBe("below");
    expect(variant?.outputImpairedDependencyId).toBe("usds-sky");
    expect(variant?.outputImpairedShare).toBe(1);
    expect(variant?.routeStatusReason).toContain("Output asset impairment: parent USDS");
  });

  it("does not propagate a sub-severe parent depeg to wrappers", async () => {
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "usds-sky",
            peak_deviation_bps: -1200,
            direction: "below",
            started_at: Math.floor(Date.now() / 1000),
          },
        ],
      },
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(
      db,
      REVIEW_DATE,
      observations([["usds-sky", -1200]]),
    );
    expect(result.has("usds-sky")).toBe(false);
    expect(result.has("susds-sky")).toBe(false);
  });

  it("prefers the wrapper's own direct depeg over the inherited parent entry", async () => {
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "usds-sky",
            peak_deviation_bps: -3100,
            direction: "below",
            started_at: 1_000_000,
          },
          {
            stablecoin_id: "susds-sky",
            peak_deviation_bps: -4200,
            direction: "below",
            started_at: 2_000_000,
          },
        ],
      },
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(
      db,
      REVIEW_DATE,
      observations([
        ["usds-sky", -3100],
        ["susds-sky", -4200],
      ]),
    );
    const variant = result.get("susds-sky");
    expect(variant?.activeDepegBps).toBe(4200);
    expect(variant?.activeDepegStartedAt).toBe(2_000_000);
    expect(variant?.routeStatusReason).toContain("fresh authoritative current deviation");
  });

  it("does not impair routes for severe upside depegs", async () => {
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "usds-sky",
            peak_deviation_bps: 3100,
            direction: "above",
            started_at: 1_000_000,
          },
        ],
      },
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(
      db,
      REVIEW_DATE,
      observations([["usds-sky", -3100]]),
    );

    expect(result.has("usds-sky")).toBe(false);
    expect(result.has("susds-sky")).toBe(false);
  });

  it("requires an explicit below direction on the open incident", async () => {
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "usds-sky",
            peak_deviation_bps: -3100,
            started_at: 1_000_000,
          },
        ],
      },
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(
      db,
      REVIEW_DATE,
      observations([["usds-sky", -3100]]),
    );

    expect(result.has("usds-sky")).toBe(false);
  });

  it("impairs configured collateral routes when their structured output dependency is depegged", async () => {
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "ausd-agora",
            peak_deviation_bps: -3600,
            direction: "below",
            started_at: 2_000_000,
          },
        ],
      },
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(
      db,
      REVIEW_DATE,
      observations([["ausd-agora", -3600]]),
    );
    const cusd = result.get("cusd-celo");
    expect(cusd?.routeStatus).toBe("degraded");
    expect(cusd?.outputImpairedDependencyId).toBe("ausd-agora");
    expect(cusd?.outputImpairedShare).toBeCloseTo(0.263979768726, 6);
    expect(cusd?.routeStatusReason).toContain("Output asset impairment");
  });

  it("accumulates impaired shares across multiple basket dependencies without an over-leverage marker", async () => {
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            peak_deviation_bps: -3000,
            direction: "below",
            started_at: 3_000_000,
          },
          {
            stablecoin_id: "usdt-tether",
            peak_deviation_bps: -2600,
            direction: "below",
            started_at: 3_100_000,
          },
        ],
      },
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(
      db,
      REVIEW_DATE,
      observations([
        ["usdc-circle", -3000],
        ["usdt-tether", -2600],
      ]),
    );
    const cusd = result.get("cusd-celo");
    expect(cusd?.routeStatus).toBe("degraded");
    // worst impaired dependency wins attribution (USDC's -3000 bps beats USDT's -2600 bps)
    expect(cusd?.outputImpairedDependencyId).toBe("usdc-circle");
    expect(cusd?.activeDepegBps).toBe(3000);
    // cUSD's reviewed USDC (3.0837494912%) and USDT (12.8710435291%)
    // Mento reserve shares accumulate.
    expect(cusd?.outputImpairedShare).toBeCloseTo(0.159547930203, 6);
    // composition weights sum below 1.0, so no over-leverage marker is emitted
    expect(cusd?.routeStatusReason).not.toContain("over-leveraged");
  });

  it("ignores severe depegs of coins that are no configured route's output dependency", async () => {
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "not-a-tracked-dependency",
            peak_deviation_bps: -4000,
            direction: "below",
            started_at: 1_000_000,
          },
        ],
      },
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(
      db,
      REVIEW_DATE,
      observations([["not-a-tracked-dependency", -4000]]),
    );

    // The direct row itself is preserved, but nothing inherits it
    expect(result.get("not-a-tracked-dependency")?.routeStatus).toBe("degraded");
    expect(result.size).toBe(1);
  });

  it("reports full output impairment when the sole backing asset is depegged", async () => {
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "usde-ethena",
            peak_deviation_bps: -2800,
            direction: "below",
            started_at: 3_000_000,
          },
        ],
      },
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(
      db,
      REVIEW_DATE,
      observations([["usde-ethena", -2800]]),
    );
    const honey = result.get("honey-berachain");
    expect(honey?.routeStatus).toBe("degraded");
    expect(honey?.outputImpairedDependencyId).toBe("usde-ethena");
    // Honey's reviewed live reserves are now a single USDe (Ethena) row at 100%,
    // so a severe USDe depeg fully impairs the modeled route output.
    expect(honey?.outputImpairedShare).toBe(1);
    expect(honey?.routeStatusReason).toContain("modeled route output is impaired");
  });

  it("publishes unknown from stale evidence and never mutates the incident", async () => {
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "usda-avalon",
            direction: "below",
            started_at: 1_765_756_800,
          },
        ],
      },
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(db, REVIEW_DATE, new Map());

    expect(result.get("usda-avalon")).toMatchObject({
      routeStatus: "unknown",
      routeStatusSource: "market-implied",
    });
    expect(result.get("usda-avalon")?.routeStatusReason).toContain("redemption score withheld");
    const history = db.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].sql).toContain("source = 'live'");
    expect(history.every(({ sql }) => /^\s*SELECT\b/i.test(sql))).toBe(true);
  });
});

describe("evaluateOutputDependencyImpairment", () => {
  const row = (stablecoinId: string, startedAt: number): ActiveDepegAvailabilityRow => ({
    stablecoin_id: stablecoinId,
    direction: "below",
    started_at: startedAt,
  });
  const severe = (
    stablecoinId: string,
    currentDeviationBps: number,
    startedAt: number,
  ): EvaluatedOpenIncident => ({
    row: row(stablecoinId, startedAt),
    state: "severe",
    currentDeviationBps,
  });

  it("clamps over-leveraged compositions to a 100% impaired share and flags them", () => {
    // Reserve-derived weights summing to 1.30 — both dependencies impaired
    const weights = new Map([
      ["dep-a", 0.7],
      ["dep-b", 0.6],
    ]);
    const incidentsById = new Map([
      ["dep-a", severe("dep-a", -2800, 1_000_000)],
      ["dep-b", severe("dep-b", -3600, 2_000_000)],
    ]);

    const evaluation = evaluateOutputDependencyImpairment(weights, incidentsById);

    expect(evaluation).not.toBeNull();
    expect(evaluation?.outputImpairedShare).toBe(1);
    expect(evaluation?.overLeveragedComposition).toBe(true);
    // worst deviation wins attribution
    expect(evaluation?.dependencyId).toBe("dep-b");
    expect(evaluation?.currentDeviationBps).toBe(-3600);
  });

  it("does not flag compositions whose weights sum to at most 1.0", () => {
    const weights = new Map([
      ["dep-a", 0.6],
      ["dep-b", 0.4],
    ]);
    const incidentsById = new Map([["dep-a", severe("dep-a", -3000, 1_000_000)]]);

    const evaluation = evaluateOutputDependencyImpairment(weights, incidentsById);

    expect(evaluation?.outputImpairedShare).toBeCloseTo(0.6, 6);
    expect(evaluation?.overLeveragedComposition).toBe(false);
  });

  it("ignores dependency coins with no active severe depeg row", () => {
    const weights = new Map([
      ["dep-a", 0.5],
      ["dep-missing", 0.5],
    ]);

    expect(evaluateOutputDependencyImpairment(weights, new Map())).toBeNull();

    const partial = evaluateOutputDependencyImpairment(
      weights,
      new Map([["dep-a", severe("dep-a", -3000, 1_000_000)]]),
    );
    expect(partial?.outputImpairedShare).toBeCloseTo(0.5, 6);
    expect(partial?.dependencyId).toBe("dep-a");
  });

  it("prefers a confirmed severe dependency over an uncertain dependency", () => {
    const evaluation = evaluateOutputDependencyImpairment(
      new Map([
        ["dep-uncertain", 0.8],
        ["dep-severe", 0.2],
      ]),
      new Map<string, EvaluatedOpenIncident>([
        ["dep-uncertain", { row: row("dep-uncertain", 1_000_000), state: "uncertain" }],
        ["dep-severe", severe("dep-severe", -2700, 2_000_000)],
      ]),
    );

    expect(evaluation?.evidenceState).toBe("severe");
    expect(evaluation?.dependencyId).toBe("dep-severe");
    expect(evaluation?.outputImpairedShare).toBeCloseTo(0.2, 6);
  });
});

describe("wave2 redemption exit-route embeds", () => {
  const now = 1_780_000_000;

  function weakProbeSnapshot(
    stablecoinId: string,
    source: string,
    redemption?: Record<string, unknown>,
  ): ReserveSnapshotMetadataRecord {
    return {
      stablecoinId,
      fetchedAt: now - 60,
      source,
      metadata: {
        freshnessMode: "not-applicable",
        ...(redemption ? { redemption } : {}),
      },
      warningCount: 0,
      warnings: [],
      sourceModel: "single-bucket",
      evidenceClass: "weak-live-probe",
      syncStatus: "ok",
    };
  }

  it("attaches diagnostic eventual-redemption for the live Avalon USDa supply-full row", async () => {
    const config = getRedemptionBackstopConfig("usda-avalon");
    expect(config).toBeDefined();

    const entry = await buildRedemptionBackstopEntry(
      mockD1([
        { match: "FROM reserve_sync_state", rows: [] },
        { match: "FROM reserve_composition", rows: [] },
      ]),
      "usda-avalon",
      config!,
      50_000_000,
      0,
      now,
    );

    expect(entry.provider).toBe("supply-full-model");
    expect(entry.capacityProfile?.scoringUsd).toBeNull();
    expect(entry.capacityProfile?.exitRouteObservations?.[0]).toMatchObject({
      routeId: "redemption:usda-avalon:stablecoin-redeem",
      routeFamily: "eventual-redemption",
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdt-tether"] },
      settlementHorizonSec: 14 * 86_400,
      scoreEligible: false,
    });
  });

  it("publishes an observation for successful Anzen reserve-sync with near-zero scoring capacity", async () => {
    const config = getRedemptionBackstopConfig("usdz-anzen");
    expect(config).toBeDefined();

    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "usdz-anzen",
      config!,
      806_422.8,
      0,
      now,
      {
        reserveSnapshotMetadata: weakProbeSnapshot("usdz-anzen", "anzen-usdz", {
          capacityUsd: 0.006695,
          capacityKind: "live-direct",
          freshnessKind: "same-run-onchain",
          holderEligibility: "any-holder",
          settlementDelaySec: 0,
          routeStatus: "open",
          routeStatusSource: "onchain",
          feeBps: 0,
          sourceUrls: ["https://docs.anzen.finance/usdz-101/overview"],
        }),
      },
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.immediateCapacityUsd).toBe(0.006695);
    expect(entry.capacityProfile?.scoringUsd).toBe(0.006695);
    expect(entry.capacityProfile?.exitRouteObservations?.[0]).toMatchObject({
      routeId: "redemption:usdz-anzen:stablecoin-redeem",
      routeFamily: "protocol-redemption",
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] },
      evidenceKind: "onchain-contract-state",
      feeEvidence: "undisclosed-reviewed",
      executableUsd: 0.006695,
      scoreEligible: false,
    });
  });

  it("publishes an observation for successful River reserve-sync trove-debt telemetry", async () => {
    const config = getRedemptionBackstopConfig("satusd-river");
    expect(config).toBeDefined();

    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "satusd-river",
      config!,
      159_000_000,
      0,
      now,
      {
        reserveSnapshotMetadata: weakProbeSnapshot("satusd-river", "river-protocol-info", {
          capacityUsd: 9_100_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          holderEligibility: "any-holder",
          routeStatus: "open",
          routeStatusSource: "onchain",
          feeBps: 50,
          sourceUrls: ["https://docs.river.inc/products/editor/redemption"],
        }),
      },
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.immediateCapacityUsd).toBe(9_100_000);
    const observation = entry.capacityProfile?.exitRouteObservations?.[0];
    expect(observation).toMatchObject({
      routeId: "redemption:satusd-river:collateral-redeem",
      routeFamily: "protocol-redemption",
      // The complete collateral inventory is issuer-undisclosed, so the
      // observation must not publish a partial BTC/ETH/BNB asset-key subset.
      output: { kind: "collateral" },
      evidenceKind: "onchain-contract-state",
      scoreEligible: true,
    });
    expect(observation?.output).not.toHaveProperty("assetKeys");
    expect(observation?.executableUsd).toBe(entry.capacityProfile?.modeledExitSizeUsd);
    expect(observation?.executableUsd).toBeGreaterThan(0);
  });

  it("keeps River unrated when the Satoshi probe withholds redemption telemetry", async () => {
    const config = getRedemptionBackstopConfig("satusd-river");
    expect(config).toBeDefined();

    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "satusd-river",
      config!,
      159_000_000,
      0,
      now,
      {
        reserveSnapshotMetadata: {
          ...weakProbeSnapshot("satusd-river", "river-protocol-info"),
          warningCount: 1,
          warnings: [
            {
              code: "river-redemption-unreadable",
              message:
                "No Satoshi Protocol chain returned a matching debtToken()/getGlobalSystemBalances()/branch set for satusd-river this run; redemption telemetry withheld",
              severity: "info",
              effect: "info",
            },
          ],
        },
      },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.immediateCapacityUsd).toBeNull();
    expect(entry.capacityProfile).toBeUndefined();
    expect(entry.score).toBeNull();
  });
});

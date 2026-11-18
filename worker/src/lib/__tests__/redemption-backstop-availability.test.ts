import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { mockD1Strict } from "@shared/test-utils/mock-d1";
import {
  buildRedemptionCurrentDepegObservationMap,
  evaluateOutputDependencyImpairment,
  loadSevereActiveDepegAvailabilityMap,
  resolveOutputDependencyWeights,
  type ActiveDepegAvailabilityRow,
  type EvaluatedOpenIncident,
} from "../redemption-backstop/availability";
import { buildRedemptionBackstopEntry } from "../redemption-backstop/sources";
import type { ReserveSnapshotMetadataRecord } from "../live-reserves/store";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { defineReviewedStablecoinRedeemConfig } from "@shared/lib/redemption-backstop-configs/stablecoin-redeem/shared";
import { LiveReserveRedemptionOutputValuationSchema } from "@shared/types/live-reserves";
import { liveSnapshot } from "./redemption-backstop-sources.test-support";
import { admittedDeviationBps, evaluateReferenceAdmission } from "@shared/lib/reference-admission";
import { asRawDeviationBps } from "@shared/types/reference-admission";
import { REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS } from "@shared/lib/report-card-active-depeg";

const REVIEW_DATE = "2026-04-22";
const ACTIVE_DEPEG_AVAILABILITY_SQL = `SELECT stablecoin_id, direction, started_at
  FROM depeg_events
  WHERE ended_at IS NULL
    AND source = 'live'`;

function activeDepegQuery(rows: Record<string, unknown>[]) {
  return { match: ACTIVE_DEPEG_AVAILABILITY_SQL, rows };
}

function observations(entries: Array<[string, number]>) {
  return new Map(entries.map(([id, currentDeviationBps]) => [id, { currentDeviationBps }]));
}

describe("buildRedemptionCurrentDepegObservationMap", () => {
  const now = 1_788_220_800;

  function authoritativeAsset(observedAt: number, id = "usdc-circle") {
    return makeAsset({
      id,
      symbol: id === "usda-avalon" ? "USDa" : "USDC",
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

    expect(result.get("usdc-circle")?.currentDeviationBps).toBeCloseTo(-3000, 10);
  });

  it("uses the published non-USD deviation until the producer supplies admission evidence", () => {
    const id = "eurc-circle";
    const currentPeg = { currentDeviationBps: -60, pegReference: null, pegReferenceUnavailable: false,
      currentPriceUnavailable: false, primaryTrust: "authoritative" as const, dexPriceCheck: null };
    const asset = { ...authoritativeAsset(now, id), pegType: "peggedEUR", currentPeg };
    const read = (row: typeof asset) => buildRedemptionCurrentDepegObservationMap({
      peggedAssets: [row], stablecoinsGenerationAt: now, now,
    }).get(id);
    expect(read(asset)?.currentDeviationBps).toBe(-60);
    const withheld = { ...asset, currentPeg: { ...currentPeg, admittedDeviationBps: null } };
    expect(read(withheld)).toBeUndefined();
  });

  it.each([
    ["2026-11-16T16:00:00Z", -REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS + 0.1, undefined],
    ["2026-11-16T16:00:00Z", -REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS, "degraded"],
    ["2026-11-14T16:00:00Z", -REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS + 0.1, "unknown"],
  ] as const)("applies the XAUT raw downside projection to both XAUT and XGLD at %s (%s bps)", async (date, bps, expected) => {
    const id = "xaut-tether";
    const assessed = Date.parse(date) / 1000;
    const observed = assessed - 60;
    const raw = asRawDeviationBps(bps);
    const admission = evaluateReferenceAdmission({ kind: "fallback", decisionAtSec: assessed, quoteObservedAtSec: observed,
      generation: `stablecoins:${observed}`, rawDeviationBps: raw, preCloseUsdPerUnit: 2_900, observation: {
        pegKey: "peggedGOLD", usdPerUnit: 3_000, source: "gold-api.com", cadence: "intraday", observedAtSec: observed,
      } });
    const asset = { ...authoritativeAsset(observed, id), symbol: "XAUT", pegType: "peggedGOLD", price: 3_000 * (1 + bps / 10_000),
      currentPeg: { currentDeviationBps: Math.round(bps), admittedDeviationBps: admittedDeviationBps(raw, admission),
        referenceAdmission: admission, pegReference: { valueUsd: 3_000, source: "fallback" as const, contributorCount: 0, asOf: observed },
        pegReferenceUnavailable: false, currentPriceUnavailable: false, primaryTrust: "authoritative" as const, dexPriceCheck: null } };
    const readings = (row: typeof asset) => buildRedemptionCurrentDepegObservationMap({
      peggedAssets: [row], stablecoinsGenerationAt: observed, now: assessed,
    });
    const admitted = readings(asset);
    expect(admission.status).toBe(expected === "unknown" ? "held-closed-session" : "admitted");
    expect(admitted.get(id)?.currentDeviationBps).toBe(expected === "unknown" ? undefined : bps);
    expect(readings({ ...asset, priceObservedAt: observed - 1 }).has(id)).toBe(false);
    const db = mockD1Strict([activeDepegQuery([{ stablecoin_id: id, direction: "below", started_at: observed }])]);
    const availability = await loadSevereActiveDepegAvailabilityMap(db, REVIEW_DATE, admitted);
    expect(availability.get(id)?.routeStatus).toBe(expected);
    expect(availability.get("xgld-unitas")?.routeStatus).toBe(expected);
  });

  it("keeps an open EURC incident uncertain when a Friday admission crosses the FX close", async () => {
    const observed = Date.parse("2026-11-13T21:59:00Z") / 1000;
    const admission = evaluateReferenceAdmission({ kind: "fx", decisionAtSec: observed, quoteObservedAtSec: observed,
      rawDeviationBps: asRawDeviationBps(-300), preCloseUsdPerUnit: 1.09, observation: {
        pegKey: "peggedEUR", usdPerUnit: 1.1, source: "openExchangeRates", cadence: "intraday", observedAtSec: observed,
      } });
    expect(admission.status).toBe("admitted");
    const id = "eurc-circle";
    const asset = { ...authoritativeAsset(observed, id), price: 1.067, pegType: "peggedEUR", currentPeg: {
      currentDeviationBps: -300, admittedDeviationBps: -300, referenceAdmission: admission,
      pegReference: { valueUsd: 1.1, source: "fx" as const, contributorCount: 0, asOf: observed },
      pegReferenceUnavailable: false, currentPriceUnavailable: false, primaryTrust: "authoritative" as const, dexPriceCheck: null } };
    const readings = (now: number) => buildRedemptionCurrentDepegObservationMap({ peggedAssets: [asset], stablecoinsGenerationAt: observed, now });
    expect(readings(observed).get(id)?.currentDeviationBps).toBe(-300);
    const legacy = buildRedemptionCurrentDepegObservationMap({ peggedAssets: [{ ...asset, currentPeg: undefined }],
      fxFallbackRates: { peggedEUR: 1.1 }, stablecoinsGenerationAt: observed, now: observed });
    expect(legacy.get(id)?.currentDeviationBps).toBe(-300);
    const db = mockD1Strict([activeDepegQuery([{ stablecoin_id: id, direction: "below", started_at: observed }])]);
    const availability = await loadSevereActiveDepegAvailabilityMap(db, REVIEW_DATE, readings(observed + 120));
    expect(availability.get(id)?.routeStatus).toBe("unknown");
  });

  it("excludes a frozen stablecoin from the current deviation map", () => {
    const result = buildRedemptionCurrentDepegObservationMap({
      peggedAssets: [authoritativeAsset(now - 60, "usda-avalon")],
      stablecoinsGenerationAt: now - 60,
      now,
    });

    expect(result.has("usda-avalon")).toBe(false);
  });

  it("rejects a fresh generation whose underlying quote is stale", () => {
    const result = buildRedemptionCurrentDepegObservationMap({
      peggedAssets: [authoritativeAsset(now - 1801)],
      stablecoinsGenerationAt: now - 60,
      now,
    });

    expect(result.has("usdc-circle")).toBe(false);
  });
});

describe("loadSevereActiveDepegAvailabilityMap", () => {
  it("inherits parent severe depeg into tracked wrapper route status", async () => {
    const parentStartedAt = Math.floor(Date.UTC(2026, 3, 20) / 1000);
    const db = mockD1Strict([
      activeDepegQuery([
        {
          stablecoin_id: "usds-sky",
          peak_deviation_bps: -3100,
          direction: "below",
          started_at: parentStartedAt,
        },
      ]),
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

  it("withholds direct and dependent redemption when a USD projection is explicitly unavailable", async () => {
    const quoteAt = Date.parse("2026-11-14T15:00:00Z") / 1000;
    const currentPeg = { pegReference: null, pegReferenceUnavailable: false, currentPriceUnavailable: false,
      currentDeviationBps: -3100, primaryTrust: "authoritative", dexPriceCheck: null,
      admittedDeviationBps: null } as const;
    const current = buildRedemptionCurrentDepegObservationMap({
      peggedAssets: [makeAsset({ id: "usds-sky", symbol: "USDS", price: 0.69, priceSource: "pyth",
        priceConfidence: "single-source", agreeSources: ["pyth"], priceObservedAt: quoteAt, currentPeg })],
      stablecoinsGenerationAt: quoteAt, now: quoteAt,
    });
    const db = mockD1Strict([activeDepegQuery([{ stablecoin_id: "usds-sky", direction: "below", started_at: quoteAt - 1 }])]);
    const result = await loadSevereActiveDepegAvailabilityMap(db, REVIEW_DATE, current);
    expect(current.has("usds-sky")).toBe(false);
    expect(result.get("usds-sky")).toMatchObject({ routeStatus: "unknown", routeStatusSource: "market-implied" });
    expect(result.get("susds-sky")).toMatchObject({ routeStatus: "unknown", outputImpairedDependencyId: "usds-sky" });
    expect(result.get("susds-sky")).not.toHaveProperty("activeDepegBps");
  });

  it("does not propagate a sub-severe parent depeg to wrappers", async () => {
    const db = mockD1Strict([
      activeDepegQuery([
        {
          stablecoin_id: "usds-sky",
          peak_deviation_bps: -1200,
          direction: "below",
          started_at: Math.floor(Date.now() / 1000),
        },
      ]),
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
    const db = mockD1Strict([
      activeDepegQuery([
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
      ]),
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
    const db = mockD1Strict([
      activeDepegQuery([
        {
          stablecoin_id: "usds-sky",
          peak_deviation_bps: 3100,
          direction: "above",
          started_at: 1_000_000,
        },
      ]),
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
    const db = mockD1Strict([
      activeDepegQuery([
        {
          stablecoin_id: "usds-sky",
          peak_deviation_bps: -3100,
          started_at: 1_000_000,
        },
      ]),
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(
      db,
      REVIEW_DATE,
      observations([["usds-sky", -3100]]),
    );

    expect(result.has("usds-sky")).toBe(false);
  });

  it("does not treat a reserve-only asset as a reviewed payout dependency", async () => {
    const db = mockD1Strict([
      activeDepegQuery([
        {
          stablecoin_id: "ausd-agora",
          peak_deviation_bps: -3600,
          direction: "below",
          started_at: 2_000_000,
        },
      ]),
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(
      db,
      REVIEW_DATE,
      observations([["ausd-agora", -3600]]),
    );
    expect(result.has("cusd-celo")).toBe(false);
  });

  it("retains impaired basket identity without inventing reserve or equal payout shares", async () => {
    const db = mockD1Strict([
      activeDepegQuery([
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
      ]),
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
    expect(cusd).not.toHaveProperty("outputImpairedShare");
    expect(cusd?.routeStatusReason).toContain("share is unquantified");
    expect(cusd?.routeStatusReason).not.toContain("over-leveraged");
  });

  it("ignores severe depegs of coins that are no configured route's output dependency", async () => {
    const db = mockD1Strict([
      activeDepegQuery([
        {
          stablecoin_id: "not-a-tracked-dependency",
          peak_deviation_bps: -4000,
          direction: "below",
          started_at: 1_000_000,
        },
      ]),
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(
      db,
      REVIEW_DATE,
      observations([["not-a-tracked-dependency", -4000]]),
    );

    expect(result.get("not-a-tracked-dependency")?.routeStatus).toBe("degraded");
    expect(result.size).toBe(1);
  });

  it("does not mistake a sole backing asset for the full reviewed basket payout", async () => {
    const db = mockD1Strict([
      activeDepegQuery([
        {
          stablecoin_id: "usde-ethena",
          peak_deviation_bps: -2800,
          direction: "below",
          started_at: 3_000_000,
        },
      ]),
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(
      db,
      REVIEW_DATE,
      observations([["usde-ethena", -2800]]),
    );
    const honey = result.get("honey-berachain");
    expect(honey?.routeStatus).toBe("degraded");
    expect(honey?.outputImpairedDependencyId).toBe("usde-ethena");
    expect(honey).not.toHaveProperty("outputImpairedShare");
    expect(honey?.routeStatusReason).toContain("share is unquantified");
  });

  it.each(["fresh", "stale", "future", "mismatched", "rejected"] as const)(
    "quantifies only the admitted complete current payout basket (%s)", async (state) => {
      const now = 1_780_000_000;
      const db = mockD1Strict([activeDepegQuery([{
        stablecoin_id: "usdc-circle", direction: "below", started_at: now - 3600,
      }])]);
      const snapshot = liveSnapshot("cusd-cap", {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 30_000_000, capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain", routeStatus: "open", routeStatusSource: "onchain",
          outputValuation: {
            sourceId: "cap-vault:chainlink-nav", unitValueUsd: 0.99,
            observedAt: state === "stale" ? now - 1801 : state === "future" ? now + 1 : now - 120,
            basketWeights: [
              { assetId: "usdc-circle", weight: 0.93 },
              { assetId: state === "mismatched" ? "usdt-tether" : "wtgxx-wisdomtree", weight: 0.07 },
            ],
          },
        },
      }, { fetchedAt: now - 60, ...(state === "rejected" ? { admission: {
        eligible: false, reasons: ["config-mismatch"], freshness: null,
      } } : {}) });
      const result = await loadSevereActiveDepegAvailabilityMap(db, REVIEW_DATE,
        observations([["usdc-circle", -3000]]),
        { metadataById: new Map([["cusd-cap", snapshot]]), now });
      expect(result.get("cusd-cap")).toMatchObject({
        routeStatus: "degraded", outputImpairedDependencyId: "usdc-circle",
      });
      if (state === "fresh") expect(result.get("cusd-cap")?.outputImpairedShare).toBe(0.93);
      else {
        expect(result.get("cusd-cap")).not.toHaveProperty("outputImpairedShare");
        expect(result.get("cusd-cap")?.routeStatusReason).toContain("share is unquantified");
      }
      expect(result.get("gusd-gate")?.outputImpairedShare).toBe(1);
      expect(result.has("usdn-noble")).toBe(false);
    },
  );

  it("attributes RISE impairment to its direct wM payout, not downstream USDC", async () => {
    const now = 1_780_000_000;
    const db = mockD1Strict([activeDepegQuery([{
      stablecoin_id: "wm-m0", direction: "below", started_at: now - 3600,
    }])]);
    const result = await loadSevereActiveDepegAvailabilityMap(db, REVIEW_DATE,
      observations([["wm-m0", -3000]]), { metadataById: new Map(), now });
    expect(result.get("usdr-rise")).toMatchObject({
      routeStatus: "degraded", outputImpairedDependencyId: "wm-m0", outputImpairedShare: 1,
    });
  });

  it("publishes unknown from stale evidence and never mutates the incident", async () => {
    const db = mockD1Strict([
      activeDepegQuery([
        {
          stablecoin_id: "usda-avalon",
          direction: "below",
          started_at: 1_765_756_800,
        },
      ]),
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

describe("reviewed payout dependency weights", () => {
  const meta = {
    id: "test-payout", variantOf: "usde-ethena",
    reserves: [{ name: "USDC", pct: 12, risk: "low" as const, coinId: "usdc-circle" }],
  };
  const singleConfig = getRedemptionBackstopConfig("dai-makerdao")!;
  const incident: EvaluatedOpenIncident = {
    row: { stablecoin_id: "usdc-circle", direction: "below", started_at: 2_000_000 },
    state: "severe", currentDeviationBps: -3000,
  };
  const incidents = new Map([["usdc-circle", incident]]);

  it.each([{ reserves: meta.reserves }, { reserves: [] }])("uses the selected single output at 100%% independently of reserves (%j)", ({ reserves }) => {
    const resolved = resolveOutputDependencyWeights({ ...meta, reserves }, singleConfig);
    expect([...resolved.weights]).toEqual([["usdc-circle", 1]]);
    expect(resolved.reserveDerived).toBe(false);
    expect(evaluateOutputDependencyImpairment(resolved.weights, incidents)).toMatchObject({
      dependencyId: "usdc-circle", outputImpairedShare: 1,
    });
  });

  it.each([null, "complete", "mismatched"] as const)("uses only complete admitted basket payout weights (%s)", (caseName) => {
    const basketConfig = {
      ...singleConfig, outputAssetType: "stable-basket" as const,
      outputAssets: ["usdc-circle", "usdt-tether"],
    };
    const valuation = caseName === null ? null : LiveReserveRedemptionOutputValuationSchema.parse({
      sourceId: "reviewed-payout", observedAt: 2_000_000, unitValueUsd: 0.99,
      basketWeights: [
        { assetId: "usdc-circle", weight: 0.8 },
        { assetId: caseName === "complete" ? "usdt-tether" : "usde-ethena", weight: 0.2 },
      ],
    });
    const resolved = resolveOutputDependencyWeights(meta, basketConfig, valuation);
    const evaluation = evaluateOutputDependencyImpairment(resolved.weights, incidents);
    expect(evaluation?.dependencyId).toBe("usdc-circle");
    if (caseName === "complete") expect(evaluation?.outputImpairedShare).toBe(0.8);
    else expect(evaluation).not.toHaveProperty("outputImpairedShare");
  });

  it("retains parent and backing fallback only when no payout identity was reviewed", () => {
    const config = { ...singleConfig, outputAssets: undefined };
    expect([...resolveOutputDependencyWeights(meta, config).weights]).toEqual([["usde-ethena", 1]]);
    expect([...resolveOutputDependencyWeights({ ...meta, variantOf: undefined }, config).weights])
      .toEqual([["usdc-circle", 0.12]]);
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

  it("attaches diagnostic eventual-redemption for a reviewed supply-full route with a bounded settlement horizon", async () => {
    const config = defineReviewedStablecoinRedeemConfig("2026-04-22", {
      outputAssets: ["usdt-tether"], settlementModel: "days", executionModel: "rules-based-nav",
      docs: [{ label: "Fixture redemption", url: "https://example.com/redemption", supports: ["route", "capacity", "settlement", "fees", "access"] }],
      v9RouteReviewTerms: {
        settlementDelaySec: 14 * 86_400, reviewedAt: "2026-04-22",
        docs: [{ label: "Fixture settlement", url: "https://example.com/settlement", supports: ["settlement"] }],
      },
    });

    const entry = await buildRedemptionBackstopEntry(
      mockD1Strict([
        {
          match:
            "SELECT stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_success_at, last_status, warning_count, warnings, last_error, metadata, last_attempt_id, pending_attempt_id, last_success_attempt_id, config_fingerprint FROM reserve_sync_state WHERE stablecoin_id IN (?)",
          matchBinds: ["usda-avalon"],
          rows: [],
        },
        {
          match:
            "SELECT stablecoin_id, slices, fetched_at, source, attempt_id, metadata, warning_count, warnings, adapter_source_model, adapter_evidence_class, config_fingerprint FROM reserve_composition WHERE stablecoin_id IN (?)",
          matchBinds: ["usda-avalon"],
          rows: [],
        },
      ]),
      "usda-avalon",
      config,
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

  it.each([
    { feeCase: "a measured zero fee", feeBps: 0 },
    { feeCase: "an unquantified formula fee", feeBps: undefined },
  ])("publishes an observation for successful Anzen reserve-sync with near-zero scoring capacity and $feeCase", async ({ feeBps }) => {
    const config = getRedemptionBackstopConfig("usdz-anzen");
    expect(config).toBeDefined();

    const entry = await buildRedemptionBackstopEntry(
      mockD1Strict([]),
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
          ...(feeBps !== undefined ? { feeBps } : {}),
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
      executableUsd: 0.006695,
      scoreEligible: feeBps !== undefined,
    });
    const observation = entry.capacityProfile?.exitRouteObservations?.[0];
    if (feeBps !== undefined) {
      expect(observation).not.toHaveProperty("feeEvidence");
    } else {
      expect(observation).toMatchObject({ feeEvidence: "disclosed-unquantified" });
    }
  });

  it("publishes an observation for successful River reserve-sync trove-debt telemetry", async () => {
    const config = getRedemptionBackstopConfig("satusd-river");
    expect(config).toBeDefined();

    const entry = await buildRedemptionBackstopEntry(
      mockD1Strict([]),
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
      output: { kind: "unresolved-asset" },
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
      mockD1Strict([]),
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

import { describe, expect, it } from "vitest";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "../api-query-descriptors";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { internV9PublicWitnessTexts } from "@shared/lib/safety-score-v9/public-witness-texts";
import { resolveSchemaLike } from "@shared/lib/schema-like";
import { makeFxCurrentPeg } from "@shared/test-utils/boundary-contract-vectors.test-support";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import {
  StabilityIndexLightResponseSchema,
  STABILITY_INDEX_QUERY_DESCRIPTOR,
} from "../api-query-domains/stability-light";
import { makeReportCardsV9Response } from "@/test/fixtures/safety-score-v9";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { getPollingWindow } from "../api-query-polling";
import { makeYieldProvenance, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { projectYieldRankingsSummary } from "@shared/lib/yield-rankings-summary";

describe("frontend API query descriptors", () => {
  it("retains admission evidence from both the stablecoins and peg-summary wire shapes", async () => {
    const currentPeg = makeFxCurrentPeg("stale-reference", null);
    const asset = { ...makeStablecoin({ id: "eurc-circle" }), currentPeg };
    const list = await resolveSchemaLike(FRONTEND_API_QUERY_DESCRIPTORS.stablecoins.schema);
    expect(list?.safeParse({ peggedAssets: [asset] })).toMatchObject({
      success: true, data: { peggedAssets: [{ currentPeg }] },
    });
    const summary = await resolveSchemaLike(FRONTEND_API_QUERY_DESCRIPTORS.pegSummary.schema);
    const coin = { ...makePegSummaryCoin({ id: asset.id }), ...currentPeg };
    expect(summary?.safeParse({ coins: [coin], summary: null, methodology: {
      version: "1.0", versionLabel: "v1.0", currentVersion: "1.0", currentVersionLabel: "v1.0",
      changelogPath: "/methodology/", asOf: 1_795_000_000, isCurrent: true,
    } })).toMatchObject({
      success: true, data: { coins: [{ referenceAdmission: currentPeg.referenceAdmission, admittedDeviationBps: null }] },
    });
  });

  it("keeps valid weekly archive dates and drops malformed coverage fields without dropping the edition", async () => {
    const schema = await resolveSchemaLike(FRONTEND_API_QUERY_DESCRIPTORS.digestArchive.schema);
    const entry = {
      digestType: "weekly", digestText: "Recap", digestTitle: null, digestExtended: null,
      generatedAt: 1_788_120_000, psiScore: null, psiBand: null, totalMcapUsd: null,
    };
    expect(schema?.safeParse({ digests: [
      { ...entry, weekStart: "2026-08-25", weekEnd: "2026-08-30" },
      { ...entry, weekStart: "2026-02-30", weekEnd: "2026-08-30" },
    ] })).toMatchObject({ success: true, data: { digests: [
      { weekStart: "2026-08-25", weekEnd: "2026-08-30" },
      { weekStart: undefined, weekEnd: "2026-08-30" },
    ] } });
  });

  it("keeps the chart-only history transport separate from full history cache identity", () => {
    const descriptor = FRONTEND_API_QUERY_DESCRIPTORS.dexLiquidityHistory("usdt-tether", 90);
    expect(descriptor.path).toBe("/api/dex-liquidity-chart-history?stablecoin=usdt-tether&days=90");
    expect(descriptor.queryKey).toEqual(["dex-liquidity-chart-history", "usdt-tether", 90]);
    expect(descriptor.producerIntervalMs).toBe(CRON_INTERVALS["sync-dex-liquidity"] * 1000);
  });

  it("separates bounded PSI startup from full-history expansion without changing producer polling", () => {
    const initial = FRONTEND_API_QUERY_DESCRIPTORS.stabilityIndexDetail;
    const full = FRONTEND_API_QUERY_DESCRIPTORS.stabilityIndexFullHistory;
    expect(initial.path).toBe("/api/stability-index?detail=true&days=365");
    expect(full.path).toBe("/api/stability-index?detail=true");
    expect(initial.queryKey).not.toEqual(full.queryKey);
    for (const descriptor of [initial, full]) {
      expect(descriptor.producerIntervalMs).toBe(CRON_INTERVALS["stability-index"] * 1000);
    }
  });

  it.each([
    ["depegResolver", "compute-depeg-resolver"],
    ["depegResolverReview", "compute-depeg-resolver"],
    ["redemptionBackstops", "sync-redemption-backstops"],
  ] as const)("binds %s polling to its own producer %s", (key, producer) => {
    const interval = CRON_INTERVALS[producer] * 1000;
    const descriptor = FRONTEND_API_QUERY_DESCRIPTORS[key];
    expect(descriptor.producerIntervalMs).toBe(interval);
    expect(getPollingWindow(descriptor.producerIntervalMs)).toEqual({
      staleTime: interval,
      refetchInterval: 2 * interval,
    });
  });

  it("anchors lagged-provider USD and native checkpoints to the current canonical observation", () => {
    const now = 1_790_793_000;
    const day = 86_400;
    const summary = projectStablecoinLiveSummary({
      price: 1, priceSource: "coingecko", priceConfidence: "high",
      currentCirculatingUSD: { peggedUSD: 200 }, currentCirculatingNative: 200, currentSupplyObservedAt: now,
      tokens: [
        { date: now - 33 * day, totalCirculatingUSD: { peggedUSD: 50 }, totalCirculating: { peggedUSD: 50 } },
        { date: now - 30 * day, totalCirculatingUSD: { peggedUSD: 80 }, totalCirculating: { peggedUSD: 80 } },
        { date: now - 10 * day, totalCirculatingUSD: { peggedUSD: 100 }, totalCirculating: { peggedUSD: 100 } },
        { date: now - 7 * day, totalCirculatingUSD: { peggedUSD: 140 }, totalCirculating: { peggedUSD: 140 } },
        { date: now - 3 * day, totalCirculatingUSD: { peggedUSD: 160 }, totalCirculating: { peggedUSD: 160 } },
      ],
    });
    expect(summary.circulatingPrevWeek).toEqual({ peggedUSD: 140 });
    expect(summary.circulatingPrevMonth).toEqual({ peggedUSD: 80 });
    expect(summary.nativeSupply).toEqual({ current: 200, prevWeek: 140, prevMonth: 80 });
  });

  it.each([null, undefined])("preserves the compact detail quote clock (%s) and a present empty baseline map", (priceObservedAt) => {
    const priceUpdatedAt = 1_800_000_000;
    const summary = projectStablecoinLiveSummary({
      price: 3_000, priceSource: "coingecko", priceObservedAt, priceUpdatedAt,
      supplyChangeBaselines: {},
      currentCirculatingNative: null,
      tokens: [{ date: priceUpdatedAt, totalCirculating: { peggedGOLD: 100 } }],
    }, "paxg-paxos");
    expect(summary).toMatchObject({
      priceObservedAt: priceObservedAt === undefined ? priceUpdatedAt : null,
      priceUpdatedAt, supplyChangeBaselines: {}, nativeSupply: { current: null },
    });
  });

  it.each([null, 1_790_793_000])("withholds unmatched canonical-clock checkpoints rather than extending the window (%s)", (clock) => {
    const now = 1_790_793_000;
    const day = 86_400;
    const summary = projectStablecoinLiveSummary({
      price: 1, priceSource: "coingecko",
      currentCirculatingUSD: { peggedUSD: 200 }, ...(clock != null ? { currentSupplyObservedAt: clock } : {}),
      tokens: [
        { date: now - 33 * day, totalCirculatingUSD: { peggedUSD: 50 }, totalCirculating: { peggedUSD: 50 } },
        { date: now - 10 * day, totalCirculatingUSD: { peggedUSD: 100 }, totalCirculating: { peggedUSD: 100 } },
        { date: now - 3 * day, totalCirculatingUSD: { peggedUSD: 160 }, totalCirculating: { peggedUSD: 160 } },
      ],
    });
    expect(summary.circulatingPrevWeek).toEqual({});
    expect(summary.circulatingPrevMonth).toEqual({});
    expect(summary.nativeSupply).toEqual({ current: 200, prevWeek: null, prevMonth: null });
  });
  it("prefers current admitted USD supply over a new listing's native-only history", () => {
    const summary = projectStablecoinLiveSummary({
      price: 0.99985, priceSource: "coingecko", priceConfidence: "single-source",
      currentCirculatingUSD: { peggedUSD: 477_309_888.38 },
      currentCirculatingPrevDayUSD: {}, currentSupplyObservedAt: 1_790_793_000,
      tokens: [{ date: 1_790_726_400, totalCirculating: { peggedUSD: 454_459_687.73 } }],
    });
    expect(summary.circulating).toEqual({ peggedUSD: 477_309_888.38 });
    expect(summary.circulatingPrevDay).toEqual({});
    expect(summary.supplyObservedAt).toBe(1_790_793_000);
    expect(summary.nativeSupply).toEqual({ current: 477_309_888.38 / 0.99985, prevWeek: null, prevMonth: null });
  });

  it("retains restored supply provenance through the registered response schema", async () => {
    const descriptor = FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary("usdt-tether");
    const schema = await resolveSchemaLike(descriptor.schema);
    expect(schema).toBeDefined();
    if (!schema) throw new Error("Expected the registered live summary response schema");
    const parsed = schema.safeParse(projectStablecoinLiveSummary({
      currentCirculatingUSD: { peggedUSD: 100 }, currentSupplyObservedAt: 1_790_793_000,
      currentSupplyRestored: true,
    }));
    if (!parsed.success) throw new Error("Expected a restored live summary");
    const summary = parsed.data;
    expect(summary.supplyRestored).toBe(true);
    expect(summary.supplyObservedAt).toBe(1_790_793_000);
    expect(summary.circulating).toEqual({ peggedUSD: 100 });
    expect(descriptor.path).toBe("/api/stablecoin-live-summary/usdt-tether");
    expect(descriptor.queryKey).toEqual(["stablecoin-live-summary", "usdt-tether"]);
    expect(schema.safeParse({ tokens: [] }).success).toBe(false);
  });

  it.each([false, undefined])("does not mark fresh or legacy current supply restored (%s)", (restored) => {
    const summary = projectStablecoinLiveSummary({
      currentCirculatingUSD: { peggedUSD: 100 }, currentSupplyRestored: restored,
    });
    expect(summary.supplyRestored).not.toBe(true);
  });

  it("keeps an explicitly unavailable current overlay from restoring provider history", () => {
    const summary = projectStablecoinLiveSummary({
      currentCirculatingUSD: {}, currentSupplyRestored: true,
      tokens: [{ date: 1_790_726_400, totalCirculatingUSD: { peggedUSD: 100 } }],
    });
    expect(summary.circulating).toEqual({});
    expect(summary.supplyObservedAt).toBeNull();
    expect(summary.nativeSupply.current).toBeNull();
  });

  it.each([null, 0, -1])("does not value missing USD buckets at an unavailable price %s", (price) => {
    const summary = projectStablecoinLiveSummary({
      price, priceSource: "coingecko",
      tokens: [{ date: 1_790_726_400, totalCirculating: { peggedUSD: 100 } }],
    });
    expect(summary.circulating).toEqual({});
  });

  it("falls back to native supply valued only at a finite positive observed price", () => {
    const summary = projectStablecoinLiveSummary({
      price: 2, priceSource: "coingecko", priceConfidence: "high",
      tokens: [{ date: 1_790_726_400, totalCirculating: { peggedEUR: 100 } }],
    });
    expect(summary.circulating).toEqual({ peggedEUR: 200 });
  });

  it("keeps explicit current zero ahead of older USD history", () => {
    const summary = projectStablecoinLiveSummary({
      currentCirculatingUSD: { peggedUSD: 0 },
      tokens: [{ date: 1_790_726_400, totalCirculatingUSD: { peggedUSD: 100 } }],
    });
    expect(summary.circulating).toEqual({ peggedUSD: 0 });
  });

  it("does not value native-only history at nominal par", () => {
    const summary = projectStablecoinLiveSummary({
      price: 1, priceSource: "protocol-par", priceObservedAtMode: "nominal_reference",
      tokens: [{ date: 1_790_726_400, totalCirculating: { peggedUSD: 100 } }],
    });
    expect(summary.circulating).toEqual({});
  });

  it("withholds nominal observations while retaining the separate reference", () => {
    const nominalPriceReference = { price: 1, source: "protocol-par", mode: "nominal_reference" as const };
    const summary = projectStablecoinLiveSummary({
      price: 1,
      priceSource: "protocol-par",
      priceConfidence: "high",
      priceObservedAtMode: "nominal_reference",
      priceUpdatedAt: 1_700_000_000,
      priceObservedAt: 1_700_000_000,
      priceSyncedAt: 1_700_000_000,
      consensusSources: ["coingecko"],
      agreeSources: ["coingecko"],
      nominalPriceReference,
    });
    expect(summary).toMatchObject({
      price: null,
      priceConfidence: null,
      priceUpdatedAt: null,
      priceObservedAt: null,
      priceSyncedAt: null,
      consensusSources: [],
      agreeSources: [],
      nominalPriceReference,
    });
    const legacy = projectStablecoinLiveSummary({ price: 1, priceSource: "protocol-redeem", priceConfidence: "high" });
    expect(legacy.price).toBe(1);
    expect(legacy.priceConfidence).toBe("high");
    expect(legacy).not.toHaveProperty("nominalPriceReference");
  });

  it("preserves canonical price provenance without copying provider history into the summary", () => {
    const provenance = {
      price: 0.9998,
      priceSource: "coingecko+binance",
      priceConfidence: "high" as const,
      priceUpdatedAt: 1_700_000_000,
      priceObservedAt: 1_699_999_990,
      priceObservedAtMode: "upstream" as const,
      priceSyncedAt: 1_700_000_005,
      consensusSources: ["coingecko", "binance"],
      agreeSources: ["coingecko", "binance"],
    };
    const summary = projectStablecoinLiveSummary({
      ...provenance,
      tokens: [{ date: 1_700_000_000, totalCirculatingUSD: { peggedUSD: 123 } }],
    });

    expect(summary).toMatchObject(provenance);
    expect(summary.circulating).toEqual({ peggedUSD: 123 });
    expect(summary).not.toHaveProperty("tokens");
  });

  it("leaves prev-period buckets unavailable when the history has no sample at or before the target", () => {
    const day = 86_400;
    const summary = projectStablecoinLiveSummary({
      price: 1,
      priceSource: "coingecko",
      priceConfidence: "high" as const,
      priceUpdatedAt: 1_700_000_000,
      tokens: [
        { date: 1_700_000_000, totalCirculatingUSD: { peggedUSD: 10 } },
        { date: 1_700_000_000 + 40 * day, totalCirculatingUSD: { peggedUSD: 90 } },
      ],
    });

    expect(summary.circulating).toEqual({ peggedUSD: 90 });
    expect(summary.circulatingPrevDay).toEqual({});
    expect(summary.circulatingPrevWeek).toEqual({});
    expect(summary.circulatingPrevMonth).toEqual({});
    expect(summary.nativeSupply).toEqual({ current: null, prevWeek: null, prevMonth: null });
  });

  it("uses the newest sample at or before each target instead of the nearest one", () => {
    const day = 86_400;
    const latest = 1_700_000_000;
    const summary = projectStablecoinLiveSummary({
      price: 1,
      priceSource: "coingecko",
      priceConfidence: "high" as const,
      priceUpdatedAt: latest,
      tokens: [
        { date: latest - 30 * day - 4 * 3600, totalCirculatingUSD: { peggedUSD: 30 }, totalCirculating: { peggedUSD: 300 } },
        { date: latest - 30 * day + 4 * 3600, totalCirculatingUSD: { peggedUSD: 31 }, totalCirculating: { peggedUSD: 310 } },
        { date: latest - 7 * day - 4 * 3600, totalCirculatingUSD: { peggedUSD: 70 }, totalCirculating: { peggedUSD: 700 } },
        { date: latest - 7 * day + 2 * 3600, totalCirculatingUSD: { peggedUSD: 71 }, totalCirculating: { peggedUSD: 710 } },
        { date: latest - day, totalCirculatingUSD: { peggedUSD: 99 } },
        { date: latest, totalCirculatingUSD: { peggedUSD: 100 }, totalCirculating: { peggedUSD: 1_000 } },
      ],
    });

    expect(summary.circulatingPrevDay).toEqual({ peggedUSD: 99 });
    expect(summary.circulatingPrevWeek).toEqual({ peggedUSD: 70 });
    expect(summary.circulatingPrevMonth).toEqual({ peggedUSD: 30 });
    expect(summary.nativeSupply).toEqual({ current: 1_000, prevWeek: 700, prevMonth: 300 });
  });

  it("never substitutes USD market cap for a missing native token-count anchor", () => {
    const day = 86_400;
    const latest = 1_700_000_000;
    const summary = projectStablecoinLiveSummary({
      price: 4_000,
      priceSource: "coingecko",
      priceConfidence: "high" as const,
      priceUpdatedAt: latest,
      tokens: [
        { date: latest - 30 * day, totalCirculatingUSD: { peggedGOLD: 3_200_000 }, totalCirculating: { peggedGOLD: 800 } },
        { date: latest - 7 * day, totalCirculatingUSD: { peggedGOLD: 3_300_000 } },
        { date: latest, totalCirculatingUSD: { peggedGOLD: 3_240_000 }, totalCirculating: { peggedGOLD: 810 } },
      ],
    });

    expect(summary.circulatingPrevWeek).toEqual({ peggedGOLD: 3_300_000 });
    expect(summary.nativeSupply).toEqual({ current: 810, prevWeek: null, prevMonth: 800 });
  });

  it("keeps the summary projection isolated from the detailed rankings cache", () => {
    expect(FRONTEND_API_QUERY_DESCRIPTORS.yieldRankings).toMatchObject({
      queryKey: ["yield-rankings"],
      path: "/api/yield-rankings",
    });
    expect(FRONTEND_API_QUERY_DESCRIPTORS.yieldRankingsSummary).toMatchObject({
      queryKey: ["yield-rankings", "summary"],
      path: "/api/yield-rankings?projection=summary",
    });
    expect(FRONTEND_API_QUERY_DESCRIPTORS.yieldRankingsSummary.queryKey).not.toEqual(
      FRONTEND_API_QUERY_DESCRIPTORS.yieldRankings.queryKey,
    );
  });

  it.each(["source-key", "explicit-warning"] as const)("qualifies mismatched xGLD yield in each Pages rankings decoder by %s", async (evidence) => {
    const xgld = makeYieldRanking({
      id: "xgld-unitas", currentApy: 6, excessYield: 2, pharosYieldScore: 25, benchmarkRate: 4,
      ...(evidence === "source-key"
        ? { provenance: makeYieldProvenance({ sourceKey: "onchain:xgld-unitas" }) }
        : { warningSignals: ["benchmark-unit-mismatch"] }),
    });
    const usd = makeYieldRanking();
    const full = { rankings: [xgld, usd], riskFreeRate: 4, scalingFactor: 8, medianApy: 5, updatedAt: 1_800_000_000 };
    const fullSchema = await resolveSchemaLike(FRONTEND_API_QUERY_DESCRIPTORS.yieldRankings.schema);
    const coinSchema = await resolveSchemaLike(FRONTEND_API_QUERY_DESCRIPTORS.yieldRankingsCoin(xgld.id).schema);
    const summarySchema = await resolveSchemaLike(FRONTEND_API_QUERY_DESCRIPTORS.yieldRankingsSummary.schema);
    const unscored = { currentApy: 6, pharosYieldScore: null, pysNullReason: "missing-inputs", benchmarkRate: undefined };
    expect(fullSchema?.safeParse(full)).toMatchObject({
      success: true, data: { rankings: [{ ...unscored, excessYield: null }, usd] },
    });
    expect(coinSchema?.safeParse({
      ...full, rankings: [xgld], projection: {
        stablecoinId: xgld.id, generationId: null, updatedAt: full.updatedAt, totalCount: 2, unavailableReason: null,
      },
    })).toMatchObject({ success: true, data: { rankings: [{ ...unscored, excessYield: null }] } });
    expect(summarySchema?.safeParse(projectYieldRankingsSummary(full))).toMatchObject({
      success: true, data: { rankings: [unscored, { pharosYieldScore: 50, benchmarkRate: 4.25 }] },
    });
  });

  it("opts full and detail readers into compact freshness without changing table requests", () => {
    expect(FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9.path).toBe("/api/report-cards/v9?freshness=operands");
    expect(FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9Detail("usdc-circle").path)
      .toBe("/api/report-cards/v9-detail?stablecoin=usdc-circle&freshness=operands&payout=assets");
    expect(FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9Table.path).toBe("/api/report-cards/v9-table");
  });

  it("accepts only report-v5 at the live V9 reader boundary", async () => {
    const schema = await resolveSchemaLike(FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9.schema);
    if (schema === undefined) throw new Error("Expected a V9 report-card response schema");
    const reportV5 = makeReportCardsV9Response();

    expect(schema.safeParse(reportV5).success).toBe(true);
    expect(schema.safeParse({ ...reportV5, schemaVersion: 4 }).success).toBe(false);
  });

  it("admits resolved witness text and rejects canonical card-local tables at the wire boundary", async () => {
    const schema = await resolveSchemaLike(FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9.schema);
    if (schema === undefined) throw new Error("Expected a V9 report-card response schema");
    const semantic = makeReportCardsV9Response();
    const card = semantic.cards[0]!;
    const reason = {
      code: "unresolved-control-identity" as const,
      message: "The independently scoped control incident review is unavailable.",
      path: "control:ethereum:reviewed:incidentState",
    };
    card.evidence.reasons = [reason];
    card.pillars.control.reasons = [reason];
    const wire = { ...semantic, cards: [internV9PublicWitnessTexts(card)] };
    expect(wire.cards[0]!.witnessTexts?.length).toBeGreaterThan(0);
    expect(schema.safeParse(wire).success).toBe(false);
    const parsed = schema.safeParse(semantic);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(semantic);
    semantic.cards[0]!.evidence.reasons[0]!.message = "~literal evidence";
    semantic.cards[0]!.pillars.control.reasons[0]!.message = "~literal evidence";
    expect(schema.safeParse(semantic).success).toBe(true);
  });

  it("validates only global PSI display fields and preserves the full payload", () => {
    const payload = {
      current: {
        score: 8,
        band: "STEADY",
        avg24h: 7.5,
        avg24hBand: "STEADY",
        computedAt: 1_700_000_000,
        components: { severity: 1, breadth: 2, stressBreadth: 3, trend: -1 },
        methodologyVersion: "v1",
        contributors: [{ extra: "preserved" }],
      },
      history: [{ date: 1_699_900_000, score: 7, band: "STEADY", methodologyVersion: "v1" }],
      methodology: { version: "v1", extra: true },
    };

    const parsed = StabilityIndexLightResponseSchema.safeParse(payload);
    expect(parsed).toEqual({ success: true, data: payload });
    expect(STABILITY_INDEX_QUERY_DESCRIPTOR.schema).toBe(StabilityIndexLightResponseSchema);
  });

  it("rejects malformed PSI fields used by the root shell", () => {
    const parsed = StabilityIndexLightResponseSchema.safeParse({
      current: {
        score: 8,
        band: "STEADY",
        computedAt: 1_700_000_000,
        components: { severity: "bad", breadth: 2, trend: -1 },
      },
      history: [],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // The issue path drives the caller's fallback; the wording is not a contract.
    expect(parsed.error.issues.map((issue) => issue.path)).toContainEqual([
      "current",
      "components",
      "severity",
    ]);
  });
});

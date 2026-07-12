import { describe, expect, it } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  appendOrReplaceCurrentStablecoinChartsPoint,
  buildCurrentStablecoinChartsPoint,
  mergeStructuralSupplementalHistoryIntoCharts,
  STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS,
} from "../stablecoin-charts-reconciliation";

describe("stablecoin-charts reconciliation", () => {
  it("excludes llama-backed charts while preserving the audited empty BRZ legacy chart", () => {
    const llamaBacked = STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS.filter(
      ({ id }) => ACTIVE_META_BY_ID.get(id)?.llamaId != null,
    );
    expect(llamaBacked).toEqual([{ id: "brz-transfero", pegType: "peggedREAL" }]);
    expect(STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining([
        "audm-mento",
        "cadm-mento",
        "chfm-mento",
        "copm-mento",
        "gbpm-mento",
        "zarm-mento",
      ]),
    );
  });

  it("merges structural supplemental history into the base chart series", () => {
    const merged = mergeStructuralSupplementalHistoryIntoCharts(
      [
        { date: 100, totalCirculatingUSD: { peggedUSD: 100 } },
        { date: 200, totalCirculatingUSD: { peggedUSD: 110 } },
        { date: 300, totalCirculatingUSD: { peggedUSD: 120 } },
      ],
      [
        { stablecoin_id: "susds-sky", snapshot_date: 150, circulating_usd: 20 },
        { stablecoin_id: "susds-sky", snapshot_date: 250, circulating_usd: 25 },
        { stablecoin_id: "paxg-paxos", snapshot_date: 80, circulating_usd: 7 },
      ],
      [
        { id: "susds-sky", pegType: "peggedUSD" },
        { id: "paxg-paxos", pegType: "peggedGOLD" },
      ],
    );

    expect(merged).toEqual([
      { date: 100, totalCirculatingUSD: { peggedUSD: 100, peggedGOLD: 7 } },
      { date: 200, totalCirculatingUSD: { peggedUSD: 130, peggedGOLD: 7 } },
      { date: 300, totalCirculatingUSD: { peggedUSD: 145, peggedGOLD: 7 } },
    ]);
  });

  it("builds a live current point from the stablecoins cache and normalizes BRL to REAL", () => {
    const point = buildCurrentStablecoinChartsPoint(
      [
        {
          id: "brz-transfero",
          symbol: "BRZ",
          name: "BRZ",
          geckoId: "brz",
          pegType: "peggedBRL",
          pegMechanism: "fiat-backed",
          price: 1,
          priceSource: "coingecko",
          priceConfidence: "single-source",
          priceUpdatedAt: null,
          priceObservedAt: null,
          priceObservedAtMode: null,
          priceSyncedAt: null,
          consensusSources: [],
          agreeSources: [],
          supplySource: "coingecko-fallback",
          circulating: { peggedBRL: 40 },
          circulatingPrevDay: {},
          circulatingPrevWeek: {},
          circulatingPrevMonth: {},
          chainCirculating: {},
          chains: [],
        },
        {
          id: "usdc-circle",
          symbol: "USDC",
          name: "USDC",
          geckoId: "usd-coin",
          pegType: "peggedUSD",
          pegMechanism: "fiat-backed",
          price: 1,
          priceSource: "defillama",
          priceConfidence: "high",
          priceUpdatedAt: null,
          priceObservedAt: null,
          priceObservedAtMode: null,
          priceSyncedAt: null,
          consensusSources: [],
          agreeSources: [],
          supplySource: "defillama",
          circulating: { peggedUSD: 90 },
          circulatingPrevDay: {},
          circulatingPrevWeek: {},
          circulatingPrevMonth: {},
          chainCirculating: {},
          chains: [],
        },
      ],
      500,
    );

    expect(point).toEqual({
      date: 500,
      totalCirculatingUSD: {
        peggedREAL: 40,
        peggedUSD: 90,
      },
    });
  });

  it("appends a live current point after historical points", () => {
    const points = appendOrReplaceCurrentStablecoinChartsPoint(
      [
        { date: 100, totalCirculatingUSD: { peggedUSD: 100 } },
        { date: 200, totalCirculatingUSD: { peggedUSD: 120 } },
      ],
      { date: 250, totalCirculatingUSD: { peggedUSD: 140 } },
    );

    expect(points).toEqual([
      { date: 100, totalCirculatingUSD: { peggedUSD: 100 } },
      { date: 200, totalCirculatingUSD: { peggedUSD: 120 } },
      { date: 250, totalCirculatingUSD: { peggedUSD: 140 } },
    ]);
  });
});

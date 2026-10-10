import { describe, expect, it } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC } from "@shared/lib/rate-series";
import {
  mergeStructuralSupplementalHistoryIntoCharts,
  STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS,
} from "../stablecoin-charts-reconciliation";

describe("stablecoin-charts reconciliation", () => {
  it("excludes llama-backed charts while preserving the audited empty BRZ legacy chart", () => {
    const llamaBacked = STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS.filter(
      ({ id }) => ACTIVE_META_BY_ID.get(id)?.llamaId != null,
    );
    expect(llamaBacked).toEqual([{ id: "brz-transfero", pegType: "peggedREAL" }]);
    const forbidden = [
      "audm-mento", "cadm-mento", "chfm-mento", "copm-mento", "gbpm-mento", "zarm-mento",
    ];
    expect(STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS.filter(({ id }) => forbidden.includes(id))).toEqual([]);
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
      { date: 100, totalCirculatingUSD: { peggedUSD: null, peggedGOLD: 7 } },
      { date: 200, totalCirculatingUSD: { peggedUSD: 130, peggedGOLD: 7 } },
      { date: 300, totalCirculatingUSD: { peggedUSD: 145, peggedGOLD: 7 } },
    ]);
  });

  it("withholds prehistory buckets and overlays beyond the shared distance budget", () => {
    const date = 1_700_000_000;
    const dates = [date - 1, date, date + MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC, date + MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC + 1];
    const merged = mergeStructuralSupplementalHistoryIntoCharts(
      dates.map((date) => ({ date, totalCirculatingUSD: { peggedUSD: 100 } })),
      [{ stablecoin_id: "gold", snapshot_date: date, circulating_usd: 20 }],
      [{ id: "gold", pegType: "peggedGOLD" }],
    );
    expect(merged.map((point) => point.totalCirculatingUSD)).toEqual([
      { peggedUSD: 100, peggedGOLD: null },
      { peggedUSD: 100, peggedGOLD: 20 },
      { peggedUSD: 100, peggedGOLD: 20 },
      { peggedUSD: 100, peggedGOLD: null },
    ]);
  });

  it("preserves dated zero evidence and never repairs an explicitly unavailable base bucket", () => {
    expect(mergeStructuralSupplementalHistoryIntoCharts(
      [
        { date: 100, totalCirculatingUSD: { peggedUSD: 100 } },
        { date: 200, totalCirculatingUSD: { peggedUSD: 100, peggedGOLD: null } },
      ],
      [
        { stablecoin_id: "gold", snapshot_date: 200, circulating_usd: 20 },
        { stablecoin_id: "gold", snapshot_date: 100, circulating_usd: 0 },
      ],
      [{ id: "gold", pegType: "peggedGOLD" }],
    )).toEqual([
      { date: 100, totalCirculatingUSD: { peggedUSD: 100, peggedGOLD: 0 } },
      { date: 200, totalCirculatingUSD: { peggedUSD: 100, peggedGOLD: null } },
    ]);
  });

  it("withholds a bucket when a configured contributor has no admitted history", () => {
    expect(mergeStructuralSupplementalHistoryIntoCharts(
      [{ date: 100, totalCirculatingUSD: { peggedUSD: 100 } }],
      [],
      [{ id: "missing", pegType: "peggedUSD" }],
    )).toEqual([{ date: 100, totalCirculatingUSD: { peggedUSD: null } }]);
  });

});

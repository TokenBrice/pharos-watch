import { describe, expect, it } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
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
      { date: 100, totalCirculatingUSD: { peggedUSD: 100, peggedGOLD: 7 } },
      { date: 200, totalCirculatingUSD: { peggedUSD: 130, peggedGOLD: 7 } },
      { date: 300, totalCirculatingUSD: { peggedUSD: 145, peggedGOLD: 7 } },
    ]);
  });

});

import { describe, expect, it } from "vitest";
import { CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC } from "@shared/lib/stablecoins/aggregate-universe";
import { ACTIVE_META_BY_ID, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC } from "@shared/lib/rate-series";
import {
  buildDateFencedSupplementalChartConfigs,
  mergeStructuralSupplementalHistoryIntoCharts,
  STRUCTURAL_SUPPLEMENTAL_CHART_OVERLAYS,
} from "../stablecoin-charts-reconciliation";

describe("stablecoin-charts reconciliation", () => {
  it("excludes llama-backed charts while preserving the audited empty BRZ legacy chart", () => {
    const llamaBacked = STRUCTURAL_SUPPLEMENTAL_CHART_OVERLAYS.filter(
      ({ id }) => TRACKED_META_BY_ID.get(id)?.llamaId != null,
    );
    expect(llamaBacked).toEqual([{ id: "brz-transfero", pegType: "peggedREAL" }]);
    const forbidden = [
      "audm-mento", "cadm-mento", "chfm-mento", "copm-mento", "gbpm-mento", "zarm-mento",
    ];
    expect(STRUCTURAL_SUPPLEMENTAL_CHART_OVERLAYS.filter(({ id }) => forbidden.includes(id))).toEqual([]);
  });

  it("excludes a DefiLlama-charted asset that carries no registry llamaId", () => {
    expect(STRUCTURAL_SUPPLEMENTAL_CHART_OVERLAYS.map(({ id }) => id)).not.toContain("sofid-sofi");
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

  it("omits unobserved overlays before history and beyond the shared distance budget", () => {
    const date = 1_700_000_000;
    const dates = [date - 1, date, date + MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC, date + MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC + 1];
    const merged = mergeStructuralSupplementalHistoryIntoCharts(
      dates.map((date) => ({ date, totalCirculatingUSD: { peggedUSD: 100 } })),
      [{ stablecoin_id: "gold", snapshot_date: date, circulating_usd: 20 }],
      [{ id: "gold", pegType: "peggedGOLD" }],
    );
    expect(merged.map((point) => point.totalCirculatingUSD)).toEqual([
      { peggedUSD: 100 },
      { peggedUSD: 100, peggedGOLD: 20 },
      { peggedUSD: 100, peggedGOLD: 20 },
      { peggedUSD: 100 },
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

  it("preserves a provider bucket when a supplemental contributor has no admitted history", () => {
    expect(mergeStructuralSupplementalHistoryIntoCharts(
      [{ date: 100, totalCirculatingUSD: { peggedUSD: 100 } }],
      [],
      [{ id: "missing", pegType: "peggedUSD" }],
    )).toEqual([{ date: 100, totalCirculatingUSD: { peggedUSD: 100 } }]);
  });

  it("fences v1-only and v2-only supplemental overlays cleanly across the cutover timestamp", () => {
    const cutover = CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC;
    const pre = cutover - 86_400;
    const post = cutover + 86_400;
    const v1Fund = ACTIVE_META_BY_ID.get("eutbl-spiko")!;
    const keptCoin = ACTIVE_META_BY_ID.get("usg-tangent")!;
    const v2OnlyCoin = ACTIVE_META_BY_ID.get("paxg-paxos")!;
    const configs = buildDateFencedSupplementalChartConfigs(
      new Set([v1Fund.id, keptCoin.id]),
      [keptCoin, v2OnlyCoin],
      new Map([[v1Fund.id, v1Fund], [keptCoin.id, keptCoin], [v2OnlyCoin.id, v2OnlyCoin]]),
      cutover,
    );
    expect(configs).toEqual([
      { id: keptCoin.id, pegType: "peggedUSD" },
      { id: v2OnlyCoin.id, pegType: "peggedGOLD", activeFrom: cutover },
      { id: v1Fund.id, pegType: "peggedEUR", inactiveFrom: cutover },
    ]);

    const merged = mergeStructuralSupplementalHistoryIntoCharts(
      [pre, cutover, post].map((date) => ({ date, totalCirculatingUSD: { peggedUSD: 100, peggedEUR: 10 } })),
      [pre, cutover, post].flatMap((snapshot_date) => [
        { stablecoin_id: v1Fund.id, snapshot_date, circulating_usd: 50 },
        { stablecoin_id: keptCoin.id, snapshot_date, circulating_usd: 20 },
        { stablecoin_id: v2OnlyCoin.id, snapshot_date, circulating_usd: 7 },
      ]),
      configs,
    );
    expect(merged).toEqual([
      { date: pre, totalCirculatingUSD: { peggedUSD: 120, peggedEUR: 60 } },
      { date: cutover, totalCirculatingUSD: { peggedUSD: 120, peggedEUR: 10, peggedGOLD: 7 } },
      { date: post, totalCirculatingUSD: { peggedUSD: 120, peggedEUR: 10, peggedGOLD: 7 } },
    ]);
  });

});

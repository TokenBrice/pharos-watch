import { describe, expect, it } from "vitest";
import {
  buildYieldHistoryEvaluationInputs,
  buildYieldHistoryEvaluationInputsCooperative,
  type YieldHistoryInputBuildProgress,
} from "../yield-sync/coordinator-history";
import type { YieldHistorySnapshotRow } from "../yield-sync/history";
import { evaluateYieldSources } from "../yield-sync/evaluation";
import { baseEvaluationInput, resolvedYield } from "./yield-evaluation.test-support";

function row(overrides: Partial<YieldHistorySnapshotRow>): YieldHistorySnapshotRow {
  return {
    stablecoin_id: "coin-a",
    source_key: "source-a",
    recorded_at: 1_700_000_000,
    is_best: 0,
    apy: 4.2,
    apy_base: null,
    source_tvl_usd: 1_000_000,
    data_source: "defillama",
    yield_source: "Source A",
    yield_type: "lending",
    exchange_rate: null,
    ...overrides,
  };
}

describe("yield coordinator history", () => {
  it("normalizes source, legacy, on-chain, TVL, and previous-best history inputs", () => {
    const result = buildYieldHistoryEvaluationInputs({
      historyRows: [
        row({ stablecoin_id: "coin-a", source_key: "source-a" }),
        row({
          stablecoin_id: "coin-a",
          source_key: null,
          data_source: "onchain",
          exchange_rate: 1.01,
        }),
        row({
          stablecoin_id: "lusd-liquity",
          source_key: "bprotocol-lqty-only",
          data_source: "onchain",
          exchange_rate: 1.02,
        }),
      ],
      prevTvlRows: [
        row({ stablecoin_id: "coin-a", source_key: "source-a", source_tvl_usd: 9_000 }),
        row({ stablecoin_id: "coin-a", source_key: null, source_tvl_usd: 7_000 }),
        row({ stablecoin_id: "coin-a", source_key: "source-a", source_tvl_usd: 8_000 }),
      ],
      prevBestRows: [
        row({ stablecoin_id: "coin-a", source_key: "source-a", is_best: 1 }),
      ],
    });

    expect(result.sourceHistory.get("coin-a::source-a")).toHaveLength(1);
    expect(result.legacyHistoryById.get("coin-a")?.[0]?.source_key).toBe("legacy-best");
    expect(result.onChainCompatibilityHistoryById.get("coin-a")).toHaveLength(1);
    expect(result.legacyDeterministicOnChainHistoryById.get("lusd-liquity")).toHaveLength(1);
    expect(result.prevTvlBySource.get("coin-a::source-a")).toBe(9_000);
    expect(result.legacyPrevTvlById.get("coin-a")).toBe(7_000);
    expect(result.prevBestSourceKeyByCoin.get("coin-a")).toBe("source-a");
  });

  it("counts selected-source switches across 30d history rows, collapsing one-publication gaps", () => {
    const switchesFor = (rows: YieldHistorySnapshotRow[]) =>
      buildYieldHistoryEvaluationInputs({ historyRows: rows, prevTvlRows: [], prevBestRows: [] })
        .sourceSwitchCount30dByCoin.get("coin-a");

    // Durable runs: A A B B A A -> two switches.
    expect(switchesFor([
      row({ source_key: "source-a", is_best: 1, recorded_at: 100 }),
      row({ source_key: "source-a", is_best: 1, recorded_at: 200 }),
      row({ source_key: "source-b", is_best: 1, recorded_at: 300 }),
      row({ source_key: "source-b", is_best: 1, recorded_at: 400 }),
      row({ source_key: "source-a", is_best: 1, recorded_at: 500 }),
      row({ source_key: "source-a", is_best: 1, recorded_at: 600 }),
    ])).toBe(2);

    // B2: a one-publication out-and-back is a fetch gap, not two switches.
    expect(switchesFor([
      row({ source_key: "source-a", is_best: 1, recorded_at: 100 }),
      row({ source_key: "source-a", is_best: 1, recorded_at: 200 }),
      row({ source_key: "source-b", is_best: 1, recorded_at: 300 }),
      row({ source_key: "source-a", is_best: 1, recorded_at: 400 }),
      row({ source_key: "source-a", is_best: 1, recorded_at: 500 }),
    ])).toBe(0);

    // Non-best rows never participate in the selected-source series.
    expect(switchesFor([
      row({ source_key: "source-a", is_best: 1, recorded_at: 100 }),
      row({ source_key: "source-b", is_best: 0, recorded_at: 200 }),
      row({ source_key: "source-a", is_best: 1, recorded_at: 300 }),
    ])).toBe(0);
  });

  it("skips the legacy-best sentinel in the durable selected-source series", () => {
    const switchesFor = (rows: YieldHistorySnapshotRow[]) =>
      buildYieldHistoryEvaluationInputs({ historyRows: rows, prevTvlRows: [], prevBestRows: [] })
        .sourceSwitchCount30dByCoin.get("coin-a");

    // A coin that only ever published legacy rows and then gains source-aware
    // rows has not switched sources: `isRealSourceSwitch` never charges the
    // sentinel, so the 30d count must not charge it either.
    expect(switchesFor([
      row({ source_key: "legacy-best", is_best: 1, recorded_at: 100 }),
      row({ source_key: "legacy-best", is_best: 1, recorded_at: 200 }),
      row({ source_key: "source-a", is_best: 1, recorded_at: 300 }),
      row({ source_key: "source-a", is_best: 1, recorded_at: 400 }),
    ])).toBe(0);

    // A durable legacy era between two runs of one real source is an unchanged
    // source, not two switches.
    expect(switchesFor([
      row({ source_key: "source-a", is_best: 1, recorded_at: 100 }),
      row({ source_key: "source-a", is_best: 1, recorded_at: 200 }),
      row({ source_key: "legacy-best", is_best: 1, recorded_at: 300 }),
      row({ source_key: "legacy-best", is_best: 1, recorded_at: 400 }),
      row({ source_key: "source-a", is_best: 1, recorded_at: 500 }),
      row({ source_key: "source-a", is_best: 1, recorded_at: 600 }),
    ])).toBe(0);

    // A real switch still counts once when it straddles a legacy era.
    expect(switchesFor([
      row({ source_key: "source-a", is_best: 1, recorded_at: 100 }),
      row({ source_key: "source-a", is_best: 1, recorded_at: 200 }),
      row({ source_key: "legacy-best", is_best: 1, recorded_at: 300 }),
      row({ source_key: "source-b", is_best: 1, recorded_at: 400 }),
      row({ source_key: "source-b", is_best: 1, recorded_at: 500 }),
    ])).toBe(1);
  });

  it("publishes the switch series including the current run, not a transient increment", () => {
    const priorKey = "defillama:coin-a:prior";
    const challengerKey = "defillama:coin-a:challenger";
    const run = (bestRows: YieldHistorySnapshotRow[], sourceKeys: string[]) => {
      const inputs = buildYieldHistoryEvaluationInputs({
        historyRows: bestRows,
        prevTvlRows: [],
        prevBestRows: [row({ source_key: priorKey, is_best: 1 })],
      });
      return evaluateYieldSources(baseEvaluationInput({
        resolved: sourceKeys.map((sourceKey, index) => ({
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({ sourceKey, currentApy: index === 0 ? 5 : 6 }),
        })),
        ...inputs,
      }));
    };
    const published = (result: ReturnType<typeof evaluateYieldSources>, sourceKey: string) =>
      result.evaluatedSources.find((source) => source.sourceKey === sourceKey);
    const priorRun = (recordedAt: number) => row({ source_key: priorKey, is_best: 1, recorded_at: recordedAt });

    // Durable switch: the challenger wins twice in a row. The first publication
    // sees one run of it, so the collapsed series still reads 0; the second run
    // is the second consecutive publication and charges exactly one switch.
    const durableFirst = published(run([priorRun(100), priorRun(200)], [priorKey, challengerKey]), challengerKey);
    const durableSecond = published(
      run(
        [priorRun(100), priorRun(200), row({ source_key: challengerKey, is_best: 1, recorded_at: 300 })],
        [priorKey, challengerKey],
      ),
      challengerKey,
    );
    expect(durableFirst?.sourceSwitchCount30d).toBe(0);
    expect(durableSecond?.sourceSwitchCount30d).toBe(1);
    // The published penalty is derived from that same count.
    expect((durableSecond?.sourceRiskPenalty ?? 0) - (durableFirst?.sourceRiskPenalty ?? 0)).toBeCloseTo(0.1, 6);

    // One-publication excursion: the challenger wins once and the prior source
    // returns. Both publications read 0 — the count never publishes an increment
    // the next run erases.
    const excursion = published(run([priorRun(100), priorRun(200)], [priorKey, challengerKey]), challengerKey);
    const returned = published(
      run(
        [priorRun(100), priorRun(200), row({ source_key: challengerKey, is_best: 1, recorded_at: 300 })],
        [priorKey],
      ),
      priorKey,
    );
    expect(excursion?.sourceSwitchCount30d).toBe(0);
    expect(returned?.sourceSwitchCount30d).toBe(0);
  });

  it("treats a resolved-but-rejected previous winner as no incumbent for both arms", () => {
    const incumbent = "defillama:coin-a:prior";
    const challenger = "defillama:coin-a:challenger";
    // History with a positive APY against a zero current APY is the
    // `source-zero-vs-history` rejection: the incumbent is resolved this run but
    // not publishable — exactly the fact the 30d count already reads.
    const bestRows = [
      row({ source_key: incumbent, is_best: 1, recorded_at: 10, apy: 5 }),
      row({ source_key: challenger, is_best: 1, recorded_at: 100 }),
      row({ source_key: challenger, is_best: 1, recorded_at: 200 }),
    ];
    const evaluate = (includeIncumbent: boolean) => {
      const inputs = buildYieldHistoryEvaluationInputs({
        historyRows: bestRows,
        prevTvlRows: [],
        prevBestRows: [row({ source_key: incumbent, is_best: 1 })],
      });
      const entries = [
        ...(includeIncumbent
          ? [{ sourceKey: incumbent, currentApy: 0, apyBase: 0 }]
          : []),
        { sourceKey: challenger, currentApy: 6, apyBase: 6 },
      ];
      return evaluateYieldSources(baseEvaluationInput({
        resolved: entries.map((entry) => ({
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield(entry),
        })),
        ...inputs,
      }));
    };

    const withoutIncumbent = evaluate(false);
    const withRejectedIncumbent = evaluate(true);
    // Same winner and same charged count: a rejected incumbent neither arms the
    // B3 arbitration margin nor blocks the switch series.
    expect(withRejectedIncumbent.bestSourceKeyByCoin.get("coin-a")).toBe(challenger);
    expect(withoutIncumbent.bestSourceKeyByCoin.get("coin-a")).toBe(challenger);
    expect(withRejectedIncumbent.sourceSwitches).toBe(withoutIncumbent.sourceSwitches);
    const rejectedRow = withRejectedIncumbent.evaluatedSources.find(
      (source) => source.sourceKey === incumbent,
    );
    expect(rejectedRow?.rejected).toBe(true);
    // The winner carries the transient-missing record: the rejected incumbent is
    // not a live candidate for either arm.
    const winnerRow = withRejectedIncumbent.evaluatedSources.find(
      (source) => source.sourceKey === challenger,
    );
    expect(winnerRow?.anomalies).toContain("previous-source-transiently-missing");
  });

  it("preserves linked on-chain identities across consecutive generations", () => {
    const linkedSourceKey = "linked-variant:child-coin:onchain:child-coin";
    const result = buildYieldHistoryEvaluationInputs({
      historyRows: [
        row({
          stablecoin_id: "parent-coin",
          source_key: linkedSourceKey,
          data_source: "onchain",
          exchange_rate: 1.01,
          is_best: 1,
          recorded_at: 100,
        }),
        row({
          stablecoin_id: "parent-coin",
          source_key: linkedSourceKey,
          data_source: "onchain",
          exchange_rate: 1.02,
          is_best: 1,
          recorded_at: 200,
        }),
      ],
      prevTvlRows: [],
      prevBestRows: [row({
        stablecoin_id: "parent-coin",
        source_key: linkedSourceKey,
        data_source: "onchain",
        exchange_rate: 1.02,
        is_best: 1,
      })],
    });

    expect(result.prevBestSourceKeyByCoin.get("parent-coin")).toBe(linkedSourceKey);
    expect(result.sourceSwitchCount30dByCoin.get("parent-coin")).toBe(0);
  });

  it("cooperative input construction matches the synchronous builder", async () => {
    const input = {
      historyRows: [
        row({ stablecoin_id: "coin-a", source_key: "source-a", is_best: 1, recorded_at: 100 }),
        row({ stablecoin_id: "coin-a", source_key: "source-b", is_best: 1, recorded_at: 200 }),
        row({ stablecoin_id: "coin-b", source_key: null, data_source: "onchain", exchange_rate: 1.01 }),
        row({ stablecoin_id: "lusd-liquity", source_key: "bprotocol-lqty-only", data_source: "onchain", exchange_rate: 1.02 }),
      ],
      prevTvlRows: [
        row({ stablecoin_id: "coin-a", source_key: "source-a", source_tvl_usd: 9_000 }),
        row({ stablecoin_id: "coin-b", source_key: null, source_tvl_usd: 7_000 }),
      ],
      prevBestRows: [row({ stablecoin_id: "coin-a", source_key: "source-b", is_best: 1 })],
    };
    const progress: YieldHistoryInputBuildProgress[] = [];

    const sync = buildYieldHistoryEvaluationInputs(input);
    const cooperative = await buildYieldHistoryEvaluationInputsCooperative(input, {
      yieldEveryRows: 1,
      onProgress: (snapshot) => {
        progress.push(snapshot);
      },
    });

    expect(cooperative).toEqual(sync);
    expect(progress[progress.length - 1]).toMatchObject({ rowsDone: 1, rowsTotal: 1 });
    for (const phase of new Set(progress.map((snapshot) => snapshot.phase))) {
      const counts = progress.filter((snapshot) => snapshot.phase === phase).map((snapshot) => snapshot.rowsDone);
      expect(counts).toEqual([...counts].sort((a, b) => a - b));
    }
  });

});

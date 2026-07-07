import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  loadStressSignalCurrentRowForCoin,
  loadStressSignalCurrentRows,
  mergeNewestStressSignalRows,
  type StressSignalCurrentRow,
} from "../stress-signals-current-rows";

const nowSec = 1_778_400_000;
const signalsJson = JSON.stringify({ supply: { value: 10, available: true } });

function row(stablecoinId: string, computedAt: number, score = 10): StressSignalCurrentRow {
  return {
    stablecoin_id: stablecoinId,
    score,
    band: "CALM",
    signals_json: signalsJson,
    computed_at: computedAt,
  };
}

describe("stress-signal current-row helpers", () => {
  it("merges latest rows over legacy rows while preserving legacy-only rows", () => {
    const merged = mergeNewestStressSignalRows(
      [row("usdt-tether", nowSec - 120, 12), row("usdc-circle", nowSec - 60, 30)],
      [row("usdt-tether", nowSec - 30, 15)],
    );

    expect(merged).toEqual([
      row("usdt-tether", nowSec - 30, 15),
      row("usdc-circle", nowSec - 60, 30),
    ]);
  });

  it("falls back to canonical history rows when latest materialization is stale", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [],
        first: null,
      },
      {
        match: "pharos:stress-signals:latest-all",
        rows: [{ ...row("usdt-tether", nowSec - 1_000, 20) }],
      },
      {
        match: "pharos:stress-signals:legacy-latest-all",
        rows: [{ ...row("usdt-tether", nowSec - 120, 12) }],
      },
    ], { requireMatch: true });

    const loaded = await loadStressSignalCurrentRows(db, nowSec, { staleAfterSec: 300 });

    expect(loaded.results).toEqual([row("usdt-tether", nowSec - 120, 12)]);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("keeps a stale single-coin latest row when no legacy row exists", async () => {
    const staleLatest = {
      score: 25,
      band: "WATCH",
      signals_json: signalsJson,
      computed_at: nowSec - 1_000,
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [],
        first: null,
      },
      {
        match: "pharos:stress-signals:latest-one",
        matchBinds: ["usdt-tether"],
        rows: [staleLatest],
        first: staleLatest,
      },
      {
        match: "pharos:stress-signals:legacy-latest-one",
        matchBinds: ["usdt-tether"],
        rows: [],
        first: null,
      },
    ], { requireMatch: true });

    const loaded = await loadStressSignalCurrentRowForCoin(
      db,
      "usdt-tether",
      nowSec,
      { staleAfterSec: 300 },
    );

    expect(loaded).toEqual(staleLatest);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("does not read unbounded current rows when the publication pointer is invalid", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [{
          key: "dews:published-generation",
          value: JSON.stringify({
            updatedAt: nowSec - 60,
            source: "compute-dews",
            publishStatus: "draft",
          }),
          updated_at: nowSec - 60,
        }],
        first: {
          key: "dews:published-generation",
          value: JSON.stringify({
            updatedAt: nowSec - 60,
            source: "compute-dews",
            publishStatus: "draft",
          }),
          updated_at: nowSec - 60,
        },
      },
    ], { requireMatch: true });

    const loaded = await loadStressSignalCurrentRows(db, nowSec, { staleAfterSec: 300 });

    expect(loaded.results).toEqual([]);
    expect(db.getHistory()).toHaveLength(1);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("does not read single-coin current rows when the publication pointer cannot be read", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [],
        throwError: new Error("D1 unavailable"),
      },
    ], { requireMatch: true });

    const loaded = await loadStressSignalCurrentRowForCoin(
      db,
      "usdt-tether",
      nowSec,
      { staleAfterSec: 300 },
    );

    expect(loaded).toBeNull();
    expect(db.getHistory()).toHaveLength(1);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });
});

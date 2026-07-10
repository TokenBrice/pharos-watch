import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  loadStressSignalCurrentRowForCoin,
  loadStressSignalCurrentRows,
  mergeNewestStressSignalRows,
  type StressSignalCurrentRow,
} from "../stress-signals-current-rows";
import { buildDewsStablecoinIdsDigest } from "../dews-publication-pointer";

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

  it("skips canonical history when the scoped latest generation is complete and fresh", async () => {
    const completedAt = nowSec - 60;
    const pointer = {
      key: "dews:published-generation",
      value: JSON.stringify({
        updatedAt: completedAt,
        source: "compute-dews",
        publishStatus: "published",
      }),
      updated_at: completedAt,
    };
    const latestRows = [
      row("usdt-tether", completedAt, 12),
      row("usdc-circle", completedAt, 30),
    ];
    pointer.value = JSON.stringify({
      updatedAt: completedAt,
      source: "compute-dews",
      publishStatus: "published",
      coverageVersion: 2,
      expectedRowCount: latestRows.length,
      stablecoinIdsDigest: buildDewsStablecoinIdsDigest(latestRows.map((latestRow) => latestRow.stablecoin_id)),
    });
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [pointer],
        first: pointer,
      },
      {
        match: "pharos:stress-signals:latest-all",
        matchBinds: [completedAt],
        rows: latestRows.map((latestRow) => ({ ...latestRow })),
      },
    ], { requireMatch: true });

    const loaded = await loadStressSignalCurrentRows(db, nowSec, { staleAfterSec: 300 });

    expect(loaded.results).toEqual(latestRows);
    expect(db.getHistory().some((entry) => entry.sql.includes("legacy-latest-all"))).toBe(false);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("merges canonical history when chunked staging hides part of the published latest set", async () => {
    const completedAt = nowSec - 60;
    const publishedIds = ["usdt-tether", "usdc-circle"];
    const pointer = {
      key: "dews:published-generation",
      value: JSON.stringify({
        updatedAt: completedAt,
        source: "compute-dews",
        publishStatus: "published",
        coverageVersion: 2,
        expectedRowCount: publishedIds.length,
        stablecoinIdsDigest: buildDewsStablecoinIdsDigest(publishedIds),
      }),
      updated_at: completedAt,
    };
    const untouchedOldSubset = row("usdc-circle", completedAt, 30);
    const canonicalRows = [
      row("usdt-tether", completedAt, 12),
      untouchedOldSubset,
    ];
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [pointer],
        first: pointer,
      },
      {
        match: "pharos:stress-signals:latest-all",
        matchBinds: [completedAt],
        rows: [{ ...untouchedOldSubset }],
      },
      {
        match: "pharos:stress-signals:legacy-latest-all",
        matchBinds: [completedAt],
        rows: canonicalRows.map((canonicalRow) => ({ ...canonicalRow })),
      },
    ], { requireMatch: true });

    const loaded = await loadStressSignalCurrentRows(db, nowSec, { staleAfterSec: 300 });

    expect(loaded.results).toEqual(canonicalRows);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("keeps the canonical merge for legacy pointers without exact-set proof", async () => {
    const completedAt = nowSec - 60;
    const pointer = {
      key: "dews:published-generation",
      value: JSON.stringify({
        updatedAt: completedAt,
        source: "compute-dews",
        publishStatus: "published",
      }),
      updated_at: completedAt,
    };
    const latest = row("usdt-tether", completedAt, 20);
    const canonical = row("usdt-tether", completedAt, 22);
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [pointer],
        first: pointer,
      },
      {
        match: "pharos:stress-signals:latest-all",
        matchBinds: [completedAt],
        rows: [{ ...latest }],
      },
      {
        match: "pharos:stress-signals:legacy-latest-all",
        matchBinds: [completedAt],
        rows: [{ ...canonical }],
      },
    ], { requireMatch: true });

    const loaded = await loadStressSignalCurrentRows(db, nowSec, { staleAfterSec: 300 });

    expect(loaded.results).toEqual([latest]);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("keeps the canonical merge when latest rows do not all match the published generation", async () => {
    const completedAt = nowSec - 60;
    const pointer = {
      key: "dews:published-generation",
      value: JSON.stringify({
        updatedAt: completedAt,
        source: "compute-dews",
        publishStatus: "published",
      }),
      updated_at: completedAt,
    };
    const latest = row("usdt-tether", completedAt - 60, 20);
    const canonical = row("usdt-tether", completedAt, 22);
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [pointer],
        first: pointer,
      },
      {
        match: "pharos:stress-signals:latest-all",
        matchBinds: [completedAt],
        rows: [{ ...latest }],
      },
      {
        match: "pharos:stress-signals:legacy-latest-all",
        matchBinds: [completedAt],
        rows: [{ ...canonical }],
      },
    ], { requireMatch: true });

    const loaded = await loadStressSignalCurrentRows(db, nowSec, { staleAfterSec: 300 });

    expect(loaded.results).toEqual([canonical]);
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

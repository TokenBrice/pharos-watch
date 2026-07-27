import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { loadStatusForCoin } from "../telegram-webhook-status";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";

const mocks = vi.hoisted(() => ({
  loadIdentifiedActiveSafetyScoreSource: vi.fn(),
}));

vi.mock("../../lib/identified-active-safety-score-source", () => ({
  loadIdentifiedActiveSafetyScoreSource: mocks.loadIdentifiedActiveSafetyScoreSource,
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("loadStatusForCoin", () => {
  beforeEach(() => {
    const snapshot = makeWorkerReportCardsV9Response({
      asOfSec: 122,
      updatedAt: 123,
      cards: [
        makeWorkerV9Card({
          id: "usdc-circle",
          grade: "B+",
          score: 66,
        }),
      ],
    });
    mocks.loadIdentifiedActiveSafetyScoreSource.mockReset().mockResolvedValue({
      kind: "v9",
      expectedModel: "v9",
      identity: snapshot.safetyScoreIdentity,
      publishedAtSec: 123,
      snapshot,
    });
  });

  it("returns DEWS + safety + depeg=stable when no active event", async () => {
    const db = mockD1([
      { match: "FROM stress_signals", rows: [{ band: "ALERT", score: 42, computed_at: 1700000000 }] },
      { match: "FROM safety_grade_history", rows: [{ grade: "B+", score: 66, recorded_at: 1700000000 }] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [{ price: 0.9997, updated_at: 1700000000 }] },
    ]);
    const status = await loadStatusForCoin(db, "usdc-circle");
    expect(status.dews?.band).toBe("ALERT");
    expect(status.safety?.grade).toBe("B+");
    expect(status.safety?.model).toBe("v9");
    expect(status.safety?.publicationGenerationId).toBe("report-cards:v9:1");
    expect(status.depeg.status).toBe("stable");
    expect(status.priceUsd).toBeCloseTo(0.9997);
  });

  it("uses an exact published DEWS row instead of an older latest-table row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const publishedAt = nowSec - 60;
    const pointer = {
      key: "dews:published-generation",
      value: JSON.stringify({
        updatedAt: publishedAt,
        source: "compute-dews",
        publishStatus: "published",
        coverageVersion: 2,
        expectedRowCount: 2,
        stablecoinIdsDigest: buildDewsStablecoinIdsDigest(["usdc-circle", "usdt-tether"]),
      }),
      updated_at: publishedAt,
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [pointer],
        first: pointer,
      },
      {
        match: "pharos:stress-signals:latest-one",
        matchBinds: ["usdc-circle", publishedAt],
        rows: [{ band: "CALM", score: 5, signals_json: "{}", computed_at: publishedAt - 60 }],
      },
      {
        match: "pharos:stress-signals:published-exact-one",
        matchBinds: ["usdc-circle", publishedAt],
        rows: [{ band: "WARNING", score: 72, signals_json: "{}", computed_at: publishedAt }],
      },
    ]);

    const status = await loadStatusForCoin(db, "usdc-circle");

    expect(status.dews).toEqual({ band: "WARNING", score: 72, computedAt: publishedAt });
    expect(db.getHistory().some((entry) => entry.sql.includes("legacy-latest-one"))).toBe(false);
  });

  it("surfaces an active depeg event with direction and deviation", async () => {
    const db = mockD1([
      { match: "FROM stress_signals", rows: [{ band: "WATCH", score: 30, computed_at: 1700000000 }] },
      { match: "FROM safety_grade_history", rows: [{ grade: "A", score: 80, recorded_at: 1700000000 }] },
      {
        match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL",
        rows: [{ direction: "below", peak_deviation_bps: 180, started_at: 1700000000, peg_reference: 1.0 }],
      },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [{ price: 0.982, updated_at: 1700000500 }] },
    ]);
    const status = await loadStatusForCoin(db, "usdc-circle");
    expect(status.depeg.status).toBe("active");
    if (status.depeg.status === "active") {
      expect(status.depeg.direction).toBe("below");
      expect(status.depeg.peakDeviationBps).toBe(180);
    }
  });

  it("handles a fully unseeded coin gracefully (null everywhere)", async () => {
    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [] },
    ]);
    const status = await loadStatusForCoin(db, "newcoin-xyz");
    expect(status.dews).toBeNull();
    expect(status.safety).toBeNull();
    expect(status.priceUsd).toBeNull();
    expect(status.depeg.status).toBe("stable");
  });

  it("uses schema-correct column names", async () => {
    // Regression guard: the dispatcher uses `computed_at` on stress_signals and
    // does not query the legacy safety history table.
    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [] },
    ]);
    await loadStatusForCoin(db, "usdc-circle");
    const history = db.getHistory().map((h) => h.sql);

    const stressSql = history.find((s) => s.includes("FROM stress_signals"));
    expect(stressSql).toMatch(/\bcomputed_at\b/);
    expect(stressSql).not.toMatch(/\brecorded_at\b/);

    expect(history.some((s) => s.includes("safety_grade_history"))).toBe(false);

    const priceSql = history.find((s) => s.includes("FROM price_cache"));
    expect(priceSql).toMatch(/\basset_id\b/);
    expect(priceSql).toMatch(/\bupdated_at\b/);

    const depegSql = history.find((s) => s.includes("FROM depeg_events"));
    expect(depegSql).toMatch(/\bpeak_deviation_bps\b/);
    expect(depegSql).toMatch(/\bpeg_reference\b/);

    const yieldSql = history.find((s) => s.includes("FROM yield_data"));
    expect(yieldSql).toContain("publication_generation_id IS NULL OR publication_state = 'published'");
  });

  it("fails closed when canonical safety identity is unavailable", async () => {
    mocks.loadIdentifiedActiveSafetyScoreSource.mockResolvedValueOnce({
      kind: "error",
      expectedModel: "v9",
      reason: "v9-snapshot-unavailable",
      detail: "missing",
    });
    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [] },
    ]);

    const status = await loadStatusForCoin(db, "usdc-circle");

    expect(status.safety).toBeNull();
    expect(status.safetyUnavailableReason).toBe("v9-snapshot-unavailable");
    expect(db.getHistory().some((entry) => entry.sql.includes("safety_grade_history"))).toBe(false);
  });

  it("returns yield status from published or legacy rows only", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE stress_signals (
          stablecoin_id TEXT NOT NULL,
          band TEXT NOT NULL,
          score REAL NOT NULL,
          computed_at INTEGER NOT NULL
        );
        CREATE TABLE safety_grade_history (
          stablecoin_id TEXT NOT NULL,
          grade TEXT NOT NULL,
          score REAL,
          recorded_at INTEGER NOT NULL
        );
        CREATE TABLE depeg_events (
          stablecoin_id TEXT NOT NULL,
          direction TEXT NOT NULL,
          peak_deviation_bps REAL NOT NULL,
          peg_reference REAL NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER
        );
        CREATE TABLE price_cache (
          asset_id TEXT PRIMARY KEY,
          price REAL NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE dex_liquidity (
          stablecoin_id TEXT PRIMARY KEY,
          liquidity_score REAL,
          total_tvl_usd REAL NOT NULL,
          updated_at INTEGER NOT NULL,
          publication_generation_id TEXT,
          publication_state TEXT
        );
        CREATE TABLE dex_liquidity_publication_generations (
          generation_id TEXT PRIMARY KEY,
          state TEXT NOT NULL
        );
        CREATE TABLE yield_data (
          stablecoin_id TEXT NOT NULL,
          is_best INTEGER NOT NULL,
          current_apy REAL NOT NULL,
          apy_30d REAL NOT NULL,
          yield_source TEXT NOT NULL,
          pharos_yield_score REAL,
          updated_at INTEGER NOT NULL,
          publication_generation_id TEXT,
          publication_state TEXT
        );
      `);
      const insertYield = sqlite.prepare(
        `INSERT INTO yield_data (
          stablecoin_id, is_best, current_apy, apy_30d, yield_source,
          pharos_yield_score, updated_at, publication_generation_id, publication_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertYield.run("usdc-circle", 1, 9, 9, "Failed source", 90, 3, "gen-failed", "failed");
      insertYield.run("usdc-circle", 1, 8, 8, "Staged source", 80, 2, "gen-staged", "staged");
      insertYield.run("usdc-circle", 1, 4.4, 4.2, "Published source", 31, 1, "gen-published", "published");

      const status = await loadStatusForCoin(createSqliteD1(sqlite), "usdc-circle");

      expect(status.yield?.source).toBe("Published source");
      expect(status.yield).toMatchObject({
        pharosYieldScore: null,
        pysUnavailableReason: "pys-v8-retired",
      });
    } finally {
      sqlite.close();
    }
  });
});

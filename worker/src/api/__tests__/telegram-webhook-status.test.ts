import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { loadStatusForCoin } from "../telegram-webhook-status";
import { buildStatusMessage } from "../telegram-webhook-messages";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";

const mocks = vi.hoisted(() => ({
  loadActiveSafetyScoreSource: vi.fn(),
  loadActiveV8SafetyScoreHistorySource: vi.fn(),
}));

vi.mock("../../lib/safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: mocks.loadActiveSafetyScoreSource,
}));

vi.mock("../../lib/safety-score-history-v2", () => ({
  loadActiveV8SafetyScoreHistorySource: mocks.loadActiveV8SafetyScoreHistorySource,
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("loadStatusForCoin", () => {
  beforeEach(() => {
    mocks.loadActiveSafetyScoreSource.mockReset().mockResolvedValue({
      kind: "v8",
      expectedModel: "v8",
      reason: "activation-marker-missing",
      activationUpdatedAt: null,
    });
    mocks.loadActiveV8SafetyScoreHistorySource.mockReset().mockResolvedValue({
      identity: {
        model: "v8",
        schemaVersion: 1,
        methodologyVersion: "v8.17",
        evaluationBuildDigest: "a".repeat(64),
        baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
        publicationGenerationId: "report-cards:v8.17:123",
      },
      publishedAtSec: 123,
      snapshot: { cards: [{ id: "usdc-circle", isDefunct: false, overallGrade: "B+", overallScore: 66 }] },
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
    expect(status.safety?.model).toBe("v8");
    expect(status.safety?.publicationGenerationId).toBe("report-cards:v8.17:123");
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
    mocks.loadActiveV8SafetyScoreHistorySource.mockRejectedValueOnce(new Error("identity mismatch"));
    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [] },
    ]);

    const status = await loadStatusForCoin(db, "usdc-circle");

    expect(status.safety).toBeNull();
    expect(status.safetyUnavailableReason).toBe("canonical-snapshot-unavailable");
    expect(db.getHistory().some((entry) => entry.sql.includes("safety_grade_history"))).toBe(false);
  });

  it.each([
    [
      "an active V9 marker",
      { kind: "v9", expectedModel: "v9" },
      "active-model-v9",
    ],
    [
      "a malformed V9 marker",
      { kind: "error", expectedModel: "v9", reason: "activation-marker-invalid" },
      "activation-marker-invalid",
    ],
    [
      "a mismatched V9 identity",
      { kind: "error", expectedModel: "v9", reason: "v9-identity-mismatch" },
      "v9-identity-mismatch",
    ],
  ] as const)("keeps /status market data but withholds Safety and PYS for %s", async (
    _label,
    activeSource,
    expectedReason,
  ) => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValue(activeSource);
    const db = mockD1([
      {
        match: "FROM yield_data",
        rows: [
          {
            current_apy: 4.4,
            apy_30d: 4.2,
            yield_source: "Aave V3",
            pharos_yield_score: 99,
            updated_at: 1_800_000_000,
          },
        ],
      },
      {
        match: "FROM price_cache WHERE asset_id = ?",
        rows: [{ price: 0.9998, updated_at: 1_800_000_000 }],
      },
    ]);

    const status = await loadStatusForCoin(db, "usdc-circle");
    const message = buildStatusMessage("USDC", status);

    expect(status.priceUsd).toBeCloseTo(0.9998);
    expect(status.safety).toBeNull();
    expect(status.safetyUnavailableReason).toBe(expectedReason);
    expect(status.expectedSafetyScoreModel).toBe("v9");
    expect(status.yield).toMatchObject({
      apy30d: 4.2,
      source: "Aave V3",
      pharosYieldScore: null,
      pysUnavailableReason: expectedReason,
    });
    expect(message).toContain("Safety: temporarily unavailable");
    expect(message).toContain("Yield: 4.20% 30d at Aave V3, PYS unavailable");
    expect(message).not.toContain("PYS 99");
    expect(mocks.loadActiveV8SafetyScoreHistorySource).not.toHaveBeenCalled();
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
      expect(status.yield?.pharosYieldScore).toBe(31);
    } finally {
      sqlite.close();
    }
  });
});

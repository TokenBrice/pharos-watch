import { afterEach, describe, expect, it, vi } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { buildSafetyScoreV8PublicationIdentity } from "@shared/lib/safety-score-v8-publication";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  buildBriefMessage,
  buildCoverageMessage,
  buildTopMessage,
  buildWhyMessage,
} from "../telegram-webhook-insights";
import type { StatusForCoin } from "../telegram-webhook-status";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";

const mocks = vi.hoisted(() => ({
  loadActiveV8SafetyScoreHistorySource: vi.fn(),
}));

vi.mock("../../lib/safety-score-history-v2", () => ({
  loadActiveV8SafetyScoreHistorySource: mocks.loadActiveV8SafetyScoreHistorySource,
}));

function makeTopChainsDb(reportCardCache: unknown, updatedAt: number) {
  return mockD1(
    [
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: {
          key: "stablecoins",
          value: JSON.stringify({
            peggedAssets: [
              {
                id: "usdc-circle",
                symbol: "USDC",
                price: 1,
                pegType: "peggedUSD",
                circulating: { peggedUSD: 100 },
                chainCirculating: { ethereum: { current: 100 } },
              },
            ],
          }),
          updated_at: updatedAt,
        },
      },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["report_card_cache"],
        rows: [],
        first: {
          key: "report_card_cache",
          value: JSON.stringify(reportCardCache),
          updated_at: updatedAt,
        },
      },
    ],
    { requireMatch: true },
  );
}

function makeCompleteReportCardCache(updatedAt: number) {
  const publicationGenerationId = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${updatedAt}`;
  return {
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    updatedAt,
    scores: Object.fromEntries([...ACTIVE_IDS].map((id) => [id, { score: 99, grade: "A+" }])),
    safetyScoreIdentity: buildSafetyScoreV8PublicationIdentity({
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
      publicationGenerationId,
    }),
    publicationGenerationId,
    completeness: {
      generationId: publicationGenerationId,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      expectedCount: ACTIVE_IDS.size,
      scoredCount: ACTIVE_IDS.size,
      notRatedCount: 0,
      notRatedIds: [],
    },
  };
}

describe("buildBriefMessage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flags stale digest briefs without suppressing the stored brief text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));
    const generatedAt = Math.floor(new Date("2026-05-11T12:00:00Z").getTime() / 1000);
    const db = mockD1([
      {
        match: "FROM daily_digest",
        rows: [
          {
            digest_title: "Calm Drift",
            digest_text: "Stored brief body.",
            digest_extended: null,
            generated_at: generatedAt,
            input_data: null,
          },
        ],
      },
    ]);

    const message = await buildBriefMessage(db);

    expect(message).toContain("Updated: 3d old");
    expect(message).toContain("May be stale: latest digest is 3d old.");
    expect(message).toContain("Stored brief body.");
  });
});

describe("buildTopMessage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds /top depeg from schema-correct depeg_events columns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));

    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: 180,
            display_price: 0.982,
            peg_reference: 1,
            started_at: Math.floor(Date.now() / 1000) - 3600,
          },
        ],
      },
    ]);

    const message = await buildTopMessage(db, "depeg");

    expect(message).toContain("Top active depegs");
    expect(message).toContain("USDC");
    expect(message).toContain("below peg 1.8%");
    expect(message).toContain("price $0.9820");

    const sql = db.getHistory()[0]?.sql ?? "";
    expect(sql).toMatch(/\bCOALESCE\(peak_price,\s*start_price\) AS display_price\b/);
    expect(sql).not.toMatch(/\bSELECT\b[\s\S]*,\s*price\s*,[\s\S]*\bFROM depeg_events\b/);
  });

  it("builds /top dews only from the exact published generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const publishedAt = nowSec - 60;
    const rows = [
      { stablecoin_id: "usdc-circle", score: 44, band: "WATCH", signals_json: "{}", computed_at: publishedAt },
      { stablecoin_id: "usdt-tether", score: 72, band: "WARNING", signals_json: "{}", computed_at: publishedAt },
    ];
    const pointer = {
      key: "dews:published-generation",
      value: JSON.stringify({
        updatedAt: publishedAt,
        source: "compute-dews",
        publishStatus: "published",
        coverageVersion: 2,
        expectedRowCount: rows.length,
        stablecoinIdsDigest: buildDewsStablecoinIdsDigest(rows.map((row) => row.stablecoin_id)),
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
        match: "pharos:stress-signals:published-exact",
        matchBinds: [publishedAt],
        rows,
      },
      {
        match: "MAX(computed_at)",
        rows: [{ stablecoin_id: "staged", score: 100, band: "CRITICAL", computed_at: nowSec }],
      },
    ]);

    const message = await buildTopMessage(db, "dews");

    expect(message).toContain("1. USDT");
    expect(message).toContain("2. USDC");
    expect(message).not.toContain("staged");
    expect(db.getHistory().some((entry) => entry.sql.includes("MAX(computed_at)"))).toBe(false);
  });

  it("falls back to usage text for unknown /top views", async () => {
    const db = mockD1([], { requireMatch: true });

    await expect(buildTopMessage(db, "unknown")).resolves.toBe("Usage: /top depeg|dews|yield|liquidity|chains|safety");
    expect(db.getHistory()).toEqual([]);
  });

  it("filters /top yield rows to legacy or published yield_data rows", async () => {
    const db = mockD1([
      {
        match: "FROM yield_data",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            current_apy: 4.4,
            apy_30d: 4.2,
            yield_source: "Aave V3",
            pharos_yield_score: 31,
            source_tvl_usd: 12_000_000,
          },
        ],
      },
    ]);

    const message = await buildTopMessage(db, "yield");

    expect(message).toContain("Top risk-adjusted yields");
    expect(message).toContain("USDC");
    const yieldSql = db.getHistory().find((entry) => entry.sql.includes("FROM yield_data"))?.sql;
    expect(yieldSql).toContain("publication_generation_id IS NULL OR publication_state = 'published'");
  });

  it("excludes staged and failed /top yield rows behaviorally", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE yield_data (
          stablecoin_id TEXT NOT NULL,
          symbol TEXT NOT NULL,
          is_best INTEGER NOT NULL,
          current_apy REAL NOT NULL,
          apy_30d REAL NOT NULL,
          yield_source TEXT NOT NULL,
          pharos_yield_score REAL,
          source_tvl_usd REAL,
          publication_generation_id TEXT,
          publication_state TEXT
        );
      `);
      const insertYield = sqlite.prepare(
        `INSERT INTO yield_data (
          stablecoin_id, symbol, is_best, current_apy, apy_30d, yield_source,
          pharos_yield_score, source_tvl_usd, publication_generation_id, publication_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertYield.run("usdt-tether", "USDT", 1, 9, 9, "Failed source", 99, 100_000_000, "gen-failed", "failed");
      insertYield.run("usde-ethena", "USDe", 1, 8, 8, "Staged source", 88, 90_000_000, "gen-staged", "staged");
      insertYield.run(
        "usdc-circle",
        "USDC",
        1,
        4.4,
        4.2,
        "Published source",
        31,
        12_000_000,
        "gen-published",
        "published",
      );
      insertYield.run("dai-makerdao", "DAI", 1, 3.1, 3, "Legacy source", 22, 8_000_000, null, null);

      const message = await buildTopMessage(createSqliteD1(sqlite), "yield");

      expect(message).toContain("USDC");
      expect(message).toContain("DAI");
      expect(message).not.toContain("USDT");
      expect(message).not.toContain("USDe");
    } finally {
      sqlite.close();
    }
  });

  it("fails closed to NR chain health when compact report-card safety data is incomplete or identity-invalid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00Z"));
    const updatedAt = Math.floor(Date.now() / 1000);
    const trustedCache = makeCompleteReportCardCache(updatedAt);
    const invalidIdentityCache = {
      ...trustedCache,
      safetyScoreIdentity: {
        ...trustedCache.safetyScoreIdentity,
        evaluationBuildDigest:
          trustedCache.safetyScoreIdentity.evaluationBuildDigest === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64),
      },
    };
    const incompleteCache = {
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      updatedAt,
      scores: { "usdc-circle": { score: 99, grade: "A+" } },
    };

    const trustedMessage = await buildTopMessage(makeTopChainsDb(trustedCache, updatedAt), "chains");
    expect(trustedMessage).toMatch(/health \d/);

    for (const reportCardCache of [incompleteCache, invalidIdentityCache]) {
      const message = await buildTopMessage(makeTopChainsDb(reportCardCache, updatedAt), "chains");

      expect(message).toContain("Top chains by stablecoin supply");
      expect(message).toContain("Ethereum");
      expect(message).toContain("health NR (null)");
      expect(message).not.toMatch(/health \d/);
    }
  });

  it("suggests the closest /top view for one-character typos", async () => {
    const db = mockD1([], { requireMatch: true });

    await expect(buildTopMessage(db, "dewz")).resolves.toBe(
      "Did you mean /top dews?\nUsage: /top depeg|dews|yield|liquidity|chains|safety",
    );
    await expect(buildTopMessage(db, "safty")).resolves.toBe(
      "Did you mean /top safety?\nUsage: /top depeg|dews|yield|liquidity|chains|safety",
    );
    expect(db.getHistory()).toEqual([]);
  });

  it("reads /top safety only from the canonical identified V8 source", async () => {
    mocks.loadActiveV8SafetyScoreHistorySource.mockResolvedValueOnce({
      identity: {
        model: "v8",
        schemaVersion: 1,
        methodologyVersion: "v8.17",
        evaluationBuildDigest: "a".repeat(64),
        baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
        publicationGenerationId: "report-cards:v8.17:123",
      },
      publishedAtSec: 123,
      snapshot: {
        cards: [{ id: "usdc-circle", symbol: "USDC", isDefunct: false, overallGrade: "A", overallScore: 90 }],
      },
    });
    const db = mockD1([], { requireMatch: true });

    const message = await buildTopMessage(db, "safety");

    expect(message).toContain("Top Safety Scores (V8)");
    expect(message).toContain("USDC");
    expect(mocks.loadActiveV8SafetyScoreHistorySource).toHaveBeenCalledWith(db);
    expect(db.getHistory()).toEqual([]);
  });

  it("returns explicit unavailable safety text when the canonical identity cannot be read", async () => {
    mocks.loadActiveV8SafetyScoreHistorySource.mockRejectedValueOnce(new Error("identity mismatch"));
    const db = mockD1([], { requireMatch: true });

    await expect(buildTopMessage(db, "safety")).resolves.toBe("Safety scores are temporarily unavailable.");
    mocks.loadActiveV8SafetyScoreHistorySource.mockRejectedValueOnce(new Error("identity mismatch"));
    await expect(buildWhyMessage(db, "usdc-circle")).resolves.toBe("Safety Score is temporarily unavailable.");
    expect(db.getHistory()).toEqual([]);
  });

  it("includes canonical V8 provenance in /why without on-demand recomputation", async () => {
    mocks.loadActiveV8SafetyScoreHistorySource.mockResolvedValueOnce({
      identity: {
        model: "v8",
        schemaVersion: 1,
        methodologyVersion: "v8.17",
        evaluationBuildDigest: "a".repeat(64),
        baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
        publicationGenerationId: "report-cards:v8.17:123",
      },
      publishedAtSec: 123,
      snapshot: {
        cards: [
          {
            id: "usdc-circle",
            symbol: "USDC",
            isDefunct: false,
            overallGrade: "A",
            overallScore: 90,
            dimensions: {
              pegStability: { grade: "A", score: 90, detail: "Stable" },
              liquidity: { grade: "A", score: 88, detail: "Deep" },
            },
            rawInputs: { activeDepeg: false, canBeBlacklisted: false, dependencies: [], collateralFromLive: false },
          },
        ],
      },
    });
    const db = mockD1([], { requireMatch: true });

    const message = await buildWhyMessage(db, "usdc-circle");

    expect(message).toContain("Model: V8 · v8.17 · report-cards:v8.17:123");
    expect(message).toContain("Weakest dimensions");
    expect(db.getHistory()).toEqual([]);
  });
});

describe("buildCoverageMessage", () => {
  it("escapes provider-controlled yield source text", () => {
    const status: StatusForCoin = {
      stablecoinId: "usdc-circle",
      priceUsd: 1,
      priceUpdatedAt: null,
      supplyUsd: null,
      stablecoinsUpdatedAt: null,
      dews: null,
      safety: null,
      safetyUnavailableReason: null,
      liquidity: null,
      yield: {
        currentApy: 4.8,
        apy30d: 4.2,
        source: 'Pendle: PT-USDC <a href="https://attacker.example/phish">CLAIM</a> & <i>boost</i>',
        pharosYieldScore: 42,
        updatedAt: Math.floor(Date.now() / 1000),
      },
      flow: null,
      depeg: { status: "stable" },
    };

    const message = buildCoverageMessage("USDC", status);

    expect(message).toContain(
      "Pendle: PT-USDC &lt;a href=&quot;https://attacker.example/phish&quot;&gt;CLAIM&lt;/a&gt; &amp; &lt;i&gt;boost&lt;/i&gt;",
    );
    expect(message).not.toContain('<a href="https://attacker.example/phish">');
    expect(message).not.toContain("<i>boost</i>");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  buildBriefMessage,
  buildCoverageMessage,
  buildTopMessage,
  buildWhyMessage,
} from "../telegram-webhook-insights";
import type { StatusForCoin } from "../telegram-webhook-status";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
  makeWorkerV9Pillars,
} from "../../test-helpers/report-cards-v9";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

const mocks = vi.hoisted(() => ({
  loadActiveSafetyScoreSource: vi.fn(),
}));

vi.mock("../../lib/safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: mocks.loadActiveSafetyScoreSource,
}));

function activeV9() {
  const snapshot = makeWorkerReportCardsV9Response({
    cards: [
      makeWorkerV9Card({
        id: "usdc-circle",
        grade: "A",
        score: 90,
      }),
    ],
  });
  return {
    kind: "v9" as const,
    snapshot,
  };
}

function makeTopChainsDb(updatedAt: number) {
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
    ],
    { requireMatch: true },
  );
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

  it("selects the daily brief rather than a newer weekly digest", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const insert = sqlite.prepare(`INSERT INTO daily_digest
        (generated_at, digest_text, input_data, digest_meta) VALUES (?, ?, '{}', ?)`);
      insert.run(100, "daily chosen", null);
      insert.run(200, "weekly excluded", '{"type":"weekly"}');
      const message = await buildBriefMessage(db);
      expect(message).toContain("daily chosen");
      expect(message).not.toContain("weekly excluded");
    } finally {
      sqlite.close();
    }
  });

  it("caps structured sections and suppresses fallback text", async () => {
    const input = {
      riskTape: Array.from({ length: 5 }, (_, i) => ({ label: `risk${i}`, value: `value${i}` })),
      changeSummary: {
        newSignals: [{ label: "new", detail: "new detail" }],
        worsenedSignals: [{ label: "worse", detail: "worse detail" }],
        resolvedSignals: Array.from({ length: 3 }, (_, i) => ({ label: `resolved${i}`, detail: "resolved detail" })),
      },
      nextTriggers: Array.from({ length: 4 }, (_, i) => ({ label: `trigger${i}`, thresholdLabel: `threshold${i}` })),
    };
    const message = await buildBriefMessage(mockD1([{ match: "FROM daily_digest", rows: [{
      generated_at: Math.floor(Date.now() / 1000), digest_text: "fallback excluded", input_data: JSON.stringify(input),
    }] }]));
    for (const text of ["risk3: value3", "new: new detail", "worse: worse detail", "resolved1: resolved detail", "trigger2: threshold2"]) {
      expect(message).toContain(text);
    }
    for (const text of ["risk4", "resolved2", "trigger3", "fallback excluded"]) {
      expect(message).not.toContain(text);
    }
  });

  it.each([
    { text: "<daily>", extended: "<extended>", expected: "&lt;daily&gt;" },
    { text: null, extended: "<extended>", expected: "&lt;extended&gt;" },
  ])("escapes fallback text for malformed structured data: $expected", async ({ text, extended, expected }) => {
    const message = await buildBriefMessage(mockD1([{ match: "FROM daily_digest", rows: [{
      generated_at: Math.floor(Date.now() / 1000), digest_text: text, digest_extended: extended, input_data: "{",
    }] }]));
    expect(message).toContain(expected);
    expect(message).not.toContain(text ?? extended);
  });

  it("marks a brief stale only after exactly 48 hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const db = mockD1([{ match: "FROM daily_digest", rows: [{
      generated_at: 1_800_000_000 - 48 * 3600, digest_text: "boundary body", input_data: "{}",
    }] }]);
    expect(await buildBriefMessage(db)).not.toContain("May be stale");
    vi.advanceTimersByTime(1000);
    expect(await buildBriefMessage(db)).toContain("May be stale");
  });
});

describe("buildTopMessage", () => {
  beforeEach(() => {
    mocks.loadActiveSafetyScoreSource.mockReset().mockResolvedValue(activeV9());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds /top depeg from schema-correct depeg_events columns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));

    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const insert = sqlite.prepare(`INSERT INTO depeg_events
        (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at,
         ended_at, start_price, peak_price, peg_reference)
        VALUES (?, ?, 'peggedUSD', 'below', ?, 1, ?, ?, ?, 1)`);
      insert.run("usdc-circle", "USDC", 180, null, 0.99, 0.982);
      insert.run("dai-makerdao", "DAI", 100, null, 0.99, null);
      insert.run("usdt-tether", "USDT", 900, 2, 0.91, 0.90);
      const message = await buildTopMessage(db, "depeg");
      expect(message).toContain("1. USDC");
      expect(message).toContain("below peg 1.8%");
      expect(message).toContain("price $0.9820");
      expect(message).toContain("2. DAI");
      expect(message).toContain("price $0.9900");
      expect(message).not.toContain("USDT");
    } finally {
      sqlite.close();
    }
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

  it("excludes staged and failed /top yield rows behaviorally", async () => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValue({
      kind: "error", reason: "v9-snapshot-unavailable", snapshot: null, detail: "missing",
    });
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
            const insertYield = sqlite.prepare(
        `INSERT INTO yield_data (
          stablecoin_id, source_key, symbol, is_best, current_apy, apy_7d, apy_30d, yield_source,
          yield_type, data_source, updated_at,
          pharos_yield_score, source_tvl_usd, publication_generation_id, publication_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'lending', 'defillama', 1, ?, ?, ?, ?)`,
      );
      insertYield.run("usdt-tether", "usdt-source", "USDT", 1, 9, 9, 9, "Failed source", 99, 100_000_000, "gen-failed", "failed");
      insertYield.run("usde-ethena", "usde-source", "USDe", 1, 8, 8, 8, "Staged source", 88, 90_000_000, "gen-staged", "staged");
      insertYield.run(
        "usdc-circle",
        "usdc-source",
        "USDC",
        1,
        4.4,
        4.3,
        4.2,
        "Published source",
        31,
        12_000_000,
        "gen-published",
        "published",
      );
      insertYield.run("dai-makerdao", "dai-source", "DAI", 1, 3.1, 3.05, 3, "Legacy source", 99, 8_000_000, null, null);

      const message = await buildTopMessage(createSqliteD1(sqlite), "yield");

      expect(message).toContain("1. USDC");
      expect(message).toContain("2. DAI");
      expect(message).toContain("PYS unavailable");
      expect(message).not.toContain("PYS 99");
      expect(message).not.toContain("USDT");
      expect(message).not.toContain("USDe");
    } finally {
      sqlite.close();
    }
  });

  it("derives chain health from the canonical V9 publication", async () => {
    const updatedAt = Math.floor(Date.now() / 1000);
    const message = await buildTopMessage(makeTopChainsDb(updatedAt), "chains");

    expect(message).toContain("Top chains by stablecoin supply");
    expect(message).toContain("Ethereum");
    expect(message).toMatch(/health \d/);
  });

  it("fails closed when the canonical V9 publication is unavailable", async () => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValue({
      kind: "error",
      reason: "v9-snapshot-unavailable",
      snapshot: null,
      detail: "missing",
    });
    const updatedAt = Math.floor(Date.now() / 1000);
    const chainsDb = makeTopChainsDb(updatedAt);
    const yieldDb = mockD1([
      {
        match: "FROM yield_data",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            current_apy: 4.4,
            apy_30d: 4.2,
            yield_source: "Aave V3",
            pharos_yield_score: 99,
            source_tvl_usd: 12_000_000,
          },
        ],
      },
    ]);

    const [chainsMessage, yieldMessage] = await Promise.all([
      buildTopMessage(chainsDb, "chains"),
      buildTopMessage(yieldDb, "yield"),
    ]);

    expect(chainsMessage).toContain("Top chains by stablecoin supply");
    expect(chainsMessage).toContain("Ethereum");
    expect(chainsMessage).toContain("health NR (null)");
    expect(chainsMessage).toContain(
      "Chain health unavailable; expected model V9, v9 snapshot unavailable.",
    );

    expect(yieldMessage).toContain(
      "Top yields (PYS unavailable; expected model V9, v9 snapshot unavailable)",
    );
    expect(yieldMessage).toContain("USDC");
    expect(yieldMessage).toContain("4.20% 30d");
    expect(yieldMessage).toContain("PYS unavailable");
    expect(yieldMessage).not.toContain("PYS 99");
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

  it("reads /top safety only from the canonical V9 source", async () => {
    const db = mockD1([], { requireMatch: true });

    const message = await buildTopMessage(db, "safety");

    expect(message).toContain("Top Safety Scores (V9)");
    expect(message).toContain("USDC");
    expect(mocks.loadActiveSafetyScoreSource).toHaveBeenCalledWith(db);
    expect(db.getHistory()).toEqual([]);
  });

  it("returns explicit unavailable safety text when the canonical identity cannot be read", async () => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValue({
      kind: "error",
      reason: "v9-snapshot-unavailable",
      snapshot: null,
      detail: "missing",
    });
    const db = mockD1([], { requireMatch: true });

    await expect(buildTopMessage(db, "safety")).resolves.toBe("Safety scores are temporarily unavailable.");
    await expect(buildWhyMessage(db, "usdc-circle")).resolves.toBe("Safety Score is temporarily unavailable.");
    expect(db.getHistory()).toEqual([]);
  });

  it("includes canonical V9 provenance in /why without on-demand recomputation", async () => {
    const db = mockD1([], { requireMatch: true });

    const message = await buildWhyMessage(db, "usdc-circle");

    expect(message).toContain("Model: V9 · 9.0 · report-cards:v9:1");
    expect(message).toContain("Weakest pillars");
    expect(db.getHistory()).toEqual([]);
  });

  it("ranks only the five highest rated cards from unordered input", async () => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValue({
      kind: "v9",
      snapshot: makeWorkerReportCardsV9Response({ cards: [
        ...[40, 90, 20, 80, 70, 60].map((score) => makeWorkerV9Card({ id: `coin-${score}`, score, grade: "A" })),
        makeWorkerV9Card({ id: "unrated", score: null }),
      ] }),
    });
    const message = await buildTopMessage(mockD1([]), "safety");
    expect(message.split("\n").slice(1)).toEqual([
      "1. coin-90 — A (90)", "2. coin-80 — A (80)", "3. coin-70 — A (70)",
      "4. coin-60 — A (60)", "5. coin-40 — A (40)",
    ]);
  });

  it("selects the weakest scored pillars and includes caps and dependency exposure", async () => {
    const card = makeWorkerV9Card({
      id: "usdc-circle",
      pillars: makeWorkerV9Pillars({ backing: null, exit: 30, control: 12 }),
      caps: [{ kind: "structural", limit: 80, source: "structural", reason: "reviewed limit", binding: true }],
      dependencies: {
        serial: [{ upstreamAssetId: "usdt-tether", score: 80, blocked: false }],
        basket: [{ upstreamAssetId: "dai-makerdao", weight: 0.5, score: 70, boundedUnknown: false }],
        cycleBlocked: false, reasonCodes: [],
      },
    });
    mocks.loadActiveSafetyScoreSource.mockResolvedValue({
      kind: "v9", snapshot: makeWorkerReportCardsV9Response({ cards: [card] }),
    });
    const message = await buildWhyMessage(mockD1([]), "usdc-circle");
    expect(message).toContain("- Control: 12\n- Exit: 30");
    expect(message).not.toContain("- Backing:");
    expect(message).toContain("1 active score cap");
    expect(message).toContain("freeze exposure: direct");
    expect(message).toContain("2 modeled dependencies");
    expect(await buildWhyMessage(mockD1([]), "missing-coin")).toBe("No Safety Score is available for that coin yet.");
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

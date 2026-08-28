import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, it, expect } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleStressSignals } from "../stress-signals";
import {
  StressSignalsAllResponseSchema,
  StressSignalDetailResponseSchema,
} from "@shared/types/market";
import { ACTIVE_IDS, PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";

const nowSec = Math.floor(Date.now() / 1000);
const completedDewsAt = nowSec - 60;
const preLaunchStablecoinId = PRE_LAUNCH_STABLECOINS[0]?.id;
if (!preLaunchStablecoinId) {
  throw new Error("stress-signals tests require at least one pre-launch stablecoin");
}

const signalsJson = JSON.stringify({
  supply: { value: 10, available: true },
  price: { value: 5, available: true },
});

const AGGREGATE_STRESS_SIGNALS_SQL = `
  SELECT /* pharos:stress-signals:legacy-latest-all */
    s.stablecoin_id, s.score, s.band, s.signals_json, s.computed_at
  FROM stress_signals s
  INNER JOIN (
    SELECT stablecoin_id, MAX(computed_at) as max_at
    FROM stress_signals GROUP BY stablecoin_id
  ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at
`;

const AGGREGATE_STRESS_SIGNALS_CUTOFF_SQL = `
  SELECT /* pharos:stress-signals:legacy-latest-all */
    s.stablecoin_id, s.score, s.band, s.signals_json, s.computed_at
  FROM stress_signals s
  INNER JOIN (
    SELECT stablecoin_id, MAX(computed_at) as max_at
    FROM stress_signals
    WHERE computed_at <= ?
    GROUP BY stablecoin_id
  ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at
`;

const LATEST_AGGREGATE_STRESS_SIGNALS_SQL = `
  SELECT /* pharos:stress-signals:latest-all */
    stablecoin_id, score, band, signals_json, computed_at
  FROM stress_signals_latest
`;

const LATEST_AGGREGATE_STRESS_SIGNALS_CUTOFF_SQL = `
  SELECT /* pharos:stress-signals:latest-all */
    stablecoin_id, score, band, signals_json, computed_at
  FROM stress_signals_latest
  WHERE computed_at <= ?
`;

const LATEST_STRESS_SIGNAL_SQL = `
  SELECT /* pharos:stress-signals:latest-one */
    score, band, signals_json, computed_at
  FROM stress_signals_latest
  WHERE stablecoin_id = ?
`;

const LATEST_STRESS_SIGNAL_CUTOFF_SQL = `
  SELECT /* pharos:stress-signals:latest-one */
    score, band, signals_json, computed_at
  FROM stress_signals_latest
  WHERE stablecoin_id = ? AND computed_at <= ?
  ORDER BY computed_at DESC LIMIT 1
`;

const LEGACY_STRESS_SIGNAL_SQL = `
  SELECT /* pharos:stress-signals:legacy-latest-one */
    score, band, signals_json, computed_at
  FROM stress_signals
  WHERE stablecoin_id = ?
  ORDER BY computed_at DESC LIMIT 1
`;

const LEGACY_STRESS_SIGNAL_CUTOFF_SQL = `
  SELECT /* pharos:stress-signals:legacy-latest-one */
    score, band, signals_json, computed_at
  FROM stress_signals
  WHERE stablecoin_id = ? AND computed_at <= ?
  ORDER BY computed_at DESC LIMIT 1
`;

const STRESS_SIGNAL_HISTORY_SQL = `
  SELECT /* pharos:stress-signals:history-one */
    snapshot_date, score, band, signals_json
  FROM stress_signal_history
  WHERE stablecoin_id = ? AND snapshot_date >= ?
  ORDER BY snapshot_date ASC
`;

const PUBLICATION_POINTER_SQL = `
  SELECT value, updated_at FROM cache WHERE key = ?
`;

function dewsPublicationPointerMatch(updatedAt: number | null = null) {
  return {
    match: PUBLICATION_POINTER_SQL,
    matchBinds: ["dews:published-generation"],
    rows: updatedAt == null
      ? []
      : [{
          key: "dews:published-generation",
          value: JSON.stringify({ updatedAt, source: "compute-dews", publishStatus: "published" }),
          updated_at: updatedAt,
        }],
    first: updatedAt == null
      ? null
      : {
          key: "dews:published-generation",
          value: JSON.stringify({ updatedAt, source: "compute-dews", publishStatus: "published" }),
          updated_at: updatedAt,
        },
  };
}

function invalidDewsPublicationPointerMatch() {
  return {
    match: PUBLICATION_POINTER_SQL,
    matchBinds: ["dews:published-generation"],
    rows: [{
      key: "dews:published-generation",
      value: JSON.stringify({
        updatedAt: completedDewsAt,
        source: "compute-dews",
        publishStatus: "draft",
      }),
      updated_at: completedDewsAt,
    }],
    first: {
      key: "dews:published-generation",
      value: JSON.stringify({
        updatedAt: completedDewsAt,
        source: "compute-dews",
        publishStatus: "draft",
      }),
      updated_at: completedDewsAt,
    },
  };
}

function makeStrictAggregateDb(rows: Record<string, unknown>[], completedAt: number | null = null) {
  return mockD1([
    dewsPublicationPointerMatch(completedAt),
    {
      match: completedAt == null ? AGGREGATE_STRESS_SIGNALS_SQL : AGGREGATE_STRESS_SIGNALS_CUTOFF_SQL,
      ...(completedAt == null ? {} : { matchBinds: [completedAt] }),
      rows,
    },
  ], { strict: true });
}

function makeStrictLatestAggregateDb(
  rows: Record<string, unknown>[],
  legacyRows: Record<string, unknown>[] = [],
  completedAt: number | null = null,
) {
  return mockD1([
    dewsPublicationPointerMatch(completedAt),
    {
      match: completedAt == null ? LATEST_AGGREGATE_STRESS_SIGNALS_SQL : LATEST_AGGREGATE_STRESS_SIGNALS_CUTOFF_SQL,
      ...(completedAt == null ? {} : { matchBinds: [completedAt] }),
      rows,
    },
    {
      match: completedAt == null ? AGGREGATE_STRESS_SIGNALS_SQL : AGGREGATE_STRESS_SIGNALS_CUTOFF_SQL,
      ...(completedAt == null ? {} : { matchBinds: [completedAt] }),
      rows: legacyRows,
    },
  ], { strict: true });
}

function makeStrictSingleCoinDb(
  current: Record<string, unknown> | null,
  historyRows: Record<string, unknown>[] = [],
  completedAt: number | null = null,
) {
  return mockD1([
    dewsPublicationPointerMatch(completedAt),
    {
      match: completedAt == null ? LEGACY_STRESS_SIGNAL_SQL : LEGACY_STRESS_SIGNAL_CUTOFF_SQL,
      ...(completedAt == null ? {} : { matchBinds: ["usdt-tether", completedAt] }),
      rows: current ? [current] : [],
      first: current,
    },
    {
      match: STRESS_SIGNAL_HISTORY_SQL,
      rows: historyRows,
    },
  ], { strict: true });
}

function makeStrictMaterializedSingleCoinDb(
  current: Record<string, unknown>,
  historyRows: Record<string, unknown>[] = [],
  completedAt: number | null = null,
) {
  return mockD1([
    dewsPublicationPointerMatch(completedAt),
    {
      match: completedAt == null ? LATEST_STRESS_SIGNAL_SQL : LATEST_STRESS_SIGNAL_CUTOFF_SQL,
      ...(completedAt == null ? {} : { matchBinds: ["usdt-tether", completedAt] }),
      rows: [current],
      first: current,
    },
    {
      match: STRESS_SIGNAL_HISTORY_SQL,
      rows: historyRows,
    },
  ], { strict: true });
}

describe("handleStressSignals contract tests", () => {
  it("aggregate mode returns shape matching StressSignalsAllResponseSchema", async () => {
    const db = makeStrictLatestAggregateDb([
      {
        stablecoin_id: "usdt-tether",
        score: 12,
        band: "CALM",
        signals_json: signalsJson,
        computed_at: nowSec,
      },
    ]);

    const url = new URL("https://x/api/stress-signals");
    const res = await handleStressSignals(db, url);

    const json = await readJsonResponse(res, 200);

    const parsed = StressSignalsAllResponseSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("StressSignalsAllResponseSchema parse failed");
    }
    const body = parsed.data;
    expect(body).toHaveProperty("signals");
    expect(body).toHaveProperty("updatedAt");
    expect(body).toHaveProperty("eligibleCount");
    expect(body).toHaveProperty("computedCount");
    expect(body).toHaveProperty("missingCount");
    expect(body).toHaveProperty("coverageRatio");
    expect(body).toHaveProperty("coverageStatus");
    expect(body).toHaveProperty("coverageReasons");
    expect(body).toHaveProperty("methodology");
    expect(body.computedCount).toBe(1);
    expect(body.eligibleCount ?? 0).toBeGreaterThanOrEqual(body.computedCount ?? 0);
    expect(body.signals["usdt-tether"]).toHaveProperty("methodologyVersion");
    expect(body.signals["usdt-tether"]).toHaveProperty("ageClassification");
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("aggregate mode falls back to legacy stress_signals when latest materialization is unavailable", async () => {
    const db = makeStrictAggregateDb([
      {
        stablecoin_id: "usdt-tether",
        score: 12,
        band: "CALM",
        signals_json: signalsJson,
        computed_at: nowSec,
      },
    ]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));

    const body = (await readJsonResponse(res, 200)) as { computedCount: number; signals: Record<string, unknown> };
    expect(body.computedCount).toBe(1);
    expect(body.signals).toHaveProperty("usdt-tether");
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("aggregate mode merges partial latest materialization over legacy rows", async () => {
    const db = makeStrictLatestAggregateDb(
      [
        {
          stablecoin_id: "usdt-tether",
          score: 15,
          band: "CALM",
          signals_json: signalsJson,
          computed_at: nowSec,
        },
      ],
      [
        {
          stablecoin_id: "usdt-tether",
          score: 12,
          band: "CALM",
          signals_json: signalsJson,
          computed_at: nowSec - 60,
        },
        {
          stablecoin_id: "usdc-circle",
          score: 33,
          band: "WATCH",
          signals_json: signalsJson,
          computed_at: nowSec,
        },
      ],
    );

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));

    const body = (await readJsonResponse(res, 200)) as {
      computedCount: number;
      signals: Record<string, { score: number }>;
    };
    expect(body.computedCount).toBe(2);
    expect(body.signals["usdt-tether"]?.score).toBe(15);
    expect(body.signals["usdc-circle"]?.score).toBe(33);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("aggregate mode ignores newer rows that have not advanced the published DEWS generation", async () => {
    const db = makeStrictLatestAggregateDb(
      [],
      [
        {
          stablecoin_id: "usdt-tether",
          score: 12,
          band: "CALM",
          signals_json: signalsJson,
          computed_at: completedDewsAt,
        },
      ],
      completedDewsAt,
    );

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));

    const body = (await readJsonResponse(res, 200)) as {
      computedCount: number;
      signals: Record<string, { score: number; computedAt: number }>;
    };
    expect(body.computedCount).toBe(1);
    expect(body.signals["usdt-tether"]).toMatchObject({
      score: 12,
      computedAt: completedDewsAt,
    });
    const history = db.getHistory();
    expect(history.some((entry) =>
      entry.sql.includes("FROM stress_signals_latest") &&
      entry.sql.includes("computed_at <= ?") &&
      entry.binds[0] === completedDewsAt
    )).toBe(true);
    expect(history.some((entry) =>
      entry.sql.includes("FROM stress_signals") &&
      entry.sql.includes("computed_at <= ?") &&
      entry.binds[0] === completedDewsAt
    )).toBe(true);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("single-coin mode returns shape matching StressSignalDetailResponseSchema", async () => {
    const db = makeStrictSingleCoinDb(
      {
        score: 25,
        band: "WATCH",
        signals_json: signalsJson,
        computed_at: nowSec,
      },
      [
        {
          snapshot_date: nowSec - 86400,
          score: 20,
          band: "WATCH",
          signals_json: signalsJson,
        },
      ],
    );

    const url = new URL("https://x/api/stress-signals?stablecoin=usdt-tether&days=7");
    const res = await handleStressSignals(db, url);

    const json = await readJsonResponse(res, 200);

    const parsed = StressSignalDetailResponseSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("StressSignalDetailResponseSchema parse failed");
    }
    const body = parsed.data;
    expect(body).toHaveProperty("current");
    expect(body).toHaveProperty("history");
    expect(body).toHaveProperty("methodology");
    expect(body.currentStatus).toBe("ok");
    expect(body.current).toHaveProperty("methodologyVersion");
    expect(body.current).toHaveProperty("ageClassification");
    expect(body.history[0]).toHaveProperty("methodologyVersion");
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("single-coin mode ignores materialized rows newer than the published DEWS generation", async () => {
    const db = makeStrictSingleCoinDb(
      {
        score: 21,
        band: "CALM",
        signals_json: signalsJson,
        computed_at: completedDewsAt,
      },
      [],
      completedDewsAt,
    );

    const res = await handleStressSignals(
      db,
      new URL("https://x/api/stress-signals?stablecoin=usdt-tether&days=7"),
    );

    const body = (await readJsonResponse(res, 200)) as {
      current: { score: number; computedAt: number } | null;
      currentStatus: string;
    };
    expect(body.current).toMatchObject({
      score: 21,
      computedAt: completedDewsAt,
    });
    expect(body.currentStatus).toBe("ok");
    const history = db.getHistory();
    expect(history.some((entry) =>
      entry.sql.includes("FROM stress_signals_latest") &&
      entry.sql.includes("computed_at <= ?") &&
      entry.binds[0] === "usdt-tether" &&
      entry.binds[1] === completedDewsAt
    )).toBe(true);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("single-coin mode serves fresh materialized latest rows before legacy fallback", async () => {
    const db = makeStrictMaterializedSingleCoinDb({
      score: 27,
      band: "WATCH",
      signals_json: signalsJson,
      computed_at: nowSec,
    });

    const res = await handleStressSignals(
      db,
      new URL("https://x/api/stress-signals?stablecoin=usdt-tether&days=7"),
    );

    const body = (await readJsonResponse(res, 200)) as {
      current: { score: number; computedAt: number } | null;
      currentStatus: string;
    };
    expect(body.current?.score).toBe(27);
    expect(body.current?.computedAt).toBe(nowSec);
    expect(body.currentStatus).toBe("ok");
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  registerStablecoinParameterContract({
    name: "stress signals",
    path: "/api/stress-signals",
    invoke: handleStressSignals,
    cases: [
      { kind: "unknown", name: "rejects an invalid stablecoin ID with 404", stablecoin: "../etc/passwd" },
      { kind: "unknown", name: "rejects a pre-launch stablecoin ID with 404", stablecoin: preLaunchStablecoinId, query: "days=7" },
    ],
  });

  it("skips malformed rows instead of failing the whole response", async () => {
    const db = makeStrictAggregateDb([
      {
        stablecoin_id: "usdt-tether",
        score: 12,
        band: "CALM",
        signals_json: signalsJson,
        computed_at: nowSec,
      },
      {
        stablecoin_id: "usdc-circle",
        score: 40,
        band: "WATCH",
        signals_json: "{invalid-json",
        computed_at: nowSec,
      },
    ]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));
    const body = (await readJsonResponse(res, 200)) as {
      signals: Record<string, unknown>;
      malformedRows: number;
    };
    expect(body.signals).toHaveProperty("usdt-tether");
    expect(body.signals).not.toHaveProperty("usdc-circle");
    expect(body.malformedRows).toBe(1);
  });

  it("filters out untracked IDs from aggregate responses", async () => {
    const db = makeStrictAggregateDb([
      {
        stablecoin_id: "usdt-tether",
        score: 12,
        band: "CALM",
        signals_json: signalsJson,
        computed_at: nowSec,
      },
      {
        stablecoin_id: "999999999",
        score: 65,
        band: "ALERT",
        signals_json: signalsJson,
        computed_at: nowSec,
      },
    ]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));
    const body = (await readJsonResponse(res, 200)) as {
      signals: Record<string, unknown>;
    };
    expect(body.signals).toHaveProperty("usdt-tether");
    expect(body.signals).not.toHaveProperty("999999999");
  });

  it("excludes quarantined and delisted retained rows from bulk coverage", async () => {
    const db = makeStrictAggregateDb([
      {
        stablecoin_id: "usdt-tether",
        score: 12,
        band: "CALM",
        signals_json: signalsJson,
        computed_at: nowSec,
      },
      {
        stablecoin_id: "busd0-usual",
        score: 25,
        band: "WATCH",
        signals_json: signalsJson,
        computed_at: nowSec,
      },
      {
        stablecoin_id: "bfusd-binance",
        score: 65,
        band: "ALERT",
        signals_json: signalsJson,
        computed_at: nowSec,
      },
    ]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));
    const body = (await readJsonResponse(res, 200)) as {
      signals: Record<string, unknown>;
      eligibleCount: number;
      computedCount: number;
    };
    expect(body.signals).toHaveProperty("usdt-tether");
    expect(body.signals).not.toHaveProperty("busd0-usual");
    expect(body.signals).not.toHaveProperty("bfusd-binance");
    expect(body.eligibleCount).toBe(ACTIVE_IDS.size);
    expect(body.computedCount).toBe(1);
  });

  it("marks aggregate coverage ok when every active stablecoin has a current row", async () => {
    const rows = [...ACTIVE_IDS].map((stablecoinId) => ({
      stablecoin_id: stablecoinId,
      score: 12,
      band: "CALM",
      signals_json: signalsJson,
      computed_at: nowSec,
    }));
    const db = makeStrictLatestAggregateDb(rows);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));

    const body = (await readJsonResponse(res, 200)) as {
      computedCount: number;
      missingCount: number;
      coverageStatus: string;
      coverageReasons: string[];
    };
    expect(body.computedCount).toBe(ACTIVE_IDS.size);
    expect(body.missingCount).toBe(0);
    expect(body.coverageStatus).toBe("ok");
    expect(body.coverageReasons).toEqual([]);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("includes amplifiers (psi + contagion) on aggregate entries, unwrapping the wrapped payload", async () => {
    const wrappedJson = JSON.stringify({
      signals: {
        supply: { value: 10, available: true },
        pool: { value: 20, available: true },
      },
      amplifiers: { psi: 1.08, contagion: 1.15 },
    });
    const db = makeStrictAggregateDb([
      {
        stablecoin_id: "usdt-tether",
        score: 42,
        band: "ALERT",
        signals_json: wrappedJson,
        computed_at: nowSec,
      },
    ]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));
    const body = (await readJsonResponse(res, 200)) as {
      signals: Record<string, {
        signals: Record<string, unknown>;
        amplifiers: { psi: number; contagion: number };
      }>;
    };
    const entry = body.signals["usdt-tether"];
    expect(entry.amplifiers).toEqual({ psi: 1.08, contagion: 1.15 });
    // signals map is unwrapped — no leftover envelope keys.
    expect(entry.signals).toEqual({
      supply: { value: 10, available: true },
      pool: { value: 20, available: true },
    });
  });

  it("defaults amplifiers to {psi:1,contagion:1} for legacy flat-shape rows", async () => {
    const legacyJson = JSON.stringify({
      supply: { value: 10, available: true },
    });
    const db = makeStrictAggregateDb([
      {
        stablecoin_id: "usdt-tether",
        score: 12,
        band: "CALM",
        signals_json: legacyJson,
        computed_at: nowSec,
      },
    ]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));
    const body = (await readJsonResponse(res, 200)) as {
      signals: Record<string, { amplifiers: { psi: number; contagion: number } }>;
    };
    expect(body.signals["usdt-tether"].amplifiers).toEqual({ psi: 1, contagion: 1 });
  });

  it("includes amplifiers on the single-coin endpoint, unwrapping both current and history rows", async () => {
    const wrappedJson = JSON.stringify({
      signals: { supply: { value: 5, available: true } },
      amplifiers: { psi: 1.05, contagion: 1.2 },
    });
    const legacyJson = JSON.stringify({ supply: { value: 5, available: true } });
    const db = makeStrictSingleCoinDb(
      {
        score: 25,
        band: "WATCH",
        signals_json: wrappedJson,
        computed_at: nowSec,
      },
      [
        {
          snapshot_date: nowSec - 86400,
          score: 20,
          band: "WATCH",
          signals_json: legacyJson,
        },
        {
          snapshot_date: nowSec - 172800,
          score: 22,
          band: "WATCH",
          signals_json: wrappedJson,
        },
      ],
    );

    const res = await handleStressSignals(
      db,
      new URL("https://x/api/stress-signals?stablecoin=usdt-tether&days=7"),
    );
    const body = (await readJsonResponse(res, 200)) as {
      current: { amplifiers: { psi: number; contagion: number }; signals: Record<string, unknown> } | null;
      history: { amplifiers: { psi: number; contagion: number }; signals: Record<string, unknown> }[];
    };
    expect(body.current?.amplifiers).toEqual({ psi: 1.05, contagion: 1.2 });
    expect(body.current?.signals).toEqual({ supply: { value: 5, available: true } });
    // history[0] legacy flat row defaults to {1,1}
    expect(body.history[0].amplifiers).toEqual({ psi: 1, contagion: 1 });
    // history[1] wrapped row surfaces the persisted amplifiers.
    expect(body.history[1].amplifiers).toEqual({ psi: 1.05, contagion: 1.2 });
  });

  it("uses the newest aggregate row for freshness headers while exposing oldest row diagnostics", async () => {
    const requestNowSec = Math.floor(Date.now() / 1000);
    const freshComputedAt = requestNowSec - 60;
    const staleComputedAt = requestNowSec - 15_000;
    const db = makeStrictAggregateDb([
      {
        stablecoin_id: "usdt-tether",
        score: 12,
        band: "CALM",
        signals_json: signalsJson,
        computed_at: freshComputedAt,
      },
      {
        stablecoin_id: "usdc-circle",
        score: 40,
        band: "WATCH",
        signals_json: signalsJson,
        computed_at: staleComputedAt,
      },
    ]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));

    const body = (await readJsonResponse(res, 200)) as {
      updatedAt: number;
      oldestComputedAt?: number;
      signals: Record<string, { ageClassification?: string }>;
    };
    expect(body.updatedAt).toBe(freshComputedAt);
    expect(body.oldestComputedAt).toBe(staleComputedAt);
    expect(Number(res.headers.get("X-Data-Age"))).toBeLessThan(120);
    expect(res.headers.get("Warning")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, max-age=60");
    expect(body.signals["usdt-tether"].ageClassification).toBe("fresh");
    expect(body.signals["usdc-circle"].ageClassification).toBe("retainedLastValid");
  });

  it("does not warn on DEWS aggregate data that is inside the 30-minute cadence runway", async () => {
    const requestNowSec = Math.floor(Date.now() / 1000);
    const oldestComputedAt = requestNowSec - 7_400;
    const db = makeStrictAggregateDb([
      {
        stablecoin_id: "usdt-tether",
        score: 12,
        band: "CALM",
        signals_json: signalsJson,
        computed_at: oldestComputedAt,
      },
    ]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));

    const body = (await readJsonResponse(res, 200)) as {
      signals: Record<string, { ageClassification?: string }>;
    };
    expect(Number(res.headers.get("X-Data-Age"))).toBeGreaterThanOrEqual(7_400);
    expect(res.headers.get("Warning")).toBeNull();
    expect(body.signals["usdt-tether"].ageClassification).toBe("lagging");
  });

  it("marks an empty aggregate as unavailable without synthesizing a fresh data-age header", async () => {
    const db = makeStrictAggregateDb([]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));

    const body = (await readJsonResponse(res, 200)) as {
      computedCount: number;
      coverageStatus: string;
      coverageReasons: string[];
      updatedAt: number;
    };
    expect(body.updatedAt).toBe(0);
    expect(body.computedCount).toBe(0);
    expect(body.coverageStatus).toBe("unavailable");
    expect(body.coverageReasons).toContain("no-current-rows");
    expect(body.coverageReasons).toContain("computed-count-zero");
    expect(res.headers.get("X-Data-Age")).toBeNull();
    expect(res.headers.get("Warning")).toContain("DEWS current rows unavailable");
  });

  it("marks the aggregate unavailable when the publication pointer is invalid", async () => {
    const db = mockD1([invalidDewsPublicationPointerMatch()], { strict: true });

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));

    const body = (await readJsonResponse(res, 200)) as {
      updatedAt: number;
      computedCount: number;
      coverageStatus: string;
      coverageReasons: string[];
    };
    expect(body.updatedAt).toBe(0);
    expect(body.computedCount).toBe(0);
    expect(body.coverageStatus).toBe("unavailable");
    expect(body.coverageReasons).toContain("no-current-rows");
    expect(res.headers.get("Warning")).toContain("DEWS current rows unavailable");
    expect(db.getHistory()).toHaveLength(1);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("marks all-malformed aggregate rows unavailable without reporting X-Data-Age: 0", async () => {
    const db = makeStrictAggregateDb([
      {
        stablecoin_id: "usdt-tether",
        score: 12,
        band: "CALM",
        signals_json: "{invalid-json",
        computed_at: nowSec,
      },
      {
        stablecoin_id: "usdc-circle",
        score: 40,
        band: "WATCH",
        signals_json: "{also-invalid-json",
        computed_at: nowSec,
      },
    ]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));

    const body = (await readJsonResponse(res, 200)) as {
      signals: Record<string, unknown>;
      computedCount: number;
      malformedRows: number;
      coverageStatus: string;
      coverageReasons: string[];
    };
    expect(body.signals).toEqual({});
    expect(body.computedCount).toBe(0);
    expect(body.malformedRows).toBe(2);
    expect(body.coverageStatus).toBe("unavailable");
    expect(body.coverageReasons).toContain("all-current-rows-malformed");
    expect(body.coverageReasons).toContain("computed-count-zero");
    expect(res.headers.get("X-Data-Age")).toBeNull();
    expect(res.headers.get("X-Data-Age")).not.toBe("0");
  });

  it("marks a readable single coin with no current row unavailable without synthetic freshness", async () => {
    const db = makeStrictSingleCoinDb(null);

    const res = await handleStressSignals(
      db,
      new URL("https://x/api/stress-signals?stablecoin=usdt-tether&days=7"),
    );

    const body = (await readJsonResponse(res, 200)) as {
      current: unknown;
      currentStatus: string;
      currentReasons: string[];
      malformedRows: number;
    };
    expect(body.current).toBeNull();
    expect(body.currentStatus).toBe("unavailable");
    expect(body.currentReasons).toContain("single-coin-current-row-missing");
    expect(body.currentReasons).toContain("computed-count-zero");
    expect(body.malformedRows).toBe(0);
    expect(res.headers.get("X-Data-Age")).toBeNull();
    expect(res.headers.get("Warning")).toContain("DEWS current row unavailable");
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("classifies stale single-coin current rows by wall-clock age", async () => {
    const db = makeStrictSingleCoinDb({
      score: 25,
      band: "WATCH",
      signals_json: signalsJson,
      computed_at: Math.floor(Date.now() / 1000) - 20_000,
    });

    const res = await handleStressSignals(
      db,
      new URL("https://x/api/stress-signals?stablecoin=usdt-tether&days=7"),
    );

    const body = (await readJsonResponse(res, 200)) as {
      current: { ageClassification?: string } | null;
    };
    expect(body.current?.ageClassification).toBe("stale");
    expect(res.headers.get("Warning")).toContain("Response is stale");
  });

  it("reports malformed single-coin current and history rows", async () => {
    const db = makeStrictSingleCoinDb(
      {
        score: 25,
        band: "WATCH",
        signals_json: "{bad-json",
        computed_at: nowSec,
      },
      [
        {
          snapshot_date: nowSec - 86400,
          score: 20,
          band: "WATCH",
          signals_json: "{bad-history-json",
        },
      ],
    );

    const res = await handleStressSignals(
      db,
      new URL("https://x/api/stress-signals?stablecoin=usdt-tether&days=7"),
    );

    const body = (await readJsonResponse(res, 200)) as {
      current: unknown;
      currentReasons: string[];
      history: unknown[];
      malformedRows: number;
    };
    expect(body.current).toBeNull();
    expect(body.currentReasons).toContain("current-row-malformed");
    expect(body.currentReasons).toContain("computed-count-zero");
    expect(body.history).toEqual([]);
    expect(body.malformedRows).toBe(2);
  });

  it("marks aggregate rows unavailable when none are readable", async () => {
    const db = makeStrictAggregateDb([
      {
        stablecoin_id: preLaunchStablecoinId,
        score: 12,
        band: "CALM",
        signals_json: signalsJson,
        computed_at: nowSec,
      },
    ]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));

    const body = (await readJsonResponse(res, 200)) as {
      signals: Record<string, unknown>;
      coverageStatus: string;
      coverageReasons: string[];
    };
    expect(body.signals).toEqual({});
    expect(body.coverageStatus).toBe("unavailable");
    expect(body.coverageReasons).toContain("no-readable-current-rows");
    expect(body.coverageReasons).toContain("computed-count-zero");
  });
});

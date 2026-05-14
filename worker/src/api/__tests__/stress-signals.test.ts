import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleStressSignals } from "../stress-signals";
import {
  StressSignalsAllResponseSchema,
  StressSignalDetailResponseSchema,
} from "@shared/types/market";

const nowSec = Math.floor(Date.now() / 1000);

const signalsJson = JSON.stringify({
  supply: { value: 10, available: true },
  price: { value: 5, available: true },
});

const AGGREGATE_STRESS_SIGNALS_SQL = `
  SELECT s.stablecoin_id, s.score, s.band, s.signals_json, s.computed_at
  FROM stress_signals s
  INNER JOIN (
    SELECT stablecoin_id, MAX(computed_at) as max_at
    FROM stress_signals GROUP BY stablecoin_id
  ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at
`;

const LATEST_STRESS_SIGNAL_SQL = `
  SELECT score, band, signals_json, computed_at
  FROM stress_signals
  WHERE stablecoin_id = ?
  ORDER BY computed_at DESC LIMIT 1
`;

const STRESS_SIGNAL_HISTORY_SQL = `
  SELECT snapshot_date, score, band, signals_json
  FROM stress_signal_history
  WHERE stablecoin_id = ? AND snapshot_date >= ?
  ORDER BY snapshot_date ASC
`;

function makeStrictAggregateDb(rows: Record<string, unknown>[]) {
  return mockD1([{ match: AGGREGATE_STRESS_SIGNALS_SQL, rows }], { strict: true });
}

function makeStrictSingleCoinDb(
  current: Record<string, unknown> | null,
  historyRows: Record<string, unknown>[] = [],
) {
  return mockD1([
    {
      match: LATEST_STRESS_SIGNAL_SQL,
      rows: current ? [current] : [],
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
    const db = makeStrictAggregateDb([
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

    expect(res.status).toBe(200);
    const json = await res.json();

    const parsed = StressSignalsAllResponseSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("StressSignalsAllResponseSchema parse failed");
    }
    const body = parsed.data;
    expect(body).toHaveProperty("signals");
    expect(body).toHaveProperty("updatedAt");
    expect(body).toHaveProperty("methodology");
    expect(body.signals["usdt-tether"]).toHaveProperty("methodologyVersion");
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

    expect(res.status).toBe(200);
    const json = await res.json();

    const parsed = StressSignalDetailResponseSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("StressSignalDetailResponseSchema parse failed");
    }
    const body = parsed.data;
    expect(body).toHaveProperty("current");
    expect(body).toHaveProperty("history");
    expect(body).toHaveProperty("methodology");
    expect(body.current).toHaveProperty("methodologyVersion");
    expect(body.history[0]).toHaveProperty("methodologyVersion");
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("rejects unknown stablecoin ID with 404", async () => {
    const db = mockD1();
    const url = new URL("https://x/api/stress-signals?stablecoin=../etc/passwd");
    const res = await handleStressSignals(db, url);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Unknown");
  });

  it("rejects pre-launch stablecoin ID with 404", async () => {
    const db = mockD1();
    const url = new URL("https://x/api/stress-signals?stablecoin=krw1-bdacs&days=7");
    const res = await handleStressSignals(db, url);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unknown stablecoin");
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signals: Record<string, unknown>;
    };
    expect(body.signals).toHaveProperty("usdt-tether");
    expect(body.signals).not.toHaveProperty("999999999");
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
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

  it("uses the latest aggregate publication for freshness headers while exposing the oldest row", async () => {
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

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updatedAt: number;
      oldestComputedAt?: number;
    };
    expect(body.updatedAt).toBe(freshComputedAt);
    expect(body.oldestComputedAt).toBe(staleComputedAt);
    expect(Number(res.headers.get("X-Data-Age"))).toBeLessThan(120);
    expect(res.headers.get("Warning")).toBeNull();
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

    expect(res.status).toBe(200);
    expect(Number(res.headers.get("X-Data-Age"))).toBeGreaterThanOrEqual(7_400);
    expect(res.headers.get("Warning")).toBeNull();
  });
});

import { afterEach, describe, it, expect, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import type { D1Database, D1PreparedStatement } from "@shared/types/cloudflare-runtime";
import { projectYieldWarningEmitted, projectYieldPysDropped } from "../yield";
import { mockTapeD1, tapeInsertBindsForType } from "./test-support";

const SEC = 1_700_000_000;

// Substring matchers — the mock-d1 helper does a substring search against the
// raw SQL emitted by the projector, so each pattern only has to be unique
// enough to disambiguate the projector's two queries.
const MATCH_FETCH_HISTORY = "is_best = 1 AND recorded_at > ?";
const MATCH_PRIOR_HISTORY = "SELECT DISTINCT stablecoin_id FROM yield_history";
const MATCH_FETCH_DECISIONS = "WHERE created_at > ?";
const MATCH_PRIOR_DECISIONS = "SELECT DISTINCT stablecoin_id FROM yield_source_decisions";
const MATCH_CACHE = "FROM cache WHERE key";

// Seed the watermark cache so `since > 0`; the prior-row lookup is guarded
// behind `since > 0`, so tests that exercise the diff path against an existing
// snapshot must supply a non-zero watermark.
function historyTables(
  samples: Record<string, unknown>[],
  priors: Record<string, unknown>[] = [],
  watermark: number = SEC - 1,
): MockTableConfig[] {
  const defaultStablecoinId = samples.find((sample) => typeof sample.stablecoin_id === "string")?.stablecoin_id;
  const priorRows = priors.map((row) => ({
    ...(defaultStablecoinId && typeof row.stablecoin_id !== "string" ? { stablecoin_id: defaultStablecoinId } : {}),
    ...row,
  }));
  return [
    {
      match: MATCH_CACHE,
      rows: priorRows.length > 0
        ? [{ key: "tape-projector:cursor:yield.warning_emitted", value: String(watermark) }]
        : [],
    },
    { match: MATCH_FETCH_HISTORY, rows: samples },
    { match: MATCH_PRIOR_HISTORY, rows: priorRows },
  ];
}

/**
 * Cloudflare's documented D1 ceiling: 1000 queries per Worker invocation
 * (Workers Paid). The proxy enforces the platform boundary so a projection that
 * spends the whole budget on corrupt prior-row seeks is observably lost.
 */
const D1_QUERIES_PER_INVOCATION = 1_000;

function withInvocationQueryCeiling(db: D1Database, ceiling = D1_QUERIES_PER_INVOCATION): D1Database {
  let queries = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const charge = (count: number): void => {
    queries += count;
    if (queries > ceiling) {
      throw new Error(`D1_ERROR: too many queries in one Worker invocation (${ceiling} max)`);
    }
  };
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrapStatement(target.bind(...values));
        }
        if (property === "first" || property === "all" || property === "run" || property === "raw") {
          const method = target[property] as (...args: unknown[]) => Promise<unknown>;
          return (...args: unknown[]) => {
            charge(1);
            return Reflect.apply(method, target, args);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => wrapStatement(target.prepare(sql));
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          charge(statements.length);
          return target.batch(statements.map((statement) => originals.get(statement) ?? statement));
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

// Seed the watermark cache so `since > 0`; the prior-row lookup is guarded
// behind `since > 0` (it has no useful work to do on a cold projector).
function decisionTables(
  samples: Record<string, unknown>[],
  priors: Record<string, unknown>[] = [],
  watermark: number = SEC - 1,
): MockTableConfig[] {
  const defaultStablecoinId = samples.find((sample) => typeof sample.stablecoin_id === "string")?.stablecoin_id;
  const priorRows = priors.map((row) => ({
    ...(defaultStablecoinId && typeof row.stablecoin_id !== "string" ? { stablecoin_id: defaultStablecoinId } : {}),
    ...row,
  }));
  return [
    {
      match: MATCH_CACHE,
      rows: priorRows.length > 0
        ? [{ key: "tape-projector:cursor:yield.pys_dropped", value: String(watermark) }]
        : [],
    },
    { match: MATCH_FETCH_DECISIONS, rows: samples },
    { match: MATCH_PRIOR_DECISIONS, rows: priorRows },
  ];
}

describe("yield.warning_emitted projector", () => {
  it("emits when warning_signals goes empty → non-empty", async () => {
    const db = mockTapeD1(
      historyTables([
        {
          stablecoin_id: "usdt-tether",
          source_key: "aave-v3:usdt",
          recorded_at: SEC,
          warning_signals: null,
        },
        {
          stablecoin_id: "usdt-tether",
          source_key: "aave-v3:usdt",
          recorded_at: SEC + 900,
          warning_signals: JSON.stringify(["reward-heavy"]),
        },
      ]),
    ) as MockD1Database;

    await projectYieldWarningEmitted(db);
    const inserts = tapeInsertBindsForType(db, "yield.warning_emitted");
    expect(inserts).toHaveLength(1);
    // bind order: eventId, type, severity, ts, ...
    expect(inserts[0]![1]).toBe("yield.warning_emitted");
    // reward-heavy is a notice-level signal
    expect(inserts[0]![2]).toBe("notice");
  });

  it("classifies severe signals (tvl-outflow, negative-trend) as warning severity", async () => {
    const db = mockTapeD1(
      historyTables([
        {
          stablecoin_id: "dai-makerdao",
          source_key: "spark:dai",
          recorded_at: SEC + 900,
          warning_signals: JSON.stringify(["tvl-outflow"]),
        },
      ]),
    ) as MockD1Database;

    await projectYieldWarningEmitted(db);
    const inserts = tapeInsertBindsForType(db, "yield.warning_emitted");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("warning");
  });

  it("emits when a NEW signal appears on top of an existing snapshot", async () => {
    // Prior batch already had ["reward-heavy"]; new row adds "tvl-outflow".
    const db = mockTapeD1(
      historyTables(
        [
          {
            stablecoin_id: "frax-finance",
            source_key: "curve:frax",
            recorded_at: SEC + 900,
            warning_signals: JSON.stringify(["reward-heavy", "tvl-outflow"]),
          },
        ],
        [
          {
            warning_signals: JSON.stringify(["reward-heavy"]),
          },
        ],
      ),
    ) as MockD1Database;

    await projectYieldWarningEmitted(db);
    const inserts = tapeInsertBindsForType(db, "yield.warning_emitted");
    expect(inserts).toHaveLength(1);
    // tvl-outflow is severe → warning
    expect(inserts[0]![2]).toBe("warning");
  });

  it("emits nothing when the signal set is unchanged", async () => {
    const db = mockTapeD1(
      historyTables(
        [
          {
            stablecoin_id: "usdt-tether",
            source_key: "aave-v3:usdt",
            recorded_at: SEC + 900,
            warning_signals: JSON.stringify(["reward-heavy"]),
          },
        ],
        [
          { warning_signals: JSON.stringify(["reward-heavy"]) },
        ],
      ),
    ) as MockD1Database;

    await projectYieldWarningEmitted(db);
    expect(tapeInsertBindsForType(db, "yield.warning_emitted")).toHaveLength(0);
  });

  it("emits nothing when warning_signals is empty/null", async () => {
    const db = mockTapeD1(
      historyTables([
        {
          stablecoin_id: "usdc-circle",
          source_key: "aave-v3:usdc",
          recorded_at: SEC + 900,
          warning_signals: null,
        },
        {
          stablecoin_id: "dai-makerdao",
          source_key: "spark:dai",
          recorded_at: SEC + 900,
          warning_signals: JSON.stringify([]),
        },
      ]),
    ) as MockD1Database;

    await projectYieldWarningEmitted(db);
    expect(tapeInsertBindsForType(db, "yield.warning_emitted")).toHaveLength(0);
  });

  it("produces a stable eventId across re-runs (idempotency)", async () => {
    function buildDb(): MockD1Database {
      return mockTapeD1(
        historyTables([
          {
            stablecoin_id: "usdt-tether",
            source_key: "aave-v3:usdt",
            recorded_at: SEC + 900,
            warning_signals: JSON.stringify(["yield-spike"]),
          },
        ]),
      ) as MockD1Database;
    }
    const dbA = buildDb();
    const dbB = buildDb();
    await projectYieldWarningEmitted(dbA);
    await projectYieldWarningEmitted(dbB);
    const a = tapeInsertBindsForType(dbA, "yield.warning_emitted");
    const b = tapeInsertBindsForType(dbB, "yield.warning_emitted");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    // eventId stable → unique-index absorbs duplicates on re-insert.
    expect(a[0]![0]).toBe(b[0]![0]);
  });

  it("emits no events when there are no new history rows", async () => {
    const db = mockTapeD1(historyTables([])) as MockD1Database;
    const result = await projectYieldWarningEmitted(db);
    expect(result.projected).toBe(0);
    expect(tapeInsertBindsForType(db, "yield.warning_emitted")).toHaveLength(0);
  });

  it("expands a full timestamp batch before advancing the warning cursor", async () => {
    const rows = [
      { stablecoin_id: "coin-a", source_key: "src-a", recorded_at: SEC, warning_signals: JSON.stringify(["reward-heavy"]) },
      { stablecoin_id: "coin-b", source_key: "src-b", recorded_at: SEC, warning_signals: JSON.stringify(["reward-heavy"]) },
      { stablecoin_id: "coin-c", source_key: "src-c", recorded_at: SEC, warning_signals: JSON.stringify(["reward-heavy"]) },
    ];
    const db = mockTapeD1([
      { match: MATCH_CACHE, rows: [] },
      { match: MATCH_FETCH_HISTORY, matchBinds: [0, 2], rows: rows.slice(0, 2) },
      { match: MATCH_FETCH_HISTORY, matchBinds: [0, SEC], rows },
      { match: MATCH_PRIOR_HISTORY, rows: [] },
    ]) as MockD1Database;

    const result = await projectYieldWarningEmitted(db, { maxRows: 2 });

    expect(result.advanced).toBe(SEC);
    expect(tapeInsertBindsForType(db, "yield.warning_emitted")).toHaveLength(3);
  });
  it("uses source_key DESC to choose the prior row at a shared timestamp", async () => {
    const db = mockTapeD1(
      historyTables(
        [
          {
            stablecoin_id: "usdt-tether",
            source_key: "a-source",
            recorded_at: SEC + 900,
            warning_signals: JSON.stringify(["existing", "new-signal"]),
          },
        ],
        [
          // Both candidates are at the cursor boundary; z-source is the C21 winner.
          { source_key: "a-source", recorded_at: SEC - 1, warning_signals: JSON.stringify(["loser"]) },
          { source_key: "z-source", recorded_at: SEC - 1, warning_signals: JSON.stringify(["existing"]) },
        ],
      ),
    ) as MockD1Database;

    await projectYieldWarningEmitted(db);
    const inserts = tapeInsertBindsForType(db, "yield.warning_emitted");
    expect(inserts).toHaveLength(1);
    const payload = JSON.parse(String(inserts[0]![11])) as {
      prevSignals: string[];
      newSignals: string[];
    };
    expect(payload.prevSignals).toEqual(["existing"]);
    expect(payload.newSignals).toEqual(["new-signal"]);

    const priorQuery = db.getHistory().find((entry) => entry.sql.includes(MATCH_PRIOR_HISTORY));
    expect(priorQuery?.sql).toContain("ORDER BY h.recorded_at DESC, h.source_key DESC");
    expect(priorQuery?.sql).toContain("LIMIT 1");
  });

});

describe("yield.pys_dropped projector", () => {
  it.each([
    { name: "emits when selected_score drops by >= the threshold", prevScore: 80, score: 55, severity: "warning" },
    { name: "classifies a >=40-point drop as severe", prevScore: 70, score: 20, severity: "severe" },
  ])("$name", async ({ prevScore, score, severity }) => {
    const db = mockTapeD1(
      decisionTables(
        [
          {
            stablecoin_id: "usdt-tether",
            selected_source_key: "aave-v3:usdt",
            selected_score: score,
            created_at: SEC + 900,
          },
        ],
        [
          { selected_score: prevScore },
        ],
      ),
    ) as MockD1Database;

    await projectYieldPysDropped(db);
    const inserts = tapeInsertBindsForType(db, "yield.pys_dropped");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![1]).toBe("yield.pys_dropped");
    // The 25-point drop is warning [20,40); the 50-point drop is severe.
    expect(inserts[0]![2]).toBe(severity);
  });

  it.each([
    { name: "the drop is below threshold", prevScore: 80, score: 73 },
    { name: "scores are equal or rising", prevScore: 75, score: 85 },
  ])("emits nothing when $name", async ({ prevScore, score }) => {
    const db = mockTapeD1(
      decisionTables(
        [
          {
            stablecoin_id: "usdt-tether",
            selected_source_key: "aave-v3:usdt",
            selected_score: score,
            created_at: SEC + 900,
          },
        ],
        [
          { selected_score: prevScore },
        ],
      ),
    ) as MockD1Database;

    await projectYieldPysDropped(db);
    expect(tapeInsertBindsForType(db, "yield.pys_dropped")).toHaveLength(0);
  });

  it("emits nothing when there is no prior score (first observation)", async () => {
    const db = mockTapeD1(
      decisionTables([
        {
          stablecoin_id: "newcoin-xyz",
          selected_source_key: "aave-v3:xyz",
          selected_score: 40,
          created_at: SEC + 900,
        },
      ]),
    ) as MockD1Database;

    await projectYieldPysDropped(db);
    expect(tapeInsertBindsForType(db, "yield.pys_dropped")).toHaveLength(0);
  });

  it("produces a stable eventId across re-runs (idempotency)", async () => {
    function buildDb(): MockD1Database {
      return mockTapeD1(
        decisionTables(
          [
            {
              stablecoin_id: "usdt-tether",
              selected_source_key: "aave-v3:usdt",
              selected_score: 55,
              created_at: SEC + 900,
            },
          ],
          [
            { selected_score: 80 },
          ],
        ),
      ) as MockD1Database;
    }
    const dbA = buildDb();
    const dbB = buildDb();
    await projectYieldPysDropped(dbA);
    await projectYieldPysDropped(dbB);
    const a = tapeInsertBindsForType(dbA, "yield.pys_dropped");
    const b = tapeInsertBindsForType(dbB, "yield.pys_dropped");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]![0]).toBe(b[0]![0]);
  });

  it("emits no events when there are no new decisions", async () => {
    const db = mockTapeD1(decisionTables([])) as MockD1Database;
    const result = await projectYieldPysDropped(db);
    expect(result.projected).toBe(0);
    expect(tapeInsertBindsForType(db, "yield.pys_dropped")).toHaveLength(0);
  });

  it("uses generation_id DESC to choose the prior row at a shared timestamp", async () => {
    const db = mockTapeD1(
      decisionTables(
        [
          {
            stablecoin_id: "usdt-tether",
            selected_source_key: "aave-v3:usdt",
            selected_score: 80,
            created_at: SEC + 900,
          },
        ],
        [
          // Both candidates are at the cursor boundary; generation-2 is the C21 winner.
          { generation_id: "generation-1", created_at: SEC - 1, selected_score: 80 },
          { generation_id: "generation-2", created_at: SEC - 1, selected_score: 95 },
        ],
      ),
    ) as MockD1Database;

    await projectYieldPysDropped(db);
    const inserts = tapeInsertBindsForType(db, "yield.pys_dropped");
    expect(inserts).toHaveLength(1);
    const payload = JSON.parse(String(inserts[0]![11])) as {
      prevScore: number;
      newScore: number;
    };
    expect(payload.prevScore).toBe(95);
    expect(payload.newScore).toBe(80);

    const priorQuery = db.getHistory().find((entry) => entry.sql.includes(MATCH_PRIOR_DECISIONS));
    expect(priorQuery?.sql).toContain("ORDER BY d.created_at DESC, d.generation_id DESC");
    expect(priorQuery?.sql).toContain("LIMIT 1");
  });
});

describe("yield PYS null-baseline continuity", () => {
  it.each([
    { name: "one null generation", scores: [80, null, 50], delta: 30 },
    { name: "multiple null generations", scores: [80, null, null, 50], delta: 30 },
    { name: "no usable prior score", scores: [null, null, 50], delta: null },
    { name: "initial and intervening null generations", scores: [null, 80, null, null, 50], delta: 30 },
  ])("keeps identical event identities and payloads across every split and small batch: $name", async ({ scores, delta }) => {
    function openHistory() {
      const fixture = fixtures.open();
      const insert = fixture.sqlite.prepare(`INSERT INTO yield_source_decisions
        (generation_id, stablecoin_id, selected_source_key, selected_confidence_tier,
         selected_data_source, selected_apy_30d, selected_score, selected_reason, alternatives_json, created_at)
        VALUES (?, 'usdt-tether', 'aave-v3:test', 'high', 'defillama', 5, ?, 'best', '[]', ?)`);
      const seed = (start: number, end: number) => {
        for (let i = start; i < end; i++) {
          insert.run(`generation-${i}`, scores[i]!, SEC + i * 900);
        }
      };
      const events = fixture.sqlite.prepare(
        "SELECT event_id, source_row_id, ts, severity, payload_json FROM tape_events WHERE type = 'yield.pys_dropped' ORDER BY id",
      );
      return { ...fixture, seed, events };
    }

    const reference = openHistory();
    reference.seed(0, scores.length);
    await projectYieldPysDropped(reference.db);
    const expected = reference.events.all();
    if (delta == null) {
      expect(expected).toEqual([]);
    } else {
      expect(expected).toEqual([{
        event_id: expect.any(String),
        source_row_id: `usdt-tether:${SEC + (scores.length - 1) * 900}:pys`,
        ts: (SEC + (scores.length - 1) * 900) * 1000,
        severity: "warning",
        payload_json: JSON.stringify({ prevScore: 80, newScore: 50, delta, sourceKey: "aave-v3:test" }),
      }]);
    }

    for (let split = 0; split <= scores.length; split++) {
      for (const maxRows of [1, 2, 500]) {
        const replay = openHistory();
        replay.seed(0, split);
        // Zero-event generations still advance the cursor; drain by source
        // generation count rather than stopping on a zero projected count.
        for (let i = 0; i < split; i++) await projectYieldPysDropped(replay.db, { maxRows });
        replay.seed(split, scores.length);
        for (let i = split; i < scores.length; i++) await projectYieldPysDropped(replay.db, { maxRows });
        expect(replay.events.all()).toEqual(expected);
        expect(await projectYieldPysDropped(replay.db)).toEqual({ projected: 0, advanced: null });
        expect(replay.events.all()).toEqual(expected);
      }
    }
  });

  it("seeds from the latest usable generation at the cursor timestamp, skipping newer null generations", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO yield_source_decisions
      (generation_id, stablecoin_id, selected_source_key, selected_confidence_tier,
       selected_data_source, selected_apy_30d, selected_score, selected_reason, alternatives_json, created_at)
      VALUES (?, 'usdt-tether', 'aave-v3:test', 'high', 'defillama', 5, ?, 'best', '[]', ?)`);
    insert.run("generation-1", 80, SEC);
    insert.run("generation-2", 95, SEC);
    insert.run("generation-3", null, SEC);
    insert.run("generation-4", null, SEC + 900);
    insert.run("generation-5", 50, SEC + 1800);
    expect(await projectYieldPysDropped(db, { since: SEC + 900 })).toMatchObject({ projected: 1 });
    const event = sqlite.prepare("SELECT severity, payload_json FROM tape_events").get();
    expect(event).toEqual({
      severity: "severe",
      payload_json: JSON.stringify({ prevScore: 95, newScore: 50, delta: 45, sourceKey: "aave-v3:test" }),
    });
  });
});

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});

describe("yield projector prior-row SQL", () => {
  it("seeds warning and PYS comparisons for all requested coin ids", async () => {
    const { db, sqlite } = await fixtures.open();
    for (const id of ["usdt-tether", "usdc-circle"]) {
      for (const [time, score] of [[SEC - 1, 80], [SEC + 1, 60]]) {
        sqlite.prepare(`INSERT INTO yield_history
          (stablecoin_id, source_key, recorded_at, is_best, apy, data_source, warning_signals)
          VALUES (?, 'aave-v3:test', ?, 1, 5, 'defillama', ?)`)
          .run(id, time, JSON.stringify(["reward-heavy"]));
        sqlite.prepare(`INSERT INTO yield_source_decisions
          (generation_id, stablecoin_id, selected_source_key, selected_confidence_tier,
           selected_data_source, selected_apy_30d, selected_score, selected_reason, alternatives_json, created_at)
          VALUES (?, ?, 'aave-v3:test', 'high', 'defillama', 5, ?, 'best', '[]', ?)`)
          .run(`generation-${time}`, id, score, time);
      }
    }
    expect(await projectYieldWarningEmitted(db, { since: SEC, until: SEC + 2 })).toMatchObject({ projected: 0 });
    expect(await projectYieldPysDropped(db, { since: SEC, until: SEC + 2 })).toMatchObject({ projected: 2 });
  });
});

describe("yield warning unavailable evidence", () => {
  it.each([
    { raw: "{", reason: "malformed-json" },
    { raw: "", reason: "malformed-json" },
    { raw: "null", reason: "non-array" },
    { raw: "{}", reason: "non-array" },
    { raw: '["reward-heavy", 1]', reason: "invalid-member" },
    { raw: '[""]', reason: "invalid-member" },
  ])("carries the last usable warning baseline across every split: $raw", async ({ raw, reason }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    function openHistory() {
      const fixture = fixtures.open();
      const signals = ['["reward-heavy"]', raw, '["reward-heavy"]', "[]", '["reward-heavy"]'];
      const insert = fixture.sqlite.prepare(`INSERT INTO yield_history
        (stablecoin_id, source_key, recorded_at, is_best, apy, data_source, warning_signals)
        VALUES ('usdt-tether', 'aave-v3:test', ?, 1, 5, 'defillama', ?)`);
      const seed = (start: number, end: number) => {
        for (let i = start; i < end; i++) insert.run(SEC + i * 900, signals[i]!);
      };
      const events = fixture.sqlite.prepare(
        "SELECT event_id, source_row_id, payload_json FROM tape_events ORDER BY ts",
      );
      return { ...fixture, seed, events, length: signals.length };
    }
    const reference = openHistory();
    reference.seed(0, reference.length);
    await projectYieldWarningEmitted(reference.db);
    const expected = reference.events.all();
    expect(expected).toEqual([0, 4].map((index) => ({
      event_id: expect.any(String),
      source_row_id: `usdt-tether:${SEC + index * 900}:warning`,
      payload_json: JSON.stringify({
        signals: ["reward-heavy"], prevSignals: [], newSignals: ["reward-heavy"], sourceKey: "aave-v3:test",
      }),
    })));
    expect(warn).toHaveBeenCalledWith("[tape:yield.warning_emitted]", {
      reason: "warning-evidence-unavailable",
      counts: { [reason]: 1 },
      samples: [{ coinId: "usdt-tether", recordedAt: SEC + 900, reason }],
    });
    for (let split = 0; split <= reference.length; split++) {
      for (const maxRows of [1, 2, 500]) {
        const replay = openHistory();
        replay.seed(0, split);
        for (let i = 0; i < split; i++) await projectYieldWarningEmitted(replay.db, { maxRows });
        replay.seed(split, replay.length);
        for (let i = split; i < replay.length; i++) await projectYieldWarningEmitted(replay.db, { maxRows });
        expect(replay.events.all()).toEqual(expected);
      }
    }
  });

  it.each([
    { prefix: ["{"], name: "malformed JSON" },
    { prefix: ["{}", '[""]', "{"], name: "multiple unavailable observations" },
  ])("holds the first valid same-coin warning after $name across every split and batch", async ({ prefix }) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const signals = [...prefix, '["reward-heavy"]', '["reward-heavy","tvl-outflow"]', "[]", '["reward-heavy"]'];
    for (let split = 0; split <= signals.length; split++) {
      for (const maxRows of [1, 2, 500]) {
        const { db, sqlite } = fixtures.open();
        const insert = sqlite.prepare(`INSERT INTO yield_history
          (stablecoin_id, source_key, recorded_at, is_best, apy, data_source, warning_signals)
          VALUES ('usdt-tether', 'source', ?, 1, 5, 'defillama', ?)`);
        const seed = (start: number, end: number) => {
          for (let i = start; i < end; i++) insert.run(SEC + i * 900, signals[i]!);
        };
        seed(0, split);
        for (let i = 0; i < split; i++) await projectYieldWarningEmitted(db, { maxRows });
        seed(split, signals.length);
        for (let i = split; i < signals.length; i++) await projectYieldWarningEmitted(db, { maxRows });
        const events = sqlite.prepare("SELECT source_row_id, payload_json FROM tape_events ORDER BY ts").all();
        expect(events).toEqual([
          {
            source_row_id: `usdt-tether:${SEC + (prefix.length + 1) * 900}:warning`,
            payload_json: JSON.stringify({
              signals: ["reward-heavy", "tvl-outflow"], prevSignals: ["reward-heavy"],
              newSignals: ["tvl-outflow"], sourceKey: "source",
            }),
          },
          {
            source_row_id: `usdt-tether:${SEC + (prefix.length + 3) * 900}:warning`,
            payload_json: JSON.stringify({
              signals: ["reward-heavy"], prevSignals: [], newSignals: ["reward-heavy"], sourceKey: "source",
            }),
          },
        ]);
      }
    }
  });

  it("quarantines leading corrupt evidence, keeps peers and bounds diagnostic samples", async () => {
    const { db, sqlite } = fixtures.open();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const insert = sqlite.prepare(`INSERT INTO yield_history
      (stablecoin_id, source_key, recorded_at, is_best, apy, data_source, warning_signals)
      VALUES (?, 'source', ?, 1, 5, 'defillama', ?)`);
    for (let i = 0; i < 12; i++) insert.run("bad", SEC + i, "{");
    insert.run("healthy", SEC, '["reward-heavy"]');
    await projectYieldWarningEmitted(db);
    expect(sqlite.prepare("SELECT coin_id FROM tape_events").all()).toEqual([{ coin_id: "healthy" }]);
    expect(warn).toHaveBeenCalledWith("[tape:yield.warning_emitted]", {
      reason: "warning-evidence-unavailable",
      counts: { "malformed-json": 12 },
      samples: expect.any(Array),
    });
    expect(warn.mock.calls[0]![1].samples).toHaveLength(10);
  });

  it("publishes a healthy peer when corrupt prior rows exhaust the D1 invocation budget", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run("tape-projector:cursor:yield.warning_emitted", String(SEC), SEC);

    const insert = sqlite.prepare(`INSERT INTO yield_history
      (stablecoin_id, source_key, recorded_at, is_best, apy, data_source, warning_signals)
      VALUES (?, 'aave-v3:test', ?, 1, 5, 'defillama', ?)`);
    // A producer regression leaves sixty coins with a long corrupt streak
    // immediately behind the watermark; the prior-row seek must stay bounded so
    // one bad generation cannot starve the whole class of its event batch (R8).
    for (let coin = 0; coin < 60; coin++) {
      const coinId = `bad-${String(coin).padStart(2, "0")}`;
      for (let generation = 0; generation < 20; generation++) {
        insert.run(coinId, SEC - 1 - generation, "{");
      }
      insert.run(coinId, SEC + 60, "{");
    }
    insert.run("zzz-healthy", SEC + 60, JSON.stringify(["tvl-outflow"]));

    const result = await projectYieldWarningEmitted(withInvocationQueryCeiling(db), { since: SEC });

    expect(result).toMatchObject({ projected: 1 });
    expect(sqlite.prepare("SELECT coin_id, type FROM tape_events ORDER BY coin_id").all()).toEqual([
      { coin_id: "zzz-healthy", type: "yield.warning_emitted" },
    ]);
  });

  it("uses source-key ordering while seeking past corrupt priors and preserves genuine null clears", async () => {
    const { db, sqlite } = fixtures.open();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const insert = sqlite.prepare(`INSERT INTO yield_history
      (stablecoin_id, source_key, recorded_at, is_best, apy, data_source, warning_signals)
      VALUES ('usdt-tether', ?, ?, 1, 5, 'defillama', ?)`);
    insert.run("a", SEC, '["reward-heavy"]');
    insert.run("z", SEC, "{");
    insert.run("a", SEC + 900, '["reward-heavy"]');
    insert.run("a", SEC + 1800, null);
    insert.run("a", SEC + 2700, '["reward-heavy"]');
    await projectYieldWarningEmitted(db, { since: SEC });
    expect(sqlite.prepare("SELECT source_row_id FROM tape_events").all()).toEqual([
      { source_row_id: `usdt-tether:${SEC + 2700}:warning` },
    ]);
  });
});

describe("yield historical methodology", () => {
  it.each([
    { timestamp: 1777636800, version: "7.43", rawInputs: null },
    { timestamp: 1792497600, version: "8.5", rawInputs: null },
    { timestamp: 1777636800, version: "6.09", rawInputs: '{"methodologyVersion":"6.09"}' },
    { timestamp: 1777636800, version: "7.43", rawInputs: "{" },
    { timestamp: 1777636800, version: "7.43", rawInputs: '{"methodologyVersion":42}' },
  ])("persists both yield event versions at source time $timestamp with $rawInputs under later clocks", async ({ timestamp, version, rawInputs }) => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare(`INSERT INTO yield_history
      (stablecoin_id, source_key, recorded_at, is_best, apy, data_source, warning_signals,
       publication_generation_id, pys_inputs_at_publish)
      VALUES ('usdt-tether', 'source', ?, 1, 5, 'defillama', '["reward-heavy"]', 'current', ?)`)
      .run(timestamp, rawInputs);
    const decision = sqlite.prepare(`INSERT INTO yield_source_decisions
      (generation_id, stablecoin_id, selected_source_key, selected_confidence_tier,
       selected_data_source, selected_apy_30d, selected_score, selected_reason, alternatives_json, created_at)
      VALUES (?, 'usdt-tether', 'source', 'high', 'defillama', 5, ?, 'best', '[]', ?)`);
    decision.run("prior", 80, timestamp - 900);
    decision.run("current", 50, timestamp);
    for (const clock of [1792497600, 1824033600]) {
      vi.spyOn(Date, "now").mockReturnValue(clock * 1000);
      await projectYieldWarningEmitted(db, { since: timestamp - 900, until: timestamp });
      await projectYieldPysDropped(db, { since: timestamp - 900, until: timestamp });
      expect(sqlite.prepare("SELECT type, methodology_version FROM tape_events ORDER BY type").all()).toEqual([
        { type: "yield.pys_dropped", methodology_version: version },
        { type: "yield.warning_emitted", methodology_version: version },
      ]);
    }
  });
});

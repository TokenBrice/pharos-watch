import { afterEach, describe, it, expect, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { D1Database, D1PreparedStatement } from "@shared/types/cloudflare-runtime";
import { projectYieldWarningEmitted, projectYieldPysDropped } from "../yield";

const SEC = 1_700_000_000;

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

type YieldSqlite = ReturnType<typeof fixtures.open>["sqlite"];

function readEvents(sqlite: YieldSqlite) {
  return sqlite.prepare("SELECT type, severity, payload_json FROM tape_events ORDER BY ts, coin_id").all()
    .map(({ type, severity, payload_json }) => ({ type, severity, payload: JSON.parse(String(payload_json)) as unknown }));
}

function seedCursor(sqlite: YieldSqlite, type: string, timestamp: number) {
  sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
    .run(`tape-projector:cursor:${type}`, String(timestamp), timestamp);
}

function expectCursor(sqlite: YieldSqlite, type: string, timestamp: number) {
  expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(`tape-projector:cursor:${type}`))
    .toEqual({ value: String(timestamp) });
}

function prepareWarningHistory(sqlite: YieldSqlite, isBest = 1) {
  return sqlite.prepare(`INSERT INTO yield_history
    (stablecoin_id, source_key, recorded_at, is_best, apy, data_source, warning_signals)
    VALUES (?, ?, ?, ${isBest}, 5, 'defillama', ?)`);
}

describe("yield.warning_emitted projector", () => {
  it("emits when warning_signals goes empty → non-empty", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = prepareWarningHistory(sqlite);
    insert.run("usdt-tether", "aave-v3:usdt", SEC, null);
    insert.run("usdt-tether", "aave-v3:usdt", SEC + 900, '["reward-heavy"]');

    expect(await projectYieldWarningEmitted(db)).toEqual({ projected: 1, advanced: SEC + 900 });
    expect(readEvents(sqlite)).toEqual([{
      type: "yield.warning_emitted",
      severity: "notice",
      payload: { signals: ["reward-heavy"], prevSignals: [], newSignals: ["reward-heavy"], sourceKey: "aave-v3:usdt" },
    }]);
    expectCursor(sqlite, "yield.warning_emitted", SEC + 900);
  });

  it("classifies severe signals (tvl-outflow, negative-trend) as warning severity", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = prepareWarningHistory(sqlite);
    insert.run("dai-makerdao", "spark:dai", SEC - 2, '["reward-heavy"]');
    insert.run("dai-makerdao", "spark:dai", SEC + 900, '["reward-heavy","tvl-outflow"]');
    insert.run("dai-makerdao", "spark:dai", SEC + 1800, '["reward-heavy","tvl-outflow","negative-trend"]');
    const insertNonBest = prepareWarningHistory(sqlite, 0);
    insertNonBest.run("dai-makerdao", "aave-v3:dai", SEC - 1, '["tvl-outflow"]');
    insertNonBest.run("dai-makerdao", "aave-v3:dai", SEC + 1200, '["negative-trend"]');
    seedCursor(sqlite, "yield.warning_emitted", SEC);

    expect(await projectYieldWarningEmitted(db)).toEqual({ projected: 2, advanced: SEC + 1800 });
    expect(readEvents(sqlite)).toEqual([
      {
        type: "yield.warning_emitted",
        severity: "warning",
        payload: {
          signals: ["reward-heavy", "tvl-outflow"], prevSignals: ["reward-heavy"],
          newSignals: ["tvl-outflow"], sourceKey: "spark:dai",
        },
      },
      {
        type: "yield.warning_emitted",
        severity: "warning",
        payload: {
          signals: ["reward-heavy", "tvl-outflow", "negative-trend"], prevSignals: ["reward-heavy", "tvl-outflow"],
          newSignals: ["negative-trend"], sourceKey: "spark:dai",
        },
      },
    ]);
    expectCursor(sqlite, "yield.warning_emitted", SEC + 1800);
  });

  it("emits nothing when warning_signals is empty/null", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = prepareWarningHistory(sqlite);
    insert.run("usdc-circle", "aave-v3:usdc", SEC + 900, null);
    insert.run("dai-makerdao", "spark:dai", SEC + 900, "[]");

    const result = await projectYieldWarningEmitted(db);
    expect(readEvents(sqlite)).toEqual([]);
    expect(result).toEqual({ projected: 0, advanced: SEC + 900 });
    expectCursor(sqlite, "yield.warning_emitted", SEC + 900);
  });

  it("emits no events when there are no new history rows", async () => {
    const { db, sqlite } = fixtures.open();
    prepareWarningHistory(sqlite).run("usdt-tether", "aave-v3:usdt", SEC, '["reward-heavy"]');
    seedCursor(sqlite, "yield.warning_emitted", SEC);

    expect(await projectYieldWarningEmitted(db)).toEqual({ projected: 0, advanced: null });
    expect(readEvents(sqlite)).toEqual([]);
    expectCursor(sqlite, "yield.warning_emitted", SEC);
  });

  it("expands a full timestamp batch before advancing the warning cursor", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = prepareWarningHistory(sqlite);
    const sources = ["src-a", "src-b", "src-c"];
    for (const source of sources) insert.run(source, source, SEC, '["reward-heavy"]');
    insert.run("later", "src-later", SEC + 900, '["reward-heavy"]');

    expect(await projectYieldWarningEmitted(db, { maxRows: 2 })).toEqual({ projected: 3, advanced: SEC });
    expect(readEvents(sqlite)).toEqual(sources.map((sourceKey) => ({
      type: "yield.warning_emitted",
      severity: "notice",
      payload: { signals: ["reward-heavy"], prevSignals: [], newSignals: ["reward-heavy"], sourceKey },
    })));
    expectCursor(sqlite, "yield.warning_emitted", SEC);
  });
  it("uses source_key DESC to choose the prior row at a shared timestamp", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO yield_history
      (stablecoin_id, source_key, recorded_at, is_best, apy, data_source, warning_signals)
      VALUES ('usdt-tether', ?, ?, 1, 5, 'defillama', ?)`);
    insert.run("a-source", SEC - 1, '["loser"]');
    insert.run("z-source", SEC - 1, '["existing"]');
    insert.run("a-source", SEC + 900, '["existing","new-signal"]');

    await projectYieldWarningEmitted(db, { since: SEC - 1 });
    const events = sqlite.prepare("SELECT payload_json FROM tape_events WHERE type = 'yield.warning_emitted'").all();
    expect(events).toHaveLength(1);
    expect(JSON.parse(String(events[0]!.payload_json))).toEqual({
      signals: ["existing", "new-signal"], prevSignals: ["existing"],
      newSignals: ["new-signal"], sourceKey: "a-source",
    });
  });

});

function preparePysDecisions(sqlite: YieldSqlite) {
  return sqlite.prepare(`INSERT INTO yield_source_decisions
    (generation_id, stablecoin_id, selected_source_key, selected_confidence_tier,
     selected_data_source, selected_apy_30d, selected_score, selected_reason, alternatives_json, created_at)
    VALUES (?, 'usdt-tether', 'aave-v3:usdt', 'high', 'defillama', 5, ?, 'best', '[]', ?)`);
}

describe("yield.pys_dropped projector", () => {
  it.each([
    { name: "emits when selected_score drops by >= the threshold", prevScore: 80, score: 55, severity: "warning" },
    { name: "classifies a >=40-point drop as severe", prevScore: 70, score: 20, severity: "severe" },
  ])("$name", async ({ prevScore, score, severity }) => {
    const { db, sqlite } = fixtures.open();
    const insert = preparePysDecisions(sqlite);
    insert.run("generation-1", prevScore, SEC);
    insert.run("generation-2", score, SEC + 900);
    seedCursor(sqlite, "yield.pys_dropped", SEC);

    expect(await projectYieldPysDropped(db)).toEqual({ projected: 1, advanced: SEC + 900 });
    expect(readEvents(sqlite)).toEqual([{
      type: "yield.pys_dropped",
      severity,
      payload: { prevScore, newScore: score, delta: prevScore - score, sourceKey: "aave-v3:usdt" },
    }]);
    expectCursor(sqlite, "yield.pys_dropped", SEC + 900);
  });

  it.each([
    { name: "the drop is below threshold", prevScore: 80, score: 73 },
    { name: "scores are equal or rising", prevScore: 75, score: 85 },
  ])("emits nothing when $name", async ({ prevScore, score }) => {
    const { db, sqlite } = fixtures.open();
    const insert = preparePysDecisions(sqlite);
    insert.run("generation-1", prevScore, SEC);
    insert.run("generation-2", score, SEC + 900);
    seedCursor(sqlite, "yield.pys_dropped", SEC);

    const result = await projectYieldPysDropped(db);
    expect(readEvents(sqlite)).toEqual([]);
    expect(result).toEqual({ projected: 0, advanced: SEC + 900 });
    expectCursor(sqlite, "yield.pys_dropped", SEC + 900);
  });

  it("classifies a 15-point drop from an untied prior as notice", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = preparePysDecisions(sqlite);
    insert.run("generation-1", 95, SEC);
    insert.run("generation-2", 80, SEC + 900);
    seedCursor(sqlite, "yield.pys_dropped", SEC);

    expect(await projectYieldPysDropped(db)).toEqual({ projected: 1, advanced: SEC + 900 });
    expect(readEvents(sqlite)).toEqual([{
      type: "yield.pys_dropped",
      severity: "notice",
      payload: { prevScore: 95, newScore: 80, delta: 15, sourceKey: "aave-v3:usdt" },
    }]);
    expectCursor(sqlite, "yield.pys_dropped", SEC + 900);
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

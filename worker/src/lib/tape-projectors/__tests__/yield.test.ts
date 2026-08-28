import { describe, it, expect } from "vitest";
import { mockD1 as createMockD1, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { projectYieldWarningEmitted, projectYieldPysDropped } from "../yield";

const SEC = 1_700_000_000;
const TAPE_WRITE_TABLES: MockTableConfig[] = [
  { match: "INSERT OR REPLACE INTO tape_events", rows: [] },
  { match: "INSERT OR REPLACE INTO cache", rows: [] },
];

function mockD1(tables: MockTableConfig[] = []): MockD1Database {
  return createMockD1([...tables, ...TAPE_WRITE_TABLES]);
}

// Substring matchers — the mock-d1 helper does a substring search against the
// raw SQL emitted by the projector, so each pattern only has to be unique
// enough to disambiguate the projector's two queries.
const MATCH_FETCH_HISTORY = "is_best = 1 AND recorded_at > ?";
const MATCH_PRIOR_HISTORY = "MAX(recorded_at) as max_at";
const MATCH_FETCH_DECISIONS = "WHERE created_at > ?";
const MATCH_PRIOR_DECISIONS = "MAX(created_at) as max_at";
const MATCH_CACHE = "FROM cache WHERE key";

function extractInsertBinds(db: MockD1Database): unknown[][] {
  return db
    .getHistory()
    .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO tape_events"))
    .map((entry) => entry.binds);
}

function extractInsertBindsForType(db: MockD1Database, type: string): unknown[][] {
  return extractInsertBinds(db).filter((binds) => binds[1] === type);
}

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
    const db = mockD1(
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
    const inserts = extractInsertBindsForType(db, "yield.warning_emitted");
    expect(inserts).toHaveLength(1);
    // bind order: eventId, type, severity, ts, ...
    expect(inserts[0]![1]).toBe("yield.warning_emitted");
    // reward-heavy is a notice-level signal
    expect(inserts[0]![2]).toBe("notice");
  });

  it("classifies severe signals (tvl-outflow, negative-trend) as warning severity", async () => {
    const db = mockD1(
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
    const inserts = extractInsertBindsForType(db, "yield.warning_emitted");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("warning");
  });

  it("emits when a NEW signal appears on top of an existing snapshot", async () => {
    // Prior batch already had ["reward-heavy"]; new row adds "tvl-outflow".
    const db = mockD1(
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
    const inserts = extractInsertBindsForType(db, "yield.warning_emitted");
    expect(inserts).toHaveLength(1);
    // tvl-outflow is severe → warning
    expect(inserts[0]![2]).toBe("warning");
  });

  it("emits nothing when the signal set is unchanged", async () => {
    const db = mockD1(
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
    expect(extractInsertBindsForType(db, "yield.warning_emitted")).toHaveLength(0);
  });

  it("emits nothing when warning_signals is empty/null", async () => {
    const db = mockD1(
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
    expect(extractInsertBindsForType(db, "yield.warning_emitted")).toHaveLength(0);
  });

  it("produces a stable eventId across re-runs (idempotency)", async () => {
    function buildDb(): MockD1Database {
      return mockD1(
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
    const a = extractInsertBindsForType(dbA, "yield.warning_emitted");
    const b = extractInsertBindsForType(dbB, "yield.warning_emitted");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    // eventId stable → unique-index absorbs duplicates on re-insert.
    expect(a[0]![0]).toBe(b[0]![0]);
  });

  it("emits no events when there are no new history rows", async () => {
    const db = mockD1(historyTables([])) as MockD1Database;
    const result = await projectYieldWarningEmitted(db);
    expect(result.projected).toBe(0);
    expect(extractInsertBindsForType(db, "yield.warning_emitted")).toHaveLength(0);
  });

  it("expands a full timestamp batch before advancing the warning cursor", async () => {
    const rows = [
      { stablecoin_id: "coin-a", source_key: "src-a", recorded_at: SEC, warning_signals: JSON.stringify(["reward-heavy"]) },
      { stablecoin_id: "coin-b", source_key: "src-b", recorded_at: SEC, warning_signals: JSON.stringify(["reward-heavy"]) },
      { stablecoin_id: "coin-c", source_key: "src-c", recorded_at: SEC, warning_signals: JSON.stringify(["reward-heavy"]) },
    ];
    const db = mockD1([
      { match: MATCH_CACHE, rows: [] },
      { match: MATCH_FETCH_HISTORY, matchBinds: [0, 2], rows: rows.slice(0, 2) },
      { match: MATCH_FETCH_HISTORY, matchBinds: [0, SEC], rows },
      { match: MATCH_PRIOR_HISTORY, rows: [] },
    ]) as MockD1Database;

    const result = await projectYieldWarningEmitted(db, { maxRows: 2 });

    expect(result.advanced).toBe(SEC);
    expect(extractInsertBindsForType(db, "yield.warning_emitted")).toHaveLength(3);
  });
});

describe("yield.pys_dropped projector", () => {
  it("emits when selected_score drops by >= the threshold", async () => {
    const db = mockD1(
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

    await projectYieldPysDropped(db);
    const inserts = extractInsertBindsForType(db, "yield.pys_dropped");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![1]).toBe("yield.pys_dropped");
    // delta = 25 → warning band [20,40)
    expect(inserts[0]![2]).toBe("warning");
  });

  it("classifies a >=40-point drop as severe", async () => {
    const db = mockD1(
      decisionTables(
        [
          {
            stablecoin_id: "usdt-tether",
            selected_source_key: "aave-v3:usdt",
            selected_score: 20,
            created_at: SEC + 900,
          },
        ],
        [
          { selected_score: 70 },
        ],
      ),
    ) as MockD1Database;

    await projectYieldPysDropped(db);
    const inserts = extractInsertBindsForType(db, "yield.pys_dropped");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("severe");
  });

  it("emits nothing when the drop is below threshold", async () => {
    const db = mockD1(
      decisionTables(
        [
          {
            stablecoin_id: "usdt-tether",
            selected_source_key: "aave-v3:usdt",
            selected_score: 73,
            created_at: SEC + 900,
          },
        ],
        [
          { selected_score: 80 },
        ],
      ),
    ) as MockD1Database;

    await projectYieldPysDropped(db);
    expect(extractInsertBindsForType(db, "yield.pys_dropped")).toHaveLength(0);
  });

  it("emits nothing when there is no prior score (first observation)", async () => {
    const db = mockD1(
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
    expect(extractInsertBindsForType(db, "yield.pys_dropped")).toHaveLength(0);
  });

  it("emits nothing when scores are equal or rising", async () => {
    const db = mockD1(
      decisionTables(
        [
          {
            stablecoin_id: "usdt-tether",
            selected_source_key: "aave-v3:usdt",
            selected_score: 85,
            created_at: SEC + 900,
          },
        ],
        [
          { selected_score: 75 },
        ],
      ),
    ) as MockD1Database;

    await projectYieldPysDropped(db);
    expect(extractInsertBindsForType(db, "yield.pys_dropped")).toHaveLength(0);
  });

  it("produces a stable eventId across re-runs (idempotency)", async () => {
    function buildDb(): MockD1Database {
      return mockD1(
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
    const a = extractInsertBindsForType(dbA, "yield.pys_dropped");
    const b = extractInsertBindsForType(dbB, "yield.pys_dropped");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]![0]).toBe(b[0]![0]);
  });

  it("emits no events when there are no new decisions", async () => {
    const db = mockD1(decisionTables([])) as MockD1Database;
    const result = await projectYieldPysDropped(db);
    expect(result.projected).toBe(0);
    expect(extractInsertBindsForType(db, "yield.pys_dropped")).toHaveLength(0);
  });
});

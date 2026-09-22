import type * as Vitest from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanup = vi.hoisted(() => ({ callbacks: [] as Array<() => void> }));
vi.mock("vitest", async (importOriginal) => ({
  ...await importOriginal<typeof Vitest>(),
  onTestFinished: (callback: () => void) => cleanup.callbacks.push(callback),
}));

import { matchMarker, mockD1, mockD1Strict, sqlMarker } from "@shared/test-utils/mock-d1";

afterEach(() => {
  cleanup.callbacks.length = 0;
});

describe("mockD1 match accounting", () => {
  it("fails the finished test when a configured match was never selected", async () => {
    const db = mockD1Strict([
      { match: "SELECT stablecoin_id FROM stress_signals_latest", rows: [] },
      { match: "SELECT job FROM cron_runs", rows: [] },
    ]);
    await db.prepare("SELECT stablecoin_id FROM stress_signals_latest").all();
    expect(() => cleanup.callbacks[0]()).toThrow("mockD1: unused table match(es): SELECT job FROM cron_runs");
  });

  it("accepts a fixture set whose every match was selected", async () => {
    const db = mockD1([{ match: "FROM cron_runs", rows: [] }], { assertMatchesUsed: true });
    await db.prepare("SELECT job FROM cron_runs").all();
    expect(() => cleanup.callbacks[0]()).not.toThrow();
  });

  it("registers no automatic assertion for a fixture that did not opt in", () => {
    mockD1([{ match: "FROM cron_runs", rows: [] }]);
    expect(cleanup.callbacks).toHaveLength(0);
  });
});

describe("marker-based match tables", () => {
  const ROWS = [{ stablecoin_id: "usdt-tether" }];

  it("resolves a statement by its marker regardless of the surrounding SQL text", async () => {
    const db = mockD1([matchMarker("stress-signals:latest-all", ROWS)]);
    const reworded = await db
      .prepare(`SELECT ${sqlMarker("stress-signals:latest-all")} score, band, stablecoin_id FROM stress_signals_latest ORDER BY stablecoin_id`)
      .all();
    expect(reworded.results).toEqual(ROWS);
  });

  it("rejects a sibling statement on the same table that carries a different marker", async () => {
    const db = mockD1([matchMarker("stress-signals:latest-all", ROWS)]);
    await expect(
      db.prepare(`SELECT ${sqlMarker("stress-signals:latest-one")} score FROM stress_signals_latest WHERE stablecoin_id = ?`).bind("usdt-tether").all(),
    ).rejects.toThrow(/no match for SQL/);
  });

  it("carries fixture overrides through to the generated match table", async () => {
    const db = mockD1([matchMarker("dews:stress-latest-upsert", [], { runMeta: { changes: 3 } })]);
    const written = await db.prepare(`${sqlMarker("dews:stress-latest-upsert")} INSERT OR REPLACE INTO stress_signals_latest VALUES (?)`).bind("usdt-tether").run();
    expect(written.meta).toEqual({ changes: 3 });
  });
});

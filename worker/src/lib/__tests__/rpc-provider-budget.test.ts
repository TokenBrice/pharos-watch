import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import {
  DWELLIR_DEFAULT_MAX_CREDITS_PER_MONTH,
  flushDwellirCredits,
  loadDwellirBudgetState,
  recordDwellirCredits,
} from "../rpc-provider-budget";

const SEPTEMBER_NOW_SEC = Date.parse("2026-09-24T10:00:00.000Z") / 1000;
const OCTOBER_NOW_SEC = Date.parse("2026-10-02T10:00:00.000Z") / 1000;
const SEPTEMBER_LEDGER_KEY = "rpc:dwellir:credits:v1:2026-09";
const OCTOBER_LEDGER_KEY = "rpc:dwellir:credits:v1:2026-10";
const API_KEY = "dwellir-test-key-placeholder";

function septemberRow(usedCredits: number): string {
  return JSON.stringify({ window: "2026-09", usedCredits });
}

/** Cache-table double with real upsert/compare-and-swap semantics and injectable failures. */
function makeCreditLedgerDb(initialRows: Record<string, string> = {}) {
  const values: Record<string, string> = { ...initialRows };
  const writes: Array<{ key: string; value: string }> = [];
  let readFailure: Error | null = null;
  let writeFailure: Error | null = null;
  let lostWrites = 0;

  return makeNoopD1({
    prepare: () => ({
      bind: (...binds: unknown[]) => ({
        first: async () => {
          if (readFailure) throw readFailure;
          const value = values[String(binds[0])];
          return value == null ? null : { value, updated_at: SEPTEMBER_NOW_SEC };
        },
        run: async () => {
          if (writeFailure) throw writeFailure;
          const key = String(binds[0]);
          const value = String(binds[1]);
          const expectedValue = binds[3] == null ? null : String(binds[3]);
          const current = values[key];
          if (lostWrites > 0 && current != null) {
            lostWrites -= 1;
            return { success: true, meta: { changes: 0 } };
          }
          if (current != null && current !== expectedValue) return { success: true, meta: { changes: 0 } };
          values[key] = value;
          writes.push({ key, value });
          return { success: true, meta: { changes: 1 } };
        },
      }),
    }),
    values,
    writes,
    failReads: (error: Error | null) => {
      readFailure = error;
    },
    failWrites: (error: Error | null) => {
      writeFailure = error;
    },
    loseWrites: (count: number) => {
      lostWrites = count;
    },
  });
}

function readLedgerValue(sqlite: DatabaseSync, key: string): unknown {
  const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key) as { value: string } | undefined;
  return row == null ? null : JSON.parse(row.value);
}

describe("loadDwellirBudgetState", () => {
  it("reports not-configured without touching the ledger", async () => {
    const db = makeNoopD1();
    await expect(loadDwellirBudgetState(db, {}, SEPTEMBER_NOW_SEC)).resolves.toEqual({
      configured: false,
      usable: false,
      reason: "not-configured",
      window: "2026-09",
      usedCredits: null,
      capCredits: DWELLIR_DEFAULT_MAX_CREDITS_PER_MONTH,
      observedAtSec: SEPTEMBER_NOW_SEC,
    });
    await expect(
      loadDwellirBudgetState(db, { DWELLIR_API_KEY: "   " }, SEPTEMBER_NOW_SEC),
    ).resolves.toMatchObject({ configured: false, usable: false, reason: "not-configured" });
  });

  it("treats a missing month row as zero used credits", async () => {
    await expect(
      loadDwellirBudgetState(makeCreditLedgerDb(), { DWELLIR_API_KEY: API_KEY }, SEPTEMBER_NOW_SEC),
    ).resolves.toEqual({
      configured: true,
      usable: true,
      reason: "ok",
      window: "2026-09",
      usedCredits: 0,
      capCredits: DWELLIR_DEFAULT_MAX_CREDITS_PER_MONTH,
      observedAtSec: SEPTEMBER_NOW_SEC,
    });
  });

  it("exhausts the month at the cap and not one credit earlier", async () => {
    const belowCap = makeCreditLedgerDb({ [SEPTEMBER_LEDGER_KEY]: septemberRow(999) });
    await expect(
      loadDwellirBudgetState(
        belowCap,
        { DWELLIR_API_KEY: API_KEY, DWELLIR_MAX_CREDITS_PER_MONTH: "1000" },
        SEPTEMBER_NOW_SEC,
      ),
    ).resolves.toMatchObject({ usable: true, reason: "ok", usedCredits: 999, capCredits: 1000 });

    const atCap = makeCreditLedgerDb({ [SEPTEMBER_LEDGER_KEY]: septemberRow(1000) });
    await expect(
      loadDwellirBudgetState(
        atCap,
        { DWELLIR_API_KEY: API_KEY, DWELLIR_MAX_CREDITS_PER_MONTH: "1000" },
        SEPTEMBER_NOW_SEC,
      ),
    ).resolves.toMatchObject({
      usable: false,
      reason: "provider-budget-exhausted",
      usedCredits: 1000,
      capCredits: 1000,
    });
  });

  it("fails closed with an unknown usage total when the ledger row is unreadable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unreadableRows = [
      "{not-json",
      JSON.stringify({ window: "2026-08", usedCredits: 4 }),
      JSON.stringify({ window: "2026-09", usedCredits: -1 }),
      JSON.stringify(["2026-09"]),
    ];
    for (const row of unreadableRows) {
      const db = makeCreditLedgerDb({ [SEPTEMBER_LEDGER_KEY]: row });
      await expect(
        loadDwellirBudgetState(db, { DWELLIR_API_KEY: API_KEY }, SEPTEMBER_NOW_SEC),
      ).resolves.toMatchObject({ configured: true, usable: false, reason: "ledger-unreadable", usedCredits: null });
    }

    const failing = makeCreditLedgerDb();
    failing.failReads(new Error("D1_ERROR: ledger read failed"));
    await expect(
      loadDwellirBudgetState(failing, { DWELLIR_API_KEY: API_KEY }, SEPTEMBER_NOW_SEC),
    ).resolves.toMatchObject({ configured: true, usable: false, reason: "ledger-unreadable", usedCredits: null });

    expect(JSON.stringify(warn.mock.calls)).toContain("dwellir_credit_ledger");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(API_KEY);
  });

  it.each([
    { label: "zero", value: "0", capCredits: DWELLIR_DEFAULT_MAX_CREDITS_PER_MONTH },
    { label: "negative", value: "-25", capCredits: DWELLIR_DEFAULT_MAX_CREDITS_PER_MONTH },
    { label: "non-numeric", value: "abc", capCredits: DWELLIR_DEFAULT_MAX_CREDITS_PER_MONTH },
    { label: "fractional", value: "12.5", capCredits: DWELLIR_DEFAULT_MAX_CREDITS_PER_MONTH },
    { label: "unsafe integer", value: "9007199254740993", capCredits: DWELLIR_DEFAULT_MAX_CREDITS_PER_MONTH },
    { label: "valid", value: "2500", capCredits: 2500 },
  ])("resolves the monthly cap for a $label value", async ({ value, capCredits }) => {
    const db = makeCreditLedgerDb({ [SEPTEMBER_LEDGER_KEY]: septemberRow(0) });
    await expect(
      loadDwellirBudgetState(
        db,
        { DWELLIR_API_KEY: API_KEY, DWELLIR_MAX_CREDITS_PER_MONTH: value },
        SEPTEMBER_NOW_SEC,
      ),
    ).resolves.toMatchObject({ capCredits, usable: true });
  });
});

describe("recordDwellirCredits and flushDwellirCredits", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    // The pending counter is module-level; leave nothing behind for the next test.
    await flushDwellirCredits(makeCreditLedgerDb(), SEPTEMBER_NOW_SEC);
  });

  it("ignores non-finite, non-positive, and sub-credit counts", async () => {
    for (const count of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) recordDwellirCredits(count);
    await expect(flushDwellirCredits(makeNoopD1(), SEPTEMBER_NOW_SEC)).resolves.toEqual({
      flushedCredits: 0,
      ok: true,
    });
  });

  it("does not touch D1 when nothing is pending", async () => {
    const prepare = vi.fn(() => {
      throw new Error("unexpected D1 access");
    });
    await expect(flushDwellirCredits(makeNoopD1({ prepare }), SEPTEMBER_NOW_SEC)).resolves.toEqual({
      flushedCredits: 0,
      ok: true,
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("accumulates credits across flushes in one month and starts fresh in the next", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      recordDwellirCredits(3);
      await expect(flushDwellirCredits(db, SEPTEMBER_NOW_SEC)).resolves.toEqual({ flushedCredits: 3, ok: true });
      recordDwellirCredits(4);
      await expect(flushDwellirCredits(db, SEPTEMBER_NOW_SEC + 3_600)).resolves.toEqual({
        flushedCredits: 4,
        ok: true,
      });
      recordDwellirCredits(5);
      await expect(flushDwellirCredits(db, OCTOBER_NOW_SEC)).resolves.toEqual({ flushedCredits: 5, ok: true });

      expect(readLedgerValue(sqlite, SEPTEMBER_LEDGER_KEY)).toEqual({ window: "2026-09", usedCredits: 7 });
      expect(readLedgerValue(sqlite, OCTOBER_LEDGER_KEY)).toEqual({ window: "2026-10", usedCredits: 5 });
      await expect(
        loadDwellirBudgetState(db, { DWELLIR_API_KEY: API_KEY }, OCTOBER_NOW_SEC),
      ).resolves.toMatchObject({ usedCredits: 5, usable: true });
    } finally {
      sqlite.close();
    }
  });

  it("restores the drained credits when D1 rejects the write so the next flush writes the combined amount", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = makeCreditLedgerDb();
    db.failWrites(new Error("D1_ERROR: ledger write failed"));
    recordDwellirCredits(2);
    await expect(flushDwellirCredits(db, SEPTEMBER_NOW_SEC)).resolves.toEqual({ flushedCredits: 0, ok: false });
    expect(db.writes).toEqual([]);

    db.failWrites(null);
    recordDwellirCredits(3);
    await expect(flushDwellirCredits(db, SEPTEMBER_NOW_SEC)).resolves.toEqual({ flushedCredits: 5, ok: true });
    expect(db.values[SEPTEMBER_LEDGER_KEY]).toBe(septemberRow(5));
    expect(JSON.stringify(warn.mock.calls)).toContain("dwellir_credit_flush_failed");
  });

  it("retries a lost compare-and-swap without double counting the drained credits", async () => {
    const db = makeCreditLedgerDb();
    db.loseWrites(1);
    recordDwellirCredits(6);
    await expect(flushDwellirCredits(db, SEPTEMBER_NOW_SEC)).resolves.toEqual({ flushedCredits: 6, ok: true });
    expect(db.values[SEPTEMBER_LEDGER_KEY]).toBe(septemberRow(6));
    expect(db.writes).toHaveLength(1);
  });

  it("keeps the drained credits pending when every compare-and-swap attempt is lost", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = makeCreditLedgerDb({ [SEPTEMBER_LEDGER_KEY]: septemberRow(1) });
    db.loseWrites(Number.POSITIVE_INFINITY);
    recordDwellirCredits(4);
    await expect(flushDwellirCredits(db, SEPTEMBER_NOW_SEC)).resolves.toEqual({ flushedCredits: 0, ok: false });
    expect(db.writes).toEqual([]);

    db.loseWrites(0);
    await expect(flushDwellirCredits(db, SEPTEMBER_NOW_SEC)).resolves.toEqual({ flushedCredits: 4, ok: true });
    expect(db.values[SEPTEMBER_LEDGER_KEY]).toBe(septemberRow(5));
  });

  it("keeps the drained credits pending when the month ledger row is corrupt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = makeCreditLedgerDb({ [SEPTEMBER_LEDGER_KEY]: "{not-json" });
    recordDwellirCredits(2);
    await expect(flushDwellirCredits(db, SEPTEMBER_NOW_SEC)).resolves.toEqual({ flushedCredits: 0, ok: false });
    expect(db.writes).toEqual([]);

    db.values[SEPTEMBER_LEDGER_KEY] = septemberRow(1);
    await expect(flushDwellirCredits(db, SEPTEMBER_NOW_SEC)).resolves.toEqual({ flushedCredits: 2, ok: true });
    expect(db.values[SEPTEMBER_LEDGER_KEY]).toBe(septemberRow(3));
  });
});

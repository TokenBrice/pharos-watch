import { readJsonResponse } from "../../../src/test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApiRequest, stubCryptoForAuth } from "../../../src/test-helpers/__shared/auth";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getReferenceSessionState } from "@shared/lib/reference-market-hours";
import type { DatabaseSync } from "node:sqlite";
import { handleBackfillStabilityIndex, type BackfillStabilityIndexRouteContext } from "../backfill-stability-index";
import { computeStabilityIndex } from "../../../src/lib/stability-index";
import { seedPsiDews } from "../../../src/api/__tests__/psi-replay.test-support";
import type { PsiHistoricalDewsRow } from "../../../src/lib/psi-replay";

stubCryptoForAuth();

const fixtures = createLatestSchemaFixtureTracker();

/** The route hydrates `url` from the request; mirror that for the direct-call suites. */
function callBackfillStabilityIndex(context: Omit<BackfillStabilityIndexRouteContext, "url">): Promise<Response> {
  const url = context.request
    ? new URL(context.request.url)
    : new URL("https://api.pharos.watch/api/backfill-stability-index");
  return handleBackfillStabilityIndex({ ...context, url });
}

vi.mock("../../../src/lib/stability-index", () => ({
  computeStabilityIndex: vi.fn(() => ({
    score: 73.2,
    band: "Stable",
    components: {
      severity: 10,
      breadth: 5,
      stressBreadth: 3,
      trend: 4,
    },
  })),
}));

interface CapturedBackfillState {
  stabilityRows?: Array<{
    computed_at: number;
    score: number;
    band: string;
    components?: string | null;
    input_snapshot?: string | null;
    methodology_version: string | null;
  }>;
  rebuildRows?: Array<{
    computed_at: number;
    score: number;
    band: string;
    components: string;
    input_snapshot: string;
    methodology_version: string;
  }>;
}

interface BackfillTestDb extends D1Database {
  sqlite: DatabaseSync;
}

function makeDb(options?: {
  earliest?: number | null;
  depegRows?: Array<{
    stablecoin_id: string;
    peak_deviation_bps: number;
    peg_reference: number;
    started_at: number;
    ended_at: number | null;
  }>;
  supplyRows?: Array<{
    stablecoin_id: string;
    snapshot_date: number;
    circulating_usd: number;
    price?: number | null;
  }>;
  /** Omit for an observed calm generation on each supplied date; [] tests absence. */
  dewsRows?: PsiHistoricalDewsRow[];
  stabilityRows?: Array<{
    computed_at: number;
    score: number;
    band: string;
    components?: string | null;
    input_snapshot?: string | null;
    methodology_version: string | null;
  }>;
  captureState?: CapturedBackfillState;
  onExec?: (sql: string) => void;
}): BackfillTestDb {
  const { sqlite, db } = fixtures.open();
  const depegRows = options?.depegRows ?? (
    options?.earliest == null
      ? []
      : [{
          stablecoin_id: "usdt-tether",
          peak_deviation_bps: -120,
          peg_reference: 1,
          started_at: options.earliest,
          ended_at: null,
        }]
  );
  const insertDepeg = sqlite.prepare(
    `INSERT INTO depeg_events
       (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at,
        ended_at, start_price, peak_price, peg_reference, source)
     VALUES (?, ?, 'peggedUSD', 'below', ?, ?, ?, 1, 0.99, ?, 'backfill')`,
  );
  for (const row of depegRows) {
    insertDepeg.run(
      row.stablecoin_id,
      row.stablecoin_id,
      row.peak_deviation_bps,
      row.started_at,
      row.ended_at,
      row.peg_reference,
    );
  }

  const insertSupply = sqlite.prepare(
    "INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
  );
  for (const row of options?.supplyRows ?? []) {
    insertSupply.run(row.stablecoin_id, row.snapshot_date, row.circulating_usd, row.price ?? null);
  }
  const dewsRows = options?.dewsRows ?? [...new Set((options?.supplyRows ?? []).map((row) => row.snapshot_date))]
    .map((snapshot_date) => ({ stablecoin_id: "usdt-tether", snapshot_date, band: "CALM" }));
  seedPsiDews(sqlite, dewsRows);

  const insertStability = sqlite.prepare(
    `INSERT INTO stability_index
       (computed_at, score, band, components, input_snapshot, methodology_version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of options?.stabilityRows ?? []) {
    insertStability.run(
      row.computed_at,
      row.score,
      row.band,
      row.components ?? "{}",
      row.input_snapshot ?? "{}",
      row.methodology_version ?? "3.0",
    );
  }

  const syncCapturedState = () => {
    if (!options?.captureState) return;
    options.captureState.stabilityRows = sqlite.prepare(
      `SELECT computed_at, score, band, components, input_snapshot, methodology_version
         FROM stability_index ORDER BY computed_at`,
    ).all() as CapturedBackfillState["stabilityRows"];
    const rebuildExists = sqlite.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'stability_index_rebuild'",
    ).get();
    if (rebuildExists) {
      options.captureState.rebuildRows = sqlite.prepare(
        `SELECT computed_at, score, band, components, input_snapshot, methodology_version
           FROM stability_index_rebuild ORDER BY computed_at`,
      ).all() as CapturedBackfillState["rebuildRows"];
    }
  };
  syncCapturedState();

  const originalBatch = db.batch.bind(db);
  db.batch = (async (statements: D1PreparedStatement[]) => {
    const results = await originalBatch(statements);
    syncCapturedState();
    return results;
  }) as typeof db.batch;

  const originalExec = db.exec.bind(db);
  db.exec = (async (sql: string) => {
    options?.onExec?.(sql);
    return originalExec(sql);
  }) as typeof db.exec;

  return Object.assign(db, { sqlite }) as BackfillTestDb;
}

describe("handleBackfillStabilityIndex", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-05T10:00:00Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fixtures.closeAll();
    vi.useRealTimers();
  });

  it("preserves the published row when interior native replay evidence is unavailable", async () => {
    const day = Math.floor(Date.now() / 1000 / 86400) * 86400 - 86400;
    const db = makeDb({
      stabilityRows: [{ computed_at: day, score: 87.3, band: "STEADY", methodology_version: "3.0", input_snapshot: "{}" }],
      depegRows: [{ stablecoin_id: "eurc-circle", peak_deviation_bps: -200, peg_reference: 1,
        started_at: day, ended_at: null }],
      supplyRows: [
        { stablecoin_id: "eurc-circle", snapshot_date: day - 7 * 86400, circulating_usd: 1e9, price: 1.08 },
        { stablecoin_id: "eurc-circle", snapshot_date: day, circulating_usd: 1e9, price: 1.08 },
      ],
    });
    db.sqlite.prepare("UPDATE depeg_events SET peg_type = 'peggedEUR', source = 'live', start_price = 0.98").run();
    seedPsiDews(db.sqlite, [{ stablecoin_id: "eurc-circle", snapshot_date: day, band: "ALERT" }]);
    const response = await callBackfillStabilityIndex({
      db, trustedAdmin: true,
      request: makeApiRequest(`/api/backfill-stability-index?startDay=${day}&endDay=${day}`, { method: "POST", adminKey: "secret" }),
    });
    expect(await readJsonResponse(response, 200)).toMatchObject({
      daysBackfilled: 0, unavailableDays: [{ day, reason: "open-depeg-inputs-unavailable", openDepegsWithoutPrice: 1 }],
    });
    expect(db.sqlite.prepare("SELECT score, input_snapshot FROM stability_index WHERE computed_at = ?").get(day))
      .toEqual({ score: 87.3, input_snapshot: "{}" });
  });

  it.each([false, true])("applies dated EUR evidence at a retained slot when available=%s", async (available) => {
    const day = Math.floor(Date.now() / 1000 / 86400) * 86400 - 86400;
    const at = day + 1800;
    const referenceMarketRepair = { method: "samples", sampleScores: { [at + 60]: 91 } };
    const db = makeDb({
      stabilityRows: [
        { computed_at: day, score: 87.3, band: "STEADY", methodology_version: "3.0", input_snapshot: JSON.stringify({ referenceMarketRepair }) },
        { computed_at: day, score: 70, band: "TREMOR", methodology_version: "3.0", input_snapshot: "{}" },
      ],
      depegRows: [{ stablecoin_id: "eurc-circle", peak_deviation_bps: -200, peg_reference: 1.2,
        started_at: day - 3600, ended_at: null }],
      supplyRows: [day - 7 * 86400, day].map((snapshot_date) => ({
        stablecoin_id: "eurc-circle", snapshot_date, circulating_usd: 1e9, price: 1.08,
      })),
    });
    db.sqlite.exec(`UPDATE depeg_events SET peg_type = 'peggedEUR';
      INSERT INTO depeg_event_provenance (event_id, source_kind, quote_mode, created_at, updated_at)
      SELECT id, 'backfill', 'usd', started_at, started_at FROM depeg_events;`);
    db.sqlite.prepare("UPDATE supply_history SET price_observed_at = ? WHERE snapshot_date = ?").run(at, day);
    db.sqlite.prepare("INSERT INTO stability_index_samples (stored_at, score, band, components, input_snapshot) VALUES (?, 87, 'STEADY', '{}', '{}')").run(at + 60);
    const response = await callBackfillStabilityIndex({
      db, trustedAdmin: true,
      references: { referenceAt: (currency, quotedAt) => available && currency === "EUR" && quotedAt === at
        ? { usdPerUnit: 1.1, observedAtSec: at - 60, source: "openExchangeRates", kind: "fx",
          observation: { pegKey: "peggedEUR", usdPerUnit: 1.1, observedAtSec: at - 60, source: "openExchangeRates",
            cadence: "intraday", repricing: { source: "openExchangeRates", preCloseUsdPerUnit: 1.12,
              sessionOpenedAtSec: getReferenceSessionState("fx", at).sessionOpenedAtSec! } } } : null },
      request: makeApiRequest(`/api/backfill-stability-index?startDay=${day}&endDay=${day}`, { method: "POST", adminKey: "secret" }),
    });
    expect(await readJsonResponse(response, 200)).toMatchObject({ daysBackfilled: available ? 1 : 0 });
    const stored = db.sqlite.prepare("SELECT score, input_snapshot FROM stability_index WHERE computed_at = ?").get(day);
    expect(stored?.score).toBe(available ? 73.2 : 87.3);
    expect(JSON.parse(String(stored?.input_snapshot)).referenceMarketRepair).toEqual(referenceMarketRepair);
    if (available) expect(computeStabilityIndex).toHaveBeenCalledWith(expect.objectContaining({
      depegs: [expect.objectContaining({ bps: expect.closeTo(-181.818, 1) })],
    }));
  });

  it.each(["trend-inputs-unavailable", "dews-archive-unavailable"])("preserves an accepted day when %s", async (reason) => {
    const day = Math.floor(Date.now() / 1000 / 86400) * 86400 - 86400;
    const preserved = {
      computed_at: day, score: 87.3, band: "STEADY", methodology_version: "3.0",
      components: JSON.stringify({ severity: 3, breadth: 4.7, stressBreadth: 5, trend: 0 }),
      input_snapshot: JSON.stringify({ dewsStressBreadth: 12, stressBreadthIncluded: true }),
    };
    const supplyRows = [{ stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 100e9, price: 0.98 }];
    if (reason === "dews-archive-unavailable") {
      supplyRows.push({ ...supplyRows[0], snapshot_date: day - 7 * 86400 });
    }
    const db = makeDb({ earliest: day, supplyRows, stabilityRows: [preserved], dewsRows: reason === "dews-archive-unavailable"
      ? [] : [{ stablecoin_id: "usdt-tether", snapshot_date: day, band: "CALM" }] });
    const response = await callBackfillStabilityIndex({
      db, request: makeApiRequest(`/api/backfill-stability-index?startDay=${day}&endDay=${day}`, { method: "POST", adminKey: "secret" }),
    });
    expect(await readJsonResponse(response, 200)).toMatchObject({
      daysBackfilled: 0, skippedInsufficientData: 1,
      unavailableDays: [{ day, reason, trendUnavailableIds: expect.any(Array) }],
    });
    expect(db.sqlite.prepare(`SELECT computed_at, score, band, components, input_snapshot, methodology_version
      FROM stability_index WHERE computed_at = ?`).get(day)).toEqual(preserved);
  });

  it("rebuilds daily PSI rows and reports days backfilled", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const start = nowSec - 2 * 86400;
    const day0 = Math.floor((nowSec - 2 * 86400) / 86400) * 86400;
    const day1 = Math.floor((nowSec - 86400) / 86400) * 86400;
    const day2 = Math.floor(nowSec / 86400) * 86400;

    const res = await callBackfillStabilityIndex({ db: makeDb({
        earliest: start,
        depegRows: [
          {
            stablecoin_id: "usdt-tether",
            peak_deviation_bps: -120,
            peg_reference: 1,
            started_at: start,
            ended_at: null,
          },
        ],
        supplyRows: [
          { stablecoin_id: "usdt-tether", snapshot_date: day0 - 7 * 86400, circulating_usd: 99_000_000, price: 1 },
          { stablecoin_id: "usdt-tether", snapshot_date: day1 - 7 * 86400, circulating_usd: 100_000_000, price: 0.9975 },
          { stablecoin_id: "usdt-tether", snapshot_date: day0, circulating_usd: 99_000_000, price: 1 },
          { stablecoin_id: "usdt-tether", snapshot_date: day1, circulating_usd: 100_000_000, price: 0.9975 },
          { stablecoin_id: "usdt-tether", snapshot_date: day2, circulating_usd: 101_000_000, price: 0.999 },
        ],
      }), trustedAdmin: true, request: makeApiRequest("/api/backfill-stability-index", { method: "POST", adminKey: "secret" }) });

    const body = (await readJsonResponse(res, 200)) as { ok: boolean; daysBackfilled: number; endDay: number; daysEvaluated: number };
    expect(body.ok).toBe(true);
    expect(body.daysBackfilled).toBeGreaterThanOrEqual(2);
    expect(body.daysEvaluated).toBeGreaterThanOrEqual(body.daysBackfilled);
    expect(body.endDay).toBe(day1);
  });

  it("keeps out-of-range rows intact for bounded non-dry-run rebuilds", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const targetDay = Math.floor((nowSec - 2 * 86400) / 86400) * 86400;
    const preservedBefore = targetDay - 86400;
    const preservedAfter = targetDay + 86400;
    const state: CapturedBackfillState = {};

    const db = makeDb({
      earliest: targetDay,
      depegRows: [
        {
          stablecoin_id: "usdt-tether",
          peak_deviation_bps: -120,
          peg_reference: 1,
          started_at: targetDay,
          ended_at: null,
        },
      ],
      supplyRows: [
        { stablecoin_id: "usdt-tether", snapshot_date: targetDay - 7 * 86400, circulating_usd: 99_000_000, price: 1 },
        { stablecoin_id: "usdt-tether", snapshot_date: targetDay, circulating_usd: 100_000_000, price: 0.996 },
      ],
      stabilityRows: [
        { computed_at: preservedBefore, score: 11, band: "Stable", methodology_version: "2.0" },
        { computed_at: targetDay, score: 22, band: "Stable", methodology_version: "2.0" },
        { computed_at: preservedAfter, score: 33, band: "Stable", methodology_version: "2.0" },
      ],
      captureState: state,
    });

    const res = await callBackfillStabilityIndex({ db, trustedAdmin: true, request: makeApiRequest(`/api/backfill-stability-index?startDay=${targetDay}&endDay=${targetDay}`, {
        method: "POST",
        adminKey: "secret",
      }) });

    expect(res.status).toBe(200);
    expect(state.stabilityRows).toEqual([
      expect.objectContaining({ computed_at: preservedBefore, score: 11, band: "Stable", methodology_version: "2.0" }),
      expect.objectContaining({ computed_at: targetDay }),
      expect.objectContaining({ computed_at: preservedAfter, score: 33, band: "Stable", methodology_version: "2.0" }),
    ]);
    expect(
      state.stabilityRows?.find((row: { computed_at: number; score: number }) => row.computed_at === targetDay)?.score,
    ).not.toBe(22);
  });

  it("preserves an existing row when replay inputs are insufficient for that day", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const targetDay = Math.floor((nowSec - 2 * 86400) / 86400) * 86400;
    const state: CapturedBackfillState = {};
    const preservedRow = {
      computed_at: targetDay,
      score: 22,
      band: "Stable",
      components: JSON.stringify({ severity: 1, breadth: 2, stressBreadth: 0, trend: 0 }),
      input_snapshot: JSON.stringify({ preserved: true }),
      methodology_version: "2.0",
    };

    vi.mocked(computeStabilityIndex).mockReturnValueOnce(null);

    const db = makeDb({
      earliest: targetDay,
      depegRows: [
        {
          stablecoin_id: "usdt-tether",
          peak_deviation_bps: -120,
          peg_reference: 1,
          started_at: targetDay,
          ended_at: null,
        },
      ],
      stabilityRows: [preservedRow],
      captureState: state,
    });

    const res = await callBackfillStabilityIndex({ db, trustedAdmin: true, request: makeApiRequest(`/api/backfill-stability-index?startDay=${targetDay}&endDay=${targetDay}`, {
        method: "POST",
        adminKey: "secret",
      }) });

    expect(res.status).toBe(200);
    expect(state.stabilityRows).toEqual([preservedRow]);
    expect(state.rebuildRows).toEqual([
      expect.objectContaining({
        computed_at: targetDay,
        components: preservedRow.components,
        input_snapshot: preservedRow.input_snapshot,
      }),
    ]);
  });

  it("returns 409 when the advisory backfill lease is already held", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const start = nowSec - 86400;
    const db = makeDb({
      earliest: start,
      depegRows: [
        {
          stablecoin_id: "usdt-tether",
          peak_deviation_bps: -120,
          peg_reference: 1,
          started_at: start,
          ended_at: null,
        },
      ],
    });

    // Make only the cron_leases acquire INSERT report no change (lock held).
    const origPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes("INSERT INTO cron_leases")) {
        const bind = stmt.bind.bind(stmt);
        return {
          ...stmt,
          bind: (...args: unknown[]) => {
            const bound = bind(...args);
            return { ...bound, run: async () => ({ success: true, meta: { changes: 0 } }) };
          },
        } as typeof stmt;
      }
      return stmt;
    }) as typeof db.prepare;

    const res = await callBackfillStabilityIndex({ db, trustedAdmin: true, request: makeApiRequest("/api/backfill-stability-index", { method: "POST", adminKey: "secret" }) });

    expect(res.status).toBe(409);
  });

  it("renews the advisory lease while a non-dry-run backfill is still running", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const start = nowSec - 86400;
    let renewCalls = 0;
    let batchCalls = 0;
    let releaseBatch: (() => void) | undefined;
    const holdBatch = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const db = makeDb({
      earliest: start,
      depegRows: [
        {
          stablecoin_id: "usdt-tether",
          peak_deviation_bps: -120,
          peg_reference: 1,
          started_at: start,
          ended_at: null,
        },
      ],
      supplyRows: [
        { stablecoin_id: "usdt-tether", snapshot_date: start - 7 * 86400, circulating_usd: 99_000_000, price: 1 },
        { stablecoin_id: "usdt-tether", snapshot_date: start, circulating_usd: 100_000_000, price: 0.998 },
      ],
    });

    const origPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes("UPDATE cron_leases")) {
        const bind = stmt.bind.bind(stmt);
        return {
          ...stmt,
          bind: (...args: unknown[]) => {
            const bound = bind(...args);
            return {
              ...bound,
              run: async () => {
                renewCalls++;
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        } as typeof stmt;
      }
      return stmt;
    }) as typeof db.prepare;

    const origBatch = db.batch.bind(db);
    db.batch = (async (stmts: D1PreparedStatement[]) => {
      batchCalls++;
      if (batchCalls === 2) {
        await holdBatch;
      }
      return origBatch(stmts);
    }) as typeof db.batch;

    const pending = callBackfillStabilityIndex({ db, trustedAdmin: true, request: makeApiRequest("/api/backfill-stability-index", { method: "POST", adminKey: "secret" }) });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(renewCalls).toBeGreaterThanOrEqual(1);

    releaseBatch?.();
    const res = await pending;

    expect(res.status).toBe(200);
  });

  it("fails closed when the authoritative pre-swap lease renewal loses ownership", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const nowSec = Math.floor(Date.now() / 1000);
    const targetDay = Math.floor((nowSec - 86400) / 86400) * 86400;
    const state: CapturedBackfillState = {};
    const execCalls: string[] = [];
    const originalRow = {
      computed_at: targetDay,
      score: 22,
      band: "Stable",
      methodology_version: "2.0",
    };
    const db = makeDb({
      earliest: targetDay,
      depegRows: [
        {
          stablecoin_id: "usdt-tether",
          peak_deviation_bps: -120,
          peg_reference: 1,
          started_at: targetDay,
          ended_at: null,
        },
      ],
      supplyRows: [
        { stablecoin_id: "usdt-tether", snapshot_date: targetDay - 7 * 86400, circulating_usd: 99_000_000, price: 1 },
        { stablecoin_id: "usdt-tether", snapshot_date: targetDay, circulating_usd: 100_000_000, price: 0.998 },
      ],
      stabilityRows: [originalRow],
      captureState: state,
      onExec: (sql) => execCalls.push(sql),
    });

    const origPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const stmt = origPrepare(sql);
      if (!sql.includes("UPDATE cron_leases")) return stmt;
      const bind = stmt.bind.bind(stmt);
      return {
        ...stmt,
        bind: (...args: unknown[]) => {
          const bound = bind(...args);
          return { ...bound, run: async () => ({ success: true, meta: { changes: 0 } }) };
        },
      } as unknown as typeof stmt;
    }) as typeof db.prepare;

    const response = await callBackfillStabilityIndex({ db, trustedAdmin: true, request: makeApiRequest(`/api/backfill-stability-index?startDay=${targetDay}&endDay=${targetDay}`, {
        method: "POST",
        adminKey: "secret",
      }) });

    expect(response.status).toBe(409);
    expect(state.stabilityRows).toEqual([expect.objectContaining(originalRow)]);
    expect(execCalls).toEqual([]);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("backfill_stability_index_lease_lost");
    expect(warnSpy.mock.calls.flat().join(" ")).toContain("backfill_stability_index_scratch_cleanup_deferred");
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("cleans up the scratch table when filling it fails", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const targetDay = Math.floor((nowSec - 86400) / 86400) * 86400;
    const execCalls: string[] = [];
    const db = makeDb({
      earliest: targetDay,
      depegRows: [
        {
          stablecoin_id: "usdt-tether",
          peak_deviation_bps: -120,
          peg_reference: 1,
          started_at: targetDay,
          ended_at: null,
        },
      ],
      supplyRows: [
        { stablecoin_id: "usdt-tether", snapshot_date: targetDay - 7 * 86400, circulating_usd: 99_000_000, price: 1 },
        { stablecoin_id: "usdt-tether", snapshot_date: targetDay, circulating_usd: 100_000_000, price: 0.998 },
      ],
      onExec: (sql) => execCalls.push(sql),
    });
    const origBatch = db.batch.bind(db);
    let batchCalls = 0;
    db.batch = (async (statements: D1PreparedStatement[]) => {
      batchCalls++;
      if (batchCalls === 2) throw new Error("scratch fill failed");
      return origBatch(statements);
    }) as typeof db.batch;

    await expect(callBackfillStabilityIndex({ db, trustedAdmin: true, request: makeApiRequest(`/api/backfill-stability-index?startDay=${targetDay}&endDay=${targetDay}`, {
        method: "POST",
        adminKey: "secret",
      }) })).rejects.toThrow("scratch fill failed");

    expect(execCalls).toEqual(["DROP TABLE IF EXISTS stability_index_rebuild"]);
  });

  it("logs advisory lease release failures without replacing a successful result", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const nowSec = Math.floor(Date.now() / 1000);
    const targetDay = Math.floor((nowSec - 86400) / 86400) * 86400;
    const db = makeDb({
      earliest: targetDay,
      depegRows: [
        {
          stablecoin_id: "usdt-tether",
          peak_deviation_bps: -120,
          peg_reference: 1,
          started_at: targetDay,
          ended_at: null,
        },
      ],
      supplyRows: [
        { stablecoin_id: "usdt-tether", snapshot_date: targetDay - 7 * 86400, circulating_usd: 99_000_000, price: 1 },
        { stablecoin_id: "usdt-tether", snapshot_date: targetDay, circulating_usd: 100_000_000, price: 0.998 },
      ],
    });
    const origPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const stmt = origPrepare(sql);
      if (!sql.includes("DELETE FROM cron_leases")) return stmt;
      const bind = stmt.bind.bind(stmt);
      return {
        ...stmt,
        bind: (...args: unknown[]) => {
          const bound = bind(...args);
          return {
            ...bound,
            run: async () => {
              throw new Error("release failed");
            },
          };
        },
      } as unknown as typeof stmt;
    }) as typeof db.prepare;

    const response = await callBackfillStabilityIndex({ db, trustedAdmin: true, request: makeApiRequest(`/api/backfill-stability-index?startDay=${targetDay}&endDay=${targetDay}`, {
        method: "POST",
        adminKey: "secret",
      }) });

    expect(response.status).toBe(200);
    expect(warnSpy.mock.calls.flat().join(" ")).toContain("backfill_stability_index_lease_release_failed");
    warnSpy.mockRestore();
  });

});

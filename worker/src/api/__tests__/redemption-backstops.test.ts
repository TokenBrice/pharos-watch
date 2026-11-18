import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedemptionBackstopsResponseSchema } from "@shared/types/redemption";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { assertAllD1MatchesUsed, mockD1Strict } from "@shared/test-utils/mock-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeRedemptionWriteRecord } from "../../lib/__tests__/redemption-backstops-store.test-support";
import { loadRedemptionBackstopLiveSignalRows, upsertRedemptionBackstopSnapshots } from "../../lib/redemption-backstops-store";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../../lib/live-reserve-policy";
import { buildRedemptionBackstopEntry } from "../../lib/redemption-backstop/sources";
import { handleRedemptionBackstops } from "../redemption-backstops";
import type * as RedemptionBackstopsStoreModule from "../../lib/redemption-backstops-store";

import { COMPLETED_RUNS_SQL, completedRun, makeCompletedRunsDb, makeRedemptionRow } from "./redemption-backstops.test-support";

describe("handleRedemptionBackstops", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["chfm-mento", "jpym-mento"])("rechecks retained %s at the close and reopen", async (id) => {
    vi.useFakeTimers();
    const close = Date.parse("2026-11-20T21:00:00Z") / 1000;
    const reopen = Date.parse("2026-11-22T23:00:00Z") / 1000;
    const read = async (observedAt: number, now: number, delay: number, paused = false) => {
      vi.setSystemTime(now * 1000);
      const delayed = delay > 0;
      const db = makeCompletedRunsDb([completedRun("run-mento", {
        min_updated_at: observedAt, max_updated_at: observedAt, completed_at: observedAt,
      })], {
        "run-mento": [makeRedemptionRow({
          stablecoin_id: id, updated_at: observedAt,
          immediate_capacity_usd: delayed ? null : paused ? 0 : 10_000_000,
          immediate_capacity_ratio: delayed ? null : paused ? 0 : 1,
          details_json: JSON.stringify({
            resolutionState: "resolved", routeStatus: paused ? "paused" : "open", routeStatusSource: "onchain",
            freshnessKind: "same-run-onchain", sourceTimestamp: observedAt, settlementDelaySec: delay,
            capacityKind: delayed ? "documented-bound" : "live-direct-bounded",
            capacitySemantics: delayed ? "eventual-only" : "immediate-bounded",
          }),
        })],
      });
      const response = await handleRedemptionBackstops(db);
      return {
        row: RedemptionBackstopsResponseSchema.parse(await readJsonResponse(response, 200)).coins[id],
        cacheControl: response.headers.get("Cache-Control"),
      };
    };
    expect(await read(close - 120, close - 30, 0)).toMatchObject({
      row: { immediateCapacityUsd: 10_000_000, settlementDelaySec: 0 },
      cacheControl: expect.stringContaining("s-maxage=30"),
    });
    expect(await read(close - 120, close, 0)).toMatchObject({
      row: { immediateCapacityUsd: null, score: null, routeStatus: "unknown", resolutionState: "missing-capacity" },
    });
    expect(await read(close - 120, close, 0, true)).toMatchObject({
      row: { immediateCapacityUsd: 0, routeStatus: "paused" },
    });
    expect(await read(reopen - 1_800, reopen - 60, 1_800)).toMatchObject({
      row: { score: 88, settlementDelaySec: 60 }, cacheControl: expect.stringContaining("s-maxage=60"),
    });
    expect(await read(reopen - 1_800, reopen, 1_800)).toMatchObject({
      row: { immediateCapacityUsd: null, score: null, resolutionState: "missing-capacity" },
    });
    expect(await read(reopen, reopen, 0)).toMatchObject({
      row: { immediateCapacityUsd: 10_000_000, resolutionState: "resolved" },
    });
  });

  it("expires a measured Mento pause in both HTTP caches and keeps the legacy row unavailable", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const id = "chfm-mento";
    const now = Date.parse("2026-11-20T20:59:00Z") / 1000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    try {
      await upsertRedemptionBackstopSnapshots(db, [makeRedemptionWriteRecord({
        stablecoinId: id, updatedAt: now, score: null, resolutionState: "impaired",
        routeStatus: "paused", routeStatusSource: "onchain", freshnessKind: "same-run-onchain",
        sourceTimestamp: now - LIVE_RESERVE_FRESHNESS_SEC + 30,
        immediateCapacityUsd: 0, immediateCapacityRatio: 0, settlementDelaySec: 0,
      })], { runId: "measured-pause" });

      for (const projection of [undefined, id]) {
        const response = await handleRedemptionBackstops(db, projection);
        expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=31, max-age=31, must-revalidate");
        expect(RedemptionBackstopsResponseSchema.parse(await readJsonResponse(response, 200)).coins[id])
          .toMatchObject({ routeStatus: "paused", immediateCapacityUsd: 0, immediateCapacityRatio: 0 });
      }
      expect((await loadRedemptionBackstopLiveSignalRows(db, [id]))[0]?.immediate_capacity_ratio).toBe(0);
      vi.setSystemTime((now + 31) * 1000);
      const expired = await handleRedemptionBackstops(db, id);
      expect(RedemptionBackstopsResponseSchema.parse(await readJsonResponse(expired, 200)).coins[id])
        .toMatchObject({ routeStatus: "unknown", immediateCapacityUsd: null, immediateCapacityRatio: null });
      expect((await loadRedemptionBackstopLiveSignalRows(db, [id]))[0]?.immediate_capacity_ratio).toBeNull();
      expect(sqlite.prepare(`SELECT immediate_capacity_usd, immediate_capacity_ratio,
        json_extract(details_json, '$.routeStatus') AS route_status
        FROM redemption_backstop_run_rows WHERE snapshot_run_id = 'measured-pause'`).get())
        .toMatchObject({ route_status: "unknown", immediate_capacity_usd: null, immediate_capacity_ratio: null });
    } finally {
      sqlite.close();
    }
  });

  it("retains a measured CHFm pause alongside the USDm payout warning until the pool receipt expires", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const id = "chfm-mento";
    const sourceTimestamp = Date.parse("2026-11-20T20:57:00Z") / 1000;
    const now = sourceTimestamp + 120;
    const warning = {
      routeStatus: "unknown", routeStatusSource: "market-implied", routeStatusReason: "Output asset uncertainty: USDm",
      routeStatusReviewedAt: "2026-11-20", activeDepegStartedAt: now - 3600, activeDepegDirection: "below",
      outputImpairedDependencyId: "cusd-celo",
    } as const;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    try {
      const entry = await buildRedemptionBackstopEntry(db, id, getRedemptionBackstopConfig(id)!, 5e6, 60, now, {
        routeAvailability: warning,
        reserveSnapshotMetadata: {
          stablecoinId: id, fetchedAt: sourceTimestamp, source: "mento", warningCount: 0, warnings: [],
          sourceModel: "dynamic-mix", evidenceClass: "independent", syncStatus: "ok",
          metadata: { freshnessMode: "verified", sourceTimestamp, redemption: {
            capacityUsd: 0, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain", sourceTimestamp,
            routeStatus: "paused", routeStatusSource: "onchain", routeStatusReason: "TradingSuspended", settlementDelaySec: 0,
          } },
        },
      });
      await upsertRedemptionBackstopSnapshots(db, [entry], { runId: "paused-with-payout-warning" });
      const readCoin = async () => RedemptionBackstopsResponseSchema.parse(
        await readJsonResponse(await handleRedemptionBackstops(db, id), 200),
      ).coins[id];
      const impaired = { routeStatusReason: warning.routeStatusReason, resolutionState: "impaired", score: null };
      expect(await readCoin()).toMatchObject({ ...impaired, immediateCapacityUsd: 0, immediateCapacityRatio: 0 });
      expect((await loadRedemptionBackstopLiveSignalRows(db, [id]))[0]?.immediate_capacity_ratio).toBe(0);
      const expiry = sourceTimestamp + LIVE_RESERVE_FRESHNESS_SEC + 1;
      vi.setSystemTime((expiry - 30) * 1000);
      expect((await handleRedemptionBackstops(db, id)).headers.get("Cache-Control")).toContain("s-maxage=30");
      vi.setSystemTime(expiry * 1000);
      expect(await readCoin()).toMatchObject({ ...impaired, immediateCapacityUsd: null, immediateCapacityRatio: null });
      expect((await loadRedemptionBackstopLiveSignalRows(db, [id]))[0]?.immediate_capacity_ratio).toBeNull();
    } finally { sqlite.close(); }
  });

  it("returns 503 when the run manifest cannot be read", async () => {
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
        rows: [],
        throwError: new Error("db unavailable"),
      },
    ]);

    const response = await handleRedemptionBackstops(db);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Redemption backstop snapshot unavailable",
    });
    assertAllD1MatchesUsed(db);
  });

  it("returns 503 without reading current rows when no completed run exists", async () => {
    // Covers both the fresh-database bootstrap and a failed first manifested
    // run: there is no legacy current-table fallback, so the only query is the
    // completed-run manifest read.
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
        rows: [],
      },
    ]);

    const response = await handleRedemptionBackstops(db);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Redemption backstop snapshot unavailable",
    });
    assertAllD1MatchesUsed(db);
  });

  it("returns the current redemption backstop map and methodology from the completed run", async () => {
    const updatedAt = 1_700_000_000;
    const db = makeCompletedRunsDb([completedRun("run-current")], {
      "run-current": [makeRedemptionRow({ snapshot_run_id: "run-current", updated_at: updatedAt })],
    });

    const response = await handleRedemptionBackstops(db);

    const rawBody = await readJsonResponse(response, 200);
    const parsed = RedemptionBackstopsResponseSchema.safeParse(rawBody);
    expect(parsed.success).toBe(true);
    const body = rawBody as {
      coins: Record<
        string,
        {
          score: number;
          effectiveExitScore: number;
          feeDescription?: string;
          resolutionState: string;
          outputDependencyResolution?: { stablecoinId: string; resolutionState: string };
          modelConfidence: string;
          capacityKind?: string;
        }
      >;
      methodology: { version: string; routeFamilyCaps: Record<string, number> };
      updatedAt: number;
      snapshotSource?: string;
    };

    expect(body.updatedAt).toBe(updatedAt);
    expect(body.methodology.version).toBe("1.1");
    expect(body.methodology.routeFamilyCaps).toEqual({ queueRedeem: 70, offchainIssuer: 65 });
    expect(body.snapshotSource).toBe("run-rows");
    expect(body.coins["cusd-cap"]?.resolutionState).toBe("resolved");
    expect(body.coins["cusd-cap"]?.outputDependencyResolution).toEqual({
      stablecoinId: "downstream-output",
      resolutionState: "missing-capacity",
    });
    expect(body.coins["cusd-cap"]?.modelConfidence).toBe("low");
    expect(body.coins["cusd-cap"]?.capacityKind).toBe("live-proxy-validated");
    expect(body.coins["cusd-cap"]?.feeDescription).toContain("Fixed redemption fee");
    assertAllD1MatchesUsed(db);
  });

  it("returns 503 when a completed run has no immutable rows", async () => {
    const db = makeCompletedRunsDb([completedRun("run-mirror")], { "run-mirror": [] });

    const response = await handleRedemptionBackstops(db);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Redemption backstop snapshot unavailable",
    });
    assertAllD1MatchesUsed(db);
  });

  it.each([null, "not-json"])(
    "returns 503 rather than a positive score when immutable details are invalid: %s",
    async (detailsJson) => {
      const db = makeCompletedRunsDb([completedRun("run-corrupt")], {
        "run-corrupt": [makeRedemptionRow({ score: 88, details_json: detailsJson })],
      });
      const response = await handleRedemptionBackstops(db);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "Redemption backstop snapshot unavailable" });
      assertAllD1MatchesUsed(db);
    },
  );

  it("returns 503 for corrupt reserve provenance without salvaging positive scalar columns", async () => {
    const details = JSON.parse(makeRedemptionRow().details_json);
    const db = makeCompletedRunsDb([completedRun("run-corrupt-binding")], {
      "run-corrupt-binding": [makeRedemptionRow({
        details_json: JSON.stringify({ ...details, reserveInput: { generationId: "reserve-new" } }),
      })],
    });
    const response = await handleRedemptionBackstops(db);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Redemption backstop snapshot unavailable" });
    assertAllD1MatchesUsed(db);
  });

  it("retains the earlier immutable timestamp, methodology and stale headers after corrupt latest details", async () => {
    const olderTimestamp = 1_699_700_000;
    const newerTimestamp = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime((newerTimestamp + 60) * 1000);
    const db = makeCompletedRunsDb([
      completedRun("run-new-corrupt", { methodology_version: "4.07" }),
      completedRun("run-old-valid", {
        completed_at: olderTimestamp + 10, min_updated_at: olderTimestamp,
        max_updated_at: olderTimestamp, methodology_version: "3.997",
      }),
    ], {
      "run-new-corrupt": [makeRedemptionRow({
        methodology_version: "4.07", details_json: "not-json", updated_at: newerTimestamp,
      })],
      "run-old-valid": [makeRedemptionRow({ updated_at: olderTimestamp, methodology_version: "3.997" })],
    });
    const response = await handleRedemptionBackstops(db);
    const body = RedemptionBackstopsResponseSchema.parse(await readJsonResponse(response, 200));
    expect(body.updatedAt).toBe(olderTimestamp);
    expect(body.coins["cusd-cap"].updatedAt).toBe(olderTimestamp);
    expect(body.methodology.version).toBe("3.997");
    expect(response.headers.get("X-Data-Age")).toBe(String(newerTimestamp + 60 - olderTimestamp));
    expect(response.headers.get("Warning")).not.toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    assertAllD1MatchesUsed(db);
  });
  it.each(["not-json", null, '{"resolutionState":"resolved","reserveInput":{}}'])(
    "keeps bulk and selected-row freshness on the prior run when an unrequested sibling has invalid details: %s",
    async (details) => {
      const { sqlite, db } = createLatestSchemaSqlite();
      const older = 1_699_700_000;
      const newer = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime((newer + 60) * 1000);
      try {
        for (const [runId, clock] of [["prior", older], ["rejected", newer]] as const) {
          await upsertRedemptionBackstopSnapshots(db, [
            makeRedemptionWriteRecord({ updatedAt: clock }),
            makeRedemptionWriteRecord({ stablecoinId: "usdc-circle", updatedAt: clock }),
          ], { runId, nowSec: clock });
        }
        sqlite.prepare("UPDATE redemption_backstop_run_rows SET details_json = ? WHERE snapshot_run_id = 'rejected' AND stablecoin_id = 'usdc-circle'").run(details);
        for (const id of [undefined, "eurc-circle", "never-published"]) {
          const response = await handleRedemptionBackstops(db, id);
          const body = await readJsonResponse(response, 200);
          expect(body).toMatchObject({ updatedAt: older, methodology: { version: "1.1" } });
          if (id) expect(body).toMatchObject({ projection: {
            generationId: "prior", totalCount: 2,
            updatedAt: id === "eurc-circle" ? older : null,
            unavailableReason: id === "eurc-circle" ? null : "row-not-published",
          } });
          expect(response.headers.get("X-Data-Age")).toBe(String(newer + 60 - older));
          expect(response.headers.get("Warning")).not.toBeNull();
          expect(response.headers.get("Cache-Control")).toBe("no-store");
        }
      } finally { sqlite.close(); }
    },
  );


  it("attributes methodology.version from the completed run manifest", async () => {
    const details = JSON.parse(makeRedemptionRow().details_json);
    const db = makeCompletedRunsDb([completedRun("run-v404", { methodology_version: "4.04" })], {
      "run-v404": [makeRedemptionRow({
        snapshot_run_id: "run-v404", methodology_version: "4.03",
        details_json: JSON.stringify({
          ...details, routeStatus: "open", routeStatusSource: "static-config", holderEligibility: "any-holder",
        }),
      })],
    });

    const response = await handleRedemptionBackstops(db);

    const rawBody = await readJsonResponse(response, 200);
    const parsed = RedemptionBackstopsResponseSchema.safeParse(rawBody);
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.methodology.version : null).toBe("4.04");
    expect(parsed.success ? parsed.data.coins["cusd-cap"]?.methodologyVersion : null).toBe("4.03");
    assertAllD1MatchesUsed(db);
  });

  it("serves an earlier valid completed run when the newest completed run is invalid", async () => {
    const db = makeCompletedRunsDb([
      completedRun("run-new-bad", { expected_count: 2 }),
      completedRun("run-old-valid", { completed_at: 1_700_000_000, min_updated_at: 1_699_999_990, max_updated_at: 1_699_999_990 }),
    ], {
      "run-old-valid": [makeRedemptionRow({ snapshot_run_id: "run-old-valid", updated_at: 1_699_999_990 })],
    });

    const response = await handleRedemptionBackstops(db);
    const rawBody = await readJsonResponse(response, 200);
    const parsed = RedemptionBackstopsResponseSchema.safeParse(rawBody);

    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.updatedAt : null).toBe(1_699_999_990);
    expect(parsed.success ? parsed.data.coins["cusd-cap"]?.updatedAt : null).toBe(1_699_999_990);
    assertAllD1MatchesUsed(db);
  });

  it("emits freshness and cache headers from the completed run timestamp", async () => {
    const updatedAt = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime((updatedAt + 60) * 1000);
    const db = makeCompletedRunsDb([completedRun("run-fresh")], {
      "run-fresh": [makeRedemptionRow({ snapshot_run_id: "run-fresh", updated_at: updatedAt })],
    });

    const response = await handleRedemptionBackstops(db);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=300, max-age=60");
    expect(response.headers.get("X-Data-Age")).toBe("60");
    expect(response.headers.get("Warning")).toBeNull();
    assertAllD1MatchesUsed(db);
  });

  it("emits stale warning headers from the completed run max row timestamp", async () => {
    const updatedAt = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime((updatedAt + 300_000) * 1000);
    const db = makeCompletedRunsDb([completedRun("run-stale", { min_updated_at: updatedAt - 60 })], {
      "run-stale": [makeRedemptionRow({ snapshot_run_id: "run-stale", updated_at: updatedAt })],
    });

    const response = await handleRedemptionBackstops(db);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Data-Age")).toBe("300000");
    expect(response.headers.get("Warning")).toContain("Response is stale (300000s old");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    assertAllD1MatchesUsed(db);
  });

  it("falls back to an earlier valid run when the newest completed run has no max timestamp", async () => {
    const db = makeCompletedRunsDb([
      completedRun("run-missing-max", { max_updated_at: null }),
      completedRun("run-old-valid", { completed_at: 1_700_000_000, min_updated_at: 1_699_999_990, max_updated_at: 1_699_999_990 }),
    ], {
      "run-old-valid": [makeRedemptionRow({ snapshot_run_id: "run-old-valid", updated_at: 1_699_999_990 })],
    });

    const response = await handleRedemptionBackstops(db);
    const rawBody = await readJsonResponse(response, 200);
    const parsed = RedemptionBackstopsResponseSchema.safeParse(rawBody);

    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.updatedAt : null).toBe(1_699_999_990);
    assertAllD1MatchesUsed(db);
  });

  it("returns 503 when the newest completed run populated no rows (zero updatedAt)", async () => {
    const db = makeCompletedRunsDb([
      completedRun("run-empty", { expected_count: 0, written_count: 0, min_updated_at: null, max_updated_at: 0 }),
    ], { "run-empty": [] });

    const response = await handleRedemptionBackstops(db);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Data not yet available" });
    assertAllD1MatchesUsed(db);
  });

  it("rethrows unexpected snapshot building errors instead of masking them as 503", async () => {
    // The real store wraps every load failure in its unavailable error, so this
    // boundary needs a scoped module mock; the dynamic import re-resolves the
    // handler against the mocked store for this test only.
    vi.doMock("../../lib/redemption-backstops-store", async (importOriginal) => {
      const actual = await importOriginal<typeof RedemptionBackstopsStoreModule>();
      return {
        ...actual,
        buildRedemptionBackstopsSnapshot: vi.fn(async () => {
          throw new Error("boom");
        }),
      };
    });
    try {
      vi.resetModules();
      const { handleRedemptionBackstops: handlerWithFailingStore } = await import("../redemption-backstops");
      await expect(handlerWithFailingStore({} as D1Database)).rejects.toThrow("boom");
    } finally {
      vi.doUnmock("../../lib/redemption-backstops-store");
      vi.resetModules();
    }
  });
});

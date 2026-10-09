import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedemptionBackstopsResponseSchema } from "@shared/types/redemption";
import { assertAllD1MatchesUsed, mockD1Strict } from "@shared/test-utils/mock-d1";
import { handleRedemptionBackstops } from "../redemption-backstops";
import type * as RedemptionBackstopsStoreModule from "../../lib/redemption-backstops-store";

import { COMPLETED_RUNS_SQL, completedRun, makeCompletedRunsDb, makeRedemptionRow } from "./redemption-backstops.test-support";

describe("handleRedemptionBackstops", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it.each([null, "", "not-json", '{"resolutionState":', "null", "[]", '"resolved"', "{}"])(
    "quarantines attributable invalid immutable details without admitting their positive score: %s",
    async (detailsJson) => {
      const db = makeCompletedRunsDb([completedRun("run-corrupt")], {
        "run-corrupt": [makeRedemptionRow({ score: 88, details_json: detailsJson })],
      });
      const response = await handleRedemptionBackstops(db);
      const body = RedemptionBackstopsResponseSchema.parse(await readJsonResponse(response, 200));
      expect(body.coins).toEqual({});
      expect(body.updatedAt).toBe(1_700_000_000);
      assertAllD1MatchesUsed(db);
    },
  );

  it("quarantines corrupt attributable reserve payload without salvaging positive scalar columns", async () => {
    const details = JSON.parse(makeRedemptionRow().details_json);
    const db = makeCompletedRunsDb([completedRun("run-corrupt-binding")], {
      "run-corrupt-binding": [makeRedemptionRow({
        details_json: JSON.stringify({ ...details, reserveInput: { generationId: "reserve-new" } }),
      })],
    });
    const response = await handleRedemptionBackstops(db);
    const body = RedemptionBackstopsResponseSchema.parse(await readJsonResponse(response, 200));
    expect(body.coins).toEqual({});
    assertAllD1MatchesUsed(db);
  });

  it("keeps the newest valid zero peer and output clock when one payload is corrupt", async () => {
    const newerTimestamp = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime((newerTimestamp + 60) * 1000);
    const db = makeCompletedRunsDb([
      completedRun("run-new", { methodology_version: "4.07", expected_count: 2, written_count: 2 }),
      completedRun("run-old-valid"),
    ], {
      "run-new": [
        makeRedemptionRow({ methodology_version: "4.07", details_json: "not-json" }),
        makeRedemptionRow({ stablecoin_id: "usdc-circle", methodology_version: "4.07", score: 0, immediate_capacity_usd: 0, immediate_capacity_ratio: 0 }),
      ],
    });
    const response = await handleRedemptionBackstops(db);
    const body = RedemptionBackstopsResponseSchema.parse(await readJsonResponse(response, 200));
    expect(body.updatedAt).toBe(newerTimestamp);
    expect(Object.keys(body.coins)).toEqual(["usdc-circle"]);
    expect(body.coins["usdc-circle"]).toMatchObject({ score: 0, updatedAt: newerTimestamp, immediateCapacityUsd: 0 });
    expect(body.methodology.version).toBe("4.07");
    expect(response.headers.get("X-Data-Age")).toBe("60");
    expect(response.headers.get("Warning")).toBeNull();
    assertAllD1MatchesUsed(db);
  });

  it("attributes methodology.version from the completed run manifest", async () => {
    const details = JSON.parse(makeRedemptionRow().details_json);
    const db = makeCompletedRunsDb([completedRun("run-v404", { methodology_version: "4.04" })], {
      "run-v404": [makeRedemptionRow({
        snapshot_run_id: "run-v404", methodology_version: "4.04",
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
    expect(parsed.success ? parsed.data.coins["cusd-cap"]?.methodologyVersion : null).toBe("4.04");
    assertAllD1MatchesUsed(db);
  });

  it("returns 503 for an untrusted newest completed manifest without falling back", async () => {
    const db = makeCompletedRunsDb([
      completedRun("run-new-bad", { expected_count: 2 }),
      completedRun("run-old-valid"),
    ], {});
    const response = await handleRedemptionBackstops(db);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Redemption backstop snapshot unavailable" });
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
    const db = makeCompletedRunsDb([completedRun("run-stale")], {
      "run-stale": [makeRedemptionRow({ snapshot_run_id: "run-stale", updated_at: updatedAt })],
    });

    const response = await handleRedemptionBackstops(db);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Data-Age")).toBe("300000");
    expect(response.headers.get("Warning")).toContain("Response is stale (300000s old");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    assertAllD1MatchesUsed(db);
  });

  it("returns 503 when the newest completed manifest has no output clock", async () => {
    const db = makeCompletedRunsDb([
      completedRun("run-missing-max", { max_updated_at: null }),
      completedRun("run-old-valid"),
    ], {});
    const response = await handleRedemptionBackstops(db);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Redemption backstop snapshot unavailable" });
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

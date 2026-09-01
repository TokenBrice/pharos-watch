import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedemptionBackstopsResponseSchema } from "@shared/types/redemption";
import { assertAllD1MatchesUsed, mockD1Strict } from "@shared/test-utils/mock-d1";
import { handleRedemptionBackstops } from "../redemption-backstops";

function makeRedemptionRow(overrides: Record<string, unknown> = {}) {
  return {
    stablecoin_id: "cusd-cap",
    score: 88,
    dex_liquidity_score: 29,
    access_score: 100,
    settlement_score: 100,
    execution_certainty_score: 80,
    capacity_score: 100,
    output_asset_quality_score: 80,
    cost_score: 40,
    route_family: "basket-redeem",
    access_model: "permissionless-onchain",
    settlement_model: "atomic",
    execution_model: "deterministic-basket",
    output_asset_type: "stable-basket",
    provider: "supply-full-model",
    source_mode: "estimated",
    immediate_capacity_usd: 10_000_000,
    immediate_capacity_ratio: 1,
    fee_bps: null,
    queue_enabled: 0,
    updated_at: 1_700_000_000,
    methodology_version: "1.1",
    details_json: JSON.stringify({
      resolutionState: "resolved",
      outputDependencyResolution: {
        stablecoinId: "downstream-output",
        resolutionState: "missing-capacity",
      },
      capacityConfidence: "heuristic",
      capacitySemantics: "eventual-only",
      capacityKind: "live-proxy-validated",
      freshnessKind: "verified-source-timestamp",
      sourceTimestamp: 1_699_999_900,
      sourceUrls: ["https://example.com/redemption.json"],
      settlementDelaySec: 3600,
      queueDepthUsd: 12_000_000,
      dailyLimitUsd: 5_000_000,
      minRedeemUsd: 100_000,
      liveHolderEligibility: "whitelisted-primary",
      feeConfidence: "undisclosed-reviewed",
      feeModelKind: "undisclosed-reviewed",
      modelConfidence: "low",
      capsApplied: [],
      feeDescription: "Fixed redemption fee, but public docs do not publish the current rate",
    }),
    ...overrides,
  };
}

const COMPLETED_RUNS_SQL =
  "SELECT run_id, completed_at, expected_count, written_count, min_updated_at, max_updated_at, methodology_version, status, metadata_json FROM redemption_backstop_runs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT ?";
const RUN_ROWS_BY_RUN_ID_SQL =
  "SELECT stablecoin_id, score, dex_liquidity_score, access_score, settlement_score, execution_certainty_score, capacity_score, output_asset_quality_score, cost_score, route_family, access_model, settlement_model, execution_model, output_asset_type, provider, source_mode, immediate_capacity_usd, immediate_capacity_ratio, fee_bps, queue_enabled, updated_at, methodology_version, details_json, snapshot_run_id FROM redemption_backstop_run_rows WHERE snapshot_run_id = ?";

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
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
        rows: [
          {
            run_id: "run-current",
            completed_at: updatedAt + 10,
            expected_count: 1,
            written_count: 1,
            min_updated_at: updatedAt,
            max_updated_at: updatedAt,
            methodology_version: "1.1",
          },
        ],
      },
      {
        match: RUN_ROWS_BY_RUN_ID_SQL,
        matchBinds: ["run-current"],
        rows: [makeRedemptionRow({ snapshot_run_id: "run-current", updated_at: updatedAt })],
      },
    ]);

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
    const updatedAt = 1_700_000_000;
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
        rows: [
          {
            run_id: "run-mirror",
            completed_at: updatedAt + 10,
            expected_count: 1,
            written_count: 1,
            min_updated_at: updatedAt,
            max_updated_at: updatedAt,
            methodology_version: "1.1",
          },
        ],
      },
      {
        match: RUN_ROWS_BY_RUN_ID_SQL,
        matchBinds: ["run-mirror"],
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

  it("attributes methodology.version from the completed run manifest", async () => {
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
        rows: [
          {
            run_id: "run-v404",
            completed_at: 1_700_000_010,
            expected_count: 1,
            written_count: 1,
            min_updated_at: 1_700_000_000,
            max_updated_at: 1_700_000_000,
            methodology_version: "4.04",
          },
        ],
      },
      {
        match: RUN_ROWS_BY_RUN_ID_SQL,
        matchBinds: ["run-v404"],
        rows: [makeRedemptionRow({ snapshot_run_id: "run-v404", methodology_version: "4.03" })],
      },
    ]);

    const response = await handleRedemptionBackstops(db);

    const rawBody = await readJsonResponse(response, 200);
    const parsed = RedemptionBackstopsResponseSchema.safeParse(rawBody);
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.methodology.version : null).toBe("4.04");
    expect(parsed.success ? parsed.data.coins["cusd-cap"]?.methodologyVersion : null).toBe("4.03");
    assertAllD1MatchesUsed(db);
  });

  it("serves an earlier valid completed run when the newest completed run is invalid", async () => {
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
        rows: [
          {
            run_id: "run-new-bad",
            completed_at: 1_700_000_010,
            expected_count: 2,
            written_count: 1,
            min_updated_at: 1_700_000_000,
            max_updated_at: 1_700_000_000,
            methodology_version: "1.1",
          },
          {
            run_id: "run-old-valid",
            completed_at: 1_700_000_000,
            expected_count: 1,
            written_count: 1,
            min_updated_at: 1_699_999_990,
            max_updated_at: 1_699_999_990,
            methodology_version: "1.1",
          },
        ],
      },
      {
        match: RUN_ROWS_BY_RUN_ID_SQL,
        matchBinds: ["run-old-valid"],
        rows: [
          makeRedemptionRow({
            snapshot_run_id: "run-old-valid",
            updated_at: 1_699_999_990,
          }),
        ],
      },
    ]);

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
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
        rows: [
          {
            run_id: "run-fresh",
            completed_at: updatedAt + 10,
            expected_count: 1,
            written_count: 1,
            min_updated_at: updatedAt,
            max_updated_at: updatedAt,
            methodology_version: "1.1",
          },
        ],
      },
      {
        match: RUN_ROWS_BY_RUN_ID_SQL,
        matchBinds: ["run-fresh"],
        rows: [makeRedemptionRow({ snapshot_run_id: "run-fresh", updated_at: updatedAt })],
      },
    ]);

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
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
        rows: [
          {
            run_id: "run-stale",
            completed_at: updatedAt + 10,
            expected_count: 1,
            written_count: 1,
            min_updated_at: updatedAt - 60,
            max_updated_at: updatedAt,
            methodology_version: "1.1",
          },
        ],
      },
      {
        match: RUN_ROWS_BY_RUN_ID_SQL,
        matchBinds: ["run-stale"],
        rows: [makeRedemptionRow({ snapshot_run_id: "run-stale", updated_at: updatedAt })],
      },
    ]);

    const response = await handleRedemptionBackstops(db);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Data-Age")).toBe("300000");
    expect(response.headers.get("Warning")).toContain("Response is stale (300000s old");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    assertAllD1MatchesUsed(db);
  });

  it("falls back to an earlier valid run when the newest completed run has no max timestamp", async () => {
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
        rows: [
          {
            run_id: "run-missing-max",
            completed_at: 1_700_000_010,
            expected_count: 1,
            written_count: 1,
            min_updated_at: 1_700_000_000,
            max_updated_at: null,
            methodology_version: "1.1",
          },
          {
            run_id: "run-old-valid",
            completed_at: 1_700_000_000,
            expected_count: 1,
            written_count: 1,
            min_updated_at: 1_699_999_990,
            max_updated_at: 1_699_999_990,
            methodology_version: "1.1",
          },
        ],
      },
      {
        match: RUN_ROWS_BY_RUN_ID_SQL,
        matchBinds: ["run-old-valid"],
        rows: [makeRedemptionRow({ snapshot_run_id: "run-old-valid", updated_at: 1_699_999_990 })],
      },
    ]);

    const response = await handleRedemptionBackstops(db);
    const rawBody = await readJsonResponse(response, 200);
    const parsed = RedemptionBackstopsResponseSchema.safeParse(rawBody);

    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.updatedAt : null).toBe(1_699_999_990);
    assertAllD1MatchesUsed(db);
  });
});

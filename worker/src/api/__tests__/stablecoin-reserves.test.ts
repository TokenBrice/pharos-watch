import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleStablecoinReserves, reserveCacheControlForMode } from "../stablecoin-reserves";
import { StablecoinReservesResponseSchema, ReserveCollectionEligibilitySchema } from "@shared/types/live-reserves";
import type { ReservePresentationMode } from "@shared/types/live-reserves";
import { reserveCompositionRow, reserveSyncRow } from "./stablecoin-reserves.test-support";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../../lib/live-reserves/store-shared";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { WORKER_TRACKED_META_BY_ID, hasWorkerLiveReserves } from "@shared/lib/stablecoins/worker-runtime-registry";
import { getReserves } from "@shared/lib/reserve-templates";
import { getLiveReserveAdapterDefinition, computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";

import { RESERVE_FEED_REVIEWS } from "../../lib/reserve-feed-reviews";

const acknowledgedReview = RESERVE_FEED_REVIEWS.find((review) => review.stablecoinId === "mtbill-midas")!;

function reviewedSyncRow(now: number, overrides: Parameters<typeof reserveSyncRow>[1] = {}) {
  return {
    ...reserveSyncRow(now, {
      last_status: "error",
      last_error: acknowledgedReview.errorPrefix,
      metadata: JSON.stringify({ failureCategory: acknowledgedReview.failureCategory }),
      ...overrides,
    }),
    stablecoin_id: acknowledgedReview.stablecoinId,
    adapter_key: acknowledgedReview.adapterKey,
    config_fingerprint: computeLiveReserveConfigFingerprint(WORKER_TRACKED_META_BY_ID.get(acknowledgedReview.stablecoinId)!.liveReservesConfig!),
  };
}

function reviewedCompositionRow(fetchedAt: number) {
  const definition = getLiveReserveAdapterDefinition(acknowledgedReview.adapterKey)!;
  return {
    ...reserveCompositionRow(fetchedAt, {
      metadata: JSON.stringify({ freshnessMode: "verified", sourceTimestamp: fetchedAt }),
    }),
    stablecoin_id: acknowledgedReview.stablecoinId,
    source: acknowledgedReview.adapterKey,
    adapter_source_model: definition.sourceModel,
    adapter_evidence_class: definition.evidenceClass,
    config_fingerprint: computeLiveReserveConfigFingerprint(WORKER_TRACKED_META_BY_ID.get(acknowledgedReview.stablecoinId)!.liveReservesConfig!),
  };
}

describe("handleStablecoinReserves", () => {
  it.each(["quarantined", "frozen", "delisted"] as const)(
    "separates %s collection exclusion from synthetic skipped history", async (status) => {
      const meta = WORKER_TRACKED_META_BY_ID.get("iusd-infinifi")!;
      const priorStatus = meta.status;
      meta.status = status;
      try {
        const db = mockD1([
          { match: "FROM reserve_composition", rows: [] },
          { match: "FROM reserve_sync_state", rows: [] },
        ]);
        const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(await handleStablecoinReserves(db, meta.id), 200));
        expect(body.sync).toMatchObject({
          enabled: true, status: "skipped", bootstrap: true,
          collectionEligibility: { scheduled: false, reason: status },
        });
        expect(body.sync?.lastAttemptedAt).toBeUndefined();
        expect(body.sync?.lastSuccessAt).toBeUndefined();
        expect(body.provenance?.scoringEligible).not.toBe(true);
      } finally { meta.status = priorStatus; }
    },
  );

  it("marks active first-attempt bootstrap as scheduled without creating an attempt clock", async () => {
    const db = mockD1([
      { match: "FROM reserve_composition", rows: [] },
      { match: "FROM reserve_sync_state", rows: [] },
    ]);
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(await handleStablecoinReserves(db, "iusd-infinifi"), 200));
    expect(body.sync).toMatchObject({
      status: "skipped", bootstrap: true, collectionEligibility: { scheduled: true, reason: "active" },
    });
    expect(body.sync?.lastAttemptedAt).toBeUndefined();
  });

  it.each(["circuit-open", "run-budget"] as const)(
    "preserves real %s skip diagnostics independently of current lifecycle eligibility", async (failureCategory) => {
      const now = Math.floor(Date.now() / 1000);
      const db = mockD1([
        { match: "FROM reserve_composition", rows: [] },
        { match: "FROM reserve_sync_state", rows: [], first: reserveSyncRow(now, {
          last_status: "skipped", last_success_at: null,
          metadata: JSON.stringify({ failureCategory }),
        }) },
      ]);
      const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(await handleStablecoinReserves(db, "iusd-infinifi"), 200));
      expect(body.sync).toMatchObject({
        status: "skipped", lastAttemptedAt: now, failureCategory,
        collectionEligibility: { scheduled: true, reason: "active" },
      });
    },
  );

  it("keeps a historical snapshot's clocks and failed-attempt status while collection is excluded", async () => {
    const now = Math.floor(Date.now() / 1000);
    const meta = WORKER_TRACKED_META_BY_ID.get("iusd-infinifi")!;
    const priorStatus = meta.status;
    meta.status = "quarantined";
    const fetchedAt = now - LIVE_RESERVE_FRESHNESS_SEC - 1;
    try {
      const db = mockD1([
        { match: "FROM reserve_composition", rows: [], first: reserveCompositionRow(fetchedAt) },
        { match: "FROM reserve_sync_state", rows: [], first: reserveSyncRow(now, {
          last_status: "error", last_success_at: fetchedAt, last_error: "publisher failed",
        }) },
      ]);
      const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(await handleStablecoinReserves(db, meta.id), 200));
      expect(body.mode).toBe("live-stale");
      expect(body.liveAt).toBe(fetchedAt);
      expect(body.provenance?.scoringEligible).toBe(false);
      expect(body.sync).toMatchObject({
        status: "error", lastAttemptedAt: now, lastSuccessAt: fetchedAt,
        collectionEligibility: { scheduled: false, reason: "quarantined" },
      });
    } finally { meta.status = priorStatus; }
  });

  it.each(["kusd-kerne", "tgbp-tokenised", "inalpha-nest", "usdy-ondo-finance", "usdxl-last"])(
    "retains pre-launch and suspended 404 contract for %s", async (id) => {
      expect((await handleStablecoinReserves(mockD1(), id)).status).toBe(404);
    },
  );

  it.each(["suspended", "unconfigured", "pre-launch"])(
    "rejects unreachable %s eligibility from successful-response schemas", (reason) => {
      expect(ReserveCollectionEligibilitySchema.safeParse({ scheduled: false, reason }).success).toBe(false);
    },
  );

  it("publishes matched acknowledgement without admitting missing evidence", async () => {
    const review = RESERVE_FEED_REVIEWS.find((item) => item.stablecoinId === "mtbill-midas")!;
    vi.useFakeTimers();
    vi.setSystemTime((review.reviewedAt + 1) * 1000);
    try {
      const state = {
        ...reserveSyncRow(review.reviewedAt + 1, {
          last_status: "error", last_success_at: null, last_error: review.errorPrefix,
          metadata: JSON.stringify({ failureCategory: review.failureCategory }),
        }),
        stablecoin_id: review.stablecoinId, adapter_key: review.adapterKey,
      };
      const db = mockD1([
        { match: "FROM reserve_composition", rows: [] },
        { match: "FROM reserve_sync_state", rows: [], first: state },
      ]);
      const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(await handleStablecoinReserves(db, review.stablecoinId), 200));
      expect(body.sync?.acknowledgedFeed).toEqual(review);
      expect(body.sync?.status).toBe("error");
      expect(body.mode).not.toBe("live");
      expect(body.provenance?.scoringEligible).not.toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it.each(["live", "live-stale", "curated-fallback"] as const)(
    "uses one assessment clock for %s freshness and acknowledgement across review expiry",
    async (mode) => {
      const now = acknowledgedReview.expiresAt - 1;
      const fetchedAt = mode === "live-stale" ? now - LIVE_RESERVE_FRESHNESS_SEC - 1 : now;
      const composition = mode === "curated-fallback" ? null : reviewedCompositionRow(fetchedAt);
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);
      const db = mockD1([
        { match: "FROM reserve_composition", rows: [], first: composition },
        {
          match: "FROM reserve_sync_state", rows: [],
          first: reviewedSyncRow(now, { last_success_at: composition ? fetchedAt : null }),
        },
      ]);
      const prepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        // The lookup crosses expiry after the resolver has captured its clock.
        if (sql.includes("FROM reserve_sync_state")) {
          vi.setSystemTime(acknowledgedReview.expiresAt * 1000);
        }
        return prepare(sql);
      });
      try {
        const res = await handleStablecoinReserves(db, acknowledgedReview.stablecoinId);
        const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
        expect(body.mode).toBe(mode);
        expect(body.sync?.acknowledgedFeed).toEqual(acknowledgedReview);
        expect(body.sync?.status).toBe("error");
        expect(body.sync?.freshness?.assessedAt).toBe(now);
        expect(body.sync?.stale).toBe(mode === "live-stale");
        expect(body.provenance?.scoringEligible).toBe(mode === "live" ? true : mode === "live-stale" ? false : undefined);
        if (mode === "live-stale") expect(body.provenance?.scoringRejectionReasons).toContain("stale");
        if (composition) expect(body.reserves).toEqual(JSON.parse(composition.slices));
        expect(res.headers.get("Cache-Control")).toBe(
          mode === "live-stale" ? "public, s-maxage=1800, max-age=120" : "public, s-maxage=300, max-age=60",
        );
      } finally {
        prepareSpy.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each([true, false])(
    "keeps acknowledgement with the presented sync generation when its initial match is %s",
    async (initialMatches) => {
      const now = acknowledgedReview.reviewedAt + 1;
      const unmatchedError = "A new unreviewed issuer failure";
      const initialError = initialMatches ? acknowledgedReview.errorPrefix : unmatchedError;
      const nextError = initialMatches ? unmatchedError : acknowledgedReview.errorPrefix;
      const syncTable = {
        match: "FROM reserve_sync_state", rows: [],
        first: reviewedSyncRow(now, { last_success_at: null, last_error: initialError }),
      };
      const db = mockD1([
        { match: "FROM reserve_composition", rows: [] },
        syncTable,
      ]);
      const prepare = db.prepare.bind(db);
      let syncReads = 0;
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        if (sql.includes("FROM reserve_sync_state") && ++syncReads > 1) {
          syncTable.first = reviewedSyncRow(now + 1, { last_success_at: null, last_error: nextError });
        }
        return prepare(sql);
      });
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);
      try {
        const res = await handleStablecoinReserves(db, acknowledgedReview.stablecoinId);
        const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
        expect(body.sync?.lastError).toBe(initialError);
        expect(body.sync?.lastAttemptedAt).toBe(now);
        expect(body.sync?.acknowledgedFeed).toEqual(initialMatches ? acknowledgedReview : undefined);
        expect(body.mode).toBe("curated-fallback");
        expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, max-age=60");
        expect(db.getHistory().filter(({ sql }) => sql.includes("FROM reserve_sync_state"))).toHaveLength(1);
      } finally {
        prepareSpy.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each(["expired", "before-review", "mismatched", "absent", "uncertain"] as const)(
    "leaves %s sync evidence unacknowledged",
    async (scenario) => {
      const now = scenario === "expired" ? acknowledgedReview.expiresAt
        : scenario === "before-review" ? acknowledgedReview.reviewedAt - 1 : acknowledgedReview.reviewedAt + 1;
      const state = scenario === "absent" ? null : reviewedSyncRow(now, {
        last_success_at: null,
        ...(scenario === "mismatched" ? { last_error: "A new unreviewed issuer failure" } : {}),
        ...(scenario === "uncertain" ? { metadata: JSON.stringify({
          failureCategory: acknowledgedReview.failureCategory, uncertainWrite: true,
        }) } : {}),
      });
      const db = mockD1([
        { match: "FROM reserve_composition", rows: [] },
        { match: "FROM reserve_sync_state", rows: [], first: state },
      ]);
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);
      try {
        const res = await handleStablecoinReserves(db, acknowledgedReview.stablecoinId);
        const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
        expect(body.sync?.acknowledgedFeed).toBeUndefined();
        expect(body.sync?.status).toBe(state ? "error" : "skipped");
        expect(body.mode).toBe("curated-fallback");
        expect(body.provenance?.scoringEligible).not.toBe(true);
        expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, max-age=60");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps a review-history query failure unacknowledged without hiding circuit-open status", async () => {
    const now = acknowledgedReview.reviewedAt + 1;
    const db = mockD1([
      { match: "FROM reserve_composition", rows: [] },
      {
        match: "FROM reserve_sync_state", rows: [],
        first: reviewedSyncRow(now, {
          last_success_at: null, last_status: "skipped", last_error: "Circuit open",
          metadata: JSON.stringify({ failureCategory: "circuit-open" }),
        }),
      },
      { match: "FROM reserve_sync_attempt_history", rows: [], throwError: new Error("Review history unavailable") },
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    try {
      const res = await handleStablecoinReserves(db, acknowledgedReview.stablecoinId);
      const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
      expect(body.sync?.acknowledgedFeed).toBeUndefined();
      expect(body.sync?.status).toBe("skipped");
      expect(body.sync?.failureCategory).toBe("circuit-open");
      expect(body.mode).toBe("curated-fallback");
      expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, max-age=60");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the resolver's sync-read failure instead of fabricating an unacknowledged fallback", async () => {
    const error = new Error("Sync state unavailable");
    const db = mockD1([
      { match: "FROM reserve_composition", rows: [] },
      { match: "FROM reserve_sync_state", rows: [], throwError: error },
    ]);
    await expect(handleStablecoinReserves(db, acknowledgedReview.stablecoinId)).rejects.toThrow(error.message);
  });

  it("does not excuse a retained snapshot's degradation when the current failure is acknowledged", async () => {
    const now = acknowledgedReview.reviewedAt + 1;
    const composition = {
      ...reviewedCompositionRow(now),
      warning_count: 1,
      warnings: JSON.stringify([{ code: "reserve-deficit", message: "Observed reserve deficit", severity: "warning", effect: "degraded" }]),
    };
    const db = mockD1([
      { match: "FROM reserve_composition", rows: [], first: composition },
      { match: "FROM reserve_sync_state", rows: [], first: reviewedSyncRow(now) },
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    try {
      const res = await handleStablecoinReserves(db, acknowledgedReview.stablecoinId);
      const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
      expect(body.sync?.acknowledgedFeed).toEqual(acknowledgedReview);
      expect(body.mode).toBe("live");
      expect(body.provenance?.scoringEligible).toBe(false);
      expect(body.provenance?.scoringRejectionReasons).toContain("degraded-snapshot");
      expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, max-age=60");
    } finally {
      vi.useRealTimers();
    }
  });
  it("preserves every configured feed's reserve display and admission inputs in the Worker projection", () => {
    for (const coin of TRACKED_STABLECOINS.filter((coin) => coin.liveReservesConfig)) {
      const projected = WORKER_TRACKED_META_BY_ID.get(coin.id);
      expect(projected && hasWorkerLiveReserves(projected), coin.id).toBe(true);
      if (!projected || !hasWorkerLiveReserves(projected)) continue;
      expect(projected.liveReservesConfig, coin.id).toEqual(coin.liveReservesConfig);
      expect(getReserves(projected), coin.id).toEqual(getReserves(coin));
    }
  });

  it("keeps USDAI on the reserve endpoint with the curated stablecoin fallback until a validated snapshot is synced", async () => {
    const db = mockD1([
      { match: "FROM reserve_composition", rows: [] },
      { match: "FROM reserve_sync_state", rows: [] },
    ]);
    const res = await handleStablecoinReserves(db, "usdai-usd-ai");

    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, max-age=60");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body).toMatchObject({
      mode: "curated-fallback",
      estimated: false,
      displayUrl: "https://usd.ai/usdai",
      reserves: [
        {
          coinId: "pyusd-paypal",
          pct: 100,
          risk: "low",
        },
      ],
      sync: {
        enabled: true,
        bootstrap: true,
      },
    });
  });

  it("returns a curated fallback payload when no live data exists in D1 yet", async () => {
    const db = mockD1([
      { match: "FROM reserve_composition", rows: [] },
      { match: "FROM reserve_sync_state", rows: [] },
    ]);
    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, max-age=60");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.mode).toBe("curated-fallback");
    expect(body.estimated).toBe(false);
    expect(body.displayBadge).toBeUndefined();
    expect(body.sync?.bootstrap).toBe(true);
  });

  it("returns live slices and preserves stored metadata while deduplicating display evidence URLs", async () => {
    const now = Math.floor(Date.now() / 1000);
    const slices = [{ name: "Test Farm", pct: 100, risk: "low" as const }];
    const storedMetadata = {
      freshnessMode: "not-applicable",
      yieldBasisCollateralPct: 89.7,
      redemption: {
        sourceUrls: [
          "https://stats.infinifi.xyz/",
          "https://docs.infinifi.example/reserves",
          "https://docs.infinifi.example/reserves",
        ],
      },
    };
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: reserveCompositionRow(now, { slices: JSON.stringify(slices), metadata: JSON.stringify(storedMetadata) }),
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: reserveSyncRow(now),
      },
    ]);
    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=3600, max-age=300");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.reserves).toEqual(slices);
    expect(body.estimated).toBe(false);
    expect(body.source).toBe("infinifi");
    expect(body.mode).toBe("live");
    expect(body.metadata).toEqual(storedMetadata);
    expect(body.evidenceUrls).toEqual(["https://docs.infinifi.example/reserves"]);
    expect(body.displayBadge).toEqual({
      kind: "live",
      label: "Live",
    });
    expect(body.provenance).toEqual({
      evidenceClass: "independent",
      sourceModel: "dynamic-mix",
      freshnessMode: "not-applicable",
      scoringEligible: true,
      scoringRejectionReasons: [],
    });
  });

  it("falls back to curated reserves and fallback cache when stored live slices are corrupt", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: reserveCompositionRow(now, { slices: "not json" }),
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: reserveSyncRow(now),
      },
    ]);

    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, max-age=60");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.mode).toBe("curated-fallback");
    expect(body.provenance).toBeUndefined();
    expect(body.displayBadge).toBeUndefined();
    expect(body.sync).toMatchObject({
      enabled: true,
      status: "degraded",
      bootstrap: false,
      warnings: ["Stored live reserve snapshot is unreadable"],
      lastError: "Stored live reserve snapshot rejected: Stored live reserve snapshot is unreadable",
    });
  });

  it("does not serialize internal malformed redemption telemetry markers", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: reserveCompositionRow(now, { slices: JSON.stringify([{ name: "Test Farm", pct: 100, risk: "low" }]), metadata: JSON.stringify({
          freshnessMode: "not-applicable",
          immediateRedeemableUsd: 500_000,
          redemptionFeeBps: 50,
          redemption: {
            capacityUsd: "500000",
            feeBps: null,
          },
        }) }),
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: reserveSyncRow(now),
      },
    ]);

    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("malformedRedemptionTelemetry");
    expect(text).not.toContain("__malformedRedemptionTelemetry");

    const body = StablecoinReservesResponseSchema.parse(JSON.parse(text));
    expect(body.metadata?.redemption).toEqual({});
  });

  registerStablecoinParameterContract({
    name: "stablecoin reserves",
    path: "/api/stablecoin-reserves",
    invoke: (db, url) => handleStablecoinReserves(db, url.searchParams.get("stablecoin") ?? ""),
    cases: [{ kind: "unknown", stablecoin: "not-a-coin", error: "Not found" }],
  });

  it("surfaces lastError from sync state in the API response", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: null,
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: reserveSyncRow(now, { last_success_at: null, last_status: "error", last_error: "HTTP 503 for https://api.example.com", metadata: "{}" }),
      },
    ]);
    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.sync?.lastError).toBe("HTTP 503 for https://api.example.com");
  });

  it("surfaces uncertain write metadata distinctly in the API response", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: null,
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: reserveSyncRow(now, { last_success_at: null, last_status: "error", last_error: "D1 write timeout for iusd-infinifi", metadata: JSON.stringify({
          uncertainWrite: true,
          failureCategory: "storage-write",
          reason: "storage-write-timeout",
        }) }),
      },
    ]);

    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.sync).toMatchObject({
      status: "error",
      uncertainWrite: true,
      failureCategory: "storage-write",
      lastError: "D1 write timeout for iusd-infinifi",
    });
  });

  it("routes live-stale mode to the intermediate cache-control tier", async () => {
    // Composition fetched_at + sync.last_success_at both well beyond the
    // 2-day freshness window (LIVE_RESERVE_FRESHNESS_SEC) so resolveReserveResult
    // returns mode=live-stale.
    const now = Math.floor(Date.now() / 1000);
    const fetchedAt = now - 3 * 24 * 3600;
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: reserveCompositionRow(fetchedAt, { slices: JSON.stringify([{ name: "Test Farm", pct: 100, risk: "low" }]) }),
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: reserveSyncRow(fetchedAt),
      },
    ]);

    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.mode).toBe("live-stale");
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=1800, max-age=120");
    // The route's own fetch budget and the judged generation travel with the verdict.
    const freshness = body.sync?.freshness;
    expect(freshness).toMatchObject({
      stale: true,
      staleReasons: ["fetch-age"],
      fetchedAt,
      attemptId: null,
      fetchBudgetSec: LIVE_RESERVE_FRESHNESS_SEC,
      sourceAgeBudgetSec: null,
    });
    expect(freshness?.fetchAgeSec).toBe(freshness!.assessedAt - fetchedAt);
    expect(freshness!.fetchAgeSec!).toBeGreaterThan(LIVE_RESERVE_FRESHNESS_SEC);
  });


  it.each<[ReservePresentationMode, string]>([
    ["live", "public, s-maxage=3600, max-age=300"],
    ["live-stale", "public, s-maxage=1800, max-age=120"],
    ["curated-fallback", "public, s-maxage=300, max-age=60"],
    ["template-fallback", "public, s-maxage=300, max-age=60"],
    ["unavailable", "public, s-maxage=300, max-age=60"],
  ])("maps mode=%s to the correct Cache-Control tier", (mode, expected) => {
    expect(reserveCacheControlForMode(mode)).toBe(expected);
  });

  it("derates live cache control when the sync is not ok or the write is uncertain", () => {
    expect(reserveCacheControlForMode("live", { enabled: true, status: "ok", stale: false, bootstrap: false }))
      .toBe("public, s-maxage=3600, max-age=300");
    expect(reserveCacheControlForMode("live", { enabled: true, status: "degraded", stale: false, bootstrap: false }))
      .toBe("public, s-maxage=300, max-age=60");
    expect(reserveCacheControlForMode("live", { enabled: true, status: "error", stale: false, bootstrap: false }))
      .toBe("public, s-maxage=300, max-age=60");
    expect(reserveCacheControlForMode("live", { enabled: true, status: "ok", stale: false, bootstrap: false, uncertainWrite: true }))
      .toBe("public, s-maxage=300, max-age=60");
  });
});

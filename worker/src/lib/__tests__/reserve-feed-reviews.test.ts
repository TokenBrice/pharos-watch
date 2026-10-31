import { describe, expect, expectTypeOf, it } from "vitest";
import { ReserveFeedReviewSchema, type ReserveFeedReview } from "@shared/types/live-reserves";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { RESERVE_FEED_REVIEWS, matchReserveFeedReview, resolveReserveFeedReviews } from "../reserve-feed-reviews";
import type { ReserveSyncStateRecord } from "../live-reserves/store-shared";
import { evaluateReserveCompositionStatus } from "../status/evaluation-rules";
import { makeReserveComposition } from "@shared/types/__tests__/status.test-support";

const review = RESERVE_FEED_REVIEWS.find((item) => item.stablecoinId === "yzusd-yuzu")!;
const now = review.reviewedAt + 1;
function state(overrides: Partial<ReserveSyncStateRecord> = {}): ReserveSyncStateRecord {
  return {
    stablecoinId: review.stablecoinId, adapterKey: review.adapterKey, breakerKey: "live-reserves:yzusd-yuzu",
    lastAttemptedAt: now, lastSuccessAt: now - 15 * 86400, lastStatus: "error", warningCount: 0,
    warnings: [], lastError: review.errorPrefix ?? null,
    metadata: { failureCategory: review.failureCategory }, ...overrides,
  };
}

describe("reserve feed review policy", () => {
  it.each(RESERVE_FEED_REVIEWS)("matches only the reviewed failure for $stablecoinId", async (item) => {
    const now = item.reviewedAt + 1;
    const observed = state({
      stablecoinId: item.stablecoinId, adapterKey: item.adapterKey,
      lastStatus: "error", lastError: item.errorPrefix,
      warnings: [],
      metadata: { failureCategory: item.failureCategory },
    });
    expect(await matchReserveFeedReview(mockD1(), observed, now)).toEqual(item);
    expect(await matchReserveFeedReview(mockD1(), { ...observed, lastStatus: "ok", lastSuccessAt: now }, now)).toBeNull();
    expect(await matchReserveFeedReview(mockD1(), {
      ...observed, metadata: { failureCategory: "validation" },
    }, now)).toBeNull();
    expect(await matchReserveFeedReview(mockD1(), {
      ...observed, warnings: [...observed.warnings, {
        code: "new-failure", message: "New failure", severity: "warning", effect: "degraded",
      }],
    }, now)).toBeNull();
    expect(await matchReserveFeedReview(mockD1(), { ...observed, lastError: "Different failure" }, now)).toBeNull();
    expect(await matchReserveFeedReview(mockD1(), { ...observed, lastError: `${item.errorPrefix}: changed cause` }, now)).toBeNull();
  });
  it.each(["adapter-timeout", "run-budget-exhausted", "network", "storage-write"])("cannot authorize operational failure category %s", (failureCategory) => {
    expect(ReserveFeedReviewSchema.safeParse({ ...review, failureCategory }).success).toBe(false);
    expect(resolveReserveFeedReviews(now, [{ ...review, failureCategory } as ReserveFeedReview]).invalidIds).toEqual([review.stablecoinId]);
  });
  it("excludes timeout and budget categories from the review type", () => {
    expectTypeOf<"adapter-timeout">().not.toExtend<ReserveFeedReview["failureCategory"]>();
    expectTypeOf<"run-budget-exhausted">().not.toExtend<ReserveFeedReview["failureCategory"]>();
  });
  it.each([-1, 0, 1])("expires at equality %+is", (offset) => {
    const resolved = resolveReserveFeedReviews(review.expiresAt + offset, [review]);
    expect(resolved.activeById.has(review.stablecoinId)).toBe(offset < 0);
    expect(resolved.expiredIds).toEqual(offset < 0 ? [] : [review.stablecoinId]);
  });
  it("accepts exactly fourteen days but rejects greater", () => {
    expect(resolveReserveFeedReviews(now, [{ ...review, expiresAt: review.reviewedAt + 14 * 86400 }]).invalidIds).toEqual([]);
    expect(resolveReserveFeedReviews(now, [{ ...review, expiresAt: review.reviewedAt + 14 * 86400 + 1 }]).invalidIds).toEqual([review.stablecoinId]);
  });
  it.each([
    { reviewedAt: now + 1 }, { owner: " " }, { sources: [{ url: "http://example.com", evidenceDate: "2026-10-06" }] },
    { sources: [{ url: "https://example.com", evidenceDate: "2026-02-30" }] },
    { sources: [{ url: "https://example.com", evidenceDate: "2026-11-05" }] },
    { expiresAt: review.reviewedAt }, { failureCategory: "" },
  ])("rejects malformed/future review %j", (overrides) => {
    expect(resolveReserveFeedReviews(now, [{ ...review, ...overrides } as ReserveFeedReview]).invalidIds).toEqual([review.stablecoinId]);
  });
  it("rejects every copy of a duplicate identity", () => {
    const result = resolveReserveFeedReviews(now, [review, review]);
    expect(result.activeById.size).toBe(0);
    expect(result.invalidIds).toEqual([review.stablecoinId]);
  });
  it("matches only the named failure and never future/ambiguous/new warnings", async () => {
    expect(await matchReserveFeedReview(mockD1(), state(), now)).toEqual(review);
    for (const overrides of [
      { lastError: "primary:http-json: Accountable:future-portfolio-timestamp" },
      { lastError: "primary:http-json: stale or future portfolio timestamp" },
      { metadata: { failureCategory: "adapter-timeout" } },
      { metadata: { failureCategory: "run-budget-exhausted" } },
      { metadata: { failureCategory: review.failureCategory, uncertainWrite: true } },
      { warnings: [{ code: "new-failure", message: "new", severity: "warning", effect: "degraded" }] },
    ] satisfies Partial<ReserveSyncStateRecord>[]) expect(await matchReserveFeedReview(mockD1(), state(overrides), now)).toBeNull();
  });
  it("does not acknowledge a review from unreadable or count-mismatched warning evidence", async () => {
    expect(await matchReserveFeedReview(mockD1(), state(), now)).toEqual(review);
    for (const overrides of [
      { warningIntegrityIssue: { code: "invalid-warnings", message: "stored reserve warnings contain invalid JSON" } },
      { warningCount: 1 },
    ] satisfies Partial<ReserveSyncStateRecord>[]) {
      expect(await matchReserveFeedReview(mockD1(), state(overrides), now)).toBeNull();
    }
  });
  it("keeps Yuzu's new review dated and short while naming the stale-timeline cause", async () => {
    expect(review.reviewedAt).toBe(Date.parse("2026-10-29T11:02:00Z") / 1000);
    expect(review.expiresAt).toBe(Date.parse("2026-11-05T11:02:00Z") / 1000);
    expect(review.failureCategory).toBe("unknown");
    expect(review.errorPrefix).toBe(
      "primary:http-json: Accountable exposure_split has no contemporaneous timeline reserve total for reconciliation",
    );
    expect(review.sources).toEqual([{ url: "https://cache.accountable.capital/dashboard/yuzu", evidenceDate: "2026-10-29" }]);
    expect(await matchReserveFeedReview(mockD1(), state(), review.expiresAt - 1)).toEqual(review);
    expect(await matchReserveFeedReview(mockD1(), state(), review.expiresAt)).toBeNull();
  });
  it("does not acknowledge the superseded bucket-total cause or a transport failure on the same feed", async () => {
    expect(resolveReserveFeedReviews(now).activeById.get(review.stablecoinId)).toEqual(review);
    for (const lastError of [
      "primary:http-json: Accountable exposure_split bucket total 61782004.86065776 does not match total_reserves 63645930.21",
      "primary:http-json: Accountable exposure_split has no valid timeline reserve total for reconciliation",
      "primary:http-json: Accountable exposure_split_ts is invalid: 2026.13.01 00:00:00 UTC",
      "primary:http-json: Accountable exposure_split has no contemporaneous timeline reserve total for reconciliation: retry",
      "primary:http-json: HTTP 403 for https://cache.accountable.capital/dashboard/yuzu",
    ]) expect(await matchReserveFeedReview(mockD1(), state({ lastError }), now)).toBeNull();
    for (const failureCategory of ["upstream-http", "schema-shape", "corroboration-mismatch"]) {
      expect(await matchReserveFeedReview(mockD1(), state({ metadata: { failureCategory } }), now)).toBeNull();
    }
    const db = mockD1([{ match: "status != 'skipped'", rows: [], first: {
      stablecoin_id: review.stablecoinId, attempted_at: now - 1, adapter_key: review.adapterKey,
      breaker_key: "test", status: "error", warnings: "[]",
      last_error: "primary:http-json: Accountable exposure_split bucket total 1 does not match total_reserves 2",
      metadata: JSON.stringify({ failureCategory: "corroboration-mismatch" }),
    } }]);
    expect(await matchReserveFeedReview(db, state({
      lastStatus: "skipped", metadata: { failureCategory: "circuit-open" },
    }), now)).toBeNull();
  });
  it("retires the recovered Gemini review and the unmatched Midas review", async () => {
    expect(RESERVE_FEED_REVIEWS.map((item) => item.stablecoinId)).toEqual(["yzusd-yuzu"]);
    const midas: ReserveSyncStateRecord = {
      stablecoinId: "mtbill-midas", adapterKey: "midas-mtbill", breakerKey: "live-reserves:mtbill-midas",
      lastAttemptedAt: now, lastSuccessAt: now - 86400, lastStatus: "error", warningCount: 0, warnings: [],
      lastError: "primary:onchain-evm: HTTP 403 for https://api-prod.midas.app/api/transparency/by-timestamp?token=[redacted]&timestamp=2026-10-28T10%3A00",
      metadata: { failureCategory: "upstream-http" },
    };
    expect(await matchReserveFeedReview(mockD1(), midas, now)).toBeNull();
    const midasSaveMismatch: ReserveSyncStateRecord = {
      ...midas, lastError: "primary:onchain-evm: midas-mtbill:save-rounded-totals-mismatch",
      metadata: { failureCategory: "unknown" },
    };
    expect(await matchReserveFeedReview(mockD1(), midasSaveMismatch, now)).toBeNull();
    const gemini: ReserveSyncStateRecord = {
      stablecoinId: "gusd-gemini", adapterKey: "gemini-independent-assurance", breakerKey: "live-reserves:gusd-gemini",
      lastAttemptedAt: now, lastSuccessAt: now, lastStatus: "ok", warningCount: 0, warnings: [], lastError: null,
      metadata: {},
    };
    expect(await matchReserveFeedReview(mockD1(), gemini, now)).toBeNull();
    const retired = { ...gemini, lastStatus: "error" as const,
      lastError: "primary:http-json: gemini-independent-assurance: newer unreviewed report on official index",
      metadata: { failureCategory: "unknown" } };
    expect(await matchReserveFeedReview(mockD1(), retired, now)).toBeNull();
  });
  it("inherits circuit-open only from the latest non-skipped matching attempt", async () => {
    const db = mockD1([{ match: "status != 'skipped'", rows: [], first: {
      stablecoin_id: review.stablecoinId, attempted_at: now - 1, adapter_key: review.adapterKey,
      breaker_key: "test", status: "error", warnings: "[]", last_error: review.errorPrefix,
      metadata: JSON.stringify({ failureCategory: review.failureCategory }),
    } }]);
    expect(await matchReserveFeedReview(db, state({ lastStatus: "skipped", metadata: { failureCategory: "circuit-open" } }), now)).toEqual(review);
  });
  it.each([false, true])("fails closed on missing/unreadable circuit history (%s)", async (failed) => {
    const db = mockD1([{ match: "status != 'skipped'", rows: [], first: null, ...(failed ? { throwError: new Error("read") } : {}) }]);
    expect(await matchReserveFeedReview(db, state({ lastStatus: "skipped", metadata: { failureCategory: "circuit-open" } }), now)).toBeNull();
  });
  it("cannot inherit an uncertain prior attempt through a circuit skip", async () => {
    const db = mockD1([{ match: "status != 'skipped'", rows: [], first: {
      stablecoin_id: review.stablecoinId, attempted_at: now - 1, adapter_key: review.adapterKey,
      breaker_key: "test", status: "error", warnings: "[]", last_error: review.errorPrefix,
      metadata: JSON.stringify({ failureCategory: review.failureCategory, uncertainWrite: true }),
    } }]);
    expect(await matchReserveFeedReview(db, state({ lastStatus: "skipped", metadata: { failureCategory: "circuit-open" } }), now)).toBeNull();
  });
  it.each(["not-json", "{}", "[{}]"])("rejects unreadable warning evidence %s rather than assuming no warnings", async (warnings) => {
    const db = mockD1([{ match: "status != 'skipped'", rows: [], first: {
      stablecoin_id: review.stablecoinId, attempted_at: now - 1, adapter_key: review.adapterKey,
      breaker_key: "test", status: "error", warnings, last_error: review.errorPrefix,
      metadata: JSON.stringify({ failureCategory: review.failureCategory }),
    } }]);
    expect(await matchReserveFeedReview(db, state({ lastStatus: "skipped", metadata: { failureCategory: "circuit-open" } }), now)).toBeNull();
  });
  it("uses adjusted numerator and denominator and retains raw counts", () => {
    const reserve = makeReserveComposition({ configuredCoins: 10, freshCoins: 8, independentFreshEligible: 8,
      healthConfiguredCoins: 8, healthFreshCoins: 6, healthAuthoritativeFreshCoins: 6, lastSuccessAt: now,
      acknowledgedFeedIds: ["a", "b"], persistentlyStaleIndependentCoins: [{ stablecoinId: "a", ageSec: 999999 }],
      unacknowledgedPersistentlyStaleIndependentCoins: [],
    });
    expect(evaluateReserveCompositionStatus(reserve)).toMatchObject({ status: "healthy", freshCoverageRatio: 0.75, authoritativeFreshCoverageRatio: 0.75 });
    expect(reserve.freshCoins).toBe(8);
    expect(evaluateReserveCompositionStatus({ ...reserve, healthFreshCoins: 0 }).status).toBe("stale");
    expect(evaluateReserveCompositionStatus({ ...reserve, healthConfiguredCoins: 0, healthFreshCoins: 0, healthAuthoritativeFreshCoins: 0 }).status).toBe("healthy");
    expect(evaluateReserveCompositionStatus({ ...reserve, writeTimeoutUncertain: 1 }).status).toBe("degraded");
  });
});

import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { RESERVE_FEED_REVIEWS, matchReserveFeedReview, resolveReserveFeedReviews } from "../reserve-feed-reviews";
import type { ReserveSyncStateRecord } from "../live-reserves/store-shared";
import { evaluateReserveCompositionStatus } from "../status/evaluation-rules";
import { makeReserveComposition } from "@shared/types/__tests__/status.test-support";

const review = RESERVE_FEED_REVIEWS.find((item) => item.stablecoinId === "mtbill-midas")!;
const now = review.reviewedAt + 1;
function state(overrides: Partial<ReserveSyncStateRecord> = {}): ReserveSyncStateRecord {
  return {
    stablecoinId: review.stablecoinId, adapterKey: review.adapterKey, breakerKey: "live-reserves:mtbill-midas",
    lastAttemptedAt: now, lastSuccessAt: now - 15 * 86400, lastStatus: "error", warningCount: 0,
    warnings: [], lastError: `${review.errorPrefix} sourceTimestamp=1789733170 nowSec=${now}`,
    metadata: { failureCategory: review.failureCategory }, ...overrides,
  };
}

describe("reserve feed review policy", () => {
  it("enrolls independent and static-validated evidence, but never BNUSD or inactive yzUSD", () => {
    const resolved = resolveReserveFeedReviews(now);
    expect(resolved.invalidIds).toEqual([]);
    expect(resolved.activeById.size).toBe(9);
    expect(resolved.activeById.has("wars-argentine-peso")).toBe(true);
    expect(resolved.activeById.has("bnusd-balanced")).toBe(false);
    expect(resolved.activeById.has("yzusd-yuzu")).toBe(false);
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
    { expiresAt: review.reviewedAt }, { failureCategory: "" },
  ])("rejects malformed/future review %j", (overrides) => {
    expect(resolveReserveFeedReviews(now, [{ ...review, ...overrides }]).invalidIds).toEqual([review.stablecoinId]);
  });
  it("rejects every copy of a duplicate identity", () => {
    const result = resolveReserveFeedReviews(now, [review, review]);
    expect(result.activeById.size).toBe(0);
    expect(result.invalidIds).toEqual([review.stablecoinId]);
  });
  it("matches only the named failure and never future/ambiguous/new warnings", async () => {
    expect(await matchReserveFeedReview(mockD1(), state(), now)).toEqual(review);
    for (const overrides of [
      { lastError: "primary:http-json: midas-mtbill:future-portfolio-timestamp" },
      { lastError: "primary:http-json: midas-mtbill: stale or future portfolio timestamp" },
      { metadata: { failureCategory: "adapter-timeout" } },
      { warnings: [{ code: "new-failure", message: "new" }] },
    ]) expect(await matchReserveFeedReview(mockD1(), state(overrides), now)).toBeNull();
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

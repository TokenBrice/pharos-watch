import { describe, expect, expectTypeOf, it } from "vitest";
import { ReserveFeedReviewSchema, type ReserveFeedReview as Review } from "@shared/types/live-reserves";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { RESERVE_FEED_REVIEWS, matchReserveFeedReview as matchReview, resolveReserveFeedReviews as resolveReviews } from "../reserve-feed-reviews";
import type { ReserveSyncStateRecord as State } from "../live-reserves/store-shared";
import { evaluateReserveCompositionStatus } from "../status/evaluation-rules";
import { makeReserveComposition } from "@shared/types/__tests__/status.test-support";

const review = RESERVE_FEED_REVIEWS.find((r) => r.stablecoinId === "yzusd-yuzu")!;
const accountable = "primary:http-json: Accountable ";
const http = "primary:http-html: HTTP 403 for https://www.fidelitydigitalassets.com/stablecoin?timestamp=changed";
function state(r = review, overrides: Partial<State> = {}): State {
  const now = r.reviewedAt + 1;
  return {
    stablecoinId: r.stablecoinId, adapterKey: r.adapterKey, breakerKey: "test",
    lastAttemptedAt: now, lastSuccessAt: now, lastStatus: r.failureCategory === null ? "degraded" : "error",
    warningCount: r.warningCodes.length,
    warnings: r.warningCodes.map((code) => ({ code, message: code, severity: "warning", effect: "degraded" })),
    lastError: r.errorClass ? http : r.errorPrefix,
    metadata: { failureCategory: r.failureCategory, sourceTimestamp: r.sourceTimestamp ?? now - 1, freshnessMode: "verified" },
    ...overrides,
  };
}
async function check(s: State, r = review, expected: Review | null = r, db = mockD1(), now = r.reviewedAt + 1) {
  expect(await matchReview(db, s, now, resolveReviews(now, [r]).activeById)).toEqual(expected);
}
function history(r = review, overrides: Record<string, unknown> = {}, failed = false) {
  return mockD1([{ match: "status != 'skipped'", rows: [], first: {
    stablecoin_id: r.stablecoinId, attempted_at: r.reviewedAt, adapter_key: r.adapterKey,
    breaker_key: "test", status: "error", warnings: "[]", last_error: r.errorClass ? http : r.errorPrefix,
    metadata: JSON.stringify({ failureCategory: r.failureCategory }), ...overrides,
  }, ...(failed ? { throwError: new Error("read") } : {}) }]);
}
const skipped = { lastStatus: "skipped", lastError: null, metadata: { failureCategory: "circuit-open" } } as const;

describe("reserve feed review policy", () => {
  it("matches authored findings; rejects changed, corrupt, fatal and expired evidence", async () => {
    for (const r of RESERVE_FEED_REVIEWS) {
      const s = state(r);
      await check(s, r);
      const mutations: Partial<State>[] = [
        { adapterKey: "other" }, { metadata: { failureCategory: "validation" } },
        { metadata: { ...s.metadata, uncertainWrite: true } }, { warningCount: s.warningCount + 1 },
        { warningIntegrityIssue: { code: "invalid-warnings", message: "unreadable" } },
        { warnings: [...s.warnings, { code: "new", message: "new", severity: "warning", effect: "degraded" }], warningCount: s.warningCount + 1 },
        { lastError: "Different failure" }, { lastError: `${s.lastError}: changed cause` },
      ];
      if (s.warnings.length) mutations.push({ warnings: s.warnings.map((w) => ({ ...w, effect: "fatal" })) });
      if (r.failureCategory === null) mutations.push(
        { metadata: {} }, { metadata: { ...s.metadata, failureCategory: {} } },
        { metadata: { ...s.metadata, sourceTimestamp: r.reviewedAt + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC + 2 } },
        { lastSuccessAt: r.reviewedAt },
      );
      for (const change of mutations) await check({ ...s, ...change }, r, null);
      await check({ ...s, lastStatus: "ok" }, r, null);
      await check(s, r, r, mockD1(), r.expiresAt - 1);
      expect(await matchReview(mockD1(), s, r.expiresAt, new Map([[r.stablecoinId, r]]))).toBeNull();
    }
  });
  it("validates review identity, dates, categories and classes", () => {
    const now = review.reviewedAt + 1;
    for (const failureCategory of ["adapter-timeout", "run-budget-exhausted", "network", "storage-write"]) {
      expect(ReserveFeedReviewSchema.safeParse({ ...review, failureCategory }).success).toBe(false);
    }
    expectTypeOf<"adapter-timeout" | "run-budget-exhausted">().not.toExtend<Review["failureCategory"]>();
    for (const overrides of [
      { reviewedAt: now + 1 }, { owner: " " }, { sources: [{ url: "http://example.com", evidenceDate: "2026-11-04" }] },
      ...["2026-02-30", "2026-11-08"].map((evidenceDate) => ({ sources: [{ url: "https://example.com", evidenceDate }] })),
      { expiresAt: review.reviewedAt }, { expiresAt: review.reviewedAt + 14 * 86400 + 1 },
      { failureCategory: "" }, { adapterKey: "m0" }, { failureCategory: null, errorPrefix: null },
      { errorClass: "http-403" }, { errorClass: "http-200", failureCategory: "upstream-http", errorPrefix: null },
      { sourceTimestamp: now }, { warningCodes: ["same", "same"] },
    ]) expect(resolveReviews(now, [{ ...review, ...overrides } as Review]).invalidIds).toEqual([review.stablecoinId]);
    expect(resolveReviews(now, [{ ...review, expiresAt: review.reviewedAt + 14 * 86400 }]).invalidIds).toEqual([]);
    const duplicates = resolveReviews(now, [review, review]);
    expect(duplicates.activeById.size).toBe(0);
    expect(duplicates.invalidIds).toEqual([review.stablecoinId]);
    for (const offset of [-1, 0, 1]) {
      const result = resolveReviews(review.expiresAt + offset, [review]);
      expect(result.activeById.has(review.stablecoinId)).toBe(offset < 0);
      expect(result.expiredIds).toEqual(offset < 0 ? [] : [review.stablecoinId]);
    }
  });
  it("keeps Yuzu dated and its exact error/category boundary", async () => {
    expect([review.reviewedAt, review.expiresAt]).toEqual(["2026-11-07T19:46:52Z", "2026-11-14T19:46:52Z"].map((s) => Date.parse(s) / 1000));
    expect(review.sources).toEqual([{ url: "https://cache.accountable.capital/dashboard/yuzu", evidenceDate: "2026-11-07" }]);
    expect(review.failureCategory).toBe("unknown");
    expect(review.errorPrefix).toBe(accountable + "exposure_split has no contemporaneous timeline reserve total for reconciliation");
    for (const lastError of [
      "future-portfolio-timestamp", "stale or future portfolio timestamp",
      "exposure_split bucket total 1 does not match total_reserves 2",
      "exposure_split has no valid timeline reserve total for reconciliation",
      "exposure_split_ts is invalid: 2026.13.01 00:00:00 UTC", "HTTP 403",
    ]) await check(state(review, { lastError: accountable + lastError }), review, null);
    for (const failureCategory of ["upstream-http", "schema-shape", "corroboration-mismatch", "adapter-timeout", "run-budget-exhausted"]) {
      await check(state(review, { metadata: { failureCategory } }), review, null);
    }
    expect(RESERVE_FEED_REVIEWS.some((r) => r.stablecoinId === "gusd-gemini")).toBe(false);
  });
  it("pins HTTP classes to the primary endpoint", async () => {
    const r: Review = { ...review, stablecoinId: "fidd-fidelity", adapterKey: "fidd-independent-assurance",
      failureCategory: "upstream-http", warningCodes: [], errorPrefix: null, errorClass: "http-403" };
    const s = state(r);
    await check(s, r);
    for (const lastError of [http.replace("403", "429"), http + "; fallback:http-json: failed",
      http.replace("www.fidelitydigitalassets.com", "other.example"), http.replace("stablecoin", "other"),
      http.replace("primary", "fallback"), http.replace("http-html", "http-json"), "unrelated-cause"]) {
      await check({ ...s, lastError }, r, null);
    }
    await check({ ...s, metadata: { failureCategory: "unknown" } }, r, null);
    await check({ ...s, ...skipped }, r, r, history(r));
  });
  it("pins verified stalled clocks, including clean ok attempts", async () => {
    const r = { ...RESERVE_FEED_REVIEWS.find((r) => r.stablecoinId === "zsd-zephyr-protocol")!, warningCodes: [] };
    const s = state(r, { lastStatus: "ok" });
    await check(s, r);
    for (const metadata of [{ ...s.metadata, sourceTimestamp: r.sourceTimestamp! + 1 }, { ...s.metadata, freshnessMode: "unverified" as const }]) {
      await check({ ...s, metadata }, r, null);
    }
    const fresh = { ...r, sourceTimestamp: r.reviewedAt };
    await check(state(fresh, { lastStatus: "ok" }), fresh, null);
  });
  it("inherits only readable nonfatal latest circuit evidence", async () => {
    const s = state(review, skipped);
    await check(s, review, review, history());
    for (const overrides of [
      { warnings: "not-json" }, { warnings: "{}" }, { warnings: "[{}]" },
      { metadata: JSON.stringify({ failureCategory: "unknown", uncertainWrite: true }) },
      { metadata: "not-json" }, { last_error: "new cause" }, { adapter_key: "other" },
      { metadata: JSON.stringify({ failureCategory: "corroboration-mismatch" }) },
    ]) await check(s, review, null, history(review, overrides));
    await check(s, review, null);
    await check(s, review, null, history(review, {}, true));
    const r = { ...review, warningCodes: ["same"] };
    for (const effect of ["degraded", "fatal", "invalid"]) {
      const db = history(r, { warnings: JSON.stringify([{ code: "same", effect }]) });
      await check(s, r, effect === "degraded" ? r : null, db);
    }
  });
  it("retains raw counts and uncertainty beside adjusted health", () => {
    const r = makeReserveComposition({ configuredCoins: 10, freshCoins: 8, independentFreshEligible: 8,
      healthConfiguredCoins: 8, healthFreshCoins: 6, healthAuthoritativeFreshCoins: 6, lastSuccessAt: review.reviewedAt,
      acknowledgedFeedIds: ["a", "b"], persistentlyStaleIndependentCoins: [{ stablecoinId: "a", ageSec: 999999 }],
      unacknowledgedPersistentlyStaleIndependentCoins: [],
    });
    expect(evaluateReserveCompositionStatus(r)).toMatchObject({ status: "healthy", freshCoverageRatio: 0.75, authoritativeFreshCoverageRatio: 0.75 });
    expect(r.freshCoins).toBe(8);
    expect(evaluateReserveCompositionStatus({ ...r, healthFreshCoins: 0 }).status).toBe("stale");
    expect(evaluateReserveCompositionStatus({ ...r, healthConfiguredCoins: 0, healthFreshCoins: 0, healthAuthoritativeFreshCoins: 0 }).status).toBe("healthy");
    expect(evaluateReserveCompositionStatus({ ...r, writeTimeoutUncertain: 1 }).status).toBe("degraded");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { loadDepegResolverReviewSnapshot } from "../../../lib/depeg-resolver-review-snapshot-cache";
import { ensureIncident, insertOpenEvent, withSqliteD1 } from "../../../lib/__tests__/depeg-resolver-ddrv2-store.test-support";
import { persistDepegResolverReviewArtifacts } from "../persistence";
import { buildDiagnosticSnapshot } from "../public-projection";
import { emptyDdrLineage } from "../context";
import { DEFAULT_DDR_V2_STORE_CONTRACTS } from "../storage-adapters";
import { makeDdrResolverRow } from "../../__tests__/depeg-public-projection.test-support";
import { NOW_SEC } from "./depeg-resolver.test-support";

const fixtures = createLatestSchemaFixtureTracker();
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000); });
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});
function diagnostic() {
  return buildDiagnosticSnapshot({
    rows: [makeDdrResolverRow({ eventId: 42, ageSec: 3600, startedAt: NOW_SEC - 3600 })],
    lineage: emptyDdrLineage(NOW_SEC), nowSec: NOW_SEC,
  });
}

describe("persistDepegResolverReviewArtifacts", () => {
  it("returns the real nonzero review count for a durably registered incident", async () => {
    await withSqliteD1(async (db) => {
      insertOpenEvent(db);
      const incident = await ensureIncident(db, 1, NOW_SEC);
      const result = await persistDepegResolverReviewArtifacts(db, diagnostic(), DEFAULT_DDR_V2_STORE_CONTRACTS);
      expect(result).toEqual({ assessmentWriteCount: 3, reviewRows: 1, reviewError: null });
      const review = await loadDepegResolverReviewSnapshot(db);
      expect(review.kind).toBe("ok");
      if (review.kind !== "ok") throw new Error("Expected populated durable review");
      expect(review.payload._meta.reviewedEventCount).toBe(1);
      expect(review.payload.rows).toHaveLength(1);
      expect(review.payload.rows[0]).toMatchObject({
        kind: "coverage", incidentKey: incident.incidentKey, stablecoinId: "lusd-liquity",
      });
    });
  });

  it("stores real assessment checkpoints and an independently readable review snapshot", async () => {
    const { db, sqlite } = fixtures.open();
    const result = await persistDepegResolverReviewArtifacts(db, diagnostic(), DEFAULT_DDR_V2_STORE_CONTRACTS);
    expect(result).toEqual({ assessmentWriteCount: 3, reviewRows: 0, reviewError: null });
    expect(sqlite.prepare("SELECT checkpoint, assessed_at FROM depeg_resolver_assessments WHERE event_id = 42 ORDER BY checkpoint").all())
      .toEqual([
        { checkpoint: "age_1h", assessed_at: NOW_SEC },
        { checkpoint: "first", assessed_at: NOW_SEC },
        { checkpoint: "latest", assessed_at: NOW_SEC },
      ]);
    const review = await loadDepegResolverReviewSnapshot(db);
    expect(review.kind).toBe("ok");
    if (review.kind !== "ok") throw new Error("Expected persisted review snapshot");
    expect(review.payload.rows).toEqual([]);
    expect(review.payload._meta.computedAt).toBe(NOW_SEC);
  });

  it("reports partial success without rolling back already durable assessments when review loading fails", async () => {
    const { db, sqlite } = fixtures.open();
    const stores = {
      ...DEFAULT_DDR_V2_STORE_CONTRACTS,
      async loadCanonicalIncidents() { throw new Error("review store unavailable"); },
    };
    expect(await persistDepegResolverReviewArtifacts(db, diagnostic(), stores))
      .toEqual({ assessmentWriteCount: 3, reviewRows: 0, reviewError: "review store unavailable" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_resolver_assessments WHERE event_id = 42").get())
      .toEqual({ count: 3 });
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'depeg-resolver-review:snapshot'").get()).toBeUndefined();
  });

  it("does not count a computed review as durable when its cache publication fails", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`CREATE TRIGGER reject_review BEFORE INSERT ON cache
      WHEN NEW.key = 'depeg-resolver-review:snapshot'
      BEGIN SELECT RAISE(ABORT, 'review publication unavailable'); END;`);
    const result = await persistDepegResolverReviewArtifacts(db, diagnostic(), DEFAULT_DDR_V2_STORE_CONTRACTS);
    expect(result).toMatchObject({ assessmentWriteCount: 3, reviewRows: 0 });
    expect(result.reviewError).toContain("review publication unavailable");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_resolver_assessments").get()).toEqual({ count: 3 });
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'depeg-resolver-review:snapshot'").get()).toBeUndefined();
  });

  it("returns a zero assessment count and does not publish a review after an assessment transaction fails", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`CREATE TRIGGER reject_assessment BEFORE INSERT ON depeg_resolver_assessments
      BEGIN SELECT RAISE(ABORT, 'assessment write unavailable'); END;`);
    const result = await persistDepegResolverReviewArtifacts(db, diagnostic(), DEFAULT_DDR_V2_STORE_CONTRACTS);
    expect(result).toMatchObject({ assessmentWriteCount: 0, reviewRows: 0 });
    expect(result.reviewError).toContain("assessment write unavailable");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_resolver_assessments").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'depeg-resolver-review:snapshot'").get()).toBeUndefined();
  });

  it("rethrows cancellation instead of converting it to an ordinary partial-error result", async () => {
    const { db, sqlite } = fixtures.open();
    const controller = new AbortController();
    const failure = new Error("review cancelled");
    const stores = {
      ...DEFAULT_DDR_V2_STORE_CONTRACTS,
      async loadCanonicalIncidents() { controller.abort(failure); throw failure; },
    };
    await expect(persistDepegResolverReviewArtifacts(db, diagnostic(), stores, controller.signal)).rejects.toBe(failure);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_resolver_assessments").get()).toEqual({ count: 3 });
  });

  it("still publishes review evidence when diagnostic assessments are intentionally skipped", async () => {
    const { db, sqlite } = fixtures.open();
    const snapshot = diagnostic();
    snapshot._meta.degraded = true;
    expect(await persistDepegResolverReviewArtifacts(db, snapshot, DEFAULT_DDR_V2_STORE_CONTRACTS))
      .toEqual({ assessmentWriteCount: 0, reviewRows: 0, reviewError: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_resolver_assessments").get()).toEqual({ count: 0 });
    expect((await loadDepegResolverReviewSnapshot(db)).kind).toBe("ok");
  });
});

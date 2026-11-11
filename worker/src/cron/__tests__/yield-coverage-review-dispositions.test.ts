import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import {
  applyYieldCoverageReviewDispositions,
  buildYieldCoverageEvidenceFingerprint,
  type YieldCoverageReviewQueue,
  type YieldCoverageReviewableQueueItem,
} from "../yield-coverage-review-dispositions";

const openDatabases: DatabaseSync[] = [];

function createDispositionDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const migrationsDir = process.cwd().endsWith("/worker")
    ? resolve(process.cwd(), "src", "test-helpers", "migration-fixtures")
    : resolve(process.cwd(), "worker", "src", "test-helpers", "migration-fixtures");
  sqlite.exec(readFileSync(resolve(migrationsDir, "0193_yield_coverage_review_dispositions.sql"), "utf8"));
  openDatabases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function seedDisposition(
  sqlite: DatabaseSync,
  input: {
    item: YieldCoverageReviewableQueueItem;
    disposition?: string;
    reviewedAt?: number;
    nextReviewAt: number;
    expiresAt?: number;
  },
  nowSec: number,
): void {
  sqlite.prepare(`INSERT INTO yield_coverage_review_dispositions (
    queue_item_id, queue_item_kind, evidence_fingerprint, disposition,
    evidence, review_owner, reviewed_at, next_review_at, expires_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.item.id, input.item.kind, buildYieldCoverageEvidenceFingerprint(input.item),
    input.disposition ?? "watch", "historical evidence", "reviewer", input.reviewedAt ?? nowSec,
    input.nextReviewAt, input.expiresAt ?? 0, nowSec, nowSec,
  );
}

function item(
  id: string,
  overrides: Partial<YieldCoverageReviewableQueueItem> = {},
): YieldCoverageReviewableQueueItem {
  return {
    id,
    kind: "lending-allowlist",
    actionHint: "accept",
    project: id,
    tvlUsd: 12_000_000,
    apy: 4,
    protocolCategory: "Lending",
    ...overrides,
  };
}

function queue(
  headlineGaps: YieldCoverageReviewableQueueItem[],
  recommendationCandidates: YieldCoverageReviewableQueueItem[] = [],
): YieldCoverageReviewQueue<YieldCoverageReviewableQueueItem> {
  return {
    persistence: "deferred",
    promotionMode: "human-reviewed",
    allowedActions: ["accept", "dismiss", "intentional-gap", "watch"],
    headlineGaps,
    recommendationCandidates,
    suppressedItemCount: 0,
  };
}

afterEach(() => {
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

describe("yield coverage review dispositions", () => {
  it("suppresses unchanged evidence only until review or expiry becomes due", async () => {
    const { sqlite, db } = createDispositionDb();
    const candidate = item("reviewed");
    seedDisposition(sqlite, {
      item: candidate,
      disposition: "watch",
      reviewedAt: 1_000,
      nextReviewAt: 2_000,
      expiresAt: 3_000,
    }, 1_000);

    const current = await applyYieldCoverageReviewDispositions(db, queue([candidate]), { nowSec: 1_500 });
    expect(current.queue).toMatchObject({
      persistence: "durable",
      promotionMode: "human-reviewed",
      suppressedItemCount: 1,
      headlineGaps: [],
    });
    expect(current.summary).toMatchObject({ suppressedItemCount: 1, visibleItemCount: 0 });

    const changed = { ...candidate, pool: "new-pool" };
    const evidenceChanged = await applyYieldCoverageReviewDispositions(db, queue([changed]), { nowSec: 1_500 });
    expect(evidenceChanged.queue.headlineGaps).toEqual([changed]);
    expect(evidenceChanged.summary.evidenceChangedCount).toBe(1);

    const reviewDue = await applyYieldCoverageReviewDispositions(db, queue([candidate]), { nowSec: 2_000 });
    expect(reviewDue.queue.headlineGaps).toEqual([candidate]);
    expect(reviewDue.summary.reviewDueCount).toBe(1);

    const expiringCandidate = item("expiring");
    seedDisposition(sqlite, {
      item: expiringCandidate,
      reviewedAt: 1_000,
      nextReviewAt: 4_000,
      expiresAt: 2_500,
    }, 1_000);
    const expired = await applyYieldCoverageReviewDispositions(db, queue([expiringCandidate]), { nowSec: 2_500 });
    expect(expired.queue.headlineGaps).toEqual([expiringCandidate]);
    expect(expired.summary.expiredCount).toBe(1);
  });

  it("suppresses before truncation so later unreviewed candidates backfill the published queue", async () => {
    const { sqlite, db } = createDispositionDb();
    const candidates = Array.from({ length: 25 }, (_, index) => item(`candidate-${index}`));
    for (const candidate of candidates.slice(0, 3)) {
      seedDisposition(sqlite, {
        item: candidate,
        disposition: "accept",
        nextReviewAt: 5_000,
        expiresAt: 5_000,
      }, 1_000);
    }

    const result = await applyYieldCoverageReviewDispositions(db, queue(candidates), {
      nowSec: 2_000,
      publishedItemLimit: 20,
    });

    expect(result.queue.headlineGaps).toHaveLength(20);
    expect(result.queue.headlineGaps[0]?.id).toBe("candidate-3");
    expect(result.summary).toMatchObject({
      candidateItemCount: 25,
      suppressedItemCount: 3,
      visibleItemCount: 22,
      visibleHeadlineGapCount: 22,
      visibleRecommendationCandidateCount: 0,
      publishedItemCount: 20,
      truncatedItemCount: 2,
      visibleByKind: { "lending-allowlist": 22 },
    });
  });

  it("rejects invalid reader epochs and limits without changing durable evidence", async () => {
    const { sqlite, db } = createDispositionDb();
    const candidate = item("validated");
    seedDisposition(sqlite, { item: candidate, nextReviewAt: 5_000 }, 1_000);
    const before = sqlite.prepare("SELECT * FROM yield_coverage_review_dispositions").all();
    for (const invalid of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(applyYieldCoverageReviewDispositions(db, queue([candidate]), { nowSec: invalid })).rejects.toBeInstanceOf(RangeError);
      await expect(applyYieldCoverageReviewDispositions(db, queue([candidate]), { nowSec: 1_000, publishedItemLimit: invalid })).rejects.toBeInstanceOf(RangeError);
    }
    await expect(applyYieldCoverageReviewDispositions(db, queue([candidate]), { nowSec: 1_000, publishedItemLimit: 0 })).rejects.toBeInstanceOf(RangeError);
    expect(sqlite.prepare("SELECT * FROM yield_coverage_review_dispositions").all()).toEqual(before);
  });
});

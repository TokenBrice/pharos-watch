import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  applyYieldCoverageReviewDispositions,
  buildYieldCoverageEvidenceFingerprint,
  upsertYieldCoverageReviewDisposition,
  type YieldCoverageReviewQueue,
  type YieldCoverageReviewableQueueItem,
} from "../yield-coverage-review-dispositions";

const openDatabases: DatabaseSync[] = [];

function createDispositionDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const migrationsDir = process.cwd().endsWith("/worker")
    ? resolve(process.cwd(), "migrations")
    : resolve(process.cwd(), "worker", "migrations");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration fixture only.
  sqlite.exec(readFileSync(resolve(migrationsDir, "0193_yield_coverage_review_dispositions.sql"), "utf8"));
  openDatabases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
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
  it("persists the disposition, evidence, owner, fingerprint, and review bounds", async () => {
    const { sqlite, db } = createDispositionDb();
    const candidate = item("new-lender");

    const stored = await upsertYieldCoverageReviewDisposition(db, {
      item: candidate,
      disposition: "dismiss",
      evidence: "Pool belongs to a different wrapped asset.",
      reviewOwner: "yield-review@example.com",
      reviewedAt: 1_000,
      nextReviewAt: 2_000,
      expiresAt: 3_000,
    }, 1_100);

    expect(stored).toMatchObject({
      queueItemId: "new-lender",
      disposition: "dismiss",
      evidence: "Pool belongs to a different wrapped asset.",
      reviewOwner: "yield-review@example.com",
      reviewedAt: 1_000,
      nextReviewAt: 2_000,
      expiresAt: 3_000,
    });
    expect(sqlite.prepare(
      `SELECT disposition, evidence, review_owner, reviewed_at, next_review_at,
              expires_at, evidence_fingerprint, created_at, updated_at
         FROM yield_coverage_review_dispositions
        WHERE queue_item_id = ?`,
    ).get("new-lender")).toEqual({
      disposition: "dismiss",
      evidence: "Pool belongs to a different wrapped asset.",
      review_owner: "yield-review@example.com",
      reviewed_at: 1_000,
      next_review_at: 2_000,
      expires_at: 3_000,
      evidence_fingerprint: buildYieldCoverageEvidenceFingerprint(candidate),
      created_at: 1_100,
      updated_at: 1_100,
    });

    const defaultWindow = await upsertYieldCoverageReviewDisposition(db, {
      item: item("monthly-default"),
      reviewedAt: 10_000,
    }, 10_000);
    expect(defaultWindow).toMatchObject({
      nextReviewAt: 10_000 + 31 * 24 * 60 * 60,
      expiresAt: 0,
    });
  });

  it("suppresses unchanged evidence only until review or expiry becomes due", async () => {
    const { db } = createDispositionDb();
    const candidate = item("reviewed");
    await upsertYieldCoverageReviewDisposition(db, {
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

    const reviewDue = await applyYieldCoverageReviewDispositions(db, queue([candidate]), { nowSec: 2_000 });
    expect(reviewDue.queue.headlineGaps).toEqual([candidate]);
    expect(reviewDue.summary.reviewDueCount).toBe(1);

    const expiringCandidate = item("expiring");
    await upsertYieldCoverageReviewDisposition(db, {
      item: expiringCandidate,
      reviewedAt: 1_000,
      nextReviewAt: 4_000,
      expiresAt: 2_500,
    }, 1_000);
    const expired = await applyYieldCoverageReviewDispositions(db, queue([expiringCandidate]), { nowSec: 2_500 });
    expect(expired.queue.headlineGaps).toEqual([expiringCandidate]);
    expect(expired.summary.expiredCount).toBe(1);
  });

  it("ignores routine market noise but reopens decision-relevant evidence changes", async () => {
    const { db } = createDispositionDb();
    const reviewed = item("banded", { tvlUsd: 12_000_000, apy: 4 });
    await upsertYieldCoverageReviewDisposition(db, {
      item: reviewed,
      nextReviewAt: 5_000,
      expiresAt: 5_000,
    }, 1_000);

    const sameBands = item("banded", { tvlUsd: 15_000_000, apy: 4.9 });
    expect(buildYieldCoverageEvidenceFingerprint(sameBands)).toBe(
      buildYieldCoverageEvidenceFingerprint(reviewed),
    );
    expect((await applyYieldCoverageReviewDispositions(db, queue([sameBands]), { nowSec: 2_000 }))
      .queue.headlineGaps).toEqual([]);

    const changed = item("banded", { tvlUsd: 15_000_000, apy: 5.1 });
    const reopened = await applyYieldCoverageReviewDispositions(db, queue([changed]), { nowSec: 2_000 });
    expect(reopened.queue.headlineGaps).toEqual([changed]);
    expect(reopened.summary.evidenceChangedCount).toBe(1);
  });

  it("suppresses before truncation so later unreviewed candidates backfill the published queue", async () => {
    const { db } = createDispositionDb();
    const candidates = Array.from({ length: 25 }, (_, index) => item(`candidate-${index}`));
    for (const candidate of candidates.slice(0, 3)) {
      await upsertYieldCoverageReviewDisposition(db, {
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
      publishedItemCount: 20,
      truncatedItemCount: 2,
    });
  });
});

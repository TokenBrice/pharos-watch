import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CanonicalKeySchema } from "@shared/types/safety-schema-primitives";
import {
  INCIDENT_REVIEW_KEY_MIGRATION_PATH,
  INCIDENT_REVIEW_ORPHAN_ADJUDICATIONS,
  INCIDENT_REVIEWS_PATH,
  REVIEW_KEY_MIGRATION_RETIRED_AT,
  assertMigrationPreservesLegacyKeys,
  buildIncidentReviewKeyMigration,
} from "../generate-safety-score-v9-incident-review-key-migration";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));

type RawReview = {
  reviewId: string;
  scope: Record<string, unknown>;
  retired?: { reviewedAt: string; reviewer: string; reason: string };
};

describe("incident review key migration", () => {
  it("reproduces the committed mapping golden from the applied registry and metadata", () => {
    const generated = buildIncidentReviewKeyMigration(ROOT);
    expect(generated).toEqual(readJson(INCIDENT_REVIEW_KEY_MIGRATION_PATH));
    expect(generated.counts).toMatchObject({
      lane: 242,
      control: 91,
      "lane-aggregate": 222,
      "mint-control": 59,
      deployment: 12,
      retired: 23,
      mapped: 626,
      orphans: 23,
      collisions: 11,
      authoredApplied: 614,
      legacyBlocked: 0,
      digestKeysRemaining: 23,
      total: 649,
    });
  });

  it("keeps every applied authored identity outcome-equivalent to its digest key", () => {
    const generated = buildIncidentReviewKeyMigration(ROOT);
    expect(() => assertMigrationPreservesLegacyKeys(ROOT, generated)).not.toThrow();
    expect(generated.rows.filter((row) => row.applied === "authored")).toHaveLength(614);
    expect(generated.rows
      .filter((row) => row.applied === "authored")
      .every((row) => row.authored !== null && typeof row.legacyControlKey === "string")).toBe(true);
  });

  it("retires exactly the adjudicated orphan digests instead of reattaching collisions", () => {
    const generated = buildIncidentReviewKeyMigration(ROOT);
    const retired = generated.rows.filter((row) => row.resolution === "retired");
    expect(new Set(retired.map((row) => row.legacyControlKey))).toEqual(
      new Set(Object.keys(INCIDENT_REVIEW_ORPHAN_ADJUDICATIONS)),
    );
    expect(retired.filter((row) => row.collidesWithCurrentCandidate)).toHaveLength(11);
    expect(retired.every((row) => row.authored === null && row.reason.length > 0 && row.applied === "retired")).toBe(true);
  });

  it("applies authored scopes to 614 rows and retires 23 with provenance, keeping 23 legacy keys", () => {
    const reviews = readJson(INCIDENT_REVIEWS_PATH) as { negativeReviews: RawReview[] };
    const authored = reviews.negativeReviews.filter((review) =>
      review.scope.kind === "control" && review.scope.controlKey === undefined);
    const retired = reviews.negativeReviews.filter((review) => review.retired !== undefined);
    const legacyDigests = reviews.negativeReviews.filter((review) =>
      typeof review.scope.controlKey === "string");
    expect(authored).toHaveLength(614);
    expect(authored.every((review) => typeof review.scope.routeId === "string" || review.scope.controlId !== undefined)).toBe(true);
    expect(retired).toHaveLength(23);
    expect(retired.every((review) =>
      review.retired?.reviewedAt === REVIEW_KEY_MIGRATION_RETIRED_AT && review.retired.reason.length > 0)).toBe(true);
    // Only the 23 retired rows keep the digest scope they were adjudicated under.
    expect(legacyDigests).toHaveLength(23);
    const deploymentScopedMint = authored.find((review) =>
      review.scope.controlId === "USDSM Etherlink proxy owner");
    expect(deploymentScopedMint?.scope.routeId).toBe("etherlink:0x6bde51212203ae5d592cc5180da2abbd41c922de");
  });

  it("emits only canonical colon-separated stable review ids", () => {
    const generated = buildIncidentReviewKeyMigration(ROOT);
    const ids = generated.rows.map((row) => row.stableReviewId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).not.toContain("|");
      expect(CanonicalKeySchema.safeParse(id).success).toBe(true);
    }
    expect(ids.find((id) => id.startsWith("bridge:"))).toMatch(/^bridge:[a-z0-9._:-]+:[a-z0-9._:-]+:[a-z0-9._:-]+:\d+$/u);
  });

  it("fails closed when an unadjudicated legacy digest cannot be recomputed", () => {
    const reviews = readJson(INCIDENT_REVIEWS_PATH) as { negativeReviews: RawReview[] };
    const target = reviews.negativeReviews.find((review) => review.retired === undefined);
    if (target === undefined) throw new Error("fixture review missing");
    target.scope = { kind: "control", controlKey: `bridge-meta:unreviewed-asset:${"0".repeat(20)}` };
    expect(() => buildIncidentReviewKeyMigration(ROOT, reviews)).toThrow(/no authored candidate/u);
  });
});

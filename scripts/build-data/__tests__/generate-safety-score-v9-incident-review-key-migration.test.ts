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
    // The golden above pins the mapping; these invariants keep it honest while
    // provider/issuer fragments merge into the registry.
    const registry = readJson(INCIDENT_REVIEWS_PATH) as { negativeReviews: readonly RawReview[] };
    const subjects = registry.negativeReviews.filter((review) =>
      review.scope.kind !== "issuer-surface" && review.scope.kind !== "provider");
    expect(generated.counts.total).toBe(subjects.length);
    expect(generated.counts.skipped).toBe(registry.negativeReviews.length - subjects.length);
    expect(generated.counts.total + generated.counts.skipped).toBe(registry.negativeReviews.length);
    expect(generated.counts.orphans).toBe(23);
    expect(generated.counts.authoredRetired).toBe(1);
    expect(generated.counts.orphans + generated.counts.authoredRetired).toBe(generated.counts.retired);
    expect(generated.counts.mapped + generated.counts.retired).toBe(generated.counts.total);
  });

  it("keeps every applied authored identity outcome-equivalent to its digest key", () => {
    const generated = buildIncidentReviewKeyMigration(ROOT);
    expect(() => assertMigrationPreservesLegacyKeys(ROOT, generated)).not.toThrow();
    expect(generated.counts.authoredApplied).toBeGreaterThan(0);
    expect(generated.rows.filter((row) => row.applied === "authored")).toHaveLength(generated.counts.authoredApplied);
    expect(generated.rows
      .filter((row) => row.applied === "authored")
      .every((row) => row.authored !== null && typeof row.legacyControlKey === "string")).toBe(true);
  });

  it("retires exactly the adjudicated orphan digests instead of reattaching collisions", () => {
    const generated = buildIncidentReviewKeyMigration(ROOT);
    const retired = generated.rows.filter((row) => row.resolution === "retired");
    const adjudicated = retired.filter((row) => row.legacyControlKey !== null);
    expect(new Set(adjudicated.map((row) => row.legacyControlKey))).toEqual(
      new Set(Object.keys(INCIDENT_REVIEW_ORPHAN_ADJUDICATIONS)),
    );
    expect(adjudicated).toHaveLength(23);
    expect(retired).toHaveLength(24);
    expect(retired.filter((row) => row.collidesWithCurrentCandidate)).toHaveLength(11);
    expect(retired.every((row) => row.authored === null && row.reason.length > 0 && row.applied === "retired")).toBe(true);
    expect(retired.find((row) => row.reviewId === "i203-cngn-compliant-naira-3ed94b7a7d58976299ac-20261011"))
      .toMatchObject({ legacyControlKey: null, digestMatch: false, reason: expect.stringContaining("Lisk") });
  });

  it("applies every authored scope and retires the adjudicated orphans with provenance", () => {
    const reviews = readJson(INCIDENT_REVIEWS_PATH) as { negativeReviews: RawReview[] };
    const generated = buildIncidentReviewKeyMigration(ROOT);
    const authored = reviews.negativeReviews.filter((review) =>
      review.scope.kind === "control" && review.scope.controlKey === undefined && review.retired === undefined);
    const retired = reviews.negativeReviews.filter((review) => review.retired !== undefined);
    const adjudicatedRetirements = retired.filter((review) => typeof review.scope.controlKey === "string");
    const authoredRetirements = retired.filter((review) => typeof review.scope.controlKey !== "string");
    const legacyDigests = reviews.negativeReviews.filter((review) =>
      typeof review.scope.controlKey === "string");
    expect(authored).toHaveLength(639);
    expect(authored).toHaveLength(generated.counts.authoredApplied + generated.counts.legacyBlocked);
    expect(authored.every((review) => typeof review.scope.routeId === "string" || review.scope.controlId !== undefined)).toBe(true);
    expect(retired).toHaveLength(generated.counts.retired);
    expect(adjudicatedRetirements).toHaveLength(generated.counts.orphans);
    expect(adjudicatedRetirements.every((review) =>
      review.retired?.reviewedAt === REVIEW_KEY_MIGRATION_RETIRED_AT && review.retired.reason.length > 0)).toBe(true);
    expect(authoredRetirements).toEqual([
      expect.objectContaining({ reviewId: "i203-cngn-compliant-naira-3ed94b7a7d58976299ac-20261011" }),
    ]);
    // Only the adjudicated orphan rows keep the digest scope they were retired under.
    expect(legacyDigests).toHaveLength(adjudicatedRetirements.length);
    const deploymentScopedMint = authored.find((review) =>
      review.scope.controlId === "USDSM Etherlink proxy owner");
    expect(deploymentScopedMint?.scope.routeId).toBe("etherlink:0x6bde51212203ae5d592cc5180da2abbd41c922de");
  });

  it("skips issuer-surface and provider reviews, which are not key-migration subjects", () => {
    const registry = readJson(INCIDENT_REVIEWS_PATH) as {
      negativeReviews: readonly RawReview[];
    } & Record<string, unknown>;
    const reviews = {
      ...registry,
      negativeReviews: [
        ...registry.negativeReviews,
        {
          reviewId: "fixture-provider",
          scope: {
            kind: "provider", providerKey: "layerzero", surface: "dvn-set",
            coveredRoutes: [{ assetId: "usdc-circle", routeId: "ethereum:0x2222222222222222222222222222222222222222" }],
          },
          reviewedAt: "2026-10-30",
          windowStartSec: 1,
          windowEndSec: 2,
        },
        {
          reviewId: "fixture-issuer",
          assetId: "usdc-circle",
          scope: { kind: "issuer-surface", coveredRoutes: ["ethereum:0x2222222222222222222222222222222222222222"] },
          reviewedAt: "2026-10-30",
          windowStartSec: 1,
          windowEndSec: 2,
        },
      ],
    };
    const generated = buildIncidentReviewKeyMigration(ROOT, reviews);
    const nonSubjects = registry.negativeReviews.filter((review) =>
      review.scope.kind === "issuer-surface" || review.scope.kind === "provider").length;
    expect(generated.counts.skipped).toBe(nonSubjects + 2);
    expect(generated.counts.total).toBe(registry.negativeReviews.length - nonSubjects);
    expect(generated.counts.total + generated.counts.skipped).toBe(reviews.negativeReviews.length);
    // No migration row claims a certificate/lane witness: a provider row has no
    // assetId, so a row for it would fail the checker's artifact schema.
    expect(generated.rows.some((row) => row.reviewId === "fixture-provider" || row.reviewId === "fixture-issuer")).toBe(false);
    expect(generated.rows.every((row) => typeof row.assetId === "string")).toBe(true);
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

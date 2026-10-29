import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CanonicalKeySchema } from "@shared/types/safety-schema-primitives";
import {
  INCIDENT_REVIEW_KEY_MIGRATION_PATH,
  INCIDENT_REVIEW_ORPHAN_ADJUDICATIONS,
  assertMigrationPreservesLegacyKeys,
  buildIncidentReviewKeyMigration,
} from "../generate-safety-score-v9-incident-review-key-migration";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REVIEWS_PATH = "shared/data/safety-score-v9/incident-reviews-v1.json";

const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));

describe("incident review key migration", () => {
  it("reproduces the committed mapping golden from the authored registry and metadata", () => {
    const generated = buildIncidentReviewKeyMigration(ROOT);
    expect(generated).toEqual(readJson(INCIDENT_REVIEW_KEY_MIGRATION_PATH));
    expect(generated.counts).toMatchObject({
      "lane-aggregate": 313,
      lane: 242,
      "mint-control": 59,
      deployment: 12,
      retired: 23,
      orphans: 23,
      collisions: 11,
      total: 649,
    });
  });

  it("keeps every migrated identity outcome-equivalent to its legacy digest key", () => {
    const generated = buildIncidentReviewKeyMigration(ROOT);
    expect(() => assertMigrationPreservesLegacyKeys(ROOT, generated)).not.toThrow();
    const authoredKeys = generated.rows
      .filter((row) => row.resolution !== "retired" && row.resolution !== "deployment")
      .map((row) => row.legacyControlKey);
    expect(authoredKeys.every((key) => typeof key === "string" && !key.endsWith(":"))).toBe(true);
  });

  it("retires exactly the adjudicated orphan digests instead of reattaching collisions", () => {
    const generated = buildIncidentReviewKeyMigration(ROOT);
    const retired = generated.rows.filter((row) => row.resolution === "retired");
    expect(new Set(retired.map((row) => row.legacyControlKey))).toEqual(
      new Set(Object.keys(INCIDENT_REVIEW_ORPHAN_ADJUDICATIONS)),
    );
    expect(retired.filter((row) => row.collidesWithCurrentCandidate)).toHaveLength(11);
    expect(retired.every((row) => row.authored === null && row.reason.length > 0)).toBe(true);
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

  it("fails closed when an unadjudicated digest cannot be recomputed", () => {
    const reviews = readJson(REVIEWS_PATH) as {
      negativeReviews: { scope: { kind: string; controlKey?: string } }[];
    };
    const target = reviews.negativeReviews.find((review) => review.scope.kind === "control");
    if (target?.scope.controlKey === undefined) throw new Error("fixture review missing control key");
    target.scope.controlKey = `bridge-meta:unreviewed-asset:${"0".repeat(20)}`;
    expect(() => buildIncidentReviewKeyMigration(ROOT, reviews)).toThrow(/no authored candidate/u);
  });
});

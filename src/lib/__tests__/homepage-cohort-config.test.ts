import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOIN_ID_SET } from "@/lib/stablecoin-static-data";
import { HOMEPAGE_COHORT_BUCKET_IDS } from "@/lib/homepage-cohort-config";

describe("HOMEPAGE_COHORT_BUCKET_IDS", () => {
  it("references only active stablecoin ids", () => {
    for (const ids of Object.values(HOMEPAGE_COHORT_BUCKET_IDS)) {
      for (const id of ids) {
        expect(ACTIVE_STABLECOIN_ID_SET.has(id)).toBe(true);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { PSI_ELIGIBLE_IDS, PSI_ELIGIBLE_META_BY_ID, PSI_ELIGIBLE_STABLECOINS } from "../psi-eligible";
import { FROZEN_IDS } from "../stablecoins";

describe("PSI eligibility", () => {
  it("excludes frozen coins from PSI_ELIGIBLE_IDS", () => {
    for (const id of FROZEN_IDS) {
      expect(PSI_ELIGIBLE_IDS.has(id)).toBe(false);
    }
  });

  it("excludes frozen coins from PSI_ELIGIBLE_META_BY_ID", () => {
    for (const id of FROZEN_IDS) {
      expect(PSI_ELIGIBLE_META_BY_ID.has(id)).toBe(false);
    }
  });

  it("excludes frozen coins from PSI_ELIGIBLE_STABLECOINS", () => {
    const ids = new Set(PSI_ELIGIBLE_STABLECOINS.map((s) => s.id));
    for (const id of FROZEN_IDS) {
      expect(ids.has(id)).toBe(false);
    }
  });
});

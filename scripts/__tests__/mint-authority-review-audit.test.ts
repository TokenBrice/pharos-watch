import { describe, expect, it } from "vitest";

import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";

describe("mint-authority-review-audit", () => {
  it("does not leave an explicit upgrade authority without a profile-level record", () => {
    const missing = TRACKED_STABLECOINS.filter(
      (meta) =>
        meta.mintAuthority?.upgradeability == null &&
        meta.mintAuthority?.controls?.some((control) => control.directMintAbility === "upgrade-only"),
    ).map((meta) => meta.id);

    expect(missing).toEqual([]);
  });
});

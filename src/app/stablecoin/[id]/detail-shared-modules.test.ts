// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

import { buildDetailSharedModules } from "./detail-shared-modules";
import { makeReadyViewModel } from "./client-test-support";

function sharedModulesFor(coinId: string) {
  return buildDetailSharedModules({
    mechanismBacking: null,
    backingParent: null,
    mechanismCollateralization: null,
    mechanismReview: null,
    viewModel: makeReadyViewModel({ coin: TRACKED_META_BY_ID.get(coinId)! }) as never,
  });
}

describe("detail shared modules regulatory slot", () => {
  it("omits the slot for a reviewed out-of-scope GENIUS profile instead of claiming not reviewed", () => {
    const modules = sharedModulesFor("kau-kinesis");
    expect(modules.regulatoryStanding).toBeNull();
    expect(modules.regulatoryNotReviewed).toBe(false);
  });

  it("keeps the not-reviewed placeholder when the coin has no curated regime profile", () => {
    const modules = sharedModulesFor("usda-avalon");
    expect(modules.regulatoryStanding).toBeNull();
    expect(modules.regulatoryNotReviewed).toBe(true);
  });
});

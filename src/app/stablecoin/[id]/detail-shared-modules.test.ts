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

function sharedModulesWith(overrides: Record<string, unknown>) {
  return buildDetailSharedModules({
    mechanismBacking: null,
    backingParent: null,
    mechanismCollateralization: null,
    mechanismReview: null,
    viewModel: makeReadyViewModel(overrides) as never,
  });
}

function indexRow(modules: ReturnType<typeof buildDetailSharedModules>, key: string) {
  return modules.evidenceIndex.flatMap((group) => group.rows).find((row) => row.key === key);
}

describe("detail shared modules not-applicable slots", () => {
  it("mounts no DEWS for a NAV token or a frozen archive", () => {
    expect(sharedModulesWith({}).showDews).toBe(true);
    expect(sharedModulesWith({ isNavToken: true }).showDews).toBe(false);
    const frozen = { ...TRACKED_META_BY_ID.get("usds-sky")!, status: "frozen" };
    expect(sharedModulesWith({ coin: frozen }).showDews).toBe(false);
  });

  it("indexes no Price feed row for a reviewed no-liquidation-oracle coin", () => {
    const oracle = { notApplicable: true, title: "Price feed", tierLabel: "No liquidation oracle · not scored", tierToneClass: "" };
    const coin = { ...TRACKED_META_BY_ID.get("usds-sky")!, oracleRiskSummary: oracle };
    expect(indexRow(sharedModulesWith({ coin }), "oracle")).toBeUndefined();
  });
});

describe("detail shared modules evidence index", () => {
  it("states a scored route as one chip, with how Exit treats it, never a bare figure", () => {
    const modules = sharedModulesWith({ redemptionBackstop: { stablecoinId: "usds-sky", score: 79, routeFamily: "offchain-issuer" } });
    const row = indexRow(modules, "redemption")!;
    expect(row.chip?.label.startsWith("79")).toBe(true);
    expect(row.chip?.toneClass).not.toBe("");
    expect(Object.keys(row)).toEqual(["key", "title", "anchorId", "chip", "limiting"]);
  });
});

describe("detail shared modules regulatory slot", () => {
  it("omits the slot for a reviewed out-of-scope GENIUS profile instead of claiming not reviewed", () => {
    const modules = sharedModulesFor("kau-kinesis");
    expect(modules.regulatoryStanding).toBeNull();
    expect(modules.regulatoryNotReviewed).toBe(false);
  });

  it("keeps the not-reviewed placeholder when the coin has no curated regime profile", () => {
    const modules = sharedModulesFor("xusd-babelfish");
    expect(modules.regulatoryStanding).toBeNull();
    expect(modules.regulatoryNotReviewed).toBe(true);
  });

  it("suppresses the not-reviewed placeholder for a frozen archive profile", () => {
    const modules = sharedModulesFor("usda-avalon");
    expect(modules.regulatoryStanding).toBeNull();
    expect(modules.regulatoryNotReviewed).toBe(false);
  });
});

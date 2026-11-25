import { describe, expect, it } from "vitest";
import { HEADLINE_STABLECOIN_COUNT, HEADLINE_STABLECOIN_LABEL, UNIVERSES } from "@/lib/universe-vocabulary";
import { ACTIVE_TOKENIZED_FUND_IDS, CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-registry";
import { CLIENT_ACTIVE_ALL_STABLECOIN_IDS, CLIENT_ACTIVE_TOKENIZED_FUND_IDS } from "@shared/lib/stablecoins/aggregate-client-registry";
import { CORE_PSI_ELIGIBLE_IDS } from "@shared/lib/psi-eligible";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";

describe("UNIVERSES", () => {
  it("counts the sets the code actually computes over", () => {
    expect(UNIVERSES.psi.count).toBe(CORE_PSI_ELIGIBLE_IDS.size);
    expect(UNIVERSES.core.count).toBe(CORE_AGGREGATE_ACTIVE_IDS.size);
    expect(UNIVERSES.tokenizedFunds.count).toBe(ACTIVE_TOKENIZED_FUND_IDS.size);
    expect(UNIVERSES.tokenizedFunds.count).toBe(CLIENT_ACTIVE_TOKENIZED_FUND_IDS.size);
    expect(UNIVERSES.active.count).toBe(ACTIVE_IDS.size - ACTIVE_TOKENIZED_FUND_IDS.size);
    expect(UNIVERSES.active.count).toBe(CLIENT_ACTIVE_ALL_STABLECOIN_IDS.size);
  });
});

describe("headline stablecoin count", () => {
  it("is the active stablecoin universe (excluding tokenized funds) under one label", () => {
    expect(HEADLINE_STABLECOIN_COUNT).toBe(ACTIVE_IDS.size - ACTIVE_TOKENIZED_FUND_IDS.size);
    expect(HEADLINE_STABLECOIN_LABEL).toBe("active stablecoins");
  });
});

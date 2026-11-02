import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/stablecoins/client-registry", () => {
  const coin = (id: string, pegCurrency: string) => ({
    id,
    flags: { pegCurrency, governance: "decentralized", backing: "crypto-backed" },
    infrastructures: [],
    variantOf: null,
    variantKind: null,
  });
  const stablecoins = [coin("other-coin", "OTHER"), coin("gbp-coin", "GBP")];
  return {
    CLIENT_ACTIVE_STABLECOINS: stablecoins,
    CLIENT_ACTIVE_IDS: new Set(stablecoins.map((stablecoin) => stablecoin.id)),
    CLIENT_TRACKED_META_BY_ID: new Map(stablecoins.map((stablecoin) => [stablecoin.id, stablecoin])),
  };
});

import { buildTrackedIdSet } from "@/components/stablecoin-table-logic";

describe("other-peg table filter", () => {
  it("matches only the OTHER peg cohort, not every non-USD/EUR/GOLD peg", () => {
    expect(buildTrackedIdSet(["other-peg"])).toEqual(new Set(["other-coin"]));
  });
});

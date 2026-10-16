import { describe, expect, it } from "vitest";
import { buildYieldDecisionLedgerDisplay, formatYieldDecisionReasonLine } from "@/lib/yield-decision-ledger";
import type { YieldPublicDecisionLedger } from "@shared/types";

const ledger: YieldPublicDecisionLedger = {
  selectedReasonCode: "curated-over-discovered",
  previousBestSourceKey: "defillama-auto:legacy",
  sourceSwitch: true,
  apy30dDeltaFromPrevious: 1.8,
  rejectedCount: 1,
  alternatives: [
    {
      sourceKey: "defillama-auto:compound-v3:usdc",
      yieldSource: "Compound V3 USDC",
      apy30dDelta: -0.51,
      rejectionReasonCode: "lower-confidence",
    },
  ],
};

describe("buildYieldDecisionLedgerDisplay", () => {
  it.each([[1, "+1.00 pp"], [-1, "-1.00 pp"], [-0.001, "+0.00 pp"]] as const)(
    "formats absolute APY delta %s in normalized percentage points",
    (delta, label) => {
      expect(buildYieldDecisionLedgerDisplay({ ...ledger, apy30dDeltaFromPrevious: delta })?.sourceSwitchLabel)
        .toBe(`Source changed (${label} APY30d)`);
    },
  );

  it("returns null for missing ledgers instead of inventing copy", () => {
    expect(buildYieldDecisionLedgerDisplay(null)).toBeNull();
    expect(formatYieldDecisionReasonLine(undefined)).toBeNull();
  });
});


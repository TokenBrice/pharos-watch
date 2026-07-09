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
  it("maps coded source-decision evidence to display labels", () => {
    const display = buildYieldDecisionLedgerDisplay(ledger);

    expect(display).toMatchObject({
      reasonLabel: "Curated source preferred",
      sourceSwitchLabel: "Source changed (+1.80% APY30d)",
      rejectedCountLabel: "1 alternate rejected",
      previousSourceKey: "defillama-auto:legacy",
    });
    expect(display?.alternatives).toEqual([
      {
        sourceKey: "defillama-auto:compound-v3:usdc",
        yieldSource: "Compound V3 USDC",
        rejectionLabel: "lower confidence",
        apy30dDeltaLabel: "-0.51% APY30d",
      },
    ]);
  });

  it("returns null for missing ledgers instead of inventing copy", () => {
    expect(buildYieldDecisionLedgerDisplay(null)).toBeNull();
    expect(formatYieldDecisionReasonLine(undefined)).toBeNull();
  });
});

describe("formatYieldDecisionReasonLine", () => {
  it("returns a compact one-line reason", () => {
    expect(formatYieldDecisionReasonLine(ledger)).toBe(
      "Curated source preferred | Source changed (+1.80% APY30d) | 1 alternate rejected",
    );
  });
});

// src/lib/__tests__/stablecoin-detail-custody-client.test.ts
import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import { projectCustodyClientSummary, shouldDisplayCustodyModule } from "../stablecoin-detail-custody-client";

function coinWith(custodyProfile: unknown): StablecoinMeta {
  return { id: "test-coin", custodyProfile } as unknown as StablecoinMeta;
}

const USDC_LIKE_PROFILE = {
  providers: [
    { name: "The Bank of New York Mellon", role: "custodian", sharePct: 88, jurisdiction: "United States" },
    { name: "Systemically important and other regulated banks (not individually disclosed)", role: "bank" },
  ],
  segregation: "segregated",
  bankruptcyRemoteness: "contractual-only",
  rehypothecation: "prohibited",
  reviewedAt: "2026-07-17",
  reviewer: "Kimi FIAT-CTRL shard-11",
  confidence: "verified",
  sources: [{ label: "Circle 10-K", url: "https://example.com/10k" }],
  uncertainty: "Bank-level split beyond BNY is not individually disclosed.",
};

describe("projectCustodyClientSummary", () => {
  it("returns null without a custody profile", () => {
    expect(projectCustodyClientSummary(coinWith(undefined))).toBeNull();
  });

  it("projects a segregated contractual-only profile", () => {
    const summary = projectCustodyClientSummary(coinWith(USDC_LIKE_PROFILE));
    expect(summary).not.toBeNull();
    expect(summary!.postureKey).toBe("segregated");
    expect(summary!.postureLabel).toBe("Segregated");
    expect(summary!.providers).toHaveLength(2);
    expect(summary!.providers[0]).toMatchObject({
      name: "The Bank of New York Mellon",
      roleLabel: "Custodian",
      jurisdiction: "United States",
      sharePct: 88,
    });
    expect(summary!.providers[1]!.sharePct).toBeNull();
    expect(summary!.segregationLabel).toBe("Segregated");
    expect(summary!.bankruptcyRemotenessLabel).toBe("Contractual");
    expect(summary!.rehypothecationLabel).toBe("Prohibited");
    expect(summary!.rehypothecationToneClass).toBeNull();
    expect(summary!.confidenceLabel).toBe("Verified");
    expect(summary!.reviewedAt).toBe("2026-07-17");
    expect(summary!.summary).toContain("The Bank of New York Mellon");
    expect(summary!.summary).toContain("segregated accounts");
    expect(summary!.summary).toContain("Rehypothecation is prohibited.");
  });

  it("derives the top posture for segregated + structured remoteness", () => {
    const summary = projectCustodyClientSummary(
      coinWith({ ...USDC_LIKE_PROFILE, bankruptcyRemoteness: "structured" }),
    );
    expect(summary!.postureKey).toBe("segregated-remote");
    expect(summary!.postureLabel).toBe("Segregated · remote");
  });

  it("flags omnibus custody, permitted rehypothecation, and unknown exposure", () => {
    const summary = projectCustodyClientSummary(
      coinWith({
        ...USDC_LIKE_PROFILE,
        segregation: "omnibus",
        rehypothecation: "permitted",
        knownUnknownExposurePct: 12,
      }),
    );
    expect(summary!.postureKey).toBe("omnibus-or-mixed");
    expect(summary!.rehypothecationToneClass).toContain("amber");
    expect(summary!.undisclosedSharePct).toBe(12);
  });

  it("maps unknown segregation to the undisclosed posture", () => {
    const summary = projectCustodyClientSummary(coinWith({ ...USDC_LIKE_PROFILE, segregation: "unknown" }));
    expect(summary!.postureKey).toBe("undisclosed");
  });
});

describe("shouldDisplayCustodyModule", () => {
  it("shows the module for an explicit centralized custodyModel even on a cdp archetype", () => {
    expect(shouldDisplayCustodyModule({ custodyModel: "institutional-regulated" }, "cdp")).toBe(true);
  });

  it("hides the module for an explicit onchain custodyModel even on a fiat-cash archetype", () => {
    expect(shouldDisplayCustodyModule({ custodyModel: "onchain" }, "fiat-cash")).toBe(false);
  });

  it("hides the module for a cdp archetype with no explicit custodyModel", () => {
    expect(shouldDisplayCustodyModule({ custodyModel: undefined }, "cdp")).toBe(false);
  });

  it("hides the module for an algorithmic archetype with no explicit custodyModel", () => {
    expect(shouldDisplayCustodyModule({ custodyModel: undefined }, "algorithmic")).toBe(false);
  });

  it("shows the module for a fiat-cash archetype with no explicit custodyModel", () => {
    expect(shouldDisplayCustodyModule({ custodyModel: undefined }, "fiat-cash")).toBe(true);
  });

  it("shows the module for a null archetype with no explicit custodyModel", () => {
    expect(shouldDisplayCustodyModule({ custodyModel: undefined }, null)).toBe(true);
  });
});

// src/lib/__tests__/regulatory-standing.test.ts
import { describe, expect, it } from "vitest";
import type { GeniusProfile, MicaProfile } from "@shared/types";
import { buildRegulatoryStandingView } from "../regulatory-standing";

const GENIUS: GeniusProfile = {
  applicability: "apparent-payment-stablecoin",
  authorizationStatus: "official-application-pending",
  issuerPathway: "federal-qualified-nonbank",
  licensingRegulator: "OCC",
  monthlyAttestationPresent: true,
  redemptionPolicyPresent: true,
  reserveDisclosurePresent: true,
  reserveDisclosureUrl: "https://example.com/reserves",
  latestReportDate: "2026-07-01",
  references: [
    { label: "OCC filing", url: "https://example.com/occ", sourceKind: "federal-regulator" },
  ],
  reviewer: "test",
  reviewedAt: "2026-07-02",
};

const MICA: MicaProfile = {
  status: "authorized",
  tokenType: "EMT",
  competentAuthority: "DNB (Netherlands)",
  references: [{ label: "DNB register", url: "https://example.com/dnb" }],
};

describe("buildRegulatoryStandingView", () => {
  it("returns null when neither regime exists", () => {
    expect(buildRegulatoryStandingView({ symbol: "XXX" })).toBeNull();
  });

  it("builds both regimes with facts, checklist, merged sources, and review date", () => {
    const view = buildRegulatoryStandingView({ symbol: "USDC", genius: GENIUS, mica: MICA });
    expect(view).not.toBeNull();
    expect(view!.regimes.map((regime) => regime.key)).toEqual(["genius", "mica"]);
    const genius = view!.regimes[0]!;
    expect(genius.facts.find((fact) => fact.key === "status")!.value).toBe("Filing Pending");
    expect(genius.facts.find((fact) => fact.key === "pathway")!.value).toBe("Federal qualified issuer");
    expect(genius.facts.find((fact) => fact.key === "regulator")!.value).toBe("OCC");
    expect(genius.checklist).toHaveLength(3);
    expect(genius.checklist[2]).toMatchObject({
      present: true,
      href: "https://example.com/reserves",
      note: "latest 2026-07-01",
    });
    const mica = view!.regimes[1]!;
    expect(mica.facts.find((fact) => fact.key === "status")!.value).toBe("Authorized");
    expect(mica.facts.find((fact) => fact.key === "token-type")!.value).toBe("E-Money Token");
    expect(mica.checklist).toHaveLength(0);
    expect(view!.sources.map((source) => source.url)).toEqual([
      "https://example.com/occ",
      "https://example.com/dnb",
    ]);
    expect(view!.reviewedAt).toBe("2026-07-02");
    expect(view!.summary).toContain("USDC");
  });

  it("prioritizes MiCA authorization for the badge when GENIUS is only pending", () => {
    const view = buildRegulatoryStandingView({ symbol: "USDC", genius: GENIUS, mica: MICA });
    expect(view!.badgeLabel).toBe("MiCA Authorized");
  });

  it("uses the approved GENIUS status for the badge when present", () => {
    const view = buildRegulatoryStandingView({
      symbol: "USDC",
      genius: { ...GENIUS, authorizationStatus: "ppsi-approved" },
      mica: MICA,
    });
    expect(view!.badgeLabel).toBe("PPSI Approved");
  });

  it("drops an irrelevant GENIUS profile and returns null when nothing remains", () => {
    const view = buildRegulatoryStandingView({
      symbol: "XAUT",
      genius: { ...GENIUS, applicability: "non-payment-token", authorizationStatus: "not-applicable" },
    });
    expect(view).toBeNull();
  });

  it("prefers the bounded primaryFederalRegulator enum over free-form licensingRegulator prose", () => {
    const longLicensingRegulator =
      "Office of the Comptroller of the Currency, acting as primary federal banking regulator " +
      "under 12 U.S.C. Chapter 1, with concurrent examination authority delegated to regional staff";
    expect(longLicensingRegulator.length).toBeGreaterThan(100);
    const view = buildRegulatoryStandingView({
      symbol: "USDC",
      genius: { ...GENIUS, licensingRegulator: longLicensingRegulator, primaryFederalRegulator: "OCC" },
    });
    const regulatorFact = view!.regimes[0]!.facts.find((fact) => fact.key === "regulator")!;
    expect(regulatorFact.value).toBe("OCC");
    // The enum wins the cell, but the researched prose survives as the hover title.
    expect(regulatorFact.title).toBe(
      "Office of the Comptroller of the Currency, acting as primary federal banking regulator under 12 U.S.C. Chapter 1, with concurrent examination authority delegated to regional staff",
    );
  });

  it("slices free-form licensingRegulator prose at the first clause break and keeps the full string as title", () => {
    const view = buildRegulatoryStandingView({
      symbol: "USDX",
      genius: {
        ...GENIUS,
        licensingRegulator: "NYDFS (BitLicense; trust charter)",
        primaryFederalRegulator: undefined,
      },
    });
    const regulatorFact = view!.regimes[0]!.facts.find((fact) => fact.key === "regulator")!;
    expect(regulatorFact.value).toBe("NYDFS");
    expect(regulatorFact.title).toBe("NYDFS (BitLicense; trust charter)");
  });

  it("hides checklist rows the review did not research", () => {
    const view = buildRegulatoryStandingView({
      symbol: "USDX",
      genius: {
        ...GENIUS,
        monthlyAttestationPresent: undefined,
        redemptionPolicyPresent: false,
        reserveDisclosurePresent: undefined,
        reserveDisclosureUrl: undefined,
        latestReportDate: undefined,
      },
    });
    const checklist = view!.regimes[0]!.checklist;
    expect(checklist).toHaveLength(1);
    expect(checklist[0]).toMatchObject({ label: "Redemption policy", present: false });
  });
});

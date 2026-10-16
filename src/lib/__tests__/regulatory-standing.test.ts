// src/lib/__tests__/regulatory-standing.test.ts
import { describe, expect, it } from "vitest";
import type { GeniusProfile, MicaProfile, StablecoinMeta } from "@shared/types";
import { MICA_STATUS_BADGE_STYLES } from "@shared/lib/mica";
import { GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES } from "@shared/lib/genius";
import {
  buildRegulatoryStandingView,
  formatReserveReportNote,
  ISSUER_DISCLOSURES,
} from "../regulatory-standing";

const GENIUS: GeniusProfile = {
  applicability: "apparent-payment-stablecoin",
  authorizationStatus: "official-application-pending",
  issuerPathway: "federal-qualified-nonbank",
  licensingRegulator: "OCC",
  monthlyAttestationPresent: true,
  redemptionPolicyPresent: true,
  reserveDisclosurePresent: true,
  reserveDisclosureUrl: "https://example.com/reserves",
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

const REPORT: NonNullable<NonNullable<StablecoinMeta["proofOfReserves"]>["latestReport"]> = {
  periodEnd: "2026-06-30",
  publishedAt: "2026-07-29",
  assuranceMethod: "examination",
  scope: "assets-and-liabilities",
  liabilityReconciliation: "full",
  reviewer: "test",
  confidence: "verified",
  sources: [{ label: "Report", url: "https://example.com/report" }],
};

describe("buildRegulatoryStandingView", () => {
  it("keeps a CASH-like issuance-path signal distinct from an announced authorization plan", () => {
    const view = buildRegulatoryStandingView({
      symbol: "CASH",
      genius: {
        ...GENIUS,
        authorizationStatus: "issuer-announced-intent",
        issuerPathway: "unknown",
        references: [{ label: "Open issuance", url: "https://example.com/issuance", sourceKind: "issuer-disclosure" }],
      },
    })!;
    expect(view.summary).toMatch(/public materials signalling a GENIUS-era issuance path/);
    expect(view.summary).not.toMatch(/announced intent|seek GENIUS authorization|filing pending|approved/);
  });

  it("builds both regimes as status rows, issuer disclosures apart from them, fold facts, merged sources, and review date", () => {
    const view = buildRegulatoryStandingView({
      symbol: "USDC", genius: GENIUS, mica: MICA,
      proofOfReserves: { type: "independent-audit", url: "https://example.com/reserves", latestReport: REPORT },
    });
    expect(view).not.toBeNull();
    expect(view!.regimes.map((regime) => regime.key)).toEqual(["genius", "mica"]);
    const genius = view!.regimes[0]!;
    expect(genius.status.toneClass).toBe(GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES["official-application-pending"].cls);
    expect(genius.caption).toBeTruthy();
    expect(genius.facts.find((fact) => fact.key === "regulator")!.value).toBe("OCC");
    expect(view!.issuerDisclosures.map((row) => row.key)).toEqual(ISSUER_DISCLOSURES.map((disclosure) => disclosure.key));
    expect(view!.issuerDisclosures.find((row) => row.key === "reserve-disclosure")).toMatchObject({
      state: "published",
      href: "https://example.com/reserves",
    });
    expect(view!.reportNote).toContain(REPORT.periodEnd);
    expect(view!.reportNote).toContain(REPORT.publishedAt);
    expect(view!.reportNote).not.toContain(GENIUS.reviewedAt);
    const mica = view!.regimes[1]!;
    expect(mica.status.toneClass).toBe(MICA_STATUS_BADGE_STYLES.authorized.cls);
    expect(mica.caption).toBeTruthy();
    expect(mica.facts.find((fact) => fact.key === "authority")!.value).toBe("DNB (Netherlands)");
    expect(view!.sources.map((source) => source.url)).toEqual([
      "https://example.com/occ",
      "https://example.com/dnb",
    ]);
    expect(view!.reviewedAt).toBe("2026-07-02");
    expect(view!.summary).toContain("USDC");
  });

  it("records issuer disclosures only from a GENIUS review, never from MiCA", () => {
    const view = buildRegulatoryStandingView({ symbol: "EURX", mica: MICA });
    expect(view!.issuerDisclosures).toEqual([]);
  });

  it("prioritizes MiCA authorization for the badge when GENIUS is only pending", () => {
    const view = buildRegulatoryStandingView({ symbol: "USDC", genius: GENIUS, mica: MICA });
    expect(view!.badgeToneClass).toBe(MICA_STATUS_BADGE_STYLES.authorized.cls);
    expect(view!.badgeLabel).toContain("MiCA");
  });

  it("uses the approved GENIUS status for the badge when present", () => {
    const view = buildRegulatoryStandingView({
      symbol: "USDC",
      genius: { ...GENIUS, authorizationStatus: "ppsi-approved" },
      mica: MICA,
    });
    expect(view!.badgeToneClass).toBe(GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES["ppsi-approved"].cls);
    expect(view!.badgeLabel).not.toContain("MiCA");
  });

  it("keeps MiCA out-of-scope muted and non-compliant in its alert tone", () => {
    const outOfScope = buildRegulatoryStandingView({ symbol: "MTB", mica: { status: "out-of-scope" } })!;
    const nonCompliant = buildRegulatoryStandingView({ symbol: "USDE", mica: { ...MICA, status: "non-compliant" } })!;
    expect(outOfScope.regimes[0]!.status.toneClass).toBe(MICA_STATUS_BADGE_STYLES["out-of-scope"].cls);
    expect(outOfScope.badgeToneClass).toBe(MICA_STATUS_BADGE_STYLES["out-of-scope"].cls);
    expect(nonCompliant.regimes[0]!.status.toneClass).toBe(MICA_STATUS_BADGE_STYLES["non-compliant"].cls);
    expect(outOfScope.regimes[0]!.status.toneClass).not.toBe(nonCompliant.regimes[0]!.status.toneClass);
  });

  it("drops an irrelevant GENIUS profile and returns null when nothing remains", () => {
    const view = buildRegulatoryStandingView({
      symbol: "XAUT",
      genius: { ...GENIUS, applicability: "non-payment-token", authorizationStatus: "not-applicable" },
    });
    expect(view).toBeNull();
  });

  it("keeps unresearched disclosures as unavailable rather than dropping or failing them", () => {
    const view = buildRegulatoryStandingView({
      symbol: "USDX",
      genius: {
        ...GENIUS,
        monthlyAttestationPresent: undefined,
        redemptionPolicyPresent: false,
        reserveDisclosurePresent: undefined,
        reserveDisclosureUrl: undefined,
      },
    });
    const states = Object.fromEntries(view!.issuerDisclosures.map((row) => [row.key, row.state]));
    expect(states).toEqual({ attestation: "unrecorded", "redemption-policy": "gap", "reserve-disclosure": "unrecorded" });
  });

  describe("attestation cell: one source of truth with the passport's Attestor entry", () => {
    const QUARTERLY_CPA: NonNullable<StablecoinMeta["proofOfReserves"]> = {
      type: "attestation",
      url: "https://example.com/transparency",
      provider: "BDO Italia",
      attestorTier: "regional",
      cadence: "quarterly",
    };

    function disclosures(
      monthlyAttestationPresent: boolean | undefined,
      proofOfReserves?: StablecoinMeta["proofOfReserves"],
    ) {
      const view = buildRegulatoryStandingView({
        symbol: "USDT",
        genius: { ...GENIUS, monthlyAttestationPresent, redemptionPolicyPresent: false },
        proofOfReserves,
      });
      const rows = view!.issuerDisclosures;
      return {
        attestation: rows.find((row) => row.key === "attestation")!,
        // A reviewed absence from the same view: the "Not found" reading.
        notFound: rows.find((row) => row.key === "redemption-policy")!,
      };
    }

    it("never reads a named attestor as not found: a quarterly CPA attestation is a cadence gap", () => {
      const { attestation, notFound } = disclosures(false, QUARTERLY_CPA);
      expect(attestation.state).toBe("gap");
      expect(attestation.value).not.toBe(notFound.value);
      expect(attestation.title).toContain("BDO Italia");
    });

    it("lets the reserves record's cadence outrank the review flag in both directions", () => {
      expect(disclosures(false, { ...QUARTERLY_CPA, cadence: "monthly" }).attestation.state).toBe("published");
      expect(disclosures(true, QUARTERLY_CPA).attestation.state).toBe("gap");
    });

    it("keeps an attestor without a recorded cadence distinct from an absent attestation", () => {
      const reviewedNotMonthly = disclosures(false, { ...QUARTERLY_CPA, cadence: undefined });
      expect(reviewedNotMonthly.attestation.state).toBe("gap");
      expect(reviewedNotMonthly.attestation.value).not.toBe(reviewedNotMonthly.notFound.value);
      expect(disclosures(undefined, { ...QUARTERLY_CPA, cadence: undefined }).attestation.state).toBe("published");
    });

    it("reads a self-attestation as a gap, never as published", () => {
      for (const reviewed of [true, false, undefined]) {
        const { attestation, notFound } = disclosures(reviewed, { ...QUARTERLY_CPA, attestorTier: "self", cadence: "monthly" });
        expect(attestation.state).toBe("gap");
        expect(attestation.value).not.toBe(notFound.value);
      }
    });

    it("agrees with a reviewed 'no attestation' tier and defers to the review when the attestor is undisclosed", () => {
      const none = disclosures(true, { ...QUARTERLY_CPA, attestorTier: "none" });
      expect(none.attestation).toMatchObject({ state: "gap", value: none.notFound.value });
      expect(disclosures(true, { ...QUARTERLY_CPA, attestorTier: "undisclosed" }).attestation.state).toBe("published");
      expect(disclosures(undefined, { ...QUARTERLY_CPA, attestorTier: "undisclosed" }).attestation.state).toBe("unrecorded");
    });

    it("falls back to the review's finding without a reserves record", () => {
      const { attestation, notFound } = disclosures(false);
      expect(attestation).toMatchObject({ state: "gap", value: notFound.value });
      expect(disclosures(true).attestation.state).toBe("published");
    });
  });

  it.each([
    { periodEnd: "2026-06-30", publishedAt: undefined },
    { periodEnd: undefined, publishedAt: "2026-07-29" },
  ])("preserves independently known report dates: %j", (dates) => {
    const note = formatReserveReportNote({ ...REPORT, ...dates });
    if (dates.periodEnd) expect(note).toContain(`period end ${dates.periodEnd}`);
    else expect(note).not.toContain("period end");
    if (dates.publishedAt) expect(note).toContain(`published ${dates.publishedAt}`);
    else expect(note).not.toContain("published");
  });

  it("labels a conservative publication stand-in as signed, not published", () => {
    const note = formatReserveReportNote({ ...REPORT, publishedAtBasis: "signed-date-standin" });
    expect(note).toContain("period end 2026-06-30; signed 2026-07-29");
    expect(note).not.toContain("published");
  });

  it("qualifies an ambiguous legacy date by its review without claiming a latest report", () => {
    const note = formatReserveReportNote({
      ...REPORT,
      periodEnd: undefined,
      publishedAt: undefined,
      reviewReference: { date: "2026-04-30", reviewedAt: "2026-06-18", dateKind: "unspecified" },
    });
    expect(note).toContain("2026-04-30");
    expect(note).toContain("as of 2026-06-18 review");
    expect(note).not.toMatch(/latest|period end|published/i);
  });

  it("does not fabricate a report note from disclosure presence or a review date", () => {
    const view = buildRegulatoryStandingView({ symbol: "USDC", genius: GENIUS });
    expect(view!.reportNote).toBeNull();
    expect(formatReserveReportNote({ ...REPORT, periodEnd: undefined, publishedAt: undefined })).toBeUndefined();
  });
});

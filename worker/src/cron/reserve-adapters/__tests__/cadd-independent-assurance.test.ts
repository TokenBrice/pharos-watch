import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import {
  getIndependentAssuranceManifest,
  reconcileIndependentAssuranceManifest,
} from "@shared/lib/independent-assurance";
import { CADD_INDEPENDENT_ASSURANCE_PROFILE } from "../cadd-independent-assurance";
import { indexFixture, verifyFixtureIndex } from "./independent-assurance.test-support";

describe("cadd-independent-assurance (Baker Tilly CSAE 3000)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reviews the August 31 2026 reasonable assurance report and reconciles CAD circulation across Base, Tempo and Ethereum", () => {
    const manifest = getIndependentAssuranceManifest("CADD");
    expect(manifest.assuranceTier).toBe("independent-assurance");
    expect(manifest.conclusion).toBe("unmodified");
    expect(manifest.attestor).toBe("Baker Tilly WM LLP");
    expect(manifest.reportAsOf).toBe("2026-08-31T23:59:00Z");
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({
      computedAssetTotal: "1207253.18",
      liabilityTotal: "1207019.18",
      reportedAssetDifference: "0",
      reportedLiabilityDifference: "0",
    });
    expect(manifest.assets).toEqual([
      { code: "cad-cash", label: "Canadian Dollar Cash", amount: "1207253.18" },
    ]);
    expect(manifest.liabilities).toHaveLength(1);
    const liability = manifest.liabilities[0];
    for (const chain of ["Base", "Tempo", "Ethereum"]) {
      expect(liability.label).toContain(chain);
    }
    expect(liability.amount).toBe("1207019.18");
  });

  it("declares the independent / independent-assurance descriptor", () => {
    const definition =
      LIVE_RESERVE_ADAPTER_DEFINITIONS["cadd-independent-assurance"];
    expect(definition.evidenceClass).toBe("independent");
    expect(definition.sourceOriginClass).toBe("independent-assurance");
    expect(definition.primaryInputKinds).toEqual(["http-html"]);
  });

  it("rewrites Drive share links to direct downloads and dates candidates from anchor text", async () => {
    const prepared = await CADD_INDEPENDENT_ASSURANCE_PROFILE.prepareIndexHtml!(
      indexFixture("cadd-independent-assurance.html"),
      new AbortController().signal,
      undefined,
    );
    expect(prepared).not.toContain("view?usp=sharing");
    expect(prepared).toContain(
      getIndependentAssuranceManifest("CADD").reportUrl,
    );
    const date = CADD_INDEPENDENT_ASSURANCE_PROFILE.reportDateFromCandidate!;
    expect(date("", "June 2026 attestation")).toBe("2026-06-30");
    expect(date("", "July 2026 attestation")).toBe("2026-07-31");
    expect(date("", "August 2026 attestation")).toBe("2026-08-31");
    expect(date("", "Daily Reserve Ratio Reports")).toBeNull();
    expect(
      CADD_INDEPENDENT_ASSURANCE_PROFILE.isReportCandidate(
        "",
        "Daily Reserve Ratio Reports ",
      ),
    ).toBe(false);
    expect(
      CADD_INDEPENDENT_ASSURANCE_PROFILE.isReportCandidate(
        "",
        "June 2026 attestation",
      ),
    ).toBe(true);
  });


  it("rejects an attestation whose anchor text carries no date", async () => {
    const html = indexFixture("cadd-independent-assurance.html") +
      '<a href="https://drive.google.com/file/d/1AAAAAAA/view?usp=sharing">Attestation</a>';
    await expect(verifyFixtureIndex(
      "CADD", CADD_INDEPENDENT_ASSURANCE_PROFILE, "cadd-independent-assurance.html", html,
    )).rejects.toThrow("ambiguous report date");
  });

});

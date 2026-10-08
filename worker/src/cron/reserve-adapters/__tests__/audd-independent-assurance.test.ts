import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { AUDD_INDEPENDENT_ASSURANCE_PROFILE } from "../audd-independent-assurance-profile";
import { indexFixture, verifyFixtureIndex } from "./independent-assurance.test-support";

describe("audd-independent-assurance (William Buck ASRS 4400 AUP)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reviews the September 2026 agreed-upon-procedures report and reconciles every chain's circulation", () => {
    const manifest = getIndependentAssuranceManifest("AUDD");
    expect(manifest.assuranceTier).toBe("agreed-upon-procedures");
    expect(manifest.attestor).toBe("William Buck Audit (Vic) Pty Ltd");
    expect(manifest.reportAsOf).toBe("2026-09-30T23:59:00Z");
    expect(reconcileIndependentAssuranceManifest(manifest, AUDD_INDEPENDENT_ASSURANCE_PROFILE.reconciliation)).toMatchObject({
      computedAssetTotal: "11289945.05",
      liabilityTotal: "11159088.48",
      reportedAssetDifference: "0",
      reportedLiabilityDifference: "0.01",
    });
    for (const chain of ["stellar", "xrpl", "ethereum", "solana", "hedera", "base", "xdc", "redbelly", "arc"]) {
      expect(manifest.liabilities.some((row) => row.code === chain && Number(row.amount) > 0)).toBe(true);
    }
    expect(manifest.assets).toEqual([
      { code: "banking-circle", label: "AUD cash held at Banking Circle (AUDC Reserve Account)", amount: "1880893.19" },
      { code: "westpac", label: "AUD cash held at Westpac under the AMAL Bare Trust", amount: "9409051.86" },
    ]);
  });

  it("rejects discrepancies beyond the cent-rounding bound or relative cap", () => {
    const manifest = getIndependentAssuranceManifest("AUDD");
    for (const reportedLiabilityTotal of ["11159088.54", "11159088.42"]) {
      expect(() => reconcileIndependentAssuranceManifest(
        { ...manifest, reportedLiabilityTotal }, AUDD_INDEPENDENT_ASSURANCE_PROFILE.reconciliation,
      )).toThrow("reported liability total differs");
    }
    expect(() => reconcileIndependentAssuranceManifest({
      ...manifest,
      liabilities: [{ code: "small", label: "Small circulation", amount: "1.00" }],
      reportedLiabilityTotal: "1.01",
    }, AUDD_INDEPENDENT_ASSURANCE_PROFILE.reconciliation)).toThrow("reported liability total differs");
  });

  it("declares the static-validated / issuer-attested descriptor for a non-assurance engagement", () => {
    const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS["audd-independent-assurance"];
    expect(definition.evidenceClass).toBe("static-validated");
    expect(definition.sourceOriginClass).toBe("issuer-attested");
    expect(definition.sourceModel).toBe("validated-static");
  });


  it("rejects a candidate whose date cannot be derived from its filename", async () => {
    const html = indexFixture("audd-independent-assurance.html") +
      '<a href="https://www.audd.digital/wp-content/uploads/2026/10/AUDC-Agreed-upon-procedures-report-Undated.pdf">Undated</a>';
    await expect(verifyFixtureIndex(
      "AUDD", AUDD_INDEPENDENT_ASSURANCE_PROFILE, "audd-independent-assurance.html", html,
    )).rejects.toThrow("ambiguous report date");
  });


});

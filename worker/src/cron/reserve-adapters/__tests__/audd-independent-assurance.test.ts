import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { AUDD_INDEPENDENT_ASSURANCE_PROFILE } from "../audd-independent-assurance";
import { indexFixture, verifyFixtureIndex } from "./independent-assurance.test-support";

describe("audd-independent-assurance (William Buck ASRS 4400 AUP)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reviews the August 2026 agreed-upon-procedures report and reconciles every chain's circulation", () => {
    const manifest = getIndependentAssuranceManifest("AUDD");
    expect(manifest.assuranceTier).toBe("agreed-upon-procedures");
    expect(manifest.attestor).toBe("William Buck Audit (Vic) Pty Ltd");
    expect(manifest.reportAsOf).toBe("2026-08-31T23:59:00Z");
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({
      computedAssetTotal: "11544609.77",
      liabilityTotal: "11408211.96",
      reportedAssetDifference: "0",
      reportedLiabilityDifference: "0",
    });
    for (const chain of ["stellar", "xrpl", "ethereum", "solana", "hedera", "base", "xdc", "redbelly"]) {
      expect(manifest.liabilities.some((row) => row.code === chain && Number(row.amount) > 0)).toBe(true);
    }
    expect(manifest.assets).toEqual([
      { code: "banking-circle", label: "AUD cash held at Banking Circle (AUDC Reserve Account)", amount: "288159.90" },
      { code: "westpac", label: "AUD cash held at Westpac under the AMAL Bare Trust", amount: "11256449.87" },
    ]);
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

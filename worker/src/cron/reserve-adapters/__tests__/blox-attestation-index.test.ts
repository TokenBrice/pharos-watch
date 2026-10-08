import { describe, expect, it } from "vitest";
import { adaptBloxAttestationIndex } from "../blox-attestation-index";
import { BLOX_ATTESTATIONS } from "./fixtures/blox-attestations";
import sidecar from "@shared/data/stablecoins/domains/reserves/myrc-blox.json";

const AUGUST = BLOX_ATTESTATIONS[0];

describe("blox-attestation-index", () => {
  it("dates the reviewed composition from examined balances, never the upload time", () => {
    const result = adaptBloxAttestationIndex([...BLOX_ATTESTATIONS].reverse());
    expect(result.slices.map(({ name, pct }) => ({ name, pct }))).toEqual([
      { name: "MYR cash at Malaysian banks", pct: 66.68 },
      { name: "Halogen Shariah MYR Liquid Fund", pct: 33.32 },
    ]);
    expect(result.slices.map((slice) => slice.sourceKey)).toEqual(sidecar.reserves.map((slice) => slice.sourceKey));
    expect(result.slices.map((slice) => slice.sourceKey)).toEqual([
      "blox-independent-assurance:myrc:cash", "blox-independent-assurance:myrc:halogen-myr-liquid-fund",
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: Date.parse("2026-08-31T00:00:00Z") / 1000,
      details: { reserveCurrency: "MYR", reserveAmount: 1800903.77, reportedBreakdownDifference: 0.03 },
    });
    expect(result.metadata).not.toHaveProperty("totalReserveUsd");
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
  });

  it("withholds historical allocations when a newer unreviewed report appears", () => {
    expect(() => adaptBloxAttestationIndex([
      ...BLOX_ATTESTATIONS,
      { ...AUGUST, month: 9, fileUrl: "https://cdn.blox.my/attestations/2026/Blox Attestation Report-2026-09-September.pdf" },
    ])).toThrow(/not the reviewed/);
  });

  it.each([
    { ...AUGUST, reservedAmount: 180090374 },
    { ...AUGUST, reservedAmount: null },
    { ...AUGUST, month: 13 },
    { ...AUGUST, fileUrl: "https://example.com/attestations/2026/report.pdf" },
    { ...AUGUST, fileUrl: AUGUST.fileUrl.replace("August", "Replaced") },
  ])("fails closed on changed totals, invalid periods or report identity", (record) => {
    expect(() => adaptBloxAttestationIndex([record])).toThrow();
  });

  it("rejects ambiguous duplicate newest periods and a regressed index", () => {
    expect(() => adaptBloxAttestationIndex([AUGUST, AUGUST])).toThrow(/not the reviewed/);
    expect(() => adaptBloxAttestationIndex(BLOX_ATTESTATIONS.slice(1))).toThrow(/not the reviewed/);
  });

  it.each([null, {}, [], [{ year: 2026 }]])("rejects unavailable or incomplete indexes", (payload) => {
    expect(() => adaptBloxAttestationIndex(payload)).toThrow();
  });
});

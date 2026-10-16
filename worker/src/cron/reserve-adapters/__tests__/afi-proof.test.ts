import { describe, expect, it } from "vitest";

import { adaptAfiProof } from "../afi-proof";
import { AFI_PROOF_PAYLOAD as PAYLOAD } from "./afi-proof.test-support";

describe("adaptAfiProof", () => {
  it("publishes the opaque basket with aggregate ratio telemetry and unverified freshness", () => {
    const result = adaptAfiProof(structuredClone(PAYLOAD), { symbol: "rwaUSDi" });

    expect(result.slices).toEqual([{
      name: "Institutional credit and market-neutral fund basket",
      sourceKey: "afi-proof:aggregate",
      pct: 100,
      risk: "high",
      assetClass: "other",
      issuerOrObligor: expect.any(String),
    }]);
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 1_500_000_000,
      totalLiabilitiesUsd: 479_782_100,
      collateralizationRatio: expect.closeTo(1_500_000_000 / 479_782_100, 9),
      unknownExposurePct: 100,
      freshnessMode: "unverified",
    });
    expect(result.metadata!.details).toMatchObject({
      proofId: "fa575eeac9391401",
      opaqueBasket: true,
      active: true,
    });
    expect(result.warnings!.map((w) => w.code)).toEqual(["opaque-reserve-basket"]);
    expect(result.warnings![0]).toMatchObject({ effect: "info", severity: "info" });
  });

  it("fails closed when the proof symbol does not match the configured pin", () => {
    expect(() => adaptAfiProof(structuredClone(PAYLOAD), { symbol: "USDO" }))
      .toThrow("does not match configured symbol");
  });

  it("fails closed when verifiedTotals disagree with the envelope", () => {
    const payload = structuredClone(PAYLOAD);
    payload.proof.verifiedTotals.totalReserves = "1499999999.00";
    expect(() => adaptAfiProof(payload, { symbol: "rwaUSDi" }))
      .toThrow("disagree with the envelope totals");
  });

  it("fails closed when the ratio disagrees with reserves/liabilities", () => {
    const payload = structuredClone(PAYLOAD);
    payload.collateralRatio = 200;
    expect(() => adaptAfiProof(payload, { symbol: "rwaUSDi" }))
      .toThrow("disagrees with reserves/liabilities");
  });

  it("publishes an undercollateralized reading as degraded instead of throwing", () => {
    const payload = structuredClone(PAYLOAD);
    payload.totalReserves = 100_000_000;
    payload.totalLiabilities = 200_000_000;
    payload.collateralRatio = 50;
    payload.proof.verifiedTotals = { totalReserves: "100000000.00", totalLiabilities: "200000000.00" };
    const result = adaptAfiProof(payload, { symbol: "rwaUSDi" });
    expect(result.metadata!.collateralizationRatio).toBeCloseTo(0.5, 9);
    expect(result.warnings!.some((w) => w.code === "reserve-undercollateralized" && w.effect === "degraded")).toBe(true);
  });
});

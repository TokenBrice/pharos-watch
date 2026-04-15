import { describe, expect, it } from "vitest";
import { adaptSolsticeAttestation } from "../solstice-attestation";

describe("adaptSolsticeAttestation", () => {
  it("maps aggregate Solstice reserve proof as a non-scoring high-risk proof slice", () => {
    const result = adaptSolsticeAttestation({
      res: "ok",
      data: {
        collateralization: 1.005,
        ts: "1776264425730",
        reserves: {
          verifiability: "100",
          interval: "periodic",
          timeline: [
            {
              ts: "1776200000000",
              reserves: 301_500_000,
              supply: 300_000_000,
              delta_neutral: true,
              overcollateralized: true,
            },
          ],
        },
      },
    });

    expect(result.slices).toEqual([
      { name: "Aggregate Solstice attested reserves", pct: 100, risk: "high" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1776264425,
      totalReserveUsd: 301_500_000,
      supplyUsd: 300_000_000,
      collateralizationRatio: 1.005,
      deltaNeutral: true,
      overcollateralized: true,
    });
  });
});

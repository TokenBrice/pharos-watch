import { describe, expect, it } from "vitest";
import { adaptSolsticeAttestation } from "../solstice-attestation";
import { validateAdapterOutput } from "../validate";
import { getReserveAdapter } from "../index";

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

  it("throws when res is not ok (parse-failure path)", () => {
    expect(() =>
      adaptSolsticeAttestation({
        res: "error",
        data: { reserves: { timeline: [] } },
      }),
    ).toThrow(/invalid response/);
  });

  it("throws when the latest timeline point has no reserve/supply values", () => {
    expect(() =>
      adaptSolsticeAttestation({
        res: "ok",
        data: {
          reserves: {
            timeline: [{ ts: "1776200000000" }],
          },
        },
      }),
    ).toThrow(/missing reserve\/supply/);
  });

  it("falls back to unverified freshness when no timestamp is discoverable", () => {
    const result = adaptSolsticeAttestation({
      res: "ok",
      data: {
        reserves: {
          timeline: [
            { reserves: 1000, supply: 900 },
          ],
        },
      },
    });
    expect(result.metadata?.freshnessMode).toBe("unverified");
  });

  it("is rejected by validateAdapterOutput when the source timestamp is in the future", () => {
    const futureMs = (Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60) * 1000;
    const result = adaptSolsticeAttestation({
      res: "ok",
      data: {
        ts: String(futureMs),
        reserves: {
          timeline: [
            { ts: String(futureMs), reserves: 1000, supply: 900 },
          ],
        },
      },
    });
    const adapter = getReserveAdapter("solstice-attestation") ?? undefined;
    const report = validateAdapterOutput(result, { adapter });
    expect(report.valid).toBe(false);
  });
});

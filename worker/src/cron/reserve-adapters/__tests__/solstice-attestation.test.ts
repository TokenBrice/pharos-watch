import { describe, expect, it } from "vitest";
import { adaptSolsticeAttestation } from "../solstice-attestation";
import { validateAdapterOutput } from "../validate";
import { getReserveAdapter } from "../index";

describe("adaptSolsticeAttestation", () => {
  it("selects the newest unsorted point and computes rather than trusts the published ratio", () => {
    const result = adaptSolsticeAttestation({
      res: "ok",
      data: {
        collateralization: 9,
        reserves: { timeline: [
          { ts: 1_776_000_000, reserves: 90, supply: 100 },
          { ts: 1_778_000_000, reserves: 120, supply: 100 },
          { ts: 1_777_000_000, reserves: 110, supply: 100 },
        ] },
      },
    });
    expect(result.metadata).toMatchObject({
      sourceTimestamp: 1_778_000_000, totalReserveUsd: 120, supplyUsd: 100,
      collateralizationRatio: 1.2, publishedCollateralizationRatio: 9,
    });
  });

  it("does not reuse older reserves when the newest point is malformed", () => {
    expect(() => adaptSolsticeAttestation({
      res: "ok",
      data: { reserves: { timeline: [
        { ts: 1_776_000_000, reserves: 100, supply: 90 },
        { ts: 1_778_000_000, supply: 100 },
      ] } },
    })).toThrow(/missing reserve\/supply/);
  });

  it("uses the selected point date when neither envelope nor point has a timestamp", () => {
    const result = adaptSolsticeAttestation({
      res: "ok",
      data: { reserves: { timeline: [{ date: "2026-04-15", reserves: 120, supply: 100 }] } },
    });
    expect(result.metadata?.sourceTimestamp).toBe(Date.parse("2026-04-15") / 1000);
  });

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

  it("accepts within the 14-day cap but degrades a proof past it", () => {
    const sourceTimestamp = 1_788_341_462;
    const result = adaptSolsticeAttestation({
      res: "ok",
      data: {
        ts: String(sourceTimestamp * 1000),
        reserves: { timeline: [{ reserves: 1000, supply: 900 }] },
      },
    });
    const adapter = getReserveAdapter("solstice-attestation")!;
    expect(adapter.evidenceClass).toBe("weak-live-probe");
    const fresh = validateAdapterOutput(result, { adapter, now: sourceTimestamp + 1_209_600 });
    const stale = validateAdapterOutput(result, { adapter, now: sourceTimestamp + 1_209_601 });
    expect(fresh.valid).toBe(true);
    expect(fresh.warnings).not.toContainEqual(expect.objectContaining({ code: "stale-source-data" }));
    expect(stale.warnings).toContainEqual(expect.objectContaining({ code: "stale-source-data", effect: "degraded" }));
  });

  it("emits the attestations evidence basis from the same payload without warnings", () => {
    const result = adaptSolsticeAttestation({
      res: "ok",
      data: {
        collateralization: 1.004,
        ts: "1788944462773",
        attestations: {
          sev: { addr: "0x9F6745D25E4cc6ad6A0a96F37721Fb495108F794" },
          merkle_root: { rootHash: "GoShEX4gMDc9Y63zmyo6V51wx6uXWq7dXxfoALWSgWz2", ts: 1788968394288 },
          snapshot: { ts: 1788967832500 },
          zkp: {
            liabilities: { params: JSON.stringify({ dataHash: "7CwrfdDDyytZfKucpRmXBGLb41LQwhTEjumFDyBVkhy3" }) },
            collateral: { params: JSON.stringify({ dataHash: "DjrDyfVkAkW7KevtLuE5CbxNr2hAiFfEyAytDTUjuKe5" }) },
          },
        },
        reserves: {
          total_reserves: { value: 1000 },
          total_supply: { value: 900 },
          timeline: [{ ts: "1788944462773", reserves: 1000, supply: 900 }],
        },
      },
    });
    expect(result.metadata?.details).toEqual({
      evidenceBasis: {
        merkleRoot: "GoShEX4gMDc9Y63zmyo6V51wx6uXWq7dXxfoALWSgWz2",
        zkpLiabilitiesHash: "7CwrfdDDyytZfKucpRmXBGLb41LQwhTEjumFDyBVkhy3",
        zkpCollateralHash: "DjrDyfVkAkW7KevtLuE5CbxNr2hAiFfEyAytDTUjuKe5",
        snapshotTsMs: 1_788_967_832_500,
        sevAttestation: "0x9F6745D25E4cc6ad6A0a96F37721Fb495108F794",
      },
    });
    expect(result.metadata).toMatchObject({ attestedTotalReservesUsd: 1000, attestedTotalSupplyUsd: 900 });
    expect(result.warnings ?? []).toEqual([]);
  });

  it("degrades when headline totals diverge from the timeline beyond 0.5% and stays quiet within it", () => {
    const mismatched = adaptSolsticeAttestation({
      res: "ok",
      data: {
        reserves: {
          total_reserves: { value: 990 },
          total_supply: { value: 900 },
          timeline: [{ reserves: 1000, supply: 900 }],
        },
      },
    });
    expect(mismatched.warnings).toContainEqual(expect.objectContaining({
      code: "solstice-timeline-total-mismatch",
      severity: "warning",
      effect: "degraded",
    }));
    const quiet = adaptSolsticeAttestation({
      res: "ok",
      data: {
        reserves: {
          total_reserves: { value: 996 },
          total_supply: { value: 900 },
          timeline: [{ reserves: 1000, supply: 900 }],
        },
      },
    });
    expect(quiet.warnings).not.toContainEqual(
      expect.objectContaining({ code: "solstice-timeline-total-mismatch" }),
    );
  });

  it("warns info instead of failing when the attestations block is missing", () => {
    const result = adaptSolsticeAttestation({
      res: "ok",
      data: {
        reserves: {
          total_reserves: { value: 1000 },
          total_supply: { value: 900 },
          timeline: [{ reserves: 1000, supply: 900 }],
        },
      },
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "solstice-attestations-unavailable",
      severity: "info",
      effect: "info",
    }));
    expect(result.metadata?.details).not.toHaveProperty("evidenceBasis");
    const adapter = getReserveAdapter("solstice-attestation")!;
    expect(validateAdapterOutput(result, { adapter }).valid).toBe(true);
  });

  it("reports a partial evidence basis when proof fields are missing", () => {
    const result = adaptSolsticeAttestation({
      res: "ok",
      data: {
        ts: "1776264425730",
        attestations: {
          merkle_root: { rootHash: "GoShEX4gMDc9Y63zmyo6V51wx6uXWq7dXxfoALWSgWz2" },
        },
        reserves: { timeline: [{ ts: "1776264425730", reserves: 1000, supply: 900 }] },
      },
    });
    expect(result.metadata?.details).toEqual({
      evidenceBasis: {
        merkleRoot: "GoShEX4gMDc9Y63zmyo6V51wx6uXWq7dXxfoALWSgWz2",
        zkpLiabilitiesHash: null,
        zkpCollateralHash: null,
        snapshotTsMs: null,
        sevAttestation: null,
      },
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "solstice-evidence-basis-partial",
      severity: "info",
    }));
  });

});

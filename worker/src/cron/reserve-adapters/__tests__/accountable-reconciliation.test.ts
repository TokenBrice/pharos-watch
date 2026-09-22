import { describe, expect, it } from "vitest";
import { adaptAccountableDashboard } from "../accountable";
import {
  APYX_2026_07_27_PAYLOAD,
  APYX_RESERVE_PARAMS,
  makeApyxGuardPayload,
} from "./accountable.test-support";

describe("adaptAccountableDashboard collateralization reconciliation", () => {

  it("reconciles the contradicted Apyx snapshot to a net-of-protocol-owned denominator", () => {
    const result = adaptAccountableDashboard({ ...APYX_2026_07_27_PAYLOAD }, { ...APYX_RESERVE_PARAMS });

    // The gross ratio the prior review derived, and the ratio the dashboard actually reports.
    expect(308_600_110.7 / 327_073_514.82).toBeCloseTo(0.943519, 6);
    expect(result.metadata?.collateralizationBasis).toBe("net-of-protocol-owned");
    expect(result.metadata?.collateralizationReconciliation).toMatchObject({
      basis: "net-of-protocol-owned",
      reportedRatio: 0.922477,
      supplyUsd: 327_073_514.82,
      totalReservesUsd: 308_600_110.7,
      protocolOwnedUsd: 88_777_862.88,
    });

    const reconciliation = result.metadata?.collateralizationReconciliation as {
      grossRatio: number;
      netRatio: number;
    };
    expect(reconciliation.grossRatio).toBeCloseTo(0.9435191072, 9);
    expect(reconciliation.netRatio).toBeCloseTo(0.922477, 6);
    // A reviewed-net basis is reproducible, so the canonical ratio is the derived one and the
    // issuer headline is not duplicated under a second key.
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(reconciliation.netRatio, 12);
    expect(result.metadata?.reportedCollateralizationRatio).toBeUndefined();
    expect(result.metadata?.supplyUsd).toBe(327_073_514.82);
    expect(result.metadata?.protocolOwnedUsd).toBe(88_777_862.88);
  });

  it("states the denominator basis on the undercollateralization warning and flags protocol-owned reserves", () => {
    const result = adaptAccountableDashboard({ ...APYX_2026_07_27_PAYLOAD }, { ...APYX_RESERVE_PARAMS });

    expect(result.warnings?.map((warning) => warning.code).sort()).toEqual([
      "protocol-owned-bucket",
      "reserve-undercollateralized",
    ]);
    expect(result.warnings).toContainEqual({
      code: "reserve-undercollateralized",
      message:
        "Accountable dashboard reports 92.25% collateralization net of protocol-owned reserves (gross reserves/supply 94.35%)",
      severity: "warning",
      effect: "degraded",
    });

    // 28.77% of reserves is issuer-held; it must never read as itemized third-party composition.
    const protocolOwned = result.warnings?.find((warning) => warning.code === "protocol-owned-bucket");
    expect(protocolOwned).toMatchObject({ severity: "warning", effect: "degraded" });
    expect(protocolOwned?.message).toContain("not itemized third-party backing");
    expect(result.metadata?.protocolOwnedPctOfReserves).toBeCloseTo(28.77, 2);
  });

  it("keeps the gross basis for feeds that report gross collateralization despite publishing protocol-owned liquidity", () => {
    // Verbatim Neutrl dashboard scalars: pol is published, but collateralization is the gross ratio.
    const result = adaptAccountableDashboard(
      {
        res: "ok",
        data: {
          collateralization: 1.033906,
          ts: "1785450200998",
          reserves: {
            total_reserves: { name: "Total Reserves", value: 60_607_322.11 },
            total_supply: { name: "Total Supply", value: 58_619_735.19 },
            pol: 1_996_688.4539363272,
            type_split: { Stablecoin: 60_607_322.11 },
          },
        },
      },
      { bucket: "type_split", riskMap: { Stablecoin: "very-low" } },
    );

    expect(result.metadata?.collateralizationBasis).toBe("gross");
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(60_607_322.11 / 58_619_735.19, 12);
    expect(result.warnings?.map((warning) => warning.code)).toEqual(["protocol-owned-bucket"]);
    expect(result.metadata?.collateralizationReconciliation).toMatchObject({
      basis: "gross",
      netRatio: expect.any(Number),
    });
  });

  it("fails closed with a degraded warning when the reported ratio matches no derivable denominator", () => {
    const result = adaptAccountableDashboard(
      {
        res: "ok",
        data: {
          collateralization: 0.75,
          ts: "1785192343737",
          reserves: {
            total_reserves: { name: "Total Reserves", value: 1_000 },
            total_supply: { name: "Total Supply", value: 1_000 },
            inventory: 100,
            pol: 50,
            reserves_split: [{ name: "Cash & Equivalents", value: 1_000 }],
          },
        },
      },
      { bucket: "reserves_split", riskMap: { "Cash & Equivalents": "very-low" } },
    );

    expect(result.metadata?.collateralizationBasis).toBe("unreconciled");
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
    expect(result.metadata?.reportedCollateralizationRatio).toBe(0.75);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "collateralization-unreconciled",
      effect: "degraded",
    }));
    expect(result.warnings?.some((warning) => warning.code === "reserve-undercollateralized")).toBe(false);
  });

  it("leaves the basis underived when the feed publishes no total_supply", () => {
    const result = adaptAccountableDashboard(
      {
        res: "ok",
        data: {
          collateralization: 0.9,
          ts: "1785192343737",
          reserves: {
            total_reserves: 1_000,
            reserves_split: [{ name: "Cash & Equivalents", value: 1_000 }],
          },
        },
      },
      { bucket: "reserves_split", riskMap: { "Cash & Equivalents": "very-low" } },
    );

    expect(result.metadata?.collateralizationBasis).toBe("underived");
    expect(result.metadata?.supplyUsd).toBeUndefined();
    // No totals means no reproducible denominator: the issuer headline is published as
    // reported, and no canonical ratio or coverage warning can claim measured coverage.
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
    expect(result.metadata?.reportedCollateralizationRatio).toBe(0.9);
    expect(result.warnings).toBeUndefined();
  });

  it("rejects a malformed total_supply instead of silently dropping the denominator", () => {
    expect(() =>
      adaptAccountableDashboard(
        {
          res: "ok",
          data: {
            collateralization: 1,
            ts: "1785192343737",
            reserves: {
              total_reserves: 1_000,
              total_supply: { name: "Total Supply", value: "n/a" },
              reserves_split: [{ name: "Cash & Equivalents", value: 1_000 }],
            },
          },
        },
        { bucket: "reserves_split", riskMap: { "Cash & Equivalents": "very-low" } },
      ),
    ).toThrow(/total_supply has invalid value/);
  });
});


describe("Apyx reviewed external-reserve guards", () => {
  const params = { bucket: "reserves_split", accountingMode: "apyx-net-external-reserves", riskMap: { STRC: "high" } } as const;
  it.each(["missing", "duplicate", "negative", "scalar-drift", "gross-drift", "ratio-drift", "zero-claims"])("fails closed on %s", (kind) => {
    const p = makeApyxGuardPayload();
    if (kind === "missing") p.data.reserves.reserves_split.pop();
    if (kind === "duplicate") p.data.reserves.reserves_split.push({ name: "Inventory", value: 20 });
    if (kind === "negative") p.data.reserves.inventory = -1;
    if (kind === "scalar-drift") p.data.reserves.inventory = 25;
    if (kind === "gross-drift") p.data.reserves.total_reserves = 105;
    if (kind === "ratio-drift") p.data.collateralization = 0.9;
    if (kind === "zero-claims") p.data.reserves.total_supply = 30;
    expect(() => adaptAccountableDashboard(p, params)).toThrow(/Accountable/);
  });
  it("rejects overflowing nested source values", () => {
    const p = makeApyxGuardPayload();
    const reserves = { ...p.data.reserves, inventory: { first: 1e308, second: 1e308 } };
    expect(() => adaptAccountableDashboard({ ...p, data: { ...p.data, reserves } }, params)).toThrow(/self-claim Inventory/);
  });
  it("preserves genuine net coverage shortfalls", () => {
    const p = makeApyxGuardPayload(); p.data.reserves.total_supply = 110; p.data.collateralization = 70 / 80;
    const r = adaptAccountableDashboard(p, params);
    expect(r.warnings?.map((row) => row.code)).toEqual(["reserve-undercollateralized"]);
    expect(r.metadata?.selfIssuedAccounting).toMatchObject({ netExternalReservesUsd: 70, netRedeemableClaimsUsd: 80 });
  });
});

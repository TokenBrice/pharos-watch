import { describe, expect, it } from "vitest";

import { adaptUnitedPorPayload, type UnitedPorPayload } from "../united-por";
import {
  expectWarningEffect,
  expectWarnings,
} from "./reserve-adapter.test-support";

import { UNITED_POR_PAYLOAD } from "./united-por.test-support";

const SLICE = {
  sourceKey: "united-por:total-reserve",
  name: "Cash, U.S. Treasury bills, and fiat-referenced stablecoins (variable mix)",
  risk: "low" as const,
};


describe("adaptUnitedPorPayload", () => {
  it("computes the honest ratio and verified freshness for a clean, non-ripcord snapshot", () => {
    const result = adaptUnitedPorPayload(UNITED_POR_PAYLOAD, SLICE);

    expect(result.slices).toEqual([{ ...SLICE, pct: 100 }]);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Math.floor(Date.parse("2026-07-09T16:10:01.559Z") / 1000),
      freshnessMode: "verified",
      totalReserveUsd: 1038136298.86,
      supplyUsd: 1030959209.0,
      details: { accountName: "United Stables", ripcord: false, freshnessSource: "same-run-render-clock" },
    });
    const expectedRatio = 1038136298.86 / 1030959209.0;
    expect(result.metadata!.collateralizationRatio).toBeCloseTo(expectedRatio, 9);
    expect(result.metadata!.details).not.toHaveProperty("ripcordDetails");
    expect(result.warnings ?? []).toEqual([]);
  });

  it("flags a ripcord=true snapshot as degraded and folds ripcordDetails into the warning message", () => {
    const payload: UnitedPorPayload = {
      ...UNITED_POR_PAYLOAD,
      ripcord: true,
      ripcordDetails: ["reserve custodian reconciliation lag", "pending manual review"],
    };

    const result = adaptUnitedPorPayload(payload, SLICE);

    // The snapshot is still stored (slices/ratio/freshness compute normally) --
    // ripcord is surfaced as a degraded warning, not a thrown error, so a
    // ripcord run never silently disappears from the reserve detail surface.
    expect(result.slices).toEqual([{ ...SLICE, pct: 100 }]);
    expect(result.metadata).toMatchObject({ freshnessMode: "verified" });
    expect(result.metadata!.details).toMatchObject({
      ripcord: true,
      ripcordDetails: ["reserve custodian reconciliation lag", "pending manual review"],
    });
    expectWarnings(result, ["united-por-ripcord"]);
    expectWarningEffect(result, "united-por-ripcord", "degraded");
  });

  it("treats missing or malformed ripcordDetails as undisclosed provider detail", () => {
    const payload = { ...UNITED_POR_PAYLOAD, ripcord: true, ripcordDetails: null } as unknown as UnitedPorPayload;

    const result = adaptUnitedPorPayload(payload, SLICE);

    expect(result.metadata!.details).toMatchObject({ ripcord: true });
    expect(result.metadata!.details).not.toHaveProperty("ripcordDetails");
    expectWarnings(result, ["united-por-ripcord"]);
    expectWarningEffect(result, "united-por-ripcord", "degraded");
  });

  it("emits a coverage-shortfall degraded warning when reserves cover less than 99.5% of token supply", () => {
    const payload: UnitedPorPayload = {
      ...UNITED_POR_PAYLOAD,
      totalReserve: "900000000",
      totalToken: "1000000000",
    };

    const result = adaptUnitedPorPayload(payload, SLICE);

    expect(result.metadata!.collateralizationRatio).toBeCloseTo(0.9, 9);
    expectWarnings(result, ["united-por-reserve-under-token"]);
    expectWarningEffect(result, "united-por-reserve-under-token", "degraded");
  });

  it("publishes observed zero backing as a degraded loss", () => {
    const result = adaptUnitedPorPayload({ ...UNITED_POR_PAYLOAD, totalReserve: "0" }, SLICE);
    expect(result.metadata).toMatchObject({ totalReserveUsd: 0, collateralizationRatio: 0 });
    expectWarningEffect(result, "united-por-reserve-under-token", "degraded");
  });

  it.each([undefined, null, "-1", "", "Infinity"])("rejects unavailable or invalid reserves (%s)", (totalReserve) => {
    expect(() => adaptUnitedPorPayload({ ...UNITED_POR_PAYLOAD, totalReserve } as UnitedPorPayload, SLICE))
      .toThrow("invalid totalReserve");
  });

  it("preserves zero liabilities without publishing an undefined ratio", () => {
    const result = adaptUnitedPorPayload({ ...UNITED_POR_PAYLOAD, totalToken: "0" }, SLICE);
    expect(result.metadata).toMatchObject({ supplyUsd: 0 });
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
    expectWarningEffect(result, "united-por-zero-supply", "degraded");
  });

  it("throws on a malformed payload with an invalid totalReserve", () => {
    const malformed: UnitedPorPayload = { ...UNITED_POR_PAYLOAD, totalReserve: "not-a-number" };

    expect(() => adaptUnitedPorPayload(malformed, SLICE)).toThrow("invalid totalReserve");
  });

  it("throws on a malformed payload with an invalid totalToken", () => {
    const malformed: UnitedPorPayload = { ...UNITED_POR_PAYLOAD, totalToken: "-1" };

    expect(() => adaptUnitedPorPayload(malformed, SLICE)).toThrow("invalid totalToken");
  });

  it("throws on a malformed payload with an unreadable updatedAt", () => {
    const malformed: UnitedPorPayload = { ...UNITED_POR_PAYLOAD, updatedAt: "" };

    expect(() => adaptUnitedPorPayload(malformed, SLICE)).toThrow("unreadable updatedAt");
  });

  it("throws when the ripcord alarm field is missing", () => {
    const payload = { ...UNITED_POR_PAYLOAD } as Partial<UnitedPorPayload>;
    delete payload.ripcord;

    expect(() => adaptUnitedPorPayload(payload as UnitedPorPayload, SLICE))
      .toThrow("missing or non-boolean ripcord alarm");
  });

  it("throws when the ripcord alarm is not a boolean", () => {
    const payload = { ...UNITED_POR_PAYLOAD, ripcord: "false" } as unknown as UnitedPorPayload;

    expect(() => adaptUnitedPorPayload(payload, SLICE))
      .toThrow("missing or non-boolean ripcord alarm");
  });

  it("throws when the attestor account is not the reviewed United Stables account", () => {
    const payload = { ...UNITED_POR_PAYLOAD, accountName: "Unreviewed Attestor" };

    expect(() => adaptUnitedPorPayload(payload, SLICE))
      .toThrow("unexpected accountName (Unreviewed Attestor); expected United Stables");
  });

  it("throws when the accountName field is missing", () => {
    const payload = { ...UNITED_POR_PAYLOAD } as Partial<UnitedPorPayload>;
    delete payload.accountName;

    expect(() => adaptUnitedPorPayload(payload as UnitedPorPayload, SLICE))
      .toThrow("unexpected accountName (missing); expected United Stables");
  });

  it("names the issuer serve clock as a render clock rather than a dated disclosure", () => {
    const stale: UnitedPorPayload = { ...UNITED_POR_PAYLOAD, updatedAt: "2026-06-01T08:00:00.000Z" };

    const result = adaptUnitedPorPayload(stale, SLICE);

    // `updatedAt` tracks the request instant, so the adapter reports it
    // honestly as a same-run render clock; an older serve time does not become
    // evidence that the reserve state was observed then.
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Math.floor(Date.parse("2026-06-01T08:00:00.000Z") / 1000),
      freshnessMode: "verified",
      details: { freshnessSource: "same-run-render-clock" },
    });
  });
});

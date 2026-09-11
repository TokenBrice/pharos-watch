import { describe, expect, it } from "vitest";

import { adaptUnitedPorPayload, type UnitedPorPayload } from "../united-por";
import {
  expectWarningEffect,
  expectWarnings,
  runAdapter,
} from "./reserve-adapter.test-support";

const UNITED_POR_ENDPOINT = "https://u.tech/u-client-api/v1/public/u/por";

const SLICE = {
  sourceKey: "united-por:total-reserve",
  name: "Cash, U.S. Treasury bills, and fiat-referenced stablecoins (variable mix)",
  risk: "low" as const,
};

// Captured 2026-07-09 from GET https://u.tech/u-client-api/v1/public/u/por
const UNITED_POR_PAYLOAD: UnitedPorPayload = {
  accountName: "United Stables",
  totalReserve: "1038136298.86",
  totalToken: "1030959209.00",
  updatedAt: "2026-07-09T16:10:01.559Z",
  ripcord: false,
  ripcordDetails: [],
};

const CAPTURE_NOW_SEC = Math.floor(Date.parse(UNITED_POR_PAYLOAD.updatedAt) / 1000) + 3_600;


describe("adaptUnitedPorPayload", () => {
  it("computes the honest ratio and verified freshness for a clean, non-ripcord snapshot", () => {
    const result = adaptUnitedPorPayload(UNITED_POR_PAYLOAD, SLICE);

    expect(result.slices).toEqual([{ ...SLICE, pct: 100 }]);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Math.floor(Date.parse("2026-07-09T16:10:01.559Z") / 1000),
      freshnessMode: "verified",
      totalReserveUsd: 1038136298.86,
      supplyUsd: 1030959209.0,
      details: { accountName: "United Stables", ripcord: false },
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

  it("still degrades a ripcord=true snapshot with no disclosed details", () => {
    const payload: UnitedPorPayload = { ...UNITED_POR_PAYLOAD, ripcord: true, ripcordDetails: [] };

    const result = adaptUnitedPorPayload(payload, SLICE);

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

  it("throws on a malformed payload with an invalid totalReserve", () => {
    const malformed: UnitedPorPayload = { ...UNITED_POR_PAYLOAD, totalReserve: "not-a-number" };

    expect(() => adaptUnitedPorPayload(malformed, SLICE)).toThrow("invalid totalReserve");
  });

  it("throws on a malformed payload with an invalid totalToken", () => {
    const malformed: UnitedPorPayload = { ...UNITED_POR_PAYLOAD, totalToken: "0" };

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

  it("still parses a stale updatedAt into a verified but old sourceTimestamp", () => {
    const stale: UnitedPorPayload = { ...UNITED_POR_PAYLOAD, updatedAt: "2026-06-01T08:00:00.000Z" };

    const result = adaptUnitedPorPayload(stale, SLICE);

    // The adapter reports the real disclosure timestamp honestly; the cron's
    // validation.maxSourceAgeSec policy (not the adapter) is what later marks
    // a sync built from this snapshot as degraded once stale.
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Math.floor(Date.parse("2026-06-01T08:00:00.000Z") / 1000),
      freshnessMode: "verified",
    });
  });
});

describe("fetchUnitedPorReserves", () => {
  it("fetches the catalog PoR endpoint and adapts the payload", async () => {
    const { result } = await runAdapter("united-por", "u-united-stables", {
      network: { json: { [UNITED_POR_ENDPOINT]: UNITED_POR_PAYLOAD } },
      nowSec: CAPTURE_NOW_SEC,
    });

    expect(result.slices).toEqual([{ ...SLICE, pct: 100 }]);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Math.floor(Date.parse(UNITED_POR_PAYLOAD.updatedAt) / 1000),
      freshnessMode: "verified",
    });
  });

  it("propagates an error when the catalog PoR endpoint fails", async () => {
    await expect(runAdapter("united-por", "u-united-stables", {
      network: { json: { [UNITED_POR_ENDPOINT]: { status: 503, body: "upstream down" } } },
      nowSec: CAPTURE_NOW_SEC,
    })).rejects.toThrow("503");
  });
});

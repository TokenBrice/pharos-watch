import { describe, expect, it, vi, beforeEach } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonWithRetry: vi.fn(),
  };
});

import { adaptUnitedPorPayload, fetchUnitedPorReserves, type UnitedPorPayload } from "../united-por";
import { fetchJsonWithRetry } from "../helpers";
import { mockedReserveHelper, TEST_SIGNAL } from "./reserve-adapter.test-support";

const SLICE = {
  name: "Cash, U.S. Treasury bills, and fiat-referenced stablecoins (variable mix)",
  risk: "low" as const,
};

function makeCoin(): StablecoinMeta {
  return { id: "u-united-stables", name: "United Stables", ticker: "U" } as unknown as StablecoinMeta;
}

function makeConfig(): LiveReservesConfig {
  return {
    adapter: "united-por",
    version: 1,
    semantics: "single-asset",
    inputs: {
      primary: { kind: "http-json", url: "https://u.tech/u-client-api/v1/public/u/por" },
    },
    params: { slice: SLICE },
  } as unknown as LiveReservesConfig;
}

// Captured 2026-07-09 from GET https://u.tech/u-client-api/v1/public/u/por
const UNITED_POR_PAYLOAD: UnitedPorPayload = {
  accountName: "United Stables",
  totalReserve: "1038136298.86",
  totalToken: "1030959209.00",
  updatedAt: "2026-07-09T16:10:01.559Z",
  ripcord: false,
  ripcordDetails: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

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
    expect(result.warnings).toEqual([
      {
        code: "united-por-ripcord",
        message:
          "United Stables PoR reports a ripcord data-quality alarm: reserve custodian reconciliation lag; pending manual review",
        severity: "warning",
        effect: "degraded",
      },
    ]);
  });

  it("still degrades a ripcord=true snapshot with no disclosed details", () => {
    const payload: UnitedPorPayload = { ...UNITED_POR_PAYLOAD, ripcord: true, ripcordDetails: [] };

    const result = adaptUnitedPorPayload(payload, SLICE);

    expect(result.warnings).toEqual([
      {
        code: "united-por-ripcord",
        message: "United Stables PoR reports a ripcord data-quality alarm: no further detail disclosed",
        severity: "warning",
        effect: "degraded",
      },
    ]);
  });

  it("treats missing or malformed ripcordDetails as undisclosed provider detail", () => {
    const payload = { ...UNITED_POR_PAYLOAD, ripcord: true, ripcordDetails: null } as unknown as UnitedPorPayload;

    const result = adaptUnitedPorPayload(payload, SLICE);

    expect(result.metadata!.details).toMatchObject({ ripcord: true });
    expect(result.metadata!.details).not.toHaveProperty("ripcordDetails");
    expect(result.warnings).toEqual([
      {
        code: "united-por-ripcord",
        message: "United Stables PoR reports a ripcord data-quality alarm: no further detail disclosed",
        severity: "warning",
        effect: "degraded",
      },
    ]);
  });

  it("emits a coverage-shortfall degraded warning when reserves cover less than 99.5% of token supply", () => {
    const payload: UnitedPorPayload = {
      ...UNITED_POR_PAYLOAD,
      totalReserve: "900000000",
      totalToken: "1000000000",
    };

    const result = adaptUnitedPorPayload(payload, SLICE);

    expect(result.metadata!.collateralizationRatio).toBeCloseTo(0.9, 9);
    expect(result.warnings).toEqual([
      {
        code: "united-por-reserve-under-token",
        message: "United PoR reserves cover 90.00% of outstanding U token supply",
        severity: "warning",
        effect: "degraded",
      },
    ]);
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
  it("fetches the configured PoR endpoint and adapts the payload", async () => {
    mockedReserveHelper(fetchJsonWithRetry).mockResolvedValue(UNITED_POR_PAYLOAD);

    const result = await fetchUnitedPorReserves(makeCoin(), makeConfig(), TEST_SIGNAL);

    expect(fetchJsonWithRetry).toHaveBeenCalledWith(
      "https://u.tech/u-client-api/v1/public/u/por",
      TEST_SIGNAL,
      12_000,
      undefined,
    );
    expect(result.slices).toEqual([{ ...SLICE, pct: 100 }]);
  });

  it("propagates an error when the PoR endpoint fetch fails", async () => {
    mockedReserveHelper(fetchJsonWithRetry).mockRejectedValue(new Error("HTTP 503 for https://u.tech/u-client-api/v1/public/u/por"));

    await expect(fetchUnitedPorReserves(makeCoin(), makeConfig(), TEST_SIGNAL)).rejects.toThrow("HTTP 503");
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import usdt from "@shared/data/stablecoins/coins/usdt-tether.json";
import {
  adaptTetherTransparency,
  type TetherTransparencyParams,
  type TetherTransparencyResponse,
} from "../tether-transparency";
import { expectValidAdapterOutput, runAdapter } from "./reserve-adapter.test-support";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
// Captured 2026-07-09 from GET https://app.tether.to/transparency.json
const TETHER_TRANSPARENCY_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "tether-transparency.json"), "utf8"),
) as TetherTransparencyResponse;
const TETHER_ENDPOINT = "https://app.tether.to/transparency.json";
// One hour after the fixture's own publication instant, so freshness policy is
// exercised against the capture rather than against wall-clock drift.
const FIXTURE_NOW_SEC = 1_783_555_140 + 3_600;

const USDT_PARAMS = parseLiveReserveAdapterParams(
  "tether-transparency", usdt.liveReservesConfig.params,
) as Extract<TetherTransparencyParams, { currencyIso: "usdt" }>;
// BDO report page 4 (PDF page 9), 2026-06-30, in report row order.
const REPORT_DOLLARS = [
  114960963604, 18625552412, 6993428950, 22374689, 40307440,
  8711171, 18838357171, 5801630681, 3761438892, 5244911675, 13453749726,
];

const XAUT_PARAMS: TetherTransparencyParams = {
  currencyIso: "xaut",
  slices: [{ name: "Physical gold bars (LBMA Good Delivery, Swiss vaults)", pct: 100, risk: "very-low" }],
};

function withChains(blockChains: unknown): TetherTransparencyResponse {
  return {
    data_formatted: TETHER_TRANSPARENCY_FIXTURE.data_formatted!.map((entry) => ({ ...entry, blockChains })),
  };
}

describe("adaptTetherTransparency", () => {
  it("conserves all eleven signed-report integer rows without percentage rounding", () => {
    const packet = USDT_PARAMS.reviewedComposition;
    expect(packet.rows.map((row) => row.dollars)).toEqual(REPORT_DOLLARS);
    expect(packet.rows.reduce((sum, row) => sum + row.dollars, 0)).toBe(187751426411);
    const result = adaptTetherTransparency(TETHER_TRANSPARENCY_FIXTURE, USDT_PARAMS);
    expect(result.slices).toHaveLength(11);
    for (const slice of result.slices) {
      const row = packet.rows.find((row) => row.sourceKey === slice.sourceKey)!;
      expect(slice.pct).toBe(row.dollars * 100 / 187751426411);
      expect(slice).not.toHaveProperty("dollars");
    }
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBe(100);
    expect(result.slices.reduce((sum, slice) => sum + slice.pct / 100, 0)).toBe(1);
    expect(result.metadata?.diag?.rawSumDeviation).toBe(0);
    const reordered = adaptTetherTransparency(TETHER_TRANSPARENCY_FIXTURE, {
      ...USDT_PARAMS, reviewedComposition: { ...packet, rows: [...packet.rows].reverse() },
    });
    expect(reordered.slices).toEqual(result.slices);
  });

  it("keeps the signed composition denominator and clock separate from live totals", () => {
    const result = adaptTetherTransparency(TETHER_TRANSPARENCY_FIXTURE, USDT_PARAMS);
    expect(result.metadata?.details).toMatchObject({
      compositionSource: "reviewed-report-dollars",
      compositionAsOf: "2026-06-30",
      compositionSourceUrl: USDT_PARAMS.reviewedComposition.sourceUrl,
      compositionTotalAssetsUsd: 187751426411,
      compositionRows: USDT_PARAMS.reviewedComposition.rows.map(({ sourceKey, dollars }) => ({ sourceKey, dollars })),
    });
    expect(result.metadata?.sourceTimestamp).toBe(1783555140);
    expect(result.metadata?.totalAssetsUsd).toBe(189761994736.8062);
    const changedTotals = {
      data_formatted: TETHER_TRANSPARENCY_FIXTURE.data_formatted!.map((entry) => ({
        ...entry, total_assets: 200_000_000_000, id: 1783558740,
      })),
    };
    const changed = adaptTetherTransparency(changedTotals, USDT_PARAMS);
    expect(changed.slices).toEqual(result.slices);
    expect(changed.metadata?.sourceTimestamp).toBe(1783558740);
    expect(changed.metadata?.details?.compositionAsOf).toBe("2026-06-30");
    const xaut = adaptTetherTransparency(TETHER_TRANSPARENCY_FIXTURE, XAUT_PARAMS);
    expect(xaut.metadata?.details?.compositionAsOf).toBeUndefined();
    expect(xaut.metadata?.sourceTimestamp).toBeDefined();
  });

  it.each([
    ["missing category", (rows: typeof USDT_PARAMS.reviewedComposition.rows) => rows.slice(1)],
    ["duplicate identity", (rows: typeof USDT_PARAMS.reviewedComposition.rows) =>
      rows.map((row, index) => index === 1 ? { ...row, sourceKey: rows[0].sourceKey } : row)],
    ["missing dollars", (rows: typeof USDT_PARAMS.reviewedComposition.rows) =>
      rows.map(({ dollars, ...row }, index) => index === 0 ? row : { ...row, dollars })],
    ["genuine partial book", (rows: typeof USDT_PARAMS.reviewedComposition.rows) =>
      rows.map((row, index) => index === 0 ? { ...row, dollars: row.dollars - 1_000_000 } : row)],
    ["one-dollar mismatch", (rows: typeof USDT_PARAMS.reviewedComposition.rows) =>
      rows.map((row, index) => index === 0 ? { ...row, dollars: row.dollars - 1 } : row)],
    ["fractional dollars", (rows: typeof USDT_PARAMS.reviewedComposition.rows) =>
      rows.map((row, index) => index === 0 ? { ...row, dollars: row.dollars - 0.5 } : row)],
  ])("rejects %s instead of normalizing a partial book", (_label, changeRows) => {
    const params = {
      ...USDT_PARAMS,
      reviewedComposition: { ...USDT_PARAMS.reviewedComposition, rows: changeRows(USDT_PARAMS.reviewedComposition.rows) },
    };
    expect(() => parseLiveReserveAdapterParams("tether-transparency", params)).toThrow();
    expect(() => adaptTetherTransparency(TETHER_TRANSPARENCY_FIXTURE, params)).toThrow();
  });

  it.each([
    { totalAssetsUsd: 187751426410 },
    { totalAssetsUsd: 189761994736.8062 },
    { asOf: "2026-07-01" },
    { asOf: "2026-02-30" },
    { sourceUrl: "https://tether.to/en/transparency" },
  ])("rejects signed-report denominator, source or date mismatch %j", (change) => {
    const params = { ...USDT_PARAMS, reviewedComposition: { ...USDT_PARAMS.reviewedComposition, ...change } };
    expect(() => adaptTetherTransparency(TETHER_TRANSPARENCY_FIXTURE, params)).toThrow();
  });

  it("does not admit the old rounded USDT packet or reinterpret it as full dollars", () => {
    expect(() => adaptTetherTransparency(TETHER_TRANSPARENCY_FIXTURE, {
      currencyIso: "usdt", compositionAsOf: "2026-06-30",
      slices: [{ name: "Partial Treasury book", pct: 99, risk: "very-low" }],
    })).toThrow();
  });

  it.each(["2026-02-30", "2026-6-30", "not-a-date"])("rejects unsupported legacy composition date %s", (compositionAsOf) => {
    expect(() => parseLiveReserveAdapterParams("tether-transparency", {
      ...XAUT_PARAMS, compositionAsOf,
    })).toThrow();
  });

  it("selects the usdt entry, computes the honest ratio, and persists USD-denominated totals", () => {
    const result = adaptTetherTransparency(TETHER_TRANSPARENCY_FIXTURE, USDT_PARAMS);

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1783555140,
      totalAssetsUsd: 189761994736.8062,
      totalLiabilitiesUsd: 184211219230.290086,
      shareholderEquityUsd: 5466941751.78272135,
    });
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.030, 3);
  });

  it("emits an info warning for the nonzero quarantined balance on Solana", () => {
    const result = adaptTetherTransparency(TETHER_TRANSPARENCY_FIXTURE, USDT_PARAMS);

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "quarantined-balance",
        severity: "info",
        effect: "info",
        message: expect.stringContaining("Solana"),
      }),
    ]);
    const details = result.metadata?.details as { chains: Array<{ name: string; quarantined: number }> };
    const solana = details.chains.find((chain) => chain.name === "Solana");
    expect(solana?.quarantined).toBeCloseTo(3698541.306464, 3);
  });

  it("selects the xaut entry, omits *Usd metadata fields, and still computes a dimensionless ratio", () => {
    const result = adaptTetherTransparency(TETHER_TRANSPARENCY_FIXTURE, XAUT_PARAMS);

    expect(result.slices).toEqual([
      { name: "Physical gold bars (LBMA Good Delivery, Swiss vaults)", pct: 100, risk: "very-low" },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1, 6);
    expect(result.metadata).not.toHaveProperty("totalAssetsUsd");
    expect(result.metadata).not.toHaveProperty("totalLiabilitiesUsd");
    expect(result.metadata).not.toHaveProperty("shareholderEquityUsd");
  });

  describe.each([USDT_PARAMS, XAUT_PARAMS])("$currencyIso chain availability", (params) => {
    it.each([
      [undefined, "missing"],
      [null, "missing"],
      ["broken", "malformed"],
      ["", "malformed"],
      [false, "malformed"],
      [Number.NaN, "malformed"],
      [Number.POSITIVE_INFINITY, "malformed"],
      [-1, "negative"],
    ])("preserves unavailable components for %s", (value, reason) => {
      for (const field of ["totalAuthorized", "notIssued", "quarantined"] as const) {
        const row = { name: "Ethereum", totalAuthorized: 100, notIssued: 10, quarantined: 0, [field]: value };
        const result = adaptTetherTransparency(withChains([row]), params);
        expect(result.metadata?.details).toMatchObject({
          chains: [{
            [field]: null,
            [`${field}Reason`]: reason,
            issued: field === "quarantined" ? 90 : null,
            issuedReason: field === "totalAuthorized"
              ? "authorization-unavailable"
              : field === "notIssued" ? "not-issued-unavailable" : null,
          }],
        });
        const clean = adaptTetherTransparency(TETHER_TRANSPARENCY_FIXTURE, params);
        expect(result.slices).toEqual(clean.slices);
        expect(result.metadata?.collateralizationRatio).toBe(clean.metadata?.collateralizationRatio);
        expect(result.metadata?.sourceTimestamp).toBe(clean.metadata?.sourceTimestamp);
        expect(result.metadata?.totalAssetsUsd).toBe(clean.metadata?.totalAssetsUsd);
        expect(result.metadata?.totalLiabilitiesUsd).toBe(clean.metadata?.totalLiabilitiesUsd);
      }
    });

    it("retains explicit zero and rejects impossible net issuance without clamping", () => {
      const result = adaptTetherTransparency(withChains([
        { name: "Zero", totalAuthorized: 0, notIssued: 0, quarantined: 0 },
        { name: "Impossible", totalAuthorized: 100, notIssued: 150, quarantined: 0 },
      ]), params);
      expect(result.metadata?.details).toMatchObject({
        chains: [
          { totalAuthorized: 0, notIssued: 0, issued: 0, issuedReason: null, quarantined: 0, quarantinedReason: null },
          { totalAuthorized: 100, notIssued: 150, issued: null, issuedReason: "not-issued-exceeds-authorized" },
        ],
        chainsReason: null,
      });
    });

    it.each([
      [undefined, "missing"],
      [null, "missing"],
      [{}, "malformed"],
    ])("does not publish a known empty census for %s", (value, reason) => {
      const result = adaptTetherTransparency(withChains(value), params);
      expect(result.metadata?.details).toMatchObject({ chains: null, chainsReason: reason });
    });

    it("distinguishes an observed empty census and retains unreadable rows", () => {
      expect(adaptTetherTransparency(withChains([]), params).metadata?.details).toMatchObject({
        chains: [], chainsReason: null,
      });
      expect(adaptTetherTransparency(withChains([null]), params).metadata?.details).toMatchObject({
        chains: [{ name: null, nameReason: "missing", issued: null, quarantined: null }],
      });
    });

    it("reports observed quarantine even when another chain's quarantine is unavailable", () => {
      const result = adaptTetherTransparency(withChains([
        { name: "Unknown", totalAuthorized: 100, notIssued: 10 },
        { name: "Observed", totalAuthorized: 100, notIssued: 10, quarantined: 5 },
      ]), params);
      expect(result.metadata?.details).toMatchObject({
        chains: [{ quarantined: null, quarantinedReason: "missing" }, { quarantined: 5, quarantinedReason: null }],
      });
      expect(result.warnings).toEqual([expect.objectContaining({ code: "quarantined-balance", effect: "info" })]);
    });
  });

  it("throws when the requested currencyIso has no matching data_formatted entry", () => {
    const usdtOnly: TetherTransparencyResponse = {
      data_formatted: TETHER_TRANSPARENCY_FIXTURE.data_formatted!.filter((entry) => entry.iso === "usdt"),
    };

    expect(() => adaptTetherTransparency(usdtOnly, XAUT_PARAMS)).toThrow(
      /no data_formatted entry for currencyIso "xaut"/,
    );
  });

  it("throws when data_formatted is missing", () => {
    expect(() => adaptTetherTransparency({}, USDT_PARAMS)).toThrow("missing data_formatted entries");
  });

  it("throws when total_assets/total_liabilities are malformed", () => {
    const malformed: TetherTransparencyResponse = {
      data_formatted: TETHER_TRANSPARENCY_FIXTURE.data_formatted!.map((entry) =>
        entry.iso === "usdt" ? { ...entry, total_assets: "not-a-number" } : entry,
      ),
    };

    expect(() => adaptTetherTransparency(malformed, USDT_PARAMS)).toThrow(
      /invalid total_assets\/total_liabilities/,
    );
  });

  it("throws when the id timestamp is unreadable", () => {
    const noId: TetherTransparencyResponse = {
      data_formatted: TETHER_TRANSPARENCY_FIXTURE.data_formatted!.map((entry) =>
        entry.iso === "usdt" ? { ...entry, id: undefined } : entry,
      ),
    };

    expect(() => adaptTetherTransparency(noId, USDT_PARAMS)).toThrow("unreadable id timestamp");
  });

  it("is degraded-but-valid under validateAdapterOutput when the id timestamp is stale", () => {
    const staleSeconds = Math.floor((Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000);
    const stale: TetherTransparencyResponse = {
      data_formatted: TETHER_TRANSPARENCY_FIXTURE.data_formatted!.map((entry) =>
        entry.iso === "usdt" ? { ...entry, id: staleSeconds } : entry,
      ),
    };

    const result = adaptTetherTransparency(stale, USDT_PARAMS);
    const report = expectValidAdapterOutput("tether-transparency", result);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "stale-source-data", effect: "degraded" })]),
    );
  });
});

describe("fetchTetherTransparencyReserves", () => {
  it("fetches the coin's configured transparency endpoint and publishes its reserve totals", async () => {
    const { result, network } = await runAdapter("tether-transparency", "usdt-tether", {
      network: { json: { [TETHER_ENDPOINT]: TETHER_TRANSPARENCY_FIXTURE } },
      nowSec: FIXTURE_NOW_SEC,
    });

    expect(network.requests.map((request) => request.url)).toEqual([TETHER_ENDPOINT]);
    expect(result.metadata?.totalAssetsUsd).toBe(189761994736.8062);
    expect(result.metadata?.freshnessMode).toBe("verified");
  });

  it("selects the configured currency per coin on the shared endpoint", async () => {
    const { result } = await runAdapter("tether-transparency", "xaut-tether", {
      network: { json: { [TETHER_ENDPOINT]: TETHER_TRANSPARENCY_FIXTURE } },
      nowSec: FIXTURE_NOW_SEC,
    });

    expect(result.slices.every((slice) => /gold/i.test(slice.name))).toBe(true);
    expect(result.metadata).not.toHaveProperty("totalAssetsUsd");
  });

  it("fails the attempt when the endpoint errors instead of publishing a partial mix", async () => {
    await expect(
      runAdapter("tether-transparency", "usdt-tether", {
        network: { json: { [TETHER_ENDPOINT]: { status: 500, body: "upstream down" } } },
        nowSec: FIXTURE_NOW_SEC,
      }),
    ).rejects.toThrow(/500/);
  });
});

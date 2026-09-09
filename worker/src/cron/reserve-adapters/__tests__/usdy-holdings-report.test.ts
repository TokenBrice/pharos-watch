import { describe, expect, it, vi, beforeEach } from "vitest";
import source from "@shared/data/live-reserves/holdings-reports/usdy.json";
import { HoldingsReportManifestSchema } from "@shared/lib/holdings-report";
import { withoutSuspendedLiveReserves } from "@shared/lib/stablecoins/registry";
import coinSource from "@shared/data/stablecoins/coins/usdy-ondo-finance.json";
import reservesSource from "@shared/data/stablecoins/domains/reserves/usdy-ondo-finance.json";
import { adaptUsdyHoldings, fetchUsdyHoldingsReserves } from "../usdy-holdings-report";
import { fetchBinaryResponseWithRetry, fetchTextResponseWithRetry } from "../request";
import { loadStablecoinsCache } from "../../../lib/stablecoins-cache";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../request", () => ({ fetchBinaryResponseWithRetry: vi.fn(), fetchTextResponseWithRetry: vi.fn() }));
vi.mock("../../../lib/stablecoins-cache", () => ({ loadStablecoinsCache: vi.fn(), hasUsableStablecoinsPayload: (value: unknown) => value != null }));

const report = HoldingsReportManifestSchema.parse(source);
const coin = { id: "usdy-ondo-finance" } as StablecoinMeta;
const config = { adapter: "usdy-holdings-report", version: 1, semantics: "collateral-mix" } as LiveReservesConfig;
const signal = new AbortController().signal;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchTextResponseWithRetry).mockResolvedValue({ body: "<html>JS-rendered Dropbox folder</html>", finalUrl: report.listingUrl, headers: new Headers() });
});

describe("USDY report reconciliation and scope", () => {
  it("keeps the undiscoverable daily series out of runtime live evidence", () => {
    const usdy = withoutSuspendedLiveReserves({ ...coinSource, ...reservesSource } as StablecoinMeta);
    expect(usdy?.reserves?.find((slice) => slice.sourceKey === "usdy-holdings-report:excluded-issuance"))
      .toMatchObject({ pct: 2.62, risk: "high" });
    expect(usdy?.liveReservesConfig).toBeUndefined();
  });

  it("reconciles the real September 3 report and rejects an omitted holding", () => {
    expect(report.holdings.filter((row) => row.cusip)).toHaveLength(15);
    expect(report.reportedAssetTotal).toBe("2147340936.79");
    expect(() => HoldingsReportManifestSchema.parse({ ...source, holdings: source.holdings.slice(1) })).toThrow(/reconcile/);
    expect(() => HoldingsReportManifestSchema.parse({ ...source, holdings: source.holdings.map((row, i) => i === 1 ? { ...row, sourceId: source.holdings[0].sourceId } : row) })).toThrow(/Duplicate/);
  });

  it("publishes CUSIP holdings, cash categories, and an undiluted excluded scope", () => {
    const liabilities = Number(report.reportedLiabilityTotal);
    const result = adaptUsdyHoldings(report, liabilities / 0.97);
    expect(result.metadata?.unknownExposurePct).toBeCloseTo(3, 10);
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 10);
    expect(result.slices.find((slice) => slice.sourceKey === "usdy-holdings-report:first-citizens:mma")?.pct).toBeCloseTo(461417.76 / 2147340936.79 * 97, 10);
    expect(result.slices.find((slice) => slice.sourceKey === "usdy-holdings-report:stonex:cash")?.pct).toBeGreaterThan(0);
    expect(result.slices.find((slice) => slice.sourceKey === "usdy-holdings-report:excluded-issuance")).toMatchObject({ pct: expect.closeTo(3, 8), risk: "high" });
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(2147340936.79 / liabilities, 10);
    expect(result.metadata?.sourceTimestamp).toBe(Date.parse("2026-09-03T23:59:59-04:00") / 1000);
  });

  it("publishes observed shortfall as degraded rather than throwing", () => {
    const result = adaptUsdyHoldings({ ...report, reportedLiabilityTotal: "3000000000.00" }, 3100000000);
    expect(result.metadata?.collateralizationRatio).toBeLessThan(1);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "reserve-undercollateralized" })]));
  });

  it("fails closed when the listing exposes a newer report", async () => {
    vi.mocked(fetchTextResponseWithRetry).mockResolvedValue({ body: "Ondo USDY LLC_ATCAttest_260904.pdf", finalUrl: report.listingUrl, headers: new Headers() });
    await expect(fetchUsdyHoldingsReserves(coin, config, signal)).rejects.toThrow(/newer unreviewed report/);
    expect(fetchBinaryResponseWithRetry).not.toHaveBeenCalled();
  });

  it("rejects hash drift even when the exact byte length is preserved", async () => {
    vi.mocked(fetchBinaryResponseWithRetry).mockResolvedValue({ body: new Uint8Array(report.reportByteLength), finalUrl: report.reportUrl, headers: new Headers() });
    await expect(fetchUsdyHoldingsReserves(coin, config, signal)).rejects.toThrow(/SHA-256 drift/);
    expect(loadStablecoinsCache).not.toHaveBeenCalled();
  });

  it("rejects size drift and foreign-host redirects", async () => {
    vi.mocked(fetchBinaryResponseWithRetry).mockResolvedValue({ body: new Uint8Array(1), finalUrl: report.reportUrl, headers: new Headers() });
    await expect(fetchUsdyHoldingsReserves(coin, config, signal)).rejects.toThrow(/byte length drift/);
    vi.mocked(fetchBinaryResponseWithRetry).mockResolvedValue({ body: new Uint8Array(report.reportByteLength), finalUrl: "https://evil.example/report.pdf", headers: new Headers() });
    await expect(fetchUsdyHoldingsReserves(coin, config, signal)).rejects.toThrow(/unapproved report host/);
  });
});

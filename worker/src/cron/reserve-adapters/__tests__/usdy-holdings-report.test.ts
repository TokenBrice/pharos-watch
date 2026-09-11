import { describe, expect, it } from "vitest";
import source from "@shared/data/live-reserves/holdings-reports/usdy.json";
import { HoldingsReportManifestSchema } from "@shared/lib/holdings-report";
import { StablecoinMetaSourceAssetSchema } from "@shared/lib/stablecoins/schema";
import { withoutSuspendedLiveReserves } from "@shared/lib/stablecoins/registry";
import coinSource from "@shared/data/stablecoins/coins/usdy-ondo-finance.json";
import reservesSource from "@shared/data/stablecoins/domains/reserves/usdy-ondo-finance.json";
import { adaptUsdyHoldings } from "../usdy-holdings-report";
import { runAdapter, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const report = HoldingsReportManifestSchema.parse(source);

function usdyNetwork(listingBody = "<html>JS-rendered Dropbox folder</html>", reportBody?: string, reportUrl = report.reportUrl): AdapterNetworkSpec {
  return {
    html: {
      [report.listingUrl]: listingBody,
      ...(reportBody === undefined ? {} : { [report.reportUrl]: { body: reportBody, url: reportUrl } }),
    },
  };
}

describe("USDY report reconciliation and scope", () => {
  it("keeps the undiscoverable daily series out of runtime live evidence", () => {
    const usdy = withoutSuspendedLiveReserves(StablecoinMetaSourceAssetSchema.parse({ ...coinSource, ...reservesSource }));
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
    await expect(runAdapter("usdy-holdings-report", "usdy-ondo-finance", {
      network: usdyNetwork("Ondo USDY LLC_ATCAttest_260904.pdf"),
      nowSec: Date.parse(report.reportAsOf) / 1000 + 3_600,
      validate: false,
    })).rejects.toThrow(/newer unreviewed report/);
  });

  it("rejects hash drift even when the exact byte length is preserved", async () => {
    await expect(runAdapter("usdy-holdings-report", "usdy-ondo-finance", {
      network: usdyNetwork(undefined, "x".repeat(report.reportByteLength)),
      nowSec: Date.parse(report.reportAsOf) / 1000 + 3_600,
      validate: false,
    })).rejects.toThrow(/SHA-256 drift/);
  });

  it("rejects size drift and foreign-host redirects", async () => {
    await expect(runAdapter("usdy-holdings-report", "usdy-ondo-finance", {
      network: usdyNetwork(undefined, "x"),
      nowSec: Date.parse(report.reportAsOf) / 1000 + 3_600,
      validate: false,
    })).rejects.toThrow(/byte length drift/);
    await expect(runAdapter("usdy-holdings-report", "usdy-ondo-finance", {
      network: usdyNetwork(undefined, "x".repeat(report.reportByteLength), "https://evil.example/report.pdf"),
      nowSec: Date.parse(report.reportAsOf) / 1000 + 3_600,
      validate: false,
    })).rejects.toThrow(/unapproved report host/);
  });
});

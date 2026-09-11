import manifestSource from "@shared/data/live-reserves/holdings-reports/usdy.json";
import { HoldingsReportManifestSchema, assertHoldingsReportHost, assertNoNewerHoldingsReport, type HoldingsReportManifest } from "@shared/lib/holdings-report";
import { getCirculatingRaw } from "@shared/lib/supply";
import type { ReserveSlice } from "@shared/types/core";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { fetchBinaryResponseWithRetry, fetchTextResponseWithRetry } from "./request";
import { reserveDegradedWarning, reserveInfoWarning } from "./warnings";
import type { AdapterFn, AdapterResult } from "./types";

const manifest = HoldingsReportManifestSchema.parse(manifestSource);

export function adaptUsdyHoldings(report: HoldingsReportManifest, circulatingUsd: number): AdapterResult {
  if (!Number.isFinite(circulatingUsd) || circulatingUsd <= 0) throw new Error("usdy-holdings-report: positive circulating USD required for scope accounting");
  const assets = Number(report.reportedAssetTotal);
  const liabilities = Number(report.reportedLiabilityTotal);
  const unknownUsd = Math.max(0, circulatingUsd - liabilities);
  const unknownExposurePct = unknownUsd / circulatingUsd * 100;
  const slices: ReserveSlice[] = report.holdings.filter((row) => Number(row.marketValue) > 0).map((row) => ({
    name: row.name,
    pct: Number(row.marketValue) / assets * (100 - unknownExposurePct),
    risk: row.category === "treasury-bill" ? "very-low" : "low",
    sourceKey: `usdy-holdings-report:${row.sourceId}`,
  }));
  if (unknownUsd > 0) slices.push({ name: "USDY outside LLC report scope (including BVI issuance)", pct: unknownExposurePct, risk: "high", sourceKey: "usdy-holdings-report:excluded-issuance" });
  const warnings = [reserveInfoWarning("usdy-report-scope-exclusion", "Ankura report covers Ondo USDY LLC only. BVI issuance is excluded; current circulating USD less report-time LLC principal is unmeasured exposure, including timing differences.")];
  if (liabilities <= 0 || assets < liabilities) warnings.push(reserveDegradedWarning("reserve-undercollateralized", "USDY LLC reported assets are below principal or principal is non-positive"));
  if (circulatingUsd < liabilities) warnings.push(reserveDegradedWarning("usdy-supply-scope-mismatch", "Current full-coin circulating USD is below report-time LLC principal; periods or supply scope differ"));
  return {
    slices, warnings,
    metadata: {
      freshnessMode: "verified", sourceTimestamp: Math.floor(Date.parse(report.reportAsOf) / 1000),
      unknownExposurePct,
      ...(liabilities > 0 ? { collateralizationRatio: assets / liabilities } : {}),
      details: {
        scope: report.scope, ratioScope: "LLC assets / LLC principal only, not full-coin solvency",
        reportDate: report.reportDate, reportAsOf: report.reportAsOf, reportTimeZone: report.reportTimeZone,
        timeBasis: report.timeBasis, preparer: report.preparer, reviewer: report.reviewer,
        reportUrl: report.reportUrl, reportSha256: report.reportSha256, reportByteLength: report.reportByteLength,
        latestReportDiscovery: "manual daily archive review; opportunistic visible-listing guard only",
        holdings: report.holdings, reportedAssetTotal: assets, reportedLiabilityTotal: liabilities,
        circulatingUsd, excludedScopeEstimateUsd: unknownUsd,
      },
    },
  };
}

export const fetchUsdyHoldingsReserves: AdapterFn = async (coin, _config, signal, ctx) => {
  assertHoldingsReportHost(manifest.reportUrl);
  assertHoldingsReportHost(manifest.listingUrl);
  // Sequential bounded reads use one connection. Dropbox's JS-only listing is
  // deliberately not treated as proof that the reviewed report is the latest.
  const listing = await fetchTextResponseWithRetry(manifest.listingUrl, signal, 10_000, ctx, { maxRetries: 0, maxResponseBytes: 1024 * 1024 });
  assertHoldingsReportHost(listing.finalUrl);
  assertNoNewerHoldingsReport(listing.body, manifest.reportDate);
  const response = await fetchBinaryResponseWithRetry(manifest.reportUrl, signal, 15_000, ctx, { maxRetries: 0, maxResponseBytes: 4 * 1024 * 1024 });
  assertHoldingsReportHost(response.finalUrl);
  if (response.body.byteLength !== manifest.reportByteLength) throw new Error("usdy-holdings-report: report byte length drift");
  const digest = await crypto.subtle.digest("SHA-256", response.body);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  // eslint-disable-next-line security/detect-possible-timing-attacks -- public report integrity pins are not secrets.
  if (hash !== manifest.reportSha256) throw new Error("usdy-holdings-report: report SHA-256 drift");
  if (!ctx?.db) throw new Error("usdy-holdings-report: supply cache required for excluded scope");
  const cached = await loadStablecoinsCache(ctx.db, { mode: "lenient", contract: "critical-fields" });
  const now = ctx.nowSec ?? Math.floor(Date.now() / 1000);
  if (!hasUsableStablecoinsPayload(cached) || cached.updatedAt == null || now - cached.updatedAt > 7200 || cached.updatedAt > now + 60) throw new Error("usdy-holdings-report: fresh supply cache required");
  const supplyCoin = cached.payload.peggedAssets.find((asset) => asset.id === coin.id);
  if (!supplyCoin) throw new Error("usdy-holdings-report: USDY supply absent");
  return adaptUsdyHoldings(manifest, getCirculatingRaw(supplyCoin));
};

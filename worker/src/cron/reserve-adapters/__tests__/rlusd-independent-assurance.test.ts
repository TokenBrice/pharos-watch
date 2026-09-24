import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS, NEXT_MONTH_DISCLOSURE_SOURCE_MAX_AGE_SEC } from "@shared/lib/live-reserve-adapters";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { getReserveAdapter } from "../index";
import { RLUSD_INDEPENDENT_ASSURANCE_PROFILE as profile } from "../rlusd-independent-assurance";
import { validateAdapterOutput } from "../validate";
import { verifyIndependentAssuranceReport } from "../independent-assurance";
import { installAdapterNetwork } from "./reserve-adapter.test-support";

const reviewed = getIndependentAssuranceManifest("RLUSD");
const html = readFileSync(new URL("./fixtures/rlusd-independent-assurance.html", import.meta.url), "utf8");
const pdf = "%PDF-1.7\nfixture\n";
const fixtureManifest = {
  ...reviewed,
  reportByteLength: Buffer.byteLength(pdf),
  reportSha256: createHash("sha256").update(pdf).digest("hex"),
};

function verify(index = html, manifest = fixtureManifest, body = pdf) {
  installAdapterNetwork({ html: {
    [reviewed.officialIndexUrl]: index,
    [reviewed.reportUrl]: { body, headers: { "content-type": "application/pdf" } },
  } });
  return verifyIndependentAssuranceReport({
    manifest, indexUrl: reviewed.officialIndexUrl, indexHost: "ripple.com",
    reportHosts: ["cdn.sanity.io"], profile, signal: new AbortController().signal,
  });
}

describe("rlusd-independent-assurance", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("reconciles the visually verified July 31 asset table and full outstanding units", () => {
    expect(reviewed).toMatchObject({
      attestor: "Deloitte & Touche LLP", conclusion: "unmodified", assuranceTier: "independent-assurance",
      reportAsOf: "2026-07-31T21:00:00Z", reportIssuedAt: "2026-08-27T00:00:00Z",
    });
    expect(reviewed.assets.map(({ amount }) => amount)).toEqual(["1077871526", "258192967", "239096420"]);
    expect(reconcileIndependentAssuranceManifest(reviewed)).toMatchObject({
      computedAssetTotal: "1575160913", liabilityTotal: "1463694758",
      reportedAssetDifference: "0", reportedLiabilityDifference: "0",
    });
    for (const chain of ["XRPL", "Ethereum", "Base", "Unichain", "Optimism", "Ink", "XRPL EVM Sidechain"]) {
      expect(reviewed.liabilities[0].label).toContain(chain);
    }
  });

  it("admits the reviewed July observation under the next-month disclosure age policy", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["rlusd-independent-assurance"]).toMatchObject({
      evidenceClass: "independent", sourceOriginClass: "independent-assurance",
    });
    const adapter = getReserveAdapter("rlusd-independent-assurance") ?? undefined;
    // Ripple publishes each month-end report 25-29 days later, so the July 31 observation is
    // ~54 days old three weeks before the September 27 successor is due; it ages out only at the cap.
    const sourceTimestamp = Math.floor(Date.parse(reviewed.reportAsOf) / 1000);
    for (const [ageSec, expectedStale] of [
      [54 * 86_400 + 12 * 3_600, false],
      [NEXT_MONTH_DISCLOSURE_SOURCE_MAX_AGE_SEC, false],
      [NEXT_MONTH_DISCLOSURE_SOURCE_MAX_AGE_SEC + 1, true],
    ] as const) {
      const warnings = validateAdapterOutput(
        { slices: [{ name: "Cash", pct: 100, risk: "very-low" }], metadata: { sourceTimestamp, freshnessMode: "verified" } },
        { adapter, now: sourceTimestamp + ageSec },
      ).warnings;
      expect(warnings.some((warning) => warning.code === "stale-source-data"), `at ${ageSec}s`).toBe(expectedStale);
    }
  });

  it("dates every real archive row, including escaped apostrophes and two-digit years", async () => {
    const prepared = await profile.prepareIndexHtml!(html, new AbortController().signal, undefined);
    const urls = [...prepared.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    expect(urls).toHaveLength(20);
    expect(urls.every((url) => profile.isReportCandidate(url, ""))).toBe(true);
    expect(urls.map((url) => profile.reportDateFromCandidate!(url, ""))).toEqual([
      "2024-12-31", "2025-01-31", "2025-02-28", "2025-03-31", "2025-04-30", "2025-05-31",
      "2025-06-30", "2025-07-31", "2025-08-31", "2025-09-30", "2025-10-31", "2025-11-30",
      "2025-12-31", "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31",
      "2026-06-30", "2026-07-31",
    ]);
  });

  it("verifies the newest official report URL and binds its PDF bytes to the source basis", async () => {
    await expect(verify()).resolves.toMatchObject({
      sourceTimestamp: Date.parse("2026-07-31T21:00:00Z") / 1000, byteLength: Buffer.byteLength(pdf),
    });
  });

  it("fails closed on a newer unreviewed report", async () => {
    await expect(verify(html + '<a href="https://cdn.sanity.io/RLUSD_Attestation_Report_August_26.pdf">Aug</a>')).rejects.toThrow("newer unreviewed report");
  });

  it("fails closed on unknown report dating and duplicate latest reports", async () => {
    await expect(verify(html + '<a href="https://cdn.sanity.io/RLUSD_Attestation_Report_latest.pdf">Latest</a>')).rejects.toThrow("ambiguous report date");
    await expect(verify(html + '<a href="https://cdn.sanity.io/RLUSD_Attestation_Report_July_26.pdf">Jul</a>')).rejects.toThrow("missing or duplicated");
  });

  it("rejects same-length PDF changes and the unreviewed fixture against the production hash", async () => {
    await expect(verify(html, fixtureManifest, pdf.replace("fixture", "changed"))).rejects.toThrow("SHA-256");
    await expect(verify(html, reviewed)).rejects.toThrow("PDF byte length");
  });
});

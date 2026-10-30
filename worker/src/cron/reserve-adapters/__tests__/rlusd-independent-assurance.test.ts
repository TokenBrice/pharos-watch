import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS, NEXT_MONTH_DISCLOSURE_SOURCE_MAX_AGE_SEC } from "@shared/lib/live-reserve-adapters";
import * as assurance from "@shared/lib/independent-assurance";
import { getIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { getReserveAdapter } from "../index";
import { RLUSD_INDEPENDENT_ASSURANCE_PROFILE as profile } from "../rlusd-independent-assurance-profile";
import { validateAdapterOutput } from "../validate";
import { verifyIndependentAssuranceReport } from "../independent-assurance";
import { installAdapterNetwork, resolveAdapterCoin } from "./reserve-adapter.test-support";

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

/** Run the registered adapter against the fixture manifest so discovery
 *  outcomes resolve past the real report's byte/SHA gates. */
async function fetchAdapter(index = html) {
  vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue(fixtureManifest);
  const { coin, config } = resolveAdapterCoin("rlusd-independent-assurance", "rlusd-ripple");
  installAdapterNetwork({ html: {
    [reviewed.officialIndexUrl]: index,
    [reviewed.reportUrl]: { body: pdf, headers: { "content-type": "application/pdf" } },
  } });
  return getReserveAdapter("rlusd-independent-assurance")!.fetch(coin, config, new AbortController().signal);
}

describe("rlusd-independent-assurance", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });


  it("admits the reviewed observation under the next-month disclosure age policy", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["rlusd-independent-assurance"]).toMatchObject({
      evidenceClass: "independent", sourceOriginClass: "independent-assurance",
    });
    const adapter = getReserveAdapter("rlusd-independent-assurance") ?? undefined;
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
    const prepared = await profile.prepareIndexHtml!(html, new AbortController().signal, undefined) as string;
    const anchors = [...prepared.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((match) => ({ href: match[1]!, text: match[2]! }));
    expect(anchors).toHaveLength(22);
    expect(anchors.every(({ href, text }) => profile.isReportCandidate(href, text))).toBe(true);
    expect(anchors.map(({ href, text }) => profile.reportDateFromCandidate(href, text))).toEqual([
      "2024-12-31", "2025-01-31", "2025-02-28", "2025-03-31", "2025-04-30", "2025-05-31",
      "2025-06-30", "2025-07-31", "2025-08-31", "2025-09-30", "2025-10-31", "2025-11-30",
      "2025-12-31", "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31",
      "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30",
    ]);
  });

  it("dates the year-less signed filenames from their archive year heading", async () => {
    const prepared = await profile.prepareIndexHtml!(html, new AbortController().signal, undefined) as string;
    const anchors = [...prepared.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((match) => ({ href: match[1]!, text: match[2]!.trim() }));
    for (const [text, expected] of [["Aug 2026", "2026-08-31"], ["Sept 2026", "2026-09-30"]] as const) {
      const anchor = anchors.find((candidate) => candidate.text === text);
      expect(anchor, `${text} anchor`).toBeDefined();
      expect(decodeURIComponent(anchor!.href.split("/").pop()!), `${text} filename`).not.toMatch(/\b(?:19|20)\d{2}\b/);
      expect(profile.reportDateFromCandidate!(anchor!.href, anchor!.text)).toBe(expected);
    }
    // The headings are the only year source; without them only the reviewed
    // artifact inherits its document-verified date.
    expect(profile.reportDateFromCandidate!(reviewed.reportUrl, "")).toBe("2026-09-30");
    expect(profile.reportDateFromCandidate!(
      "https://cdn.sanity.io/files/ior4a5y3/production/unreviewed.pdf/RLUSD%20Attestation%20Report%20(Oct)_Final%20Signed.pdf",
      "",
    )).toBeNull();
  });

  it("verifies the newest official report URL and binds its PDF bytes to the source basis", async () => {
    await expect(verify()).resolves.toMatchObject({
      sourceTimestamp: Date.parse("2026-09-30T21:00:00Z") / 1000, byteLength: Buffer.byteLength(pdf),
    });
  });

  it("keeps the reviewed report and names a newer unreviewed report", async () => {
    const newer = "https://cdn.sanity.io/RLUSD_Attestation_Report_October_26.pdf";
    await expect(verify(`${html}<a href="${newer}">Oct</a>`)).resolves.toMatchObject({
      sourceTimestamp: Date.parse("2026-09-30T21:00:00Z") / 1000,
      newerUnreviewedReport: { reportDate: "2026-10-31", reportUrl: newer },
      undatedIndexReportCandidates: [],
    });
  });

  it("still surfaces a newer year-less report filed under a later archive heading", async () => {
    const october = "https://cdn.sanity.io/files/ior4a5y3/production/unreviewed.pdf/RLUSD%20Attestation%20Report%20(Oct)_Final%20Signed.pdf";
    await expect(verify(`${html}<div class="mb-4 text-heading2">2026</div><div class="grid"><a href="${october}">Oct</a></div>`))
      .resolves.toMatchObject({ newerUnreviewedReport: { reportDate: "2026-10-31", reportUrl: october } });
    const january = "https://cdn.sanity.io/files/ior4a5y3/production/unreviewed.pdf/RLUSD%20Attestation%20Report%20(Jan)_Final%20Signed.pdf";
    await expect(verify(`${html}<div class="mb-4 text-heading2">2027</div><div class="grid"><a href="${january}">Jan</a></div>`))
      .resolves.toMatchObject({ newerUnreviewedReport: { reportDate: "2027-01-31", reportUrl: january } });
  });

  it("publishes the reviewed report degraded when a non-reviewed index entry cannot be dated", async () => {
    const undated = "https://cdn.sanity.io/RLUSD_Attestation_Report_latest.pdf";
    await expect(verify(html + `<a href="${undated}">Latest</a>`)).resolves.toMatchObject({
      sourceTimestamp: Date.parse("2026-09-30T21:00:00Z") / 1000,
      newerUnreviewedReport: null,
      undatedIndexReportCandidates: [{ reportUrl: undated, label: "Latest" }],
    });

    const result = await fetchAdapter(html + `<a href="${undated}">Latest</a>`);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "undated-index-report-candidate",
      severity: "warning",
      effect: "degraded",
      message: expect.stringContaining(undated),
    }));
    expect(result.warnings?.some((warning) => warning.code === "newer-unreviewed-report")).not.toBe(true);
    expect(result.slices.reduce((total, slice) => total + slice.pct, 0)).toBeCloseTo(100, 5);
    expect(result.metadata?.sourceTimestamp).toBe(Date.parse("2026-09-30T21:00:00Z") / 1000);
    expect(validateAdapterOutput(result, {
      adapter: getReserveAdapter("rlusd-independent-assurance") ?? undefined,
      now: Date.parse("2026-09-30T21:00:00Z") / 1000 + 60,
    }).valid).toBe(true);

    const newer = "https://cdn.sanity.io/RLUSD_Attestation_Report_October_26.pdf";
    const combined = await fetchAdapter(html + `<a href="${undated}">Latest</a><a href="${newer}">Oct</a>`);
    expect(combined.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "undated-index-report-candidate", effect: "degraded" }),
      expect.objectContaining({ code: "newer-unreviewed-report", effect: "degraded" }),
    ]));
  });

  it("warns instead of throwing when a month-only artifact has no enclosing archive year", async () => {
    const monthOnly = "https://cdn.sanity.io/files/ior4a5y3/production/unreviewed.pdf/RLUSD%20Attestation%20Report%20(Oct)_Final%20Signed.pdf";
    await expect(verify(`${html}<a href="${monthOnly}">Oct</a>`)).resolves.toMatchObject({
      undatedIndexReportCandidates: [{ reportUrl: monthOnly, label: "Oct" }],
    });
  });

  it("still fails closed on a missing, duplicated, or mis-dated reviewed URL", async () => {
    await expect(verify("<p>No reports</p>")).rejects.toThrow("reviewed report URL is missing or duplicated");
    await expect(verify(html + '<a href="https://cdn.sanity.io/RLUSD_Attestation_Report_September_26.pdf">Sep</a>'))
      .rejects.toThrow("missing or duplicated");
    await expect(verify(html, { ...fixtureManifest, reportDate: "2026-09-29" }))
      .rejects.toThrow("does not match the reviewed manifest");
  });

  it("publishes no positive claim when the official index read fails", async () => {
    const { coin, config } = resolveAdapterCoin("rlusd-independent-assurance", "rlusd-ripple");
    installAdapterNetwork({ html: {
      [reviewed.officialIndexUrl]: { status: 503, body: "unavailable" },
      [reviewed.reportUrl]: { body: pdf, headers: { "content-type": "application/pdf" } },
    } });
    await expect(
      getReserveAdapter("rlusd-independent-assurance")!.fetch(coin, config, new AbortController().signal),
    ).rejects.toThrow("HTTP 503");
  });

  it("rejects same-length PDF changes and the unreviewed fixture against the production hash", async () => {
    await expect(verify(html, fixtureManifest, pdf.replace("fixture", "changed"))).rejects.toThrow("SHA-256");
    await expect(verify(html, reviewed)).rejects.toThrow("PDF byte length");
  });
});

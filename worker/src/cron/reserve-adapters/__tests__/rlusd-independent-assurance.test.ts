import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS, NEXT_MONTH_DISCLOSURE_SOURCE_MAX_AGE_SEC } from "@shared/lib/live-reserve-adapters";
import { getIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { getReserveAdapter } from "../index";
import { RLUSD_INDEPENDENT_ASSURANCE_PROFILE as profile } from "../rlusd-independent-assurance-profile";
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
    const prepared = await profile.prepareIndexHtml!(html, new AbortController().signal, undefined);
    const urls = [...prepared.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    expect(urls).toHaveLength(21);
    expect(urls.every((url) => profile.isReportCandidate(url, ""))).toBe(true);
    expect(urls.map((url) => profile.reportDateFromCandidate!(url, ""))).toEqual([
      "2024-12-31", "2025-01-31", "2025-02-28", "2025-03-31", "2025-04-30", "2025-05-31",
      "2025-06-30", "2025-07-31", "2025-08-31", "2025-09-30", "2025-10-31", "2025-11-30",
      "2025-12-31", "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31",
      "2026-06-30", "2026-07-31", "2026-08-31",
    ]);
  });

  it("verifies the newest official report URL and binds its PDF bytes to the source basis", async () => {
    await expect(verify()).resolves.toMatchObject({
      sourceTimestamp: Date.parse("2026-08-31T21:00:00Z") / 1000, byteLength: Buffer.byteLength(pdf),
    });
  });

  it("fails closed on a newer unreviewed report", async () => {
    await expect(verify(html + '<a href="https://cdn.sanity.io/RLUSD_Attestation_Report_September_26.pdf">Sep</a>')).rejects.toThrow("newer unreviewed report");
  });

  it("fails closed on unknown report dating and duplicate latest reports", async () => {
    await expect(verify(html + '<a href="https://cdn.sanity.io/RLUSD_Attestation_Report_latest.pdf">Latest</a>')).rejects.toThrow("ambiguous report date");
    await expect(verify(html + '<a href="https://cdn.sanity.io/RLUSD_Attestation_Report_August_26.pdf">Aug</a>')).rejects.toThrow("missing or duplicated");
  });

  it("does not assign a reviewed year to another month-only artifact", async () => {
    await expect(verify(html.replace("4981331c98a2bb203c0c9ab2584e8b2a0da80938", "unknown"))).rejects.toThrow("ambiguous report date");
  });

  it("rejects same-length PDF changes and the unreviewed fixture against the production hash", async () => {
    await expect(verify(html, fixtureManifest, pdf.replace("fixture", "changed"))).rejects.toThrow("SHA-256");
    await expect(verify(html, reviewed)).rejects.toThrow("PDF byte length");
  });
});

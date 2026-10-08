import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as assurance from "@shared/lib/independent-assurance";
import type { StablecoinMeta } from "@shared/types/core";
import gusd from "@shared/data/stablecoins/coins/gusd-gemini.json";
import {
  fetchGeminiIndependentAssuranceReserves,
  verifyGeminiContentfulIndex,
} from "../gemini-independent-assurance";
import { installAdapterNetwork } from "./reserve-adapter.test-support";

const REVIEWED_URL =
  "https://assets.ctfassets.net/jg6lo9a2ukvr/7m6P0Or1IDsjF8Nj71yoOY/aff37499c0d462e444c5e614ed065e79/Gemini_Trust_Company__LLC_-_GUSD_RR_August_2026_-_Issued.pdf";
const REVIEWED_DATE = "2026-08-31T05:00:00Z";

interface FixtureEntry {
  date: string;
  assetId: string;
  url: string;
}

function contentfulIndex(entries: FixtureEntry[]): string {
  return JSON.stringify({
    sys: { type: "Array" },
    total: entries.length,
    skip: 0,
    limit: 1000,
    items: entries.map((entry) => ({
      metadata: { tags: [], concepts: [] },
      sys: {
        id: `entry-${entry.assetId}`,
        type: "Entry",
        contentType: { sys: { type: "Link", linkType: "ContentType", id: "gusdAttestation" } },
      },
      fields: {
        label: entry.date,
        assetUrl: { sys: { type: "Link", linkType: "Asset", id: entry.assetId } },
        reportDate: entry.date,
      },
    })),
    includes: {
      Asset: entries.map((entry) => ({
        sys: { id: entry.assetId, type: "Asset" },
        fields: { file: { url: entry.url.replace(/^https:/, "") } },
      })),
    },
  });
}

const reviewedEntry = (url = REVIEWED_URL): FixtureEntry => ({ date: REVIEWED_DATE, assetId: "7m6P0Or1IDsjF8Nj71yoOY", url });
const olderEntry = (date = "2026-07-31T05:00:00Z"): FixtureEntry => ({
  date,
  assetId: "olderJuly",
  url: "https://assets.ctfassets.net/jg6lo9a2ukvr/older/July_GUSD_Reserves_Report_Draft.pdf",
});

describe("Gemini Contentful attestation index verification", () => {
  const manifest = assurance.getIndependentAssuranceManifest("GUSD");

  it("accepts the reviewed newest entry and ignores older entries", () => {
    expect(() => verifyGeminiContentfulIndex(contentfulIndex([olderEntry(), reviewedEntry()]), manifest)).not.toThrow();
  });

  it("fails closed when a newer unreviewed entry exists", () => {
    const newer = olderEntry("2026-09-30T05:00:00Z");
    expect(() => verifyGeminiContentfulIndex(contentfulIndex([olderEntry(), reviewedEntry(), newer]), manifest))
      .toThrow("newer unreviewed report");
  });

  it("fails closed when the newest entry URL differs from the reviewed manifest", () => {
    const drift = reviewedEntry("https://assets.ctfassets.net/jg6lo9a2ukvr/7m6P0Or1IDsjF8Nj71yoOY/aff37499c0d462e444c5e614ed065e79/Resigned_Report.pdf");
    expect(() => verifyGeminiContentfulIndex(contentfulIndex([drift]), manifest))
      .toThrow("newest report URL differs");
  });

  it("rejects an ambiguous newest entry set", () => {
    const twin = { ...reviewedEntry(), assetId: "7m6P0Or1IDsjF8Nj71yoOY-twin", url: REVIEWED_URL };
    expect(() => verifyGeminiContentfulIndex(contentfulIndex([reviewedEntry(), twin]), manifest))
      .toThrow("ambiguous newest report");
  });

  it("rejects an index with an unresolvable PDF asset or invalid content", () => {
    const malformed = JSON.stringify({ ...JSON.parse(contentfulIndex([reviewedEntry()])), items: [{ sys: { contentType: { sys: { id: "other" } } } }] });
    expect(() => verifyGeminiContentfulIndex(malformed, manifest)).toThrow("unexpected content types");
    expect(() => verifyGeminiContentfulIndex("{not json", manifest)).toThrow("not valid JSON");
  });

  it("rejects an older July draft when the reviewed August report is missing", () => {
    expect(() => verifyGeminiContentfulIndex(contentfulIndex([olderEntry()]), manifest))
      .toThrow("reviewed report missing");
  });

  it("rejects an unresolved newest asset", () => {
    const payload = JSON.parse(contentfulIndex([reviewedEntry()]));
    payload.includes.Asset = [];
    expect(() => verifyGeminiContentfulIndex(JSON.stringify(payload), manifest))
      .toThrow("no resolvable PDF asset");
  });

  it("rejects a malformed report date", () => {
    expect(() => verifyGeminiContentfulIndex(contentfulIndex([{ ...reviewedEntry(), date: "not-a-date" }]), manifest))
      .toThrow("unparseable report date");
  });

  it("rejects a non-HTTPS asset instead of accepting a reviewed date alone", () => {
    expect(() => verifyGeminiContentfulIndex(contentfulIndex([reviewedEntry(REVIEWED_URL.replace("https:", "http:"))]), manifest))
      .toThrow("non-HTTPS asset URL");
  });
});

describe("Gemini GUSD independent assurance", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const coin = gusd as StablecoinMeta;

  it("verifies the reviewed Contentful entry and emits reconciled reserve slices", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-07T21:00:00Z"));
    const original = assurance.getIndependentAssuranceManifest("GUSD");
    const pdf = "%PDF-1.7 scoped assurance fixture";
    const manifest = { ...original, reportByteLength: pdf.length, reportSha256: createHash("sha256").update(pdf).digest("hex") };
    vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue(manifest);
    const network = installAdapterNetwork({
      json: {
        [manifest.officialIndexUrl]: contentfulIndex([olderEntry(), reviewedEntry(manifest.reportUrl)]),
        [manifest.reportUrl]: {
          body: pdf,
          headers: {
            "content-type": "application/pdf",
            "content-length": String(pdf.length),
          },
        },
      },
    });

    const result = await fetchGeminiIndependentAssuranceReserves(coin, coin.liveReservesConfig!, AbortSignal.timeout(5000));
    expect(network.requests.map((request) => request.url)).toEqual([
      manifest.officialIndexUrl,
      manifest.reportUrl,
    ]);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1, 12);
    expect(result.metadata?.sourceTimestamp).toBe(Date.parse("2026-08-31T17:00:00-04:00") / 1000);
    const sourceAgeDays = (Date.now() / 1000 - result.metadata!.sourceTimestamp!) / 86400;
    expect(sourceAgeDays).toBeGreaterThan(30);
    expect(sourceAgeDays).toBeLessThan(75);
    const reconciled = assurance.reconcileIndependentAssuranceManifest(original);
    expect(reconciled.computedAssetTotal).toBe("39573881");
    expect(reconciled.liabilityTotal).toBe("39573881");
    expect(result.slices).toEqual([
      expect.objectContaining({ name: expect.stringContaining("cash deposits"), pct: 100, risk: "very-low", assetClass: "bank-deposit" }),
    ]);
    expect(() => assurance.reconcileIndependentAssuranceManifest({
      ...original,
      liabilities: original.liabilities.map((liability, index) => index === 0 ? { ...liability, amount: String(Number(liability.amount) - 1) } : liability),
    })).toThrow(/liability total/);
  });

  it("fails closed when the official index gains a newer unreviewed entry", async () => {
    const manifest = assurance.getIndependentAssuranceManifest("GUSD");
    installAdapterNetwork({
      json: {
        [manifest.officialIndexUrl]: contentfulIndex([olderEntry(), reviewedEntry(), olderEntry("2026-09-30T05:00:00Z")]),
        [manifest.reportUrl]: "%PDF-1.7 scoped assurance fixture",
      },
    });

    await expect(fetchGeminiIndependentAssuranceReserves(coin, coin.liveReservesConfig!, AbortSignal.timeout(5000)))
      .rejects.toThrow("newer unreviewed report");
  });

  it.each([
    { label: "byte length", body: "%PDF-1.7 shortened", error: "PDF byte length" },
    { label: "artifact hash", body: "%PDF-1.7 scoped assurance fixturf", error: "PDF SHA-256" },
  ])("rejects a reviewed-index PDF with corrupt $label", async ({ body, error }) => {
    const original = assurance.getIndependentAssuranceManifest("GUSD");
    const reviewedPdf = "%PDF-1.7 scoped assurance fixture";
    const manifest = {
      ...original,
      reportByteLength: reviewedPdf.length,
      reportSha256: createHash("sha256").update(reviewedPdf).digest("hex"),
    };
    vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue(manifest);
    installAdapterNetwork({
      json: {
        [manifest.officialIndexUrl]: contentfulIndex([olderEntry(), reviewedEntry()]),
        [manifest.reportUrl]: {
          body,
          headers: { "content-type": "application/pdf", "content-length": String(body.length) },
        },
      },
    });
    await expect(fetchGeminiIndependentAssuranceReserves(coin, coin.liveReservesConfig!, AbortSignal.timeout(5000)))
      .rejects.toThrow(error);
  });
});

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
  "https://assets.ctfassets.net/jg6lo9a2ukvr/37f7Yx41qkN4XELuRzQrDv/e7d67a902d19e5fbf6a85ee620838d51/Gemini_Trust_Company__LLC_053126_GUSD_Reserves_Report_May_2026_-_Issued.pdf";
const REVIEWED_DATE = "2026-05-31T05:00:00Z";

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

const reviewedEntry = (url = REVIEWED_URL): FixtureEntry => ({ date: REVIEWED_DATE, assetId: "37f7Yx41qkN4XELuRzQrDv", url });
const olderEntry = (date = "2026-04-30T05:00:00Z"): FixtureEntry => ({
  date,
  assetId: "olderApril",
  url: "https://assets.ctfassets.net/jg6lo9a2ukvr/older/April_GUSD_Reserves_Report.pdf",
});

describe("Gemini Contentful attestation index verification", () => {
  const manifest = assurance.getIndependentAssuranceManifest("GUSD");

  it("accepts the reviewed newest entry and ignores older entries", () => {
    expect(() => verifyGeminiContentfulIndex(contentfulIndex([olderEntry(), reviewedEntry()]), manifest)).not.toThrow();
  });

  it("fails closed when a newer unreviewed entry exists", () => {
    const newer = olderEntry("2026-06-30T05:00:00Z");
    expect(() => verifyGeminiContentfulIndex(contentfulIndex([olderEntry(), reviewedEntry(), newer]), manifest))
      .toThrow("newer unreviewed report");
  });

  it("fails closed when the newest entry URL differs from the reviewed manifest", () => {
    const drift = reviewedEntry("https://assets.ctfassets.net/jg6lo9a2ukvr/37f7Yx41qkN4XELuRzQrDv/e7d67a902d19e5fbf6a85ee620838d51/Resigned_Report.pdf");
    expect(() => verifyGeminiContentfulIndex(contentfulIndex([drift]), manifest))
      .toThrow("newest report URL differs");
  });

  it("rejects an ambiguous newest entry set", () => {
    const twin = { ...reviewedEntry(), assetId: "37f7Yx41qkN4XELuRzQrDv-twin", url: REVIEWED_URL };
    expect(() => verifyGeminiContentfulIndex(contentfulIndex([reviewedEntry(), twin]), manifest))
      .toThrow("ambiguous newest report");
  });

  it("rejects an index with an unresolvable PDF asset or invalid content", () => {
    const malformed = JSON.stringify({ ...JSON.parse(contentfulIndex([reviewedEntry()])), items: [{ sys: { contentType: { sys: { id: "other" } } } }] });
    expect(() => verifyGeminiContentfulIndex(malformed, manifest)).toThrow("unexpected content types");
    expect(() => verifyGeminiContentfulIndex("{not json", manifest)).toThrow("not valid JSON");
  });
});

describe("Gemini GUSD independent assurance", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const coin = gusd as StablecoinMeta;

  it("verifies the reviewed Contentful entry and emits reconciled reserve slices", async () => {
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
    expect(result.metadata?.sourceTimestamp).toBe(Date.parse("2026-05-29T17:00:00-04:00") / 1000);
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
        [manifest.officialIndexUrl]: contentfulIndex([olderEntry(), reviewedEntry(), olderEntry("2026-06-30T05:00:00Z")]),
        [manifest.reportUrl]: "%PDF-1.7 scoped assurance fixture",
      },
    });

    await expect(fetchGeminiIndependentAssuranceReserves(coin, coin.liveReservesConfig!, AbortSignal.timeout(5000)))
      .rejects.toThrow("newer unreviewed report");
  });
});

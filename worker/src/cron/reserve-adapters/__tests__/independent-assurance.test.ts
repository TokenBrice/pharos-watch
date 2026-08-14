import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  getIndependentAssuranceManifest,
  IndependentAssuranceManifestSchema,
  reconcileIndependentAssuranceManifest,
  type IndependentAssuranceManifest,
  type IndependentAssuranceProduct,
} from "@shared/lib/independent-assurance";
import { getReserveAdapter } from "../index";
import { EUROP_INDEPENDENT_ASSURANCE_PROFILE } from "../europ-independent-assurance";
import {
  verifyIndependentAssuranceReport,
  type IndependentAssuranceProfile,
} from "../independent-assurance";
import { straitsxIndependentAssuranceProfile } from "../straitsx-independent-assurance";
import { USDGO_INDEPENDENT_ASSURANCE_PROFILE } from "../usdgo-transparency";
import { validateAdapterOutput } from "../validate";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nfixture\n");
const PDF_SHA256 = createHash("sha256").update(PDF_BYTES).digest("hex");

const PROFILE: IndependentAssuranceProfile = {
  adapterName: "test-independent-assurance",
  product: "AUDX",
  profile: "audx-v1",
  requiredAssetCodes: [],
  classifications: {},
  isReportCandidate: (_href, text) => /report/i.test(text),
};

function manifest(overrides: Partial<IndependentAssuranceManifest> = {}): IndependentAssuranceManifest {
  return {
    schemaVersion: 1,
    product: "AUDX",
    profile: "audx-v1",
    officialIndexUrl: "https://www.audxtoken.com/transparency",
    reportUrl: "https://www.audxtoken.com/reviewed.pdf",
    reportSha256: PDF_SHA256,
    reportByteLength: PDF_BYTES.length,
    reportDate: "2026-06-30",
    reportAsOf: "2026-06-30T23:59:00+11:00",
    reportTimeZone: "AEDT",
    attestor: "Aura Partners",
    engagement: "Independent limited assurance",
    conclusion: "nothing-came-to-attention",
    unit: "AUD",
    assets: [{ code: "cash", label: "Cash", amount: "101.00" }],
    liabilities: [{ code: "supply", label: "Supply", amount: "100.00" }],
    reportedAssetTotal: "101.00",
    computedAssetTotal: "101.00",
    reportedLiabilityTotal: "100.00",
    extraction: {
      tool: "test",
      parserVersion: "test",
      normalizedTextSha256: "0".repeat(64),
      pageCount: 1,
    },
    ...overrides,
  };
}

function responseWithFinalUrl(body: BodyInit, init: ResponseInit, finalUrl?: string): Response {
  const response = new Response(body, init);
  if (finalUrl) Object.defineProperty(response, "url", { value: finalUrl });
  return response;
}

function installFetch(options?: {
  pdf?: Uint8Array;
  rejectPdf?: boolean;
  indexFinalUrl?: string;
  pdfFinalUrl?: string;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/transparency")) {
        return responseWithFinalUrl(
          '<a href="/reviewed.pdf">June 2026 Report</a>',
          { headers: { "content-type": "text/html" } },
          options?.indexFinalUrl,
        );
      }
      if (options?.rejectPdf) throw new Error("network unreachable");
      return responseWithFinalUrl(
        options?.pdf ?? PDF_BYTES,
        {
          headers: {
            "content-type": "application/pdf",
            "content-length": String((options?.pdf ?? PDF_BYTES).length),
          },
        },
        options?.pdfFinalUrl,
      );
    }),
  );
}

async function verify(manifestOverride: Partial<IndependentAssuranceManifest> = {}) {
  return verifyIndependentAssuranceReport({
    manifest: manifest(manifestOverride),
    indexUrl: "https://www.audxtoken.com/transparency",
    indexHost: "www.audxtoken.com",
    reportHosts: ["www.audxtoken.com"],
    profile: PROFILE,
    signal: new AbortController().signal,
  });
}

function readIndexFixture(name: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only fixture reads with literal names from this file.
  return readFileSync(resolve(TEST_DIR, "fixtures", name), "utf8");
}

async function verifyRealIndexFixture(
  product: IndependentAssuranceProduct,
  profile: IndependentAssuranceProfile,
  fixtureName: string,
  htmlOverride?: string,
): Promise<void> {
  const reviewed = getIndependentAssuranceManifest(product);
  const indexHost = new URL(reviewed.officialIndexUrl).hostname;
  const reportHost = new URL(reviewed.reportUrl).hostname;
  const html = htmlOverride ?? readIndexFixture(fixtureName);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === reviewed.officialIndexUrl) {
        return new Response(html, { headers: { "content-type": "text/html" } });
      }
      if (url === reviewed.reportUrl) {
        return new Response(PDF_BYTES, {
          headers: {
            "content-type": "application/pdf",
            "content-length": String(PDF_BYTES.length),
          },
        });
      }
      throw new Error(`unexpected fixture request ${url}`);
    }),
  );
  await verifyIndependentAssuranceReport({
    manifest: reviewed,
    indexUrl: reviewed.officialIndexUrl,
    indexHost,
    reportHosts: [reportHost],
    profile,
    signal: new AbortController().signal,
  });
}

describe("independent-assurance manifest framework", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a matching official index URL and exact PDF bytes", async () => {
    installFetch();

    await expect(verify()).resolves.toMatchObject({
      sourceTimestamp: 1782824340,
      byteLength: PDF_BYTES.length,
    });
  });

  it("fails closed when the official PDF hash changes", async () => {
    installFetch({ pdf: new TextEncoder().encode("%PDF-1.7\nchanged\n") });

    await expect(verify()).rejects.toThrow("SHA-256");
  });

  it("fails closed when the official PDF is unreachable", async () => {
    installFetch({ rejectPdf: true });

    await expect(verify()).rejects.toThrow("Fetch failed for https://www.audxtoken.com/reviewed.pdf");
  });

  it("fails closed when the official index redirects to an unreviewed host", async () => {
    installFetch({ indexFinalUrl: "https://example.com/transparency" });

    await expect(verify()).rejects.toThrow("index response host example.com is not in the reviewed allowlist");
  });

  it("fails closed when the official PDF redirects to an unreviewed host", async () => {
    installFetch({ pdfFinalUrl: "https://example.com/reviewed.pdf" });

    await expect(verify()).rejects.toThrow("PDF response host example.com is not in the reviewed allowlist");
  });

  it("fails closed when a newer official report appears without a reviewed manifest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('<a href="/new-2026-07-31.pdf">July 2026 Report</a>')),
    );

    await expect(verify()).rejects.toThrow("newer unreviewed report");
  });

  it("fails closed when the official index has two reports at the reviewed latest date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          '<a href="/reviewed.pdf">June 2026 Report</a><a href="/alternate.pdf">June 2026 Report</a>',
        ),
      ),
    );

    await expect(verify()).rejects.toThrow("reviewed report URL is missing or duplicated");
  });

  it.each([
    ["EUROP", EUROP_INDEPENDENT_ASSURANCE_PROFILE, "europ-independent-assurance.html"],
    ["XSGD", straitsxIndependentAssuranceProfile("XSGD"), "straitsx-independent-assurance-xsgd.html"],
    ["XUSD", straitsxIndependentAssuranceProfile("XUSD"), "straitsx-independent-assurance-xusd.html"],
    ["USDGO", USDGO_INDEPENDENT_ASSURANCE_PROFILE, "usdgo-transparency.html"],
  ] as const)("accepts the trimmed real %s index shape before verifying PDF bytes", async (product, profile, fixture) => {
    await expect(verifyRealIndexFixture(product, profile, fixture)).rejects.toThrow("PDF byte length");
  });

  it("ignores a newer unrelated StraitsX whitepaper but fails closed on a newer XSGD report", async () => {
    const fixture = "straitsx-independent-assurance-xsgd.html";
    await expect(
      verifyRealIndexFixture("XSGD", straitsxIndependentAssuranceProfile("XSGD"), fixture),
    ).rejects.toThrow("PDF byte length");

    const withNewReport = readIndexFixture(fixture) +
      '<button data-gated-asset="XSGD Attestation Report July 2026" data-gated-url="https://cdn.prod.website-files.com/6119d1f2b05f8e65b1739721/XSGD_SCS_Reserve_Account_Report_(31_July_2026).pdf"></button>';
    await expect(
      verifyRealIndexFixture("XSGD", straitsxIndependentAssuranceProfile("XSGD"), fixture, withNewReport),
    ).rejects.toThrow("newer unreviewed report");
  });

  it("still fails closed when the USDGO family has two reports for the reviewed latest date", async () => {
    const fixture = "usdgo-transparency.html";
    const ambiguous = readIndexFixture(fixture) +
      '<a href="https://learn.anchorage.com/06.30.26_USDGO-Stablecoin-Attestation-Report-revised.pdf">Jun revised</a>';
    await expect(
      verifyRealIndexFixture("USDGO", USDGO_INDEPENDENT_ASSURANCE_PROFILE, fixture, ambiguous),
    ).rejects.toThrow("reviewed report URL is missing or duplicated");
  });

  it("keeps stale verified reports out of score-grade state", () => {
    const adapter = getReserveAdapter("audx-independent-assurance");
    const result = validateAdapterOutput(
      {
        slices: [{ name: "Cash", pct: 100, risk: "very-low" }],
        metadata: {
          sourceTimestamp: 1782824340,
          freshnessMode: "verified",
        },
      },
      { adapter: adapter!, now: 1786666166 + 4_000_001 },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "stale-source-data", effect: "degraded" }));
  });

  it("allows EUROP's reviewed sub-unit headline rounding difference", () => {
    const base = manifest({
      product: "EUROP",
      profile: "europ-v1",
      unit: "EUR",
      reportDate: "2026-06-30",
      reportAsOf: "2026-06-30T08:00:00Z",
      assets: [
        { code: "cash", label: "Cash", amount: "2300280.35" },
        { code: "cash-equivalents", label: "Cash equivalents", amount: "4899995.78" },
      ],
      liabilities: [{ code: "circulation", label: "Circulation", amount: "6840292.27" }],
      reportedAssetTotal: "7200276.54",
      computedAssetTotal: "7200276.13",
      reportedLiabilityTotal: "6840292.27",
    });
    const result = reconcileIndependentAssuranceManifest(base, {
      reportedAssetTotalTolerance: { absolute: "1", relativePpm: 1 },
    });

    expect(result.collateralizationRatio).toBeGreaterThan(1);
    expect(result.reportedAssetDifference).toBe("0.41");
    expect(IndependentAssuranceManifestSchema.safeParse(base).success).toBe(true);
  });

  it("rejects an EUROP asset discrepancy outside the reviewed tolerance", () => {
    const base = manifest({
      product: "EUROP",
      profile: "europ-v1",
      unit: "EUR",
      reportedAssetTotal: "7200276.54",
      computedAssetTotal: "7200276.13",
      assets: [
        { code: "cash", label: "Cash", amount: "2300280.35" },
        { code: "cash-equivalents", label: "Cash equivalents", amount: "4899995.78" },
      ],
    });

    expect(() =>
      reconcileIndependentAssuranceManifest(base, {
        reportedAssetTotalTolerance: { absolute: "0.4", relativePpm: 1 },
      }),
    ).toThrow(/reported asset total differs/);
  });
});

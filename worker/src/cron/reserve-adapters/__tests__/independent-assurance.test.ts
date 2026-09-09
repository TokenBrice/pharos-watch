import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach, vi } from "vitest";
import * as assurance from "@shared/lib/independent-assurance";
import * as adapters from "@shared/lib/live-reserve-adapters";
import type { LiveReserveAdapterDefinitionMap } from "@shared/lib/live-reserve-adapters";
import {
  getIndependentAssuranceManifest,
  IndependentAssuranceManifestSchema,
  reconcileIndependentAssuranceManifest,
  type IndependentAssuranceManifest,
  type IndependentAssuranceProduct,
} from "@shared/lib/independent-assurance";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { LiveReserveAdapterKey } from "@shared/types/live-reserves";
import {
  EUROP_INDEPENDENT_ASSURANCE_PROFILE,
  fetchIndependentAssuranceAdapter,
  fetchIndependentAssuranceReserves,
  straitsxIndependentAssuranceProfile,
  verifyIndependentAssuranceReport,
  type IndependentAssuranceProfile,
} from "../independent-assurance";
import { getReserveAdapter } from "../index";
import { USDGO_INDEPENDENT_ASSURANCE_PROFILE } from "../usdgo-transparency";
import { validateAdapterOutput } from "../validate";
import { buildReviewedReserveClassifications } from "../../../lib/safety-score-v9/extension-reserves";

/** One registered live-reserve adapter definition: the union
 * `getLiveReserveAdapterDefinition` hands out for any adapter key. */
type LiveReserveAdapterDefinition = LiveReserveAdapterDefinitionMap[LiveReserveAdapterKey];

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
    assuranceTier: "independent-assurance",
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
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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

const ROUTED_ASSURANCE_COINS = [
  "xsgd-straitsx",
  "xusd-straitsx",
  "audx-aussie-dollar-token",
] as const;

function routedAssuranceCoin(id: (typeof ROUTED_ASSURANCE_COINS)[number]) {
  const coin = ACTIVE_STABLECOINS.find((candidate) => candidate.id === id);
  if (!coin?.liveReservesConfig) throw new Error(`missing routed assurance config for ${id}`);
  return coin;
}

function assuranceCandidate(
  product: "XSGD" | "XUSD" | "AUDX",
  url: string,
  date: string,
): string {
  const [year, month, day] = date.split("-");
  const monthName = new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleString("en", {
    month: "long",
    timeZone: "UTC",
  });
  const label = product === "AUDX"
    ? `${product} assurance report ${date}`
    : `${product} SCS Reserve Account Report (${day} ${monthName} ${year})`;
  return `<a href="${url}">${label}</a>`;
}

describe("independent-assurance manifest framework", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["agreed-upon-procedures", "issuer-attested"] as const)(
    "derives %s provenance and prevents independent publication",
    async (conclusion) => {
      const raw = { ...manifest(), conclusion, assuranceTier: undefined };
      const reviewed = IndependentAssuranceManifestSchema.parse(raw);
      expect(reviewed.assuranceTier).toBe(conclusion);
      expect(IndependentAssuranceManifestSchema.safeParse({
        ...raw, assuranceTier: "independent-assurance",
      }).success).toBe(false);
      vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue(reviewed);
      const fetchMock = installFetch();
      const coin = routedAssuranceCoin("audx-aussie-dollar-token");
      const config = coin.liveReservesConfig!;
      const profile = { ...PROFILE, classifications: { cash: { name: "Cash", risk: "very-low" as const } } };
      const params = { product: "AUDX" as const, profile: "audx-v1", indexHost: "www.audxtoken.com", reportHosts: ["www.audxtoken.com"] };
      await expect(fetchIndependentAssuranceReserves(
        coin, config, new AbortController().signal, profile, params,
      )).rejects.toThrow("static-validated/issuer-attested");
      expect(fetchMock).not.toHaveBeenCalled();

      const descriptor = adapters.getLiveReserveAdapterDefinition(config.adapter)!;
      // The fixture fabricates an evidence class the registry never pairs with
      // this adapter key (the `key` literal pins the union member), so the
      // mocked definition is only reachable via an explicit assertion,
      // mirroring the keyed-params cast in live-reserve-adapters.ts.
      vi.spyOn(adapters, "getLiveReserveAdapterDefinition").mockReturnValue({
        ...descriptor, evidenceClass: "static-validated", sourceOriginClass: "issuer-attested",
      } as unknown as LiveReserveAdapterDefinition);
      const result = await fetchIndependentAssuranceReserves(
        coin, config, new AbortController().signal, profile, params,
      );
      expect(result.slices).toMatchObject([{ name: "Cash", risk: "very-low", pct: 100 }]);
      expect(result.metadata).toMatchObject({ freshnessMode: "verified", collateralizationRatio: 1.01 });
    },
  );

  it("joins renamed assurance categories by their source asset code", async () => {
    const reviewed = manifest();
    vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue(reviewed);
    installFetch();
    const coin = routedAssuranceCoin("audx-aussie-dollar-token");
    const result = await fetchIndependentAssuranceReserves(
      coin,
      { ...coin.liveReservesConfig!, inputs: { primary: { kind: "http-html", url: reviewed.officialIndexUrl } } },
      new AbortController().signal,
      { ...PROFILE, classifications: { cash: { name: "Renamed bank reserve", risk: "very-low" } } },
      { product: "AUDX", profile: "audx-v1", indexHost: "www.audxtoken.com", reportHosts: ["www.audxtoken.com"] },
    );
    const meta = {
      ...coin,
      reserves: [{ ...coin.reserves![0]!, sourceKey: "test-independent-assurance:audx:cash" }],
    };
    const clock = Date.parse(`${coin.reserveReview!.reviewedAt}T12:00:00Z`) / 1000;
    const [classification] = buildReviewedReserveClassifications(result.slices, meta, clock);
    expect(classification).toMatchObject({
      assetClass: coin.reserves![0]!.assetClass,
      issuerOrObligorKey: coin.reserves![0]!.issuerOrObligor,
    });
    expect(classification?.classificationKey).toMatch(/^registry-reviewed:/);
  });

  it.each(["200", "0", "-1"])("publishes reported liability %s with degraded evidence", async (liability) => {
    const reviewed = manifest({
      liabilities: [{ code: "supply", label: "Supply", amount: liability }],
      reportedLiabilityTotal: liability,
    });
    vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue(reviewed);
    installFetch();
    const result = await fetchIndependentAssuranceReserves(
      routedAssuranceCoin("audx-aussie-dollar-token"),
      { ...routedAssuranceCoin("audx-aussie-dollar-token").liveReservesConfig!,
        inputs: { primary: { kind: "http-html", url: reviewed.officialIndexUrl } } },
      new AbortController().signal,
      { ...PROFILE, classifications: { cash: { name: "Cash", risk: "very-low" } } },
      { product: "AUDX", profile: "audx-v1", indexHost: "www.audxtoken.com", reportHosts: ["www.audxtoken.com"] },
    );
    expect(result.slices).toMatchObject([{ name: "Cash", risk: "very-low", pct: 100 }]);
    expect(result.metadata?.collateralizationRatio).toBe(liability === "200" ? 0.505 : undefined);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" }));
    expect(reconcileIndependentAssuranceManifest(reviewed)).toMatchObject({
      reserveShortfall: liability === "200" ? "99" : "0",
      nonPositiveLiabilityCodes: liability === "200" ? [] : ["supply"],
    });
  });

  it.each(["assets", "liabilities"] as const)("rejects malformed %s rows", (field) => {
    const reviewed = manifest();
    reviewed[field][0].amount = "not-a-decimal";
    expect(() => reconcileIndependentAssuranceManifest(reviewed)).toThrow("not a decimal string");
  });

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
    const fetchMock = installFetch({ rejectPdf: true });

    await expect(verify()).rejects.toThrow("Fetch failed for www.audxtoken.com");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://www.audxtoken.com/reviewed.pdf",
      expect.any(Object),
    );
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

  it("ignores an unrelated StraitsX whitepaper but fails closed on a newer XSGD report", async () => {
    const fixture = "straitsx-independent-assurance-xsgd.html";
    await expect(
      verifyRealIndexFixture("XSGD", straitsxIndependentAssuranceProfile("XSGD"), fixture),
    ).rejects.toThrow("PDF byte length");

    const withNewReport = readIndexFixture(fixture) +
      '<button data-gated-asset="XSGD Attestation Report August 2026" data-gated-url="https://cdn.prod.website-files.com/6119d1f2b05f8e65b1739721/XSGD_SCS_Reserve_Account_Report_(31_August_2026).pdf"></button>';
    await expect(
      verifyRealIndexFixture("XSGD", straitsxIndependentAssuranceProfile("XSGD"), fixture, withNewReport),
    ).rejects.toThrow("newer unreviewed report");
  });

  it("still fails closed when the USDGO family has two reports for the reviewed latest date", async () => {
    const fixture = "usdgo-transparency.html";
    const ambiguous = readIndexFixture(fixture) +
      '<a href="https://learn.anchorage.com/07.31.26_USDGO-Stablecoin-Attestation-Report-revised.pdf">Jul revised</a>';
    await expect(
      verifyRealIndexFixture("USDGO", USDGO_INDEPENDENT_ASSURANCE_PROFILE, fixture, ambiguous),
    ).rejects.toThrow("reviewed report URL is missing or duplicated");
  });

  it.each(ROUTED_ASSURANCE_COINS)(
    "%s dispatches through the exported adapter and preserves every fail-closed gate",
    async (coinId) => {
      const coin = routedAssuranceCoin(coinId);
      const config = coin.liveReservesConfig!;
      const product = coin.symbol.toUpperCase() as "XSGD" | "XUSD" | "AUDX";
      const reviewed = getIndependentAssuranceManifest(product);
      const reviewedCandidate = assuranceCandidate(product, reviewed.reportUrl, reviewed.reportDate);
      const nextYear = Number(reviewed.reportDate.slice(0, 4)) + 1;
      const nextDate = `${nextYear}-07-31`;
      const newerUrl = new URL(
        product === "AUDX"
          ? `report-${nextDate}.pdf`
          : `${product}-SCS-Reserve-Account-Report-31-July-${nextYear}.pdf`,
        reviewed.reportUrl,
      ).toString();
      const newerCandidate = assuranceCandidate(product, newerUrl, nextDate);
      const duplicateUrl = new URL(`alternate-${product}-${reviewed.reportDate}.pdf`, reviewed.reportUrl).toString();
      const duplicateCandidate = assuranceCandidate(product, duplicateUrl, reviewed.reportDate);

      const cases = [
        {
          name: "hash mismatch",
          config,
          html: reviewedCandidate,
          pdf: new Uint8Array(reviewed.reportByteLength),
          error: "SHA-256",
        },
        {
          name: "URL/host drift",
          config: {
            ...config,
            inputs: { ...config.inputs, primary: { kind: "http-html" as const, url: "https://example.com/drift" } },
          },
          html: reviewedCandidate,
          pdf: PDF_BYTES,
          error: "configured index URL is not the reviewed official index",
        },
        { name: "missing reviewed URL", config, html: "<p>No reports</p>", pdf: PDF_BYTES, error: "reviewed report URL is missing or duplicated" },
        { name: "newer unreviewed report", config, html: reviewedCandidate + newerCandidate, pdf: PDF_BYTES, error: "newer unreviewed report" },
        { name: "duplicate latest date", config, html: reviewedCandidate + duplicateCandidate, pdf: PDF_BYTES, error: "reviewed report URL is missing or duplicated" },
      ];

      for (const testCase of cases) {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url === reviewed.officialIndexUrl) {
            return new Response(testCase.html, { headers: { "content-type": "text/html" } });
          }
          if (url === reviewed.reportUrl) {
            return new Response(testCase.pdf, {
              headers: {
                "content-type": "application/pdf",
                "content-length": String(testCase.pdf.length),
              },
            });
          }
          throw new Error(`unexpected ${testCase.name} request ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(
          fetchIndependentAssuranceAdapter(
            coin,
            testCase.config,
            new AbortController().signal,
          ),
          testCase.name,
        ).rejects.toThrow(testCase.error);
      }
    },
  );

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

  it("reconciles July StraitsX reports including the new XSGD XLAYER liability", () => {
    for (const product of ["XUSD", "XSGD"] as const) {
      const reviewed = getIndependentAssuranceManifest(product);
      expect(reviewed.reportDate).toBe("2026-07-31");
      expect(reconcileIndependentAssuranceManifest(reviewed)).toMatchObject({
        reportedAssetDifference: "0",
        reportedLiabilityDifference: "0",
      });
    }
    const xsgd = getIndependentAssuranceManifest("XSGD");
    expect(xsgd.liabilities).toContainEqual({ code: "xlayer", label: "XSGD XLAYER circulation", amount: "5" });
    expect(() => reconcileIndependentAssuranceManifest({
      ...xsgd,
      liabilities: xsgd.liabilities.filter((row) => row.code !== "xlayer"),
    })).toThrow("liability total 21283481 does not match manifest 21283486");
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

  it.each(["brlv-crown", "audm-macropod"] as const)(
    "binds %s to a static-validated/issuer-attested descriptor and reconciles every liability",
    (coinId) => {
      const coin = ACTIVE_STABLECOINS.find((candidate) => candidate.id === coinId);
      if (!coin?.liveReservesConfig) throw new Error(`missing issuer-attested config for ${coinId}`);
      expect(coin.liveReservesConfig.adapter).toBe("issuer-attested-report");

      const descriptor = getReserveAdapter("issuer-attested-report");
      expect(descriptor?.evidenceClass).toBe("static-validated");
      expect(adapters.getLiveReserveAdapterDefinition("issuer-attested-report")?.sourceOriginClass).toBe("issuer-attested");

      const product = coin.symbol.toUpperCase() as "BRLV" | "AUDM";
      const reviewed = getIndependentAssuranceManifest(product);
      expect(reviewed.conclusion).toBe("issuer-attested");
      expect(reviewed.assuranceTier).toBe("issuer-attested");
      expect(reviewed.liabilities.length).toBeGreaterThan(0);
      expect(reconcileIndependentAssuranceManifest(reviewed)).toMatchObject({
        reportedAssetDifference: "0",
        reportedLiabilityDifference: "0",
        reserveShortfall: "0",
        nonPositiveLiabilityCodes: [],
      });
    },
  );

  it.each(["brlv-crown", "audm-macropod"] as const)(
    "dispatches %s through the exported adapter and classifies measured slices",
    async (coinId) => {
      const coin = ACTIVE_STABLECOINS.find((candidate) => candidate.id === coinId);
      if (!coin?.liveReservesConfig) throw new Error(`missing live-reserves config for ${coinId}`);
      const config = coin.liveReservesConfig;
      const product = coin.symbol.toUpperCase() as "BRLV" | "AUDM";
      const reviewed = {
        ...getIndependentAssuranceManifest(product),
        reportSha256: PDF_SHA256,
        reportByteLength: PDF_BYTES.length,
      };
      vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue(reviewed);

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url === reviewed.officialIndexUrl) {
            return new Response(`<a href="${reviewed.reportUrl}">Reviewed report</a>`, {
              headers: { "content-type": "text/html" },
            });
          }
          if (url === reviewed.reportUrl) {
            return new Response(PDF_BYTES, {
              headers: { "content-type": "application/pdf", "content-length": String(PDF_BYTES.length) },
            });
          }
          throw new Error(`unexpected request ${url}`);
        }),
      );

      const result = await fetchIndependentAssuranceAdapter(coin, config, new AbortController().signal);
      expect(result.metadata).toMatchObject({ freshnessMode: "verified" });
      expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
      expect(result.slices.length).toBeGreaterThan(0);
      expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeGreaterThan(99);
    },
  );
});

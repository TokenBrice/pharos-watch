import { createHash } from "node:crypto";
import { describe, expect, it, afterEach, vi } from "vitest";
import * as assurance from "@shared/lib/independent-assurance";
import * as adapters from "@shared/lib/live-reserve-adapters";
import type { LiveReserveAdapterDefinitionMap } from "@shared/lib/live-reserve-adapters";
import {
  getIndependentAssuranceManifest,
  independentAssuranceSourceTimestamp,
  IndependentAssuranceManifestSchema,
  reconcileIndependentAssuranceManifest,
  type IndependentAssuranceManifest,
  type IndependentAssuranceProduct,
} from "@shared/lib/independent-assurance";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { LiveReserveAdapterKey } from "@shared/types/live-reserves";
import {
  AUDM_INDEPENDENT_ASSURANCE_PROFILE,
  EUROP_INDEPENDENT_ASSURANCE_PROFILE,
  fetchIndependentAssuranceAdapter,
  fetchIndependentAssuranceReserves,
  INDEPENDENT_ASSURANCE_ADAPTERS,
  straitsxIndependentAssuranceProfile,
  verifyIndependentAssuranceReport,
} from "../independent-assurance";
import { AGORA_INDEPENDENT_ASSURANCE_PROFILE } from "../agora-independent-assurance-profile";
import { USDPT_INDEPENDENT_ASSURANCE_PROFILE } from "../anchorage-independent-assurance-profile";
import { AUDD_INDEPENDENT_ASSURANCE_PROFILE } from "../audd-independent-assurance-profile";
import {
  BRLA_NOTION_PIN,
  buildBrlaReserveSlices,
  fetchAndVerifyBrlaPdf,
  verifyBrlaNotionDiscovery,
} from "../brla-independent-assurance";
import { CADD_INDEPENDENT_ASSURANCE_PROFILE } from "../cadd-independent-assurance-profile";
import { collectPdfAnchors } from "../helpers";
import { getReserveAdapter } from "../index";
import type { IndependentAssuranceProfile } from "../independent-assurance-types";
import { USDGO_INDEPENDENT_ASSURANCE_PROFILE } from "../usdgo-transparency";
import { validateAdapterOutput } from "../validate";
import { buildReviewedReserveClassifications } from "../../../lib/safety-score-v9/extension-reserves";
import { installAdapterNetwork } from "./reserve-adapter.test-support";
import {
  PDF_BYTES,
  installFetch as installAssuranceFetch,
  indexFixture,
  verifyFixtureIndex,
  verifyIndex as verifyAssuranceIndex,
} from "./independent-assurance.test-support";

/** One registered live-reserve adapter definition: the union
 * `getLiveReserveAdapterDefinition` hands out for any adapter key. */
type LiveReserveAdapterDefinition = LiveReserveAdapterDefinitionMap[LiveReserveAdapterKey];

const PDF_SHA256 = createHash("sha256").update(PDF_BYTES).digest("hex");

const PROFILE: IndependentAssuranceProfile = {
  adapterName: "test-independent-assurance",
  product: "AUDX",
  profile: "audx-v1",
  requiredAssetCodes: [],
  classifications: {},
  isReportCandidate: (_href, text) => /report/i.test(text),
  reportDateFromCandidate: (href, text) => {
    const value = `${href} ${text}`;
    return value.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ??
      (/\bJuly 2026\b/i.test(value) ? "2026-07-31" : null) ??
      (/\bJune 2026\b/i.test(value) || /\/reviewed\.pdf$/i.test(href) ? "2026-06-30" : null);
  },
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

const FIDD_VIEWER_URL = "https://fwc.widen.net/s/bbtmltgbgf/fidelity-digital-assets---fidd-reserve-attestation-report---september-2026";
const FIDD_OCTOBER_VIEWER_URL = "https://fwc.widen.net/s/nextreport/fidelity-digital-assets---fidd-reserve-attestation-report---october-2026";
const FIDD_VIEWER_HTML = '<html><head><title>Fidelity-Digital-Assets---FIDD-Reserve-Attestation-Report---September-2026.pdf</title></head><body><a id="download" href="/content/azzc1igqzr/original/Fidelity-Digital-Assets---FIDD-Reserve-Attestation-Report---September-2026.pdf?u=5lvvtn&amp;download=true">Download</a></body></html>';
const FIDD_OCTOBER_VIEWER_HTML = FIDD_VIEWER_HTML.replaceAll("September-2026", "October-2026");

function assuranceFenceCases() {
  const ausd = getIndependentAssuranceManifest("AUSD");
  const agoraReviewed =
    `https://fdr-prod-docs-files-public.s3.us-east-1.amazonaws.com${new URL(ausd.reportUrl).pathname}?X-Amz-Signature=fixture`;
  const fiddIndex = `<a href="${FIDD_VIEWER_URL}">September</a>`;
  return [
    {
      adapter: "agora-independent-assurance",
      coinId: "ausd-agora",
      product: "AUSD",
      html: `<a href="${agoraReviewed}">September</a>`,
      newerHtml: `<a href="${agoraReviewed}">September</a><a href="https://files.buildwithfern.com/agora.docs.buildwithfern.com/new/docs/assets/2026%20Oct%20-%20Agora%20Dollar%20Reserve%20Report.pdf">October</a>`,
    },
    {
      adapter: "anchorage-independent-assurance",
      coinId: "usat-tether",
      product: "USAT",
      html: indexFixture("anchorage-independent-assurance.html"),
      newerHtml: indexFixture("anchorage-independent-assurance.html") +
        '<a href="https://learn.anchorage.com/10.31.26_USAT-Stablecoin-Attestation-Report.pdf">Oct</a>',
    },
    {
      adapter: "anchorage-independent-assurance",
      coinId: "usdpt-western-union",
      product: "USDPT",
      html: indexFixture("usdpt-independent-assurance.html"),
      newerHtml: indexFixture("usdpt-independent-assurance.html") +
        '<a href="https://learn.anchorage.com/10.31.26_USDPT_Stablecoin_Attestation_Report.pdf">Oct</a>',
    },
    {
      adapter: "audd-independent-assurance",
      coinId: "audd-novatti",
      product: "AUDD",
      html: indexFixture("audd-independent-assurance.html"),
      newerHtml: indexFixture("audd-independent-assurance.html") +
        '<a href="https://www.audd.digital/wp-content/uploads/2026/11/AUDC-Agreed-upon-procedures-report-Oct26_.pdf">October 2026</a>',
    },
    {
      adapter: "cadd-independent-assurance",
      coinId: "cadd-cad-digital",
      product: "CADD",
      html: indexFixture("cadd-independent-assurance.html"),
      newerHtml: indexFixture("cadd-independent-assurance.html") +
        '<a href="https://drive.google.com/file/d/1OctFailsClosedPlaceholderID/view?usp=sharing">October 2026 attestation</a>',
    },
    {
      adapter: "fdusd-independent-assurance",
      coinId: "fdusd-first-digital",
      product: "FDUSD",
      html: indexFixture("fdusd-independent-assurance.html"),
      newerHtml: indexFixture("fdusd-independent-assurance.html") +
        '<div role="listitem" class="transparency-report_item w-dyn-item"><div>Oct 2026</div><a href="https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/cafe_Attestation%20Report%20on%20Reserves%20Account%20Oct.pdf">Download</a></div>',
    },
    {
      adapter: "rlusd-independent-assurance",
      coinId: "rlusd-ripple",
      product: "RLUSD",
      html: indexFixture("rlusd-independent-assurance.html"),
      newerHtml: indexFixture("rlusd-independent-assurance.html") +
        '<a href="https://ripple.com/RLUSD_Reserve_Report_October_2026.pdf">October</a>',
    },
    {
      adapter: "sbc-independent-assurance",
      coinId: "sbc-brale",
      product: "SBC",
      html: `<a href="${getIndependentAssuranceManifest("SBC").reportUrl}">September</a>`,
      newerHtml: `<a href="${getIndependentAssuranceManifest("SBC").reportUrl}">September</a>` +
        '<a href="https://brale.xyz/SBC-Stable-Coin-Reserve-Attestation-Report-10-2026.pdf">October</a>',
    },
    {
      adapter: "fidd-independent-assurance",
      coinId: "fidd-fidelity",
      product: "FIDD",
      html: fiddIndex,
      newerHtml: `${fiddIndex}<a href="${FIDD_OCTOBER_VIEWER_URL}">October</a>`,
      options: {
        extraHtml: {
          [FIDD_VIEWER_URL]: FIDD_VIEWER_HTML,
          [FIDD_OCTOBER_VIEWER_URL]: FIDD_OCTOBER_VIEWER_HTML,
        },
      },
    },
  ] as const;
}

describe("independent-assurance manifest framework", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(assuranceFenceCases())(
    "$adapter keeps the reviewed index and redirect hosts fail-closed and lets a newer report reach the PDF gates",
    async (testCase) => {
      const options = "options" in testCase ? testCase.options : undefined;
      await expect(
        verifyAssuranceIndex(testCase.adapter, testCase.coinId, testCase.product, testCase.html, options),
      ).rejects.toThrow("PDF byte length");
      await expect(
        verifyAssuranceIndex(testCase.adapter, testCase.coinId, testCase.product, testCase.html, {
          ...options,
          indexRedirect: "https://unreviewed.example/index",
        }),
      ).rejects.toThrow(/index response host .* is not in the reviewed allowlist/);
      await expect(
        verifyAssuranceIndex(testCase.adapter, testCase.coinId, testCase.product, testCase.html, {
          ...options,
          reportRedirect: "https://unreviewed.example/report.pdf",
        }),
      ).rejects.toThrow(/PDF response host .* is not in the reviewed allowlist/);
      // A newer index entry no longer stops discovery; the pinned PDF gates still run.
      await expect(
        verifyAssuranceIndex(testCase.adapter, testCase.coinId, testCase.product, testCase.newerHtml, options),
      ).rejects.toThrow("PDF byte length");
    },
  );
  it("rejects an unreviewed index redirect before reading its body", async () => {
    const fetchMock = installFetch({ indexFinalUrl: "https://unreviewed.example/index" });
    await expect(verify()).rejects.toThrow(/index response host .* is not in the reviewed allowlist/);
    expect(((await fetchMock.mock.results[0]!.value) as Response).bodyUsed).toBe(false);
  });

  it("rejects an unreviewed PDF redirect before reading its body", async () => {
    const fetchMock = installFetch({ pdfFinalUrl: "https://unreviewed.example/report.pdf" });
    await expect(verify()).rejects.toThrow(/PDF response host .* is not in the reviewed allowlist/);
    expect(((await fetchMock.mock.results[1]!.value) as Response).bodyUsed).toBe(false);
  });

  it("rejects an oversized index page before parsing it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseWithFinalUrl(
      "x".repeat(1024 * 1024 + 1),
      { headers: { "content-type": "text/html" } },
      "https://www.audxtoken.com/transparency",
    )));
    await expect(verify()).rejects.toThrow("Response body exceeded 1048576 bytes");
  });

  it.each(assuranceFenceCases())(
    "$adapter validates pinned bytes and publishes the reviewed product's measured assets",
    async (testCase) => {
      const reviewed = getIndependentAssuranceManifest(testCase.product);
      vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue({
        ...reviewed,
        reportByteLength: PDF_BYTES.length,
        reportSha256: createHash("sha256").update(PDF_BYTES).digest("hex"),
      });
      // The synthetic PDF has its own identity; the product suite separately
      // rejects any real report identity outside the reviewed rounding scope.
      const reconcile = assurance.reconcileIndependentAssuranceManifest;
      vi.spyOn(assurance, "reconcileIndependentAssuranceManifest").mockImplementation((manifest, options) =>
        reconcile(manifest, options?.reviewedReport ? {
          ...options,
          reviewedReport: { ...options.reviewedReport, reportSha256: PDF_SHA256 },
        } : options));
      const options = "options" in testCase ? testCase.options : undefined;
      installAssuranceFetch(testCase.product, testCase.html, options);
      const coin = ACTIVE_STABLECOINS.find((candidate) => candidate.id === testCase.coinId);
      if (!coin?.liveReservesConfig) throw new Error(`missing assurance config for ${testCase.coinId}`);
      const adapter = getReserveAdapter(testCase.adapter)!;
      const result = await adapter.fetch(coin, coin.liveReservesConfig, new AbortController().signal);
      expect(result.slices.length).toBeGreaterThan(0);
      expect(result.slices.reduce((total, slice) => total + slice.pct, 0)).toBeCloseTo(100, 5);
      expect(result.slices.every((slice) =>
        slice.sourceKey?.startsWith(`${testCase.adapter}:${testCase.product.toLowerCase()}:`),
      )).toBe(true);
      expect(result.metadata?.sourceTimestamp).toBe(assurance.independentAssuranceSourceTimestamp(reviewed));
      expect(result.metadata?.details).toMatchObject({
        assurance: { product: testCase.product, assets: reviewed.assets, liabilities: reviewed.liabilities },
      });
      if (testCase.product === "SBC") {
        expect(result.warnings).toContainEqual(expect.objectContaining({
          code: "report-rounding-difference", severity: "info", effect: "info",
        }));
      }
      expect(validateAdapterOutput(result, {
        adapter,
        now: assurance.independentAssuranceSourceTimestamp(reviewed) + 60,
      }).valid).toBe(true);
      expect(result.warnings?.some((warning) => warning.code === "newer-unreviewed-report")).not.toBe(true);

      installAssuranceFetch(testCase.product, testCase.newerHtml, options);
      const newer = await adapter.fetch(coin, coin.liveReservesConfig, new AbortController().signal);
      expect(newer.slices).toEqual(result.slices);
      expect(newer.metadata?.sourceTimestamp).toBe(result.metadata?.sourceTimestamp);
      expect(newer.warnings).toContainEqual(expect.objectContaining({
        code: "newer-unreviewed-report", severity: "warning", effect: "degraded",
        message: expect.stringContaining(`publishing the reviewed ${reviewed.reportDate} report`),
      }));
    },
  );

  it("rejects specialized keys and invalid product bindings before reading upstream", async () => {
    const coin = routedAssuranceCoin("audx-aussie-dollar-token");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(fetchIndependentAssuranceAdapter(coin, {
      ...coin.liveReservesConfig!,
      adapter: "gemini-independent-assurance",
    }, new AbortController().signal)).rejects.toThrow();
    await expect(fetchIndependentAssuranceAdapter(coin, {
      ...coin.liveReservesConfig!,
      adapter: "agora-independent-assurance",
      params: { ...coin.liveReservesConfig!.params, product: "AUDX" },
    }, new AbortController().signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["08/09/2026", "08.09.2026"])(
    "rejects AUDX's ambiguous numeric report date %s",
    async (ambiguousDate) => {
      const reviewed = getIndependentAssuranceManifest("AUDX");
      const html = `<a href="${reviewed.reportUrl}">31 July 2026 report</a>` +
        `<a href="https://www.audxtoken.com/reports/report-${ambiguousDate}.pdf">AUDX report</a>`;
      await expect(
        verifyAssuranceIndex("audx-independent-assurance", "audx-aussie-dollar-token", "AUDX", html),
      ).rejects.toThrow("ambiguous report date");
    },
  );

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
      expect(result.slices).toEqual([{ sourceKey: "test-independent-assurance:audx:cash", name: "Cash", risk: "very-low", pct: 100 }]);
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
    expect(result.slices).toEqual([{ sourceKey: "test-independent-assurance:audx:cash", name: "Cash", risk: "very-low", pct: 100 }]);
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

  it("fails closed when the official PDF is unreachable", async () => {
    const fetchMock = installFetch({ rejectPdf: true });

    await expect(verify()).rejects.toThrow("network unreachable");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://www.audxtoken.com/reviewed.pdf",
      expect.any(Object),
    );
  });

  it.each([
    ["XSGD", straitsxIndependentAssuranceProfile("XSGD"), "straitsx-independent-assurance-xsgd.html"],
    ["XUSD", straitsxIndependentAssuranceProfile("XUSD"), "straitsx-independent-assurance-xusd.html"],
    ["USDGO", USDGO_INDEPENDENT_ASSURANCE_PROFILE, "usdgo-transparency.html"],
  ] as const)("accepts the trimmed real %s index shape before verifying PDF bytes", async (product, profile, fixture) => {
    await expect(verifyFixtureIndex(product, profile, fixture)).rejects.toThrow("PDF byte length");
  });

  it("accepts EUROP's official WordPress media index before verifying PDF bytes", async () => {
    const reviewed = getIndependentAssuranceManifest("EUROP");
    const media = JSON.stringify([{ source_url: reviewed.reportUrl }]);
    await expect(
      verifyFixtureIndex("EUROP", EUROP_INDEPENDENT_ASSURANCE_PROFILE, "europ-independent-assurance.html", media),
    ).rejects.toThrow("PDF byte length");
  });

  it("fails closed when EUROP's media index publishes a newer report", async () => {
    const reviewed = getIndependentAssuranceManifest("EUROP");
    const media = JSON.stringify([
      { source_url: reviewed.reportUrl },
      {
        source_url:
          "https://schuman.io/wp-content/uploads/2026/10/SALVUS_Attestation_relative_au_nombre_de_jetons_EUROP_30_09_2026.pdf",
      },
    ]);
    await expect(
      verifyFixtureIndex("EUROP", EUROP_INDEPENDENT_ASSURANCE_PROFILE, "europ-independent-assurance.html", media, true),
    ).resolves.toMatchObject({ newerUnreviewedReport: { reportDate: "2026-09-30" } });
  });

  it("treats a differently separated Salvus attestation letter as an EUROP report candidate", async () => {
    const reviewed = getIndependentAssuranceManifest("EUROP");
    const letter = "https://schuman.io/wp-content/uploads/2026/10/2026.09.30-Schuman-_-Salvus-Attestation_Letter-Signed-All.pdf";
    const auditorReport = "https://schuman.io/wp-content/uploads/2026/10/2026.09.30-Salvus-Rapport_Commissiaires_Comptes.pdf";
    expect(EUROP_INDEPENDENT_ASSURANCE_PROFILE.isReportCandidate(letter, "")).toBe(true);
    expect(EUROP_INDEPENDENT_ASSURANCE_PROFILE.isReportCandidate(auditorReport, "")).toBe(false);
    const media = JSON.stringify([{ source_url: reviewed.reportUrl }, { source_url: letter }, { source_url: auditorReport }]);
    await expect(
      verifyFixtureIndex("EUROP", EUROP_INDEPENDENT_ASSURANCE_PROFILE, "europ-independent-assurance.html", media, true),
    ).resolves.toMatchObject({ newerUnreviewedReport: { reportDate: "2026-09-30", reportUrl: letter } });
  });

  it("ignores an unrelated StraitsX whitepaper and reports a newer XSGD report as unreviewed", async () => {
    const fixture = "straitsx-independent-assurance-xsgd.html";
    await expect(
      verifyFixtureIndex("XSGD", straitsxIndependentAssuranceProfile("XSGD"), fixture),
    ).rejects.toThrow("PDF byte length");

    const withNewReport = indexFixture(fixture) +
      '<button data-gated-asset="XSGD Attestation Report October 2026" data-gated-url="https://cdn.prod.website-files.com/6119d1f2b05f8e65b1739721/XSGD_SCS_Reserve_Account_Report_(31_October_2026).pdf"></button>';
    await expect(
      verifyFixtureIndex("XSGD", straitsxIndependentAssuranceProfile("XSGD"), fixture, withNewReport, true),
    ).resolves.toMatchObject({ newerUnreviewedReport: { reportDate: "2026-10-31" } });
  });

  it("still fails closed when the USDGO family has two reports for the reviewed latest date", async () => {
    const fixture = "usdgo-transparency.html";
    const ambiguous = indexFixture(fixture) +
      '<a href="https://learn.anchorage.com/09.30.26_USDGO-Stablecoin-Attestation-Report-revised.pdf">Sep revised</a>';
    await expect(
      verifyFixtureIndex("USDGO", USDGO_INDEPENDENT_ASSURANCE_PROFILE, fixture, ambiguous),
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
        // A newer report passes discovery and still meets the pinned PDF identity gate.
        { name: "newer unreviewed report", config, html: reviewedCandidate + newerCandidate, pdf: PDF_BYTES, error: "PDF byte length" },
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

  it("fails reconciliation when a positive StraitsX liability is omitted", () => {
    for (const product of ["XUSD", "XSGD"] as const) {
      const reviewed = getIndependentAssuranceManifest(product);
      expect(reconcileIndependentAssuranceManifest(reviewed)).toMatchObject({
        reportedAssetDifference: "0",
        reportedLiabilityDifference: "0",
      });
    }
    const xsgd = getIndependentAssuranceManifest("XSGD");
    expect(() => reconcileIndependentAssuranceManifest({
      ...xsgd,
      liabilities: xsgd.liabilities.filter((row) => row.code !== "xlayer"),
    })).toThrow(/liability total .* does not match manifest/);
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

  it("rejects a zero reported asset total before computing a relative difference", () => {
    const zeroAssets = manifest({
      assets: [{ code: "cash", label: "Cash", amount: "0" }],
      computedAssetTotal: "0",
      reportedAssetTotal: "0",
    });
    expect(() => reconcileIndependentAssuranceManifest(zeroAssets))
      .toThrow("reported asset total must be greater than zero");
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

  it.each([
    ["reserve-verification-report-2026-09-30.pdf", "Supply Reporting (Monthly)", "2026-09-30"],
    ["reserve-verification-report-2026-09-31.pdf", "Supply Reporting (Monthly)", null],
    ["reserve-verification-report-2026-09-30.pdf", "as at 1st October 2026", null],
    ["261001 Catena Reserve Verification Report as at 30th Sept 2026.pdf", "", "2026-09-30"],
    ["261001 Catena Reserve Verification Report.pdf", "Verification of AUDM Reserves as at 30th September 2026", "2026-09-30"],
    ["260901 Catena Reserve Verification Report as at 1st September 2026.pdf", "", "2026-09-01"],
    ["261001 Catena Reserve Verification Report as at 30th Sept 2026.pdf", "as at 1st October 2026", null],
    ["261001 Catena Reserve Verification Report as at 31st Sept 2026.pdf", "", null],
    ["Reserve Verification Report.pdf", "", null],
    ["261001 Catena Reserve Verification Report as at September 2026.pdf", "", null],
  ])("uses an unambiguous AUDM reserve period for %s", (fileName, text, expected) => {
    expect(AUDM_INDEPENDENT_ASSURANCE_PROFILE.reportDateFromCandidate(
      `https://cdn.prod.website-files.com/${encodeURIComponent(fileName)}`, text,
    )).toBe(expected);
  });

  it("recognizes the migrated AUDM monthly report without treating the quarterly AUP as that report", () => {
    expect(AUDM_INDEPENDENT_ASSURANCE_PROFILE.isReportCandidate(
      "https://docs.macropod.com/legal/reserve-verification-report-31st-october-2026.pdf", "Supply Reporting (Monthly)",
    )).toBe(true);
    expect(AUDM_INDEPENDENT_ASSURANCE_PROFILE.isReportCandidate(
      "https://docs.macropod.com/legal/agreed-upon-procedures-report-2026-06.pdf", "Independent Quarterly Reconciliation",
    )).toBe(false);
  });

  it("verifies the migrated AUDM monthly index before checking exact report bytes", async () => {
    const reviewed = getIndependentAssuranceManifest("AUDM");
    // The live index dates the ordinal-filename link through its anchor label.
    const html = `<a href="${reviewed.reportUrl}">Supply Reporting (Monthly)Monthly reports detailing supply, reserves, and issued tokens. Latest: as at 31 October 2026.</a>
      <a href="https://docs.macropod.com/legal/agreed-upon-procedures-report-2026-06.pdf">Independent Quarterly Reconciliation</a>`;
    await expect(verifyFixtureIndex("AUDM", AUDM_INDEPENDENT_ASSURANCE_PROFILE, "", html))
      .rejects.toThrow("PDF byte length");
    await expect(verifyFixtureIndex("AUDM", AUDM_INDEPENDENT_ASSURANCE_PROFILE, "",
      `${html}<a href="https://docs.macropod.com/legal/reserve-verification-report-2026-11-30.pdf">Monthly report</a>`, true))
      .resolves.toMatchObject({ newerUnreviewedReport: { reportDate: "2026-11-30" } });
  });

  it.each([
    ["ambiguous", "Reserve Verification Report as at 30th Sept 2026.pdf", "as at 1st October 2026"],
    ["mixed ISO", "Reserve Verification Report as at 30th Sept 2026.pdf", "as at 2026-10-01"],
    ["mixed malformed", "Reserve Verification Report as at 30th Sept 2026.pdf", "as at 1st Octember 2026"],
    ["mixed incomplete", "Reserve Verification Report as at 30th Sept 2026.pdf", "as at September 2026"],
    ["missing", "Reserve Verification Report.pdf", "Monthly report"],
  ])("rejects an AUDM index with a %s reserve date", async (_label, fileName, text) => {
    const reviewed = getIndependentAssuranceManifest("AUDM");
    const candidate = `https://cdn.prod.website-files.com/${encodeURIComponent(fileName)}`;
    // The reviewed anchor keeps the live, datable label so only the malformed
    // candidate introduces the ambiguity under test.
    await expect(verifyFixtureIndex(
      "AUDM",
      AUDM_INDEPENDENT_ASSURANCE_PROFILE,
      "",
      `<a href="${reviewed.reportUrl}">Supply Reporting (Monthly) Latest: as at 31 October 2026</a><a href="${candidate}">${text}</a>`,
    )).rejects.toThrow("ambiguous report date");
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
            return new Response(`<a href="${reviewed.reportUrl}">Supply Reporting (Monthly) Latest: as at 31 October 2026</a>`, {
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

/** Sum decimal strings in minor units without using production decimal helpers. */
function minorUnitsSum(values: readonly string[]): bigint {
  return values.reduce((sum, value) => {
    const [whole, fraction = ""] = value.split(".");
    return sum + BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  }, 0n);
}

describe("assurance adapter descriptor provenance", () => {
  it("derives evidence and origin classes from every bound assurance manifest tier", () => {
    const products = new Set<IndependentAssuranceProduct>();
    for (const adapterKey of Object.keys(INDEPENDENT_ASSURANCE_ADAPTERS)) {
      const definition = adapters.getLiveReserveAdapterDefinition(adapterKey);
      expect(definition, `missing descriptor for ${adapterKey}`).not.toBeNull();
      let boundCoins = 0;
      for (const coin of ACTIVE_STABLECOINS) {
        if (coin.liveReservesConfig?.adapter !== adapterKey) continue;
        boundCoins += 1;
        const product = (coin.liveReservesConfig.params as { product: IndependentAssuranceProduct }).product;
        products.add(product);
        const manifest = getIndependentAssuranceManifest(product);
        const independent = manifest.assuranceTier === "independent-assurance";
        expect({
          adapter: adapterKey,
          product,
          evidenceClass: definition!.evidenceClass,
          sourceOriginClass: definition!.sourceOriginClass,
        }).toEqual({
          adapter: adapterKey,
          product,
          evidenceClass: independent ? "independent" : "static-validated",
          sourceOriginClass: independent ? "independent-assurance" : "issuer-attested",
        });
        expect(definition!.primaryInputKinds).toContain("http-html");
      }
      expect(boundCoins, `no active coin is bound to ${adapterKey}`).toBeGreaterThan(0);
    }
    expect(products.size).toBeGreaterThan(0);
  });
});

const agoraManifest = getIndependentAssuranceManifest("AUSD");
const agoraProfile = AGORA_INDEPENDENT_ASSURANCE_PROFILE;
// Agora returns prepared HTML only; it reports no out-of-band newer entry.
const prepareAgora = async (...args: Parameters<NonNullable<typeof agoraProfile.prepareIndexHtml>>) =>
  (await agoraProfile.prepareIndexHtml!(...args)) as string;
const agoraFixture = "agora-transparency-2026-09-30-august.html";
const agoraFern = `/_fern-files${new URL(agoraManifest.reportUrl).pathname}`;
const agoraAnchor = (href: string) => `<a href="${href}">2026 Sep - Agora Dollar Reserve Report</a>`;
// The live index rotated to the September examination and dropped the August
// link; the frozen August capture plus the served September anchor reproduces it.
const agoraCurrentIndex = () => indexFixture(agoraFixture) + agoraAnchor(agoraFern);

afterEach(() => vi.unstubAllGlobals());

describe("Agora reviewed September examination", () => {
  it("parses Fern dates across report naming conventions", () => {
    const date = agoraProfile.reportDateFromCandidate!;
    expect(date("https://x/2026%20Jul%20-%20Agora%20Dollar%20Reserve%20Report.pdf", "2026 Jul - Agora Dollar Reserve Report")).toBe("2026-07-31");
    expect(date("https://x/2026%20Jun%20-%20Agora%20Dollar%20Reserve%20Report.pdf", "")).toBe("2026-06-30");
    expect(date("https://x/Management%20Report%20on%20Agora%20Dollar%20and%20Reserve%20Assets%20as%20of%2012.31.25.pdf", "")).toBe("2025-12-31");
    expect(date("https://x/other.pdf", "")).toBeNull();
  });

  it("rewrites the signed reviewed report while keeping older transport links", async () => {
    const signed = agoraManifest.reportUrl.replace("files.buildwithfern.com", "fdr-prod-docs-files-public.s3.us-east-1.amazonaws.com") + "?X-Amz-Signature=abcd";
    const august = "https://fdr-prod-docs-files-public.s3.us-east-1.amazonaws.com/agora.docs.buildwithfern.com/444c4f3a9642d6a9149e8fa9736469cd03192f55cc7ff3d2326117b0397875b5/docs/assets/2026%20Aug%20-%20Agora%20Dollar%20Reserve%20Report.pdf?X-Amz-Signature=efgh";
    const may = "https://files.buildwithfern.com/agora.docs.buildwithfern.com/938a11767a399cc2cfd2a15efc4cdfab65a53e59402e61c9e166b5354b5c9673/docs/assets/2026%20May%20-%20Agora%20Dollar%20Reserve%20Report.pdf";
    const prepared = await prepareAgora([signed, august, may].map(href => `<a href="${href}">report</a>`).join("\n"), new AbortController().signal);
    expect(collectPdfAnchors(prepared)).toEqual([
      { href: agoraManifest.reportUrl, text: "report" },
      { href: august, text: "report" },
      { href: may, text: "report" },
    ]);
  });

  it("accepts a single already-stable reviewed link", async () => {
    const prepared = await prepareAgora(agoraAnchor(agoraManifest.reportUrl), new AbortController().signal);
    expect(collectPdfAnchors(prepared)).toEqual([{ href: agoraManifest.reportUrl, text: "2026 Sep - Agora Dollar Reserve Report" }]);
  });

  it("dates every report candidate in the current official capture", async () => {
    const prepared = await prepareAgora(agoraCurrentIndex(), new AbortController().signal);
    const reports = collectPdfAnchors(prepared).filter(a => /\.pdf(?:[?#]|$)/i.test(a.href) && agoraProfile.isReportCandidate(a.href, a.text));
    expect(reports.every(a => agoraProfile.reportDateFromCandidate!(a.href, a.text) !== null)).toBe(true);
  });

  it("fails closed on the frozen July index because the September reviewed link is missing", async () => {
    await expect(prepareAgora(indexFixture("agora-transparency-2026-09-30.html"), new AbortController().signal))
      .rejects.toThrow("reviewed report link missing or ambiguous");
  });

  it("binds the official Fern index to the reviewed stable artifact", async () => {
    const prepared = await prepareAgora(agoraCurrentIndex(), new AbortController().signal);
    expect(collectPdfAnchors(prepared).filter(a => a.href === agoraManifest.reportUrl)).toEqual([
      { href: agoraManifest.reportUrl, text: "2026 Sep - Agora Dollar Reserve Report" },
    ]);
    const signed = agoraManifest.reportUrl.replace("files.buildwithfern.com", "fdr-prod-docs-files-public.s3.us-east-1.amazonaws.com") + "?X-Amz-Signature=abcd";
    expect(await prepareAgora(agoraAnchor(signed), new AbortController().signal)).toContain(`href="${agoraManifest.reportUrl}"`);
  });

  it.each([
    "", agoraAnchor(agoraFern) + agoraAnchor(agoraManifest.reportUrl),
    agoraAnchor(agoraManifest.reportUrl.replace("files.buildwithfern.com", "example.com")),
    agoraAnchor(agoraFern.replace("03ab55af", "00000000")),
  ])("fails closed on missing, duplicated or drifted reviewed identity", async html => {
    await expect(prepareAgora(html, new AbortController().signal)).rejects.toThrow("reviewed report link missing or ambiguous");
  });

  it("reports a newer report as unreviewed and fails closed on undated candidates", async () => {
    const newer = "https://files.buildwithfern.com/2026%20Oct%20Agora%20Dollar%20Reserve%20Report.pdf";
    await expect(verifyFixtureIndex("AUSD", agoraProfile, agoraFixture, agoraCurrentIndex() + agoraAnchor(newer), true))
      .resolves.toMatchObject({ newerUnreviewedReport: { reportDate: "2026-10-31", reportUrl: newer } });
    await expect(verifyFixtureIndex("AUSD", agoraProfile, agoraFixture, agoraCurrentIndex() + '<a href="/Agora%20Dollar%20Reserve%20Report.pdf">Report</a>')).rejects.toThrow("ambiguous report date");
  });

  it("preserves measured categories and excludes created supply without asset netting", () => {
    expect(reconcileIndependentAssuranceManifest(agoraManifest, agoraProfile.reconciliation)).toMatchObject({
      computedAssetTotal: "219154363", liabilityTotal: "218359166", reportedAssetDifference: "1",
    });
    expect(agoraManifest.adjustments).toEqual([expect.objectContaining({ kind: "excluded-circulation", amount: "32195647" })]);
    expect(agoraManifest.adjustments![0]).not.toHaveProperty("alreadyNettedIntoAssets");
    expect(() => reconcileIndependentAssuranceManifest({ ...agoraManifest, reportedAssetTotal: "219154366" }, agoraProfile.reconciliation)).toThrow("reported asset total");
  });

  it("requires netted asset adjustments to declare their accounting treatment", () => {
    const adjustment = { code: "net-cash", label: "Net cash", amount: "-1", treatment: "Already deducted from asset row" };
    expect(IndependentAssuranceManifestSchema.safeParse({ ...agoraManifest, adjustments: [adjustment] }).success).toBe(false);
    expect(IndependentAssuranceManifestSchema.safeParse({ ...agoraManifest, adjustments: [{ ...adjustment, alreadyNettedIntoAssets: true }] }).success).toBe(true);
    expect(IndependentAssuranceManifestSchema.safeParse({ ...agoraManifest, adjustments: [{ ...adjustment, kind: "excluded-circulation" }] }).success).toBe(true);
  });
});

describe("anchorage-independent-assurance (Deloitte Anchorage examinations)", () => {
  it("reconciles September reserves with both chain redeemable liabilities", () => {
    const manifest = getIndependentAssuranceManifest("USAT");
    expect(manifest.assuranceTier).toBe("independent-assurance");
    expect(manifest.conclusion).toBe("unmodified");
    expect(manifest.attestorIdentification).toMatchObject({
      method: "reviewed-inference",
      evidence: [expect.any(String), expect.any(String)],
      reReviewTrigger: expect.any(String),
    });
    // The report clock is bound to the reviewed report date instead of a literal
    // that every new monthly report rewrites.
    expect(independentAssuranceSourceTimestamp(manifest)).toBe(Date.parse(manifest.reportAsOf) / 1000);
    // Reconciliation itself enforces computed-total-equals-sum and the cent bound.
    expect(reconcileIndependentAssuranceManifest(manifest).reportedAssetDifference).toBe("0");
    // Independent bigint sum: assets total the manifest's computed total without
    // trusting the reconciler's own decimal sum.
    expect(minorUnitsSum(manifest.assets.map((row) => row.amount))).toBe(minorUnitsSum([manifest.computedAssetTotal]));
    const codes = manifest.liabilities.map((row) => row.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const row of manifest.liabilities) expect(Number(row.amount)).toBeGreaterThan(0);
  });

  it("selects the reviewed USDPT report on the USDPT index and names a newer unreviewed report", async () => {
    const reviewed = getIndependentAssuranceManifest("USDPT");
    const html =
      '<div class="accordion-dates-grid">' +
      '<a href="https://learn.anchorage.com/05.31.26_USDPT_Stablecoin_Attestation_Report_signed.pdf">May</a>' +
      '<a href="https://learn.anchorage.com/06.30.26_USDPT-Stablecoin-Attestation-Report.pdf">Jun</a>' +
      `<a href="${reviewed.reportUrl}">Sep</a>` +
      "</div>";
    await expect(verifyFixtureIndex(
      "USDPT", USDPT_INDEPENDENT_ASSURANCE_PROFILE, "anchorage-independent-assurance.html", html,
    )).rejects.toThrow("PDF byte length");

    const newer = html.replace(
      "</div>",
      '<a href="https://learn.anchorage.com/10.31.26_USDPT-Stablecoin-Attestation-Report.pdf">Oct</a></div>',
    );
    await expect(verifyFixtureIndex(
      "USDPT", USDPT_INDEPENDENT_ASSURANCE_PROFILE, "anchorage-independent-assurance.html", newer, true,
    )).resolves.toMatchObject({
      newerUnreviewedReport: { reportDate: "2026-10-31", reportUrl: "https://learn.anchorage.com/10.31.26_USDPT-Stablecoin-Attestation-Report.pdf" },
    });
  });

});

describe("audd-independent-assurance (William Buck ASRS 4400 AUP)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reviews the September 2026 agreed-upon-procedures report and reconciles every chain's circulation", () => {
    const manifest = getIndependentAssuranceManifest("AUDD");
    expect(manifest.assuranceTier).toBe("agreed-upon-procedures");
    // Reconciliation recomputes both totals from the reviewed rows and admits the
    // report's reported cent-rounding difference within the profile's bound.
    expect(reconcileIndependentAssuranceManifest(manifest, AUDD_INDEPENDENT_ASSURANCE_PROFILE.reconciliation))
      .toMatchObject({
        computedAssetTotal: "11289945.05",
        liabilityTotal: "11159088.48",
        reportedAssetDifference: "0",
        reportedLiabilityDifference: "0.01",
      });
    for (const chain of ["stellar", "xrpl", "ethereum", "solana", "hedera", "base", "xdc", "redbelly", "arc"]) {
      expect(manifest.liabilities.some((row) => row.code === chain && Number(row.amount) > 0)).toBe(true);
    }
    const codes = manifest.liabilities.map((row) => row.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const row of manifest.liabilities) expect(Number(row.amount)).toBeGreaterThan(0);
  });

  it("rejects discrepancies beyond the cent-rounding bound or relative cap", () => {
    const manifest = getIndependentAssuranceManifest("AUDD");
    for (const reportedLiabilityTotal of ["11159088.54", "11159088.42"]) {
      expect(() => reconcileIndependentAssuranceManifest(
        { ...manifest, reportedLiabilityTotal }, AUDD_INDEPENDENT_ASSURANCE_PROFILE.reconciliation,
      )).toThrow("reported liability total differs");
    }
    expect(() => reconcileIndependentAssuranceManifest({
      ...manifest,
      liabilities: [{ code: "small", label: "Small circulation", amount: "1.00" }],
      reportedLiabilityTotal: "1.01",
    }, AUDD_INDEPENDENT_ASSURANCE_PROFILE.reconciliation)).toThrow("reported liability total differs");
  });

  it("rejects a candidate whose date cannot be derived from its filename", async () => {
    const html = indexFixture("audd-independent-assurance.html") +
      '<a href="https://www.audd.digital/wp-content/uploads/2026/10/AUDC-Agreed-upon-procedures-report-Undated.pdf">Undated</a>';
    await expect(verifyFixtureIndex(
      "AUDD", AUDD_INDEPENDENT_ASSURANCE_PROFILE, "audd-independent-assurance.html", html,
    )).rejects.toThrow("ambiguous report date");
  });

});

describe("cadd-independent-assurance (Baker Tilly CSAE 3000)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reviews the September 30 2026 reasonable assurance report and reconciles CAD circulation across Base, Tempo and Ethereum", () => {
    const manifest = getIndependentAssuranceManifest("CADD");
    expect(manifest.assuranceTier).toBe("independent-assurance");
    expect(manifest.conclusion).toBe("unmodified");
    expect(manifest.attestor).toBe("Baker Tilly WM LLP");
    expect(manifest.reportAsOf).toBe("2026-09-30T23:59:00Z");
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({
      computedAssetTotal: "1320001.34",
      liabilityTotal: "1319658.34",
      reportedAssetDifference: "0",
      reportedLiabilityDifference: "0",
    });
    expect(manifest.assets).toEqual([
      { code: "cad-cash", label: "Canadian Dollar Cash", amount: "1320001.34" },
    ]);
    expect(manifest.liabilities).toHaveLength(1);
    const liability = manifest.liabilities[0];
    for (const chain of ["Base", "Tempo", "Ethereum"]) {
      expect(liability.label).toContain(chain);
    }
    expect(liability.amount).toBe("1319658.34");
  });

  it("rewrites Drive share links to direct downloads and dates candidates from anchor text", async () => {
    const prepared = await CADD_INDEPENDENT_ASSURANCE_PROFILE.prepareIndexHtml!(
      indexFixture("cadd-independent-assurance.html"),
      new AbortController().signal,
      undefined,
    );
    expect(prepared).not.toContain("view?usp=sharing");
    expect(prepared).toContain(
      getIndependentAssuranceManifest("CADD").reportUrl,
    );
    const date = CADD_INDEPENDENT_ASSURANCE_PROFILE.reportDateFromCandidate!;
    expect(date("", "June 2026 attestation")).toBe("2026-06-30");
    expect(date("", "July 2026 attestation")).toBe("2026-07-31");
    expect(date("", "August 2026 attestation")).toBe("2026-08-31");
    expect(date("", "September 2026 attestation")).toBe("2026-09-30");
    expect(date("", "Daily Reserve Ratio Reports")).toBeNull();
    expect(
      CADD_INDEPENDENT_ASSURANCE_PROFILE.isReportCandidate(
        "",
        "Daily Reserve Ratio Reports ",
      ),
    ).toBe(false);
    expect(
      CADD_INDEPENDENT_ASSURANCE_PROFILE.isReportCandidate(
        "",
        "June 2026 attestation",
      ),
    ).toBe(true);
  });

  it("rejects an attestation whose anchor text carries no date", async () => {
    const html = indexFixture("cadd-independent-assurance.html") +
      '<a href="https://drive.google.com/file/d/1AAAAAAA/view?usp=sharing">Attestation</a>';
    await expect(verifyFixtureIndex(
      "CADD", CADD_INDEPENDENT_ASSURANCE_PROFILE, "cadd-independent-assurance.html", html,
    )).rejects.toThrow("ambiguous report date");
  });

});

const ROOT_RECORD = {
  recordMap: {
    block: {
      [BRLA_NOTION_PIN.rootPageId]: {
        spaceId: "space",
        value: {
          value: {
            id: BRLA_NOTION_PIN.rootPageId,
            type: "page",
            properties: { title: [[BRLA_NOTION_PIN.rootPageTitle]] },
            content: BRLA_NOTION_PIN.rootContent,
          },
        },
      },
    },
  },
};

const YEAR_RECORD = {
  recordMap: {
    block: {
      [BRLA_NOTION_PIN.yearBlockId]: {
        spaceId: "space",
        value: {
          value: {
            id: BRLA_NOTION_PIN.yearBlockId,
            type: "header",
            properties: { title: [[BRLA_NOTION_PIN.yearTitle]] },
          },
        },
      },
      [BRLA_NOTION_PIN.reportBlockId]: {
        spaceId: "space",
        value: {
          value: {
            id: BRLA_NOTION_PIN.reportBlockId,
            type: "file",
            properties: {
              title: [[BRLA_NOTION_PIN.attachmentTitle]],
              source: [[BRLA_NOTION_PIN.attachmentSource]],
            },
          },
        },
      },
    },
  },
};

const SIGNED_URL = `https://file.notion.com/f/f/space/${BRLA_NOTION_PIN.attachmentId}/Avenia_-_Transparency_Report_-_20260930_(Audit_Attestation).pdf?table=block&id=${BRLA_NOTION_PIN.reportBlockId}&spaceId=space&expirationTimestamp=1792454400000&signature=signature`;

function installBrlaFetch(options: { rootRecord?: unknown; yearRecord?: unknown; signedUrl?: string; indexUrl?: string } = {}) {
  const {
    rootRecord = ROOT_RECORD,
    yearRecord = YEAR_RECORD,
    signedUrl = SIGNED_URL,
    indexUrl = "https://brladigital.notion.site/BRLA-Transparency-Page-238ba143aa2f4338902ee91ebe50298a",
  } = options;
  const loadPageChunkUrl = "https://brladigital.notion.site/api/v3/loadPageChunk";
  const signedFileUrlsUrl = "https://brladigital.notion.site/api/v3/getSignedFileUrls";
  return installAdapterNetwork({
    html: { [indexUrl]: "<html>official index</html>" },
    json: {
      [loadPageChunkUrl]: async (request: Request) => {
        const body = JSON.parse(await request.clone().text()) as { pageId?: string };
        const record = body.pageId === BRLA_NOTION_PIN.rootPageId
          ? rootRecord
          : body.pageId === BRLA_NOTION_PIN.yearBlockId
            ? yearRecord
            : { recordMap: { block: {} } };
        return { json: record, url: request.url };
      },
      [signedFileUrlsUrl]: { json: { signedUrls: [signedUrl] }, url: signedFileUrlsUrl },
      [signedUrl]: new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        headers: { "content-type": "application/pdf" },
      }),
    },
  });
}

const discoveryArgs = (overrides: Record<string, unknown> = {}) => ({
  manifest: getIndependentAssuranceManifest("BRLA"),
  indexUrl: "https://brladigital.notion.site/BRLA-Transparency-Page-238ba143aa2f4338902ee91ebe50298a",
  indexHost: "brladigital.notion.site",
  reportHosts: ["file.notion.so", "file.notion.com"],
  signal: AbortSignal.timeout(1000),
  ...overrides,
});

describe("BRLA Notion reviewed discovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves the reviewed September report through pinned block identity", async () => {
    installBrlaFetch();
    const result = await verifyBrlaNotionDiscovery(discoveryArgs());
    expect(result.signedUrl).toBe(SIGNED_URL);
    expect(result.sourceTimestamp).toBe(Math.floor(Date.parse("2026-09-30T23:59:59+00:00") / 1000));
  });

  it("retains the original examined instant, conclusion and exact September artifact", () => {
    const manifest = getIndependentAssuranceManifest("BRLA");
    expect(manifest).toMatchObject({
      reportDate: "2026-09-30",
      reportAsOf: "2026-09-30T23:59:59+00:00",
      reportIssuedAt: "2026-10-16T13:50:19-03:00",
      conclusion: "unmodified",
      assuranceTier: "independent-assurance",
      reportSha256: "fae95580de235d577bbfd92b384d33b9bde0c8105b16180aeb18edf6ed6602f4",
      reportByteLength: 887263,
      extraction: { pageCount: 5 },
    });
    expect(manifest.reportUrl).toContain("/6674dccd-e58f-4da9-a3d1-c4ae0d676fea/");
    expect(BRLA_NOTION_PIN.reportBlockId).toBe("3fb7f28f-0ae4-8083-9016-e7b53db36574");
    expect(BRLA_NOTION_PIN.attachmentId).toBe("6674dccd-e58f-4da9-a3d1-c4ae0d676fea");
    expect(manifest.assets.map(({ amount }) => amount)).toEqual(["72064692.29", "60103684.97"]);
    const { slices, warnings } = buildBrlaReserveSlices(manifest);
    expect(slices[0]).toMatchObject({ pct: expect.closeTo(54.524913, 6), assetClass: "cash" });
    expect(slices[1]).toMatchObject({
      pct: expect.closeTo(45.475087, 6), assetClass: "repo",
      issuerOrObligor: "BTG Pactual and XP Investimentos; Brazilian corporate debentures as collateral",
    });
    expect(warnings).toEqual([]);
  });

  it("fails closed when the root page title drifts", async () => {
    installBrlaFetch({
      rootRecord: {
        recordMap: {
          block: {
            [BRLA_NOTION_PIN.rootPageId]: {
              spaceId: "space",
              value: { value: { id: BRLA_NOTION_PIN.rootPageId, type: "page", properties: { title: [["Rebranded page"]] }, content: BRLA_NOTION_PIN.rootContent } },
            },
          },
        },
      },
    });
    await expect(verifyBrlaNotionDiscovery(discoveryArgs())).rejects.toThrow("page identity drifted");
  });

  it("fails closed when the root child tree changes (e.g. a new year group)", async () => {
    installBrlaFetch({
      rootRecord: {
        recordMap: {
          block: {
            [BRLA_NOTION_PIN.rootPageId]: {
              spaceId: "space",
              value: { value: { id: BRLA_NOTION_PIN.rootPageId, type: "page", properties: { title: [[BRLA_NOTION_PIN.rootPageTitle]] }, content: [...BRLA_NOTION_PIN.rootContent, "new-block-id"] } },
            },
          },
        },
      },
    });
    await expect(verifyBrlaNotionDiscovery(discoveryArgs())).rejects.toThrow("index structure changed");
  });

  it("fails closed when the report attachment drifts", async () => {
    installBrlaFetch({
      yearRecord: {
        recordMap: {
          block: {
            [BRLA_NOTION_PIN.yearBlockId]: YEAR_RECORD.recordMap.block[BRLA_NOTION_PIN.yearBlockId],
            [BRLA_NOTION_PIN.reportBlockId]: {
              spaceId: "space",
              value: {
                value: {
                  id: BRLA_NOTION_PIN.reportBlockId,
                  type: "file",
                  properties: {
                    title: [[BRLA_NOTION_PIN.attachmentTitle]],
                    source: [["attachment:drifted:Avenia_-_Transparency_Report_-_20260930_(Audit_Attestation).pdf"]],
                  },
                },
              },
            },
          },
        },
      },
    });
    await expect(verifyBrlaNotionDiscovery(discoveryArgs())).rejects.toThrow("attachment drifted");
  });

  it("keeps the reviewed report and names a newer unreviewed report in the 2026 tree", async () => {
    const octoberBlockId = "4d77f28f-0ae4-80fb-bd17-f3ca9b5d3490";
    installBrlaFetch({
      yearRecord: {
        recordMap: {
          block: {
            ...YEAR_RECORD.recordMap.block,
            [octoberBlockId]: {
              spaceId: "space",
              value: {
                value: {
                  id: octoberBlockId,
                  type: "file",
                  properties: { title: [["Avenia - Transparency Report - 20261031 (Audit Attestation).pdf"]] },
                },
              },
            },
          },
        },
      },
    });
    await expect(verifyBrlaNotionDiscovery(discoveryArgs())).resolves.toMatchObject({
      newerUnreviewedReport: { reportDate: "2026-10-31" },
    });
  });

  it("fails closed when the signed URL identity drifts", async () => {
    installBrlaFetch({ signedUrl: "https://file.notion.so/f/f/space/other-attachment/report.pdf?table=block&id=other-block&signature=x" });
    await expect(verifyBrlaNotionDiscovery(discoveryArgs())).rejects.toThrow("signed URL attachment identity drifted");
  });

  it("fails closed on a non-reviewed signed URL host", async () => {
    installBrlaFetch({ signedUrl: `https://evil.example/${BRLA_NOTION_PIN.attachmentId}/report.pdf?table=block&id=${BRLA_NOTION_PIN.reportBlockId}` });
    await expect(verifyBrlaNotionDiscovery(discoveryArgs())).rejects.toThrow("signed URL host is not reviewed");
  });

  it("reconciles all four chain liabilities to BRL and rejects an omitted chain", () => {
    const manifest = getIndependentAssuranceManifest("BRLA");
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({
      computedAssetTotal: "132168377.26",
      liabilityTotal: "129478160.68",
    });
    expect(manifest.liabilities).toContainEqual({ code: "moonbeam", label: "Moonbeam Chain BRLA redeemable tokens", amount: "4294.09" });
    expect(() => reconcileIndependentAssuranceManifest({
      ...manifest,
      liabilities: manifest.liabilities.filter((row) => row.code !== "moonbeam"),
    })).toThrow("liability total 129473866.59 does not match manifest 129478160.68");
  });
});

describe("BRLA PDF byte verification", () => {
  afterEach(() => vi.unstubAllGlobals());

  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xaa, 0xbb]);
  const manifest = {
    ...getIndependentAssuranceManifest("BRLA"),
    reportSha256: createHash("sha256").update(bytes).digest("hex"),
    reportByteLength: bytes.length,
  };

  function installBinaryFetch(changed = false) {
    const body = changed
      ? (() => {
        const next = new Uint8Array(bytes);
        next[next.length - 1] = 0xcc;
        return next;
      })()
      : bytes;
    return installAdapterNetwork({
      json: {
        [SIGNED_URL]: new Response(body, { headers: { "content-type": "application/pdf" } }),
      },
    });
  }

  it("accepts reviewed bytes", async () => {
    installBinaryFetch();
    const result = await fetchAndVerifyBrlaPdf({
      manifest,
      signedUrl: SIGNED_URL,
      reportHosts: ["file.notion.so", "file.notion.com"],
      signal: AbortSignal.timeout(1000),
    });
    expect(result.byteLength).toBe(bytes.length);
  });

  it("rejects drifted bytes", async () => {
    installBinaryFetch(true);
    await expect(fetchAndVerifyBrlaPdf({
      manifest,
      signedUrl: SIGNED_URL,
      reportHosts: ["file.notion.so", "file.notion.com"],
      signal: AbortSignal.timeout(1000),
    })).rejects.toThrow("PDF SHA-256");
  });
});

describe("BRLA asset classification", () => {
  it("publishes an unknown-class slice and degrades for an unreviewed asset code", () => {
    const reviewed = getIndependentAssuranceManifest("BRLA");
    const withUnknown = {
      ...reviewed,
      assets: [...reviewed.assets, { code: "unreviewed-holdings", label: "Unreviewed holdings", amount: "123.45" }],
    };

    const { slices, unknownExposurePct, warnings } = buildBrlaReserveSlices(withUnknown);

    const unreviewed = slices.find((slice) => slice.sourceKey === "brla-independent-assurance:brla:unreviewed-holdings");
    expect(unreviewed).toMatchObject({ name: "Unreviewed holdings", risk: "high", liquidityHorizon: "unknown" });
    expect(unreviewed).not.toHaveProperty("assetClass");
    expect(unknownExposurePct).toBeGreaterThan(0);
    expect(warnings).toEqual([expect.objectContaining({
      code: "brla-asset-code-unclassified",
      effect: "degraded",
    })]);
  });

  it("rejects an unparsable asset amount", () => {
    const reviewed = getIndependentAssuranceManifest("BRLA");
    const garbage = {
      ...reviewed,
      assets: [{ code: "cash-and-cash-equivalents", label: "Cash", amount: "not-a-number" }],
    };

    expect(() => buildBrlaReserveSlices(garbage)).toThrow("unparsable asset amount");
  });
});

import { describe, expect, it } from "vitest";
import { adaptRippleTransparency, parseRippleReserveBreakdown } from "../ripple-transparency";
import { expectWarnings, installAdapterNetwork, runAdapter } from "./reserve-adapter.test-support";

const RIPPLE_HTML = `
<h5>Total Circulating RLUSD</h5>
<p>$1,443.7M</p>
<h5>RLUSD Reserve Funds</h5>
<p>$1,546.6M</p>
<p>As of <!-- -->04/30/2026</p>
`;

const RIPPLE_HTML_WITH_BREAKDOWN = `
<h5>Total Circulating RLUSD</h5>
<p>$1,443.7M</p>
<h5>RLUSD Reserve Funds</h5>
<p>$1,546.6M</p>
<p>As of <!-- -->04/30/2026</p>
<table>
<tr><td>U.S. Treasury bills</td><td>60.10%</td></tr>
<tr><td>Government money-market funds</td><td>25.20%</td></tr>
<tr><td>Cash and deposit accounts</td><td>14.70%</td></tr>
</table>
`;

/**
 * Trimmed 2026-09-11 capture of
 * https://ripple.com/solutions/stablecoin/transparency/ (same document behind
 * the /products/stablecoin/transparency/ redirect): the marketing paragraphs,
 * the live Balances block, and the Attestations copy. The live payload
 * publishes no asset-class percentage breakdown; the reserve classes appear
 * only in this prose and inside the linked monthly Deloitte report PDFs.
 */
const RIPPLE_HTML_LIVE = `
<div class="[&amp;&gt;*:last-child]:mb-0 body3 lg:body2"><p class="mb-[1em] last:mb-0"><a class="text-newblue-50 hover:underline decoration-current" target="_blank" rel="noopener noreferrer" href="/products/stablecoin/">Ripple USD (RLUSD)</a> is a USD stablecoin designed for institutions, created with trust and compliance at its core. RLUSD is backed by U.S. dollars and other cash equivalents, with reserves held in segregated accounts.</p><p class="mb-[1em] last:mb-0">Standard Custody, the issuer of RLUSD, is chartered and supervised by NYDFS as a limited purpose trust company, which means our stablecoin is required to be backed 100% by highly liquid, short-term, transparent reserves. Standard Custody adheres to high safety and soundness standards, including NYDFS customer protection and reserve requirements, as well as redemptions with strict SLAs.<br/></p></div>
<div class="p-8 rounded-lg shadow-heavy-24 mt-8 flex flex-col w-full text-center"><h5 class="heading3 md:heading2 mb-4">Total Circulating RLUSD</h5><p class="headline3 md:headline2 blue-gradient-light">$2,395.6M</p><h5 class="heading3 md:heading2 mb-4 mt-10">RLUSD Reserve Funds</h5><p class="headline3 md:headline2 blue-gradient-light">$2,517.7M</p><p class="mt-8 md:mt-10 text-gray-50 caption1">As of <!-- -->09/03/2026</p></div>
<h4 class="heading1 md:headline4 mb-8">Attestations*</h4><div class="w-full body3 lg:body2 text-gray-70"><p class="mb-[1em] last:mb-0">Attestations are performed by an independent Certified Public Accountant (CPA) licensed in the United States. The CPA issues monthly attestation reports pertaining to management’s assertions regarding the amount of RLUSD in circulation, along with information pertaining to the composition of the RLUSD Reserve fund.</p></div>
<a href="https://cdn.sanity.io/files/ior4a5y3/production/5a9121caa4206788930869cac0f868e5841d7fae.pdf/RLUSD_Attestation_Report_-_June'26_FINAL.pdf">Jun</a>
`;

describe("adaptRippleTransparency", () => {
  it("parses RLUSD reserves and source timestamp", () => {
    const result = adaptRippleTransparency(RIPPLE_HTML);

    expect(result.metadata).toMatchObject({
      circulatingUsd: 1_443_700_000,
      reservesUsd: 1_546_600_000,
      collateralizationRatio: 1_546_600_000 / 1_443_700_000,
      freshnessMode: "verified",
      sourceTimestamp: Date.UTC(2026, 3, 30) / 1000,
    });
    expectWarnings(result, ["attested-fallback-used"]);
  });

  it("itemizes slices per the attested May 2026 composition when the payload lacks a breakdown", () => {
    const result = adaptRippleTransparency(RIPPLE_HTML);

    expect(result.slices).toEqual([
      {
        sourceKey: "ripple-transparency:treasury-bills",
        name: "U.S. Treasury bills",
        pct: 65.41,
        risk: "very-low",
        assetClass: "treasury-bill",
        issuerOrObligor: "United States Treasury",
        riskFactors: ["duration", "liquidity", "custody"],
        liquidityHorizon: "one-day",
        maturityDaysMax: 92,
      },
      {
        sourceKey: "ripple-transparency:government-mmf",
        name: "Government money-market funds",
        pct: 19.44,
        risk: "very-low",
        assetClass: "money-market-fund",
        issuerOrObligor: "DFS-approved government money-market funds",
        riskFactors: ["counterparty", "liquidity", "custody"],
        liquidityHorizon: "one-day",
      },
      {
        sourceKey: "ripple-transparency:cash",
        name: "Cash and deposit accounts",
        pct: 15.15,
        risk: "very-low",
        assetClass: "bank-deposit",
        issuerOrObligor: "DFS-approved depository institutions",
        riskFactors: ["counterparty", "custody", "concentration"],
        liquidityHorizon: "immediate",
      },
    ]);
  });

  it("reads the live payload's balances and reports the missing breakdown as absent, not malformed", () => {
    const result = adaptRippleTransparency(RIPPLE_HTML_LIVE);

    expect(result.metadata).toMatchObject({
      circulatingUsd: 2_395_600_000,
      reservesUsd: 2_517_700_000,
      collateralizationRatio: 2_517_700_000 / 2_395_600_000,
      freshnessMode: "verified",
      sourceTimestamp: Date.UTC(2026, 8, 3) / 1000,
    });
    expect(result.slices.map((slice) => [slice.name, slice.pct])).toEqual([
      ["U.S. Treasury bills", 65.41],
      ["Government money-market funds", 19.44],
      ["Cash and deposit accounts", 15.15],
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "attested-fallback-used",
        effect: "degraded",
        message: expect.stringContaining("no asset-class breakdown"),
      }),
    ]);
  });

  it("derives the split from the payload when it carries an asset-class breakdown", () => {
    const result = adaptRippleTransparency(RIPPLE_HTML_WITH_BREAKDOWN);

    expect(result.slices.map((slice) => [slice.name, slice.pct])).toEqual([
      ["U.S. Treasury bills", 60.1],
      ["Government money-market funds", 25.2],
      ["Cash and deposit accounts", 14.7],
    ]);
    expect(result.warnings).toBeUndefined();
  });

  it("falls back to the attested split with a degraded warning when the payload breakdown does not reconcile", () => {
    const result = adaptRippleTransparency(RIPPLE_HTML_WITH_BREAKDOWN.replace("60.10%", "30.10%"));

    expect(result.slices.map((slice) => slice.pct)).toEqual([65.41, 19.44, 15.15]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "attested-fallback-used",
        effect: "degraded",
        message: expect.stringContaining("malformed asset-class breakdown"),
      }),
    ]);
  });

  it("falls back to the attested split with a degraded warning when percentages are malformed numeric tokens", () => {
    const result = adaptRippleTransparency(
      RIPPLE_HTML_WITH_BREAKDOWN.replace("60.10%", "1060.10%")
        .replace("25.20%", "1025.20%")
        .replace("14.70%", "1014.70%"),
    );

    expect(result.slices.map((slice) => slice.pct)).toEqual([65.41, 19.44, 15.15]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "attested-fallback-used",
        effect: "degraded",
        message: expect.stringContaining("malformed asset-class breakdown"),
      }),
    ]);
  });

  it("keeps the undercollateralization breaker on the aggregate ratio", () => {
    const result = adaptRippleTransparency(RIPPLE_HTML.replace("$1,546.6M", "$900.0M"));

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "attested-fallback-used",
        effect: "degraded",
      }),
      expect.objectContaining({
        code: "reserve-undercollateralized",
        effect: "degraded",
      }),
    ]);
    expect(result.slices.map((slice) => slice.pct)).toEqual([65.41, 19.44, 15.15]);
  });

  it("throws when the source date is missing", () => {
    expect(() => adaptRippleTransparency(RIPPLE_HTML.replace("04/30/2026", ""))).toThrow(/layout-changed/);
  });
});

describe("parseRippleReserveBreakdown", () => {
  it("returns null when no class labels are present", () => {
    expect(parseRippleReserveBreakdown("Total Circulating RLUSD $1,443.7M")).toBeNull();
  });

  it("returns null when a class percentage is missing", () => {
    expect(parseRippleReserveBreakdown("U.S. Treasury bills 65.41%, Government money-market funds 19.44%")).toBeNull();
  });

  it("rejects percentage suffixes inside malformed numeric tokens", () => {
    expect(
      parseRippleReserveBreakdown(
        "U.S. Treasury bills 1060.10%, Government money-market funds 1025.20%, Cash and deposit accounts 1014.70%",
      ),
    ).toBeNull();
  });

  it("does not borrow the next class percentage when the labeled token is malformed", () => {
    expect(
      parseRippleReserveBreakdown(
        "U.S. Treasury bills 1060.10%, Government money-market funds 25.20%, Cash and deposit accounts 14.70%",
      ),
    ).toBeNull();
  });

  it("rejects over-precision percentages instead of parsing a valid-looking prefix", () => {
    expect(
      parseRippleReserveBreakdown(
        "U.S. Treasury bills 60.1000000%, Government money-market funds 25.20%, Cash and deposit accounts 14.70%",
      ),
    ).toBeNull();
  });
});

describe("fetchRippleTransparencyReserves", () => {
  const url = "https://ripple.com/solutions/stablecoin/transparency/";
  const nowSec = Date.UTC(2026, 4, 1) / 1000;

  it("fetches RLUSD transparency through the shared network harness", async () => {
    const { result, network } = await runAdapter("ripple-transparency", "rlusd-ripple", {
      network: installAdapterNetwork({ html: { [url]: RIPPLE_HTML } }),
      nowSec,
    });
    expect(result.metadata).toMatchObject({ reservesUsd: 1_546_600_000 });
    expect(network.requests).toEqual([{ url, method: "GET" }]);
  });

  it("rejects a renamed reserve heading instead of publishing an attested fallback", async () => {
    await expect(runAdapter("ripple-transparency", "rlusd-ripple", {
      network: installAdapterNetwork({ html: { [url]: RIPPLE_HTML.replace("RLUSD Reserve Funds", "RLUSD Reserves") } }),
      nowSec,
      validate: false,
    })).rejects.toThrow("layout-changed");
  });
});

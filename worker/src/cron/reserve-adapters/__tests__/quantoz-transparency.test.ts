import { describe, expect, it } from "vitest";
import { adaptQuantozTransparency } from "../quantoz-transparency";
import { expectWarningEffect, expectWarnings, installAdapterNetwork, runAdapter } from "./reserve-adapter.test-support";

const QUANTOZ_HTML = `
<div class="qtr-snapshot-heading"><p><span>Published snapshot <time datetime="2026-04-20">20 April 2026</time></span></p></div>
<article class="qtr-token qtr-euro" aria-labelledby="qtr-eurq-title">
  <div class="qtr-token-head"><div><h3 id="qtr-eurq-title">EURQ</h3><p>Euro e-money token</p></div></div>
  <dl class="qtr-reserve-values">
    <div><dt>Tokens in circulation</dt><dd>€3,881,707</dd></div>
    <div class="qtr-ratio"><dt><svg aria-hidden="true"><path d="M1 1"/></svg> Reserve ratio</dt><dd>100.20%</dd></div>
  </dl>
  <div class="qtr-assets"><p class="qtr-label">Reported reserve composition</p>
    <dl>
      <div><dt><svg aria-hidden="true"><path d="M1 1"/></svg> Cash</dt><dd>30%</dd></div>
      <div><dt><svg aria-hidden="true"><path d="M1 1"/></svg> Government bonds</dt><dd>70%</dd></div>
    </dl>
  </div>
</article>
<article class="qtr-token qtr-dollar" aria-labelledby="qtr-usdq-title">
  <div class="qtr-token-head"><div><h3 id="qtr-usdq-title">USDQ</h3><p>US dollar e-money token</p></div></div>
  <dl class="qtr-reserve-values">
    <div><dt>Tokens in circulation</dt><dd>$6,099,501</dd></div>
    <div class="qtr-ratio"><dt><svg aria-hidden="true"><path d="M1 1"/></svg> Reserve ratio</dt><dd>100.67%</dd></div>
  </dl>
  <div class="qtr-assets"><p class="qtr-label">Reported reserve composition</p>
    <dl>
      <div><dt><svg aria-hidden="true"><path d="M1 1"/></svg> Cash</dt><dd>30%</dd></div>
      <div><dt><svg aria-hidden="true"><path d="M1 1"/></svg> Government bonds</dt><dd>70%</dd></div>
    </dl>
  </div>
</article>
`;

/**
 * Trimmed live markup fetched from https://www.quantoz.com/transparency on 2026-09-24 after
 * the site redesign replaced the old "Reserve Status Overview" table (`UPDATED: <date>` tagline,
 * EUR-style `€4.302.714` numbers) with per-token cards dated by a
 * `Published snapshot <time datetime="…">` heading and US-formatted numbers.
 */
const LIVE_QUANTOZ_HTML = `
<div class="qtr-snapshot-heading"><p><svg class="qv-icon" aria-hidden="true" focusable="false"></svg><span>Published snapshot <time datetime="2026-08-30">30 August 2026</time></span></p></div>
<article class="qtr-token qtr-euro" aria-labelledby="qtr-eurq-title">
  <div class="qtr-token-head"><img src="/assets/token-eurq.svg" width="78" height="78" alt=""><div><h3 id="qtr-eurq-title">EURQ</h3><p>Euro e-money token</p></div></div>
  <dl class="qtr-reserve-values">
    <div><dt>Tokens in circulation</dt><dd>€4,302,714</dd></div>
    <div class="qtr-ratio"><dt><svg class="qv-icon" aria-hidden="true" focusable="false"></svg> Reserve ratio</dt><dd>100.76%</dd></div>
  </dl>
  <div class="qtr-assets"><p class="qtr-label">Reported reserve composition</p>
    <dl>
      <div><dt><svg class="qv-icon" aria-hidden="true" focusable="false"></svg> Cash</dt><dd>33%</dd></div>
      <div><dt><svg class="qv-icon" aria-hidden="true" focusable="false"></svg> Government bonds</dt><dd>66%</dd></div>
    </dl>
  </div>
</article>
<article class="qtr-token qtr-dollar" aria-labelledby="qtr-usdq-title">
  <div class="qtr-token-head"><img src="/assets/token-usdq.svg" width="78" height="78" alt=""><div><h3 id="qtr-usdq-title">USDQ</h3><p>US dollar e-money token</p></div></div>
  <dl class="qtr-reserve-values">
    <div><dt>Tokens in circulation</dt><dd>$5,684,016</dd></div>
    <div class="qtr-ratio"><dt><svg class="qv-icon" aria-hidden="true" focusable="false"></svg> Reserve ratio</dt><dd>101.91%</dd></div>
  </dl>
  <div class="qtr-assets"><p class="qtr-label">Reported reserve composition</p>
    <dl>
      <div><dt><svg class="qv-icon" aria-hidden="true" focusable="false"></svg> Cash</dt><dd>33%</dd></div>
      <div><dt><svg class="qv-icon" aria-hidden="true" focusable="false"></svg> Government bonds</dt><dd>66%</dd></div>
    </dl>
  </div>
</article>
<section><h3>100% Highly Liquid Reserves</h3></section>
`;

const LIVE_NOW_SEC = Date.UTC(2026, 8, 11) / 1000;

describe("adaptQuantozTransparency", () => {
  it("parses EURQ reserve composition and source timestamp", () => {
    const result = adaptQuantozTransparency(QUANTOZ_HTML, "EURQ");

    expect(result.slices).toEqual([
      { sourceKey: "quantoz-transparency:government-bonds", name: "Government bonds (Netherlands, Germany, and US)", pct: 70, risk: "very-low" },
      { sourceKey: "quantoz-transparency:cash", name: "Cash deposits at Tier 1 European banks", pct: 30, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      token: "EURQ",
      totalSupply: 3_881_707,
      reserveRatioPct: 100.2,
      cashPct: 30,
      governmentBondPct: 70,
      freshnessMode: "verified",
      sourceTimestamp: Date.UTC(2026, 3, 20) / 1000,
    });
    expect(result.warnings).toBeUndefined();
  });

  it("parses USDQ reserve composition and source timestamp", () => {
    const result = adaptQuantozTransparency(QUANTOZ_HTML, "USDQ");

    expect(result.metadata).toMatchObject({
      token: "USDQ",
      totalSupply: 6_099_501,
      reserveRatioPct: 100.67,
    });
  });

  it("emits a degraded warning when the reserve ratio is below threshold", () => {
    const result = adaptQuantozTransparency(QUANTOZ_HTML.replace("100.67%", "99.00%"), "USDQ");

    expectWarnings(result, ["reserve-undercollateralized"]);
  });

  it("treats the live whole-number 33% / 66% allocation as rounding, not drift", () => {
    const result = adaptQuantozTransparency(LIVE_QUANTOZ_HTML, "EURQ");

    expect(result.slices).toEqual([
      { sourceKey: "quantoz-transparency:government-bonds", name: "Government bonds (Netherlands, Germany, and US)", pct: 67, risk: "very-low" },
      { sourceKey: "quantoz-transparency:cash", name: "Cash deposits at Tier 1 European banks", pct: 33, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      token: "EURQ",
      totalSupply: 4_302_714,
      reserveRatioPct: 100.76,
      cashPct: 33,
      governmentBondPct: 66,
      sourceTimestamp: Date.UTC(2026, 7, 30) / 1000,
    });
    // The 99% published sum stays out of the shared percentage-sum gate's raw input,
    // because the source's own rounding envelope explains it.
    expect(result.metadata?.diag).toEqual({ roundingEnvelopePct: 1, publishedAllocationSumPct: 99 });
    expectWarningEffect(result, "published-percentages-rounded", "info");
  });

  it("throws when the update timestamp is missing", () => {
    expect(() => adaptQuantozTransparency(
      QUANTOZ_HTML.replace('<span>Published snapshot <time datetime="2026-04-20">20 April 2026</time></span>', ""),
      "EURQ",
    )).toThrow(/layout-changed/);
  });

  it("fails closed when the circulation label is renamed", () => {
    expect(() => adaptQuantozTransparency(
      QUANTOZ_HTML.replace("<dt>Tokens in circulation</dt>", "<dt>Circulating supply</dt>"),
      "EURQ",
    )).toThrow(/missing or malformed EURQ total-supply column/);
  });

  it("rejects a surplus percentage inside the composition list", () => {
    const ambiguousHtml = LIVE_QUANTOZ_HTML.replace(
      "<dd>66%</dd>",
      "<dd>66%</dd><div><dt>Other bonds</dt><dd>1%</dd></div>",
    );

    expect(() => adaptQuantozTransparency(ambiguousHtml, "EURQ"))
      .toThrow("missing, reordered, or extra reserve-composition percentages");
  });
});
describe("fetchQuantozTransparencyReserves", () => {
  const url = "https://www.quantoz.com/transparency";
  const nowSec = Date.UTC(2026, 3, 20, 1) / 1000;

  it("fetches the reviewed token through the shared network harness", async () => {
    const { result, network } = await runAdapter("quantoz-transparency", "eurq-quantoz", {
      network: installAdapterNetwork({ html: { [url]: QUANTOZ_HTML } }),
      nowSec,
    });
    expect(result.metadata).toMatchObject({ token: "EURQ", totalSupply: 3_881_707 });
    expect(network.requests).toEqual([{ url, method: "GET" }]);
  });

  it("rejects a renamed snapshot heading instead of publishing stale data", async () => {
    await expect(runAdapter("quantoz-transparency", "eurq-quantoz", {
      network: installAdapterNetwork({ html: { [url]: QUANTOZ_HTML.replace("Published snapshot", "Page generated") } }),
      nowSec,
      validate: false,
    })).rejects.toThrow("layout-changed");
  });

  it.each(["eurq-quantoz", "usdq-quantoz"])(
    "keeps the live rounded allocation of %s at ok status",
    async (coinId) => {
      const { result, report } = await runAdapter("quantoz-transparency", coinId, {
        network: installAdapterNetwork({ html: { [url]: LIVE_QUANTOZ_HTML } }),
        nowSec: LIVE_NOW_SEC,
      });

      expect(result.metadata).toMatchObject({
        token: coinId.startsWith("eurq") ? "EURQ" : "USDQ",
        cashPct: 33,
        governmentBondPct: 66,
      });
      const effects = [...(result.warnings ?? []), ...report.warnings].map((warning) => warning.effect);
      expect(effects).toContain("info");
      expect(effects.filter((effect) => effect !== "info")).toEqual([]);
    },
  );

  it("degrades when the published allocation drifts past the whole-number rounding envelope", async () => {
    const { result, report } = await runAdapter("quantoz-transparency", "eurq-quantoz", {
      network: installAdapterNetwork({ html: { [url]: LIVE_QUANTOZ_HTML.replace("<dd>33%</dd>", "<dd>32%</dd>") } }),
      nowSec: LIVE_NOW_SEC,
    });

    // 98% is two points off, twice the one-point envelope two rounded categories can explain.
    expect(result.metadata?.diag).toMatchObject({ rawSumDeviation: 2, roundingEnvelopePct: 1 });
    expectWarningEffect(report, "pct-sum-deviation", "degraded");
  });

  it("fails closed when the published allocation cannot be reconciled with 100%", async () => {
    await expect(runAdapter("quantoz-transparency", "eurq-quantoz", {
      network: installAdapterNetwork({ html: { [url]: LIVE_QUANTOZ_HTML.replace("<dd>33%</dd>", "<dd>30%</dd>") } }),
      nowSec: LIVE_NOW_SEC,
      validate: false,
    })).rejects.toThrow(/sum to 96/);
  });
});

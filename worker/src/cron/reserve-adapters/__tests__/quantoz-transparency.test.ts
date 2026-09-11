import { describe, expect, it } from "vitest";
import { adaptQuantozTransparency } from "../quantoz-transparency";
import { expectWarningEffect, expectWarnings, installAdapterNetwork, runAdapter } from "./reserve-adapter.test-support";
const QUANTOZ_HTML = `
<div class="text-style-tagline gradient-normal">UPDATED: April 20th, 2026</div>
<div>Reserve Status Overview</div>
<div role="row" class="table5_item">
  <div role="cell"><div class="text-weight-medium">EURQ</div></div>
  <div role="cell"><div>€3.881.707</div></div>
  <div role="cell"><div>100,20%</div></div>
  <div role="cell"><div><strong>30% / 70%</strong></div></div>
</div>
<div role="row" class="table5_item">
  <div role="cell"><div class="text-weight-medium">USDQ</div></div>
  <div role="cell"><div>$6.099.501</div></div>
  <div role="cell"><div>100,67%</div></div>
  <div role="cell"><div><strong>30% / 70%</strong></div></div>
</div>
`;

/**
 * Live capture of https://www.quantoz.com/transparency on 2026-09-11. Quantoz publishes
 * whole-number percentages, so the real cash/bond split `33% / 66%` sums to 99.
 */
const LIVE_QUANTOZ_HTML = `
<div class="text-style-tagline gradient-normal">UPDATED: AUGUST 30th, 2026</div>
<div>Reserve Status Overview</div>
<div role="row" class="table5_item">
  <div role="cell" class="table5_column"><div class="text-weight-medium">EURQ</div></div>
  <div role="cell" class="table5_column"><div>€4.302.714</div></div>
  <div role="cell" class="table5_column"><div>100,76%</div></div>
  <div role="cell" class="table5_column"><div><strong>33% / 66%</strong></div></div>
</div>
<div role="row" class="table5_item">
  <div role="cell" class="table5_column"><div class="text-weight-medium">USDQ</div></div>
  <div role="cell" class="table5_column"><div>$5.684.016</div></div>
  <div role="cell" class="table5_column"><div>101,91%</div></div>
  <div role="cell" class="table5_column"><div><strong>33% / 66%</strong></div></div>
</div>
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
    const result = adaptQuantozTransparency(QUANTOZ_HTML.replace("100,67%", "99,00%"), "USDQ");

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
    });
    // The 99% published sum stays out of the shared percentage-sum gate's raw input,
    // because the source's own rounding envelope explains it.
    expect(result.metadata?.diag).toEqual({ roundingEnvelopePct: 1, publishedAllocationSumPct: 99 });
    expectWarningEffect(result, "published-percentages-rounded", "info");
  });

  it("throws when the update timestamp is missing", () => {
    expect(() => adaptQuantozTransparency(QUANTOZ_HTML.replace("UPDATED: April 20th, 2026", ""), "EURQ"))
      .toThrow(/layout-changed/);
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

  it("rejects a renamed update field instead of publishing stale data", async () => {
    await expect(runAdapter("quantoz-transparency", "eurq-quantoz", {
      network: installAdapterNetwork({ html: { [url]: QUANTOZ_HTML.replace("UPDATED:", "REFRESHED:") } }),
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
      network: installAdapterNetwork({ html: { [url]: LIVE_QUANTOZ_HTML.replace("33% / 66%", "32% / 66%") } }),
      nowSec: LIVE_NOW_SEC,
    });

    // 98% is two points off, twice the one-point envelope two rounded categories can explain.
    expect(result.metadata?.diag).toMatchObject({ rawSumDeviation: 2, roundingEnvelopePct: 1 });
    expectWarningEffect(report, "pct-sum-deviation", "degraded");
  });

  it("fails closed when the published allocation cannot be reconciled with 100%", async () => {
    await expect(runAdapter("quantoz-transparency", "eurq-quantoz", {
      network: installAdapterNetwork({ html: { [url]: LIVE_QUANTOZ_HTML.replace("33% / 66%", "30% / 66%") } }),
      nowSec: LIVE_NOW_SEC,
      validate: false,
    })).rejects.toThrow(/sum to 96/);
  });
});

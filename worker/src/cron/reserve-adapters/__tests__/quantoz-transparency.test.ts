import { describe, expect, it } from "vitest";
import { adaptQuantozTransparency } from "../quantoz-transparency";
import { expectWarnings, installAdapterNetwork, runAdapter } from "./reserve-adapter.test-support";
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
});

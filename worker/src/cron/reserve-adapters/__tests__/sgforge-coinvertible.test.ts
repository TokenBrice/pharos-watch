import { describe, expect, it } from "vitest";
import { adaptSgForgeCoinvertible } from "../sgforge-coinvertible";

const SAMPLE_HTML = `
<div class="coinvertible_eur_usd">
  <h5><span>EUR CoinVertible in circulation</span></h5>
  <div class="coinvertible_number">
    92 476 840,64 <span class="ft-small c-secondary">Last update 20/03/26</span>
  </div>
  <div class="coinvertible_clt" style="--sg-percent: 100%;">
    <div class="bank">Societe Generale : 100%</div>
  </div>
  <div class="coinvertible_cash">
    <div class="number">92 476 840,64 €</div>
  </div>
</div>
`;

describe("adaptSgForgeCoinvertible", () => {
  it("maps the EUR CoinVertible block into a single cash reserve slice", () => {
    const result = adaptSgForgeCoinvertible(SAMPLE_HTML, "eur");
    expect(result.slices).toEqual([
      { name: "Euro cash deposits at Societe Generale", pct: 100, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      coinType: "eur",
      circulationAmount: 92476840.64,
      cashAmount: 92476840.64,
      bankName: "Societe Generale",
      bankPct: 100,
      lastUpdate: "20/03/26",
      sourceTimestamp: Date.UTC(2026, 2, 20) / 1000,
      freshnessMode: "verified",
    });
  });

  it("throws when the expected disclosure block is missing", () => {
    expect(() => adaptSgForgeCoinvertible("<html></html>", "eur")).toThrow("layout-changed");
  });

  it("throws parse-failed when localized amounts become unreadable", () => {
    const malformedAmountHtml = `
<div class="coinvertible_eur_usd">
  <h5><span>EUR CoinVertible in circulation</span></h5>
  <div class="coinvertible_number">
    not-a-number <span class="ft-small c-secondary">Last update 20/03/26</span>
  </div>
  <div class="coinvertible_clt" style="--sg-percent: 100%;">
    <div class="bank">Societe Generale : 100%</div>
  </div>
  <div class="coinvertible_cash">
    <div class="number">92 476 840,64 €</div>
  </div>
</div>
`;
    expect(() => adaptSgForgeCoinvertible(malformedAmountHtml, "eur")).toThrow("parse-failed");
  });
});

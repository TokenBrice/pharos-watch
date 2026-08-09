import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptSgForgeCoinvertible } from "../sgforge-coinvertible";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLE_HTML = readFileSync(join(FIXTURES_DIR, "sgforge-coinvertible-eur.html"), "utf8");
const MAY_7_2026_NOON_UTC = Date.UTC(2026, 4, 7, 12) / 1000;
const CURRENT_LAST_UPDATE_RE = /Last update \d{1,2}\/\d{2}\/\d{2,4}/g;

describe("adaptSgForgeCoinvertible", () => {
  it("maps the EUR CoinVertible block into a single cash reserve slice", () => {
    const result = adaptSgForgeCoinvertible(SAMPLE_HTML, "eur");
    expect(result.slices).toEqual([
      { name: "Euro cash deposits at Societe Generale", pct: 100, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      coinType: "eur",
      circulationAmount: 139700459.12,
      cashAmount: 139700459.12,
      collateralizationRatio: 1,
      cashCoveragePct: 100,
      bankName: "Societe Generale",
      bankPct: 100,
      lastUpdate: "9/08/2026",
      sourceTimestamp: Date.UTC(2026, 7, 9) / 1000,
      freshnessMode: "verified",
      redemption: {
        capacityKind: "documented-bound",
        freshnessKind: "verified-source-timestamp",
        sourceTimestamp: Date.UTC(2026, 7, 9) / 1000,
        routeStatus: "unknown",
        holderEligibility: "verified-customer",
      },
    });
  });

  it("throws when the expected disclosure block is missing", () => {
    expect(() => adaptSgForgeCoinvertible("<html></html>", "eur")).toThrow("layout-changed");
  });

  it("keeps European slash dates when they are not future-dated", () => {
    const html = SAMPLE_HTML.replace(CURRENT_LAST_UPDATE_RE, "Last update 7/05/26");
    const result = adaptSgForgeCoinvertible(html, "eur", { nowSec: MAY_7_2026_NOON_UTC });

    expect(result.metadata).toMatchObject({
      lastUpdate: "7/05/26",
      sourceTimestamp: Date.UTC(2026, 4, 7) / 1000,
    });
  });

  it("accepts current SG Forge markup with a line break and four-digit slash date", () => {
    // The live fixture already carries the `<br/>` between the amount and the
    // "Last update" span, so only the date needs to be pinned here.
    const html = SAMPLE_HTML.replace(CURRENT_LAST_UPDATE_RE, "Last update 2/06/2026");
    const result = adaptSgForgeCoinvertible(html, "eur", { nowSec: Date.UTC(2026, 5, 2, 12) / 1000 });

    expect(result.metadata).toMatchObject({
      lastUpdate: "2/06/2026",
      sourceTimestamp: Date.UTC(2026, 5, 2) / 1000,
    });
  });

  it("falls back to U.S. slash dates when the European interpretation would be future-dated", () => {
    const html = SAMPLE_HTML.replace(CURRENT_LAST_UPDATE_RE, "Last update 5/07/26");
    const result = adaptSgForgeCoinvertible(html, "eur", { nowSec: MAY_7_2026_NOON_UTC });

    expect(result.metadata).toMatchObject({
      lastUpdate: "5/07/26",
      sourceTimestamp: Date.UTC(2026, 4, 7) / 1000,
    });
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

  it("degrades when cash coverage falls below circulation", () => {
    const undercoveredHtml = SAMPLE_HTML.replace(/139 700 459,12\s+€/, "138 000 000,00 €");
    const result = adaptSgForgeCoinvertible(undercoveredHtml, "eur");

    expect(result.metadata?.collateralizationRatio).toBeLessThan(0.995);
    expect(result.warnings?.[0]).toMatchObject({
      code: "reserve-undercollateralized",
      effect: "degraded",
    });
  });

  it("throws when the reserve bank percentage is outside expected range", () => {
    const invalidPctHtml = SAMPLE_HTML.replace(/Societe Generale\s*:\s*100%/, "Societe Generale : 101%");

    expect(() => adaptSgForgeCoinvertible(invalidPctHtml, "eur")).toThrow("layout-changed");
  });
});

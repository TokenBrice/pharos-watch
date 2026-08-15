import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { adaptCircleTransparency } from "../circle-transparency";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const CIRCLE_HTML = readFileSync(join(FIXTURES_DIR, "circle-usdc.html"), "utf8");

const AMBIGUOUS_NEAR_PERCENT_HTML = `
<span data-coin="usdc" data-point="100.8" id="usdc-in-circulation"></span>
<canvas id="usdc_chartjs_canvas"
  data-usdc-us-treasuries="47.08"
  data-usdc-months="19.87"
  data-usdc-cash="11.35"
  data-usdc-in-circulation="21.70">
</canvas>
`;

describe("adaptCircleTransparency", () => {
  it("extracts USDC reserve slices from HTML", () => {
    const result = adaptCircleTransparency(CIRCLE_HTML, "usdc");
    expect(result.slices.length).toBe(4);
    const total = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBeCloseTo(100, 10);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: Date.UTC(2026, 7, 6) / 1000,
    });
  });

  it("uses Circle's reserve disclosure date when the page exposes one", () => {
    const result = adaptCircleTransparency(`${CIRCLE_HTML}<div>As of Aug 06, 2026</div>`, "usdc");

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: Date.UTC(2026, 7, 6) / 1000,
      redemption: {
        capacityKind: "documented-bound",
        freshnessKind: "verified-source-timestamp",
        sourceTimestamp: Date.UTC(2026, 7, 6) / 1000,
        routeStatus: "unknown",
        holderEligibility: "verified-customer",
      },
    });
  });

  it("maps USDC slices to very-low risk", () => {
    const result = adaptCircleTransparency(CIRCLE_HTML, "usdc");
    for (const slice of result.slices) {
      expect(slice.risk).toBe("very-low");
    }
  });

  it("extracts EURC reserve slices from HTML", () => {
    const result = adaptCircleTransparency(CIRCLE_HTML, "eurc");
    expect(result.slices.length).toBe(2);
    const total = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBe(100);
  });

  it("normalizes current absolute-value USDC disclosures into percentages", () => {
    const result = adaptCircleTransparency(CIRCLE_HTML, "usdc");
    expect(result.metadata?.valueMode).toBe("absolute");
    expect(result.slices).toEqual([
      { sourceKey: "circle:usdc:treasuries-under-3m", name: "<3-Month U.S. Treasuries", pct: 71.9, risk: "very-low" },
      { sourceKey: "circle:usdc:other-bank-deposits", name: "Other Bank Deposits", pct: 13.9, risk: "very-low" },
      { sourceKey: "circle:usdc:sifi-deposits", name: "Deposits at Systemically Important Institutions", pct: 12.5, risk: "very-low" },
      { sourceKey: "circle:usdc:overnight-reverse-treasury-repo", name: "Overnight Reverse Treasury Repo", pct: 1.7, risk: "very-low" },
    ]);
  });

  it("normalizes current absolute-value EURC disclosures into percentages", () => {
    const result = adaptCircleTransparency(CIRCLE_HTML, "eurc");
    expect(result.metadata?.valueMode).toBe("absolute");
    expect(result.slices).toEqual([
      { sourceKey: "circle:eurc:other-bank-deposits", name: "Other Bank Deposits", pct: 98.6, risk: "very-low" },
      { sourceKey: "circle:eurc:sifi-deposits", name: "Deposits at Systemically Important Institutions", pct: 1.4, risk: "very-low" },
    ]);
  });

  it("prefers percentage mode when the payload already sums to roughly 100%", () => {
    const result = adaptCircleTransparency(AMBIGUOUS_NEAR_PERCENT_HTML, "usdc");
    expect(result.metadata?.valueMode).toBe("percentage");
  });

  it("throws when no matching canvas found", () => {
    expect(() => adaptCircleTransparency("<html></html>", "usdc")).toThrow("layout-changed");
  });

  it("prefers the reserve-block 'As of' date when the page contains unrelated 'As of' banners", () => {
    const farPadding = "<div>" + "x".repeat(3_000) + "</div>";
    const stalePageBanner = `<div>As of Jan 01, 2020</div>${farPadding}`;
    const futureBanner = `${farPadding}<div>As of Feb 02, 2022</div>`;
    const adversarial = `${stalePageBanner}${CIRCLE_HTML}<div>As of Aug 06, 2026</div>${futureBanner}`;
    const result = adaptCircleTransparency(adversarial, "usdc");

    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 7, 6) / 1000,
    });
  });

  it("uses a unique global reserve disclosure date when the coin tab has no local date", () => {
    const htmlWithoutLocalDate = CIRCLE_HTML.replace(/\bAs of\s+[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}\b/gi, "");
    const farPadding = "<div>" + "x".repeat(3_000) + "</div>";
    const result = adaptCircleTransparency(`<p>As of May 07, 2026</p>${farPadding}${htmlWithoutLocalDate}`, "eurc");

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: Date.UTC(2026, 4, 7) / 1000,
    });
  });

  it("does not use an ambiguous global reserve disclosure date", () => {
    const htmlWithoutLocalDate = CIRCLE_HTML.replace(/\bAs of\s+[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}\b/gi, "");
    const farPadding = "<div>" + "x".repeat(3_000) + "</div>";
    const result = adaptCircleTransparency(
      `<p>As of May 07, 2026</p>${farPadding}${htmlWithoutLocalDate}${farPadding}<p>As of Apr 01, 2026</p>`,
      "eurc",
    );

    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        freshnessSource: "html-disclosure",
      },
    });
  });

  it("emits a circle-disclosure-timestamp-ambiguous warning when multiple unique 'As of' dates appear outside the disclosure window", () => {
    const htmlWithoutLocalDate = CIRCLE_HTML.replace(/\bAs of\s+[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}\b/gi, "");
    const farPadding = "<div>" + "x".repeat(3_000) + "</div>";
    const result = adaptCircleTransparency(
      `<p>As of May 07, 2026</p>${farPadding}${htmlWithoutLocalDate}${farPadding}<p>As of Apr 01, 2026</p>`,
      "eurc",
    );

    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "circle-disclosure-timestamp-ambiguous" })]),
    );
    expect(result.slices.length).toBeGreaterThan(0);
    expect(result.metadata).toMatchObject({ freshnessMode: "unverified" });
  });

  it("throws layout-changed when a data-usdc-* attribute carries a multi-dot value like '4.7.18'", () => {
    const html = `
<canvas id="usdc_chartjs_canvas"
  data-usdc-us-treasuries="4.7.18"
  data-usdc-months="19.87"
  data-usdc-cash="11.35"
  data-usdc-in-circulation="21.70">
</canvas>
`;

    expect(() => adaptCircleTransparency(html, "usdc")).toThrow(/layout-changed/);
    expect(() => adaptCircleTransparency(html, "usdc")).toThrow(/data-usdc-us-treasuries/);
  });
});

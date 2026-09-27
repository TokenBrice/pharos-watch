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

const COIN_CASES = [
  {
    coinType: "usdc",
    displayId: "usdc-in-circulation",
    canvasId: "usdc_chartjs_canvas",
    attributes: 'data-usdc-us-treasuries="70" data-usdc-months="20" data-usdc-cash="10" data-usdc-in-circulation="0"',
  },
  {
    coinType: "eurc",
    displayId: "euro-in-circulation",
    canvasId: "eurocoin_chartjs_canvas",
    attributes: 'data-eurocoin-cash="98" data-eurocoin-tokens="2"',
  },
];

describe.each(COIN_CASES)("Circle $coinType disclosure boundaries", ({ coinType, displayId, canvasId, attributes }) => {
  const canvas = `<canvas id="${canvasId}" ${attributes}></canvas>`;
  const anchor = `<span id="${displayId}" data-point="100"></span>`;
  const date = "<p>As of Sep 24, 2026</p>";
  const otherDate = "<p>As of Jan 01, 2020</p>";
  const padding = " ".repeat(3_000);

  it("ignores preceding decoy reserve attributes", () => {
    const baseline = adaptCircleTransparency(CIRCLE_HTML, coinType);
    const result = adaptCircleTransparency(`<div ${attributes}></div>${CIRCLE_HTML}`, coinType);
    expect(result.slices).toEqual(baseline.slices);
    expect(result.metadata?.diag).toEqual(baseline.metadata?.diag);
  });

  it("rejects duplicate authoritative nodes", () => {
    expect(() => adaptCircleTransparency(`${canvas}${CIRCLE_HTML}`, coinType)).toThrow("layout-changed");
  });

  it("rejects a missing authoritative node even with valid attributes elsewhere", () => {
    expect(() => adaptCircleTransparency(`<div ${attributes}></div>${anchor}${date}`, coinType))
      .toThrow("layout-changed");
    expect(() => adaptCircleTransparency(`<div id="${canvasId}" ${attributes}></div>`, coinType))
      .toThrow("layout-changed");
  });

  it("does not borrow an attribute missing from the authoritative canvas", () => {
    const incomplete = canvas.replace(/data-[\w-]+="[\d.]+"/, "");
    expect(() => adaptCircleTransparency(`<div ${attributes}></div>${incomplete}`, coinType))
      .toThrow("layout-changed");
  });

  it("prefers one real local date over unrelated global dates", () => {
    const result = adaptCircleTransparency(`${otherDate}${padding}${date}${anchor}${canvas}`, coinType);
    expect(result.metadata?.sourceTimestamp).toBe(Date.UTC(2026, 8, 24) / 1000);
    expect(result.metadata?.freshnessMode).toBe("verified");
  });

  it("rejects distinct dates inside the local window", () => {
    const result = adaptCircleTransparency(`${date}${anchor}${otherDate}${canvas}`, coinType);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "circle-disclosure-timestamp-ambiguous" }));
  });

  it("accepts repeated occurrences of one local date", () => {
    const result = adaptCircleTransparency(`${date}${anchor}${date}${canvas}`, coinType);
    expect(result.metadata?.sourceTimestamp).toBe(Date.UTC(2026, 8, 24) / 1000);
  });

  it("uses only a unique global date when the circulation anchor is missing", () => {
    const result = adaptCircleTransparency(`${date}${padding}${canvas}${date}`, coinType);
    expect(result.metadata?.sourceTimestamp).toBe(Date.UTC(2026, 8, 24) / 1000);
    for (const dates of [`${date}${otherDate}`, `${otherDate}${date}`]) {
      const ambiguous = adaptCircleTransparency(`${dates}${padding}${canvas}`, coinType);
      expect(ambiguous.metadata?.freshnessMode).toBe("unverified");
      expect(ambiguous.metadata?.sourceTimestamp).toBeUndefined();
      expect(ambiguous.metadata?.redemption?.sourceTimestamp).toBeUndefined();
      expect(ambiguous.warnings).toContainEqual(expect.objectContaining({ code: "circle-disclosure-timestamp-ambiguous" }));
    }
  });

  it("keeps an undated disclosure unverified", () => {
    const result = adaptCircleTransparency(`${anchor}${canvas}`, coinType);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
  });
});

describe("adaptCircleTransparency", () => {
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

  it("normalizes current absolute-value USDC disclosures into percentages", () => {
    const result = adaptCircleTransparency(CIRCLE_HTML, "usdc");
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: Date.UTC(2026, 7, 6) / 1000,
    });
    expect(result.slices).toEqual([
      { sourceKey: "circle:usdc:treasuries-under-3m", name: "<3-Month U.S. Treasuries", pct: 71.9, risk: "very-low" },
      { sourceKey: "circle:usdc:other-bank-deposits", name: "Other Bank Deposits", pct: 13.9, risk: "very-low" },
      { sourceKey: "circle:usdc:sifi-deposits", name: "Deposits at Systemically Important Institutions", pct: 12.5, risk: "very-low" },
      { sourceKey: "circle:usdc:overnight-reverse-treasury-repo", name: "Overnight Reverse Treasury Repo", pct: 1.7, risk: "very-low" },
    ]);
  });

  it("normalizes current absolute-value EURC disclosures into percentages", () => {
    const result = adaptCircleTransparency(CIRCLE_HTML, "eurc");
    expect(result.slices).toEqual([
      { sourceKey: "circle:eurc:other-bank-deposits", name: "Other Bank Deposits", pct: 98.6, risk: "very-low" },
      { sourceKey: "circle:eurc:sifi-deposits", name: "Deposits at Systemically Important Institutions", pct: 1.4, risk: "very-low" },
    ]);
  });

  it("reports upstream percentage drift separately from rounding repair", () => {
    const result = adaptCircleTransparency(AMBIGUOUS_NEAR_PERCENT_HTML.replace('data-usdc-cash="11.35"', 'data-usdc-cash="10.55"'), "usdc");
    expect(result.metadata?.diag).toMatchObject({ rawSumDeviation: expect.closeTo(0.8, 6) });
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100);
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
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "circle-disclosure-timestamp-ambiguous" }));
    expect(result.slices).toEqual([
      { sourceKey: "circle:eurc:other-bank-deposits", name: "Other Bank Deposits", pct: 98.6, risk: "very-low" },
      { sourceKey: "circle:eurc:sifi-deposits", name: "Deposits at Systemically Important Institutions", pct: 1.4, risk: "very-low" },
    ]);
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

  it("accepts a valid allocation with a zero disclosure row and omits the zero slice", () => {
    const html = `
<span data-coin="usdc" data-point="100" id="usdc-in-circulation"></span>
<canvas id="usdc_chartjs_canvas"
  data-usdc-us-treasuries="70"
  data-usdc-months="20"
  data-usdc-cash="10"
  data-usdc-in-circulation="0">
</canvas>
`;
    const result = adaptCircleTransparency(html, "usdc");

    expect(result.slices).toEqual([
      { sourceKey: "circle:usdc:treasuries-under-3m", name: "<3-Month U.S. Treasuries", pct: 70, risk: "very-low" },
      { sourceKey: "circle:usdc:sifi-deposits", name: "Deposits at Systemically Important Institutions", pct: 20, risk: "very-low" },
      { sourceKey: "circle:usdc:other-bank-deposits", name: "Other Bank Deposits", pct: 10, risk: "very-low" },
    ]);
  });

  it("throws layout-changed when every disclosure row reads zero", () => {
    const html = `
<span data-coin="usdc" data-point="0" id="usdc-in-circulation"></span>
<canvas id="usdc_chartjs_canvas"
  data-usdc-us-treasuries="0"
  data-usdc-months="0"
  data-usdc-cash="0"
  data-usdc-in-circulation="0">
</canvas>
`;
    expect(() => adaptCircleTransparency(html, "usdc")).toThrow(/layout-changed/);
  });
});

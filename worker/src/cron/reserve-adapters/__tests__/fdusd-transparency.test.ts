import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptFdusdTransparency } from "../fdusd-transparency";
import { validateAdapterOutput } from "../validate";
import { getReserveAdapter } from "../index";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLE_HTML = readFileSync(join(FIXTURES_DIR, "fdusd-transparency.html"), "utf8");

describe("adaptFdusdTransparency", () => {
  // The canonical `www.firstdigitallabs.com` host answers Worker/automation traffic
  // with a Cloudflare 403 challenge, so the reviewed same-provider Webflow origin
  // (pinned as the config fallback in registry.test.ts) is the fetchable capture
  // surface. Keep the fixture provenance aligned with the path production uses.
  it("captures the fixture from the reviewed Webflow fallback origin", () => {
    expect(SAMPLE_HTML).toContain("<!-- source: https://firstdigitallabs.webflow.io/transparency -->");
  });

  it("maps the transparency badges into Pharos reserve slices", () => {
    const result = adaptFdusdTransparency(SAMPLE_HTML);
    // Mapped issuer labels are normalized ("US Treasury Bills"); reviewed buckets
    // outside FDUSD_LABEL_MAP ("Fixed Deposit") pass through verbatim.
    expect(result.slices).toEqual([
      { name: "U.S. Treasury Bills", pct: 85.3, risk: "very-low" },
      { name: "Cash", pct: 10.4, risk: "very-low" },
      { name: "Fixed Deposit", pct: 4.3, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      sliceCount: 3,
      asOf: "May 31, 2026",
      sourceTimestamp: Date.UTC(2026, 4, 31) / 1000,
      freshnessMode: "verified",
      redemption: {
        capacityKind: "documented-bound",
        freshnessKind: "verified-source-timestamp",
        sourceTimestamp: Date.UTC(2026, 4, 31) / 1000,
        routeStatus: "unknown",
      },
    });
  });

  it("throws when the page no longer exposes any reserve badges (layout-changed/parse-failure path)", () => {
    expect(() => adaptFdusdTransparency("<html></html>")).toThrow("layout-changed");
  });

  it("throws layout-changed when badges exist but percent-value parses to 0 / NaN", () => {
    const brokenHtml = `
      <div role="listitem" class="chart-badge w-dyn-item">
        <div>US Treasury Bills</div>
        <div class="percent-value">not-a-number</div>
      </div>
    `;
    expect(() => adaptFdusdTransparency(brokenHtml)).toThrow("layout-changed");
  });

  it("falls back to unverified freshness metadata when the 'As of' block is missing", () => {
    const htmlWithoutAsOf = `
      <div role="listitem" class="chart-badge w-dyn-item">
        <div>US Treasury Bills</div>
        <div class="percent-value">100</div>
      </div>
    `;
    const result = adaptFdusdTransparency(htmlWithoutAsOf);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
    expect(result.metadata?.redemption).toMatchObject({
      freshnessKind: "unverified",
    });
  });

  it("is rejected by validateAdapterOutput when the source timestamp is in the future", () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const month = futureDate.toLocaleString("en-US", { month: "short" });
    const day = futureDate.getUTCDate();
    const year = futureDate.getUTCFullYear();
    const futureHtml = `
      <div class="chart-date">As of</div><div class="chart-date">${month} ${day}, ${year}</div>
      <div role="listitem" class="chart-badge w-dyn-item">
        <div>US Treasury Bills</div>
        <div class="percent-value">100</div>
      </div>
    `;

    const result = adaptFdusdTransparency(futureHtml);
    const adapter = getReserveAdapter("fdusd-transparency") ?? undefined;
    const report = validateAdapterOutput(result, { adapter });
    expect(report.valid).toBe(false);
  });
});

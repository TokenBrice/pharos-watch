import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { GRADE_ON_DARK_HEX } from "../../shared/lib/classification";
import { PHAROS_MARK_ON_DARK_SVG, PHAROS_MARK_ON_LIGHT_SVG } from "../../shared/lib/social-card/brand";
import type { SocialCardSpec, SocialScorecardCard } from "../../shared/lib/social-card/spec";
import { buildSocialCardElement, buildSocialScorecardElement, buildSocialScorecardOverviewElement } from "../../shared/lib/social-card/templates";
import { FROST, SocialCardError } from "../../shared/lib/social-card/tokens";
import { renderSvgPngWithResvg } from "../lib/og-resvg-render.mts";
import {
  loadSocialCardAssets,
  renderSocialCardSvg,
  renderSocialScorecardSvg,
  validateSocialCardSpec,
  type SocialCardRenderAssets,
} from "../lib/social-card-render";

const copy = { title: "t", description: "d", alt: "a" };
const usdt = { symbol: "USDT", name: "Tether", logoPath: "/logos/1-usdt.svg" };
const usdc = { symbol: "USDC", name: "USD Coin", logoPath: "/logos/2-usdc.svg" };
const hub: SocialCardSpec = { template: "hub", path: "/", label: "Stablecoin intelligence", copy, headline: "Stablecoins, under the lens.", deck: "See the peg. Trace the backing. Know the exit.", subject: { kind: "cluster", members: [usdt, usdc] } };
const dossier: SocialCardSpec = { template: "dossier", path: "/stablecoin/eurr-revolut/", label: "Upcoming stablecoin", copy, identity: { symbol: "EURR", name: "Revolut Euro" }, headline: "EURR", subline: "Revolut Euro", hook: "The neobank that rented its own coin", chips: ["EUR peg", "Launched Aug 2026"], lifecycle: "launched-untracked", stamp: "NOT YET TRACKED" };
const versus: SocialCardSpec = { template: "versus", path: "/compare/usdt-vs-usdc/", label: "Stablecoin comparison", copy, left: { ...usdt, detail: "Tether · El Salvador" }, right: { ...usdc, detail: "Circle · United States" }, hook: "Same peg. Different promises." };
const record: SocialCardSpec = { template: "record", path: "/depeg/usdc/", label: "Confirmed depeg record", copy, accent: "severity", identity: usdc, dateline: "11 Mar 2023", title: "USDC: 12.1% below peg", facts: ["Recovered after 46 hours"], ruler: { peg: 1, floor: 0.85, low: 0.879, currencySymbol: "$" } };
const scorecard: SocialScorecardCard = { identity: usdt, grade: "A+", score: 87, asOf: "17 Nov 2026", pillars: [{ name: "Backing", score: 65, grade: "C+" }, { name: "Exit", score: 92, grade: "A+" }, { name: "Economic control", score: 70, grade: "B" }] };

let assets: SocialCardRenderAssets;
beforeAll(async () => {
  assets = await loadSocialCardAssets(process.cwd(), [hub, dossier, versus, record, scorecard]);
});

describe("social card renderer", () => {
  it("renders every template as a 1200×630 SVG that resvg rasterises within the size budget", async () => {
    const svgs = [...await Promise.all([hub, dossier, versus, record].map((spec) => renderSocialCardSvg(spec, assets))), await renderSocialScorecardSvg(scorecard, assets)];
    for (const svg of svgs) expect(svg).toMatch(/^<svg width="1200" height="630" viewBox="0 0 1200 630"/);
    for (const svg of svgs.slice(-2)) {
      const png = await renderSvgPngWithResvg({ svg, fontBuffers: assets.fontBuffers, background: "#f4f6f7", width: 1200 });
      expect(await sharp(png).metadata()).toMatchObject({ width: 1200, height: 630, format: "png" });
      expect(png.byteLength).toBeLessThan(300 * 1024);
    }
  });

  it("fails loudly with the spec path instead of clipping or dropping copy", () => {
    expect(() => validateSocialCardSpec({ ...dossier, hook: "x".repeat(65) } as SocialCardSpec)).toThrow("/stablecoin/eurr-revolut/ hook: 65 characters exceed the 64-character budget");
    expect(() => validateSocialCardSpec({ ...hub, headline: "Peg ≠ par" } as SocialCardSpec)).toThrow('headline: no glyph for "≠"');
    // Within budget but wider than the column at the floor size: one unbreakable 40-character word.
    expect(() => validateSocialCardSpec({ ...hub, headline: "W".repeat(40) } as SocialCardSpec, assets)).toThrow(SocialCardError);
    expect(() => validateSocialCardSpec({ ...hub, headline: "W".repeat(40) } as SocialCardSpec, assets)).toThrow(/headline: .* exceeds 4 line\(s\)/);
    // A pillar bar never clamps; the registry's longest ticker fits down instead of failing.
    expect(() => buildSocialScorecardElement({ ...scorecard, pillars: [{ name: "Exit", score: 100.5, grade: "A+" }] }, assets)).toThrow("pillars[0].score: 100.5 is outside 0-100");
    const longest = { symbol: "skyMoneyUsdsFlagship", name: "sky.money USDS Flagship" };
    for (const pillars of [scorecard.pillars, []]) expect(JSON.stringify(buildSocialScorecardElement({ ...scorecard, identity: longest, pillars }, assets))).toContain('"skyMoneyUsdsFlagship"');
  });

  it("draws a dashed monogram for an identity without a registered logo", () => {
    const element = JSON.stringify(buildSocialCardElement(dossier, assets));
    expect(element).toContain("dashed");
    expect(element).toContain('"children":"EURR"');
    expect(() => buildSocialCardElement({ ...dossier, identity: { ...dossier.identity, logoPath: "/logos/unloaded.png" } } as SocialCardSpec, assets)).toThrow("logo /logos/unloaded.png");
  });

  it("colours grades only from the classification authority", () => {
    const element = JSON.stringify(buildSocialScorecardElement(scorecard, assets));
    expect(element).toContain(`4px solid ${GRADE_ON_DARK_HEX.A}`);
    expect(element).toContain(`"background":"${GRADE_ON_DARK_HEX.C}"`);
    // An observed zero is an empty track, not a stub of fill.
    expect(JSON.stringify(buildSocialScorecardElement({ ...scorecard, pillars: [{ name: "Exit", score: 0, grade: "F" }] }, assets))).not.toContain(`"background":"${GRADE_ON_DARK_HEX.F}"`);
    expect(element).toContain("As of 17 Nov 2026");
    expect(element).not.toMatch(/not live|v\d+\.\d+/i);
    const legend = JSON.stringify(buildSocialCardElement({ ...hub, subject: { kind: "grade-shield" } } as SocialCardSpec, assets));
    for (const family of ["A", "B", "C", "D", "F"] as const) expect(legend).toContain(`2.5px solid ${GRADE_ON_DARK_HEX[family]}`);
    expect(() => buildSocialScorecardElement({ ...scorecard, grade: "NR" }, assets)).toThrow('"NR" is not a published grade');
  });

  it("dates the pillarless Worker scorecard and the letterless overview with a frost outline", () => {
    const sealed = JSON.stringify(buildSocialScorecardElement({ ...scorecard, pillars: [] }, assets));
    const overview = JSON.stringify(buildSocialScorecardOverviewElement({ meanScore: 71.84, rated: 142, notRated: 3, unavailable: 0, asOf: "17 Nov 2026" }, assets));
    expect(sealed).not.toContain("By pillar");
    expect(JSON.stringify(buildSocialScorecardElement({ ...scorecard, identity: { ...usdt, name: "Usdt" }, pillars: [] }, assets))).not.toContain('"Usdt"');
    expect(overview).toContain('"142\u00a0rated\u00a0· 3\u00a0not\u00a0rated"');
    expect(overview).toContain('"71.8"');
    expect(overview).not.toMatch(/unavailable|"children":"[A-F][+-]?"/);
    for (const card of [sealed, overview]) {
      expect(card).toContain(`"border":"2px solid ${FROST}"`);
      expect(card).not.toContain(`"background":"${FROST}"`);
      expect(card).toContain('"As of 17 Nov 2026"');
    }
    expect(() => buildSocialScorecardOverviewElement({ meanScore: 70, rated: 0, notRated: 2, unavailable: 0, asOf: "17 Nov 2026" }, assets)).toThrow("at least one rated");
  });

  it("inlines the brand marks exactly as public/ serves them", () => {
    expect(PHAROS_MARK_ON_DARK_SVG).toBe(readFileSync("public/pharos-mark-on-dark.svg", "utf8").trim());
    expect(PHAROS_MARK_ON_LIGHT_SVG).toBe(readFileSync("public/pharos-mark-on-light.svg", "utf8").trim());
  });
});

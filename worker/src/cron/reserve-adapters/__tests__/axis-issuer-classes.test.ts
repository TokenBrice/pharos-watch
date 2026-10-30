import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractEscapedJsonValueAfterKey } from "../html";
import { validateAdapterOutput } from "../validate";
import { adaptAxisIssuerClasses } from "../axis-issuer-classes";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
/**
 * Captured 2026-10-29T18:21Z from
 * https://app.axis.to/transparency?tab=asset-composition. The fixture keeps the exact
 * `self.__next_f.push` script; the surrounding page chrome is not parsed.
 */
const FIXTURE = readFileSync(join(FIXTURES_DIR, "axis-transparency-2026-10-29.html"), "utf8");
const DASHBOARD_ANCHOR = '\\"initialDashboard\\":';
const SOURCE_TIMESTAMP = Math.floor(Date.parse("2026-10-29T12:08:46.361Z") / 1000);
const NOW = Math.floor(Date.parse("2026-10-29T12:18:00Z") / 1000);

interface FixtureClass {
  id: string;
  value: number;
  percent: number;
  unclassified: { gross_usd: number; asset_count: number; percent_of_class: number };
}
interface FixtureDashboard {
  overview: {
    last_updated?: string;
    total_reserves: { value: number };
    usdx_total_supply: number;
    collateralization_ratio: number;
  };
  dashboard_details: {
    asset_classes: {
      total: number;
      breakdown: FixtureClass[];
      unclassified: { percent: number; gross_usd: number; asset_count: number };
    };
  };
  reserves_history: { data: Array<{ value: number; timestamp: string }> };
}

/** Replace the captured dashboard object in the escaped flight JSON, keeping every other
 *  byte of the fixture so the parser is exercised against the real wire shape. */
function mutateDashboard(mutate: (dashboard: FixtureDashboard) => void): string {
  const anchorIndex = FIXTURE.indexOf(DASHBOARD_ANCHOR);
  if (anchorIndex < 0) throw new Error("fixture dashboard anchor is missing");
  const start = FIXTURE.indexOf("{", anchorIndex + DASHBOARD_ANCHOR.length);
  let depth = 0;
  let escaped = false;
  let end = -1;
  for (let index = start; index < FIXTURE.length; index += 1) {
    const char = FIXTURE[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (start < 0 || end < 0) throw new Error("fixture dashboard object is unterminated");
  const decoded = extractEscapedJsonValueAfterKey(FIXTURE, DASHBOARD_ANCHOR, "axis-issuer-classes");
  const dashboard = JSON.parse(decoded) as FixtureDashboard;
  mutate(dashboard);
  const encoded = JSON.stringify(JSON.stringify(dashboard)).slice(1, -1);
  return FIXTURE.slice(0, start) + encoded + FIXTURE.slice(end + 1);
}

function liquidHedge(dashboard: FixtureDashboard): FixtureClass {
  const row = dashboard.dashboard_details.asset_classes.breakdown.find((candidate) => candidate.id === "liquid_hedge");
  if (!row) throw new Error("fixture liquid_hedge class is missing");
  return row;
}

const RESIDUAL_PCT = 33_662_245.1926844 / 69_046_922.14880197 * 100;

describe("adaptAxisIssuerClasses", () => {
  it("publishes exactly the five reviewed class keys plus one unclassified residual", () => {
    const result = adaptAxisIssuerClasses(FIXTURE, NOW);

    expect(result.slices.map((slice) => slice.sourceKey)).toEqual([
      "axis:transparency:asset-class:cash_fiat",
      "axis:transparency:asset-class:stablecoins",
      "axis:transparency:asset-class:liquid_hedge",
      "axis:transparency:asset-class:staked_lst",
      "axis:transparency:asset-class:tbill_rwa",
      "axis:transparency:unclassified-residual",
    ]);
    expect(result.slices.filter((slice) => slice.unclassifiedResidual !== true)
      .every((slice) => slice.liquidityHorizon === "unknown")).toBe(true);
    expect(result.slices.find((slice) => slice.unclassifiedResidual === true)?.liquidityHorizon).toBeUndefined();
    expect(result.slices.every((slice) => slice.coinId == null && slice.depType == null)).toBe(true);
    expect(result.slices.find((slice) => slice.sourceKey === "axis:transparency:asset-class:cash_fiat")).toMatchObject({
      name: "Fiat cash and FX balances",
      assetClass: "cash",
      issuerOrObligor: expect.stringContaining("Axis bank"),
    });
    expect(result.slices.find((slice) => slice.sourceKey === "axis:transparency:asset-class:staked_lst")).toMatchObject({
      assetClass: "protocol-position",
    });
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 10);
  });

  it("charges the unclassified share to exactly one residual row", () => {
    const result = adaptAxisIssuerClasses(FIXTURE, NOW);
    const residuals = result.slices.filter((slice) => slice.unclassifiedResidual === true);

    expect(residuals).toHaveLength(1);
    expect(residuals[0]).toMatchObject({
      sourceKey: "axis:transparency:unclassified-residual",
      name: "Unclassified liquid hedge inventory",
      risk: "high",
      assetClass: "other",
      residualReason: "insufficient-evidence",
    });
    expect(residuals[0]!.coinId).toBeUndefined();
    expect(residuals[0]!.depType).toBeUndefined();
    expect(residuals[0]!.issuerOrObligor).toBeUndefined();
    expect(residuals[0]!.pct).toBeCloseTo(RESIDUAL_PCT, 8);
    expect(result.metadata?.unknownExposurePct).toBeCloseTo(RESIDUAL_PCT, 8);
    expect(result.slices.find((slice) => slice.sourceKey === "axis:transparency:asset-class:liquid_hedge")?.pct)
      .toBeCloseTo(76.23764060675437 - RESIDUAL_PCT, 8);
  });

  it("records the page clock, reserve/supply totals and reconciled ratio", () => {
    const result = adaptAxisIssuerClasses(FIXTURE, NOW);

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: SOURCE_TIMESTAMP,
      supplyUsd: 68_864_099.65676695,
    });
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(69_046_922.148802, 6);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(69_046_922.148802 / 68_864_099.65676695, 10);
    expect(result.metadata?.details).toMatchObject({
      lastUpdated: "2026-10-29T12:08:46.361Z",
      classCount: 5,
      unclassifiedAssetCount: 462,
    });
    const report = validateAdapterOutput(result, { now: NOW, maxSourceAgeSec: 3 * 86_400 });
    expect(report.valid).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it("fails closed when the class values do not sum to the published total", () => {
    const html = mutateDashboard((dashboard) => {
      dashboard.dashboard_details.asset_classes.breakdown[0]!.value += 10_000;
    });
    expect(() => adaptAxisIssuerClasses(html, NOW)).toThrow(/do not sum to the published total/);
  });

  it("fails closed when last_updated is missing", () => {
    const html = mutateDashboard((dashboard) => {
      delete dashboard.overview.last_updated;
    });
    expect(() => adaptAxisIssuerClasses(html, NOW)).toThrow(/last_updated|reviewed shape/);
  });

  it("fails closed on an unreviewed class identity", () => {
    const html = mutateDashboard((dashboard) => {
      dashboard.dashboard_details.asset_classes.breakdown[0]!.id = "cash";
    });
    expect(() => adaptAxisIssuerClasses(html, NOW)).toThrow(/unreviewed or duplicate asset-class identity/);
  });

  it("fails closed when an unclassified amount exceeds its class or appears outside liquid hedge", () => {
    const exceedsClass = mutateDashboard((dashboard) => {
      const row = liquidHedge(dashboard);
      row.unclassified.gross_usd = row.value + 1;
    });
    expect(() => adaptAxisIssuerClasses(exceedsClass, NOW)).toThrow(/unclassified amount exceeds/);

    const outsideLiquidHedge = mutateDashboard((dashboard) => {
      dashboard.dashboard_details.asset_classes.breakdown[0]!.unclassified.gross_usd = 1;
    });
    expect(() => adaptAxisIssuerClasses(outsideLiquidHedge, NOW)).toThrow(/unreviewed unclassified portion/);
  });

  it("fails closed when the same-day timeline point contradicts the class total", () => {
    const html = mutateDashboard((dashboard) => {
      const point = dashboard.reserves_history.data.find((entry) => entry.timestamp.startsWith("2026-10-29"));
      if (!point) throw new Error("fixture timeline point is missing");
      point.value += 10_000;
    });
    expect(() => adaptAxisIssuerClasses(html, NOW)).toThrow(/timeline point does not match/);
  });

  it("allows the 10-minute future skew and rejects a clock one second beyond it", () => {
    expect(() => adaptAxisIssuerClasses(FIXTURE, SOURCE_TIMESTAMP - 600)).not.toThrow();
    expect(() => adaptAxisIssuerClasses(FIXTURE, SOURCE_TIMESTAMP - 601)).toThrow(/source-clock skew allowance/);
  });
});

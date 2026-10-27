import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CRON_INTERVALS, CRON_JOB_DEFINITIONS } from "@shared/lib/cron-jobs";
import { DATA_SURFACE_DESCRIPTORS } from "@shared/lib/data-surface-descriptors";
import { getPublicProducerGraceBudget, PUBLIC_PRODUCER_INTERVAL_SEC } from "@shared/lib/public-health";
import { FRESHNESS_RATIOS, getCacheHealthyMaxRatio, getCacheRatioThresholds } from "@shared/lib/status-thresholds";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8");

const UNIT_SEC: Record<string, number> = { m: 60, h: 3600, d: 86_400 };
function parseDuration(cell: string): number {
  const match = /^(\d+)([mhd])(?: nominal)?$/.exec(cell.trim());
  if (!match) throw new Error(`Unparseable duration cell: ${cell}`);
  return Number(match[1]) * UNIT_SEC[match[2]!]!;
}
const hours = (sec: number) => `${sec / 3600}h`;
const minutes = (sec: number) => `${sec / 60}m`;

describe("lane freshness matrix", () => {
  const matrix = read("docs/process/lane-freshness-matrix.md");
  const rows = matrix.split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));

  it("lists every logical job once with its effective interval, 2x budget, impact and evidence kind", () => {
    const ids = rows.map(([job]) => job!.replace(/`/g, ""));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(CRON_JOB_DEFINITIONS.map((job) => job.job).sort());
    expect(matrix).toContain(`all ${CRON_JOB_DEFINITIONS.length} logical jobs`);
    for (const [jobCell, intervalCell, budgetCell, impactCell] of rows) {
      const job = CRON_JOB_DEFINITIONS.find((definition) => definition.job === jobCell!.replace(/`/g, ""))!;
      if (!intervalCell!.endsWith("nominal")) expect(parseDuration(intervalCell!), job.job).toBe(job.intervalSec);
      const [budget, evidence] = budgetCell!.split(" ");
      expect(parseDuration(budget!), job.job).toBe(2 * parseDuration(intervalCell!));
      expect(evidence, job.job).toBe(job.freshnessSurface === "consumer" ? "C" : "O");
      expect(impactCell, job.job).toBe(job.statusImpact);
    }
  });

  it("keeps the draft sign-off boundary", () => {
    expect(matrix).toContain("**Draft for owner sign-off.**");
    expect(matrix).toContain("## Sign-off boundary");
    expect(matrix).toContain("Safety publishes hourly at :22; :46 preparation is conditional recovery.");
  });
});

describe("owning freshness prose", () => {
  it("states the yield-data bands from the cache override authority", () => {
    const bands = getCacheRatioThresholds("yield-data");
    const budget = DATA_SURFACE_DESCRIPTORS.yieldRankings.endpointMaxAgeSec;
    expect(read("docs/yield-intelligence.md")).toContain(
      `fresh through ${(budget * bands.degraded).toLocaleString("en-US")} seconds, degraded through ${(budget * bands.stale).toLocaleString("en-US")} seconds, then stale.`,
    );
    const status = read("docs/status-dashboard.md");
    expect(status).toContain(`\`>${bands.degraded}x\` degraded / \`>${bands.stale}x\` stale`);
    expect(status).toContain(`\`healthyMaxRatio\` is \`${FRESHNESS_RATIOS.DEGRADED}\` by default and \`${getCacheHealthyMaxRatio("yield-data")}\` for \`yield-data\``);
  });

  it("states Safety cadence and consumer budgets from the producer interval", () => {
    const interval = CRON_INTERVALS["compute-safety-score-v9"]!;
    expect(read("docs/status-dashboard.md")).toContain(`(${interval.toLocaleString("en-US")}-second cadence)`);
    const consumer = hours(2 * interval);
    const flowMap = read("docs/data-flow-map.md");
    expect(flowMap).toContain(`past the ${consumer} consumer budget`);
    const endpointSec = DATA_SURFACE_DESCRIPTORS.reportCards.endpointMaxAgeSec;
    expect(flowMap).toContain(`(12× the ${hours(endpointSec)} endpoint budget, ${hours(12 * endpointSec)})`);
    expect(read("docs/stablecoin-detail-page.md")).toContain(`${consumer} consumer budget`);
    expect(read("docs/dependency-map.md")).toContain(
      `${interval / 60}-minute \`staleTime\` and ${(2 * interval) / 60}-minute \`refetchInterval\`.`,
    );
  });

  it("keeps the three mint/burn vocabularies distinct", () => {
    const status = read("docs/status-dashboard.md");
    const endpointSec = API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows;
    const producer = getPublicProducerGraceBudget(PUBLIC_PRODUCER_INTERVAL_SEC.mintBurn);
    expect(status).toContain(
      `The critical \`/api/mint-burn-flows\` endpoint is fresh through ${hours(endpointSec * FRESHNESS_RATIOS.FRESH)} and degraded through ${hours(endpointSec * FRESHNESS_RATIOS.DEGRADED)}. `
      + `Public producer status is Delayed after ${minutes(producer.delayedAfterSec)}, Degraded after ${hours(producer.degradedAfterSec)} and outage after ${hours(producer.outageAfterSec)}.`,
    );
    // The internal sync classifier keeps its own 60m/90m numbers without claiming the public floor.
    expect(status).toContain(`against a \`${minutes(endpointSec)}\` window`);
    expect(status).not.toContain("the same floor described under Availability status above");
  });
});

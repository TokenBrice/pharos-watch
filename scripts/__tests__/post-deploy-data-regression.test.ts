import { describe, expect, it } from "vitest";

import {
  POST_DEPLOY_DATA_ENDPOINTS,
  POST_DEPLOY_DATA_METRIC_IDS,
  POST_DEPLOY_DATA_REGRESSION_MAX_DROP_RATIO,
  POST_DEPLOY_DATA_REGRESSION_WAIT_SEC,
  POST_DEPLOY_DATA_SNAPSHOT_VERSION,
  buildPostDeployDataSnapshot,
  comparePostDeployDataSnapshots,
  formatPostDeployDataRegressionMarkdown,
  parsePostDeployDataSnapshot,
  type PostDeployDataEndpointKey,
  type PostDeployDataEndpointResult,
} from "../lib/post-deploy-data-regression.mts";

const CAPTURED_AT = 1_800_000_000;

function stablecoins(count: number, priced = count): unknown {
  return {
    peggedAssets: Array.from({ length: count }, (_value, index) => ({
      id: `coin-${index}`,
      price: index < priced ? 1 : null,
    })),
  };
}

function yieldRankings(counts: Partial<Record<"onchain" | "protocol-api" | "defillama" | "defillama-auto" | "rate-derived" | "price-derived", number>>): unknown {
  const rankings = Object.entries(counts).flatMap(([dataSource, count]) =>
    Array.from({ length: count ?? 0 }, (_value, index) => ({ id: `${dataSource}-${index}`, dataSource })));
  return { rankings };
}

function dexLiquidity(count: number): unknown {
  const map: Record<string, unknown> = {
    __global__: { poolCount: 999 },
    missing: {},
  };
  for (let index = 0; index < count; index += 1) {
    map[`coin-${index}`] = { poolCount: index === 0 ? 0 : 2 };
  }
  return map;
}

function defaultPayload(endpoint: PostDeployDataEndpointKey): unknown {
  switch (endpoint) {
    case "stablecoins":
      return stablecoins(60);
    case "yield-rankings":
      return yieldRankings({ onchain: 5, "protocol-api": 5, defillama: 5, "defillama-auto": 5, "rate-derived": 5, "price-derived": 5 });
    case "depeg-events":
      return { events: [], total: 30 };
    case "mint-burn-flows":
      return { coins: Array.from({ length: 25 }, (_value, index) => ({ stablecoinId: `coin-${index}` })) };
    case "dex-liquidity":
      return dexLiquidity(25);
    case "daily-digest":
      return { digest: "edition copy", digestTitle: "Title" };
  }
}

function endpointResults(
  overrides: Partial<Record<PostDeployDataEndpointKey, unknown>> = {},
  statusOverrides: Partial<Record<PostDeployDataEndpointKey, { status: number; ok: boolean }>> = {},
): PostDeployDataEndpointResult[] {
  return POST_DEPLOY_DATA_ENDPOINTS.map((definition) => {
    const status = statusOverrides[definition.key] ?? { status: 200, ok: true };
    return {
      endpoint: definition.key,
      path: definition.path,
      producer: definition.producer,
      status: status.status,
      ok: status.ok,
      generation: 1_799_999_000,
      error: status.ok ? null : "unavailable",
      payload: overrides[definition.key] ?? defaultPayload(definition.key),
    };
  });
}

function snapshot(
  overrides: Partial<Record<PostDeployDataEndpointKey, unknown>> = {},
  statusOverrides: Partial<Record<PostDeployDataEndpointKey, { status: number; ok: boolean }>> = {},
) {
  return buildPostDeployDataSnapshot(endpointResults(overrides, statusOverrides), CAPTURED_AT);
}

function compared(baseline = snapshot(), current = snapshot()) {
  return comparePostDeployDataSnapshots(baseline, current, { budgetSeconds: POST_DEPLOY_DATA_REGRESSION_WAIT_SEC });
}

function metricValue(snapshotValue: ReturnType<typeof snapshot>, id: string): number | null {
  return snapshotValue.metrics.find((metric) => metric.id === id)?.value ?? null;
}

describe("post-deploy data snapshot extraction", () => {
  it("reports every metric in the fixed roster", () => {
    const value = snapshot();
    expect(value.metrics.map((metric) => metric.id)).toEqual(POST_DEPLOY_DATA_METRIC_IDS);
    expect(POST_DEPLOY_DATA_METRIC_IDS).toContain("yield.rankings.source.price-derived");
    expect(metricValue(value, "stablecoins.active")).toBe(60);
    expect(metricValue(value, "stablecoins.priced")).toBe(60);
    expect(metricValue(value, "yield.rankings.total")).toBe(30);
    expect(metricValue(value, "yield.rankings.source.price-derived")).toBe(5);
    expect(metricValue(value, "depeg.events.total")).toBe(30);
    expect(metricValue(value, "mint-burn.coins")).toBe(25);
    expect(metricValue(value, "dex-liquidity.coins-with-pools")).toBe(24);
    expect(metricValue(value, "digest.present")).toBe(1);
    expect(value.endpoints.every((endpoint) => endpoint.generation === 1_799_999_000)).toBe(true);
  });

  it("keeps explicitly absent cohorts at zero and unreadable payloads unknown", () => {
    const value = snapshot({ "daily-digest": { digest: null }, "yield-rankings": { rankings: "not-an-array" } });
    expect(metricValue(value, "digest.present")).toBe(0);
    expect(metricValue(value, "yield.rankings.total")).toBeNull();
    expect(value.metrics.find((metric) => metric.id === "yield.rankings.total")?.unavailableReason)
      .toBe("payload-unavailable");
  });

  it("records a failed endpoint as unavailable instead of zero", () => {
    const value = snapshot({}, { "mint-burn-flows": { status: 503, ok: false } });
    expect(metricValue(value, "mint-burn.coins")).toBeNull();
    expect(value.metrics.find((metric) => metric.id === "mint-burn.coins")?.unavailableReason).toBe("endpoint-http-503");
  });
});

describe("post-deploy data comparison", () => {
  it("passes unchanged volume", () => {
    const report = compared();
    expect(report.outcome).toBe("passed");
    expect(report.reason).toBe("data-volume-stable");
    expect(report.findings.every((finding) => finding.status === "ok")).toBe(true);
  });

  it("fails when a yield source family loses more than half of its rows", () => {
    const baseline = snapshot({ "yield-rankings": yieldRankings({ onchain: 1, "price-derived": 24 }) });
    const current = snapshot({ "yield-rankings": yieldRankings({ onchain: 20, "price-derived": 5 }) });
    const report = compared(baseline, current);
    expect(report.outcome).toBe("failed");
    expect(report.reason).toBe("metric-drop-exceeds-threshold:yield.rankings.source.price-derived");
    expect(report.findings.find((finding) => finding.metric === "yield.rankings.total"))
      .toMatchObject({ status: "ok", baseline: 25, current: 25 });
    expect(report.findings.find((finding) => finding.metric === "yield.rankings.source.price-derived"))
      .toMatchObject({ status: "dropped", reason: "metric-drop-exceeds-threshold", baseline: 24, current: 5 });
  });

  it("allows a drop of exactly 50% and ignores baselines under the per-metric minimum", () => {
    const half = compared(snapshot({ stablecoins: stablecoins(60) }), snapshot({ stablecoins: stablecoins(30) }));
    expect(half.outcome).toBe("passed");

    const tiny = compared(
      snapshot({ "yield-rankings": yieldRankings({ onchain: 20, "price-derived": 5 }) }),
      snapshot({ "yield-rankings": yieldRankings({ onchain: 20 }) }),
    );
    expect(tiny.outcome).toBe("passed");
    expect(tiny.findings.find((finding) => finding.metric === "yield.rankings.source.price-derived"))
      .toMatchObject({ status: "ok", reason: "metric-baseline-below-minimum", baseline: 5, current: 0 });
  });

  it("never turns an unreadable current count into a drop", () => {
    const report = compared(snapshot(), snapshot({ "yield-rankings": {} }));
    expect(report.outcome).toBe("unknown");
    expect(report.reason).toContain("metric-current-unavailable");
    expect(report.findings.some((finding) => finding.status === "dropped")).toBe(false);
  });

  it("fails a current 5xx and treats other endpoint read failures as unknown", () => {
    const fiveHundred = compared(snapshot(), snapshot({}, { "depeg-events": { status: 503, ok: false } }));
    expect(fiveHundred.outcome).toBe("failed");
    expect(fiveHundred.reason).toBe("endpoint-http-5xx:depeg-events");
    expect(fiveHundred.endpointFailures).toEqual([
      expect.objectContaining({ endpoint: "depeg-events", status: 503, reason: "endpoint-http-5xx" }),
    ]);

    const rateLimited = compared(snapshot(), snapshot({}, { "depeg-events": { status: 429, ok: false } }));
    expect(rateLimited.outcome).toBe("unknown");
    expect(rateLimited.reason).toContain("endpoint-read-failed");
  });

  it("reports an unavailable baseline as unknown, not as a healthy pass", () => {
    const report = compared(snapshot({}, { "mint-burn-flows": { status: 503, ok: false } }), snapshot());
    expect(report.outcome).toBe("unknown");
    expect(report.findings.find((finding) => finding.metric === "mint-burn.coins"))
      .toMatchObject({ status: "unknown", reason: "metric-baseline-unavailable" });
  });

  it("skips a pages-only deploy", () => {
    const baseline = parsePostDeployDataSnapshot(JSON.parse(JSON.stringify(
      buildPostDeployDataSnapshot([], CAPTURED_AT, { reason: "worker-not-required" }),
    )));
    const report = compared(baseline, snapshot());
    expect(report.outcome).toBe("skipped");
    expect(report.reason).toBe("baseline-skipped:worker-not-required");
  });
});

describe("post-deploy data snapshot schema", () => {
  it("round-trips a strict snapshot and rejects malformed evidence", () => {
    const value = snapshot();
    expect(parsePostDeployDataSnapshot(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(() => parsePostDeployDataSnapshot({ ...value, version: POST_DEPLOY_DATA_SNAPSHOT_VERSION + 1 }))
      .toThrow(/version/);
    expect(() => parsePostDeployDataSnapshot({
      ...value,
      metrics: [{ ...value.metrics[0], value: "high" }],
    })).toThrow(/metric reading/);
  });

  it("formats reason codes, producers, budgets and generations for the operator issue", () => {
    const report = compared(
      snapshot({ "yield-rankings": yieldRankings({ onchain: 1, "price-derived": 24 }) }),
      snapshot({ "yield-rankings": yieldRankings({ onchain: 20, "price-derived": 5 }) }),
    );
    const markdown = formatPostDeployDataRegressionMarkdown(report);
    expect(markdown).toContain("metric-drop-exceeds-threshold:yield.rankings.source.price-derived");
    expect(markdown).toContain("sync-yield-data");
    expect(markdown).toContain(`Observation budget: ${POST_DEPLOY_DATA_REGRESSION_WAIT_SEC}s`);
    expect(markdown).toContain("Generation");
    expect(markdown).toContain(`${POST_DEPLOY_DATA_REGRESSION_MAX_DROP_RATIO * 100}%`);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs";
import { buildSnapshot, compareSnapshots } from "../maintenance/audit-redemption-registry-parity";

describe("redemption registry parity", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "redemption-parity-")); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  function compareWithCli(before: unknown, after: unknown) {
    const beforePath = join(directory, "before.json");
    const afterPath = join(directory, "after.json");
    writeFileSync(beforePath, JSON.stringify(before));
    writeFileSync(afterPath, JSON.stringify(after));
    return spawnSync(process.execPath, [
      "--import", "tsx", "scripts/maintenance/audit-redemption-registry-parity.ts",
      "--compare", beforePath, afterPath,
    ], { encoding: "utf8" });
  }

  it.each([
    ["outputAssets", ["usdt-tether"]],
    ["unresolvedOutputAssetKeys", ["asset:reviewed-external"]],
    ["unresolvedOutputDisposition", "issuer-undisclosed"],
    ["routeSuspension", { reviewedAt: "2026-10-01", effectiveAt: "2026-06-30" }],
    ["routeExitCorrelation", "independent-issuer-rail"],
    ["physicalCommodityDelivery", { unit: "troy-oz", minimumUnits: 1000 }],
    ["physicalToUsd", { reviewedAt: "2026-10-01", settlementDelaySec: 604800 }],
    ["v9RouteCostTerms", { kind: "fee-bps", feeBps: 25 }],
    ["v9RouteReviewTerms", { reviewedAt: "2020-01-01", settlementDelaySec: 604800 }],
    ["v9ComposedDexExit", { intermediateAssetId: "usdc-circle" }],
    ["reviewedAt", "2020-01-01"],
    ["docs", [{ label: "Changed review", url: "https://example.com/terms", supports: ["settlement"] }]],
    ["notes", ["Conditional completion; issuer may postpone payout"]],
  ])("rejects a material authored %s change through --compare", (field, value) => {
    const config = REDEMPTION_BACKSTOP_CONFIGS["lusd-liquity"];
    const before = buildSnapshot({ test: config });
    const after = buildSnapshot({ test: { ...config, [field]: value } });
    const result = compareWithCli(before, after);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`registry.test.${field}:`);
  });

  it("compares an unchanged finalized registry equal regardless of object key order", () => {
    const before = buildSnapshot();
    const after = { registry: [...before.registry].reverse().map((row) => Object.fromEntries(
      Object.entries(row as Record<string, unknown>).reverse(),
    )) };
    const result = compareWithCli(before, after);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(compareSnapshots(join(directory, "before.json"), join(directory, "after.json"))).toEqual([]);
  });

  it("captures every config field without projecting supply-full into immediate capacity", () => {
    const config = Object.values(REDEMPTION_BACKSTOP_CONFIGS).find((entry) => entry.capacityModel.kind === "supply-full")!;
    const snapshot = buildSnapshot({ test: config });
    expect(snapshot.registry).toEqual([{ ...config, stablecoinId: "test" }]);
    expect(snapshot).not.toHaveProperty("staticScores");
    expect(snapshot.registry[0]).not.toHaveProperty("immediateCapacityUsd");
    expect(snapshot.registry[0]).not.toHaveProperty("immediateCapacityRatio");
  });

  it("rejects review expiry changes without changing the reviewed route terms", () => {
    const config = REDEMPTION_BACKSTOP_CONFIGS["mre7yield-midas"];
    const result = compareWithCli(
      buildSnapshot({ test: config }),
      buildSnapshot({ test: {
        ...config,
        v9RouteReviewTerms: { ...config.v9RouteReviewTerms, reviewedAt: "2020-01-01" },
      } }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("registry.test.v9RouteReviewTerms:");
  });
});

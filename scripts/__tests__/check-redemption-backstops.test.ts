import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run as runRedemptionBackstopCli } from "../ci/check-redemption-backstops";
import { validateRedemptionBackstopRegistry } from "../lib/redemption-backstop-validation";
import { defineRecordEntries } from "@shared/lib/redemption-backstop-configs/factory";
import type { RedemptionBackstopConfigManifestEntry } from "@shared/lib/redemption-backstop-configs";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";
import { createTempRepoTracker } from "./helpers/test-state";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";

const { makeRoot, cleanup } = createTempRepoTracker("redemption-backstops");
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const GATE_LOAD_TIMEOUT_MS = 15_000;

const baseConfig: RedemptionBackstopConfig = {
  routeFamily: "offchain-issuer",
  accessModel: "issuer-api",
  settlementModel: "same-day",
  executionModel: "rules-based-nav",
  outputAssetType: "stable-single",
  capacityModel: { kind: "supply-full" },
  costModel: {
    kind: "dynamic-or-unclear",
    feeDescription: "Public docs reviewed do not publish a numeric redemption fee.",
  },
};

function runFixture(
  configs: Record<string, RedemptionBackstopConfig>,
  manifestOverrides: Partial<RedemptionBackstopConfigManifestEntry> = {},
) {
  const manifest: RedemptionBackstopConfigManifestEntry[] = [
    {
      name: "fixture",
      filePath: "fixture.ts",
      entries: defineRecordEntries(configs),
      allowedRouteFamilies: ["offchain-issuer", "stablecoin-redeem", "psm-swap"],
      ...manifestOverrides,
    },
  ];
  return runRedemptionBackstopCli([], {
    manifest,
    validate: validateRedemptionBackstopRegistry,
    mergedConfigs: configs,
    sourceTextByPath: new Map(),
  });
}

function validateFixture(
  configs: Record<string, RedemptionBackstopConfig>,
  manifestOverrides: Partial<RedemptionBackstopConfigManifestEntry> = {},
) {
  const result = runFixture(configs, manifestOverrides);
  if (!result.validation) throw new Error("Fixture validation did not produce a result.");
  return result.validation;
}

describe("check-redemption-backstops CLI", () => {
  it("serializes a valid production registry to stdout and a nested report file", () => {
    const reportPath = join(makeRoot(), "nested", "reports", "report.json");
    const result = spawnSync("node_modules/.bin/tsx", [
      "scripts/ci/check-redemption-backstops.ts", "--json", "--report", reportPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const stdout = result.stdout;

    expect(readFileSync(reportPath, "utf8")).toBe(stdout);
    const report = JSON.parse(stdout) as {
      summary: { configuredCount: number };
      findings: Array<{ severity: string }>;
      auditRows: Array<{ stablecoinId: string }>;
    };
    expect(report.summary.configuredCount).toBeGreaterThan(0);
    expect(report.auditRows).toHaveLength(report.summary.configuredCount);
    expect(new Set(report.auditRows.map((row) => row.stablecoinId)).size).toBe(report.auditRows.length);
    expect(report.findings.filter((finding) => finding.severity === "error")).toEqual([]);
  }, GATE_LOAD_TIMEOUT_MS);

  it.each(["krusdc-keyrock", "steakusdg-steakhouse", "steakeurcv-steakhouse"])(
    "requires %s to retain its execution-only baseline rather than unconditionally consume reserve telemetry",
    (id) => {
      const config = getRedemptionBackstopConfig(id)!;
      const executionOnly = validateFixture({ [id]: config });
      expect(executionOnly.findings.filter((finding) => finding.stablecoinId === id && finding.severity === "error")).toEqual([]);

      const reserveConsuming = validateFixture({
        [id]: { ...config, capacityModel: { kind: "reserve-sync-metadata" } },
      });
      expect(reserveConsuming.findings).toContainEqual(expect.objectContaining({
        severity: "error", code: "unused-live-telemetry-policy-stale", stablecoinId: id,
      }));
    },
  );

  it.each([false, true])("retains unused native-M policy only with exact payout admission (bound=%s)", (bound) => {
    const config = getRedemptionBackstopConfig("usdr-rise")!;
    const report = validateFixture({
      "usdr-rise": {
        ...config,
        capacityModel: {
          kind: "reserve-sync-metadata",
          ...(bound ? { requiredOutputAssetKeys: ["wm-m0"] } : {}),
        },
      },
    });
    const stale = report.findings.some((finding) =>
      finding.code === "unused-live-telemetry-policy-stale" && finding.stablecoinId === "usdr-rise",
    );
    expect(stale).toBe(!bound);
  });


  it("requires dailyLimitUsd when config text cites a numeric daily limit", () => {
    const result = validateFixture(
      {
        "lisusd-lista": {
          ...baseConfig,
          routeFamily: "psm-swap",
          accessModel: "permissionless-onchain",
          settlementModel: "atomic",
          executionModel: "deterministic-onchain",
          capacityModel: { kind: "supply-ratio", ratio: 0.15 },
          costModel: {
            kind: "fee-bps",
            feeBps: 200,
            feeDescription: "Fixture docs publish a 500,000 token daily redemption limit.",
          },
        },
      },
      { allowedRouteFamilies: ["psm-swap"] },
    );

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "daily-limit-mentioned-without-capacity-limit",
        stablecoinId: "lisusd-lista",
      }),
    );
  });

  it("ratchets active stablecoin redemption config coverage", () => {
    const result = validateRedemptionBackstopRegistry({
      manifest: [],
      mergedConfigs: {},
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "unconfigured-active-ratchet-regressed",
      }),
    );
  });

  it("requires a policy when active live redemption telemetry is not consumed", () => {
    const result = validateFixture({
      "frxusd-frax": {
        ...baseConfig,
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
      },
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "unused-live-redemption-telemetry",
        stablecoinId: "frxusd-frax",
      }),
    );
  });
});

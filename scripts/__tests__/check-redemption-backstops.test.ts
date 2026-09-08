import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateRedemptionBackstopRegistry } from "../lib/redemption-backstop-validation";
import { defineRecordEntries } from "@shared/lib/redemption-backstop-configs/factory";
import type { RedemptionBackstopConfigManifestEntry } from "@shared/lib/redemption-backstop-configs";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";
import { createTempRepoTracker } from "./helpers/test-state";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";

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

function validateFixture(
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
  return validateRedemptionBackstopRegistry({
    manifest,
    mergedConfigs: configs,
  });
}

describe("check-redemption-backstops CLI", () => {
  it("serializes a valid production registry to stdout and a nested report file", () => {
    const reportPath = join(makeRoot(), "nested", "reports", "report.json");
    const stdout = execFileSync("node_modules/.bin/tsx", [
      "scripts/ci/check-redemption-backstops.ts", "--json", "--report", reportPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

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

  it("orders fixture audit rows deterministically regardless of insertion order", () => {
    const first = validateFixture({ "usdt-tether": baseConfig, "usdc-circle": baseConfig });
    const second = validateFixture({ "usdc-circle": baseConfig, "usdt-tether": baseConfig });

    expect(first.auditRows.map((row) => row.stablecoinId)).toEqual(["usdc-circle", "usdt-tether"]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("reports precisely the unconfigured fixture cohort without warning for configured coins", () => {
    vi.spyOn(ACTIVE_META_BY_ID, "keys").mockImplementation(() => new Map([
      ["usdt-tether", true], ["unconfigured-fixture", true],
    ]).keys());
    const result = validateFixture({ "usdt-tether": baseConfig });
    expect(result.auditRows.map((row) => row.stablecoinId)).toEqual(["usdt-tether"]);
    expect(result.findings.filter((finding) => finding.code === "unconfigured-active-coin")).toEqual([
      expect.objectContaining({ severity: "warning", stablecoinId: "unconfigured-fixture" }),
    ]);
  });

  it("rejects unknown CLI arguments", () => {
    const result = spawnSync("node_modules/.bin/tsx", ["scripts/ci/check-redemption-backstops.ts", "--bad-arg"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown argument: --bad-arg");
  }, GATE_LOAD_TIMEOUT_MS);

  it("rejects non-http docs URLs and invalid calendar review dates", () => {
    const result = validateFixture({
      "usdt-tether": {
        ...baseConfig,
        reviewedAt: "2026-02-30",
        docs: [{ label: "Fixture", url: "ftp://example.com/redemption", supports: ["route"] }],
      },
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema-validation",
          stablecoinId: "usdt-tether",
          message: expect.stringContaining("Expected an http(s) URL"),
        }),
        expect.objectContaining({
          code: "schema-validation",
          stablecoinId: "usdt-tether",
          message: expect.stringContaining("Expected a valid calendar date"),
        }),
      ]),
    );
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

  it("reports resolved capacity basis, fallback source, and daily limit caps in audit rows", () => {
    const result = validateFixture(
      {
        "lisusd-lista": {
          ...baseConfig,
          routeFamily: "psm-swap",
          accessModel: "permissionless-onchain",
          settlementModel: "atomic",
          executionModel: "deterministic-onchain",
          capacityModel: { kind: "supply-ratio", ratio: 0.15, dailyLimitUsd: 500_000 },
        },
      },
      { allowedRouteFamilies: ["psm-swap"] },
    );

    expect(result.auditRows).toEqual([
      expect.objectContaining({
        stablecoinId: "lisusd-lista",
        capacityBasis: null,
        resolvedCapacityBasis: "psm-balance-share",
        capacityFallbackSource: "none",
        dailyLimitUsd: 500_000,
      }),
    ]);
  });

  it("reports reserve-sync fallback ratio sources separately from resolved basis", () => {
    const result = validateFixture({
      "frxusd-frax": {
        ...baseConfig,
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.1 },
        reviewedAt: "2026-05-12",
        docs: [{ label: "Fixture", url: "https://example.com/frxusd-redemption", supports: ["route", "capacity"] }],
      },
      "sfrxusd-frax": {
        ...baseConfig,
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        capacityModel: { kind: "reserve-sync-metadata", fallbackUsd: 1_000_000 },
        reviewedAt: "2026-05-12",
        docs: [{ label: "Fixture", url: "https://example.com/sfrxusd-redemption", supports: ["route", "capacity"] }],
      },
    });

    expect(result.auditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stablecoinId: "frxusd-frax",
          resolvedCapacityBasis: "live-proxy-buffer",
          capacityFallbackSource: "reserve-sync-fallback-ratio",
          dailyLimitUsd: null,
        }),
        expect.objectContaining({
          stablecoinId: "sfrxusd-frax",
          resolvedCapacityBasis: "live-direct-telemetry",
          capacityFallbackSource: "reserve-sync-fallback-usd",
          dailyLimitUsd: null,
        }),
      ]),
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

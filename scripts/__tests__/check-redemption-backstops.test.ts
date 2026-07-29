import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { validateRedemptionBackstopRegistry } from "../lib/redemption-backstop-validation";
import { defineRecordEntries } from "@shared/lib/redemption-backstop-configs/factory";
import type { RedemptionBackstopConfigManifestEntry } from "@shared/lib/redemption-backstop-configs";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";

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
      configs,
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
  it("prints machine-readable JSON when --json is passed", () => {
    const stdout = execFileSync("npx", ["tsx", "scripts/ci/check-redemption-backstops.ts", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const report = JSON.parse(stdout) as {
      summary: { configuredCount: number };
      findings: Array<{ severity: string }>;
      auditRows: unknown[];
    };
    expect(report.summary.configuredCount).toBe(310);
    expect(report.auditRows).toHaveLength(310);
    expect(report.findings.some((finding) => finding.severity === "error")).toBe(false);
  }, GATE_LOAD_TIMEOUT_MS);

  it("writes deterministic JSON report data", () => {
    const reportPath = join(mkdtempSync(join(tmpdir(), "redemption-backstops-")), "report.json");

    execFileSync("npx", ["tsx", "scripts/ci/check-redemption-backstops.ts", "--report", reportPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report.summary.configuredCount).toBe(310);
    expect(report.auditRows).toHaveLength(310);
    expect(report.auditRows[0]).toMatchObject({
      stablecoinId: expect.any(String),
      routeFamily: expect.any(String),
      capacityConfidence: expect.any(String),
      resolvedCapacityBasis: expect.any(String),
      capacityFallbackSource: expect.any(String),
    });
    expect(report.auditRows[0]).toHaveProperty("reviewedAt");
    expect(
      report.auditRows.find((row: { stablecoinId: string }) => row.stablecoinId === "ybold-yearn"),
    ).toMatchObject({
      filePath: "shared/lib/redemption-backstop-configs/stablecoin-redeem/configs.ts",
    });
    expect(
      report.auditRows.find((row: { stablecoinId: string }) => row.stablecoinId === "fdusd-first-digital"),
    ).toMatchObject({
      feeModelKind: "undisclosed-reviewed",
    });
  }, GATE_LOAD_TIMEOUT_MS);

  it("preserves warning findings in reports while exiting successfully", () => {
    const reportPath = join(mkdtempSync(join(tmpdir(), "redemption-backstops-warnings-")), "report.json");

    execFileSync("npx", ["tsx", "scripts/ci/check-redemption-backstops.ts", "--report", reportPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      findings: Array<{ severity: string; code: string }>;
    };
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          code: "documented-bound-missing-route-support",
        }),
      ]),
    );
    expect(report.findings.some((finding) => finding.severity === "error")).toBe(false);
  }, GATE_LOAD_TIMEOUT_MS);

  it("creates parent directories for nested JSON reports", () => {
    const cwd = mkdtempSync(join(tmpdir(), "redemption-backstops-nested-"));
    const reportPath = join(cwd, "nested", "reports", "report.json");

    execFileSync("npx", ["tsx", "scripts/ci/check-redemption-backstops.ts", "--report", reportPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      summary: { configuredCount: number };
    };
    expect(report.summary.configuredCount).toBe(310);
  }, GATE_LOAD_TIMEOUT_MS);

  it("rejects unknown CLI arguments", () => {
    const result = spawnSync("npx", ["tsx", "scripts/ci/check-redemption-backstops.ts", "--bad-arg"], {
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

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { validateRedemptionBackstopRegistry } from "../lib/redemption-backstop-validation";
import type { RedemptionBackstopConfigManifestEntry } from "@shared/lib/redemption-backstop-configs";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";

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
  it("writes deterministic JSON report data", () => {
    const reportPath = join(mkdtempSync(join(tmpdir(), "redemption-backstops-")), "report.json");

    execFileSync("npx", ["tsx", "scripts/ci/check-redemption-backstops.ts", "--report", reportPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report.summary.configuredCount).toBe(311);
    expect(report.auditRows).toHaveLength(311);
    expect(report.auditRows[0]).toMatchObject({
      stablecoinId: expect.any(String),
      routeFamily: expect.any(String),
      capacityConfidence: expect.any(String),
    });
    expect(report.auditRows[0]).toHaveProperty("reviewedAt");
    expect(report.auditRows.find((row: { stablecoinId: string }) => row.stablecoinId === "ybold-yearn")).toMatchObject({
      filePath: "shared/lib/redemption-backstop-configs/stablecoin-redeem/ybold-yearn.ts",
    });
    expect(
      report.auditRows.find((row: { stablecoinId: string }) => row.stablecoinId === "fdusd-first-digital"),
    ).toMatchObject({
      feeModelKind: "undisclosed-reviewed",
    });
  });

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

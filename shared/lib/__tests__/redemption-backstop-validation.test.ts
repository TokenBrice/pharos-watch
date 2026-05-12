import { describe, expect, it } from "vitest";
import { validateRedemptionBackstopRegistry } from "@shared/lib/redemption-backstop-configs/validation";
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

function validateFixture(manifest: RedemptionBackstopConfigManifestEntry[]) {
  return validateRedemptionBackstopRegistry({
    manifest,
    mergedConfigs: Object.assign({}, ...manifest.map((entry) => entry.configs)),
  });
}

describe("validateRedemptionBackstopRegistry", () => {
  it("reports duplicate IDs across manifest families", () => {
    const result = validateFixture([
      {
        name: "issuer-a",
        filePath: "issuer-a.ts",
        configs: { "usdt-tether": baseConfig },
        allowedRouteFamilies: ["offchain-issuer"],
      },
      {
        name: "issuer-b",
        filePath: "issuer-b.ts",
        configs: { "usdt-tether": baseConfig },
        allowedRouteFamilies: ["offchain-issuer"],
      },
    ]);

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "duplicate-id",
        stablecoinId: "usdt-tether",
      }),
    );
  });

  it("reports route family mismatches with owner metadata", () => {
    const result = validateFixture([
      {
        name: "issuer",
        filePath: "issuer.ts",
        configs: {
          "usdt-tether": {
            ...baseConfig,
            routeFamily: "psm-swap",
          },
        },
        allowedRouteFamilies: ["offchain-issuer"],
      },
    ]);

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "route-family-mismatch",
        stablecoinId: "usdt-tether",
        family: "issuer",
        filePath: "issuer.ts",
      }),
    );
  });

  it("reports static overwrite patterns when source text is provided", () => {
    const sourceTextByPath = new Map([
      [
        "issuer.ts",
        `
          export const ISSUER_BACKSTOP_CONFIGS = {
            ...expandIds(["usdt-tether"], baseConfig),
            "usdt-tether": baseConfig,
          };
        `,
      ],
    ]);

    const result = validateRedemptionBackstopRegistry({
      manifest: [
        {
          name: "issuer",
          filePath: "issuer.ts",
          configs: { "usdt-tether": baseConfig },
          allowedRouteFamilies: ["offchain-issuer"],
        },
      ],
      mergedConfigs: { "usdt-tether": baseConfig },
      sourceTextByPath,
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "unapproved-config-overwrite",
        stablecoinId: "usdt-tether",
      }),
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  defineBackstopRegistry,
  defineBatch,
  defineRecordEntries,
} from "@shared/lib/redemption-backstop-configs/factory";
import { buildRedemptionBackstopRegistry } from "@shared/lib/redemption-backstop-configs/manifest";
import { RedemptionBackstopConfigSchema } from "@shared/lib/redemption-backstop-configs/schema";
import {
  getAllowedRedemptionCapacityWarningReason,
  isRedemptionFreshnessAllowedByPolicy,
} from "@shared/lib/redemption-backstop-configs/policies";
import { validateRedemptionBackstopRegistry } from "../../../scripts/lib/redemption-backstop-validation";
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

type ManifestFixture = Omit<RedemptionBackstopConfigManifestEntry, "entries">;

/** Fixtures declare configs only; entries carry no extra metadata unless a test adds it. */
function toManifest(modules: ManifestFixture[]): RedemptionBackstopConfigManifestEntry[] {
  return modules.map((module) => ({ ...module, entries: defineRecordEntries(module.configs) }));
}

function validateFixture(modules: ManifestFixture[]) {
  const manifest = toManifest(modules);
  return validateRedemptionBackstopRegistry({
    manifest,
    mergedConfigs: Object.assign({}, ...manifest.map((entry) => entry.configs)),
  });
}

describe("validateRedemptionBackstopRegistry", () => {
  it("rejects duplicate factory entries unless the later entry carries an override reason", () => {
    expect(() =>
      defineBackstopRegistry([
        ...defineBatch(["usdt-tether"], baseConfig),
        ...defineBatch(["usdt-tether"], baseConfig),
      ]),
    ).toThrow(/duplicated without an override reason/);
  });

  it("lets a later entry with an override reason win", () => {
    const registry = defineBackstopRegistry([
      ...defineBatch(["usdt-tether"], baseConfig),
      {
        id: "usdt-tether",
        config: { ...baseConfig, settlementModel: "days" as const },
        overrideReason: "Reviewed issuer terms document slower settlement.",
      },
    ]);

    expect(registry["usdt-tether"].settlementModel).toBe("days");
  });

  it("keeps redemption policy approvals in owned shared config", () => {
    expect(
      isRedemptionFreshnessAllowedByPolicy({
        stablecoinId: "frxusd-frax",
        freshnessKind: "unverified",
        hasScoringEligibleFreshness: false,
      }),
    ).toBe(true);
    expect(
      isRedemptionFreshnessAllowedByPolicy({
        stablecoinId: "usdt-tether",
        freshnessKind: "unverified",
        hasScoringEligibleFreshness: false,
      }),
    ).toBe(false);
    expect(
      getAllowedRedemptionCapacityWarningReason("gho-aave", {
        code: "aggregated-residual-issuance",
        effect: "degraded",
      }),
    ).toContain("lower-bound redemption capacity");
  });

  it("allows V9 route reviews to preserve or worsen settlement but never improve it", () => {
    expect(
      RedemptionBackstopConfigSchema.safeParse({
        ...baseConfig,
        v9RouteReviewTerms: { minRedeemUsd: 100_000, settlementModel: "days" },
      }).success,
    ).toBe(true);

    const faster = RedemptionBackstopConfigSchema.safeParse({
      ...baseConfig,
      settlementModel: "days",
      v9RouteReviewTerms: { settlementModel: "same-day" },
    });
    expect(faster.success).toBe(false);
    if (!faster.success) {
      expect(faster.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["v9RouteReviewTerms", "settlementModel"],
          message: "V9 reviewed settlement cannot be faster than the frozen settlement model",
        }),
      );
    }

    expect(
      RedemptionBackstopConfigSchema.safeParse({
        ...baseConfig,
        v9RouteReviewTerms: { minRedeemUsd: -1 },
      }).success,
    ).toBe(false);
  });

  it("surfaces reviewed redemption policy entries in the audit report", () => {
    const result = validateFixture([
      {
        name: "issuer",
        filePath: "issuer.ts",
        configs: { "usdt-tether": baseConfig },
        allowedRouteFamilies: ["offchain-issuer"],
      },
    ]);

    expect(result.policyRows).toContainEqual(
      expect.objectContaining({
        kind: "unverified-freshness",
        stablecoinId: "frxusd-frax",
        owner: "redemption-backstop-v4",
        reviewedAt: "2026-05-12",
      }),
    );
    expect(result.findings.filter((finding) => finding.code.startsWith("redemption-policy-"))).toEqual([]);
  });

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

  it("reports duplicate IDs when using the default merged registry path", () => {
    const result = validateRedemptionBackstopRegistry({
      manifest: toManifest([
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
      ]),
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "duplicate-id",
        stablecoinId: "usdt-tether",
      }),
    );
  });

  it("fails fast when the runtime registry builder sees duplicate shard IDs", () => {
    expect(() =>
      buildRedemptionBackstopRegistry(
        toManifest([
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
        ]),
      ),
    ).toThrow(
      'Duplicate redemption backstop config id "usdt-tether" appears in both issuer-a (issuer-a.ts) and issuer-b (issuer-b.ts).',
    );
  });

  it("carries entry override and source-file metadata into the merged registry and audit", () => {
    const issuerEntries = [
      ...defineBatch(["usdt-tether"], baseConfig, { sourceFilePath: "issuer-base.ts" }),
      {
        id: "usdt-tether",
        config: { ...baseConfig, settlementModel: "days" as const },
        overrideReason: "Reviewed issuer terms document slower settlement.",
        sourceFilePath: "issuer-override.ts",
      },
    ];
    const manifest: RedemptionBackstopConfigManifestEntry[] = [
      {
        name: "issuer",
        filePath: "issuer.ts",
        configs: defineBackstopRegistry(issuerEntries),
        entries: issuerEntries,
        allowedRouteFamilies: ["offchain-issuer"],
      },
      {
        name: "plain",
        filePath: "plain.ts",
        configs: { "usdc-circle": baseConfig },
        entries: defineRecordEntries({ "usdc-circle": baseConfig }, { sourceFilePath: "plain.ts" }),
        allowedRouteFamilies: ["offchain-issuer"],
      },
    ];

    const registry = buildRedemptionBackstopRegistry(manifest);
    expect(registry["usdt-tether"].settlementModel).toBe("days");

    const audit = validateRedemptionBackstopRegistry({ manifest, mergedConfigs: registry });
    expect(audit.auditRows).toContainEqual(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        filePath: "issuer-override.ts",
        overrideReason: "Reviewed issuer terms document slower settlement.",
      }),
    );
    expect(audit.auditRows).toContainEqual(
      expect.objectContaining({
        stablecoinId: "usdc-circle",
        filePath: "plain.ts",
        overrideReason: null,
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
      manifest: toManifest([
        {
          name: "issuer",
          filePath: "issuer.ts",
          configs: { "usdt-tether": baseConfig },
          allowedRouteFamilies: ["offchain-issuer"],
        },
      ]),
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

  it("rejects live-derived capacity confidence in static configs", () => {
    const result = validateFixture([
      {
        name: "issuer",
        filePath: "issuer.ts",
        configs: {
          "usdt-tether": {
            ...baseConfig,
            capacityModel: {
              kind: "supply-ratio",
              ratio: 0.1,
              confidence: "live-direct",
            },
          } as unknown as RedemptionBackstopConfig,
        },
        allowedRouteFamilies: ["offchain-issuer"],
      },
    ]);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "static-live-capacity-confidence",
          stablecoinId: "usdt-tether",
        }),
        expect.objectContaining({
          severity: "error",
          code: "schema-validation",
          stablecoinId: "usdt-tether",
          message: expect.stringContaining("Invalid option"),
        }),
      ]),
    );
  });

  it("rejects fee model and capacity invariant mismatches", () => {
    const result = validateFixture([
      {
        name: "issuer",
        filePath: "issuer.ts",
        configs: {
          "usdt-tether": {
            ...baseConfig,
            capacityModel: {
              kind: "reserve-sync-metadata",
              fallbackRatio: 0.1,
              fallbackUsd: 1_000_000,
            },
            costModel: {
              kind: "dynamic-or-unclear",
              feeDescription: "Formula fee with tested bounds.",
              confidence: "formula",
              feeModelKind: "documented-variable",
              feeBpsMin: 100,
              feeBpsMax: 50,
              stressFeeBps: 25,
            },
          } as unknown as RedemptionBackstopConfig,
        },
        allowedRouteFamilies: ["offchain-issuer"],
      },
    ]);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema-validation",
          message: expect.stringContaining("fallbackRatio and fallbackUsd are mutually exclusive"),
        }),
        expect.objectContaining({
          code: "schema-validation",
          message: expect.stringContaining("feeBpsMin must be less than or equal to feeBpsMax"),
        }),
        expect.objectContaining({
          code: "schema-validation",
          message: expect.stringContaining("stressFeeBps must be greater than or equal"),
        }),
        expect.objectContaining({
          code: "schema-validation",
          message: expect.stringContaining("formula fee confidence requires feeModelKind=formula"),
        }),
      ]),
    );
  });

  it("rejects formula fee model kind without formula confidence", () => {
    const result = validateFixture([
      {
        name: "issuer",
        filePath: "issuer.ts",
        configs: {
          "usdt-tether": {
            ...baseConfig,
            costModel: {
              kind: "dynamic-or-unclear",
              feeDescription: "Formula fee is documented.",
              feeModelKind: "formula",
            },
          } as unknown as RedemptionBackstopConfig,
        },
        allowedRouteFamilies: ["offchain-issuer"],
      },
    ]);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema-validation",
          stablecoinId: "usdt-tether",
          message: expect.stringContaining("feeModelKind=formula requires formula fee confidence"),
        }),
      ]),
    );
  });

  it("rejects duplicate support tags on a redemption document source", () => {
    const result = validateFixture([
      {
        name: "issuer",
        filePath: "issuer.ts",
        configs: {
          "usdt-tether": {
            ...baseConfig,
            docs: [
              {
                label: "Fixture docs",
                url: "https://example.com/docs",
                supports: ["route", "route"],
              },
            ],
          } as unknown as RedemptionBackstopConfig,
        },
        allowedRouteFamilies: ["offchain-issuer"],
      },
    ]);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema-validation",
          stablecoinId: "usdt-tether",
          message: expect.stringContaining('Duplicate doc support "route"'),
        }),
      ]),
    );
  });

  it("warns when documented-bound configs lack route or capacity source support", () => {
    const result = validateFixture([
      {
        name: "issuer",
        filePath: "issuer.ts",
        configs: {
          "usdt-tether": {
            ...baseConfig,
            capacityModel: {
              kind: "supply-ratio",
              ratio: 0.1,
              confidence: "documented-bound",
            },
            reviewedAt: "2026-05-12",
            docs: [{ label: "Fixture fee docs", url: "https://example.com/fees", supports: ["fees"] }],
          },
        },
        allowedRouteFamilies: ["offchain-issuer"],
      },
    ]);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          code: "documented-bound-missing-route-support",
          stablecoinId: "usdt-tether",
          filePath: "issuer.ts",
        }),
        expect.objectContaining({
          severity: "warning",
          code: "documented-bound-missing-capacity-support",
          stablecoinId: "usdt-tether",
          filePath: "issuer.ts",
        }),
      ]),
    );
  });

  it("accepts documented-bound configs with explicit route and capacity source support", () => {
    const result = validateFixture([
      {
        name: "issuer",
        filePath: "issuer.ts",
        configs: {
          "usdt-tether": {
            ...baseConfig,
            capacityModel: {
              kind: "supply-ratio",
              ratio: 0.1,
              confidence: "documented-bound",
            },
            reviewedAt: "2026-05-12",
            docs: [
              {
                label: "Fixture redemption docs",
                url: "https://example.com/redemption",
                supports: ["route", "capacity", "fees"],
              },
            ],
          },
        },
        allowedRouteFamilies: ["offchain-issuer"],
      },
    ]);

    const supportWarnings = result.findings.filter(
      (finding) => finding.stablecoinId === "usdt-tether" && finding.code.startsWith("documented-bound-missing-"),
    );
    expect(supportWarnings).toEqual([]);
  });

  it("rejects invalid review dates and non-positive daily limits", () => {
    const result = validateFixture([
      {
        name: "issuer",
        filePath: "issuer.ts",
        configs: {
          "usdt-tether": {
            ...baseConfig,
            reviewedAt: "2999-01-01",
            docs: [{ label: "Fixture", url: "https://example.com/redemption" }],
            capacityModel: {
              kind: "supply-ratio",
              ratio: 0.1,
              dailyLimitUsd: 0,
            },
          },
        },
        allowedRouteFamilies: ["offchain-issuer"],
      },
    ]);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema-validation",
          stablecoinId: "usdt-tether",
          message: expect.stringContaining("reviewedAt cannot be in the future"),
        }),
        expect.objectContaining({
          code: "schema-validation",
          stablecoinId: "usdt-tether",
          message: expect.stringContaining("Too small"),
        }),
      ]),
    );
  });

  it("aligns configured output baskets to the 16-member exit-route asset-key bound", () => {
    const outputAssets = Array.from({ length: 16 }, (_, index) => `tracked-stablecoin-${index}`);
    expect(
      RedemptionBackstopConfigSchema.safeParse({
        ...baseConfig,
        outputAssetType: "stable-basket",
        outputAssets,
      }).success,
    ).toBe(true);

    const oversized = RedemptionBackstopConfigSchema.safeParse({
      ...baseConfig,
      outputAssetType: "stable-basket",
      outputAssets: [...outputAssets, "tracked-stablecoin-16"],
    });
    expect(oversized.success).toBe(false);
    if (!oversized.success) {
      expect(oversized.error.issues).toContainEqual(
        expect.objectContaining({ code: "too_big", path: ["outputAssets"], maximum: 16 }),
      );
    }

    const mixedTrackedAndUntracked = RedemptionBackstopConfigSchema.safeParse({
      ...baseConfig,
      outputAssetType: "stable-basket",
      outputAssets: ["usdc-circle", "asset:vbusdc"],
    });
    expect(mixedTrackedAndUntracked.success).toBe(false);
    if (!mixedTrackedAndUntracked.success) {
      expect(mixedTrackedAndUntracked.error.issues[0]?.message).toContain(
        "stable outputAssets must be tracked stablecoin ids",
      );
    }

    const unresolved = RedemptionBackstopConfigSchema.safeParse({
      ...baseConfig,
      outputAssetType: "stable-basket",
      unresolvedOutputAssetKeys: ["usdc-circle", "asset:vbusdc"],
      unresolvedOutputDisposition: "reviewed-external",
      reviewedAt: "2026-07-27",
    });
    expect(unresolved.success).toBe(true);

    const externalWithoutIdentity = RedemptionBackstopConfigSchema.safeParse({
      ...baseConfig,
      unresolvedOutputDisposition: "reviewed-external",
      reviewedAt: "2026-07-27",
    });
    expect(externalWithoutIdentity.success).toBe(false);
    if (!externalWithoutIdentity.success) {
      expect(externalWithoutIdentity.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["unresolvedOutputDisposition"],
          message: expect.stringContaining("requires unresolvedOutputAssetKeys"),
        }),
      );
    }

    const dispositionWithoutReviewDate = RedemptionBackstopConfigSchema.safeParse({
      ...baseConfig,
      unresolvedOutputAssetKeys: ["asset:vbusdc"],
      unresolvedOutputDisposition: "reviewed-external",
    });
    expect(dispositionWithoutReviewDate.success).toBe(false);
    if (!dispositionWithoutReviewDate.success) {
      expect(dispositionWithoutReviewDate.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["unresolvedOutputDisposition"],
          message: expect.stringContaining("requires reviewedAt"),
        }),
      );
    }

    const conflicting = RedemptionBackstopConfigSchema.safeParse({
      ...baseConfig,
      outputAssetType: "stable-basket",
      outputAssets: ["usdc-circle"],
      unresolvedOutputAssetKeys: ["asset:vbusdc"],
    });
    expect(conflicting.success).toBe(false);
    if (!conflicting.success) {
      expect(conflicting.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["unresolvedOutputAssetKeys"],
          message: expect.stringContaining("cannot be combined"),
        }),
      );
    }
  });
});

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

type ManifestFixture = Omit<RedemptionBackstopConfigManifestEntry, "entries"> & {
  configs: Record<string, RedemptionBackstopConfig>;
};

/** Fixtures declare configs only; entries carry no extra metadata unless a test adds it. */
function toManifest(modules: ManifestFixture[]): RedemptionBackstopConfigManifestEntry[] {
  return modules.map(({ configs, ...module }) => ({ ...module, entries: defineRecordEntries(configs) }));
}

function validateFixture(modules: ManifestFixture[]) {
  return validateRedemptionBackstopRegistry({ manifest: toManifest(modules) });
}

function singleOwner(config: RedemptionBackstopConfig = baseConfig): ManifestFixture {
  return {
    name: "issuer",
    filePath: "issuer.ts",
    configs: { "usdt-tether": config },
    allowedRouteFamilies: ["offchain-issuer"],
  };
}

describe("validateRedemptionBackstopRegistry", () => {
  it("rejects duplicate factory entries unless the later entry carries an override reason", () => {
    expect(() =>
      defineBackstopRegistry([
        ...defineBatch(["usdt-tether"], baseConfig),
        ...defineBatch(["usdt-tether"], baseConfig),
      ]),
    ).toThrow(/usdt-tether/);
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
    ).not.toBeNull();
    expect(getAllowedRedemptionCapacityWarningReason("usdt-tether", {
      code: "aggregated-residual-issuance", effect: "degraded",
    })).toBeNull();
  });

  it("allows conservative V9 route reviews and requires cited evidence for a faster settlement", () => {
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
          code: "custom",
        }),
      );
    }
    expect(RedemptionBackstopConfigSchema.safeParse({
      ...baseConfig,
      settlementModel: "days",
      v9RouteReviewTerms: {
        settlementModel: "same-day",
        settlementDelaySec: 3600,
        reviewedAt: "2026-08-24",
        docs: [{ label: "Settlement terms", url: "https://example.com/terms", supports: ["route"] }],
      },
    }).success).toBe(true);

    expect(
      RedemptionBackstopConfigSchema.safeParse({
        ...baseConfig,
        v9RouteReviewTerms: { minRedeemUsd: -1 },
      }).success,
    ).toBe(false);
  });

  it("requires reviewed, field-specific rationale for bounded V9 route-terms gaps", () => {
    const reviewedGap = {
      scoringDisposition: "bounded-terms-gap" as const,
      missingScoringFields: ["settlement"] as const,
      rationale: "The reviewed documents establish the mechanism but not its settlement SLA.",
      reviewedAt: "2026-08-24",
      docs: [{ label: "Terms", url: "https://example.com/terms", supports: ["route"] }],
    };

    expect(
      RedemptionBackstopConfigSchema.safeParse({
        ...baseConfig,
        v9RouteReviewTerms: reviewedGap,
      }).success,
    ).toBe(true);
    expect(
      RedemptionBackstopConfigSchema.safeParse({
        ...baseConfig,
        v9RouteReviewTerms: {
          scoringDisposition: "bounded-terms-gap",
          missingScoringFields: ["settlement"],
          reviewedAt: "2026-08-24",
          docs: reviewedGap.docs,
        },
      }).success,
    ).toBe(false);
    expect(
      RedemptionBackstopConfigSchema.safeParse({
        ...baseConfig,
        v9RouteReviewTerms: {
          scoringDisposition: "bounded-terms-gap",
          missingScoringFields: ["capacity"],
          rationale: "The executable capacity bound is not established.",
        },
      }).success,
    ).toBe(false);
    expect(
      RedemptionBackstopConfigSchema.safeParse({
        ...baseConfig,
        v9RouteReviewTerms: {
          missingScoringFields: ["cost"],
          rationale: "A cost term is absent.",
        },
      }).success,
    ).toBe(false);
  });

  it("surfaces reviewed redemption policy entries in the audit report", () => {
    const result = validateFixture([
      singleOwner(),
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
      /usdt-tether.*issuer-a.*issuer-b/,
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
        entries: issuerEntries,
        allowedRouteFamilies: ["offchain-issuer"],
      },
      {
        name: "plain",
        filePath: "plain.ts",
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
      singleOwner({
            ...baseConfig,
            routeFamily: "psm-swap",
          }),
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

  it.each([
    {
      name: "live-derived static capacity confidence",
      overrides: { capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "live-direct" } },
      path: ["capacityModel", "confidence"], code: "invalid_value",
    },
    {
      name: "mutually exclusive reserve fallbacks",
      overrides: { capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.1, fallbackUsd: 1_000_000 } },
      path: ["capacityModel", "fallbackUsd"], code: "custom",
    },
    {
      name: "inverted fee bounds",
      overrides: { costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed fees", feeBpsMin: 100, feeBpsMax: 50 } },
      path: ["costModel", "feeBpsMin"], code: "custom",
    },
    {
      name: "stress fee below normal bound",
      overrides: { costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed fees", feeBpsMax: 100, stressFeeBps: 50 } },
      path: ["costModel", "stressFeeBps"], code: "custom",
    },
    {
      name: "formula confidence with nonformula kind",
      overrides: { costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed fees", confidence: "formula", feeModelKind: "documented-variable" } },
      path: ["costModel", "feeModelKind"], code: "custom",
    },
    {
      name: "formula kind without formula confidence",
      overrides: { costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed fees", feeModelKind: "formula" } },
      path: ["costModel", "confidence"], code: "custom",
    },
    {
      name: "duplicate document support",
      overrides: { docs: [{ label: "Docs", url: "https://example.com/docs", supports: ["route", "route"] }] },
      path: ["docs", 0, "supports", 1], code: "custom",
    },
    {
      name: "future review date",
      overrides: { reviewedAt: "2999-01-01" },
      path: ["reviewedAt"], code: "custom",
    },
    {
      name: "nonpositive daily limit",
      overrides: { capacityModel: { kind: "supply-ratio", ratio: 0.1, dailyLimitUsd: 0 } },
      path: ["capacityModel", "dailyLimitUsd"], code: "too_small",
    },
  ])("rejects $name with a field-specific issue", ({ overrides, path, code }) => {
    expect(RedemptionBackstopConfigSchema.safeParse(baseConfig).success).toBe(true);
    const config = { ...baseConfig, ...overrides } as unknown as RedemptionBackstopConfig;
    const parsed = RedemptionBackstopConfigSchema.safeParse(config);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map(({ code, path }) => ({ code, path }))).toEqual([{ code, path }]);
    }
    const result = validateFixture([singleOwner(config)]);
    expect(result.findings).toContainEqual(expect.objectContaining({
      severity: "error", code: "schema-validation", stablecoinId: "usdt-tether",
    }));
    if (path.join(".") === "capacityModel.confidence") {
      expect(result.findings).toContainEqual(expect.objectContaining({
        code: "static-live-capacity-confidence", stablecoinId: "usdt-tether",
      }));
    }
  });

  it("warns when documented-bound configs lack route or capacity source support", () => {
    const result = validateFixture([
      singleOwner({
            ...baseConfig,
            capacityModel: {
              kind: "supply-ratio",
              ratio: 0.1,
              confidence: "documented-bound",
            },
            reviewedAt: "2026-05-12",
            docs: [{ label: "Fixture fee docs", url: "https://example.com/fees", supports: ["fees"] }],
          }),
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
      singleOwner({
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
          }),
    ]);

    const supportWarnings = result.findings.filter(
      (finding) => finding.stablecoinId === "usdt-tether" && finding.code.startsWith("documented-bound-missing-"),
    );
    expect(supportWarnings).toEqual([]);
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
      expect(mixedTrackedAndUntracked.error.issues).toContainEqual(
        expect.objectContaining({ code: "custom", path: ["outputAssets", 1] }),
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
          code: "custom",
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
          code: "custom",
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
          code: "custom",
        }),
      );
    }
  });
});

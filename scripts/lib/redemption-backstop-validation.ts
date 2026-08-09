import ts from "typescript";
import { getScriptKind } from "./ts-ast.mjs";
import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { resolveCapacityBasis } from "@shared/lib/redemption-backstop-capacity";
import {
  resolveCapacityConfidence,
  resolveCapacitySemantics,
  resolveFeeConfidence,
  resolveFeeModelKind,
} from "@shared/lib/redemption-backstop-confidence";
import { ACTIVE_META_BY_ID, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  RedemptionBackstopsResponseSchema,
  type RedemptionCapacityConfidence,
  type RedemptionDocSourceSupport,
  type RedemptionRouteFamily,
} from "@shared/types/redemption";
import { RedemptionBackstopConfigSchema, currentUtcDate } from "@shared/lib/redemption-backstop-configs/schema";
import type {
  RedemptionBackstopConfig,
  RedemptionCapacityModel,
} from "@shared/lib/redemption-backstop-configs/shared";
import { REDEMPTION_BACKSTOP_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/redemption-backstop";
import {
  REDEMPTION_BACKSTOP_CONFIG_MANIFEST,
  type RedemptionBackstopConfigManifestEntry,
} from "@shared/lib/redemption-backstop-configs/manifest";
import {
  REDEMPTION_BACKSTOP_POLICY_ENTRIES,
  type RedemptionBackstopPolicyEntry,
} from "@shared/lib/redemption-backstop-configs/policies";

export type RedemptionRegistryFindingSeverity = "error" | "warning";

export interface RedemptionRegistryFinding {
  severity: RedemptionRegistryFindingSeverity;
  code: string;
  stablecoinId?: string;
  family?: string;
  filePath?: string;
  message: string;
}

type RedemptionCapacityFallbackSource = "none" | "reserve-sync-fallback-ratio" | "reserve-sync-fallback-usd";

function resolveCapacityFallbackSource(model: RedemptionCapacityModel): RedemptionCapacityFallbackSource {
  if (model.kind !== "reserve-sync-metadata") return "none";
  if (model.fallbackRatio != null) return "reserve-sync-fallback-ratio";
  if (model.fallbackUsd != null) return "reserve-sync-fallback-usd";
  return "none";
}

function resolveCapacityDailyLimitUsd(model: RedemptionCapacityModel): number | null {
  if (model.kind === "fixed-usd" || model.kind === "supply-ratio") {
    return model.dailyLimitUsd ?? null;
  }
  return null;
}

export interface RedemptionRegistryAuditRow {
  stablecoinId: string;
  family: string;
  filePath: string;
  routeFamily: RedemptionRouteFamily;
  accessModel: RedemptionBackstopConfig["accessModel"];
  settlementModel: RedemptionBackstopConfig["settlementModel"];
  executionModel: RedemptionBackstopConfig["executionModel"];
  outputAssetType: RedemptionBackstopConfig["outputAssetType"];
  capacityModelKind: RedemptionBackstopConfig["capacityModel"]["kind"];
  capacityConfidence: string;
  capacityBasis: string | null;
  resolvedCapacityBasis: string | null;
  capacityFallbackSource: string;
  dailyLimitUsd: number | null;
  capacitySemantics: string;
  costModelKind: RedemptionBackstopConfig["costModel"]["kind"];
  feeConfidence: string;
  feeModelKind: string;
  docsCount: number;
  docsSupportCoverage: RedemptionDocSourceSupport[];
  liveReserveAdapter: string | null;
  liveReserveTelemetry: string | null;
  reviewedAt: string | null;
  overrideReason: string | null;
}

export interface RedemptionPolicyAuditRow {
  kind: RedemptionBackstopPolicyEntry["kind"];
  stablecoinId: string;
  warningCode: string | null;
  reason: string;
  owner: string;
  reviewedAt: string;
  liveReserveAdapter: string | null;
  liveReserveTelemetry: string | null;
}

export interface RedemptionRegistryValidationResult {
  findings: RedemptionRegistryFinding[];
  auditRows: RedemptionRegistryAuditRow[];
  policyRows: RedemptionPolicyAuditRow[];
  summary: {
    configuredCount: number;
    strongProxyCount: number;
    heuristicIds: string[];
    routeFamilyCounts: Record<RedemptionRouteFamily, number>;
    unconfiguredActiveIds: string[];
  };
}

export interface RedemptionRegistryValidationOptions {
  manifest?: readonly RedemptionBackstopConfigManifestEntry[];
  mergedConfigs?: Record<string, RedemptionBackstopConfig>;
  docsText?: string;
  apiDocsText?: string;
  sourceTextByPath?: ReadonlyMap<string, string>;
}

const DOC_SUPPORT_KINDS: RedemptionDocSourceSupport[] = ["route", "capacity", "fees", "access", "settlement"];

const DOC_SOURCE_SUPPORT_BASELINE = {
  sourcesWithoutSupports: 103,
  missingSupportKindCounts: {
    route: 58,
    capacity: 10,
    fees: 126,
    access: 157,
    settlement: 167,
  },
} as const satisfies {
  sourcesWithoutSupports: number;
  missingSupportKindCounts: Record<RedemptionDocSourceSupport, number>;
};

const UNCONFIGURED_ACTIVE_BASELINE = 62;
const DAILY_LIMIT_CONTEXT_WINDOW = 80;
const DAILY_LIMIT_TIME_TERMS = ["daily", "per-day", "per day"] as const;
const DAILY_LIMIT_BOUND_TERMS = ["limit", "cap", "maximum", "max"] as const;
const LIVE_ONLY_STATIC_CAPACITY_CONFIDENCES = new Set(["live-direct", "live-proxy"]);

const ROUTE_FAMILY_ORDER: RedemptionRouteFamily[] = [
  "offchain-issuer",
  "stablecoin-redeem",
  "collateral-redeem",
  "queue-redeem",
  "psm-swap",
  "basket-redeem",
];

const UNUSED_LIVE_REDEMPTION_TELEMETRY_POLICY_IDS = new Set(
  REDEMPTION_BACKSTOP_POLICY_ENTRIES.filter((entry) => entry.kind === "unused-live-redemption-telemetry").map(
    (entry) => entry.stablecoinId,
  ),
);

function resolveAuditCapacityConfidence(
  config: RedemptionBackstopConfig,
  adapterDefinition: ReturnType<typeof getLiveReserveAdapterDefinition> | null,
): RedemptionCapacityConfidence {
  const staticConfidence = resolveCapacityConfidence(config.capacityModel);
  if (config.capacityModel.kind !== "reserve-sync-metadata") return staticConfidence;
  if (adapterDefinition?.redemptionTelemetry.capacity === "direct") return "live-direct";
  if (adapterDefinition?.redemptionTelemetry.capacity === "proxy") return "live-proxy";
  return staticConfidence;
}

export function validateRedemptionBackstopRegistry(
  options: RedemptionRegistryValidationOptions = {},
): RedemptionRegistryValidationResult {
  const manifest = options.manifest ?? REDEMPTION_BACKSTOP_CONFIG_MANIFEST;
  const mergedConfigs = options.mergedConfigs ?? mergeManifestConfigsForValidation(manifest);
  const overrideReasonById = new Map<string, string>();
  const sourceFileById = new Map<string, string>();
  for (const moduleEntry of manifest) {
    for (const entry of moduleEntry.entries) {
      if (entry.overrideReason) overrideReasonById.set(entry.id, entry.overrideReason);
      if (entry.sourceFilePath) sourceFileById.set(entry.id, entry.sourceFilePath);
    }
  }
  const findings: RedemptionRegistryFinding[] = [];
  const seenById = new Map<string, string>();
  const ownerById = new Map<string, RedemptionBackstopConfigManifestEntry>();
  let sourcesWithoutSupports = 0;
  const missingSupportKindCounts = new Map<RedemptionDocSourceSupport, number>();

  validateStaticConfigOverwrites(manifest, options.sourceTextByPath, findings);

  for (const moduleEntry of manifest) {
    const allowedFamilies = new Set(moduleEntry.allowedRouteFamilies);
    for (const [id, config] of Object.entries(moduleEntry.configs)) {
      const previous = seenById.get(id);
      if (previous) {
        addFinding(
          findings,
          "error",
          "duplicate-id",
          `Duplicate id "${id}" appears in both ${previous} and ${moduleEntry.name}.`,
          {
            stablecoinId: id,
            family: moduleEntry.name,
            filePath: moduleEntry.filePath,
          },
        );
        continue;
      }
      seenById.set(id, moduleEntry.name);
      ownerById.set(id, moduleEntry);

      if (!allowedFamilies.has(config.routeFamily)) {
        addFinding(
          findings,
          "error",
          "route-family-mismatch",
          `${moduleEntry.name} contains ${id} with unexpected route family ${config.routeFamily}.`,
          { stablecoinId: id, family: moduleEntry.name, filePath: moduleEntry.filePath },
        );
      }

      if (!TRACKED_META_BY_ID.has(id)) {
        addFinding(
          findings,
          "error",
          "unknown-tracked-id",
          `Unknown tracked stablecoin id "${id}" in ${moduleEntry.name}.`,
          {
            stablecoinId: id,
            family: moduleEntry.name,
            filePath: moduleEntry.filePath,
          },
        );
      }
    }
  }

  const mergedIds = Object.keys(mergedConfigs).sort();
  if (seenById.size !== mergedIds.length) {
    addFinding(
      findings,
      "error",
      "registry-size-mismatch",
      `Module union size ${seenById.size} does not match merged registry size ${mergedIds.length}.`,
    );
  }

  const routeFamilyCounts = Object.fromEntries(
    ROUTE_FAMILY_ORDER.map((routeFamily) => [
      routeFamily,
      mergedIds.filter((id) => mergedConfigs[id]?.routeFamily === routeFamily).length,
    ]),
  ) as Record<RedemptionRouteFamily, number>;

  if (options.docsText != null) {
    const expectedConfiguredLine = `- **Configured coins:** ${mergedIds.length}`;
    if (!options.docsText.includes(expectedConfiguredLine)) {
      addFinding(
        findings,
        "error",
        "docs-configured-count-out-of-sync",
        `docs/redemption-backstops.md is out of sync. Expected line: ${expectedConfiguredLine}`,
      );
    }

    const expectedRouteLine = `- **Route families:** ${ROUTE_FAMILY_ORDER.map(
      (routeFamily) => `${routeFamilyCounts[routeFamily]} \`${routeFamily}\``,
    ).join(", ")}`;
    if (!options.docsText.includes(expectedRouteLine)) {
      addFinding(
        findings,
        "error",
        "docs-route-count-out-of-sync",
        `docs/redemption-backstops.md is out of sync. Expected line: ${expectedRouteLine}`,
      );
    }
  }

  const auditRows = mergedIds.map((id) => {
    const config = mergedConfigs[id];
    const owner = ownerById.get(id);
    const sourceFilePath = sourceFileById.get(id);
    const parseResult = RedemptionBackstopConfigSchema.safeParse(config);
    if (!parseResult.success) {
      for (const issue of parseResult.error.issues) {
        const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
        addFinding(
          findings,
          "error",
          "schema-validation",
          `${id}: schema validation failed at ${path}: ${issue.message}`,
          {
            stablecoinId: id,
            family: owner?.name,
            filePath: sourceFilePath ?? owner?.filePath,
          },
        );
      }
    }

    validateConfigInvariants(id, config, owner, sourceFilePath, findings);

    const coveredSupportKinds = new Set<RedemptionDocSourceSupport>();
    for (const doc of config.docs ?? []) {
      if (!doc.supports || doc.supports.length === 0) {
        sourcesWithoutSupports += 1;
        continue;
      }
      for (const supportKind of doc.supports) {
        coveredSupportKinds.add(supportKind);
      }
    }
    for (const supportKind of DOC_SUPPORT_KINDS) {
      if (!coveredSupportKinds.has(supportKind)) {
        missingSupportKindCounts.set(supportKind, (missingSupportKindCounts.get(supportKind) ?? 0) + 1);
      }
    }
    validateDocumentedBoundSourceSupport(id, config, coveredSupportKinds, owner, sourceFilePath, findings);

    const adapterKey = TRACKED_META_BY_ID.get(id)?.liveReservesConfig?.adapter ?? null;
    const adapterDefinition = adapterKey ? getLiveReserveAdapterDefinition(adapterKey) : null;
    const capacityConfidence = resolveCapacityConfidence(config.capacityModel);
    const resolvedCapacityConfidence = resolveAuditCapacityConfidence(config, adapterDefinition);
    return {
      stablecoinId: id,
      family: owner?.name ?? "unknown",
      filePath: sourceFileById.get(id) ?? owner?.filePath ?? "unknown",
      routeFamily: config.routeFamily,
      accessModel: config.accessModel,
      settlementModel: config.settlementModel,
      executionModel: config.executionModel,
      outputAssetType: config.outputAssetType,
      capacityModelKind: config.capacityModel.kind,
      capacityConfidence,
      capacityBasis: config.capacityModel.basis ?? null,
      resolvedCapacityBasis:
        resolveCapacityBasis(config.routeFamily, config.capacityModel, resolvedCapacityConfidence) ?? null,
      capacityFallbackSource: resolveCapacityFallbackSource(config.capacityModel),
      dailyLimitUsd: resolveCapacityDailyLimitUsd(config.capacityModel),
      capacitySemantics: resolveCapacitySemantics(config.capacityModel),
      costModelKind: config.costModel.kind,
      feeConfidence: resolveFeeConfidence(config.costModel),
      feeModelKind: resolveFeeModelKind(config.costModel),
      docsCount: config.docs?.length ?? 0,
      docsSupportCoverage: [...coveredSupportKinds].sort(),
      liveReserveAdapter: adapterKey,
      liveReserveTelemetry: adapterDefinition?.redemptionTelemetry.capacity ?? null,
      reviewedAt: config.reviewedAt ?? null,
      overrideReason: overrideReasonById.get(id) ?? null,
    };
  });

  validateDocSupportRatchet(findings, sourcesWithoutSupports, missingSupportKindCounts);
  validateConfidenceDocs(findings, options.docsText, options.apiDocsText);
  const policyRows = validateRedemptionBackstopPolicies(findings, mergedConfigs);

  const configuredIds = new Set(mergedIds);
  const unconfiguredActiveIds = [...ACTIVE_META_BY_ID.keys()].filter((id) => !configuredIds.has(id)).sort();
  if (unconfiguredActiveIds.length > UNCONFIGURED_ACTIVE_BASELINE) {
    addFinding(
      findings,
      "error",
      "unconfigured-active-ratchet-regressed",
      `Active stablecoins without redemption backstop configs increased to ${unconfiguredActiveIds.length} (baseline ${UNCONFIGURED_ACTIVE_BASELINE}).`,
    );
  }
  for (const id of unconfiguredActiveIds) {
    addFinding(
      findings,
      "warning",
      "unconfigured-active-coin",
      `Active stablecoin "${id}" has no redemption backstop config.`,
      {
        stablecoinId: id,
      },
    );
  }
  validateUnusedLiveRedemptionTelemetryPolicies(mergedConfigs, configuredIds, findings);

  const heuristicIds = mergedIds.filter(
    (id) => resolveCapacityConfidence(mergedConfigs[id].capacityModel) === "heuristic",
  );

  return {
    findings,
    auditRows,
    policyRows,
    summary: {
      configuredCount: mergedIds.length,
      strongProxyCount: mergedIds.length - heuristicIds.length,
      heuristicIds,
      routeFamilyCounts,
      unconfiguredActiveIds,
    },
  };
}

function validateDocumentedBoundSourceSupport(
  id: string,
  config: RedemptionBackstopConfig,
  coveredSupportKinds: ReadonlySet<RedemptionDocSourceSupport>,
  owner: RedemptionBackstopConfigManifestEntry | undefined,
  sourceFilePath: string | undefined,
  findings: RedemptionRegistryFinding[],
): void {
  if (resolveCapacityConfidence(config.capacityModel) !== "documented-bound") return;
  const context = { stablecoinId: id, family: owner?.name, filePath: sourceFilePath ?? owner?.filePath };

  if (!coveredSupportKinds.has("route")) {
    addFinding(
      findings,
      "warning",
      "documented-bound-missing-route-support",
      `${id}: documented-bound capacity requires at least one docs[] source with supports:["route"].`,
      context,
    );
  }

  if (!coveredSupportKinds.has("capacity")) {
    addFinding(
      findings,
      "warning",
      "documented-bound-missing-capacity-support",
      `${id}: documented-bound capacity requires at least one docs[] source with supports:["capacity"].`,
      context,
    );
  }
}

function validateConfigInvariants(
  id: string,
  config: RedemptionBackstopConfig,
  owner: RedemptionBackstopConfigManifestEntry | undefined,
  sourceFilePath: string | undefined,
  findings: RedemptionRegistryFinding[],
): void {
  const context = { stablecoinId: id, family: owner?.name, filePath: sourceFilePath ?? owner?.filePath };
  if (config.costModel.kind === "dynamic-or-unclear" && !config.costModel.feeDescription) {
    addFinding(
      findings,
      "error",
      "missing-fee-description",
      `${id}: dynamic-or-unclear cost model missing feeDescription`,
      context,
    );
  }
  if (config.costModel.kind === "fee-bps" && config.costModel.feeBps < 0) {
    addFinding(findings, "error", "negative-fee-bps", `${id}: negative feeBps (${config.costModel.feeBps})`, context);
  }
  if (
    config.capacityModel.kind === "supply-ratio" &&
    (config.capacityModel.ratio <= 0 || config.capacityModel.ratio > 1)
  ) {
    addFinding(
      findings,
      "error",
      "supply-ratio-out-of-range",
      `${id}: supply-ratio out of range (${config.capacityModel.ratio})`,
      context,
    );
  }
  const rawCapacityConfidence = (config.capacityModel as { confidence?: string }).confidence;
  if (rawCapacityConfidence && LIVE_ONLY_STATIC_CAPACITY_CONFIDENCES.has(rawCapacityConfidence)) {
    addFinding(
      findings,
      "error",
      "static-live-capacity-confidence",
      `${id}: static config capacity confidence cannot be ${rawCapacityConfidence}; live-direct/live-proxy are runtime-only evidence.`,
      context,
    );
  }
  if (
    config.capacityModel.kind === "reserve-sync-metadata" &&
    config.capacityModel.fallbackRatio != null &&
    (config.capacityModel.fallbackRatio <= 0 || config.capacityModel.fallbackRatio > 1)
  ) {
    addFinding(
      findings,
      "error",
      "reserve-sync-fallback-ratio-out-of-range",
      `${id}: reserve-sync fallbackRatio out of range (${config.capacityModel.fallbackRatio})`,
      context,
    );
  }
  if (mentionsNumericDailyLimit(config) && !hasConfiguredDailyLimit(config.capacityModel)) {
    addFinding(
      findings,
      "error",
      "daily-limit-mentioned-without-capacity-limit",
      `${id}: notes or fee text mention a numeric daily limit but capacityModel.dailyLimitUsd is not configured.`,
      context,
    );
  }
  if (config.totalScoreCap != null && (config.totalScoreCap <= 0 || config.totalScoreCap > 100)) {
    addFinding(
      findings,
      "error",
      "total-score-cap-out-of-range",
      `${id}: totalScoreCap out of range (${config.totalScoreCap})`,
      context,
    );
  }
  if (config.capacityModel.confidence === "documented-bound") {
    if (!config.reviewedAt) {
      addFinding(
        findings,
        "error",
        "documented-bound-missing-reviewed-at",
        `${id}: documented-bound route missing reviewedAt`,
        context,
      );
    }
    if (!config.docs || config.docs.length === 0) {
      addFinding(
        findings,
        "error",
        "documented-bound-missing-docs",
        `${id}: documented-bound route missing explicit docs[]`,
        context,
      );
    }
  }
  if (config.reviewedAt && (!config.docs || config.docs.length === 0)) {
    addFinding(findings, "error", "reviewed-route-missing-docs", `${id}: reviewed route missing docs[]`, context);
  }
  if (config.capacityModel.kind === "reserve-sync-metadata") {
    const adapterKey = TRACKED_META_BY_ID.get(id)?.liveReservesConfig?.adapter;
    if (!adapterKey) {
      addFinding(
        findings,
        "error",
        "reserve-sync-missing-adapter",
        `${id}: reserve-sync-metadata route missing liveReservesConfig adapter`,
        context,
      );
      return;
    }
    const definition = getLiveReserveAdapterDefinition(adapterKey);
    if (!definition) {
      addFinding(
        findings,
        "error",
        "reserve-sync-unknown-adapter",
        `${id}: reserve-sync-metadata route references unknown adapter (${adapterKey})`,
        context,
      );
      return;
    }
    if (definition.redemptionTelemetry.capacity === "none") {
      addFinding(
        findings,
        "error",
        "reserve-sync-adapter-no-capacity",
        `${id}: reserve-sync-metadata route points to fee-only/no-capacity adapter (${adapterKey})`,
        context,
      );
    }
    if (!config.reviewedAt) {
      addFinding(
        findings,
        "error",
        "reserve-sync-missing-reviewed-at",
        `${id}: reserve-sync-metadata route missing reviewedAt`,
        context,
      );
    }
    if (!config.docs || config.docs.length === 0) {
      addFinding(
        findings,
        "error",
        "reserve-sync-missing-docs",
        `${id}: reserve-sync-metadata route missing explicit docs[]`,
        context,
      );
    }
  }
}

function validateRedemptionBackstopPolicies(
  findings: RedemptionRegistryFinding[],
  mergedConfigs: Readonly<Record<string, RedemptionBackstopConfig>>,
): RedemptionPolicyAuditRow[] {
  const seen = new Set<string>();

  return REDEMPTION_BACKSTOP_POLICY_ENTRIES.map((entry) => {
    const adapterKey = TRACKED_META_BY_ID.get(entry.stablecoinId)?.liveReservesConfig?.adapter ?? null;
    const adapterDefinition = adapterKey ? getLiveReserveAdapterDefinition(adapterKey) : null;
    const warningCode = entry.kind === "degraded-sync-warning-exception" ? entry.warningCode : null;
    const policyKey = `${entry.kind}:${entry.stablecoinId}:${warningCode ?? ""}`;

    if (seen.has(policyKey)) {
      addFinding(findings, "error", "duplicate-redemption-policy", `Duplicate redemption policy entry ${policyKey}.`, {
        stablecoinId: entry.stablecoinId,
        filePath: "shared/lib/redemption-backstop-configs/policies.ts",
      });
    }
    seen.add(policyKey);

    if (!TRACKED_META_BY_ID.has(entry.stablecoinId)) {
      addFinding(
        findings,
        "error",
        "redemption-policy-unknown-tracked-id",
        `Redemption policy references unknown tracked stablecoin id "${entry.stablecoinId}".`,
        { stablecoinId: entry.stablecoinId, filePath: "shared/lib/redemption-backstop-configs/policies.ts" },
      );
    }

    if (!adapterKey) {
      addFinding(
        findings,
        "error",
        "redemption-policy-missing-adapter",
        `${entry.stablecoinId}: redemption policy requires liveReservesConfig adapter metadata.`,
        { stablecoinId: entry.stablecoinId, filePath: "shared/lib/redemption-backstop-configs/policies.ts" },
      );
    } else if (!adapterDefinition) {
      addFinding(
        findings,
        "error",
        "redemption-policy-unknown-adapter",
        `${entry.stablecoinId}: redemption policy references unknown adapter (${adapterKey}).`,
        { stablecoinId: entry.stablecoinId, filePath: "shared/lib/redemption-backstop-configs/policies.ts" },
      );
    } else if (
      entry.kind !== "unused-live-redemption-telemetry" &&
      adapterDefinition.redemptionTelemetry.capacity === "none"
    ) {
      addFinding(
        findings,
        "error",
        "redemption-policy-adapter-no-capacity",
        `${entry.stablecoinId}: redemption policy points to adapter without redemption capacity telemetry (${adapterKey}).`,
        { stablecoinId: entry.stablecoinId, filePath: "shared/lib/redemption-backstop-configs/policies.ts" },
      );
    }

    if (!entry.reason.trim()) {
      addFinding(
        findings,
        "error",
        "redemption-policy-missing-reason",
        `${entry.stablecoinId}: redemption policy missing reason.`,
        { stablecoinId: entry.stablecoinId, filePath: "shared/lib/redemption-backstop-configs/policies.ts" },
      );
    }
    if (!entry.owner.trim()) {
      addFinding(
        findings,
        "error",
        "redemption-policy-missing-owner",
        `${entry.stablecoinId}: redemption policy missing owner.`,
        { stablecoinId: entry.stablecoinId, filePath: "shared/lib/redemption-backstop-configs/policies.ts" },
      );
    }
    if (!isValidReviewedAt(entry.reviewedAt)) {
      addFinding(
        findings,
        "error",
        "redemption-policy-invalid-reviewed-at",
        `${entry.stablecoinId}: redemption policy reviewedAt must be a valid non-future YYYY-MM-DD.`,
        { stablecoinId: entry.stablecoinId, filePath: "shared/lib/redemption-backstop-configs/policies.ts" },
      );
    }
    if (entry.kind === "unused-live-redemption-telemetry") {
      const config = mergedConfigs[entry.stablecoinId];
      if (config?.capacityModel.kind === "reserve-sync-metadata") {
        addFinding(
          findings,
          "error",
          "unused-live-telemetry-policy-stale",
          `${entry.stablecoinId}: unused live redemption telemetry policy is stale because the config now consumes reserve-sync-metadata.`,
          { stablecoinId: entry.stablecoinId, filePath: "shared/lib/redemption-backstop-configs/policies.ts" },
        );
      }
    }

    return {
      kind: entry.kind,
      stablecoinId: entry.stablecoinId,
      warningCode,
      reason: entry.reason,
      owner: entry.owner,
      reviewedAt: entry.reviewedAt,
      liveReserveAdapter: adapterKey,
      liveReserveTelemetry: adapterDefinition?.redemptionTelemetry.capacity ?? null,
    };
  });
}

function validateUnusedLiveRedemptionTelemetryPolicies(
  mergedConfigs: Record<string, RedemptionBackstopConfig>,
  configuredIds: ReadonlySet<string>,
  findings: RedemptionRegistryFinding[],
): void {
  for (const [id, meta] of ACTIVE_META_BY_ID) {
    const adapterKey = meta.liveReservesConfig?.adapter ?? null;
    if (!adapterKey) continue;
    const definition = getLiveReserveAdapterDefinition(adapterKey);
    if (!definition || definition.redemptionTelemetry.capacity === "none") continue;

    const config = mergedConfigs[id];
    if (config?.capacityModel.kind === "reserve-sync-metadata") continue;

    if (UNUSED_LIVE_REDEMPTION_TELEMETRY_POLICY_IDS.has(id)) continue;

    addFinding(
      findings,
      "error",
      "unused-live-redemption-telemetry",
      configuredIds.has(id)
        ? `${id}: live-reserve adapter ${adapterKey} exposes redemption capacity telemetry but the redemption config does not consume reserve-sync-metadata and has no unused-telemetry policy.`
        : `${id}: live-reserve adapter ${adapterKey} exposes redemption capacity telemetry but the active stablecoin has no redemption config and no unused-telemetry policy.`,
      {
        stablecoinId: id,
        filePath: "shared/lib/redemption-backstop-configs/policies.ts",
      },
    );
  }
}

function validateDocSupportRatchet(
  findings: RedemptionRegistryFinding[],
  sourcesWithoutSupports: number,
  missingSupportKindCounts: ReadonlyMap<RedemptionDocSourceSupport, number>,
): void {
  if (sourcesWithoutSupports > DOC_SOURCE_SUPPORT_BASELINE.sourcesWithoutSupports) {
    addFinding(
      findings,
      "error",
      "docs-support-ratchet-regressed",
      `docs[].supports ratchet regressed: ${sourcesWithoutSupports} source entries lack supports[] (baseline ${DOC_SOURCE_SUPPORT_BASELINE.sourcesWithoutSupports})`,
    );
  }
  for (const supportKind of DOC_SUPPORT_KINDS) {
    const count = missingSupportKindCounts.get(supportKind) ?? 0;
    const baseline = DOC_SOURCE_SUPPORT_BASELINE.missingSupportKindCounts[supportKind];
    if (count > baseline) {
      addFinding(
        findings,
        "error",
        "docs-support-kind-ratchet-regressed",
        `docs[].supports ratchet regressed for ${supportKind}: ${count} configs missing support (baseline ${baseline})`,
      );
    }
  }
}

function validateConfidenceDocs(
  findings: RedemptionRegistryFinding[],
  docsText: string | undefined,
  apiDocsText: string | undefined,
): void {
  for (const requiredTerm of ["live-direct", "live-proxy"]) {
    if (docsText != null && !docsText.includes(requiredTerm)) {
      addFinding(
        findings,
        "error",
        "docs-missing-confidence-term",
        `docs/redemption-backstops.md missing capacity-confidence term ${requiredTerm}`,
      );
    }
    if (apiDocsText != null && !apiDocsText.includes(requiredTerm)) {
      addFinding(
        findings,
        "error",
        "api-docs-missing-confidence-term",
        `docs/api-reference.md missing capacity-confidence term ${requiredTerm}`,
      );
    }
  }
  validateApiReferenceExample(findings, apiDocsText);
}

function validateApiReferenceExample(
  findings: RedemptionRegistryFinding[],
  apiDocsText: string | undefined,
): void {
  if (apiDocsText == null) return;
  const sectionStart = apiDocsText.indexOf("### `GET /api/redemption-backstops`");
  if (sectionStart < 0) {
    addFinding(
      findings,
      "error",
      "api-docs-missing-redemption-backstops-section",
      "docs/api-reference.md missing GET /api/redemption-backstops section",
    );
    return;
  }

  const sectionText = apiDocsText.slice(sectionStart);
  const match = /```json\n([\s\S]*?)\n```/.exec(sectionText);
  if (!match) {
    addFinding(
      findings,
      "error",
      "api-docs-missing-redemption-backstops-example",
      "docs/api-reference.md missing redemption-backstops JSON response example",
    );
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(match[1]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addFinding(
      findings,
      "error",
      "api-docs-invalid-redemption-backstops-example-json",
      `docs/api-reference.md redemption-backstops example is not valid JSON: ${message}`,
    );
    return;
  }

  const parsed = RedemptionBackstopsResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    addFinding(
      findings,
      "error",
      "api-docs-redemption-backstops-example-schema-mismatch",
      `docs/api-reference.md redemption-backstops example does not match RedemptionBackstopsResponseSchema: ${parsed.error.message}`,
    );
    return;
  }

  if (
    parsed.data.methodology.version !== REDEMPTION_BACKSTOP_METHODOLOGY_VERSION ||
    parsed.data.methodology.currentVersion !== REDEMPTION_BACKSTOP_METHODOLOGY_VERSION
  ) {
    addFinding(
      findings,
      "error",
      "api-docs-redemption-backstops-version-stale",
      `docs/api-reference.md redemption-backstops example must use methodology version ${REDEMPTION_BACKSTOP_METHODOLOGY_VERSION}`,
    );
  }
}

function hasConfiguredDailyLimit(model: RedemptionBackstopConfig["capacityModel"]): boolean {
  return "dailyLimitUsd" in model && model.dailyLimitUsd != null;
}

function mentionsNumericDailyLimit(config: RedemptionBackstopConfig): boolean {
  const textParts = [config.costModel.feeDescription, ...(config.notes ?? [])].filter((part): part is string =>
    Boolean(part),
  );
  return textParts.some((text) => mentionsDailyLimitContext(text) && containsAsciiDigit(text));
}

function mentionsDailyLimitContext(text: string): boolean {
  const normalized = text.toLowerCase();
  const timeTermIndexes = collectWholeTermIndexes(normalized, DAILY_LIMIT_TIME_TERMS);
  if (timeTermIndexes.length === 0) return false;

  const boundTermIndexes = collectWholeTermIndexes(normalized, DAILY_LIMIT_BOUND_TERMS);
  return timeTermIndexes.some((timeIndex) =>
    boundTermIndexes.some((boundIndex) => Math.abs(boundIndex - timeIndex) <= DAILY_LIMIT_CONTEXT_WINDOW),
  );
}

function collectWholeTermIndexes(text: string, terms: readonly string[]): number[] {
  const indexes: number[] = [];
  for (const term of terms) {
    let index = text.indexOf(term);
    while (index !== -1) {
      const before = index === 0 ? "" : text[index - 1];
      const after = text[index + term.length] ?? "";
      if (!isAsciiWordChar(before) && !isAsciiWordChar(after)) {
        indexes.push(index);
      }
      index = text.indexOf(term, index + term.length);
    }
  }
  return indexes;
}

function containsAsciiDigit(text: string): boolean {
  for (const char of text) {
    if (char >= "0" && char <= "9") return true;
  }
  return false;
}

function isAsciiWordChar(char: string): boolean {
  return (
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    (char >= "0" && char <= "9") ||
    char === "_"
  );
}

function isBackstopConfigsDecl(
  node: ts.Node,
): node is ts.VariableDeclaration & { name: ts.Identifier; initializer: ts.ObjectLiteralExpression } {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text.endsWith("BACKSTOP_CONFIGS") &&
    node.initializer != null &&
    ts.isObjectLiteralExpression(node.initializer)
  );
}

function validateStaticConfigOverwrites(
  manifest: readonly RedemptionBackstopConfigManifestEntry[],
  sourceTextByPath: ReadonlyMap<string, string> | undefined,
  findings: RedemptionRegistryFinding[],
): void {
  if (!sourceTextByPath) return;

  for (const filePath of sourceTextByPath.keys()) {
    const moduleEntry = resolveManifestEntryForSourceFile(manifest, filePath);
    if (!moduleEntry) continue;
    validateStaticConfigSourceFile(moduleEntry, filePath, sourceTextByPath, findings);
  }
}

function resolveManifestEntryForSourceFile(
  manifest: readonly RedemptionBackstopConfigManifestEntry[],
  filePath: string,
): RedemptionBackstopConfigManifestEntry | undefined {
  for (const moduleEntry of manifest) {
    if (filePath === moduleEntry.filePath) return moduleEntry;
  }

  for (const moduleEntry of manifest) {
    if (!moduleEntry.filePath.endsWith("/index.ts")) continue;
    const dir = moduleEntry.filePath.slice(0, -"/index.ts".length);
    if (filePath.startsWith(`${dir}/`)) return moduleEntry;
  }
  return undefined;
}

function validateStaticConfigSourceFile(
  moduleEntry: RedemptionBackstopConfigManifestEntry,
  filePath: string,
  sourceTextByPath: ReadonlyMap<string, string>,
  findings: RedemptionRegistryFinding[],
): void {
  const sourceText = sourceTextByPath.get(filePath);
  if (sourceText == null) return;
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
  const registryEntries: { id: string; kind: "expandIds" | "property" }[] = [];

  function visit(node: ts.Node): void {
    if (isBackstopConfigsDecl(node)) {
      for (const property of node.initializer.properties) {
        if (
          ts.isSpreadAssignment(property) &&
          ts.isCallExpression(property.expression) &&
          property.expression.expression.getText(sourceFile) === "expandIds"
        ) {
          const ids = collectStringArray(property.expression.arguments[0]);
          if (!ids) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(property.getStart(sourceFile));
            addFinding(
              findings,
              "error",
              "expand-ids-inline-array-required",
              `${filePath}:${line + 1}:${character + 1}: expandIds() must use an inline string array for overwrite checks.`,
              { family: moduleEntry.name, filePath },
            );
            continue;
          }
          registryEntries.push(...ids.map((id) => ({ id, kind: "expandIds" as const })));
          continue;
        }

        if (ts.isPropertyAssignment(property)) {
          const id = propertyNameText(property.name);
          if (id) {
            registryEntries.push({ id, kind: "property" });
          }
        }
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      const objectKeys = new Map<string, ts.PropertyName>();
      for (const property of node.properties) {
        if (
          ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property) ||
          ts.isMethodDeclaration(property)
        ) {
          const key = propertyNameText(property.name);
          if (!key) continue;
          const previous = objectKeys.get(key);
          if (previous) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(property.name.getStart(sourceFile));
            const previousPosition = sourceFile.getLineAndCharacterOfPosition(previous.getStart(sourceFile));
            addFinding(
              findings,
              "error",
              "duplicate-object-key",
              `${filePath}:${line + 1}:${character + 1}: duplicate object key "${key}" previously declared at line ${previousPosition.line + 1}.`,
              { stablecoinId: key, family: moduleEntry.name, filePath },
            );
            continue;
          }
          objectKeys.set(key, property.name);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const approvedOverrideIds = new Set(
    moduleEntry.entries.filter((entry) => entry.overrideReason).map((entry) => entry.id),
  );
  const seenInModule = new Map<string, "expandIds" | "property">();
  for (const entry of registryEntries) {
    const previous = seenInModule.get(entry.id);
    if (previous) {
      if (!approvedOverrideIds.has(entry.id)) {
        addFinding(
          findings,
          "error",
          "unapproved-config-overwrite",
          `${moduleEntry.name} overwrites "${entry.id}" via ${previous}->${entry.kind}; use defineBackstopRegistry with an overrideReason if intentional.`,
          { stablecoinId: entry.id, family: moduleEntry.name, filePath },
        );
      }
    }
    seenInModule.set(entry.id, entry.kind);
  }
}

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function collectStringArray(expression: ts.Expression | undefined): string[] | null {
  if (!expression || !ts.isArrayLiteralExpression(expression)) return null;

  const ids: string[] = [];
  for (const element of expression.elements) {
    if (!ts.isStringLiteral(element)) return null;
    ids.push(element.text);
  }
  return ids;
}

function isValidReviewedAt(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value <= currentUtcDate();
}

function mergeManifestConfigsForValidation(
  manifest: readonly RedemptionBackstopConfigManifestEntry[],
): Record<string, RedemptionBackstopConfig> {
  return Object.assign({}, ...manifest.map((entry) => entry.configs));
}

function addFinding(
  findings: RedemptionRegistryFinding[],
  severity: RedemptionRegistryFindingSeverity,
  code: string,
  message: string,
  context: Omit<RedemptionRegistryFinding, "severity" | "code" | "message"> = {},
): void {
  findings.push({ severity, code, message, ...context });
}

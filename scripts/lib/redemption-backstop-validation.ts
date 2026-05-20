import ts from "typescript";
import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import {
  resolveCapacityConfidence,
  resolveCapacitySemantics,
  resolveFeeConfidence,
  resolveFeeModelKind,
} from "@shared/lib/redemption-backstop-confidence";
import { ACTIVE_META_BY_ID, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { RedemptionDocSourceSupport, RedemptionRouteFamily } from "@shared/types";
import { RedemptionBackstopConfigSchema } from "@shared/lib/redemption-backstop-configs/schema";
import { getBackstopRegistryOverrideReasons, getBackstopRegistrySourceFilePaths } from "@shared/lib/redemption-backstop-configs/factory";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";
import {
  REDEMPTION_BACKSTOP_CONFIG_MANIFEST,
  buildRedemptionBackstopRegistry,
  type RedemptionBackstopConfigManifestEntry,
} from "@shared/lib/redemption-backstop-configs/manifest";
import { REDEMPTION_BACKSTOP_POLICY_ENTRIES, type RedemptionBackstopPolicyEntry } from "@shared/lib/redemption-backstop-configs/policies";

export type RedemptionRegistryFindingSeverity = "error" | "warning";

export interface RedemptionRegistryFinding {
  severity: RedemptionRegistryFindingSeverity;
  code: string;
  stablecoinId?: string;
  family?: string;
  filePath?: string;
  message: string;
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

const ROUTE_FAMILY_ORDER: RedemptionRouteFamily[] = [
  "offchain-issuer",
  "stablecoin-redeem",
  "collateral-redeem",
  "queue-redeem",
  "psm-swap",
  "basket-redeem",
];

export function validateRedemptionBackstopRegistry(
  options: RedemptionRegistryValidationOptions = {},
): RedemptionRegistryValidationResult {
  const manifest = options.manifest ?? REDEMPTION_BACKSTOP_CONFIG_MANIFEST;
  const mergedConfigs = options.mergedConfigs ?? buildRedemptionBackstopRegistry(manifest);
  const overrideReasonById = new Map<string, string>();
  for (const moduleEntry of manifest) {
    for (const [id, reason] of getBackstopRegistryOverrideReasons(moduleEntry.configs)) {
      overrideReasonById.set(id, reason);
    }
  }
  const sourceFileById = new Map<string, string>();
  for (const moduleEntry of manifest) {
    for (const [id, sourceFilePath] of getBackstopRegistrySourceFilePaths(moduleEntry.configs)) {
      sourceFileById.set(id, sourceFilePath);
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
            filePath: owner?.filePath,
          },
        );
      }
    }

    validateConfigInvariants(id, config, owner, findings);

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

    const adapterKey = TRACKED_META_BY_ID.get(id)?.liveReservesConfig?.adapter ?? null;
    const adapterDefinition = adapterKey ? getLiveReserveAdapterDefinition(adapterKey) : null;
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
      capacityConfidence: resolveCapacityConfidence(config.capacityModel),
      capacityBasis: config.capacityModel.basis ?? null,
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
  const policyRows = validateRedemptionBackstopPolicies(findings);

  const configuredIds = new Set(mergedIds);
  const unconfiguredActiveIds = [...ACTIVE_META_BY_ID.keys()].filter((id) => !configuredIds.has(id)).sort();
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

function validateConfigInvariants(
  id: string,
  config: RedemptionBackstopConfig,
  owner: RedemptionBackstopConfigManifestEntry | undefined,
  findings: RedemptionRegistryFinding[],
): void {
  const context = { stablecoinId: id, family: owner?.name, filePath: owner?.filePath };
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

function validateRedemptionBackstopPolicies(findings: RedemptionRegistryFinding[]): RedemptionPolicyAuditRow[] {
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
    } else if (adapterDefinition.redemptionTelemetry.capacity === "none") {
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
        `${entry.stablecoinId}: redemption policy reviewedAt must be YYYY-MM-DD.`,
        { stablecoinId: entry.stablecoinId, filePath: "shared/lib/redemption-backstop-configs/policies.ts" },
      );
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
}

function validateStaticConfigOverwrites(
  manifest: readonly RedemptionBackstopConfigManifestEntry[],
  sourceTextByPath: ReadonlyMap<string, string> | undefined,
  findings: RedemptionRegistryFinding[],
): void {
  if (!sourceTextByPath) return;

  for (const moduleEntry of manifest) {
    for (const filePath of [moduleEntry.filePath, ...(moduleEntry.sourceFilePaths ?? [])]) {
      validateStaticConfigSourceFile(moduleEntry, filePath, sourceTextByPath, findings);
    }
  }
}

function validateStaticConfigSourceFile(
  moduleEntry: RedemptionBackstopConfigManifestEntry,
  filePath: string,
  sourceTextByPath: ReadonlyMap<string, string>,
  findings: RedemptionRegistryFinding[],
): void {
  const sourceText = sourceTextByPath.get(filePath);
  if (sourceText == null) return;
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const registryEntries: { id: string; kind: "expandIds" | "property" }[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text.endsWith("BACKSTOP_CONFIGS") &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
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

  const seenInModule = new Map<string, "expandIds" | "property">();
  for (const entry of registryEntries) {
    const previous = seenInModule.get(entry.id);
    if (previous) {
      if (!getBackstopRegistryOverrideReasons(moduleEntry.configs).has(entry.id)) {
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
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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

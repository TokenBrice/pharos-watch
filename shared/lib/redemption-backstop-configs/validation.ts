import ts from "typescript";
import { getLiveReserveAdapterDefinition } from "../live-reserve-adapters";
import {
  resolveCapacityConfidence,
  resolveCapacitySemantics,
  resolveFeeConfidence,
  resolveFeeModelKind,
} from "../redemption-backstop-confidence";
import { ACTIVE_META_BY_ID, TRACKED_META_BY_ID } from "../stablecoins";
import type { RedemptionDocSourceSupport, RedemptionRouteFamily } from "../../types";
import { RedemptionBackstopConfigSchema } from "./schema";
import type { RedemptionBackstopConfig } from "./shared";
import {
  REDEMPTION_BACKSTOP_CONFIG_MANIFEST,
  buildRedemptionBackstopRegistry,
  type RedemptionBackstopConfigManifestEntry,
} from "./manifest";

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

export interface RedemptionRegistryValidationResult {
  findings: RedemptionRegistryFinding[];
  auditRows: RedemptionRegistryAuditRow[];
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

const INTENTIONAL_REDEMPTION_CONFIG_OVERRIDES = new Set([
  "offchain-issuer:audx-aussie-dollar-token:expandIds->expandIds",
  "offchain-issuer:brl1-brl1:expandIds->expandIds",
  "offchain-issuer:cngn-compliant-naira:expandIds->expandIds",
  "offchain-issuer:kgst-kyrgyz-som:expandIds->expandIds",
  "offchain-issuer:reur-royal-euro:expandIds->expandIds",
  "offchain-issuer:wars-argentine-peso:expandIds->expandIds",
  "offchain-issuer:usyc-hashnote:expandIds->expandIds",
  "offchain-issuer:ustb-superstate:expandIds->expandIds",
  "offchain-issuer:a7a5-old-vector:expandIds->expandIds",
  "offchain-issuer:gusd-gate:expandIds->expandIds",
  "offchain-issuer:usdt-tether:expandIds->property",
  "offchain-issuer:usdc-circle:expandIds->property",
  "offchain-issuer:pyusd-paypal:expandIds->property",
  "offchain-issuer:fdusd-first-digital:expandIds->property",
  "offchain-issuer:rlusd-ripple:expandIds->property",
  "offchain-issuer:eurc-circle:expandIds->property",
  "offchain-issuer:usdp-paxos:expandIds->property",
  "offchain-issuer:gusd-gemini:expandIds->property",
  "offchain-issuer:usdg-paxos:expandIds->property",
  "offchain-issuer:usdx-hex-trust:expandIds->property",
  "offchain-issuer:xusd-straitsx:expandIds->property",
  "offchain-issuer:xsgd-straitsx:expandIds->property",
  "offchain-issuer:euri-banking-circle:expandIds->property",
  "offchain-issuer:usdq-quantoz:expandIds->property",
  "offchain-issuer:eurq-quantoz:expandIds->property",
  "offchain-issuer:usd1-world-liberty-financial:expandIds->property",
  "offchain-issuer:ausd-agora:expandIds->property",
  "offchain-issuer:usdo-openeden:expandIds->property",
  "offchain-issuer:usdm-moneta:expandIds->property",
  "offchain-issuer:ustb-superstate:expandIds->property",
  "offchain-issuer:usdh-native-markets:expandIds->property",
  "offchain-issuer:fidd-fidelity:expandIds->property",
  "offchain-issuer:usdcv-societe-generale-forge:expandIds->property",
  "offchain-issuer:tusd-trueusd:expandIds->property",
  "offchain-issuer:eurs-stasis:expandIds->property",
  "offchain-issuer:brz-transfero:expandIds->property",
  "offchain-issuer:ylds-figure:expandIds->property",
  "offchain-issuer:usdtb-ethena:expandIds->property",
  "offchain-issuer:pusd-plume:expandIds->property",
  "offchain-issuer:gyen-gyen:expandIds->property",
  "offchain-issuer:cadc-cad-coin:expandIds->property",
  "offchain-issuer:veur-vnx:expandIds->property",
  "offchain-issuer:vchf-vnx:expandIds->property",
  "offchain-issuer:vgbp-vnx:expandIds->property",
  "offchain-issuer:tryb-bilira:expandIds->property",
  "offchain-issuer:tgbp-tokenised:expandIds->property",
  "offchain-issuer:jpyc-jpyc:expandIds->property",
  "offchain-issuer:axcnh-anchorx:expandIds->property",
  "offchain-issuer:idrt-rupiah-token:expandIds->property",
  "offchain-issuer:europ-schuman:expandIds->property",
  "offchain-issuer:eurau-allunity:expandIds->property",
  "offchain-issuer:chfau-allunity:expandIds->property",
  "offchain-issuer:usda-anzens:expandIds->property",
  "offchain-issuer:cash-phantom:expandIds->property",
  "offchain-issuer:mnee-mnee:expandIds->property",
  "offchain-issuer:sbc-brale:expandIds->property",
  "offchain-issuer:m-m0:expandIds->property",
  "offchain-issuer:musd-metamask:expandIds->property",
  "offchain-issuer:usdn-noble:expandIds->property",
  "offchain-issuer:aeur-anchored-coins:expandIds->property",
  "offchain-issuer:eurcv-societe-generale-forge:expandIds->property",
  "offchain-issuer:tbill-openeden:expandIds->property",
  "offchain-issuer:eure-monerium:expandIds->property",
  "offchain-issuer:eurr-stablr:expandIds->property",
  "offchain-issuer:wusd-worldwide:expandIds->property",
  "offchain-issuer:usdgo-osl:expandIds->property",
  "offchain-issuer:audd-novatti:expandIds->property",
  "offchain-issuer:usdr-stablr:expandIds->property",
  "offchain-issuer:usat-tether:expandIds->property",
  "collateral-redeem:bold-liquity:expandIds->property",
  "collateral-redeem:lusd-liquity:expandIds->property",
  "collateral-redeem:feusd-felix:expandIds->property",
  "collateral-redeem:meusd-mezo:expandIds->property",
  "collateral-redeem:nect-beraborrow:expandIds->property",
  "collateral-redeem:fxusd-f-x-protocol:expandIds->property",
  "collateral-redeem:usdq-quill:expandIds->property",
  "collateral-redeem:usdk-orki:expandIds->property",
]);

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
      filePath: owner?.filePath ?? "unknown",
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
      overrideReason: null,
    };
  });

  validateDocSupportRatchet(findings, sourcesWithoutSupports, missingSupportKindCounts);
  validateConfidenceDocs(findings, options.docsText, options.apiDocsText);

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
    const sourceText = sourceTextByPath.get(moduleEntry.filePath);
    if (sourceText == null) continue;
    const sourceFile = ts.createSourceFile(moduleEntry.filePath, sourceText, ts.ScriptTarget.Latest, true);
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
                `${moduleEntry.filePath}:${line + 1}:${character + 1}: expandIds() must use an inline string array for overwrite checks.`,
                { family: moduleEntry.name, filePath: moduleEntry.filePath },
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
                `${moduleEntry.filePath}:${line + 1}:${character + 1}: duplicate object key "${key}" previously declared at line ${previousPosition.line + 1}.`,
                { stablecoinId: key, family: moduleEntry.name, filePath: moduleEntry.filePath },
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
        const key = `${moduleEntry.name}:${entry.id}:${previous}->${entry.kind}`;
        if (!INTENTIONAL_REDEMPTION_CONFIG_OVERRIDES.has(key)) {
          addFinding(
            findings,
            "error",
            "unapproved-config-overwrite",
            `${moduleEntry.name} overwrites "${entry.id}" via ${previous}->${entry.kind}; add it to INTENTIONAL_REDEMPTION_CONFIG_OVERRIDES if intentional.`,
            { stablecoinId: entry.id, family: moduleEntry.name, filePath: moduleEntry.filePath },
          );
        }
      }
      seenInModule.set(entry.id, entry.kind);
    }
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

function addFinding(
  findings: RedemptionRegistryFinding[],
  severity: RedemptionRegistryFindingSeverity,
  code: string,
  message: string,
  context: Omit<RedemptionRegistryFinding, "severity" | "code" | "message"> = {},
): void {
  findings.push({ severity, code, message, ...context });
}

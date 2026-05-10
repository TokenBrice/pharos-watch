#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { getLiveReserveAdapterDefinition } from "../shared/lib/live-reserve-adapters";
import { COLLATERAL_REDEEM_BACKSTOP_CONFIGS } from "../shared/lib/redemption-backstop-configs/collateral-redeem";
import { OFFCHAIN_ISSUER_BACKSTOP_CONFIGS } from "../shared/lib/redemption-backstop-configs/offchain-issuer";
import { PSM_AND_BASKET_BACKSTOP_CONFIGS } from "../shared/lib/redemption-backstop-configs/psm-and-basket";
import { QUEUE_REDEEM_BACKSTOP_CONFIGS } from "../shared/lib/redemption-backstop-configs/queue-redeem";
import { RedemptionBackstopConfigSchema } from "../shared/lib/redemption-backstop-configs/schema";
import { STABLECOIN_REDEEM_BACKSTOP_CONFIGS } from "../shared/lib/redemption-backstop-configs/stablecoin-redeem";
import { TRACKED_META_BY_ID } from "../shared/lib/stablecoins";
import { REDEMPTION_BACKSTOP_CONFIGS } from "../shared/lib/redemption-backstops";
import type { RedemptionDocSourceSupport } from "../shared/types/redemption";

const ROOT = process.cwd();
const DOC_PATH = resolve(ROOT, "docs/redemption-backstops.md");
const API_DOC_PATH = resolve(ROOT, "docs/api-reference.md");
const docs = readFileSync(DOC_PATH, "utf8");
const apiDocs = readFileSync(API_DOC_PATH, "utf8");

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
  "offchain-issuer:pusd-pleasing:expandIds->property",
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

const familyModules = [
  {
    name: "offchain-issuer",
    filePath: "shared/lib/redemption-backstop-configs/offchain-issuer.ts",
    configs: OFFCHAIN_ISSUER_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["offchain-issuer"]),
  },
  {
    name: "psm-and-basket",
    filePath: "shared/lib/redemption-backstop-configs/psm-and-basket.ts",
    configs: PSM_AND_BASKET_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["basket-redeem", "psm-swap"]),
  },
  {
    name: "collateral-redeem",
    filePath: "shared/lib/redemption-backstop-configs/collateral-redeem.ts",
    configs: COLLATERAL_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["collateral-redeem"]),
  },
  {
    name: "queue-redeem",
    filePath: "shared/lib/redemption-backstop-configs/queue-redeem.ts",
    configs: QUEUE_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["queue-redeem"]),
  },
  {
    name: "stablecoin-redeem",
    filePath: "shared/lib/redemption-backstop-configs/stablecoin-redeem.ts",
    configs: STABLECOIN_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["stablecoin-redeem"]),
  },
] as const;

const errors: string[] = [];
const seenById = new Map<string, string>();

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

function checkStaticConfigOverwrites(): void {
  for (const moduleEntry of familyModules) {
    const sourcePath = resolve(ROOT, moduleEntry.filePath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- source paths are fixed repo-local registry module paths.
    const sourceText = readFileSync(sourcePath, "utf8");
    const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
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
              errors.push(
                `${moduleEntry.filePath}:${line + 1}:${character + 1}: expandIds() must use an inline string array for overwrite checks.`,
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
              errors.push(
                `${moduleEntry.filePath}:${line + 1}:${character + 1}: duplicate object key "${key}" previously declared at line ${previousPosition.line + 1}.`,
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
          errors.push(
            `${moduleEntry.name} overwrites "${entry.id}" via ${previous}->${entry.kind}; add it to INTENTIONAL_REDEMPTION_CONFIG_OVERRIDES if intentional.`,
          );
        }
      }
      seenInModule.set(entry.id, entry.kind);
    }
  }
}

checkStaticConfigOverwrites();

for (const moduleEntry of familyModules) {
  for (const [id, config] of Object.entries(moduleEntry.configs)) {
    const previous = seenById.get(id);
    if (previous) {
      errors.push(`Duplicate id "${id}" appears in both ${previous} and ${moduleEntry.name}.`);
      continue;
    }
    seenById.set(id, moduleEntry.name);

    if (!moduleEntry.allowedRouteFamilies.has(config.routeFamily)) {
      errors.push(`${moduleEntry.name} contains ${id} with unexpected route family ${config.routeFamily}.`);
    }

    if (!TRACKED_META_BY_ID.has(id)) {
      errors.push(`Unknown tracked stablecoin id "${id}" in ${moduleEntry.name}.`);
    }
  }
}

const mergedIds = Object.keys(REDEMPTION_BACKSTOP_CONFIGS);
if (seenById.size !== mergedIds.length) {
  errors.push(`Module union size ${seenById.size} does not match merged registry size ${mergedIds.length}.`);
}

const routeFamilyOrder = [
  "offchain-issuer",
  "stablecoin-redeem",
  "collateral-redeem",
  "queue-redeem",
  "psm-swap",
  "basket-redeem",
] as const;

const routeFamilyCounts = routeFamilyOrder.map((routeFamily) => ({
  routeFamily,
  count: mergedIds.filter((id) => REDEMPTION_BACKSTOP_CONFIGS[id]?.routeFamily === routeFamily).length,
}));

const expectedConfiguredLine = `- **Configured coins:** ${mergedIds.length}`;
if (!docs.includes(expectedConfiguredLine)) {
  errors.push(`docs/redemption-backstops.md is out of sync. Expected line: ${expectedConfiguredLine}`);
}

const expectedRouteLine = `- **Route families:** ${routeFamilyCounts
  .map(({ routeFamily, count }) => `${count} \`${routeFamily}\``)
  .join(", ")}`;
if (!docs.includes(expectedRouteLine)) {
  errors.push(`docs/redemption-backstops.md is out of sync. Expected line: ${expectedRouteLine}`);
}

let sourcesWithoutSupports = 0;
const missingSupportKindCounts = new Map<RedemptionDocSourceSupport, number>();

for (const [id, config] of Object.entries(REDEMPTION_BACKSTOP_CONFIGS)) {
  const parseResult = RedemptionBackstopConfigSchema.safeParse(config);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      errors.push(`${id}: schema validation failed at ${path}: ${issue.message}`);
    }
  }
  if (config.costModel.kind === "dynamic-or-unclear" && !config.costModel.feeDescription) {
    errors.push(`${id}: dynamic-or-unclear cost model missing feeDescription`);
  }
  if (config.costModel.kind === "fee-bps" && config.costModel.feeBps < 0) {
    errors.push(`${id}: negative feeBps (${config.costModel.feeBps})`);
  }
  if (
    config.capacityModel.kind === "supply-ratio" &&
    (config.capacityModel.ratio <= 0 || config.capacityModel.ratio > 1)
  ) {
    errors.push(`${id}: supply-ratio out of range (${config.capacityModel.ratio})`);
  }
  if (
    config.capacityModel.kind === "reserve-sync-metadata" &&
    config.capacityModel.fallbackRatio != null &&
    (config.capacityModel.fallbackRatio <= 0 || config.capacityModel.fallbackRatio > 1)
  ) {
    errors.push(`${id}: reserve-sync fallbackRatio out of range (${config.capacityModel.fallbackRatio})`);
  }
  if (config.totalScoreCap != null && (config.totalScoreCap <= 0 || config.totalScoreCap > 100)) {
    errors.push(`${id}: totalScoreCap out of range (${config.totalScoreCap})`);
  }
  if (config.capacityModel.confidence === "documented-bound") {
    if (!config.reviewedAt) {
      errors.push(`${id}: documented-bound route missing reviewedAt`);
    }
    if (!config.docs || config.docs.length === 0) {
      errors.push(`${id}: documented-bound route missing explicit docs[]`);
    }
  }
  if (config.reviewedAt && (!config.docs || config.docs.length === 0)) {
    errors.push(`${id}: reviewed route missing docs[]`);
  }

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

  if (config.capacityModel.kind === "reserve-sync-metadata") {
    const adapterKey = TRACKED_META_BY_ID.get(id)?.liveReservesConfig?.adapter;
    if (!adapterKey) {
      errors.push(`${id}: reserve-sync-metadata route missing liveReservesConfig adapter`);
      continue;
    }
    const definition = getLiveReserveAdapterDefinition(adapterKey);
    if (!definition) {
      errors.push(`${id}: reserve-sync-metadata route references unknown adapter (${adapterKey})`);
      continue;
    }
    const telemetry = definition.redemptionTelemetry;
    if (telemetry.capacity === "none") {
      errors.push(`${id}: reserve-sync-metadata route points to fee-only/no-capacity adapter (${adapterKey})`);
    }
    if (!config.reviewedAt) {
      errors.push(`${id}: reserve-sync-metadata route missing reviewedAt`);
    }
    if (!config.docs || config.docs.length === 0) {
      errors.push(`${id}: reserve-sync-metadata route missing explicit docs[]`);
    }
  }
}

if (sourcesWithoutSupports > DOC_SOURCE_SUPPORT_BASELINE.sourcesWithoutSupports) {
  errors.push(
    `docs[].supports ratchet regressed: ${sourcesWithoutSupports} source entries lack supports[] (baseline ${DOC_SOURCE_SUPPORT_BASELINE.sourcesWithoutSupports})`,
  );
}

for (const supportKind of DOC_SUPPORT_KINDS) {
  const count = missingSupportKindCounts.get(supportKind) ?? 0;
  const baseline = DOC_SOURCE_SUPPORT_BASELINE.missingSupportKindCounts[supportKind];
  if (count > baseline) {
    errors.push(
      `docs[].supports ratchet regressed for ${supportKind}: ${count} configs missing support (baseline ${baseline})`,
    );
  }
}

for (const requiredTerm of ["live-direct", "live-proxy"]) {
  if (!docs.includes(requiredTerm)) {
    errors.push(`docs/redemption-backstops.md missing capacity-confidence term ${requiredTerm}`);
  }
  if (!apiDocs.includes(requiredTerm)) {
    errors.push(`docs/api-reference.md missing capacity-confidence term ${requiredTerm}`);
  }
}

if (errors.length > 0) {
  console.error("Redemption backstop registry checks failed:");
  for (const error of errors) {
    console.error(`  ${error}`);
  }
  process.exit(1);
}

console.log(
  `Redemption backstop checks passed (${mergedIds.length} configs; ${routeFamilyCounts
    .map(({ routeFamily, count }) => `${routeFamily}=${count}`)
    .join(", ")}).`,
);

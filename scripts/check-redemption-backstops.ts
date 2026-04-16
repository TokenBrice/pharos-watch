#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLiveReserveAdapterDefinition } from "../shared/lib/live-reserve-adapters";
import { COLLATERAL_REDEEM_BACKSTOP_CONFIGS } from "../shared/lib/redemption-backstop-configs/collateral-redeem";
import { OFFCHAIN_ISSUER_BACKSTOP_CONFIGS } from "../shared/lib/redemption-backstop-configs/offchain-issuer";
import { PSM_AND_BASKET_BACKSTOP_CONFIGS } from "../shared/lib/redemption-backstop-configs/psm-and-basket";
import { QUEUE_REDEEM_BACKSTOP_CONFIGS } from "../shared/lib/redemption-backstop-configs/queue-redeem";
import { STABLECOIN_REDEEM_BACKSTOP_CONFIGS } from "../shared/lib/redemption-backstop-configs/stablecoin-redeem";
import { TRACKED_META_BY_ID } from "../shared/lib/stablecoins";
import { REDEMPTION_BACKSTOP_CONFIGS } from "../shared/lib/redemption-backstops";

const ROOT = process.cwd();
const DOC_PATH = resolve(ROOT, "docs/redemption-backstops.md");
const API_DOC_PATH = resolve(ROOT, "docs/api-reference.md");
const docs = readFileSync(DOC_PATH, "utf8");
const apiDocs = readFileSync(API_DOC_PATH, "utf8");

const familyModules = [
  {
    name: "offchain-issuer",
    configs: OFFCHAIN_ISSUER_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["offchain-issuer"]),
  },
  {
    name: "psm-and-basket",
    configs: PSM_AND_BASKET_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["basket-redeem", "psm-swap"]),
  },
  {
    name: "collateral-redeem",
    configs: COLLATERAL_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["collateral-redeem"]),
  },
  {
    name: "queue-redeem",
    configs: QUEUE_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["queue-redeem"]),
  },
  {
    name: "stablecoin-redeem",
    configs: STABLECOIN_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["stablecoin-redeem"]),
  },
] as const;

const errors: string[] = [];
const seenById = new Map<string, string>();

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

for (const [id, config] of Object.entries(REDEMPTION_BACKSTOP_CONFIGS)) {
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

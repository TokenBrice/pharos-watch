#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLiveReserveAdapterDefinition } from "../shared/lib/live-reserve-adapters";
import {
  resolveCapacityConfidence,
  resolveFeeConfidence,
  resolveFeeModelKind,
} from "../shared/lib/redemption-backstop-confidence";
import { REDEMPTION_BACKSTOP_CONFIGS, type RedemptionBackstopConfig } from "../shared/lib/redemption-backstops";
import { ACTIVE_IDS, ACTIVE_STABLECOINS, TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "../shared/lib/stablecoins";
import type { StablecoinMeta } from "../shared/types";
import type {
  RedemptionCapacityConfidence,
  RedemptionDocSourceSupport,
  RedemptionFeeConfidence,
  RedemptionFeeModelKind,
  RedemptionRouteFamily,
} from "../shared/types/redemption";

const ROUTE_FAMILY_ORDER: RedemptionRouteFamily[] = [
  "offchain-issuer",
  "stablecoin-redeem",
  "collateral-redeem",
  "queue-redeem",
  "psm-swap",
  "basket-redeem",
];

const DOC_SUPPORT_KINDS: RedemptionDocSourceSupport[] = ["route", "capacity", "fees", "access", "settlement"];

interface CliOptions {
  safetyDelta: boolean;
  beforePath?: string;
  afterPath?: string;
  allowlistPath?: string;
}

interface GroupSummary {
  total: number;
  active: number;
  activeExamples: string[];
  otherExamples: string[];
}

interface SafetyDeltaCard {
  id: string;
  overallScore: number | null;
  liquidityScore: number | null;
  redemptionUsedForLiquidity: boolean | null;
}

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    safetyDelta: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--safety-delta") {
      options.safetyDelta = true;
      continue;
    }
    if (arg === "--before") {
      options.beforePath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--after") {
      options.afterPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--allowlist") {
      options.allowlistPath = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

function increment<K extends string>(map: Map<K, number>, key: K, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function formatCountMap<K extends string>(map: ReadonlyMap<K, number>, order?: readonly K[]): string[] {
  const orderedKeys = order
    ? [...order, ...[...map.keys()].filter((key) => !order.includes(key)).sort()]
    : [...map.keys()].sort();

  return orderedKeys.filter((key) => map.has(key)).map((key) => `  - ${key}: ${map.get(key) ?? 0}`);
}

function coinLabel(id: string): string {
  const meta = TRACKED_META_BY_ID.get(id);
  return meta ? `${id} (${meta.symbol})` : id;
}

function statusOf(meta: StablecoinMeta): string {
  return meta.status ?? "active";
}

function readJsonFile(path: string): unknown {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied audit files are read only for local before/after comparison.
  return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
}

function routeConfidenceForReadback(id: string, config: RedemptionBackstopConfig): RedemptionCapacityConfidence {
  if (config.capacityModel.kind !== "reserve-sync-metadata") {
    return resolveCapacityConfidence(config.capacityModel);
  }

  const adapterKey = TRACKED_META_BY_ID.get(id)?.liveReservesConfig?.adapter;
  const telemetry = adapterKey ? getLiveReserveAdapterDefinition(adapterKey)?.redemptionTelemetry.capacity : null;
  if (telemetry === "direct") return "live-direct";
  if (telemetry === "proxy") return "live-proxy";
  return "dynamic";
}

function addGroup(groups: Map<string, GroupSummary>, key: string, meta: StablecoinMeta): void {
  const group = groups.get(key) ?? {
    total: 0,
    active: 0,
    activeExamples: [],
    otherExamples: [],
  };
  group.total += 1;
  if (ACTIVE_IDS.has(meta.id)) {
    group.active += 1;
    if (group.activeExamples.length < 8) {
      group.activeExamples.push(`${meta.id} (${meta.symbol})`);
    }
  } else if (group.otherExamples.length < 8) {
    group.otherExamples.push(`${meta.id} (${meta.symbol})`);
  }
  groups.set(key, group);
}

function printGroup(title: string, groups: ReadonlyMap<string, GroupSummary>): void {
  console.log(`\n${title}`);
  for (const [key, group] of [...groups.entries()].sort((a, b) => {
    const countSort = b[1].total - a[1].total;
    return countSort !== 0 ? countSort : a[0].localeCompare(b[0]);
  })) {
    const examples = group.activeExamples.length > 0 ? group.activeExamples : group.otherExamples;
    console.log(
      `  - ${key}: ${group.total} tracked, ${group.active} active` +
        (examples.length > 0 ? `; examples: ${examples.join(", ")}` : ""),
    );
  }
}

function printRedemptionHealthAudit(): void {
  const configEntries = Object.entries(REDEMPTION_BACKSTOP_CONFIGS).sort(([a], [b]) => a.localeCompare(b));
  const configuredIds = new Set(configEntries.map(([id]) => id));
  const activeConfiguredIds = configEntries.map(([id]) => id).filter((id) => ACTIVE_IDS.has(id));
  const activeUncovered = ACTIVE_STABLECOINS.filter((meta) => !configuredIds.has(meta.id));
  const trackedUncovered = TRACKED_STABLECOINS.filter((meta) => !configuredIds.has(meta.id));

  console.log("Redemption Backstop Health Audit");
  console.log("Informational only; gaps reported here do not fail this command.\n");

  console.log("Coverage");
  console.log(`  - tracked stablecoins: ${TRACKED_STABLECOINS.length}`);
  console.log(`  - active stablecoins: ${ACTIVE_STABLECOINS.length}`);
  console.log(`  - configured routes: ${configEntries.length}`);
  console.log(`  - active configured routes: ${activeConfiguredIds.length}`);
  console.log(`  - active uncovered stablecoins: ${activeUncovered.length}`);
  console.log(`  - tracked uncovered stablecoins: ${trackedUncovered.length}`);
  console.log(
    "  - coverage-expansion examples prioritize active assets; frozen/cemetery assets are reported only as lifecycle context",
  );

  const routeFamilyCounts = new Map<RedemptionRouteFamily, number>();
  const capacityModelCounts = new Map<string, number>();
  const capacityConfidenceCounts = new Map<RedemptionCapacityConfidence, number>();
  const readbackCapacityConfidenceCounts = new Map<RedemptionCapacityConfidence, number>();
  const costModelCounts = new Map<string, number>();
  const feeConfidenceCounts = new Map<RedemptionFeeConfidence, number>();
  const feeModelKindCounts = new Map<RedemptionFeeModelKind, number>();

  const reserveSyncRoutes: string[] = [];
  const heuristicSupplyRatioRoutes: string[] = [];
  const fallbackRatioRoutes: string[] = [];
  const docSourceWithoutSupports: string[] = [];
  const docsMissingSupportKindRows: string[] = [];
  const missingSupportKindCounts = new Map<RedemptionDocSourceSupport, number>();

  for (const [id, config] of configEntries) {
    increment(routeFamilyCounts, config.routeFamily);
    increment(capacityModelCounts, config.capacityModel.kind);
    increment(capacityConfidenceCounts, resolveCapacityConfidence(config.capacityModel));
    increment(readbackCapacityConfidenceCounts, routeConfidenceForReadback(id, config));
    increment(costModelCounts, config.costModel.kind);
    increment(feeConfidenceCounts, resolveFeeConfidence(config.costModel));
    increment(feeModelKindCounts, resolveFeeModelKind(config.costModel));

    if (
      config.capacityModel.kind === "supply-ratio" &&
      resolveCapacityConfidence(config.capacityModel) === "heuristic"
    ) {
      heuristicSupplyRatioRoutes.push(`  - ${coinLabel(id)}: ratio=${config.capacityModel.ratio}`);
    }

    if (config.capacityModel.kind === "reserve-sync-metadata") {
      const adapterKey = TRACKED_META_BY_ID.get(id)?.liveReservesConfig?.adapter ?? "missing-adapter";
      const telemetry =
        adapterKey === "missing-adapter"
          ? null
          : (getLiveReserveAdapterDefinition(adapterKey)?.redemptionTelemetry ?? null);
      reserveSyncRoutes.push(
        `  - ${coinLabel(id)}: adapter=${adapterKey}, capacity=${telemetry?.capacity ?? "unknown"}, fee=${telemetry?.fee ?? "unknown"}`,
      );

      if (config.capacityModel.fallbackRatio != null) {
        fallbackRatioRoutes.push(
          `  - ${coinLabel(id)}: fallbackRatio=${config.capacityModel.fallbackRatio}, adapter=${adapterKey}`,
        );
      }
    }

    const coveredSupportKinds = new Set<RedemptionDocSourceSupport>();
    for (const doc of config.docs ?? []) {
      if (!doc.supports || doc.supports.length === 0) {
        docSourceWithoutSupports.push(`  - ${coinLabel(id)}: ${doc.label} (${doc.url})`);
        continue;
      }
      for (const supportKind of doc.supports) {
        coveredSupportKinds.add(supportKind);
      }
    }

    const missingKinds = DOC_SUPPORT_KINDS.filter((kind) => !coveredSupportKinds.has(kind));
    if (missingKinds.length > 0) {
      for (const kind of missingKinds) {
        increment(missingSupportKindCounts, kind);
      }
      docsMissingSupportKindRows.push(`  - ${coinLabel(id)}: ${missingKinds.join(", ")}`);
    }
  }

  console.log("\nRoute Families");
  console.log(formatCountMap(routeFamilyCounts, ROUTE_FAMILY_ORDER).join("\n"));

  console.log("\nCapacity Models");
  console.log(formatCountMap(capacityModelCounts).join("\n"));

  console.log("\nCapacity Confidence (configured/default)");
  console.log(formatCountMap(capacityConfidenceCounts).join("\n"));

  console.log("\nCapacity Confidence (reserve-sync adapter readback estimate)");
  console.log(formatCountMap(readbackCapacityConfidenceCounts).join("\n"));

  console.log("\nCost Models");
  console.log(formatCountMap(costModelCounts).join("\n"));

  console.log("\nFee Confidence");
  console.log(formatCountMap(feeConfidenceCounts).join("\n"));

  console.log("\nFee Model Kinds");
  console.log(formatCountMap(feeModelKindCounts).join("\n"));

  console.log(`\nReserve-Sync-Metadata Routes (${reserveSyncRoutes.length})`);
  console.log(reserveSyncRoutes.length > 0 ? reserveSyncRoutes.join("\n") : "  - none");

  console.log("\nDocs Support Gaps");
  console.log(`  - doc source entries without supports[]: ${docSourceWithoutSupports.length}`);
  console.log("  - configs missing support kinds:");
  console.log(formatCountMap(missingSupportKindCounts, DOC_SUPPORT_KINDS).join("\n"));

  console.log("\nDocs Missing Support Kinds By Stablecoin");
  console.log(docsMissingSupportKindRows.length > 0 ? docsMissingSupportKindRows.join("\n") : "  - none");

  console.log("\nDoc Source Entries Without supports[]");
  console.log(docSourceWithoutSupports.length > 0 ? docSourceWithoutSupports.join("\n") : "  - none");

  console.log(`\nHeuristic supply-ratio Routes (${heuristicSupplyRatioRoutes.length})`);
  console.log(heuristicSupplyRatioRoutes.length > 0 ? heuristicSupplyRatioRoutes.join("\n") : "  - none");

  console.log(`\nReserve-Sync Fallback Ratio Routes (${fallbackRatioRoutes.length})`);
  console.log(fallbackRatioRoutes.length > 0 ? fallbackRatioRoutes.join("\n") : "  - none");

  const wrapperParentGroups = new Map<string, GroupSummary>();
  const adapterGroups = new Map<string, GroupSummary>();
  const backingGroups = new Map<string, GroupSummary>();
  const governanceGroups = new Map<string, GroupSummary>();
  const lifecycleGroups = new Map<string, GroupSummary>();

  for (const meta of trackedUncovered) {
    const wrapperParent = meta.variantOf
      ? `${meta.variantKind ?? "variant"} -> ${meta.variantOf}`
      : meta.flags.navToken
        ? "nav-token-no-parent"
        : "not-wrapper";
    addGroup(wrapperParentGroups, wrapperParent, meta);
    addGroup(adapterGroups, meta.liveReservesConfig?.adapter ?? "none", meta);
    addGroup(backingGroups, meta.flags.backing, meta);
    addGroup(governanceGroups, meta.flags.governance, meta);
    addGroup(lifecycleGroups, statusOf(meta), meta);
  }

  printGroup("\nUncovered Candidates By Wrapper/Parent", wrapperParentGroups);
  printGroup("Uncovered Candidates By Live Reserve Adapter", adapterGroups);
  printGroup("Uncovered Candidates By Backing", backingGroups);
  printGroup("Uncovered Candidates By Governance", governanceGroups);
  printGroup("Uncovered Tracked Assets By Lifecycle", lifecycleGroups);
}

function parseSafetyCard(input: unknown): SafetyDeltaCard | null {
  if (typeof input !== "object" || input == null) return null;
  const record = input as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  const dimensions =
    typeof record.dimensions === "object" && record.dimensions != null
      ? (record.dimensions as Record<string, unknown>)
      : {};
  const liquidity =
    typeof dimensions.liquidity === "object" && dimensions.liquidity != null
      ? (dimensions.liquidity as Record<string, unknown>)
      : {};
  const rawInputs =
    typeof record.rawInputs === "object" && record.rawInputs != null
      ? (record.rawInputs as Record<string, unknown>)
      : {};

  return {
    id: record.id,
    overallScore: typeof record.overallScore === "number" ? record.overallScore : null,
    liquidityScore: typeof liquidity.score === "number" ? liquidity.score : null,
    redemptionUsedForLiquidity:
      typeof rawInputs.redemptionUsedForLiquidity === "boolean" ? rawInputs.redemptionUsedForLiquidity : null,
  };
}

function readSafetyCards(path: string): Map<string, SafetyDeltaCard> {
  const payload = readJsonFile(path);
  const cardsInput = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload != null && Array.isArray((payload as { cards?: unknown }).cards)
      ? (payload as { cards: unknown[] }).cards
      : null;

  if (!cardsInput) {
    throw new Error(`${path} must be a report-card snapshot object with cards[] or a cards array`);
  }

  const cards = new Map<string, SafetyDeltaCard>();
  for (const item of cardsInput) {
    const card = parseSafetyCard(item);
    if (card) {
      cards.set(card.id, card);
    }
  }
  return cards;
}

function readAllowlist(path: string | undefined): Set<string> {
  if (!path) return new Set();
  const payload = readJsonFile(path);
  if (!Array.isArray(payload)) {
    throw new Error(`${path} must be an array of stablecoin ids or objects with an id field`);
  }

  return new Set(
    payload.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (typeof item === "object" && item != null && typeof (item as { id?: unknown }).id === "string") {
        return [(item as { id: string }).id];
      }
      return [];
    }),
  );
}

function formatScore(value: number | null): string {
  return value == null ? "NR" : String(value);
}

function printSafetyDeltaAudit(options: CliOptions): void {
  console.log("Safety Score Delta Audit");

  if (!options.beforePath || !options.afterPath) {
    console.log("Scaffold mode only: provide --before and --after report-card snapshot JSON files to compare.");
    console.log("No checked-in report-card fixture/cache inputs were found for local recomputation.");
    console.log("TODO: wire this mode to deterministic report-card fixture inputs when a fixture source exists.");
    console.log("Expected usage:");
    console.log(
      "  npx tsx scripts/audit-redemption-backstop-health.ts --safety-delta --before agents/research/report-cards-before.json --after agents/research/report-cards-after.json [--allowlist agents/research/allowed-safety-deltas.json]",
    );
    return;
  }

  const before = readSafetyCards(options.beforePath);
  const after = readSafetyCards(options.afterPath);
  const allowlist = readAllowlist(options.allowlistPath);
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const nrToRated: string[] = [];
  const redemptionTransitions: string[] = [];
  const deltas: string[] = [];

  for (const id of ids) {
    const beforeCard = before.get(id);
    const afterCard = after.get(id);
    if (!beforeCard || !afterCard) continue;
    const allowed = allowlist.has(id) ? " allowed" : "";

    if (beforeCard.overallScore == null && afterCard.overallScore != null) {
      nrToRated.push(`  - ${coinLabel(id)}: NR -> ${afterCard.overallScore}${allowed}`);
    }

    if (beforeCard.redemptionUsedForLiquidity !== afterCard.redemptionUsedForLiquidity) {
      redemptionTransitions.push(
        `  - ${coinLabel(id)}: ${beforeCard.redemptionUsedForLiquidity} -> ${afterCard.redemptionUsedForLiquidity}${allowed}`,
      );
    }

    const liquidityChanged = beforeCard.liquidityScore !== afterCard.liquidityScore;
    const overallChanged = beforeCard.overallScore !== afterCard.overallScore;
    if (liquidityChanged || overallChanged) {
      deltas.push(
        `  - ${coinLabel(id)}: liquidity ${formatScore(beforeCard.liquidityScore)} -> ${formatScore(afterCard.liquidityScore)}, overall ${formatScore(beforeCard.overallScore)} -> ${formatScore(afterCard.overallScore)}${allowed}`,
      );
    }
  }

  console.log(`\nNR-to-rated transitions (${nrToRated.length})`);
  console.log(nrToRated.length > 0 ? nrToRated.join("\n") : "  - none");
  console.log(`\nredemptionUsedForLiquidity transitions (${redemptionTransitions.length})`);
  console.log(redemptionTransitions.length > 0 ? redemptionTransitions.join("\n") : "  - none");
  console.log(`\nLiquidity / Exit and overall deltas (${deltas.length})`);
  console.log(deltas.length > 0 ? deltas.join("\n") : "  - none");
}

const options = parseCliOptions(process.argv.slice(2));
if (options.safetyDelta) {
  printSafetyDeltaAudit(options);
} else {
  printRedemptionHealthAudit();
}

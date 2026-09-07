#!/usr/bin/env tsx

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  REDEMPTION_BACKSTOP_CONFIG_MANIFEST,
  REDEMPTION_BACKSTOP_CONFIGS,
} from "@shared/lib/redemption-backstop-configs";
import { configsFromBackstopEntries } from "@shared/lib/redemption-backstop-configs/factory";
import {
  resolveCapacityConfidence,
  resolveFeeConfidence,
  resolveFeeModelKind,
} from "@shared/lib/redemption-backstop-confidence";
import {
  computeCapacityScore,
  computeRedemptionBackstopScore,
  REDEMPTION_ACCESS_SCORES,
  REDEMPTION_EXECUTION_SCORES,
  REDEMPTION_OUTPUT_ASSET_SCORES,
  REDEMPTION_SETTLEMENT_SCORES,
} from "@shared/lib/redemption-backstop-scoring";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";
import { resolveStaticCostScore } from "../lib/redemption-audit-helpers";

const ROOT = process.cwd();
const SNAPSHOT_SUPPLY_USD = 1_000_000_000;

interface ParitySnapshot {
  registry: unknown[];
  staticScores: unknown[];
}

const SEMANTIC_REGISTRY_FIELDS = [
  "stablecoinId",
  "routeFamily",
  "accessModel",
  "settlementModel",
  "executionModel",
  "outputAssetType",
  "holderEligibility",
  "routeStatus",
  "capacityModel",
  "costModel",
  "totalScoreCap",
] as const;

const SEMANTIC_STATIC_SCORE_FIELDS = [
  "stablecoinId",
  "routeFamily",
  "capacityConfidence",
  "feeConfidence",
  "feeModelKind",
  "immediateCapacityUsd",
  "immediateCapacityRatio",
  "accessScore",
  "settlementScore",
  "executionCertaintyScore",
  "capacityScore",
  "coverageRatioScore",
  "absoluteCapacityScore",
  "outputAssetQualityScore",
  "costScore",
  "score",
  "capsApplied",
] as const;

function buildSnapshot(): ParitySnapshot {
  const ownerById = new Map<string, string>();
  for (const entry of REDEMPTION_BACKSTOP_CONFIG_MANIFEST) {
    for (const id of Object.keys(configsFromBackstopEntries(entry.entries))) {
      ownerById.set(id, entry.name);
    }
  }

  const ids = Object.keys(REDEMPTION_BACKSTOP_CONFIGS).sort();
  return {
    registry: ids.map((id) => {
      const config = REDEMPTION_BACKSTOP_CONFIGS[id];
      return {
        stablecoinId: id,
        owner: ownerById.get(id) ?? "unknown",
        routeFamily: config.routeFamily,
        accessModel: config.accessModel,
        settlementModel: config.settlementModel,
        executionModel: config.executionModel,
        outputAssetType: config.outputAssetType,
        holderEligibility: config.holderEligibility ?? null,
        routeStatus: config.routeStatus ?? null,
        capacityModel: sortObject(config.capacityModel),
        costModel: sortObject(config.costModel),
        totalScoreCap: config.totalScoreCap ?? null,
        reviewedAt: config.reviewedAt ?? null,
        docs: (config.docs ?? []).map((doc) => ({
          label: doc.label,
          url: doc.url,
          supports: [...(doc.supports ?? [])].sort(),
        })),
        notes: [...(config.notes ?? [])],
      };
    }),
    staticScores: ids.map((id) => buildStaticScoreSnapshot(id, REDEMPTION_BACKSTOP_CONFIGS[id])),
  };
}

function buildStaticScoreSnapshot(stablecoinId: string, config: RedemptionBackstopConfig): object {
  const immediateCapacityRatio = resolveStaticCapacityRatio(config);
  const immediateCapacityUsd = immediateCapacityRatio == null ? null : SNAPSHOT_SUPPLY_USD * immediateCapacityRatio;
  const capacity = computeCapacityScore({
    immediateCapacityUsd,
    immediateCapacityRatio,
  });
  const accessScore = REDEMPTION_ACCESS_SCORES[config.accessModel];
  const settlementScore = REDEMPTION_SETTLEMENT_SCORES[config.settlementModel];
  const executionCertaintyScore = REDEMPTION_EXECUTION_SCORES[config.executionModel];
  const outputAssetQualityScore = REDEMPTION_OUTPUT_ASSET_SCORES[config.outputAssetType];
  const costScore = resolveStaticCostScore(config);
  const score = computeRedemptionBackstopScore({
    routeFamily: config.routeFamily,
    accessScore,
    settlementScore,
    executionCertaintyScore,
    capacityScore: capacity.score,
    outputAssetQualityScore,
    costScore,
    totalScoreCap: config.totalScoreCap,
  });

  return {
    stablecoinId,
    routeFamily: config.routeFamily,
    capacityConfidence: resolveCapacityConfidence(config.capacityModel),
    feeConfidence: resolveFeeConfidence(config.costModel),
    feeModelKind: resolveFeeModelKind(config.costModel),
    immediateCapacityUsd,
    immediateCapacityRatio,
    accessScore,
    settlementScore,
    executionCertaintyScore,
    capacityScore: capacity.score,
    coverageRatioScore: capacity.coverageRatioScore,
    absoluteCapacityScore: capacity.absoluteCapacityScore,
    outputAssetQualityScore,
    costScore,
    score: score.score,
    capsApplied: score.capsApplied,
    notes: [...(config.notes ?? [])],
    sourceReferences: (config.docs ?? []).map((doc) => doc.url).sort(),
  };
}

function resolveStaticCapacityRatio(config: RedemptionBackstopConfig): number | null {
  switch (config.capacityModel.kind) {
    case "supply-full":
      return 1;
    case "supply-ratio":
      return config.capacityModel.ratio;
    case "reserve-sync-metadata":
      return config.capacityModel.fallbackRatio ?? null;
  }
  return null;
}


function compareSnapshots(beforePath: string, afterPath: string): string[] {
  const before = toSemanticSnapshot(readJson(beforePath));
  const after = toSemanticSnapshot(readJson(afterPath));
  return [
    ...compareSection("registry", before.registry, after.registry),
    ...compareSection("staticScores", before.staticScores, after.staticScores),
  ];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
}

function writeJson(path: string, value: unknown): void {
  const resolved = resolve(ROOT, path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortObject(item)]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function toSemanticSnapshot(value: unknown): ParitySnapshot {
  const raw = value as Partial<ParitySnapshot>;
  return {
    registry: normalizeRows(raw.registry, SEMANTIC_REGISTRY_FIELDS),
    staticScores: normalizeRows(raw.staticScores, SEMANTIC_STATIC_SCORE_FIELDS),
  };
}

function normalizeRows<T extends readonly string[]>(value: unknown, fields: T): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => pickFields(row, fields));
}

function pickFields<T extends readonly string[]>(value: unknown, fields: T): Record<T[number], unknown> {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(fields.map((field) => [field, sortObject(raw[field])])) as Record<T[number], unknown>;
}

function compareSection(section: string, beforeRows: unknown[], afterRows: unknown[]): string[] {
  const beforeById = rowsByStablecoinId(beforeRows);
  const afterById = rowsByStablecoinId(afterRows);
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();
  const diffs: string[] = [];

  for (const id of ids) {
    const before = beforeById.get(id);
    const after = afterById.get(id);
    if (!before) {
      diffs.push(`${section}.${id}: added`);
      continue;
    }
    if (!after) {
      diffs.push(`${section}.${id}: removed`);
      continue;
    }

    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const field of fields) {
      const beforeValue = stableStringify(before[field]);
      const afterValue = stableStringify(after[field]);
      if (beforeValue !== afterValue) {
        diffs.push(`${section}.${id}.${field}: ${beforeValue} -> ${afterValue}`);
      }
    }
  }

  return diffs;
}

function rowsByStablecoinId(rows: unknown[]): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const stablecoinId = (row as Record<string, unknown>).stablecoinId;
    if (typeof stablecoinId === "string" && stablecoinId.length > 0) {
      result.set(stablecoinId, row as Record<string, unknown>);
    }
  }
  return result;
}

const [command, ...args] = process.argv.slice(2);
if (command === "--snapshot" && args[0]) {
  writeJson(args[0], buildSnapshot());
} else if (command === "--compare" && args[0] && args[1]) {
  const diffs = compareSnapshots(args[0], args[1]);
  if (diffs.length > 0) {
    for (const diff of diffs) {
      console.error(diff);
    }
    process.exit(1);
  }
  console.log("Redemption registry parity snapshots match.");
} else {
  console.error("Usage: tsx scripts/maintenance/audit-redemption-registry-parity.ts --snapshot <path>");
  console.error("   or: tsx scripts/maintenance/audit-redemption-registry-parity.ts --compare <before.json> <after.json>");
  process.exit(1);
}

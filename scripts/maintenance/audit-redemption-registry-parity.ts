#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";
import { readJsonFile } from "../lib/catalog-json";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = process.cwd();

interface ParitySnapshot {
  registry: unknown[];
}

export function buildSnapshot(
  configs: Readonly<Record<string, RedemptionBackstopConfig>> = REDEMPTION_BACKSTOP_CONFIGS,
): ParitySnapshot {
  return {
    registry: Object.keys(configs).sort().map((stablecoinId) => sortObject({
      ...configs[stablecoinId],
      stablecoinId,
    })),
  };
}



export function compareSnapshots(beforePath: string, afterPath: string): string[] {
  const before = readJsonFile(resolve(ROOT, beforePath)) as ParitySnapshot;
  const after = readJsonFile(resolve(ROOT, afterPath)) as ParitySnapshot;
  return compareSection("registry", before.registry, after.registry);
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

if (isDirectRun(import.meta.url, process.argv[1])) {
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
}

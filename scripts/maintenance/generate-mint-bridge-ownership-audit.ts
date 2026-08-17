#!/usr/bin/env tsx

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StablecoinMeta } from "@shared/types";
import {
  STABLECOIN_SOURCE_DOMAIN_FIELDS,
  STABLECOIN_SOURCE_DOMAIN_VALUES,
} from "@shared/lib/stablecoins/schema";
import {
  validateMintBridgeOwnership,
  type MintBridgeOwnershipViolation,
} from "@shared/lib/stablecoins/mint-bridge-ownership";

const COINS_DIR = join(process.cwd(), "shared/data/stablecoins/coins");
const DOMAINS_DIR = join(process.cwd(), "shared/data/stablecoins/domains");

interface AssetAudit {
  assetId: string;
  violations: MintBridgeOwnershipViolation[];
}

interface AuditReport {
  totalAssets: number;
  totalViolations: number;
  assets: AssetAudit[];
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function loadSidecarPatches(): Map<string, Record<string, unknown>> {
  const patches = new Map<string, Record<string, unknown>>();

  for (const domain of STABLECOIN_SOURCE_DOMAIN_VALUES) {
    const domainDir = join(DOMAINS_DIR, domain);
    let files: string[];
    try {
      files = readdirSync(domainDir).filter((file) => file.endsWith(".json"));
    } catch {
      continue;
    }

    for (const file of files) {
      const raw = readJson(join(domainDir, file));
      const id = typeof raw.id === "string" ? raw.id : file.slice(0, -".json".length);
      const patch = patches.get(id) ?? {};
      for (const field of STABLECOIN_SOURCE_DOMAIN_FIELDS[domain]) {
        if (Object.prototype.hasOwnProperty.call(raw, field)) {
          patch[String(field)] = raw[field];
        }
      }
      patches.set(id, patch);
    }
  }

  return patches;
}

function loadMergedAssets(): StablecoinMeta[] {
  const patches = loadSidecarPatches();
  return readdirSync(COINS_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))
    .map((file) => {
      const raw = readJson(join(COINS_DIR, file));
      const id = typeof raw.id === "string" ? raw.id : file.slice(0, -".json".length);
      return { ...raw, ...(patches.get(id) ?? {}) } as unknown as StablecoinMeta;
    });
}

function buildReport(): AuditReport {
  const assets = loadMergedAssets()
    .map((meta) => ({ assetId: meta.id, violations: validateMintBridgeOwnership(meta) }))
    .filter((asset) => asset.violations.length > 0)
    .sort((left, right) => left.assetId.localeCompare(right.assetId));

  return {
    totalAssets: assets.length,
    totalViolations: assets.reduce((total, asset) => total + asset.violations.length, 0),
    assets,
  };
}

function renderText(report: AuditReport): string {
  const lines = [
    `[audit:mint-bridge-ownership] ${report.totalViolations} violation(s) across ${report.totalAssets} asset(s)`,
  ];

  for (const asset of report.assets) {
    lines.push(`\n${asset.assetId}`);
    for (const violation of asset.violations) {
      lines.push(`  - [${violation.severity}] ${violation.code} ${violation.path}: ${violation.message}`);
    }
  }

  if (report.totalViolations === 0) lines.push("\nNo mint/bridge ownership violations found.");
  return `${lines.join("\n")}\n`;
}

function main(argv: readonly string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("Usage: tsx scripts/maintenance/generate-mint-bridge-ownership-audit.ts [--json]\n");
    return 0;
  }

  const json = argv.includes("--json");
  const report = buildReport();
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`[audit:mint-bridge-ownership] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 0;
}

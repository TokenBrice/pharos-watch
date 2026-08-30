#!/usr/bin/env tsx

import {
  validateMintBridgeOwnership,
  type MintBridgeOwnershipViolation,
} from "@shared/lib/stablecoins/mint-bridge-ownership";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";

interface AssetAudit {
  assetId: string;
  violations: MintBridgeOwnershipViolation[];
}

interface AuditReport {
  totalAssets: number;
  totalViolations: number;
  assets: AssetAudit[];
}

function buildReport(): AuditReport {
  const assets = loadPerCoinStablecoinEntries()
    .map(({ coin }) => ({ assetId: coin.id, violations: validateMintBridgeOwnership(coin) }))
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

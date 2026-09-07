#!/usr/bin/env node

/**
 * Flag persisted `dex_deployment_outcomes` rows whose provider set contradicts
 * the live discovery registry.
 *
 * A census row's `provider_set_json` is a snapshot of a registry fact. An empty
 * set means "no registered token-pool provider supported this chain when the row
 * was written". Once discovery coverage for that chain ships, the row keeps
 * asserting the old scope limit until the windowed crawl rotates back to that
 * deployment — days for a many-chain footprint. `classifyDexPlaceholderCoverage`
 * no longer publishes such a row as an unsupported method (it is superseded
 * evidence), but the contradicted row itself is still a stale artifact worth
 * surfacing: it is the signal that a newly registered provider has not yet been
 * exercised against a deployment.
 *
 * The census lives in production D1, so this check reads a dump instead of the
 * database:
 *
 *   cd worker && npx wrangler d1 execute stablecoin-db --remote --json \
 *     --command "SELECT stablecoin_id, chain, contract_address, outcome, \
 *       provider_set_json, reason, observed_at FROM dex_deployment_outcomes" \
 *     > /tmp/dex-census.json
 *   npm run check:dex-census-provider-drift -- --rows=/tmp/dex-census.json
 */

import { readFileSync } from "node:fs";
import { getDexDiscoveryProviders } from "@shared/lib/dex-deployment-coverage";
import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { isRecord } from "@shared/lib/type-guards";
import {
  parseStrictCliArgs,
  requireCliString,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { reportViolations } from "../lib/report-violations.mts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const USAGE: string = `Usage: npm run check:dex-census-provider-drift -- --rows=<dump.json>

Flags dex_deployment_outcomes rows that persist an empty provider set while
getDexDiscoveryProviders() resolves at least one provider for the deployment.

Options:
      --rows   Path to a wrangler "d1 execute --json" dump (or a bare JSON array)
      --json   Print the findings as JSON instead of a report
  -h, --help   Show this help`;

export interface DexCensusProviderRow {
  stablecoinId: string;
  chain: string;
  address: string;
  outcome: string;
  reason: string;
  observedAt: number | null;
  persistedProviders: readonly string[] | null;
}

export interface DexCensusProviderDrift {
  stablecoinId: string;
  chain: string;
  address: string;
  outcome: string;
  reason: string;
  observedAt: number | null;
  liveProviders: readonly string[];
}

export interface DexCensusProviderDriftReport {
  scannedRowCount: number;
  trackedRowCount: number;
  drift: DexCensusProviderDrift[];
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

/** Accept both a wrangler `--json` envelope and a bare row array. */
export function extractCensusRows(payload: unknown): DexCensusProviderRow[] {
  const candidates: unknown[] = Array.isArray(payload)
    ? payload.flatMap((entry) =>
        isRecord(entry) && Array.isArray(entry.results) ? entry.results : [entry],
      )
    : isRecord(payload) && Array.isArray(payload.results)
      ? payload.results
      : [];

  const rows: DexCensusProviderRow[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const stablecoinId = stringField(candidate, "stablecoin_id");
    const chain = stringField(candidate, "chain");
    const address = stringField(candidate, "contract_address");
    if (!stablecoinId || !chain || !address) continue;
    let persistedProviders: string[] | null = null;
    try {
      const parsed: unknown = JSON.parse(stringField(candidate, "provider_set_json"));
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
        persistedProviders = parsed;
      }
    } catch {
      persistedProviders = null;
    }
    const observedAt = candidate.observed_at;
    rows.push({
      stablecoinId,
      chain,
      address,
      outcome: stringField(candidate, "outcome"),
      reason: stringField(candidate, "reason"),
      observedAt: typeof observedAt === "number" ? observedAt : null,
      persistedProviders,
    });
  }
  return rows;
}

function trackedDeploymentKeys(): Set<string> {
  const keys = new Set<string>();
  for (const meta of ACTIVE_STABLECOINS) {
    for (const deployment of [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])]) {
      keys.add(`${meta.id}|${canonicalExitRouteAssetKey(deployment.chain, deployment.address)}`);
    }
  }
  return keys;
}

/**
 * A row drifts when it persists an empty provider set for a deployment the
 * registry covers today. Rows for deployments that are no longer tracked are
 * orphans that never reach a published census, so they are counted but never
 * reported.
 */
export function findDexCensusProviderDrift(
  rows: readonly DexCensusProviderRow[],
  trackedKeys: ReadonlySet<string> = trackedDeploymentKeys(),
): DexCensusProviderDriftReport {
  const drift: DexCensusProviderDrift[] = [];
  let trackedRowCount = 0;
  for (const row of rows) {
    const key = `${row.stablecoinId}|${canonicalExitRouteAssetKey(row.chain, row.address)}`;
    if (!trackedKeys.has(key)) continue;
    trackedRowCount++;
    if (row.persistedProviders == null || row.persistedProviders.length > 0) continue;
    const liveProviders = getDexDiscoveryProviders(row.chain, row.address);
    if (liveProviders.length === 0) continue;
    drift.push({
      stablecoinId: row.stablecoinId,
      chain: row.chain,
      address: row.address,
      outcome: row.outcome,
      reason: row.reason,
      observedAt: row.observedAt,
      liveProviders,
    });
  }
  drift.sort(
    (left, right) =>
      left.stablecoinId.localeCompare(right.stablecoinId) || left.chain.localeCompare(right.chain),
  );
  return { scannedRowCount: rows.length, trackedRowCount, drift };
}

export function formatDrift(entry: DexCensusProviderDrift): string {
  const observed = entry.observedAt == null ? "unknown" : new Date(entry.observedAt * 1000).toISOString();
  return `${entry.stablecoinId} ${entry.chain}:${entry.address} persists [] while the registry resolves [${entry.liveProviders.join(", ")}] (outcome=${entry.outcome}, observedAt=${observed})`;
}

export function runDexCensusProviderDriftCheck(
  argv: readonly string[] = process.argv.slice(2),
): number {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      rows: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return 0;

  const rowsPath = requireCliString(values.rows, "--rows");
  const report = findDexCensusProviderDrift(
    extractCensusRows(JSON.parse(readFileSync(rowsPath, "utf8")) as unknown),
  );

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.drift.length > 0 ? 1 : 0;
  }

  return reportViolations({
    label: "dex census provider drift",
    heading: "Census rows contradicted by the live discovery registry",
    violations: report.drift.map((entry) => formatDrift(entry)),
    hint: "Each row was written before its chain gained discovery coverage. The windowed crawl overwrites it on its next rotation; delete the row to force an immediate re-census.",
    scannedCount: report.trackedRowCount,
  });
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(
    () => {
      process.exitCode = runDexCensusProviderDriftCheck();
    },
    { label: "dex-census-provider-drift", usage: USAGE },
  );
}

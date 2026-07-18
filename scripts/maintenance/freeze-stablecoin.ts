#!/usr/bin/env tsx
/**
 * Freeze a tracked stablecoin: capture its current peggedAssets row,
 * compute peakMcap from supply_history, and print the JSON edits the
 * operator must paste into the registry source files.
 *
 * Usage:
 *   PHAROS_API_KEY=... npx tsx scripts/maintenance/freeze-stablecoin.ts <coinId>
 *
 * Inputs:
 *   - <coinId>: must already exist in shared/data/stablecoins/coins/*.json
 *   - $PHAROS_API_KEY: required to call api.pharos.watch
 *
 * Outputs (printed to stdout):
 *   - The full JSON entry to append to shared/data/stablecoins/frozen-snapshots.json
 *   - The patch to apply to the coin's existing per-coin registry entry:
 *     set status=frozen, frozenAt, and an obituary skeleton.
 *
 * The operator finalizes the obituary copy (causeOfDeath, deathDate,
 * epitaph, obituary, sourceUrl, sourceLabel) by hand and reviews the diff.
 */
import process from "node:process";
import {
  assertCliUsage,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const API_BASE = process.env.PHAROS_API_BASE ?? "https://api.pharos.watch/api";
const USAGE = `Usage: npx tsx scripts/maintenance/freeze-stablecoin.ts [options] <coinId>

Options:
  --dry-run     Explicitly mark this read-only plan generation as a preview
  -h, --help    Show this help`;

export interface FreezeStablecoinCliOptions {
  coinId: string;
  dryRun: boolean;
  help: boolean;
}

export function parseFreezeStablecoinArgs(argv: string[]): FreezeStablecoinCliOptions {
  const { positionals, values } = parseStrictCliArgs(argv, {
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
    },
  });
  const help = values.help === true;
  if (!help) {
    assertCliUsage(positionals.length === 1, "exactly one <coinId> positional argument is required");
  }
  return {
    coinId: positionals[0] ?? "",
    dryRun: values["dry-run"] === true,
    help,
  };
}

interface BuildFreezePlanInput {
  coinId: string;
  peakMcap: number;
  peggedAssetRow: Record<string, unknown> & { id: string };
  frozenAt: string;
  capturedAt: string;
}

export interface FreezePlan {
  frozenSnapshotsEntry: {
    id: string;
    capturedAt: string;
    peggedAssetRow: Record<string, unknown> & { id: string };
  };
  metaPatch: {
    status: "frozen";
    frozenAt: string;
    obituary: {
      causeOfDeath: "TBD";
      deathDate: string;
      epitaph: string;
      obituary: string;
      peakMcap: number;
      sourceUrl: string;
      sourceLabel: string;
    };
  };
}

export function buildFreezePlan(input: BuildFreezePlanInput): FreezePlan {
  return {
    frozenSnapshotsEntry: {
      id: input.coinId,
      capturedAt: input.capturedAt,
      peggedAssetRow: input.peggedAssetRow,
    },
    metaPatch: {
      status: "frozen",
      frozenAt: input.frozenAt,
      obituary: {
        causeOfDeath: "TBD",
        deathDate: input.frozenAt.slice(0, 7),
        epitaph: "<one-line headline — replace before commit>",
        obituary: "<full paragraph — replace before commit>",
        peakMcap: input.peakMcap,
        sourceUrl: "<source URL — replace before commit>",
        sourceLabel: "<source label — replace before commit>",
      },
    },
  };
}

async function fetchPeggedAssetRow(coinId: string): Promise<Record<string, unknown> & { id: string }> {
  const apiKey = process.env.PHAROS_API_KEY;
  if (!apiKey) throw new Error("PHAROS_API_KEY env var required");
  const res = await fetch(`${API_BASE}/stablecoins`, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) throw new Error(`/api/stablecoins returned ${res.status}`);
  const body = (await res.json()) as { peggedAssets?: Array<Record<string, unknown> & { id?: unknown }> };
  const row = (body.peggedAssets ?? []).find((a) => String(a.id) === coinId);
  if (!row) throw new Error(`coin ${coinId} not found in /api/stablecoins payload`);
  return row as Record<string, unknown> & { id: string };
}

async function fetchPeakMcap(coinId: string): Promise<number> {
  const apiKey = process.env.PHAROS_API_KEY;
  if (!apiKey) throw new Error("PHAROS_API_KEY env var required");
  const res = await fetch(`${API_BASE}/supply-history?stablecoin=${coinId}&days=1825`, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) throw new Error(`/api/supply-history returned ${res.status}`);
  const body = (await res.json()) as
    | Array<{ circulatingUsd?: number | null }>
    | { history?: Array<{ circulatingUsd?: number | null }> };
  const rows = Array.isArray(body) ? body : body.history ?? [];
  const max = Math.max(...rows.map((p) => p.circulatingUsd ?? 0));
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error(`unable to compute peakMcap from supply-history for ${coinId}`);
  }
  return Math.round(max);
}

export async function runFreezeStablecoin(argv = process.argv.slice(2)) {
  const options = parseFreezeStablecoinArgs(argv);
  if (writeCliHelpIfRequested(options, USAGE)) return;
  const { coinId } = options;
  const today = new Date();
  const frozenAt = today.toISOString().slice(0, 10);
  const capturedAt = today.toISOString();

  if (options.dryRun) console.log("Dry run: generating a read-only freeze plan.");
  console.log(`Fetching peggedAssets row for ${coinId}…`);
  const peggedAssetRow = await fetchPeggedAssetRow(coinId);
  console.log(`Computing peakMcap from supply-history…`);
  const peakMcap = await fetchPeakMcap(coinId);
  console.log(`peakMcap = $${peakMcap.toLocaleString()}`);

  const plan = buildFreezePlan({ coinId, peakMcap, peggedAssetRow, frozenAt, capturedAt });

  console.log("\n=== APPEND THIS ENTRY TO shared/data/stablecoins/frozen-snapshots.json ===\n");
  console.log(JSON.stringify(plan.frozenSnapshotsEntry, null, 2));
  console.log("\n=== APPLY THIS PATCH TO THE COIN'S EXISTING REGISTRY ENTRY ===\n");
  console.log("// Add these top-level fields (alongside id, name, symbol, …):");
  console.log(JSON.stringify(plan.metaPatch, null, 2));
  console.log("\nIMPORTANT: 'causeOfDeath: \"TBD\"' is NOT a valid enum value.");
  console.log("Replace with one of: algorithmic-failure, counterparty-failure, liquidity-drain, regulatory, abandoned.");
  console.log("Other placeholder strings (epitaph, obituary, sourceUrl, sourceLabel) must also be replaced.");
  console.log("Run `npm run check:frozen-invariants` after edits to validate.");
  console.log("\nSee docs/freezing-stablecoins.md for the full procedure.");
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runFreezeStablecoin(), {
    label: "freeze-stablecoin",
    usage: USAGE,
  });
}

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
 * When /api/stablecoins no longer serves the coin, the snapshot is built from
 * its last observed /api/supply-history row plus registry identity instead:
 * supply is the observed row, price stays unavailable, and the captured
 * `capturedAt` is that observation date rather than the freeze run clock.
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
import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
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

interface SupplyHistoryPoint {
  date: number;
  circulatingUsd?: number | null;
}

/** Registry identity copied onto a snapshot row when the live payload has none. */
export interface FrozenSnapshotIdentity {
  name: string;
  symbol: string;
  backing: string;
  pegCurrency: string;
}

export interface SupplyHistorySnapshot {
  capturedAt: string;
  peakMcap: number;
  peggedAssetRow: Record<string, unknown> & { id: string };
}

function peakCirculatingUsd(points: readonly SupplyHistoryPoint[]): number {
  return points.reduce((peak, point) => Math.max(peak, point.circulatingUsd ?? 0), Number.NEGATIVE_INFINITY);
}

/**
 * Snapshot for a coin the live list no longer serves: identity and peg type come from the registry,
 * supply from its newest observed supply-history row. Price is not observed here, so it stays null
 * with the `missing` source; `capturedAt` is that observation date, never the freeze run clock.
 */
export function buildSupplyHistorySnapshot(input: {
  coinId: string;
  identity: FrozenSnapshotIdentity;
  points: readonly SupplyHistoryPoint[];
}): SupplyHistorySnapshot {
  const { coinId, identity, points } = input;
  const pegType = pegTypeFromCurrency(identity.pegCurrency);
  if (!pegType) {
    throw new Error(`cannot derive a peg type from registry pegCurrency "${identity.pegCurrency}" for ${coinId}`);
  }
  const peakMcap = Math.round(peakCirculatingUsd(points));
  if (!Number.isFinite(peakMcap) || peakMcap <= 0) {
    throw new Error(`unable to compute peakMcap from supply-history for ${coinId}`);
  }
  const latest = points.reduce<SupplyHistoryPoint | null>(
    (last, point) => (last === null || point.date > last.date ? point : last),
    null,
  );
  if (latest === null) throw new Error(`no supply-history rows for ${coinId}`);
  const circulatingUsd = latest.circulatingUsd;
  if (typeof circulatingUsd !== "number" || !Number.isFinite(circulatingUsd) || circulatingUsd < 0) {
    throw new Error(`no observed circulatingUsd in the latest supply-history row for ${coinId}`);
  }
  return {
    capturedAt: new Date(latest.date * 1000).toISOString(),
    peakMcap,
    peggedAssetRow: {
      id: coinId,
      name: identity.name,
      symbol: identity.symbol,
      pegType,
      pegMechanism: identity.backing,
      price: null,
      priceSource: "missing",
      supplySource: "supply-history",
      circulating: { [pegType]: circulatingUsd },
      circulatingPrevDay: {},
      circulatingPrevWeek: {},
      circulatingPrevMonth: {},
      chainCirculating: {},
      chains: [],
    },
  };
}

async function fetchPeggedAssetRow(coinId: string): Promise<Record<string, unknown> & { id: string } | null> {
  const apiKey = process.env.PHAROS_API_KEY;
  if (!apiKey) throw new Error("PHAROS_API_KEY env var required");
  const res = await fetch(`${API_BASE}/stablecoins`, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) throw new Error(`/api/stablecoins returned ${res.status}`);
  const body = (await res.json()) as { peggedAssets?: Array<Record<string, unknown> & { id?: unknown }> };
  const row = (body.peggedAssets ?? []).find((a) => String(a.id) === coinId);
  if (!row) return null;
  return row as Record<string, unknown> & { id: string };
}

async function fetchSupplyHistory(coinId: string, query: string): Promise<SupplyHistoryPoint[]> {
  const apiKey = process.env.PHAROS_API_KEY;
  if (!apiKey) throw new Error("PHAROS_API_KEY env var required");
  const res = await fetch(`${API_BASE}/supply-history?stablecoin=${coinId}&${query}`, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) throw new Error(`/api/supply-history returned ${res.status}`);
  const body = (await res.json()) as SupplyHistoryPoint[] | { history?: SupplyHistoryPoint[] };
  return Array.isArray(body) ? body : body.history ?? [];
}

async function fetchPeakMcap(coinId: string): Promise<number> {
  const max = peakCirculatingUsd(await fetchSupplyHistory(coinId, "days=1825"));
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
  const liveRow = await fetchPeggedAssetRow(coinId);
  let peggedAssetRow: Record<string, unknown> & { id: string };
  let snapshotCapturedAt: string;
  let peakMcap: number;
  if (liveRow) {
    console.log(`Computing peakMcap from supply-history…`);
    peggedAssetRow = liveRow;
    snapshotCapturedAt = capturedAt;
    peakMcap = await fetchPeakMcap(coinId);
  } else {
    const meta = TRACKED_META_BY_ID.get(coinId);
    if (!meta) throw new Error(`coin ${coinId} is missing from /api/stablecoins and the stablecoin registry`);
    console.log(`No /api/stablecoins row for ${coinId}; building the snapshot from its last observed supply-history point.`);
    console.log(`Computing peakMcap from supply-history…`);
    const snapshot = buildSupplyHistorySnapshot({
      coinId,
      identity: {
        name: meta.name,
        symbol: meta.symbol,
        backing: meta.flags.backing,
        pegCurrency: meta.flags.pegCurrency,
      },
      points: await fetchSupplyHistory(coinId, "range=all"),
    });
    peggedAssetRow = snapshot.peggedAssetRow;
    snapshotCapturedAt = snapshot.capturedAt;
    peakMcap = snapshot.peakMcap;
  }
  console.log(`peakMcap = $${peakMcap.toLocaleString()}`);
  if (!liveRow) {
    console.log(`Fallback snapshot: supply observed ${snapshotCapturedAt} from /api/supply-history; price unavailable.`);
  }

  const plan = buildFreezePlan({ coinId, peakMcap, peggedAssetRow, frozenAt, capturedAt: snapshotCapturedAt });

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

import type { D1Database } from "@shared/types/cloudflare-runtime";
import { getCache, setCache } from "../db-cache";
import { toErrorMessage } from "@shared/lib/error-utils";
import { RPC_PARITY_TARGETS } from "./targets";
import type {
  RpcParityChainSample,
  RpcParityComparatorRef,
  RpcParityErrorClass,
  RpcParityRunSamples,
} from "./types";

/**
 * Storage for the Dwellir parity window.
 *
 * One versioned cache row holds the last seven days of runs. Samples are stored
 * in a compact wire form (fixed-arity tuples, base36 heights) because the row
 * must stay well under the 256 KB cache-row budget while still naming, for every
 * stored sample, the operators that were read and the block they were read at
 * (ADR-33). The row is self-describing: samples index into the chain table
 * stored beside them, so an append-only target-table change keeps older samples
 * attributable while a reorder resets the window instead of misattributing it.
 */

export const RPC_PARITY_STORE_KEY = "rpc:provider-parity:dwellir:v1";
const RPC_PARITY_STORE_VERSION = 1;
export const RPC_PARITY_RETENTION_SEC = 7 * 86_400;
export const RPC_PARITY_RETENTION_RUNS = 168;
/** Hard ceiling for the serialized row: bounded well under the 256 KB cache-row budget. */
export const RPC_PARITY_MAX_ROW_BYTES = 176 * 1024;

/** Fixed error-class vocabulary; the wire form stores the index. */
const RPC_PARITY_ERROR_CLASSES: readonly RpcParityErrorClass[] = [
  "range-cap",
  "result-cap",
  "rate-limited",
  "capability",
  "server-error",
  "timeout",
  "network",
  "rpc-error",
  "invalid-response",
];

const FLAG_HEAD_OK = 1;
const FLAG_COMPARATOR_HEAD_OK = 2;
const FLAG_STATE_CHECKED = 4;
const FLAG_STATE_MATCHED = 8;
const FLAG_LOG_CHECKED = 16;
const FLAG_LOG_MATCHED = 32;
const FLAG_PRUNED_CHECKED = 64;
const FLAG_PRUNED_TRAP = 128;

export interface RpcParityLatestState {
  atSec: number;
  dwellirHead: number | null;
  comparatorHead: number | null;
  commonBlock: number | null;
}

export interface RpcParityStoredRun {
  atSec: number;
  samples: RpcParityChainSample[];
}

/** Decoded row: what the report reads. */
export interface RpcParityStoreRow {
  chains: string[];
  comparators: RpcParityComparatorRef[];
  dwellirHosts: string[];
  runs: RpcParityStoredRun[];
  latest: Record<string, RpcParityLatestState>;
}

const SAMPLE_FIELD_SEPARATOR = "|";
const SAMPLE_SEPARATOR = ";";
const SAMPLE_FIELD_COUNT = 9;

interface RpcParityWireRow {
  v: number;
  chains: string[];
  comparators: [string, string, string][];
  hosts: string[];
  /** `[atSec, "<chainIdx>|<flags>|...;<chainIdx>|<flags>|..."[]]` — a fixed-arity field list per sample. */
  runs: [number, string][];
  latest: Record<string, [number, number | null, number | null, number | null]>;
}

function encodeSample(
  sample: RpcParityChainSample,
  chainIndex: number,
  comparators: RpcParityComparatorRef[],
  hosts: string[],
): string {
  let comparatorIndex = comparators.findIndex((candidate) => sameComparator(candidate, sample.comparator));
  if (comparatorIndex === -1) {
    comparators.push(sample.comparator);
    comparatorIndex = comparators.length - 1;
  }
  let hostIndex = hosts.indexOf(sample.dwellirHost);
  if (hostIndex === -1) {
    hosts.push(sample.dwellirHost);
    hostIndex = hosts.length - 1;
  }
  const flags =
    (sample.headOk ? FLAG_HEAD_OK : 0)
    | (sample.comparatorHeadOk ? FLAG_COMPARATOR_HEAD_OK : 0)
    | (sample.stateChecked ? FLAG_STATE_CHECKED : 0)
    | (sample.stateMatched ? FLAG_STATE_MATCHED : 0)
    | (sample.logChecked ? FLAG_LOG_CHECKED : 0)
    | (sample.logMatched ? FLAG_LOG_MATCHED : 0)
    | (sample.prunedLogChecked ? FLAG_PRUNED_CHECKED : 0)
    | (sample.prunedLogTrap ? FLAG_PRUNED_TRAP : 0);
  const errorCode = sample.errorClass ? RPC_PARITY_ERROR_CLASSES.indexOf(sample.errorClass) + 1 : 0;
  return [
    chainIndex,
    flags,
    sample.commonBlock === null ? "" : sample.commonBlock.toString(36),
    sample.lagBlocks === null ? "" : sample.lagBlocks,
    sample.dwellirLatencyMs === null ? "" : sample.dwellirLatencyMs,
    sample.comparatorLatencyMs === null ? "" : sample.comparatorLatencyMs,
    errorCode,
    comparatorIndex,
    hostIndex,
  ].join(SAMPLE_FIELD_SEPARATOR);
}

function readWireNumber(field: string | undefined): number | null {
  if (field == null || field === "") return null;
  const parsed = Number(field);
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeSample(
  wire: string,
  chains: string[],
  comparators: RpcParityComparatorRef[],
  hosts: string[],
): RpcParityChainSample | null {
  const fields = wire.split(SAMPLE_FIELD_SEPARATOR);
  if (fields.length !== SAMPLE_FIELD_COUNT) return null;
  const chainIndex = readWireNumber(fields[0]);
  const flags = readWireNumber(fields[1]);
  const errorCode = readWireNumber(fields[6]);
  const comparatorIndex = readWireNumber(fields[7]);
  const hostIndex = readWireNumber(fields[8]);
  if (chainIndex === null || flags === null || errorCode === null || comparatorIndex === null || hostIndex === null) {
    return null;
  }
  const chainId = chains[chainIndex];
  const comparator = comparators[comparatorIndex];
  const dwellirHost = hosts[hostIndex];
  if (typeof chainId !== "string" || !comparator || typeof dwellirHost !== "string") return null;
  const commonBlockField = fields[2];
  const parsedCommonBlock = commonBlockField ? Number.parseInt(commonBlockField, 36) : null;
  const commonBlock = parsedCommonBlock !== null && Number.isSafeInteger(parsedCommonBlock) ? parsedCommonBlock : null;
  const errorClass = errorCode > 0 ? RPC_PARITY_ERROR_CLASSES[errorCode - 1] ?? null : null;
  return {
    chainId,
    comparator,
    dwellirHost,
    headOk: (flags & FLAG_HEAD_OK) !== 0,
    comparatorHeadOk: (flags & FLAG_COMPARATOR_HEAD_OK) !== 0,
    comparatorHead: null,
    dwellirHead: null,
    commonBlock,
    lagBlocks: readWireNumber(fields[3]),
    stateChecked: (flags & FLAG_STATE_CHECKED) !== 0,
    stateMatched: (flags & FLAG_STATE_MATCHED) !== 0,
    logChecked: (flags & FLAG_LOG_CHECKED) !== 0,
    logMatched: (flags & FLAG_LOG_MATCHED) !== 0,
    prunedLogChecked: (flags & FLAG_PRUNED_CHECKED) !== 0,
    prunedLogTrap: (flags & FLAG_PRUNED_TRAP) !== 0,
    dwellirLatencyMs: readWireNumber(fields[4]),
    comparatorLatencyMs: readWireNumber(fields[5]),
    errorClass,
  };
}

function sameComparator(left: RpcParityComparatorRef, right: RpcParityComparatorRef): boolean {
  return left.operator === right.operator && left.host === right.host && left.source === right.source;
}

export function encodeRpcParityStoreRow(row: RpcParityStoreRow): string {
  const comparators: RpcParityComparatorRef[] = [...row.comparators];
  const hosts: string[] = [...row.dwellirHosts];
  const chains = [...row.chains];
  const runs: [number, string][] = row.runs.map((run) => [
    run.atSec,
    run.samples
      .flatMap((sample) => {
        const chainIndex = chains.indexOf(sample.chainId);
        if (chainIndex === -1) return [];
        return [encodeSample(sample, chainIndex, comparators, hosts)];
      })
      .join(SAMPLE_SEPARATOR),
  ]);
  const latest: RpcParityWireRow["latest"] = {};
  for (const [chainId, state] of Object.entries(row.latest)) {
    latest[chainId] = [state.atSec, state.dwellirHead, state.comparatorHead, state.commonBlock];
  }
  const wire: RpcParityWireRow = {
    v: RPC_PARITY_STORE_VERSION,
    chains,
    comparators: comparators.map((comparator) => [comparator.operator, comparator.host, comparator.source]),
    hosts,
    runs,
    latest,
  };
  return JSON.stringify(wire);
}

/** Decodes a stored row. Returns null for anything whose shape cannot be trusted. */
export function decodeRpcParityStoreRow(value: string): RpcParityStoreRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const wire = parsed as Partial<RpcParityWireRow>;
  if (wire.v !== RPC_PARITY_STORE_VERSION) return null;
  if (!Array.isArray(wire.chains) || !wire.chains.every((chainId) => typeof chainId === "string")) return null;
  if (!Array.isArray(wire.hosts) || !wire.hosts.every((host) => typeof host === "string")) return null;
  if (!Array.isArray(wire.comparators)) return null;
  if (!Array.isArray(wire.runs)) return null;

  const comparators: RpcParityComparatorRef[] = [];
  for (const entry of wire.comparators) {
    if (!Array.isArray(entry) || entry.length !== 3) return null;
    const [operator, host, source] = entry as [unknown, unknown, unknown];
    if (typeof operator !== "string" || typeof host !== "string" || typeof source !== "string") return null;
    if (operator !== "alchemy" && operator !== "drpc" && operator !== "public") return null;
    if (source !== "registry" && source !== "pin") return null;
    comparators.push({ operator, host, source });
  }

  const chains = wire.chains;
  const hosts = wire.hosts;
  const runs: RpcParityStoredRun[] = [];
  for (const run of wire.runs) {
    if (!Array.isArray(run) || run.length !== 2) return null;
    const [atSec, samples] = run;
    if (typeof atSec !== "number" || !Number.isSafeInteger(atSec) || typeof samples !== "string") return null;
    const decoded: RpcParityChainSample[] = [];
    for (const sample of samples === "" ? [] : samples.split(SAMPLE_SEPARATOR)) {
      const value = decodeSample(sample, chains, comparators, hosts);
      if (!value) return null;
      decoded.push(value);
    }
    runs.push({ atSec, samples: decoded });
  }

  const latest: Record<string, RpcParityLatestState> = {};
  const wireLatest = wire.latest;
  if (wireLatest != null) {
    if (typeof wireLatest !== "object" || Array.isArray(wireLatest)) return null;
    for (const [chainId, entry] of Object.entries(wireLatest)) {
      if (!Array.isArray(entry) || entry.length !== 4) return null;
      const [atSec, dwellirHead, comparatorHead, commonBlock] = entry;
      if (typeof atSec !== "number" || !Number.isSafeInteger(atSec)) return null;
      latest[chainId] = {
        atSec,
        dwellirHead: typeof dwellirHead === "number" ? dwellirHead : null,
        comparatorHead: typeof comparatorHead === "number" ? comparatorHead : null,
        commonBlock: typeof commonBlock === "number" ? commonBlock : null,
      };
    }
  }

  return { chains, comparators, dwellirHosts: hosts, runs, latest };
}

export interface RpcParityStoreMerge {
  row: RpcParityStoreRow;
  bytes: number;
  droppedOldest: number;
  reset: boolean;
}

/**
 * Appends one run to the retained window: prunes past the retention window and
 * the run cap, then drops the oldest runs until the serialized row is back under
 * the size bound. The newest run is never dropped.
 */
export function mergeRpcParityRun(
  existing: RpcParityStoreRow | null,
  run: RpcParityRunSamples,
  options: { nowSec: number; maxBytes?: number; retentionRuns?: number },
): RpcParityStoreMerge {
  const maxBytes = options.maxBytes ?? RPC_PARITY_MAX_ROW_BYTES;
  const retentionRuns = options.retentionRuns ?? RPC_PARITY_RETENTION_RUNS;
  const chainOrder = RPC_PARITY_TARGETS.map((target) => target.chainId);
  const windowStartSec = run.atSec - RPC_PARITY_RETENTION_SEC;

  let reset = false;
  const existingChains = existing?.chains ?? null;
  const orderCompatible = existingChains !== null
    && existingChains.every((chainId, index) => chainOrder[index] === chainId);
  // The incoming window is a pure function of the existing row: it copies every
  // retained array before appending, so the caller's row (and any reader holding
  // it) is never mutated by a merge.
  const chains: string[] = existingChains && orderCompatible ? [...existingChains] : [...chainOrder];
  if (existingChains && !orderCompatible) {
    // A removed or reordered target invalidates every retained index.
    reset = true;
  }
  const comparators: RpcParityComparatorRef[] = existing && !reset ? [...existing.comparators] : [];
  const dwellirHosts: string[] = existing && !reset ? [...existing.dwellirHosts] : [];
  const latest: Record<string, RpcParityLatestState> = existing && !reset ? { ...existing.latest } : {};

  const known = new Set(chains);
  const incoming: RpcParityChainSample[] = [];
  for (const sample of run.samples) {
    if (known.has(sample.chainId)) {
      incoming.push(sample);
      continue;
    }
    chains.push(sample.chainId);
    known.add(sample.chainId);
    incoming.push(sample);
  }

  for (const sample of incoming) {
    latest[sample.chainId] = {
      atSec: run.atSec,
      dwellirHead: sample.dwellirHead,
      comparatorHead: sample.comparatorHead,
      commonBlock: sample.commonBlock,
    };
  }

  const retained = (existing && !reset ? existing.runs : [])
    .filter((existingRun) => existingRun.atSec >= windowStartSec && existingRun.atSec !== run.atSec);
  // A duplicate write for the same slot replaces the earlier sample set instead
  // of counting the chain twice in the window.
  const runs: RpcParityStoredRun[] = [...retained, { atSec: run.atSec, samples: incoming }]
    .sort((left, right) => left.atSec - right.atSec)
    .slice(-retentionRuns);

  const row: RpcParityStoreRow = {
    chains,
    comparators,
    dwellirHosts,
    runs,
    latest: Object.fromEntries(
      Object.entries(latest).filter(([, state]) => state.atSec >= windowStartSec),
    ),
  };

  let droppedOldest = 0;
  let bytes = encodeRpcParityStoreRow(row).length;
  while (bytes > maxBytes && row.runs.length > 1) {
    row.runs.shift();
    droppedOldest += 1;
    bytes = encodeRpcParityStoreRow(row).length;
  }
  return { row, bytes, droppedOldest, reset };
}

export interface RpcParityStoreRead {
  row: RpcParityStoreRow | null;
  updatedAtSec: number | null;
  error: string | null;
}

/** Reads the retained window. A missing or unreadable row is reported, never thrown. */
export async function readRpcParityStore(db: D1Database, signal?: AbortSignal): Promise<RpcParityStoreRead> {
  let cached: { value: string; updatedAt: number } | null;
  try {
    cached = await getCache(db, RPC_PARITY_STORE_KEY, signal);
  } catch (error) {
    return { row: null, updatedAtSec: null, error: toErrorMessage(error) };
  }
  if (!cached) return { row: null, updatedAtSec: null, error: null };
  const row = decodeRpcParityStoreRow(cached.value);
  if (!row) {
    return {
      row: null,
      updatedAtSec: cached.updatedAt,
      error: `unreadable ${RPC_PARITY_STORE_KEY} payload`,
    };
  }
  return { row, updatedAtSec: cached.updatedAt, error: null };
}

export interface RpcParityStoreWrite {
  ok: boolean;
  runs: number;
  bytes: number;
  droppedOldest: number;
  reset: boolean;
  error: string | null;
}

/**
 * Persists one run: reads the retained window, appends (pruning on write), and
 * writes it back. Storage failures are returned so the caller can record a
 * degraded run instead of losing it — the probe already measured the provider.
 */
export async function recordRpcParityRun(
  db: D1Database,
  run: RpcParityRunSamples,
  signal?: AbortSignal,
): Promise<RpcParityStoreWrite> {
  const existing = await readRpcParityStore(db, signal);
  const merged = mergeRpcParityRun(existing.row, run, { nowSec: run.atSec });
  try {
    await setCache(db, RPC_PARITY_STORE_KEY, encodeRpcParityStoreRow(merged.row), signal);
  } catch (error) {
    return {
      ok: false,
      runs: merged.row.runs.length,
      bytes: merged.bytes,
      droppedOldest: merged.droppedOldest,
      reset: merged.reset,
      error: toErrorMessage(error),
    };
  }
  const readError = existing.error;
  return {
    ok: readError === null,
    runs: merged.row.runs.length,
    bytes: merged.bytes,
    droppedOldest: merged.droppedOldest,
    reset: merged.reset,
    error: readError,
  };
}

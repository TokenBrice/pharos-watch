import { gzipSync, gunzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import type { D1Database } from "@shared/types/cloudflare-runtime";
import { getCache, setCache } from "../db-cache";
import { toErrorMessage } from "@shared/lib/error-utils";
import { RPC_PARITY_TARGETS } from "./targets";
import type {
  RpcParityChainSample,
  RpcParityComparatorRef,
  RpcParityErrorClass,
  RpcParityProbeStep,
  RpcParityRunSamples,
  RpcParityStepFailures,
} from "./types";
import {
  combineRpcParityLatestFreshness,
  RPC_PARITY_PROBE_STEPS,
  RPC_PARITY_LATEST_MAX_NUMERIC_CALLS,
  RPC_PARITY_MAX_CALLS_PER_OPERATOR,
  RPC_PARITY_SKIP_REASONS,
  RPC_PARITY_LATEST_FRESHNESS_VERDICTS,
  RPC_PARITY_LATEST_FRESHNESS_REASONS,
  RPC_PARITY_LATEST_PROBE_METHODS,
  type RpcParityCallObservation,
  type RpcParityLatestFreshness,
  type RpcParityChainSkip,
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
const RPC_PARITY_STORE_VERSION = 5;
export const RPC_PARITY_RETENTION_SEC = 7 * 86_400;
export const RPC_PARITY_RETENTION_RUNS = 168;
/** Serialized compressed row ceiling; leaves 16 KiB below the cache-row budget. */
export const RPC_PARITY_MAX_ROW_BYTES = 240 * 1024;
/** Bound the uncompressed wire too, so highly compressible proof data stays readable. */
export const RPC_PARITY_MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024;
const RAW_ROW_BUDGET_ERROR = "rpc-parity-raw-row-budget";
/** v5 reads v1–v4; old readers reject its dual freshness provenance.
 * A rollback reader's next write resets history; preserve the row beforehand.
 */

type CallLayout = [number[], number[]];
/** v4 layout bit: this call used the sample's separate logs comparator. */
const CALL_LOGS_COMPARATOR = 128;

function packLatencies(values: number[]): string | number[] {
  // Preserve exact milliseconds, including unexpectedly long/fractional timings.
  if (values.some((value) => !Number.isInteger(value) || value > 8191)) return values;
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const value of values) {
    accumulator |= value << bits;
    bits += 13;
    while (bits >= 8) {
      bytes.push(accumulator & 255);
      accumulator >>>= 8;
      bits -= 8;
    }
  }
  if (bits) bytes.push(accumulator);
  return Buffer.from(bytes).toString("base64");
}

function unpackLatencies(packed: unknown, count: number): number[] | null {
  if (Array.isArray(packed)) {
    return packed.length === count && packed.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
      ? packed : null;
  }
  if (typeof packed !== "string") return null;
  const bytes = Buffer.from(packed, "base64");
  if (bytes.length !== Math.ceil(count * 13 / 8)) return null;
  let accumulator = 0;
  let bits = 0;
  const values: number[] = [];
  for (const byte of bytes) {
    accumulator |= byte << bits;
    bits += 8;
    while (bits >= 13 && values.length < count) {
      values.push(accumulator & 8191);
      accumulator >>>= 13;
      bits -= 13;
    }
  }
  return values.length === count ? values : null;
}
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
  skipped?: RpcParityChainSkip[];
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
/**
 * Layout tag for the optional per-run diagnostics section. A row written by a
 * newer lane version never breaks an older reader: the tag is checked before
 * the entries are interpreted, and an unknown tag is ignored so the samples
 * themselves stay readable.
 */
const DIAGNOSTICS_LAYOUT = "1";
const DIAGNOSTICS_FIELD_COUNT = 4;

/** Step-failure bits, per operator, in the sparse diagnostics section. */
const STEP_FAILURE_BITS: Record<"dwellir" | "comparator", Record<RpcParityProbeStep, number>> = {
  dwellir: { head: 1, state: 2, logs: 4, latest: 64 },
  comparator: { head: 8, state: 16, logs: 32, latest: 128 },
};

function emptyStepFailures(): RpcParityStepFailures {
  return { head: false, state: false, logs: false, latest: false };
}

interface RpcParityWireRow {
  v: number;
  chains: string[];
  comparators: [string, string, string][];
  hosts: string[];
  layouts?: CallLayout[];
  /**
   * `[atSec, "<chainIdx>|<flags>|...;<chainIdx>|<flags>|..."]` — a fixed-arity
   * field list per sample — plus, when a chain (or its comparator) had a failed
   * step, a sparse diagnostics section. Rows written before diagnostics existed
   * are simply two elements long.
   */
  runs: ([number, string] | [number, string, string])[];
  latest: Record<string, [number, number | null, number | null, number | null]>;
  skips?: ([number, number][] | null)[];
}

function encodeCompactFreshness(
  freshness: RpcParityLatestFreshness | null | undefined,
  base: number,
  retainValues: boolean,
): unknown[] | null {
  if (!freshness) return null;
  const fields: unknown[] = [
    RPC_PARITY_LATEST_FRESHNESS_VERDICTS.indexOf(freshness.verdict), RPC_PARITY_LATEST_FRESHNESS_REASONS.indexOf(freshness.reason),
    freshness.headBefore === null ? null : freshness.headBefore - base,
    freshness.headAfter === null ? null : freshness.headAfter - base,
    freshness.matchedBlock === null ? null : freshness.matchedBlock - base,
    retainValues ? freshness.latestValue ?? null : null,
    retainValues ? freshness.numericValues ?? null : null,
    freshness.method === undefined ? null : RPC_PARITY_LATEST_PROBE_METHODS.indexOf(freshness.method),
    freshness.discriminating ?? null,
    freshness.servedBlock == null ? null : freshness.servedBlock - base,
    freshness.lagBlocks ?? null,
    freshness.toleranceBlocks ?? null,
  ];
  if (freshness.call) fields.push(
    freshness.call.to, freshness.call.data,
    freshness.referenceEndBlock == null ? null : freshness.referenceEndBlock - base,
  );
  return fields;
}

function encodeSample(
  sample: RpcParityChainSample,
  chainIndex: number,
  comparators: RpcParityComparatorRef[],
  hosts: string[],
  layouts: CallLayout[],
  previousBlocks: Map<string, number>,
  retainStaleExample: boolean,
): string {
  const comparatorIndex = registerComparator(comparators, sample.comparator);
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
  const blockDelta = sample.commonBlock === null ? null
    : sample.commonBlock - (previousBlocks.get(sample.chainId) ?? 0);
  if (sample.commonBlock !== null) previousBlocks.set(sample.chainId, sample.commonBlock);
  let telemetry = "";
  if (sample.calls || sample.latestFreshness || sample.tokenFreshness || sample.logsComparator !== undefined) {
    const layout: CallLayout = [[], []];
    const latencies: number[] = [];
    for (const [index, operator] of (["dwellir", "comparator"] as const).entries()) {
      const calls = sample.calls?.[operator] ?? [];
      if (calls.length > RPC_PARITY_MAX_CALLS_PER_OPERATOR[operator]) {
        throw new Error(`rpc-parity-call-bound:${operator}`);
      }
      for (const call of calls) {
        const error = call.errorClass ? RPC_PARITY_ERROR_CLASSES.indexOf(call.errorClass) + 1 : 0;
        const separateComparator = operator === "comparator" && call.comparator
          && !sameComparator(call.comparator, sample.comparator);
        if (separateComparator && (!sample.logsComparator || !sameComparator(call.comparator!, sample.logsComparator))) {
          throw new Error("rpc-parity-call-comparator");
        }
        layout[index].push(RPC_PARITY_PROBE_STEPS.indexOf(call.step) * 32 + (call.phase === "warm" ? 16 : 0) + error
          + (separateComparator ? CALL_LOGS_COMPARATOR : 0));
        latencies.push(call.latencyMs);
      }
    }
    const layoutKey = JSON.stringify(layout);
    let layoutIndex = layouts.findIndex((entry) => JSON.stringify(entry) === layoutKey);
    if (layoutIndex === -1) {
      layoutIndex = layouts.length;
      layouts.push(layout);
    }
    const base = sample.commonBlock ?? 0;
    const compactFreshness = sample.tokenFreshness === undefined
      ? encodeCompactFreshness(sample.latestFreshness, base, retainStaleExample)
      : [
        encodeCompactFreshness(sample.sentinelFreshness, base, true),
        encodeCompactFreshness(sample.tokenFreshness, base, true),
      ];
    const data: unknown[] = [layoutIndex, packLatencies(latencies), compactFreshness];
    if (sample.logsComparator !== undefined) {
      data.push(sample.logsComparator === null ? null : registerComparator(comparators, sample.logsComparator));
    }
    telemetry = JSON.stringify(data);
  }
  return [
    chainIndex,
    flags,
    blockDelta === null ? "" : blockDelta.toString(36),
    sample.lagBlocks === null ? "" : sample.lagBlocks,
    sample.calls || sample.dwellirLatencyMs === null ? "" : sample.dwellirLatencyMs,
    sample.calls || sample.comparatorLatencyMs === null ? "" : sample.comparatorLatencyMs,
    errorCode,
    comparatorIndex,
    hostIndex,
    telemetry,
  ].join(SAMPLE_FIELD_SEPARATOR);
}

/**
 * Per-sample diagnostics, written only when something failed, so a healthy run
 * costs nothing in the retained row.
 */
function encodeSampleDiagnostics(sample: RpcParityChainSample, chainIndex: number): string | null {
  const stepMask =
    (sample.failedSteps.dwellir.head ? STEP_FAILURE_BITS.dwellir.head : 0)
    | (sample.failedSteps.dwellir.state ? STEP_FAILURE_BITS.dwellir.state : 0)
    | (sample.failedSteps.dwellir.logs ? STEP_FAILURE_BITS.dwellir.logs : 0)
    | (sample.failedSteps.comparator.head ? STEP_FAILURE_BITS.comparator.head : 0)
    | (sample.failedSteps.comparator.state ? STEP_FAILURE_BITS.comparator.state : 0)
    | (sample.failedSteps.comparator.logs ? STEP_FAILURE_BITS.comparator.logs : 0)
    | (sample.failedSteps.dwellir.latest ? STEP_FAILURE_BITS.dwellir.latest : 0)
    | (sample.failedSteps.comparator.latest ? STEP_FAILURE_BITS.comparator.latest : 0);
  const errorCode = sample.comparatorErrorClass
    ? RPC_PARITY_ERROR_CLASSES.indexOf(sample.comparatorErrorClass) + 1
    : 0;
  const httpStatus = sample.comparatorHttpStatus === null ? "" : String(sample.comparatorHttpStatus);
  if (stepMask === 0 && errorCode === 0 && httpStatus === "") return null;
  return [chainIndex, stepMask, errorCode, httpStatus].join(SAMPLE_FIELD_SEPARATOR);
}

interface SampleDiagnostics {
  stepMask: number;
  comparatorErrorClass: RpcParityErrorClass | null;
  comparatorHttpStatus: number | null;
}

function decodeDiagnostics(section: string | undefined): Map<number, SampleDiagnostics> {
  const byChainIndex = new Map<number, SampleDiagnostics>();
  if (section == null || section === "") return byChainIndex;
  const [layout, ...entries] = section.split(SAMPLE_SEPARATOR);
  if (layout !== DIAGNOSTICS_LAYOUT) return byChainIndex;
  for (const entry of entries) {
    const fields = entry.split(SAMPLE_FIELD_SEPARATOR);
    if (fields.length !== DIAGNOSTICS_FIELD_COUNT) continue;
    const chainIndex = readWireNumber(fields[0]);
    const stepMask = readWireNumber(fields[1]);
    if (chainIndex === null || stepMask === null) continue;
    const errorCode = readWireNumber(fields[2]) ?? 0;
    const httpStatus = readWireNumber(fields[3]);
    byChainIndex.set(chainIndex, {
      stepMask,
      comparatorErrorClass: errorCode > 0 ? RPC_PARITY_ERROR_CLASSES[errorCode - 1] ?? null : null,
      comparatorHttpStatus: httpStatus === null ? null : Math.trunc(httpStatus),
    });
  }
  return byChainIndex;
}

function readWireNumber(field: string | undefined): number | null {
  if (field == null || field === "") return null;
  const parsed = Number(field);
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeCompactFreshness(
  f: unknown,
  base: number,
  version: number,
): RpcParityLatestFreshness | null {
  if (!Array.isArray(f) || (f.length !== 5 && f.length !== 7 && f.length !== 12 && !(version >= 5 && f.length === 15))
    || !RPC_PARITY_LATEST_FRESHNESS_VERDICTS[f[0] as number] || !RPC_PARITY_LATEST_FRESHNESS_REASONS[f[1] as number]
    || !f.slice(2, 5).every((value) => value === null || Number.isSafeInteger(value))) return null;
  const freshness: RpcParityLatestFreshness = {
    verdict: RPC_PARITY_LATEST_FRESHNESS_VERDICTS[f[0] as number], reason: RPC_PARITY_LATEST_FRESHNESS_REASONS[f[1] as number],
    headBefore: f[2] === null ? null : base + Number(f[2]),
    headAfter: f[3] === null ? null : base + Number(f[3]),
    matchedBlock: f[4] === null ? null : base + Number(f[4]),
  };
  if (f.length >= 12) {
    if ((f[7] !== null && (!Number.isInteger(f[7]) || !RPC_PARITY_LATEST_PROBE_METHODS[f[7]]))
      || (f[8] !== null && typeof f[8] !== "boolean")
      || !f.slice(9, 12).every((value) => value === null || Number.isSafeInteger(value))) return null;
    if (f[7] !== null && typeof f[8] !== "boolean") return null;
    if (f[7] === null && f[8] === true) return null;
    if (f[7] !== null) freshness.method = RPC_PARITY_LATEST_PROBE_METHODS[f[7]];
    if (f[8] !== null) freshness.discriminating = f[8];
    if (f[9] !== null) freshness.servedBlock = base + Number(f[9]);
    if (f[10] !== null) freshness.lagBlocks = Number(f[10]);
    if (f[11] !== null) {
      if (Number(f[11]) < 0) return null;
      freshness.toleranceBlocks = Number(f[11]);
    }
  }
  if (f.length === 15) {
    if (typeof f[12] !== "string" || !/^0x[0-9a-f]{40}$/i.test(f[12])
      || typeof f[13] !== "string" || !/^0x[0-9a-f]{8}$/i.test(f[13])) return null;
    freshness.call = { to: f[12], data: f[13] };
    if (f[14] !== null) {
      if (!Number.isSafeInteger(f[14])) return null;
      freshness.referenceEndBlock = base + Number(f[14]);
    }
  }
  if (f.length === 7 || (f.length >= 12 && (f[5] !== null || f[6] !== null))) {
    if ((f[5] !== null && typeof f[5] !== "string") || !Array.isArray(f[6])
      || f[6].length > (f.length === 15 ? RPC_PARITY_LATEST_MAX_NUMERIC_CALLS : 4)
      || !f[6].every((entry) => entry && Number.isSafeInteger(entry.block) && typeof entry.value === "string")) return null;
    freshness.latestValue = f[5];
    freshness.numericValues = f[6];
  }
  if (freshness.verdict !== "indeterminate") {
    const before = freshness.headBefore;
    const after = freshness.headAfter;
    if (before === null || after === null || before < 0 || after < before) return null;
    if (freshness.method !== undefined && freshness.method !== "state-bracket") {
      const served = freshness.servedBlock;
      const tolerance = freshness.toleranceBlocks;
      if (served == null || tolerance === undefined
        || freshness.discriminating !== true || freshness.lagBlocks !== before - served) return null;
      if (freshness.verdict === "fresh") {
        if (freshness.reason !== "served-block-in-range" || served < before - tolerance || served > after + tolerance) return null;
      } else if (freshness.reason !== "served-block-behind" || served >= before - tolerance) return null;
    } else if (freshness.call) {
      const tolerance = freshness.toleranceBlocks;
      const values = freshness.numericValues;
      const end = freshness.referenceEndBlock;
      if (tolerance === undefined || end == null || end < after || !values?.length || !freshness.latestValue) return null;
      const first = Math.max(0, before - tolerance);
      if (values.length !== end - first + 1
        || !values.every((entry, index) => entry.block === end - index)) return null;
      const match = values.find((entry) => entry.value === freshness.latestValue);
      if (freshness.verdict === "fresh") {
        const discriminating = values.some((entry) => entry.value !== values[0].value);
        if (freshness.reason !== "matched-numeric-block" || !match || freshness.matchedBlock !== match.block
          || freshness.discriminating !== discriminating) return null;
      } else if (freshness.reason !== "no-bracket-match" || match || freshness.matchedBlock !== null
        || freshness.discriminating !== true) return null;
    } else {
      // Legacy state-bracket observations did not include the shared tolerance.
      if (after - before + 1 > 4) return null; // v2–v4's original numeric-reference bound
      if (freshness.verdict === "fresh") {
        if (freshness.reason !== "matched-numeric-block" || freshness.matchedBlock === null
          || freshness.matchedBlock < before || freshness.matchedBlock > after) return null;
      } else if (freshness.reason !== "no-bracket-match" || freshness.matchedBlock !== null) return null;
    }
  }
  return freshness;
}

function decodeSample(
  wire: string,
  chains: string[],
  comparators: RpcParityComparatorRef[],
  hosts: string[],
  layouts: CallLayout[],
  previousBlocks: Map<string, number>,
  version: number,
): RpcParityChainSample | null {
  const fields = wire.split(SAMPLE_FIELD_SEPARATOR);
  if (fields.length !== SAMPLE_FIELD_COUNT && fields.length !== SAMPLE_FIELD_COUNT + 1) return null;
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
  const commonBlock = parsedCommonBlock !== null && Number.isSafeInteger(parsedCommonBlock)
    ? parsedCommonBlock + (version >= 2 ? previousBlocks.get(chainId) ?? 0 : 0) : null;
  if (commonBlock !== null) previousBlocks.set(chainId, commonBlock);
  const errorClass = errorCode > 0 ? RPC_PARITY_ERROR_CLASSES[errorCode - 1] ?? null : null;
  let telemetry: Pick<RpcParityChainSample, "calls" | "latestFreshness" | "logsComparator" | "sentinelFreshness" | "tokenFreshness"> = {};
  if (fields[9]) {
    try {
      const data: unknown = JSON.parse(fields[9]);
      if (!Array.isArray(data) || (data.length !== 3 && !(version >= 4 && data.length === 4))) return null;
      let logsComparator: RpcParityComparatorRef | null | undefined;
      if (data.length === 4) {
        if (data[3] === null) {
          logsComparator = null;
          if (flags & (FLAG_LOG_CHECKED | FLAG_LOG_MATCHED | FLAG_PRUNED_CHECKED | FLAG_PRUNED_TRAP)) return null;
        } else {
          if (!Number.isInteger(data[3]) || data[3] < 0 || !comparators[data[3]]) return null;
          logsComparator = comparators[data[3]];
        }
      }
      const layout = layouts[data[0] as number];
      if (!layout || layout.length !== 2 || !layout.every((entries, index) => (
        Array.isArray(entries) && entries.length <= RPC_PARITY_MAX_CALLS_PER_OPERATOR[index === 0 ? "dwellir" : "comparator"]
      ))) return null;
      const timings = unpackLatencies(data[1], layout[0].length + layout[1].length);
      if (!timings) return null;
      let timingIndex = 0;
      const operators = layout.map((entries, operatorIndex) => entries.map((code): RpcParityCallObservation => {
        const separateComparator = version >= 4 && (code & CALL_LOGS_COMPARATOR) !== 0;
        const step = Math.floor((version >= 4 ? code & 127 : code) / 32);
        const error = code % 16;
        if (!Number.isInteger(code) || code < 0 || code > 255 || !RPC_PARITY_PROBE_STEPS[step]
          || error > RPC_PARITY_ERROR_CLASSES.length
          || (separateComparator && (operatorIndex !== 1 || !logsComparator))) {
          throw new Error("invalid-call");
        }
        const observation: RpcParityCallObservation = {
          step: RPC_PARITY_PROBE_STEPS[step], phase: code & 16 ? "warm" : "firstTouch",
          latencyMs: timings[timingIndex++], errorClass: error === 0 ? null : RPC_PARITY_ERROR_CLASSES[error - 1],
        };
        if (separateComparator && logsComparator) observation.comparator = logsComparator;
        return observation;
      }));
      telemetry = { calls: { dwellir: operators[0], comparator: operators[1] } };
      if (logsComparator !== undefined) telemetry.logsComparator = logsComparator;
      if (data[2] !== null) {
        const f: unknown = data[2];
        const base = commonBlock ?? 0;
        if (version >= 5 && Array.isArray(f) && f.length === 2) {
          const sentinel = f[0] === null ? null : decodeCompactFreshness(f[0], base, version);
          const token = decodeCompactFreshness(f[1], base, version);
          if ((f[0] !== null && (!sentinel?.call
            || (sentinel.method !== "multicall3-block-number" && sentinel.method !== "arbsys-block-number")))
            || !token?.call || token.method !== "state-bracket" || token.toleranceBlocks === undefined) return null;
          const requiresEnd = token.headBefore !== null && token.headAfter !== null && token.headAfter >= token.headBefore;
          if (requiresEnd || token.referenceEndBlock != null) {
            if (token.headAfter === null
              || token.referenceEndBlock !== Math.max(token.headAfter, sentinel?.servedBlock ?? token.headAfter)) return null;
          }
          telemetry.sentinelFreshness = sentinel;
          telemetry.tokenFreshness = token;
          telemetry.latestFreshness = combineRpcParityLatestFreshness(sentinel, token);
        } else {
          const freshness = decodeCompactFreshness(f, base, version);
          if (!freshness) return null;
          telemetry.latestFreshness = freshness;
        }
      }
    } catch {
      return null;
    }
  }
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
    dwellirLatencyMs: telemetry.calls?.dwellir.find((call) => call.step === "head")?.latencyMs ?? readWireNumber(fields[4]),
    comparatorLatencyMs: telemetry.calls?.comparator.find((call) => call.step === "head")?.latencyMs ?? readWireNumber(fields[5]),
    errorClass,
    // Rows written before the diagnostics section existed decode to "nothing
    // failed that we recorded", which is exactly what they claimed; the run
    // decoder overlays the section when this row carries one.
    comparatorErrorClass: null,
    comparatorHttpStatus: null,
    failedSteps: { dwellir: emptyStepFailures(), comparator: emptyStepFailures() },
    ...telemetry,
  };
}

function decodeDiagnosticFields(diagnostics: SampleDiagnostics): Pick<
  RpcParityChainSample,
  "comparatorErrorClass" | "comparatorHttpStatus" | "failedSteps"
> {
  return {
    comparatorErrorClass: diagnostics.comparatorErrorClass,
    comparatorHttpStatus: diagnostics.comparatorHttpStatus,
    failedSteps: {
      dwellir: stepFailuresFromMask(diagnostics.stepMask, "dwellir"),
      comparator: stepFailuresFromMask(diagnostics.stepMask, "comparator"),
    },
  };
}

function stepFailuresFromMask(mask: number, operator: "dwellir" | "comparator"): RpcParityStepFailures {
  const bits = STEP_FAILURE_BITS[operator];
  return {
    head: (mask & bits.head) !== 0,
    state: (mask & bits.state) !== 0,
    logs: (mask & bits.logs) !== 0,
    latest: (mask & bits.latest) !== 0,
  };
}

function sameComparator(left: RpcParityComparatorRef, right: RpcParityComparatorRef): boolean {
  return left.operator === right.operator && left.host === right.host && left.source === right.source;
}

function registerComparator(comparators: RpcParityComparatorRef[], comparator: RpcParityComparatorRef): number {
  const index = comparators.findIndex((candidate) => sameComparator(candidate, comparator));
  if (index !== -1) return index;
  comparators.push(comparator);
  return comparators.length - 1;
}

export function encodeRpcParityStoreRow(row: RpcParityStoreRow): string {
  const comparators: RpcParityComparatorRef[] = [...row.comparators];
  const hosts: string[] = [...row.dwellirHosts];
  const chains = [...row.chains];
  const layouts: CallLayout[] = [];
  const previousBlocks = new Map<string, number>();
  const newestStale = new Map<string, RpcParityChainSample>();
  for (const run of row.runs) {
    for (const sample of run.samples) {
      if (sample.latestFreshness?.verdict === "stale") newestStale.set(sample.chainId, sample);
    }
  }
  const runs: ([number, string] | [number, string, string])[] = row.runs.map((run) => {
    const diagnostics: string[] = [];
    const samples = run.samples.flatMap((sample) => {
      const chainIndex = chains.indexOf(sample.chainId);
      if (chainIndex === -1) return [];
      const diagnostic = encodeSampleDiagnostics(sample, chainIndex);
      if (diagnostic !== null) diagnostics.push(diagnostic);
      return [encodeSample(sample, chainIndex, comparators, hosts, layouts, previousBlocks, newestStale.get(sample.chainId) === sample)];
    });
    const samplePayload = samples.join(SAMPLE_SEPARATOR);
    if (diagnostics.length === 0) return [run.atSec, samplePayload];
    return [run.atSec, samplePayload, [DIAGNOSTICS_LAYOUT, ...diagnostics].join(SAMPLE_SEPARATOR)];
  });
  const latest: RpcParityWireRow["latest"] = {};
  for (const [chainId, state] of Object.entries(row.latest)) {
    latest[chainId] = [state.atSec, state.dwellirHead, state.comparatorHead, state.commonBlock];
  }
  const wire: RpcParityWireRow = {
    v: RPC_PARITY_STORE_VERSION,
    chains,
    comparators: comparators.map((comparator) => [comparator.operator, comparator.host, comparator.source]),
    hosts,
    layouts,
    runs,
    latest,
    skips: row.runs.map((run) => run.skipped === undefined ? null : run.skipped.map<[number, number]>((entry) => (
      [chains.indexOf(entry.chainId), RPC_PARITY_SKIP_REASONS.indexOf(entry.reason)]
    ))),
  };
  // gzip is a native Worker Node-compat API. Compress the whole window, not
  // each run: repeated provenance and method vocabulary share one dictionary.
  const serialized = Buffer.from(JSON.stringify(wire), "utf8");
  if (serialized.byteLength > RPC_PARITY_MAX_DECOMPRESSED_BYTES) throw new RangeError(RAW_ROW_BUDGET_ERROR);
  const compressed = gzipSync(serialized, { level: 9 });
  return JSON.stringify({
    v: RPC_PARITY_STORE_VERSION,
    encoding: "gzip",
    payload: Buffer.from(compressed.buffer, compressed.byteOffset, compressed.byteLength).toString("base64"),
  });
}

/** Decodes a stored row. Returns null for anything whose shape cannot be trusted. */
export function decodeRpcParityStoreRow(value: string): RpcParityStoreRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && "encoding" in parsed) {
      const envelope = parsed as { v?: unknown; encoding?: unknown; payload?: unknown };
      if ((envelope.v !== 2 && envelope.v !== 3 && envelope.v !== 4 && envelope.v !== RPC_PARITY_STORE_VERSION) || envelope.encoding !== "gzip" || typeof envelope.payload !== "string") return null;
      const decompressed = gunzipSync(Buffer.from(envelope.payload, "base64"), {
        maxOutputLength: RPC_PARITY_MAX_DECOMPRESSED_BYTES,
      });
      parsed = JSON.parse(Buffer.from(
        decompressed.buffer, decompressed.byteOffset, decompressed.byteLength,
      ).toString("utf8")) as unknown;
    }
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const wire = parsed as Partial<RpcParityWireRow>;
  if (wire.v !== 1 && wire.v !== 2 && wire.v !== 3 && wire.v !== 4 && wire.v !== RPC_PARITY_STORE_VERSION) return null;
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
  const previousBlocks = new Map<string, number>();
  const layouts = wire.layouts ?? [];
  if (!Array.isArray(layouts)) return null;
  if (wire.skips !== undefined && (!Array.isArray(wire.skips) || wire.skips.length !== wire.runs.length)) return null;
  for (const [runIndex, run] of wire.runs.entries()) {
    if (!Array.isArray(run) || (run.length !== 2 && run.length !== 3)) return null;
    const [atSec, samples, diagnosticsSection] = run;
    if (typeof atSec !== "number" || !Number.isSafeInteger(atSec) || typeof samples !== "string") return null;
    if (diagnosticsSection !== undefined && typeof diagnosticsSection !== "string") return null;
    const diagnostics = decodeDiagnostics(diagnosticsSection);
    let skipped: RpcParityChainSkip[] | undefined;
    const skipEntries = wire.skips?.[runIndex];
    if (skipEntries != null) {
      if (!Array.isArray(skipEntries)) return null;
      skipped = [];
      for (const entry of skipEntries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof chains[entry[0]] !== "string"
          || RPC_PARITY_SKIP_REASONS[entry[1]] === undefined) return null;
        skipped.push({ chainId: chains[entry[0]], reason: RPC_PARITY_SKIP_REASONS[entry[1]] });
      }
    }
    const decoded: RpcParityChainSample[] = [];
    for (const sample of samples === "" ? [] : samples.split(SAMPLE_SEPARATOR)) {
      const value = decodeSample(sample, chains, comparators, hosts, layouts, previousBlocks, wire.v!);
      if (!value) return null;
      decoded.push(value);
    }
    // Diagnostics are keyed by the sample's own chain index; a sample whose
    // index carried no entry keeps its all-clear defaults.
    runs.push({
      ...(skipped === undefined ? {} : { skipped }),
      atSec,
      samples: decoded.map((sample) => {
        const chainIndex = chains.indexOf(sample.chainId);
        const entry = chainIndex === -1 ? undefined : diagnostics.get(chainIndex);
        return entry === undefined ? sample : { ...sample, ...decodeDiagnosticFields(entry) };
      }),
    });
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

/** Null means the raw wire exceeded the reader ceiling, not an empty row. */
function encodedRowBytesForPruning(row: RpcParityStoreRow): number | null {
  try {
    return encodeRpcParityStoreRow(row).length;
  } catch (error) {
    if (error instanceof RangeError && error.message === RAW_ROW_BUDGET_ERROR) return null;
    throw error;
  }
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
  for (const entry of run.skipped ?? []) {
    if (!known.has(entry.chainId)) {
      chains.push(entry.chainId);
      known.add(entry.chainId);
    }
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
  const runs: RpcParityStoredRun[] = [...retained, {
    atSec: run.atSec, samples: incoming,
    ...(run.skipped === undefined ? {} : { skipped: run.skipped }),
  }]
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
  let bytes = encodedRowBytesForPruning(row);
  while ((bytes === null || bytes > maxBytes) && row.runs.length > 1) {
    row.runs.shift();
    droppedOldest += 1;
    bytes = encodedRowBytesForPruning(row);
  }
  if (bytes === null) throw new RangeError(RAW_ROW_BUDGET_ERROR);
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
  published: boolean;
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
      published: false,
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
    published: true,
    runs: merged.row.runs.length,
    bytes: merged.bytes,
    droppedOldest: merged.droppedOldest,
    reset: merged.reset,
    error: readError,
  };
}

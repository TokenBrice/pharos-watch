import { loadV9CandidateMethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { V9ValidatedPolicyEnvelope } from "@shared/types/safety-score-v9";
import {
  V9LaneIncidentCertificateSchema,
  type V9LaneIncidentCertificate,
} from "@shared/types/safety-score-v9-incidents";
import { API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC } from "../api-freshness-age";
import { throwIfAborted } from "../abort";
import { getCaches, prepareCacheUpsert } from "../db-cache";
import { batchExecute } from "../d1-primitives";
import { runWithOverloadRetry } from "../d1-overload-retry";
import { parseJson } from "../json-parse";

/**
 * Cache-table persistence for C3 lane incident certificates.
 *
 * One row per (subject lane, screening set, pinned block window). The row family
 * lives in the generic `cache` table, whose schema is owned by the baseline
 * migration (`docs/process/worker-infrastructure-appendix.md#cache-table`), so a
 * new key family needs no migration.
 *
 * The pinned `windowEndSec` is the freshness witness (R3), never the producer or
 * cache clock: a read assesses age against policy
 * `semantic.evidence.laneIncidentCertificateMaxAgeSec` and never rewrites a
 * certificate or advances its dates. A lane is served as current only when its
 * retained certificates form one contiguous coverage chain; a coverage gap or an
 * expired window yields a named non-current state, never a re-dated certificate
 * (ADR-28/29).
 */

const CACHE_PREFIX = "lane-incident-certificate:v1";
const CACHE_SEPARATOR = "|";
const CACHE_KEY_PREFIX = `${CACHE_PREFIX}${CACHE_SEPARATOR}`;
/** Exclusive upper bound for a prefix range scan; every ASCII key sorts below it. */
const CACHE_KEY_PREFIX_HIGH = `${CACHE_KEY_PREFIX}\uFFFF`;
const NUMBER_WIDTH = 16;
const NUMBER_RANGE_PART_PATTERN = /^(\d{16})-(\d{16})$/u;
const SCREENING_SET_ID_PATTERN = /^[a-f0-9]{64}$/u;
const VALUE_READ_BATCH_SIZE = 90;
const KEY_READ_RETRY_ATTEMPTS = 3;

/**
 * Retained windows per (lane, screening set). Pruning is skipped for a group with
 * a recorded coverage gap, so a gap stays visible until the producer backfills
 * the missing window.
 */
export const LANE_INCIDENT_CERTIFICATE_MAX_WINDOWS_PER_GROUP = 4;

export const LANE_INCIDENT_CERTIFICATE_READ_STATES = [
  "current",
  "expired",
  "coverage-gap",
  "future-window",
  "missing",
  "malformed-row",
] as const;
export type LaneIncidentCertificateReadState =
  (typeof LANE_INCIDENT_CERTIFICATE_READ_STATES)[number];

/**
 * Declared fields that identify a lane's screening set. The subject lane (OP-IR
 * 5b) and the sorted contributor control ids are part of the identity: an added
 * contributor, emitter or pin starts a new chain and inherits nothing.
 */
export interface LaneIncidentCertificateScreeningSetInput {
  subjectDeploymentKey: string;
  screeningPolicyDigest: string;
  contributorControlIds: readonly string[];
  emitters: readonly { address: string; expectedRuntimeCodeSha256: string }[];
}

export type LaneIncidentCertificateCacheKeyInput = LaneIncidentCertificateScreeningSetInput &
  Pick<
    V9LaneIncidentCertificate,
    | "fromBlock"
    | "toBlock"
    | "windowStartSec"
    | "windowEndSec"
  >;

/** One certificate to persist with the contributors its descriptor screens. */
export interface LaneIncidentCertificatePersistenceRow {
  certificate: V9LaneIncidentCertificate;
  contributorControlIds: readonly string[];
}

interface ParsedCertificateKey {
  deploymentKey: string;
  screeningSetId: string;
  windowStartSec: number;
  windowEndSec: number;
  fromBlock: number;
  toBlock: number;
}

/**
 * Identity of one emitter set under one frozen screening policy. A new emitter
 * (or code pin) or a new topic list starts a fresh chain: certificates produced
 * under different screening policies never chain with each other (R3/R5).
 */
export function laneIncidentCertificateScreeningSetId(
  screeningSet: LaneIncidentCertificateScreeningSetInput,
): string {
  return sha256Hex(stableJsonStringifyV1({
    domain: "safety-score-v9.lane-incident-certificate.screening-set.v2",
    subjectDeploymentKey: screeningSet.subjectDeploymentKey,
    screeningPolicyDigest: screeningSet.screeningPolicyDigest,
    contributorControlIds: [...screeningSet.contributorControlIds].sort(compareText),
    emitters: screeningSet.emitters
      .map(({ address, expectedRuntimeCodeSha256 }) => ({ address, expectedRuntimeCodeSha256 }))
      .sort((left, right) => compareText(left.address, right.address)),
  }));
}

function padded(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Lane incident certificate key component must be a non-negative safe integer (received ${value})`);
  }
  return String(value).padStart(NUMBER_WIDTH, "0");
}

/** Deterministic cache key: lane, screening set, pinned window and block range. */
export function laneIncidentCertificateCacheKey(
  certificate: LaneIncidentCertificateCacheKeyInput,
): string {
  if (certificate.subjectDeploymentKey.includes(CACHE_SEPARATOR)) {
    throw new Error("Lane incident certificate subject deployment key cannot contain the cache separator");
  }
  return [
    CACHE_PREFIX,
    certificate.subjectDeploymentKey,
    laneIncidentCertificateScreeningSetId(certificate),
    `${padded(certificate.windowStartSec)}-${padded(certificate.windowEndSec)}`,
    `${padded(certificate.fromBlock)}-${padded(certificate.toBlock)}`,
  ].join(CACHE_SEPARATOR);
}

function parseLaneIncidentCertificateKey(key: string): ParsedCertificateKey | null {
  const parts = key.split(CACHE_SEPARATOR);
  if (parts.length !== 5 || parts[0] !== CACHE_PREFIX) return null;
  const [, deploymentKey, screeningSetId, windowPart, blockPart] = parts;
  if (!deploymentKey || !SCREENING_SET_ID_PATTERN.test(screeningSetId ?? "")) return null;
  const window = NUMBER_RANGE_PART_PATTERN.exec(windowPart ?? "");
  const block = NUMBER_RANGE_PART_PATTERN.exec(blockPart ?? "");
  if (!window || !block) return null;
  const [windowStartSec, windowEndSec] = [Number(window[1]), Number(window[2])];
  const [fromBlock, toBlock] = [Number(block[1]), Number(block[2])];
  if (
    !Number.isSafeInteger(windowStartSec) ||
    !Number.isSafeInteger(windowEndSec) ||
    !Number.isSafeInteger(fromBlock) ||
    !Number.isSafeInteger(toBlock)
  ) {
    return null;
  }
  return { deploymentKey, screeningSetId, windowStartSec, windowEndSec, fromBlock, toBlock };
}

/** Policy-backed freshness budget for an admitted lane certificate (30 days at U4). */
export function resolveLaneIncidentCertificateMaxAgeSec(
  envelope?: V9ValidatedPolicyEnvelope,
  nowSec = Math.floor(Date.now() / 1_000),
): number {
  return (envelope ?? loadV9CandidateMethodologyPolicy(nowSec))
    .policy.semantic.evidence.laneIncidentCertificateMaxAgeSec;
}

export interface LaneIncidentCertificateChainView {
  deploymentKey: string;
  screeningSetId: string;
  /** Newest certificate in the retained chain; it remains the newest even when not current. */
  certificate: V9LaneIncidentCertificate;
  /** Start of the retained coverage chain (oldest retained pinned window). */
  coveredFromSec: number;
  /** Newest pinned window end; the only freshness witness. */
  coveredThroughSec: number;
  /** Retained certificates in the assessed chain. */
  windowCount: number;
}

export type LaneIncidentCertificateRead =
  | (LaneIncidentCertificateChainView & { state: "current"; expiresAtSec: number })
  | (LaneIncidentCertificateChainView & {
    state: "expired";
    expiresAtSec: number;
    expiredBySec: number;
  })
  | (LaneIncidentCertificateChainView & {
    state: "coverage-gap";
    /** Last block covered before the unscreened interval. */
    gapFromBlock: number;
    /** First block of the next retained certificate, after the unscreened interval. */
    gapToBlock: number;
  })
  | (LaneIncidentCertificateChainView & { state: "future-window" })
  | { state: "missing"; deploymentKey: string }
  | {
    state: "malformed-row";
    deploymentKey: string;
    cacheKey: string;
    detail: string;
  };

export interface LoadLaneIncidentCertificateOptions {
  nowSec: number;
  /** Validated evaluation policy; defaults to the candidate policy at `nowSec`. */
  policy?: V9ValidatedPolicyEnvelope;
  signal?: AbortSignal;
}

interface CertificateRow extends ParsedCertificateKey {
  cacheKey: string;
  certificate: V9LaneIncidentCertificate;
}

interface ChainAssessment {
  screeningSetId: string;
  rows: CertificateRow[];
  coveredFromSec: number;
  coveredThroughBlock: number;
  gap: { gapFromBlock: number; gapToBlock: number } | null;
}

function assertClock(nowSec: number): void {
  if (!Number.isSafeInteger(nowSec) || nowSec < 0) {
    throw new TypeError("Lane incident certificate clock must be a non-negative integer");
  }
}

async function readFamilyKeys(db: D1Database, signal?: AbortSignal): Promise<string[]> {
  const rows = await runWithOverloadRetry(
    () => db
      .prepare("SELECT key FROM cache WHERE key >= ? AND key < ?")
      .bind(CACHE_KEY_PREFIX, CACHE_KEY_PREFIX_HIGH)
      .all<{ key: string }>(),
    KEY_READ_RETRY_ATTEMPTS,
    signal,
  );
  return (rows.results ?? []).map((row) => row.key);
}

async function readValues(
  db: D1Database,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  const sorted = [...new Set(keys)].sort(compareText);
  for (let index = 0; index < sorted.length; index += VALUE_READ_BATCH_SIZE) {
    const rows = await getCaches(db, sorted.slice(index, index + VALUE_READ_BATCH_SIZE));
    for (const [key, row] of rows) values.set(key, row.value);
  }
  return values;
}

function malformedRow(
  deploymentKey: string,
  cacheKey: string,
  detail: string,
): LaneIncidentCertificateRead {
  return { state: "malformed-row", deploymentKey, cacheKey, detail };
}

function decodeRow(
  key: string,
  parsedKey: ParsedCertificateKey,
  value: string | undefined,
): CertificateRow | { detail: string } {
  if (value === undefined) {
    return { detail: "cache row disappeared between the key scan and the value read" };
  }
  const json = parseJson(value);
  if (!json.ok) return { detail: `stored value is not valid JSON: ${json.message}` };
  const parsed = V9LaneIncidentCertificateSchema.safeParse(json.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { detail: `stored value is not an admitted certificate: ${issue?.message ?? "schema mismatch"}` };
  }
  const certificate = parsed.data;
  if (stableJsonStringifyV1(certificate) !== value) {
    return { detail: "stored certificate JSON is not canonical" };
  }
  // Rebuild the stored identity from the key's screening set: the certificate
  // alone cannot rederive it, because the set also pins the descriptor's
  // contributors (OP-IR 5b).
  const expectedKey = [
    CACHE_PREFIX,
    certificate.subjectDeploymentKey,
    parsedKey.screeningSetId,
    `${padded(certificate.windowStartSec)}-${padded(certificate.windowEndSec)}`,
    `${padded(certificate.fromBlock)}-${padded(certificate.toBlock)}`,
  ].join(CACHE_SEPARATOR);
  if (expectedKey !== key) {
    return { detail: "cache key does not match the stored certificate" };
  }
  return { ...parsedKey, cacheKey: key, certificate };
}

function compareCertificateRows(left: CertificateRow, right: CertificateRow): number {
  return (
    left.fromBlock - right.fromBlock ||
    left.toBlock - right.toBlock ||
    left.windowStartSec - right.windowStartSec ||
    compareText(left.cacheKey, right.cacheKey)
  );
}

/**
 * Assess the retained pinned block ranges of one screening set. Ranges are
 * ordered by their start block; every next range must start at or before the
 * previous covered end block plus one, so an unscreened block interval is a gap,
 * not an implicit clean read. Block coverage (not block timestamps) is the
 * coverage unit: two adjacent ranges leave no unscreened block, while a skipped
 * block does. The timestamp envelope is reported separately as the freshness
 * witness.
 */
function assessChain(screeningSetId: string, rows: readonly CertificateRow[]): ChainAssessment {
  const sorted = [...rows].sort(compareCertificateRows);
  const first = sorted[0];
  if (!first) throw new Error("Lane incident certificate chain cannot be empty");
  let coveredThroughBlock = first.toBlock;
  let coveredFromSec = first.windowStartSec;
  let gap: ChainAssessment["gap"] = null;
  for (let index = 1; index < sorted.length; index += 1) {
    const row = sorted[index];
    if (!row) continue;
    if (row.fromBlock > coveredThroughBlock + 1) {
      gap = { gapFromBlock: coveredThroughBlock, gapToBlock: row.fromBlock };
      break;
    }
    coveredThroughBlock = Math.max(coveredThroughBlock, row.toBlock);
    coveredFromSec = Math.min(coveredFromSec, row.windowStartSec);
  }
  return {
    screeningSetId,
    rows: sorted,
    coveredFromSec,
    coveredThroughBlock,
    gap,
  };
}

function newestRow(rows: readonly CertificateRow[]): CertificateRow {
  let newest = rows[0];
  if (!newest) throw new Error("Lane incident certificate chain cannot be empty");
  for (const row of rows) {
    if (
      row.toBlock > newest.toBlock ||
      (row.toBlock === newest.toBlock && row.windowEndSec > newest.windowEndSec)
    ) {
      newest = row;
    }
  }
  return newest;
}

function assessLane(
  deploymentKey: string,
  keys: readonly string[],
  values: ReadonlyMap<string, string>,
  maxAgeSec: number,
  nowSec: number,
): LaneIncidentCertificateRead {
  if (keys.length === 0) return { state: "missing", deploymentKey };

  const rows: CertificateRow[] = [];
  for (const key of [...keys].sort(compareText)) {
    const parsedKey = parseLaneIncidentCertificateKey(key);
    if (!parsedKey) {
      return malformedRow(deploymentKey, key, "cache key is not a lane incident certificate identity");
    }
    const decoded = decodeRow(key, parsedKey, values.get(key));
    if ("detail" in decoded) return malformedRow(deploymentKey, key, decoded.detail);
    if (decoded.deploymentKey !== deploymentKey) {
      return malformedRow(deploymentKey, key, "cache key belongs to another lane");
    }
    rows.push(decoded);
  }

  const groups = new Map<string, CertificateRow[]>();
  for (const row of rows) {
    const group = groups.get(row.screeningSetId);
    if (group) group.push(row);
    else groups.set(row.screeningSetId, [row]);
  }

  const chains = [...groups.entries()]
    .map(([screeningSetId, groupRows]) => assessChain(screeningSetId, groupRows))
    .sort((left, right) =>
      right.coveredThroughBlock - left.coveredThroughBlock ||
      compareText(left.screeningSetId, right.screeningSetId),
    );
  const chain = chains[0];
  if (!chain) return { state: "missing", deploymentKey };

  const newest = newestRow(chain.rows);
  const view = {
    deploymentKey,
    screeningSetId: chain.screeningSetId,
    certificate: newest.certificate,
    coveredFromSec: chain.coveredFromSec,
    // The newest certificate's pinned window end is the freshness witness (R3).
    coveredThroughSec: newest.windowEndSec,
    windowCount: chain.rows.length,
  } satisfies LaneIncidentCertificateChainView;

  if (chain.gap) {
    return { state: "coverage-gap", ...view, ...chain.gap };
  }
  if (view.coveredThroughSec > nowSec + API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC) {
    return { state: "future-window", ...view };
  }
  const expiresAtSec = view.coveredThroughSec + maxAgeSec;
  if (nowSec > expiresAtSec) {
    return { state: "expired", ...view, expiresAtSec, expiredBySec: nowSec - expiresAtSec };
  }
  return { state: "current", ...view, expiresAtSec };
}

/**
 * Read one lane's current certificate state. Only `current` is usable evidence;
 * expired, gapped, future-dated, missing and malformed rows never become a
 * positive incident claim and are never re-dated on read.
 */
export async function loadLaneIncidentCertificate(
  db: D1Database,
  deploymentKey: string,
  options: LoadLaneIncidentCertificateOptions,
): Promise<LaneIncidentCertificateRead> {
  const results = await loadLaneIncidentCertificates(db, [deploymentKey], options);
  const result = results.get(deploymentKey);
  if (!result) throw new Error(`Lane incident certificate read dropped lane ${deploymentKey}`);
  return result;
}

export async function loadLaneIncidentCertificates(
  db: D1Database,
  deploymentKeys: readonly string[],
  options: LoadLaneIncidentCertificateOptions,
): Promise<Map<string, LaneIncidentCertificateRead>> {
  throwIfAborted(options.signal);
  assertClock(options.nowSec);
  const lanes = [...new Set(deploymentKeys)].sort(compareText);
  const maxAgeSec = resolveLaneIncidentCertificateMaxAgeSec(options.policy, options.nowSec);
  const results = new Map<string, LaneIncidentCertificateRead>();
  if (lanes.length === 0) return results;

  const requested = new Set(lanes);
  const familyKeys = await readFamilyKeys(db, options.signal);
  const keysByLane = new Map<string, string[]>();
  const malformedByLane = new Map<string, string>();
  for (const key of familyKeys) {
    const parsed = parseLaneIncidentCertificateKey(key);
    if (!parsed) {
      // A key inside the family that does not parse can only be attributed to a
      // lane whose prefix survives; fail that lane closed instead of hiding it.
      const lane = key.split(CACHE_SEPARATOR)[1];
      if (lane !== undefined && requested.has(lane) && !malformedByLane.has(lane)) {
        malformedByLane.set(lane, key);
      }
      continue;
    }
    if (!requested.has(parsed.deploymentKey)) continue;
    const laneKeys = keysByLane.get(parsed.deploymentKey);
    if (laneKeys) laneKeys.push(key);
    else keysByLane.set(parsed.deploymentKey, [key]);
  }

  const allKeys = [...keysByLane.values()].flat();
  const values = await readValues(db, allKeys);
  throwIfAborted(options.signal);

  for (const lane of lanes) {
    const malformedKey = malformedByLane.get(lane);
    if (malformedKey !== undefined) {
      results.set(lane, malformedRow(lane, malformedKey, "cache key is not a lane incident certificate identity"));
      continue;
    }
    results.set(lane, assessLane(lane, keysByLane.get(lane) ?? [], values, maxAgeSec, options.nowSec));
  }
  return results;
}

export interface LaneIncidentCertificateHead {
  deploymentKey: string;
  screeningSetId: string;
  windowStartSec: number;
  windowEndSec: number;
  fromBlock: number;
  toBlock: number;
  cacheKey: string;
}

/**
 * Scheduling hint for the screening producer: the newest retained pinned window
 * per lane, read from keys only so no certificate body is transferred. Chain
 * continuity and freshness remain the read API's verdict, not this list's.
 */
export async function listLaneIncidentCertificateHeads(
  db: D1Database,
  options: { signal?: AbortSignal } = {},
): Promise<LaneIncidentCertificateHead[]> {
  throwIfAborted(options.signal);
  const familyKeys = await readFamilyKeys(db, options.signal);
  const newestByLane = new Map<string, LaneIncidentCertificateHead>();
  for (const key of familyKeys) {
    const parsed = parseLaneIncidentCertificateKey(key);
    if (!parsed) continue;
    const current = newestByLane.get(parsed.deploymentKey);
    if (
      current === undefined ||
      parsed.windowEndSec > current.windowEndSec ||
      (parsed.windowEndSec === current.windowEndSec && parsed.windowStartSec > current.windowStartSec) ||
      (parsed.windowEndSec === current.windowEndSec &&
        parsed.windowStartSec === current.windowStartSec &&
        compareText(parsed.screeningSetId, current.screeningSetId) < 0)
    ) {
      newestByLane.set(parsed.deploymentKey, {
        deploymentKey: parsed.deploymentKey,
        screeningSetId: parsed.screeningSetId,
        windowStartSec: parsed.windowStartSec,
        windowEndSec: parsed.windowEndSec,
        fromBlock: parsed.fromBlock,
        toBlock: parsed.toBlock,
        cacheKey: key,
      });
    }
  }
  return [...newestByLane.values()].sort((left, right) => compareText(left.deploymentKey, right.deploymentKey));
}

interface PruneCandidate {
  cacheKey: string;
  windowStartSec: number;
  windowEndSec: number;
}

interface PendingCertificate {
  certificate: V9LaneIncidentCertificate;
  value: string;
  groupKey: string;
}

/**
 * Choose the oldest rows to prune for one touched group. Pruning preserves the
 * continuity evidence: a group with a gap keeps every row until the producer
 * backfills the missing window.
 */
function selectPrunableKeys(rows: readonly PruneCandidate[]): string[] {
  if (rows.length <= LANE_INCIDENT_CERTIFICATE_MAX_WINDOWS_PER_GROUP) return [];
  const sorted = [...rows].sort((left, right) =>
    left.windowStartSec - right.windowStartSec ||
    left.windowEndSec - right.windowEndSec ||
    compareText(left.cacheKey, right.cacheKey),
  );
  let coveredThrough = sorted[0]?.windowEndSec ?? 0;
  for (let index = 1; index < sorted.length; index += 1) {
    const row = sorted[index];
    if (!row) continue;
    if (row.windowStartSec > coveredThrough) return [];
    coveredThrough = Math.max(coveredThrough, row.windowEndSec);
  }
  return sorted
    .slice(0, sorted.length - LANE_INCIDENT_CERTIFICATE_MAX_WINDOWS_PER_GROUP)
    .map((row) => row.cacheKey);
}

/**
 * Persist admitted certificates, replacing the row for the same lane, screening
 * set and pinned window. Malformed input throws instead of being stored; a
 * failed write throws so the producer can report the lane failed (R2/R4).
 */
export async function persistLaneIncidentCertificates(
  db: D1Database,
  rows: readonly LaneIncidentCertificatePersistenceRow[],
  nowSec: number,
  signal?: AbortSignal,
): Promise<{ written: number; pruned: number }> {
  throwIfAborted(signal);
  assertClock(nowSec);
  if (rows.length === 0) return { written: 0, pruned: 0 };

  const byKey = new Map<string, PendingCertificate>();
  const newByGroup = new Map<string, Map<string, PendingCertificate>>();
  for (const input of rows) {
    const certificate = V9LaneIncidentCertificateSchema.parse(input.certificate);
    const screeningSet = { ...certificate, contributorControlIds: input.contributorControlIds };
    const key = laneIncidentCertificateCacheKey(screeningSet);
    const value = stableJsonStringifyV1(certificate);
    const existing = byKey.get(key);
    if (existing && existing.value !== value) {
      throw new Error(`Conflicting lane incident certificates for one pinned window: ${key}`);
    }
    const groupKey = `${certificate.subjectDeploymentKey}\u0000${laneIncidentCertificateScreeningSetId(screeningSet)}`;
    const pending = { certificate, value, groupKey };
    byKey.set(key, pending);
    const group = newByGroup.get(groupKey);
    if (group) group.set(key, pending);
    else newByGroup.set(groupKey, new Map([[key, pending]]));
  }

  const existingKeys = await readFamilyKeys(db, signal);
  const existingByGroup = new Map<string, PruneCandidate[]>();
  for (const key of existingKeys) {
    const parsed = parseLaneIncidentCertificateKey(key);
    if (!parsed) continue;
    const groupKey = `${parsed.deploymentKey}\u0000${parsed.screeningSetId}`;
    const candidate: PruneCandidate = {
      cacheKey: key,
      windowStartSec: parsed.windowStartSec,
      windowEndSec: parsed.windowEndSec,
    };
    const group = existingByGroup.get(groupKey);
    if (group) group.push(candidate);
    else existingByGroup.set(groupKey, [candidate]);
  }

  const prunable: string[] = [];
  for (const [groupKey, newRows] of newByGroup) {
    const merged = new Map<string, PruneCandidate>();
    for (const row of existingByGroup.get(groupKey) ?? []) merged.set(row.cacheKey, row);
    for (const [key, pending] of newRows) {
      merged.set(key, {
        cacheKey: key,
        windowStartSec: pending.certificate.windowStartSec,
        windowEndSec: pending.certificate.windowEndSec,
      });
    }
    prunable.push(...selectPrunableKeys([...merged.values()]));
  }

  const statements = [
    ...[...byKey.entries()].map(([key, entry]) =>
      prepareCacheUpsert(db, { key, value: entry.value, updatedAt: nowSec }),
    ),
    // Deletes run after the upserts so a backfilled window that falls outside
    // retention cannot resurrect a pruned row.
    ...prunable.map((key) => db.prepare("DELETE FROM cache WHERE key = ?").bind(key)),
  ];
  await batchExecute(db, statements, { signal });
  return { written: byKey.size, pruned: prunable.length };
}

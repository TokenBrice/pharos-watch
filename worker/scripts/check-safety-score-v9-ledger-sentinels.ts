/**
 * Sentinel-resolution check for the Safety Score v9 reviewed missing-data ledger.
 *
 * `docs/process/safety-score-curation-expiry-sweep.md` owns the closure contract:
 * a promote becomes a closure only after a fresh production replay makes the
 * recorded sentinel disappear without an adverse replacement. The registry emits
 * both machine-checkable sentinel forms (`doneWhenGapIdAbsent`,
 * `doneWhenScoreReasonAbsent`), but no code evaluated them, so landed closures sat
 * beside stale deferrals. This script performs that join.
 *
 * Inputs are the append-only ledger and a missing-data registry regenerated from
 * one fresh replay (optionally cross-checked against that exact replay). Output is
 * one verdict per claim group, evaluated on its latest appended decision:
 *
 * - `closed`             every machine-checkable sentinel is absent on the bound
 *                        registry, nothing measured-adverse or sibling replaced
 *                        it, and no closure blocker applies.
 * - `still-open`         at least one sentinel still resolves to an open item.
 * - `replaced-adversely` the sentinel dropped, but its identity became a
 *                        measured-adverse fact or a successor item occupies the
 *                        same scope; the group routes back to review, never to a
 *                        booked closure.
 * - `unverifiable`       this registry cannot verify the decision: narrative-only
 *                        or unresolvable sentinels, a missing or unrated
 *                        (quarantined / pipeline-gap) asset, a retired work type,
 *                        a registry without replay bindings, or a capture older
 *                        than the decision it would judge.
 *
 * Fail-closed rules (ADR-28..35): a failed read never becomes a positive claim.
 * No closure verdict exists unless the registry names its snapshot bindings
 * (`asOfSec`, `candidateId`, `publicationGenerationId`); every row repeats the
 * missing-data registry fingerprint and capture clock and names the ledger
 * decision index it evaluated; `inputs.registry.registrySha256` is the digest of
 * the exact registry bytes read, so a consumer (the closure applier) can prove
 * file identity; `--replay` rejects a registry that does not belong to that
 * replay; and `unknown` outcome never collapses into `closed`.
 *
 * Capture-scale registries exceed Node's default heap. Run locally with
 * `NODE_OPTIONS=--max-old-space-size=12288`.
 *
 * Usage:
 *   npx tsx worker/scripts/check-safety-score-v9-ledger-sentinels.ts \
 *     --registry <missing-data-registry.json> [--ledger <path>] \
 *     [--replay <accepted.replay.json>] [--output <json>] [--markdown <md>]
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { compareCodeUnits } from "@shared/lib/compare";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  parseStrictCliArgs,
  requireCliString,
  runDirectCli,
  writeCliHelpIfRequested,
  writeFileResolved,
} from "../../scripts/lib/cli-args.mjs";

const USAGE = `Usage: npx tsx worker/scripts/check-safety-score-v9-ledger-sentinels.ts --registry <path> [options]

Options:
  --registry <path>  Missing-data registry regenerated from one fresh replay (required)
  --ledger <path>    Reviewed missing-data ledger (default: ${".github/artifacts/safety-score-missing-data-reviewed-ledger.json"})
  --replay <path>    Exact v9 replay the registry must have been generated from; a mismatch fails closed
  --output <path>    Machine-readable verdict report JSON (default: stdout)
  --markdown <path>  Operator and issue-excerpt Markdown
  -h, --help         Show this help`;

export const DEFAULT_LEDGER_PATH = ".github/artifacts/safety-score-missing-data-reviewed-ledger.json";

/** One verdict per claim group, evaluated on that group's latest appended decision. */
export const SENTINEL_VERDICTS = ["closed", "still-open", "replaced-adversely", "unverifiable"] as const;
export type SentinelVerdict = (typeof SENTINEL_VERDICTS)[number];

/**
 * Machine-readable verdict reasons. `closed` reasons state how much of the claim
 * group remains; the others name the exact condition that blocked closure.
 */
export const SENTINEL_VERDICT_REASONS = [
  "sentinels-absent",
  "sentinels-absent-group-clear",
  "sentinels-still-present",
  "sentinels-partially-absent",
  "measured-adverse-successor",
  "sibling-sentinel-successor",
  "no-sentinels",
  "narrative-only-sentinels",
  "sentinel-unresolvable",
  "uncheckable-sentinel",
  "registry-binding-unavailable",
  "capture-predates-decision",
  "asset-absent-from-registry",
  "asset-not-rated",
  "work-type-retired",
] as const;
export type SentinelVerdictReason = (typeof SENTINEL_VERDICT_REASONS)[number];

/**
 * `structured-pending-production` admission axis required by the plan. Only a
 * clean closure verifies admission; `unverifiable` never becomes `failed`, and
 * `failed` never becomes `verified`.
 */
export const SENTINEL_ADMISSIONS = ["verified", "failed", "not-applicable", "unverifiable"] as const;
export type SentinelAdmission = (typeof SENTINEL_ADMISSIONS)[number];

const STRUCTURED_PENDING_PRODUCTION = "structured-pending-production";
const MEASURED_ADVERSE_CAUSE = "D";
const RATED = "rated";

const RegistrySchema = z
  .object({
    schemaVersion: z.number().int(),
    snapshot: z.unknown().optional(),
    workTypeDefinitions: z.unknown().optional(),
    stablecoins: z.array(
      z
        .object({
          assetId: z.string().min(1),
          currentScore: z.unknown().optional(),
          missingItems: z.array(z.unknown()),
        })
        .loose(),
    ),
  })
  .loose();

const RegistrySnapshotSchema = z
  .object({
    asOfSec: z.number().int().positive(),
    candidateId: z.string().min(1),
    publicationGenerationId: z.string().min(1),
    baseInputGenerationId: z.string().min(1).optional(),
    factSetDigest: z.string().min(1).optional(),
    resultDigest: z.string().min(1).optional(),
    queueDigest: z.string().min(1).optional(),
    policyId: z.string().min(1).optional(),
    policyDigest: z.string().min(1).optional(),
    evaluationBuildDigest: z.string().min(1).optional(),
  })
  .loose();

const LedgerSchema = z
  .object({
    schemaVersion: z.number().int(),
    allowedDecisions: z.array(z.string().min(1)).min(1),
    decisions: z.array(
      z
        .object({
          claimGroupId: z.string().min(1),
          decision: z.string().min(1),
          reviewedAt: z.string().min(1),
          workType: z.string().min(1).nullable().optional(),
          deferState: z.string().min(1).nullable().optional(),
          sentinels: z.unknown().optional(),
          taskIds: z.unknown().optional(),
        })
        .loose(),
    ),
  })
  .loose();

const ReplaySchema = z
  .object({
    pipeline: z
      .object({
        candidate: z
          .object({
            candidateId: z.string().min(1),
            asOfSec: z.number().int().positive(),
            publicationGenerationId: z.string().min(1),
            baseInputGenerationId: z.string().min(1).optional(),
            factSetDigest: z.string().min(1).optional(),
            resultDigest: z.string().min(1).optional(),
            evaluationBuildDigest: z.string().min(1).optional(),
            policy: z
              .object({ id: z.string().min(1), semanticDigest: z.string().min(1) })
              .loose()
              .optional(),
          })
          .loose(),
      })
      .loose(),
  })
  .loose();

export interface RegistryBinding {
  schemaVersion: number;
  asOfSec: number;
  asOfIso: string;
  candidateId: string;
  publicationGenerationId: string;
  baseInputGenerationId: string | null;
  factSetDigest: string | null;
  resultDigest: string | null;
  queueDigest: string | null;
  policyId: string | null;
  policyDigest: string | null;
  evaluationBuildDigest: string | null;
}

export interface RegistryItem {
  taskId: string;
  claimGroupId: string;
  workType: string;
  gapId: string | null;
  reasonCode: string;
  cause: string | null;
  /** `${reasonCode}|${scorePath ?? ""}` for score-projection items, else null. */
  scoreProjectionKey: string | null;
}

interface RegistryIndex {
  schemaVersion: number;
  binding: RegistryBinding | null;
  fingerprint: string;
  stablecoinCount: number;
  openItemCount: number;
  assetRatingStatus: ReadonlyMap<string, string | null>;
  workTypes: ReadonlySet<string>;
  itemsByGroup: ReadonlyMap<string, readonly RegistryItem[]>;
  itemsByGapId: ReadonlyMap<string, readonly RegistryItem[]>;
  scoreProjectionByKey: ReadonlyMap<string, RegistryItem>;
  scoreProjectionByGroupReason: ReadonlyMap<string, readonly RegistryItem[]>;
  taskIds: ReadonlySet<string>;
}

export interface SentinelMatch {
  kind: "gap" | "reason";
  /** Gap id, or `${reasonCode}|${path}`; `|*` marks a path-agnostic reason sentinel. */
  identity: string;
  status: "absent" | "present" | "adverse" | "successor";
  openItems: number;
  causes: string[];
}

export interface SentinelResolutionRow {
  claimGroupId: string;
  workType: string;
  assetId: string;
  decision: string;
  deferState: string | null;
  reviewedAt: string;
  reviewedAtSec: number;
  /** Position of the evaluated decision in the ledger this run read. */
  ledgerDecisionIndex: number;
  verdict: SentinelVerdict;
  reason: SentinelVerdictReason;
  admission: SentinelAdmission;
  registryFingerprint: string;
  asOfSec: number | null;
  groupState: "open-items" | "no-open-items";
  openItemCount: number;
  openTaskCount: number;
  taskIds: { total: number; open: number; closed: number };
  sentinels: {
    total: number;
    machineCheckable: number;
    gap: number;
    reason: number;
    narrative: number;
    unresolvable: number;
    absent: number;
    present: number;
    adverse: number;
    successor: number;
  };
  matches: SentinelMatch[];
  residualReasonCodes: string[];
  blocks: SentinelVerdictReason[];
}

export interface SentinelResolutionReport {
  schemaVersion: 1;
  title: string;
  purpose: string;
  contract: {
    evaluatedDecision: "latest-appended-decision-per-claim-group";
    closureRequires: string;
    admissionAxis: string;
  };
  inputs: {
    registryPath: string;
    ledgerPath: string;
    registry: {
      schemaVersion: number;
      stablecoinCount: number;
      openItemCount: number;
      missingDataRegistryFingerprint: string;
      /** SHA-256 of the exact registry file bytes this run parsed; null for programmatic callers without bytes. */
      registrySha256: string | null;
      binding: RegistryBinding | null;
    };
    ledger: {
      schemaVersion: number;
      decisionCount: number;
      claimGroupCount: number;
      latestReviewedAt: string | null;
    };
    replay: { path: string; candidateId: string; asOfSec: number; publicationGenerationId: string } | null;
    closureEvidence: "replay-verified" | "registry-snapshot" | "unavailable";
  };
  summary: {
    claimGroupCount: number;
    decisionCount: number;
    supersededDecisionCount: number;
    verdictCounts: Record<SentinelVerdict, number>;
    reasonCounts: Array<{ reason: SentinelVerdictReason; count: number }>;
    admissionCounts: Record<SentinelAdmission, number>;
    deferStateCounts: Array<{ key: string; count: number }>;
    groupStateCounts: { openItems: number; noOpenItems: number };
    closure: {
      groups: number;
      groupsWithOpenItems: number;
      openItemsInClosedGroups: number;
      derivedFactsClosed: number;
    };
    taskIds: { evaluated: number; open: number; closed: number };
    sentinels: {
      total: number;
      machineCheckable: number;
      absent: number;
      present: number;
      adverse: number;
      successor: number;
      narrative: number;
      unresolvable: number;
    };
    workTypeVerdictCounts: Array<{ workType: string; verdicts: Record<SentinelVerdict, number> }>;
  };
  groups: SentinelResolutionRow[];
}

interface NormalizedSentinel {
  kind: "gap" | "reason" | "narrative" | "unresolvable";
  gapId?: string;
  reasonCode?: string;
  path?: string | null;
  /** A reason sentinel without a path asserts the reason code itself is absent. */
  anyPath?: boolean;
  text?: string;
  detail?: string;
}

function requirePlainObject(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalStringField(record: Record<string, unknown>, field: string, location: string): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${location}.${field} must be a string when present`);
  return value;
}

function requiredStringField(record: Record<string, unknown>, field: string, location: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${location}.${field} must be a non-empty string`);
  return value;
}

/** Reviewed dates are ISO dates or ISO timestamps; a date starts at its UTC midnight. */
export function sentinelReviewedAtSec(value: string): number {
  const normalized = value.includes("T") ? value : `${value}T00:00:00Z`;
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid reviewedAt: ${value}`);
  return Math.floor(milliseconds / 1000);
}

function readScoreProjectionKey(item: Record<string, unknown>, location: string): string | null {
  const path = item.path;
  if (typeof path !== "object" || path === null || Array.isArray(path)) return null;
  const record = path as Record<string, unknown>;
  if (record.kind !== "score-projection") return null;
  const scorePath = record.scorePath;
  if (scorePath === undefined || scorePath === null) {
    return `${requiredStringField(item, "reasonCode", location)}|`;
  }
  if (typeof scorePath !== "string") throw new Error(`${location}.path.scorePath must be a string or null`);
  return `${requiredStringField(item, "reasonCode", location)}|${scorePath}`;
}

function readRegistryItem(value: unknown, location: string): RegistryItem {
  const record = requirePlainObject(value, location);
  const gapId = optionalStringField(record, "gapId", location);
  return {
    taskId: requiredStringField(record, "taskId", location),
    claimGroupId: requiredStringField(record, "claimGroupId", location),
    workType: requiredStringField(record, "workType", location),
    gapId,
    reasonCode: requiredStringField(record, "reasonCode", location),
    cause: optionalStringField(record, "cause", location),
    scoreProjectionKey: readScoreProjectionKey(record, location),
  };
}

function optionalRatingStatus(currentScore: unknown, location: string): string | null {
  if (currentScore === undefined || currentScore === null) return null;
  const record = requirePlainObject(currentScore, location);
  return optionalStringField(record, "ratingStatus", location);
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function registryItemIdentity(item: RegistryItem): string {
  return [
    item.taskId,
    item.claimGroupId,
    item.gapId ?? "",
    item.reasonCode,
    item.scoreProjectionKey ?? "",
    item.cause ?? "",
  ].join("\u0000");
}

/**
 * SHA-256 over the registry's replay binding plus every open item identity, so a
 * verdict row names exactly which replay and which open-item set were read.
 */
export function missingDataRegistryFingerprint(index: {
  schemaVersion: number;
  binding: RegistryBinding | null;
  items: readonly RegistryItem[];
}): string {
  const identity = {
    schemaVersion: index.schemaVersion,
    binding: index.binding
      ? {
          asOfSec: index.binding.asOfSec,
          candidateId: index.binding.candidateId,
          publicationGenerationId: index.binding.publicationGenerationId,
          baseInputGenerationId: index.binding.baseInputGenerationId,
          factSetDigest: index.binding.factSetDigest,
          resultDigest: index.binding.resultDigest,
          queueDigest: index.binding.queueDigest,
          policyId: index.binding.policyId,
          policyDigest: index.binding.policyDigest,
          evaluationBuildDigest: index.binding.evaluationBuildDigest,
        }
      : null,
    items: index.items.map(registryItemIdentity).sort(compareCodeUnits),
  };
  return createHash("sha256").update(stableJsonStringifyV1(identity)).digest("hex");
}

function readRegistryBinding(
  value: unknown,
  registrySchemaVersion: number,
  location: string,
): RegistryBinding | null {
  if (value === undefined || value === null) return null;
  const parsed = RegistrySnapshotSchema.safeParse(value);
  if (!parsed.success) {
    // A snapshot that exists but cannot name its replay is unbound, not trusted.
    requirePlainObject(value, location);
    return null;
  }
  const snapshot = parsed.data;
  return {
    schemaVersion: registrySchemaVersion,
    asOfSec: snapshot.asOfSec,
    asOfIso: new Date(snapshot.asOfSec * 1000).toISOString(),
    candidateId: snapshot.candidateId,
    publicationGenerationId: snapshot.publicationGenerationId,
    baseInputGenerationId: snapshot.baseInputGenerationId ?? null,
    factSetDigest: snapshot.factSetDigest ?? null,
    resultDigest: snapshot.resultDigest ?? null,
    queueDigest: snapshot.queueDigest ?? null,
    policyId: snapshot.policyId ?? null,
    policyDigest: snapshot.policyDigest ?? null,
    evaluationBuildDigest: snapshot.evaluationBuildDigest ?? null,
  };
}

export function buildRegistryIndex(registryValue: unknown, registryPath: string): RegistryIndex {
  const parsed = RegistrySchema.safeParse(registryValue);
  if (!parsed.success) {
    throw new Error(`${registryPath} is not a Safety Score v9 missing-data registry: ${parsed.error.issues[0]?.message ?? "schema failure"}`);
  }
  const registry = parsed.data;
  const binding = readRegistryBinding(registry.snapshot, registry.schemaVersion, `${registryPath}:snapshot`);
  const assetRatingStatus = new Map<string, string | null>();
  const workTypes = new Set<string>();
  if (registry.workTypeDefinitions && typeof registry.workTypeDefinitions === "object") {
    for (const workType of Object.keys(registry.workTypeDefinitions as Record<string, unknown>)) workTypes.add(workType);
  }
  const items: RegistryItem[] = [];
  const itemsByGroup = new Map<string, RegistryItem[]>();
  const itemsByGapId = new Map<string, RegistryItem[]>();
  const scoreProjectionByKey = new Map<string, RegistryItem>();
  const scoreProjectionByGroupReason = new Map<string, RegistryItem[]>();
  const taskIds = new Set<string>();
  let openItemCount = 0;
  for (const [assetIndex, asset] of registry.stablecoins.entries()) {
    const assetLocation = `${registryPath}:stablecoins[${assetIndex}]`;
    if (assetRatingStatus.has(asset.assetId)) throw new Error(`${assetLocation} duplicates asset id ${asset.assetId}`);
    assetRatingStatus.set(asset.assetId, optionalRatingStatus(asset.currentScore, `${assetLocation}.currentScore`));
    for (const [itemIndex, itemValue] of asset.missingItems.entries()) {
      const location = `${assetLocation}.missingItems[${itemIndex}]`;
      const item = readRegistryItem(itemValue, location);
      if (item.claimGroupId.slice(item.claimGroupId.indexOf(":") + 1) !== asset.assetId) {
        throw new Error(`${location}.claimGroupId ${item.claimGroupId} does not belong to asset ${asset.assetId}`);
      }
      if (taskIds.has(item.taskId)) throw new Error(`${location}.taskId ${item.taskId} is not unique`);
      taskIds.add(item.taskId);
      openItemCount += 1;
      items.push(item);
      const groupItems = itemsByGroup.get(item.claimGroupId);
      if (groupItems) groupItems.push(item);
      else itemsByGroup.set(item.claimGroupId, [item]);
      if (item.gapId) {
        const gapItems = itemsByGapId.get(item.gapId);
        if (gapItems) gapItems.push(item);
        else itemsByGapId.set(item.gapId, [item]);
      }
      if (item.scoreProjectionKey !== null) {
        const projectionKey = `${item.claimGroupId}\u0000${item.scoreProjectionKey}`;
        if (scoreProjectionByKey.has(projectionKey)) {
          throw new Error(`${location} duplicates score projection ${item.scoreProjectionKey} in ${item.claimGroupId}`);
        }
        scoreProjectionByKey.set(projectionKey, item);
        const groupReasonKey = `${item.claimGroupId}\u0000${item.reasonCode}`;
        const reasonItems = scoreProjectionByGroupReason.get(groupReasonKey);
        if (reasonItems) reasonItems.push(item);
        else scoreProjectionByGroupReason.set(groupReasonKey, [item]);
      }
    }
  }
  return {
    schemaVersion: registry.schemaVersion,
    binding,
    fingerprint: missingDataRegistryFingerprint({ schemaVersion: registry.schemaVersion, binding, items }),
    stablecoinCount: registry.stablecoins.length,
    openItemCount,
    assetRatingStatus,
    workTypes,
    itemsByGroup,
    itemsByGapId,
    scoreProjectionByKey,
    scoreProjectionByGroupReason,
    taskIds,
  };
}

/**
 * Normalizes the ledger's heterogeneous sentinel encoding into machine-checkable
 * specs. Narrative strings and unrecognized objects stay explicit so they can
 * block closure instead of being silently dropped.
 */
export function normalizeLedgerSentinels(value: unknown, location: string): NormalizedSentinel[] {
  if (value === undefined || value === null) return [];
  const entries = Array.isArray(value) ? value : [value];
  const sentinels: NormalizedSentinel[] = [];
  for (const [index, entry] of entries.entries()) {
    const entryLocation = `${location}[${index}]`;
    if (typeof entry === "string") {
      sentinels.push({ kind: "narrative", text: entry });
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${entryLocation} must be a sentinel string or object`);
    }
    const record = entry as Record<string, unknown>;
    const gapId = record.doneWhenGapIdAbsent;
    const reason = record.doneWhenScoreReasonAbsent;
    let recognized = false;
    if (typeof gapId === "string") {
      if (gapId.length === 0) throw new Error(`${entryLocation}.doneWhenGapIdAbsent must not be empty`);
      sentinels.push({ kind: "gap", gapId });
      recognized = true;
    } else if (gapId !== undefined && gapId !== null) {
      throw new Error(`${entryLocation}.doneWhenGapIdAbsent must be a string`);
    }
    if (reason === undefined || reason === null) {
      // Fact sentinels record `doneWhenScoreReasonAbsent: null` beside the gap id.
    } else if (typeof reason === "string") {
      if (reason.length === 0) throw new Error(`${entryLocation}.doneWhenScoreReasonAbsent must not be empty`);
      sentinels.push({ kind: "reason", reasonCode: reason, path: null, anyPath: true });
      recognized = true;
    } else if (typeof reason === "object" && !Array.isArray(reason)) {
      const reasonRecord = reason as Record<string, unknown>;
      const reasonCode = reasonRecord.reasonCode;
      if (typeof reasonCode !== "string" || reasonCode.length === 0) {
        throw new Error(`${entryLocation}.doneWhenScoreReasonAbsent.reasonCode must be a non-empty string`);
      }
      const path = reasonRecord.path;
      if (path === undefined || path === null) {
        sentinels.push({ kind: "reason", reasonCode, path: null, anyPath: true });
      } else if (typeof path === "string") {
        sentinels.push({ kind: "reason", reasonCode, path, anyPath: false });
      } else {
        sentinels.push({
          kind: "unresolvable",
          detail: `${entryLocation}.doneWhenScoreReasonAbsent.path is not a string path`,
        });
        continue;
      }
      recognized = true;
    } else {
      throw new Error(`${entryLocation}.doneWhenScoreReasonAbsent must be a string, object, or null`);
    }
    if (!recognized) {
      sentinels.push({ kind: "unresolvable", detail: `${entryLocation} carries no machine-checkable sentinel form` });
    }
  }
  return sentinels;
}

function gapSuccessorExists(
  index: RegistryIndex,
  claimGroupId: string,
  gapId: string,
): RegistryItem | null {
  for (const item of index.itemsByGroup.get(claimGroupId) ?? []) {
    if (!item.gapId) continue;
    // Gap ids are hierarchical (`asset:gap:<component chain>`); a strict `:`-boundary
    // prefix in either direction is sibling succession at the same scope.
    if (item.gapId.startsWith(`${gapId}:`) || gapId.startsWith(`${item.gapId}:`)) return item;
  }
  return null;
}

function itemCauses(items: readonly RegistryItem[]): string[] {
  return sortedUnique(items.map((item) => item.cause ?? "unknown"));
}

function evaluateSentinels(
  index: RegistryIndex,
  claimGroupId: string,
  assetId: string,
  sentinels: readonly NormalizedSentinel[],
): { matches: SentinelMatch[]; narrative: number; unresolvable: number } {
  const matches: SentinelMatch[] = [];
  let narrative = 0;
  let unresolvable = 0;
  for (const sentinel of sentinels) {
    if (sentinel.kind === "narrative") {
      narrative += 1;
      continue;
    }
    if (sentinel.kind === "unresolvable") {
      unresolvable += 1;
      continue;
    }
    if (sentinel.kind === "gap") {
      const gapId = sentinel.gapId!;
      // A gap sentinel must belong to the decision's asset; a foreign id cannot
      // verify this group and must never read as an absent sentinel.
      if (!gapId.startsWith(`${assetId}:`)) {
        unresolvable += 1;
        continue;
      }
      const openItems = index.itemsByGapId.get(gapId) ?? [];
      if (openItems.some((item) => item.cause !== MEASURED_ADVERSE_CAUSE)) {
        matches.push({
          kind: "gap",
          identity: gapId,
          status: "present",
          openItems: openItems.length,
          causes: itemCauses(openItems),
        });
        continue;
      }
      if (openItems.length > 0) {
        matches.push({
          kind: "gap",
          identity: gapId,
          status: "adverse",
          openItems: openItems.length,
          causes: itemCauses(openItems),
        });
        continue;
      }
      const successor = gapSuccessorExists(index, claimGroupId, gapId);
      matches.push(
        successor
          ? {
              kind: "gap",
              identity: gapId,
              status: "successor",
              openItems: (index.itemsByGroup.get(claimGroupId) ?? []).length,
              causes: [successor.gapId ?? ""],
            }
          : { kind: "gap", identity: gapId, status: "absent", openItems: 0, causes: [] },
      );
      continue;
    }
    const reasonCode = sentinel.reasonCode!;
    if (sentinel.anyPath) {
      const openItems =
        index.scoreProjectionByGroupReason.get(`${claimGroupId}\u0000${reasonCode}`) ?? [];
      matches.push(
        openItems.length > 0
          ? {
              kind: "reason",
              identity: `${reasonCode}|*`,
              status: "present",
              openItems: openItems.length,
              causes: itemCauses(openItems),
            }
          : { kind: "reason", identity: `${reasonCode}|*`, status: "absent", openItems: 0, causes: [] },
      );
      continue;
    }
    const identity = `${reasonCode}|${sentinel.path ?? ""}`;
    const projectionKey = `${claimGroupId}\u0000${identity}`;
    if (index.scoreProjectionByKey.has(projectionKey)) {
      const item = index.scoreProjectionByKey.get(projectionKey)!;
      matches.push({
        kind: "reason",
        identity,
        status: "present",
        openItems: 1,
        causes: itemCauses([item]),
      });
      continue;
    }
    const successorItems = (index.scoreProjectionByGroupReason.get(`${claimGroupId}\u0000${reasonCode}`) ?? [])
      .filter((item) => item.scoreProjectionKey !== identity);
    matches.push(
      successorItems.length > 0
        ? {
            kind: "reason",
            identity,
            status: "successor",
            openItems: successorItems.length,
            causes: itemCauses(successorItems),
          }
        : { kind: "reason", identity, status: "absent", openItems: 0, causes: [] },
    );
  }
  return { matches, narrative, unresolvable };
}

function countReasons(rows: readonly SentinelResolutionRow[]): Array<{ reason: SentinelVerdictReason; count: number }> {
  const counts = new Map<SentinelVerdictReason, number>();
  for (const row of rows) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || compareCodeUnits(left.reason, right.reason));
}

function countDeferStates(rows: readonly SentinelResolutionRow[]): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.deferState ?? "none";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || compareCodeUnits(left.key, right.key));
}

function emptyVerdictCounts(): Record<SentinelVerdict, number> {
  return { closed: 0, "still-open": 0, "replaced-adversely": 0, unverifiable: 0 };
}

function emptyAdmissionCounts(): Record<SentinelAdmission, number> {
  return { verified: 0, failed: 0, "not-applicable": 0, unverifiable: 0 };
}

export interface BuildSentinelResolutionReportInput {
  registry: unknown;
  /** SHA-256 of the registry bytes read; the CLI always supplies it so consumers can prove file identity. */
  registrySha256?: string;
  ledger: unknown;
  registryPath: string;
  ledgerPath: string;
  replay?: { value: unknown; path: string };
}

function verifyReplayBinding(
  index: RegistryIndex,
  replayValue: unknown,
  replayPath: string,
): { candidateId: string; asOfSec: number; publicationGenerationId: string } {
  const parsed = ReplaySchema.safeParse(replayValue);
  if (!parsed.success) {
    throw new Error(`${replayPath} is not a Safety Score v9 replay artifact: ${parsed.error.issues[0]?.message ?? "schema failure"}`);
  }
  const candidate = parsed.data.pipeline.candidate;
  const binding = index.binding;
  if (!binding) {
    throw new Error(`${replayPath} cannot be verified: the registry carries no snapshot binding`);
  }
  const comparisons: Array<[string, unknown, unknown]> = [
    ["candidateId", binding.candidateId, candidate.candidateId],
    ["asOfSec", binding.asOfSec, candidate.asOfSec],
    ["publicationGenerationId", binding.publicationGenerationId, candidate.publicationGenerationId],
    ["baseInputGenerationId", binding.baseInputGenerationId, candidate.baseInputGenerationId ?? null],
    ["factSetDigest", binding.factSetDigest, candidate.factSetDigest ?? null],
    ["resultDigest", binding.resultDigest, candidate.resultDigest ?? null],
    ["evaluationBuildDigest", binding.evaluationBuildDigest, candidate.evaluationBuildDigest ?? null],
    ["policyId", binding.policyId, candidate.policy?.id ?? null],
    ["policyDigest", binding.policyDigest, candidate.policy?.semanticDigest ?? null],
  ];
  const mismatches = comparisons.filter(([, registryValue, replayValueEntry]) => {
    if (registryValue === null || registryValue === undefined) return false;
    return registryValue !== replayValueEntry;
  });
  if (mismatches.length > 0) {
    throw new Error(
      `${replayPath} does not belong to this registry: ${mismatches
        .map(([field, registryValue, replayValueEntry]) => `${field} registry=${String(registryValue)} replay=${String(replayValueEntry)}`)
        .join("; ")}`,
    );
  }
  return {
    candidateId: candidate.candidateId,
    asOfSec: candidate.asOfSec,
    publicationGenerationId: candidate.publicationGenerationId,
  };
}

export function buildSentinelResolutionReport(
  input: BuildSentinelResolutionReportInput,
): SentinelResolutionReport {
  const index = buildRegistryIndex(input.registry, input.registryPath);
  const ledger = LedgerSchema.parse(input.ledger);
  const allowedDecisions = new Set(ledger.allowedDecisions);
  const replayBinding = input.replay ? verifyReplayBinding(index, input.replay.value, input.replay.path) : null;

  let latestReviewedAt: { value: string; sec: number } | null = null;
  const latestByGroup = new Map<string, { decision: z.infer<typeof LedgerSchema>["decisions"][number]; index: number }>();
  for (const [decisionIndex, decision] of ledger.decisions.entries()) {
    const location = `${input.ledgerPath}:decisions[${decisionIndex}]`;
    if (!allowedDecisions.has(decision.decision)) {
      throw new Error(`${location}.decision ${decision.decision} is not in the ledger's allowedDecisions roster`);
    }
    const reviewedAtSec = sentinelReviewedAtSec(decision.reviewedAt);
    if (!latestReviewedAt || reviewedAtSec > latestReviewedAt.sec ||
        (reviewedAtSec === latestReviewedAt.sec && compareCodeUnits(decision.reviewedAt, latestReviewedAt.value) > 0)) {
      latestReviewedAt = { value: decision.reviewedAt, sec: reviewedAtSec };
    }
    const current = latestByGroup.get(decision.claimGroupId);
    if (!current || reviewedAtSec >= sentinelReviewedAtSec(current.decision.reviewedAt)) {
      latestByGroup.set(decision.claimGroupId, { decision, index: decisionIndex });
    }
  }

  const rows: SentinelResolutionRow[] = [];
  for (const claimGroupId of [...latestByGroup.keys()].sort(compareCodeUnits)) {
    const { decision, index: ledgerDecisionIndex } = latestByGroup.get(claimGroupId)!;
    const location = `${input.ledgerPath}:${claimGroupId}`;
    const separator = claimGroupId.indexOf(":");
    if (separator <= 0 || separator === claimGroupId.length - 1) {
      throw new Error(`${location} is not a <workType>:<assetId> claim group id`);
    }
    const workType = claimGroupId.slice(0, separator);
    const assetId = claimGroupId.slice(separator + 1);
    const reviewedAtSec = sentinelReviewedAtSec(decision.reviewedAt);
    const sentinels = normalizeLedgerSentinels(decision.sentinels, `${location}.sentinels`);
    const { matches, narrative, unresolvable } = evaluateSentinels(index, claimGroupId, assetId, sentinels);

    const rawTaskIds = decision.taskIds;
    const taskIds: string[] = [];
    if (rawTaskIds !== undefined && rawTaskIds !== null) {
      if (!Array.isArray(rawTaskIds)) throw new Error(`${location}.taskIds must be an array of task ids`);
      for (const taskId of rawTaskIds) {
        if (typeof taskId !== "string" || taskId.length === 0) {
          throw new Error(`${location}.taskIds must contain only non-empty strings`);
        }
        taskIds.push(taskId);
      }
    }
    const groupItems = index.itemsByGroup.get(claimGroupId) ?? [];
    const openTaskIds = new Set(groupItems.map((item) => item.taskId));
    const openTasks = taskIds.filter((taskId) => openTaskIds.has(taskId)).length;

    const present = matches.filter((match) => match.status === "present").length;
    const adverse = matches.filter((match) => match.status === "adverse").length;
    const successor = matches.filter((match) => match.status === "successor").length;
    const absent = matches.length - present - adverse - successor;

    const sentinelCounts = {
      total: sentinels.length,
      machineCheckable: matches.length,
      gap: sentinels.filter((sentinel) => sentinel.kind === "gap").length,
      reason: sentinels.filter((sentinel) => sentinel.kind === "reason").length,
      narrative,
      unresolvable,
      absent,
      present,
      adverse,
      successor,
    };

    const assetPresent = index.assetRatingStatus.has(assetId);
    const ratingStatus = index.assetRatingStatus.get(assetId) ?? null;
    const workTypePresent = index.workTypes.has(workType);
    const blocks: SentinelVerdictReason[] = [];
    if (!index.binding) blocks.push("registry-binding-unavailable");
    else if (reviewedAtSec > index.binding.asOfSec) blocks.push("capture-predates-decision");
    if (!assetPresent) blocks.push("asset-absent-from-registry");
    else if (ratingStatus !== RATED) blocks.push("asset-not-rated");
    if (!workTypePresent) blocks.push("work-type-retired");
    if (sentinelCounts.machineCheckable > 0 && (narrative > 0 || unresolvable > 0)) {
      blocks.push("uncheckable-sentinel");
    }

    let verdict: SentinelVerdict;
    let reason: SentinelVerdictReason;
    if (sentinelCounts.machineCheckable === 0) {
      verdict = "unverifiable";
      reason = sentinels.length === 0
        ? "no-sentinels"
        : unresolvable > 0
          ? "sentinel-unresolvable"
          : "narrative-only-sentinels";
    } else if (present > 0) {
      verdict = "still-open";
      reason = absent + adverse + successor > 0 ? "sentinels-partially-absent" : "sentinels-still-present";
    } else if (adverse > 0) {
      verdict = "replaced-adversely";
      reason = "measured-adverse-successor";
    } else if (successor > 0) {
      verdict = "replaced-adversely";
      reason = "sibling-sentinel-successor";
    } else if (narrative > 0 || unresolvable > 0) {
      verdict = "unverifiable";
      reason = "uncheckable-sentinel";
    } else {
      verdict = "closed";
      reason = groupItems.length === 0 ? "sentinels-absent-group-clear" : "sentinels-absent";
    }

    const decisiveBlock = blocks.find((block) =>
      block === "registry-binding-unavailable" ||
      block === "capture-predates-decision" ||
      block === "asset-absent-from-registry" ||
      (verdict === "closed" && (block === "asset-not-rated" || block === "work-type-retired" || block === "uncheckable-sentinel")));
    if (decisiveBlock) {
      verdict = "unverifiable";
      reason = decisiveBlock;
    }

    const admission: SentinelAdmission = decision.deferState !== STRUCTURED_PENDING_PRODUCTION
      ? "not-applicable"
      : verdict === "closed"
        ? "verified"
        : verdict === "unverifiable"
          ? "unverifiable"
          : "failed";

    rows.push({
      claimGroupId,
      workType,
      assetId,
      decision: decision.decision,
      deferState: decision.deferState ?? null,
      reviewedAt: decision.reviewedAt,
      reviewedAtSec,
      ledgerDecisionIndex,
      verdict,
      reason,
      admission,
      registryFingerprint: index.fingerprint,
      asOfSec: index.binding?.asOfSec ?? null,
      groupState: groupItems.length > 0 ? "open-items" : "no-open-items",
      openItemCount: groupItems.length,
      openTaskCount: openTasks,
      taskIds: { total: taskIds.length, open: openTasks, closed: taskIds.length - openTasks },
      sentinels: sentinelCounts,
      matches,
      residualReasonCodes: sortedUnique(groupItems.map((item) => item.reasonCode)),
      blocks,
    });
  }

  rows.sort((left, right) => compareCodeUnits(left.claimGroupId, right.claimGroupId));

  const verdictCounts = emptyVerdictCounts();
  const admissionCounts = emptyAdmissionCounts();
  const workTypeVerdicts = new Map<string, Record<SentinelVerdict, number>>();
  const sentinelTotals = { total: 0, machineCheckable: 0, absent: 0, present: 0, adverse: 0, successor: 0, narrative: 0, unresolvable: 0 };
  let taskIdEvaluated = 0;
  let taskIdOpen = 0;
  let taskIdClosed = 0;
  for (const row of rows) {
    verdictCounts[row.verdict] += 1;
    admissionCounts[row.admission] += 1;
    sentinelTotals.total += row.sentinels.total;
    sentinelTotals.machineCheckable += row.sentinels.machineCheckable;
    sentinelTotals.absent += row.sentinels.absent;
    sentinelTotals.present += row.sentinels.present;
    sentinelTotals.adverse += row.sentinels.adverse;
    sentinelTotals.successor += row.sentinels.successor;
    sentinelTotals.narrative += row.sentinels.narrative;
    sentinelTotals.unresolvable += row.sentinels.unresolvable;
    taskIdEvaluated += row.taskIds.total;
    taskIdOpen += row.taskIds.open;
    taskIdClosed += row.taskIds.closed;
    const buckets = workTypeVerdicts.get(row.workType) ?? emptyVerdictCounts();
    buckets[row.verdict] += 1;
    workTypeVerdicts.set(row.workType, buckets);
  }
  const closedRows = rows.filter((row) => row.verdict === "closed");
  const summary: SentinelResolutionReport["summary"] = {
    claimGroupCount: rows.length,
    decisionCount: ledger.decisions.length,
    supersededDecisionCount: ledger.decisions.length - rows.length,
    verdictCounts,
    reasonCounts: countReasons(rows),
    admissionCounts,
    deferStateCounts: countDeferStates(rows),
    groupStateCounts: {
      openItems: rows.filter((row) => row.groupState === "open-items").length,
      noOpenItems: rows.filter((row) => row.groupState === "no-open-items").length,
    },
    closure: {
      groups: closedRows.length,
      groupsWithOpenItems: closedRows.filter((row) => row.groupState === "open-items").length,
      openItemsInClosedGroups: closedRows.reduce((total, row) => total + row.openItemCount, 0),
      derivedFactsClosed: closedRows.reduce((total, row) => total + row.taskIds.closed, 0),
    },
    taskIds: { evaluated: taskIdEvaluated, open: taskIdOpen, closed: taskIdClosed },
    sentinels: sentinelTotals,
    workTypeVerdictCounts: [...workTypeVerdicts.entries()]
      .map(([workType, verdicts]) => ({ workType, verdicts }))
      .sort((left, right) => compareCodeUnits(left.workType, right.workType)),
  };

  return {
    schemaVersion: 1,
    title: "Safety Score v9 ledger sentinel resolutions",
    purpose: "Determine, per claim group, whether the latest reviewed decision's machine-checkable sentinels dropped on one fresh replay without an adverse replacement.",
    contract: {
      evaluatedDecision: "latest-appended-decision-per-claim-group",
      closureRequires:
        "Every machine-checkable sentinel absent on the bound registry, no measured-adverse identity and no sibling successor at the same scope, a rated asset, a live work type, and no uncheckable sentinel.",
      admissionAxis:
        "structured-pending-production decisions report admission-verified only on a clean closure; unverifiable never becomes failed and failed never becomes verified.",
    },
    inputs: {
      registryPath: input.registryPath,
      ledgerPath: input.ledgerPath,
      registry: {
        schemaVersion: index.schemaVersion,
        stablecoinCount: index.stablecoinCount,
        openItemCount: index.openItemCount,
        missingDataRegistryFingerprint: index.fingerprint,
        registrySha256: input.registrySha256 ?? null,
        binding: index.binding,
      },
      ledger: {
        schemaVersion: ledger.schemaVersion,
        decisionCount: ledger.decisions.length,
        claimGroupCount: rows.length,
        latestReviewedAt: latestReviewedAt?.value ?? null,
      },
      replay: replayBinding
        ? {
            path: input.replay!.path,
            candidateId: replayBinding.candidateId,
            asOfSec: replayBinding.asOfSec,
            publicationGenerationId: replayBinding.publicationGenerationId,
          }
        : null,
      closureEvidence: !index.binding
        ? "unavailable"
        : replayBinding
          ? "replay-verified"
          : "registry-snapshot",
    },
    summary,
    groups: rows,
  };
}

export function stringifySentinelResolutionReport(report: SentinelResolutionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const MAX_TABLE_ROWS = 40;

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
}

export function renderSentinelResolutionMarkdown(report: SentinelResolutionReport): string {
  const { inputs, summary, groups } = report;
  const binding = inputs.registry.binding;
  const closedRows = groups
    .filter((row) => row.verdict === "closed")
    .sort((left, right) => right.openItemCount - left.openItemCount || compareCodeUnits(left.claimGroupId, right.claimGroupId));
  const replacedRows = groups.filter((row) => row.verdict === "replaced-adversely");
  const unverifiableCounts = new Map<SentinelVerdictReason, { groups: number; openItems: number }>();
  for (const row of groups) {
    if (row.verdict !== "unverifiable") continue;
    const bucket = unverifiableCounts.get(row.reason) ?? { groups: 0, openItems: 0 };
    bucket.groups += 1;
    bucket.openItems += row.openItemCount;
    unverifiableCounts.set(row.reason, bucket);
  }
  const unverifiableReasonRows = [...unverifiableCounts.entries()]
    .map(([reason, counts]) => ({ reason, ...counts }))
    .sort((left, right) => right.groups - left.groups || compareCodeUnits(left.reason, right.reason));

  const lines = [
    "# Safety Score v9 ledger sentinel resolutions",
    "",
    `Missing-data registry: \`${inputs.registry.missingDataRegistryFingerprint}\` at ${binding?.asOfIso ?? "an unavailable clock"} (candidate ${binding?.candidateId ?? "unknown"}, publication generation ${binding?.publicationGenerationId ?? "unknown"}).`,
    `Reviewed ledger: ${inputs.ledgerPath} — ${inputs.ledger.decisionCount} decisions over ${inputs.ledger.claimGroupCount} claim groups; latest review ${inputs.ledger.latestReviewedAt ?? "none"}.`,
    inputs.replay
      ? `Replay binding: **replay-verified** against ${inputs.replay.path} (${inputs.replay.candidateId} at ${new Date(inputs.replay.asOfSec * 1000).toISOString()}).`
      : inputs.closureEvidence === "registry-snapshot"
        ? "Replay binding: not supplied; closure verdicts rest on the registry's own snapshot bindings."
        : "Replay binding: **unavailable** — no closure verdict can be booked from this registry.",
    "",
    `Verdicts: closed ${summary.verdictCounts.closed} · still-open ${summary.verdictCounts["still-open"]} · replaced-adversely ${summary.verdictCounts["replaced-adversely"]} · unverifiable ${summary.verdictCounts.unverifiable}.`,
    `Admission for structured-pending-production: verified ${summary.admissionCounts.verified} · failed ${summary.admissionCounts.failed} · unverifiable ${summary.admissionCounts.unverifiable} · not-applicable ${summary.admissionCounts["not-applicable"]}.`,
    `Machine-checkable sentinels: ${summary.sentinels.machineCheckable} (absent ${summary.sentinels.absent} · present ${summary.sentinels.present} · measured-adverse ${summary.sentinels.adverse} · sibling successor ${summary.sentinels.successor}); narrative ${summary.sentinels.narrative} · unresolvable ${summary.sentinels.unresolvable}.`,
    "",
    "A closed row means every machine-checkable sentinel was absent on this registry with no measured-adverse or sibling successor and no closure blocker. Nothing in this report appends a ledger decision, and no row moves a published score.",
    "",
    `## Closure-bookable groups (${summary.closure.groups}; ${summary.closure.groupsWithOpenItems} still carry items; ${summary.closure.derivedFactsClosed} decision task ids are absent from the registry)`,
    "",
  ];
  if (closedRows.length === 0) {
    lines.push("No claim group is closure-bookable on this registry.", "");
  } else {
    lines.push(
      "| Claim group | Decision | Reviewed | Open items | Derived facts closed | Reason |",
      "|---|---|---|---:|---:|---|",
      ...closedRows.slice(0, MAX_TABLE_ROWS).map((row) =>
        `| ${escapeMarkdownCell(row.claimGroupId)} | ${row.decision} | ${row.reviewedAt} | ${row.openItemCount} | ${row.taskIds.closed} | ${row.reason} |`),
      "",
    );
    if (closedRows.length > MAX_TABLE_ROWS) {
      lines.push(`Showing the ${MAX_TABLE_ROWS} closed groups with the most open items; ${closedRows.length - MAX_TABLE_ROWS} more are in the JSON report.`, "");
    }
  }
  lines.push(`## Replaced adversely (${summary.verdictCounts["replaced-adversely"]})`, "");
  if (replacedRows.length === 0) {
    lines.push("None: no dropped sentinel became a measured-adverse fact or a sibling successor.", "");
  } else {
    lines.push(
      "| Claim group | Decision | Reviewed | Reason | Open items |",
      "|---|---|---|---|---:|",
      ...replacedRows.slice(0, MAX_TABLE_ROWS).map((row) =>
        `| ${escapeMarkdownCell(row.claimGroupId)} | ${row.decision} | ${row.reviewedAt} | ${row.reason} | ${row.openItemCount} |`),
      "",
    );
  }
  lines.push(`## Unverifiable (${summary.verdictCounts.unverifiable}) — by machine reason`, "");
  if (unverifiableReasonRows.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push(
      "| Reason | Groups | Open items |",
      "|---|---:|---:|",
      ...unverifiableReasonRows.map((entry) => `| ${entry.reason} | ${entry.groups} | ${entry.openItems} |`),
      "",
    );
  }
  lines.push(`## Still open (${summary.verdictCounts["still-open"]}) — by work type`, "");
  const stillOpenByWorkType = summary.workTypeVerdictCounts
    .filter((entry) => entry.verdicts["still-open"] > 0)
    .sort((left, right) => right.verdicts["still-open"] - left.verdicts["still-open"] || compareCodeUnits(left.workType, right.workType));
  lines.push(
    "| Work type | Still-open groups | Closed groups |",
    "|---|---:|---:|",
    ...stillOpenByWorkType.map((entry) => `| ${entry.workType} | ${entry.verdicts["still-open"]} | ${entry.verdicts.closed} |`),
    "",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

export interface SentinelCheckIo {
  /** Parse one JSON artifact and return the SHA-256 of the exact bytes parsed. */
  readJson(path: string): { value: unknown; sha256: string };
  writeText(path: string, contents: string): void;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

const DEFAULT_IO: SentinelCheckIo = {
  readJson: (path) => {
    const bytes = readFileSync(path);
    return {
      value: JSON.parse(bytes.toString("utf8")) as unknown,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  },
  writeText: (path, contents) => {
    writeFileResolved(path, contents);
  },
  stdout: process.stdout,
  stderr: process.stderr,
};

export function runV9LedgerSentinelCheckCli(
  argv: readonly string[],
  io: SentinelCheckIo = DEFAULT_IO,
): SentinelResolutionReport | null {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      registry: { type: "string" },
      ledger: { type: "string" },
      replay: { type: "string" },
      output: { type: "string" },
      markdown: { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, io.stdout)) return null;
  const registryPath = requireCliString(values.registry, "--registry");
  const ledgerPath = typeof values.ledger === "string" ? values.ledger : DEFAULT_LEDGER_PATH;
  const registryInput = io.readJson(registryPath);
  const report = buildSentinelResolutionReport({
    registry: registryInput.value,
    registrySha256: registryInput.sha256,
    ledger: io.readJson(ledgerPath).value,
    registryPath,
    ledgerPath,
    ...(typeof values.replay === "string"
      ? { replay: { value: io.readJson(values.replay).value, path: values.replay } }
      : {}),
  });
  const serialized = stringifySentinelResolutionReport(report);
  if (values.output !== undefined) io.writeText(requireCliString(values.output, "--output"), serialized);
  else io.stdout.write(serialized);
  if (values.markdown !== undefined) {
    io.writeText(requireCliString(values.markdown, "--markdown"), renderSentinelResolutionMarkdown(report));
  }
  io.stderr.write(
    `safety-score-v9:ledger-sentinels: ${report.summary.claimGroupCount} claim groups; closed ${report.summary.verdictCounts.closed}, still-open ${report.summary.verdictCounts["still-open"]}, replaced-adversely ${report.summary.verdictCounts["replaced-adversely"]}, unverifiable ${report.summary.verdictCounts.unverifiable}; registry ${report.inputs.registry.missingDataRegistryFingerprint} at asOf ${report.inputs.registry.binding?.asOfIso ?? "unavailable"}; evidence ${report.inputs.closureEvidence}\n`,
  );
  return report;
}

runDirectCli(import.meta.url, () => runV9LedgerSentinelCheckCli(process.argv.slice(2)), {
  label: "safety-score-v9:ledger-sentinels",
  usage: USAGE,
});

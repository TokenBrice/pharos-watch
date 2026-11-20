import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  SENTINEL_CHECKER_VERSION,
  SentinelResolutionsArtifactSchema,
  type SentinelResolutionFields,
  type SentinelVerdict,
} from "../lib/sentinel-resolution-contract";
import {
  parseStrictCliArgs,
  requireCliString,
  runDirectCli,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import {
  CURATION_LEDGER_PATH,
  CURATION_RESOLUTION_MODES,
  CURATION_WORK_TYPES,
  LedgerAppendError,
  appendCurationLedgerDecisions,
  canonicalLedgerJson,
  indexLatestCurationDecisions,
  ledgerSentinelList,
  normalizeWritableLedgerSentinel,
  parseLedgerSentinel,
  readCurationLedger,
  sha256Hex,
  writeCurationLedger,
  type CurationLedger,
  type CurationLedgerDecision,
  type LedgerSentinel,
  type NewCurationLedgerDecision,
} from "./ledger-append";
import type { ResolutionMode, WorkType } from "../lib/safety-score-v9-missing-data-work-types";

/**
 * Apply sentinel-sweep verdicts as append-only curation-ledger decisions.
 *
 * The sweep checker (`worker/scripts/check-safety-score-v9-ledger-sentinels.ts`)
 * owns verdicts and the artifact read here: one row per claim group's latest
 * decision, the verdict axis `closed | still-open | replaced-adversely |
 * unverifiable`, and a separate `admission` axis for
 * structured-pending-production (SPP) decisions. This applier re-verifies the
 * parts it can re-derive from the registry it was handed (sentinel absence,
 * group task rows, factsClosed) and books:
 *
 *   closed (SPP admission verified)                  -> promote
 *   still-open + reason `sentinels-partially-absent` -> partial promote
 *
 * A closure needs the checker's per-sentinel matches: only a `closed` verdict
 * with every match `absent` books fully, a split needs at least one
 * checker-confirmed `absent` match, and every non-absent (present, adverse,
 * successor) sentinel is carried, never dropped. `factsClosed` counts the
 * verified-absent sentinels over the decision's task rows and requires a
 * one-to-one task/sentinel mapping (`ambiguous-task-mapping` otherwise): each
 * surviving recorded task row must be held open by a carried sentinel, each
 * carried sentinel must keep exactly one distinct task row (successor scopes
 * match per sentinel; a reason sentinel whose schema-3 projection lost its
 * supplemental task row maps through the projection's single
 * `coveredByTaskIds` entry), and task rows that rotate with
 * the registry carry their current ids forward.
 *
 * Every other verdict is reported and never booked. An SPP row whose admission
 * has not verified is a wait state, never a reviewed rejection: it is skipped
 * with `spp-admission-failed` and books nothing. Nothing is booked when the
 * artifact was not replay-verified, predates the current checker version
 * (`checker-version-mismatch`; archived verdicts must be regenerated before
 * booking), names a different registry digest, clock or ledger version, the
 * group's latest decision is already booked, the asset is quarantined or not
 * rated (`asset-not-rated`), a sentinel is still open (or prose), the
 * task/sentinel mapping is not one-to-one over distinct checker identities, or
 * no task row closed.
 */

const STRUCTURED_PENDING_PRODUCTION = "structured-pending-production";
const SPLIT_REASON = "sentinels-partially-absent";
const REQUIRED_CLOSURE_EVIDENCE = "replay-verified";

export type SentinelApplyFailureReason =
  | "resolutions-schema-invalid"
  | "checker-version-mismatch"
  | "closure-evidence-insufficient"
  | "registry-schema-invalid"
  | "registry-fingerprint-mismatch"
  | "capture-clock-mismatch"
  | "duplicate-resolution-row"
  | "run-id-invalid"
  | "ledger-append-rejected";

export class SentinelApplyError extends Error {
  readonly reason: SentinelApplyFailureReason;

  constructor(reason: SentinelApplyFailureReason, message: string) {
    super(`${reason}: ${message}`);
    this.name = "SentinelApplyError";
    this.reason = reason;
  }
}

const nonEmptyText = z.string().refine((value) => value.trim().length > 0, "must not be blank");
const clockSec = z.number().int().nonnegative();

/** The per-sentinel verdicts this applier consumes from one checker row. */
const CHECKER_MATCH_STATUSES = ["absent", "present", "adverse", "successor"] as const;
type CheckerMatchStatus = (typeof CHECKER_MATCH_STATUSES)[number];

const SentinelMatchSchema = z.object({
  kind: z.enum(["gap", "reason"]),
  identity: nonEmptyText,
  status: z.enum(CHECKER_MATCH_STATUSES),
  /** For gap successors, the successor gap id that occupies the sentinel's scope. */
  causes: z.array(z.string()).optional(),
});

type SentinelResolutionRow = SentinelResolutionFields & {
  matches: readonly z.infer<typeof SentinelMatchSchema>[];
};

export interface SentinelResolutions {
  schemaVersion: 1;
  /** SHA-256 of the exact registry bytes the checker read; matched against the registry handed to the applier. */
  registrySha256: string;
  /** Checker identity fingerprint (replay binding plus open-item set); carried into booked evidence. */
  identityFingerprint: string;
  captureClockSec: number;
  ledgerDecisionCount: number;
  rows: readonly SentinelResolutionRow[];
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

/**
 * Read a checker artifact this applier is willing to book from. Only
 * replay-verified sweeps qualify: a registry-snapshot run has no replay to
 * cross-check, so its `closed` rows must not reach the ledger.
 */
export function parseSentinelResolutions(value: unknown): SentinelResolutions {
  const parsed = SentinelResolutionsArtifactSchema.safeParse(value);
  if (!parsed.success) {
    throw new SentinelApplyError("resolutions-schema-invalid", describeIssues(parsed.error));
  }
  const artifact = parsed.data;
  // Verdict semantics are versioned: an archived artifact predates checker
  // fixes (adverse-replacement and successor detection) and must be
  // regenerated with the current checker before it may book anything.
  if (artifact.inputs.checkerVersion !== SENTINEL_CHECKER_VERSION) {
    throw new SentinelApplyError(
      "checker-version-mismatch",
      `inputs.checkerVersion is ${artifact.inputs.checkerVersion ?? "absent"}; this applier books only ` +
        `checker version ${SENTINEL_CHECKER_VERSION} artifacts — regenerate archived verdicts before booking`,
    );
  }
  const closureEvidence = artifact.inputs.closureEvidence;
  if (closureEvidence !== REQUIRED_CLOSURE_EVIDENCE) {
    throw new SentinelApplyError(
      "closure-evidence-insufficient",
      `inputs.closureEvidence is ${closureEvidence}; only ${REQUIRED_CLOSURE_EVIDENCE} artifacts may book closures`,
    );
  }
  const captureClockSec = artifact.inputs.registry.binding?.asOfSec;
  if (captureClockSec === undefined) {
    throw new SentinelApplyError(
      "resolutions-schema-invalid",
      "inputs.registry.binding.asOfSec is required to prove the capture clock",
    );
  }
  const identityFingerprint = artifact.inputs.registry.missingDataRegistryFingerprint;
  const rows: SentinelResolutionRow[] = [];
  for (const [index, row] of artifact.groups.entries()) {
    if (row.registryFingerprint !== undefined && row.registryFingerprint !== identityFingerprint) {
      throw new SentinelApplyError(
        "resolutions-schema-invalid",
        `groups.${index}: registryFingerprint disagrees with inputs.registry.missingDataRegistryFingerprint`,
      );
    }
    if (row.asOfSec !== undefined && row.asOfSec !== captureClockSec) {
      throw new SentinelApplyError(
        "resolutions-schema-invalid",
        `groups.${index}: asOfSec ${row.asOfSec} disagrees with inputs.registry.binding.asOfSec ${captureClockSec}`,
      );
    }
    const matches = SentinelMatchSchema.array().safeParse((row as { matches?: unknown }).matches);
    if (!matches.success) {
      throw new SentinelApplyError(
        "resolutions-schema-invalid",
        `groups.${index}.matches: expected the checker's per-sentinel match statuses`,
      );
    }
    rows.push({
      claimGroupId: row.claimGroupId,
      verdict: row.verdict,
      reason: row.reason,
      admission: row.admission,
      ledgerDecisionIndex: row.ledgerDecisionIndex,
      ...(row.openItemCount === undefined ? {} : { openItemCount: row.openItemCount }),
      matches: matches.data,
    });
  }
  return {
    schemaVersion: 1,
    registrySha256: artifact.inputs.registry.registrySha256,
    identityFingerprint,
    captureClockSec,
    ledgerDecisionCount: artifact.inputs.ledger.decisionCount,
    rows,
  };
}

const RegistryItemSchema = z
  .object({
    taskId: nonEmptyText,
    claimGroupId: nonEmptyText,
    gapId: nonEmptyText.nullable(),
    reasonCode: nonEmptyText,
    doneWhenScoreReasonAbsent: z
      .object({ reasonCode: nonEmptyText, path: z.unknown() })
      .nullable()
      .optional(),
  })
  .passthrough();

/** Schema-3 score projection: identity plus the compiled tasks covering it. */
const ProjectionGapSchema = z
  .object({
    reasonCode: nonEmptyText,
    workType: nonEmptyText,
    path: z.string().nullable().optional(),
    coveredByTaskIds: z.array(nonEmptyText).optional(),
  })
  .passthrough();

const RegistryAssetSchema = z
  .object({
    assetId: nonEmptyText,
    currentScore: z
      .object({ ratingStatus: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    missingItems: z.array(RegistryItemSchema),
    scoreProjectionGaps: z.array(ProjectionGapSchema).optional(),
  })
  .passthrough();

const RegistrySchema = z
  .object({
    // Schema 3 keeps the task rows, sentinels and asset identity this applier
    // reads unchanged; it only adds bands the applier does not consume.
    schemaVersion: z.union([z.literal(2), z.literal(3)]),
    snapshot: z.object({ asOfSec: clockSec }).passthrough(),
    stablecoins: z.array(RegistryAssetSchema),
  })
  .passthrough();

type RegistryItem = z.infer<typeof RegistryItemSchema>;

export interface RegistryGroupIndex {
  items: readonly RegistryItem[];
  taskIds: ReadonlySet<string>;
  gapIds: ReadonlySet<string>;
  reasonCodes: ReadonlySet<string>;
  reasonPairs: ReadonlySet<string>;
  /**
   * Schema-3 score projections for this claim group keyed by the checker's
   * reason identity (`reasonCode|path`), holding `coveredByTaskIds`.
   */
  projectionCoverage: ReadonlyMap<string, readonly string[]>;
}

export interface RegistryIndex {
  fingerprint: string;
  captureClockSec: number;
  groups: ReadonlyMap<string, RegistryGroupIndex>;
  assetIds: ReadonlySet<string>;
  ratingStatusByAsset: ReadonlyMap<string, string | null>;
  /** Live task rows per asset across work types: a schema-3 projection's covering task can live in another work type's group. */
  assetTaskIds: ReadonlyMap<string, ReadonlySet<string>>;
}

function reasonPairKey(reasonCode: string, path: unknown): string {
  return `${reasonCode}\u0000${canonicalLedgerJson(path ?? null)}`;
}

/**
 * Validate the sweep's registry artifact and index only what the applier reads:
 * group task rows, sentinel keys and asset rating status.
 */
export function buildRegistryIndex(rawRegistry: unknown, fingerprint: string): RegistryIndex {
  const parsed = RegistrySchema.safeParse(rawRegistry);
  if (!parsed.success) {
    throw new SentinelApplyError("registry-schema-invalid", describeIssues(parsed.error));
  }
  const groups = new Map<string, {
    items: RegistryItem[];
    taskIds: Set<string>;
    gapIds: Set<string>;
    reasonCodes: Set<string>;
    reasonPairs: Set<string>;
    projectionCoverage: Map<string, readonly string[]>;
  }>();
  const assetIds = new Set<string>();
  const ratingStatusByAsset = new Map<string, string | null>();
  const assetTaskIds = new Map<string, Set<string>>();
  // Schema-3 projection coverage keyed by the projection's own claim group
  // (`workType:assetId`), mirroring the checker's identity indexing.
  const projectionCoverageByGroup = new Map<string, Map<string, readonly string[]>>();
  for (const asset of parsed.data.stablecoins) {
    assetIds.add(asset.assetId);
    ratingStatusByAsset.set(asset.assetId, asset.currentScore?.ratingStatus ?? null);
    const assetTasks = new Set<string>();
    assetTaskIds.set(asset.assetId, assetTasks);
    for (const gap of asset.scoreProjectionGaps ?? []) {
      const claimGroupId = `${gap.workType}:${asset.assetId}`;
      let coverage = projectionCoverageByGroup.get(claimGroupId);
      if (!coverage) {
        coverage = new Map();
        projectionCoverageByGroup.set(claimGroupId, coverage);
      }
      const identity = `${gap.reasonCode}|${gap.path ?? ""}`;
      if (!coverage.has(identity)) coverage.set(identity, gap.coveredByTaskIds ?? []);
    }
    for (const item of asset.missingItems) {
      let group = groups.get(item.claimGroupId);
      if (!group) {
        group = {
          items: [],
          taskIds: new Set(),
          gapIds: new Set(),
          reasonCodes: new Set(),
          reasonPairs: new Set(),
          projectionCoverage: projectionCoverageByGroup.get(item.claimGroupId) ?? new Map(),
        };
        groups.set(item.claimGroupId, group);
      }
      group.items.push(item);
      group.taskIds.add(item.taskId);
      assetTasks.add(item.taskId);
      if (item.gapId !== null) group.gapIds.add(item.gapId);
      group.reasonCodes.add(item.reasonCode);
      const reason = item.doneWhenScoreReasonAbsent;
      if (reason) group.reasonPairs.add(reasonPairKey(reason.reasonCode, reason.path));
    }
  }
  // Projection-only groups carry no task rows; indexing them keeps reason
  // absence checkable against scoreProjectionGaps when every row retired.
  for (const [claimGroupId, coverage] of projectionCoverageByGroup) {
    if (groups.has(claimGroupId)) continue;
    groups.set(claimGroupId, {
      items: [],
      taskIds: new Set<string>(),
      gapIds: new Set<string>(),
      reasonCodes: new Set<string>(),
      reasonPairs: new Set<string>(),
      projectionCoverage: coverage,
    });
  }
  return {
    fingerprint,
    captureClockSec: parsed.data.snapshot.asOfSec,
    groups,
    assetIds,
    ratingStatusByAsset,
    assetTaskIds,
  };
}

export interface SentinelEvaluation {
  machineCheckable: boolean;
  absent: boolean;
  absentLabels: string[];
  openLabels: string[];
}

/**
 * Evaluate one ledger sentinel against its own claim group's open rows. A gap
 * condition counts as absent only when no live gap id occupies its scope under
 * the checker's gap matcher (exact id, `:`-boundary child or parent, raw or
 * generation-normalized). A reason-pair condition counts as absent only when
 * neither the exact pair nor the reason code appears in the group; that keeps
 * path-format drift from manufacturing a closure. Schema-3
 * `scoreProjectionGaps` is the authority for reason absence (the checker's
 * registry matcher): a reason that only lost its supplemental task row but
 * stays score-visible is present, never absent.
 */
export function evaluateSentinel(
  sentinel: unknown,
  group: RegistryGroupIndex | undefined,
): SentinelEvaluation {
  const conditions = parseLedgerSentinel(sentinel);
  if (!conditions.machineCheckable) {
    return { machineCheckable: false, absent: false, absentLabels: [], openLabels: [] };
  }
  const gapIds = group?.gapIds ?? new Set<string>();
  const reasonCodes = group?.reasonCodes ?? new Set<string>();
  const reasonPairs = group?.reasonPairs ?? new Set<string>();
  const result: SentinelEvaluation = {
    machineCheckable: true,
    absent: true,
    absentLabels: [],
    openLabels: [],
  };
  for (const gapId of conditions.gapIds) {
    const occupant = [...gapIds].find((liveGapId) => gapScopeOccupied(gapId, liveGapId));
    if (occupant !== undefined) {
      result.absent = false;
      result.openLabels.push(`gapId ${gapId} scope still occupied by ${occupant}`);
    } else {
      result.absentLabels.push(`gapId ${gapId} absent`);
    }
  }
  for (const pair of conditions.reasonPairs) {
    if (reasonPairs.has(`${pair.reasonCode}\u0000${pair.pathKey}`) || reasonCodes.has(pair.reasonCode)) {
      result.absent = false;
      result.openLabels.push(`reasonCode ${pair.reasonCode} at ${pair.pathKey} still open`);
    } else {
      result.absentLabels.push(`reasonCode ${pair.reasonCode} at ${pair.pathKey} absent`);
    }
  }
  for (const reasonCode of conditions.reasonCodes) {
    if (reasonCodes.has(reasonCode)) {
      result.absent = false;
      result.openLabels.push(`reasonCode ${reasonCode} still open`);
    } else {
      result.absentLabels.push(`reasonCode ${reasonCode} absent`);
    }
  }
  const coverage = group?.projectionCoverage;
  if (coverage !== undefined) {
    for (const key of sentinelMatchKeys(sentinel)) {
      if (!key.startsWith("reason\u0000")) continue;
      const identity = key.slice("reason\u0000".length);
      // Match the checker's registry matcher over the reason code: `reason|*`
      // is path-agnostic, and an exact path whose reason survives at another
      // path is a successor, never an absence.
      const prefix = `${identity.slice(0, identity.indexOf("|") + 1)}`;
      for (const projectionIdentity of coverage.keys()) {
        if (!projectionIdentity.startsWith(prefix)) continue;
        result.absent = false;
        result.openLabels.push(`scoreProjectionGaps still lists ${projectionIdentity}`);
      }
    }
  }
  return result;
}

/** How the checker's per-sentinel matches judge one ledger sentinel entry. */
export type CheckerSentinelStatus = "absent" | "present" | "adverse" | "successor" | "unmatched";

function matchIdentityKey(kind: string, identity: string): string {
  return `${kind}\u0000${identity}`;
}

/** A route-generation component inside a gap id: a dashed UUID that rotates on re-ingestion. */
const GENERATION_COMPONENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Gap scope with route-generation components removed, mirroring the checker's `gapScopeKey`. */
function gapScopeKey(gapId: string): string {
  return gapId
    .split(":")
    .filter((component) => !GENERATION_COMPONENT.test(component))
    .join(":");
}

/**
 * The checker's gap matcher, mirrored for absence re-verification: a live gap id
 * occupies the sentinel's scope when it is the same id or a strict `:`-boundary
 * child or parent of it — on raw ids or on generation-normalized scopes, so a
 * retired parent whose scope a rotated child still holds is never absent.
 */
function gapScopeOccupied(sentinelGapId: string, liveGapId: string): boolean {
  if (liveGapId.startsWith(`${sentinelGapId}:`) || sentinelGapId.startsWith(`${liveGapId}:`)) {
    return true;
  }
  const sentinelScope = gapScopeKey(sentinelGapId);
  const liveScope = gapScopeKey(liveGapId);
  return (
    liveScope.startsWith(`${sentinelScope}:`) ||
    sentinelScope.startsWith(`${liveScope}:`) ||
    liveScope === sentinelScope
  );
}

/**
 * The checker's identity normalization, mirrored here so both sides align one
 * ledger sentinel to the same match: `gap <id>` and `reason <reasonCode>|<path>`,
 * with `|*` for a path-agnostic reason (a string reason or a reason object
 * without a path). A non-string, non-null path stays unmatchable.
 */
function sentinelMatchKeys(sentinel: unknown): string[] {
  if (typeof sentinel !== "object" || sentinel === null || Array.isArray(sentinel)) return [];
  const record = sentinel as Record<string, unknown>;
  const keys: string[] = [];
  const gap = record.doneWhenGapIdAbsent;
  if (typeof gap === "string" && gap.trim().length > 0) keys.push(matchIdentityKey("gap", gap));
  const reason = record.doneWhenScoreReasonAbsent;
  if (typeof reason === "string" && reason.trim().length > 0) {
    keys.push(matchIdentityKey("reason", `${reason}|*`));
  } else if (typeof reason === "object" && reason !== null && !Array.isArray(reason)) {
    const reasonRecord = reason as Record<string, unknown>;
    if (typeof reasonRecord.reasonCode === "string" && reasonRecord.reasonCode.length > 0) {
      const path = reasonRecord.path;
      const pathIdentity = typeof path === "string" ? path : path === undefined || path === null ? "*" : "";
      keys.push(matchIdentityKey("reason", `${reasonRecord.reasonCode}|${pathIdentity}`));
    }
  }
  return keys;
}

/**
 * Align one ledger sentinel entry with the checker's match statuses. The
 * checker's identities are `gap <id>` and `reason <reasonCode>|<path or *>`;
 * an entry the artifact does not confirm is `unmatched` and can never book.
 */
export function checkerSentinelStatus(
  sentinel: unknown,
  matches: ReadonlyMap<string, CheckerMatchStatus>,
): CheckerSentinelStatus {
  const identities = sentinelMatchKeys(sentinel);
  if (identities.length === 0) return "unmatched";
  let status: CheckerSentinelStatus = "absent";
  for (const identity of identities) {
    const match = matches.get(identity);
    if (match === undefined || match === "absent") {
      if (match === undefined) return "unmatched";
      continue;
    }
    if (status === "absent") status = match;
  }
  return status;
}

export type SentinelSkipReason =
  | "already-applied"
  | "stale-ledger-basis"
  | "ledger-advanced"
  | "missing-ledger-group"
  | "latest-decision-reject"
  | "unknown-work-type"
  | "unknown-resolution-mode"
  | "missing-sentinel"
  | "non-machine-sentinel"
  | "sentinel-still-open"
  | "stale-row-count"
  | "quarantined-or-missing-asset"
  | "asset-not-rated"
  | "no-derived-closure"
  | "ambiguous-task-mapping"
  | "spp-state-mismatch"
  | "spp-admission-failed"
  | "verdict-not-bookable";

export interface SkippedResolution {
  claimGroupId: string;
  verdict: SentinelVerdict;
  reason: SentinelSkipReason;
  detail: string;
}

export interface BookedClosure {
  claimGroupId: string;
  verdict: SentinelVerdict;
  factsClosed: number;
  closedTaskIds: readonly string[];
  remainingTaskIds: readonly string[];
  decisionRecord: NewCurationLedgerDecision;
}

export interface ApplySentinelClosuresInput {
  ledger: CurationLedger;
  registry: unknown;
  resolutions: unknown;
  /** SHA-256 of the exact registry bytes read by the caller. */
  registryFingerprint: string;
  /** Suffix appended to `sentinel-sweep/`; defaults to the artifact's capture clock. */
  runId?: string;
}

export interface ApplySentinelClosuresResult {
  ledger: CurationLedger;
  captureClockSec: number;
  booked: readonly BookedClosure[];
  skipped: readonly SkippedResolution[];
}

function claimGroupAssetIds(claimGroupId: string): string[] {
  const separator = claimGroupId.indexOf(":");
  if (separator <= 0) return [];
  return claimGroupId.slice(separator + 1).split("+").filter((value) => value.length > 0);
}

function assetUnavailable(registry: RegistryIndex, claimGroupId: string): boolean {
  const assetIds = claimGroupAssetIds(claimGroupId);
  if (assetIds.length === 0) return true;
  for (const assetId of assetIds) {
    if (!registry.assetIds.has(assetId)) return true;
    if (registry.ratingStatusByAsset.get(assetId) === "pipeline-gap") return true;
  }
  return false;
}

/**
 * The checker's closure contract requires a rated asset; it holds partial
 * promotions to the same bar because a promote still asserts score-facing
 * facts. Mirrors its `asset-not-rated` block here so the applier never books
 * what the checker's blocks hold unverifiable.
 */
function assetNotRated(registry: RegistryIndex, claimGroupId: string): boolean {
  return claimGroupAssetIds(claimGroupId).some(
    (assetId) => registry.ratingStatusByAsset.get(assetId) !== "rated",
  );
}

/**
 * Live task rows on this claim group's assets, across work types: a schema-3
 * projection's `coveredByTaskIds` names compiled task rows that live in another
 * work type's group on the same asset, so both the covering-task check and the
 * carried-ID filter on the next sweep resolve against the asset, not the group.
 */
function groupAssetTaskIds(registry: RegistryIndex, claimGroupId: string): ReadonlySet<string> {
  const taskIds = new Set<string>();
  for (const assetId of claimGroupAssetIds(claimGroupId)) {
    for (const taskId of registry.assetTaskIds.get(assetId) ?? []) taskIds.add(taskId);
  }
  return taskIds;
}

function sentinelCarryForward(
  evaluationSentinels: readonly { sentinel: unknown; checkerStatus: CheckerSentinelStatus }[],
): LedgerSentinel[] {
  const carried: LedgerSentinel[] = [];
  for (const { sentinel, checkerStatus } of evaluationSentinels) {
    // Only checker-confirmed absences retire an obligation; present, adverse
    // and successor matches all survive as carried sentinels.
    if (checkerStatus === "absent") continue;
    const writable = normalizeWritableLedgerSentinel(sentinel);
    if (writable !== null) carried.push(writable);
  }
  return carried;
}

/**
 * One registry item keeps a carried (non-absent) sentinel entry open when it
 * satisfies any of that entry's completion conditions, mirroring
 * `evaluateSentinel`'s openness test per item. The checker's path-agnostic
 * identities also keep their item open — a successor match (same reason code
 * at a different path) and a reason object without a path (`reason|*`) — so
 * the obligation's current task id is carried instead of dropped.
 */
function itemKeepsEntryOpen(item: RegistryItem, sentinel: unknown, checkerStatus: CheckerSentinelStatus): boolean {
  const conditions = parseLedgerSentinel(sentinel);
  if (item.gapId !== null && conditions.gapIds.includes(item.gapId)) return true;
  if (item.doneWhenScoreReasonAbsent && typeof item.doneWhenScoreReasonAbsent === "object") {
    const reason = item.doneWhenScoreReasonAbsent as { reasonCode?: unknown; path?: unknown };
    if (typeof reason.reasonCode === "string") {
      if (conditions.reasonCodes.includes(reason.reasonCode)) return true;
      if (
        conditions.reasonPairs.some(
          (pair) =>
            pair.reasonCode === reason.reasonCode &&
            // `reason|*` (a reason object without a path) asserts the reason
            // code itself, so any task row of that code keeps the entry open.
            (checkerStatus === "successor" || pair.pathKey === "null"),
        )
      ) {
        return true;
      }
      const pathKey = canonicalLedgerJson(reason.path ?? null);
      if (conditions.reasonPairs.some((pair) => pair.reasonCode === reason.reasonCode && pair.pathKey === pathKey)) {
        return true;
      }
    }
  }
  return conditions.reasonCodes.includes(item.reasonCode);
}

/**
 * Whether one registry item holds open any carried (non-absent) sentinel —
 * directly, or by occupying a checker-named successor gap scope.
 */
function itemHoldsCarriedSentinel(
  item: RegistryItem,
  evaluations: readonly { sentinel: unknown; checkerStatus: CheckerSentinelStatus }[],
  successorGapIds: ReadonlySet<string>,
): boolean {
  if (item.gapId !== null && successorGapIds.has(item.gapId)) return true;
  return evaluations.some(
    ({ sentinel, checkerStatus }) => checkerStatus !== "absent" && itemKeepsEntryOpen(item, sentinel, checkerStatus),
  );
}

/**
 * A carried reason sentinel whose projection lost its supplemental task row
 * (schema 3 still lists it under `scoreProjectionGaps`) maps through the
 * projection's `coveredByTaskIds` — but only when the sentinel's projections
 * name exactly one covering task, so the carried obligation keeps exactly one
 * unambiguous task row. A successor match (the reason moved paths) resolves
 * its covering task from the successor projection, not the retired path.
 */
function singleCoveringTaskId(
  sentinel: unknown,
  group: RegistryGroupIndex | undefined,
  checkerStatus: CheckerSentinelStatus,
): string | undefined {
  const identities = sentinelMatchKeys(sentinel)
    .filter((key) => key.startsWith("reason\u0000"))
    .map((key) => key.slice("reason\u0000".length));
  const coverage = group?.projectionCoverage;
  if (identities.length === 0 || coverage === undefined) return undefined;
  const candidates = new Set<string>();
  for (const identity of identities) {
    // `reason|*` is path-agnostic, and a successor moved paths: every
    // projection of that reason code is a covering candidate; otherwise only
    // the named path's own projection can cover.
    const prefix =
      identity.endsWith("|*") || checkerStatus === "successor"
        ? `${identity.slice(0, identity.indexOf("|") + 1)}`
        : undefined;
    for (const [projectionIdentity, taskIds] of coverage) {
      if (prefix === undefined ? projectionIdentity !== identity : !projectionIdentity.startsWith(prefix)) continue;
      if (taskIds.length !== 1) return undefined;
      candidates.add(taskIds[0]!);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

/** The checker-named successor gap ids occupying this one sentinel's scope. */
function sentinelSuccessorCauses(
  sentinel: unknown,
  successorCausesByGapId: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const causes = new Set<string>();
  for (const gapId of parseLedgerSentinel(sentinel).gapIds) {
    for (const cause of successorCausesByGapId.get(gapId) ?? []) causes.add(cause);
  }
  return causes;
}

/** Whether one carried sentinel holds this task row directly or via its own successor scope. */
function entryHoldsTask(
  entry: { sentinel: unknown; checkerStatus: CheckerSentinelStatus },
  item: RegistryItem,
  successorCauses: ReadonlySet<string>,
): boolean {
  if (item.gapId !== null && successorCauses.has(item.gapId)) return true;
  return itemKeepsEntryOpen(item, entry.sentinel, entry.checkerStatus);
}

/**
 * Whether every carried sentinel can be assigned one distinct task row from
 * its candidates (Kuhn's augmenting-path matching). Equal counts alone do not
 * establish the mapping: two sentinels can share a single successor task while
 * another sentinel spans two rows.
 */
function distinctTaskRows(candidatesBySentinel: readonly (readonly string[])[]): boolean {
  const ownerByTaskId = new Map<string, number>();
  const augment = (sentinel: number, visited: Set<string>): boolean => {
    for (const taskId of candidatesBySentinel[sentinel]!) {
      if (visited.has(taskId)) continue;
      visited.add(taskId);
      const owner = ownerByTaskId.get(taskId);
      if (owner === undefined || augment(owner, visited)) {
        ownerByTaskId.set(taskId, sentinel);
        return true;
      }
    }
    return false;
  };
  return candidatesBySentinel.every((_, sentinel) => augment(sentinel, new Set<string>()));
}

/** Outcome of deriving one decision from a bookable resolution row. */
type BuiltDecision =
  | { ok: true; decision: NewCurationLedgerDecision; closedTaskIds: string[]; remainingTaskIds: string[] }
  | { ok: false; reason: "no-derived-closure" | "ambiguous-task-mapping"; detail: string };

function buildDecisionForResolution(input: {
  latest: CurationLedgerDecision;
  split: boolean;
  group: RegistryGroupIndex | undefined;
  evaluations: readonly { sentinel: unknown; evaluation: SentinelEvaluation; checkerStatus: CheckerSentinelStatus }[];
  /** Per sentinel gap id, the gap ids the checker named as successors occupying that scope. */
  successorCausesByGapId: ReadonlyMap<string, ReadonlySet<string>>;
  /** Live task rows on the claim group's assets, across work types. */
  assetTaskIds: ReadonlySet<string>;
  reviewedAt: string;
  reviewer: string;
  registryFingerprint: string;
  identityFingerprint: string;
  captureClockSec: number;
}): BuiltDecision {
  const { latest, split, group, evaluations } = input;
  const currentTaskIds = input.assetTaskIds;
  const factsClosed =
    latest.taskIds.length === 0 ? 0 : evaluations.filter((entry) => entry.checkerStatus === "absent").length;
  if (factsClosed === 0) {
    return {
      ok: false,
      reason: "no-derived-closure",
      detail: `no recorded task row maps to a verified-absent sentinel (decision records ${latest.taskIds.length} task rows)`,
    };
  }
  // Task rows rotate with the registry: an obligation still open under a new
  // task id must carry that current id forward, not silently count as closed.
  // The liveness lookup spans the claim group's assets, because a carried
  // covering task can live in another work type's group on the same asset.
  const remainingTaskIds: string[] = latest.taskIds.filter((taskId) => currentTaskIds.has(taskId));
  const remaining = new Set(remainingTaskIds);
  const successorGapIds = new Set<string>();
  for (const causes of input.successorCausesByGapId.values()) {
    for (const cause of causes) successorGapIds.add(cause);
  }
  for (const item of group?.items ?? []) {
    if (remaining.has(item.taskId)) continue;
    if (itemHoldsCarriedSentinel(item, evaluations, successorGapIds)) {
      remaining.add(item.taskId);
      remainingTaskIds.push(item.taskId);
    }
  }
  const carried = evaluations.filter((entry) => entry.checkerStatus !== "absent");
  // Matching counts and distinct identities still do not establish the mapping:
  // each carried sentinel must hold exactly one distinct task row (successor
  // scopes match per sentinel), and a reason sentinel whose projection has no
  // task row of its own maps through the projection's single covering task —
  // including one the decision already records. A sentinel carried with no
  // task row can never close (factsClosed is derived over recorded task
  // rows), so an unestablishable carried mapping skips instead of booking a
  // dead-end row.
  const candidatesByCarriedSentinel: string[][] = [];
  for (const entry of carried) {
    const causes = sentinelSuccessorCauses(entry.sentinel, input.successorCausesByGapId);
    const held = (group?.items ?? [])
      .filter((item) => remaining.has(item.taskId) && entryHoldsTask(entry, item, causes))
      .map((item) => item.taskId);
    if (held.length > 0) {
      candidatesByCarriedSentinel.push(held);
      continue;
    }
    const coveredTaskId = singleCoveringTaskId(entry.sentinel, group, entry.checkerStatus);
    if (coveredTaskId === undefined || !currentTaskIds.has(coveredTaskId)) {
      return {
        ok: false,
        reason: "ambiguous-task-mapping",
        detail:
          "a carried sentinel holds no task row and its projection coverage names no single covering task live on the asset",
      };
    }
    if (!remaining.has(coveredTaskId)) {
      remaining.add(coveredTaskId);
      remainingTaskIds.push(coveredTaskId);
    }
    candidatesByCarriedSentinel.push([coveredTaskId]);
  }
  // One distinct task row per carried sentinel keeps the booked split closable
  // on the next sweep (its recorded rows must map one-to-one to its
  // sentinels). With equal counts the bijection also proves every surviving
  // recorded task row is held open by a carried sentinel, so a task still open
  // on an obligation outside the decision's sentinel set cannot be booked.
  if (remainingTaskIds.length !== carried.length) {
    return {
      ok: false,
      reason: "ambiguous-task-mapping",
      detail: `${remainingTaskIds.length} remaining task rows against ${carried.length} carried sentinels`,
    };
  }
  if (!distinctTaskRows(candidatesByCarriedSentinel)) {
    return {
      ok: false,
      reason: "ambiguous-task-mapping",
      detail: "carried sentinels cannot each hold a distinct task row",
    };
  }
  const closedTaskIds = latest.taskIds.filter((taskId) => !remaining.has(taskId));
  const provenance =
    `registry ${input.registryFingerprint} @ ${input.captureClockSec} ` +
    `(missing-data identity ${input.identityFingerprint})`;
  const absentEvidence = evaluations
    .filter(({ checkerStatus }) => checkerStatus === "absent")
    .flatMap(({ evaluation }) => evaluation.absentLabels)
    .map((label) => `${provenance}: ${label}`);
  const carriedEvidence = evaluations
    .filter(({ checkerStatus }) => checkerStatus !== "absent")
    .map(({ checkerStatus }) => `${provenance}: sentinel match ${checkerStatus} carries forward`);
  const closedSummary =
    closedTaskIds.length === factsClosed
      ? closedTaskIds.join(", ")
      : `${factsClosed} of ${latest.taskIds.length} recorded task rows map to verified-absent sentinels`;
  return {
    ok: true as const,
    closedTaskIds,
    remainingTaskIds,
    decision: {
      claimGroupId: latest.claimGroupId,
      taskIds: [...remainingTaskIds],
      workType: latest.workType,
      resolutionMode: latest.resolutionMode,
      decision: "promote",
      reviewedAt: input.reviewedAt,
      reviewer: input.reviewer,
      changeRefs: [],
      evidence: [
        `${provenance}: ${split ? "still-open split" : "closed"} verdict; factsClosed ${factsClosed} ` +
          `re-derived from verified-absent sentinels over ${latest.taskIds.length} recorded task rows (${closedSummary})`,
        ...absentEvidence,
        ...carriedEvidence,
      ],
      rationale:
        (split
          ? "Mechanical split closure: some sentinels are checker-confirmed absent while sibling, adverse or successor obligations remain carried; "
          : "Mechanical sentinel closure: every machine-checkable sentinel on the latest decision is checker-confirmed absent ") +
        `on a replay-verified registry sweep in ${provenance}. ` +
        "No new issuer evidence was reviewed; factsClosed is re-derived from verified-absent sentinels over the " +
        "decision's task rows and recorded here, never taken from the reviewer.",
      sentinels: split ? sentinelCarryForward(evaluations) : [],
      nextReviewTrigger: split
        ? `Re-review when the carried sentinels for ${latest.claimGroupId} become absent, or when new evidence replaces them.`
        : `Re-review if a future missing-data registry reopens ${latest.claimGroupId}.`,
      factsClosed,
    },
  };
}

function skip(
  row: SentinelResolutionRow,
  reason: SentinelSkipReason,
  detail: string,
): SkippedResolution {
  return { claimGroupId: row.claimGroupId, verdict: row.verdict, reason, detail };
}

/**
 * Pure applier: validate inputs, derive closures, append through the single
 * ledger append path. Re-running the same artifact adds nothing.
 */
export function applySentinelClosures(input: ApplySentinelClosuresInput): ApplySentinelClosuresResult {
  const resolutions = parseSentinelResolutions(input.resolutions);
  const registry = buildRegistryIndex(input.registry, input.registryFingerprint);
  if (resolutions.registrySha256 !== registry.fingerprint) {
    throw new SentinelApplyError(
      "registry-fingerprint-mismatch",
      `artifact registrySha256 ${resolutions.registrySha256} != registry bytes ${registry.fingerprint}`,
    );
  }
  if (resolutions.captureClockSec !== registry.captureClockSec) {
    throw new SentinelApplyError(
      "capture-clock-mismatch",
      `artifact capture clock ${resolutions.captureClockSec} != registry asOfSec ${registry.captureClockSec}`,
    );
  }
  const seenGroups = new Set<string>();
  for (const row of resolutions.rows) {
    if (seenGroups.has(row.claimGroupId)) {
      throw new SentinelApplyError(
        "duplicate-resolution-row",
        `${row.claimGroupId} appears more than once; verdicts must be one row per group`,
      );
    }
    seenGroups.add(row.claimGroupId);
  }
  const runId = input.runId ?? String(resolutions.captureClockSec);
  if (runId.trim().length === 0) {
    throw new SentinelApplyError("run-id-invalid", "run id must not be blank");
  }
  const reviewer = `sentinel-sweep/${runId}`;
  const reviewedAt = new Date(registry.captureClockSec * 1000).toISOString().slice(0, 10);
  const marker = `registry ${registry.fingerprint} @ ${registry.captureClockSec}`;
  const ledgerDecisionCount = input.ledger.decisions.length;
  const staleLedgerBasis = resolutions.ledgerDecisionCount !== ledgerDecisionCount;
  const latestByGroup = indexLatestCurationDecisions(input.ledger.decisions);
  const candidates: NewCurationLedgerDecision[] = [];
  const booked: BookedClosure[] = [];
  const skipped: SkippedResolution[] = [];
  const triggerFiredGroups: string[] = [];

  for (const row of resolutions.rows) {
    const latestEntry = latestByGroup.get(row.claimGroupId);
    if (!latestEntry) {
      skipped.push(skip(row, "missing-ledger-group", "no ledger history for this claim group"));
      continue;
    }
    const latest = latestEntry.decision;
    if (latest.evidence.some((entry) => typeof entry === "string" && entry.startsWith(marker))) {
      skipped.push(skip(row, "already-applied", `latest decision already cites ${marker}`));
      continue;
    }
    if (staleLedgerBasis) {
      skipped.push(
        skip(
          row,
          "stale-ledger-basis",
          `artifact read ${resolutions.ledgerDecisionCount} decisions, ledger has ${ledgerDecisionCount}`,
        ),
      );
      continue;
    }
    if (row.ledgerDecisionIndex !== latestEntry.index) {
      skipped.push(
        skip(
          row,
          "ledger-advanced",
          `artifact evaluated decision index ${row.ledgerDecisionIndex}, latest is ${latestEntry.index}`,
        ),
      );
      continue;
    }
    if (latest.decision === "reject") {
      skipped.push(skip(row, "latest-decision-reject", "the latest decision already rejected this group"));
      continue;
    }
    if (!CURATION_WORK_TYPES.has(latest.workType as WorkType)) {
      skipped.push(skip(row, "unknown-work-type", `legacy workType ${latest.workType}`));
      continue;
    }
    if (!CURATION_RESOLUTION_MODES.has(latest.resolutionMode as ResolutionMode)) {
      skipped.push(skip(row, "unknown-resolution-mode", `legacy resolutionMode ${latest.resolutionMode}`));
      continue;
    }
    const group = registry.groups.get(row.claimGroupId);
    if (row.openItemCount !== undefined && row.openItemCount !== (group?.items.length ?? 0)) {
      skipped.push(
        skip(
          row,
          "stale-row-count",
          `artifact counted ${row.openItemCount} items, registry has ${group?.items.length ?? 0}`,
        ),
      );
      continue;
    }
    if (assetUnavailable(registry, row.claimGroupId)) {
      skipped.push(
        skip(row, "quarantined-or-missing-asset", "asset is absent from the registry or marked pipeline-gap"),
      );
      continue;
    }
    if (assetNotRated(registry, row.claimGroupId)) {
      skipped.push(
        skip(row, "asset-not-rated", "an asset is not rated; a promote asserts facts the checker holds unverifiable"),
      );
      continue;
    }
    const spp = latest.deferState === STRUCTURED_PENDING_PRODUCTION;
    if (spp && row.admission === "not-applicable") {
      skipped.push(
        skip(row, "spp-state-mismatch", "structured-pending-production decision reports admission not-applicable"),
      );
      continue;
    }
    if (!spp && row.admission !== "not-applicable") {
      skipped.push(
        skip(
          row,
          "spp-state-mismatch",
          `latest deferState is ${latest.deferState ?? "absent"} but the row reports admission ${row.admission}`,
        ),
      );
      continue;
    }
    if (row.admission === "failed") {
      skipped.push(
        skip(
          row,
          "spp-admission-failed",
          "structured-pending-production admission has not verified; waiting for admitted production evidence " +
            "and booking no reject",
        ),
      );
      continue;
    }
    const split = row.verdict === "still-open" && row.reason === SPLIT_REASON;
    if (row.verdict !== "closed" && !split) {
      skipped.push(
        skip(row, "verdict-not-bookable", `verdict ${row.verdict} (${row.reason}) requires human review`),
      );
      continue;
    }
    if (spp && row.admission !== "verified") {
      skipped.push(
        skip(row, "spp-state-mismatch", `a closed structured-pending-production row requires admission verified`),
      );
      continue;
    }
    const sentinels = ledgerSentinelList(latest);
    if (sentinels.length === 0) {
      skipped.push(skip(row, "missing-sentinel", "the latest decision records no sentinel"));
      continue;
    }
    const evaluations = sentinels.map((sentinel) => ({
      sentinel,
      evaluation: evaluateSentinel(sentinel, group),
    }));
    if (evaluations.some(({ evaluation }) => !evaluation.machineCheckable)) {
      skipped.push(skip(row, "non-machine-sentinel", "a sentinel is prose and cannot authorize a closure"));
      continue;
    }
    const checkerMatches = new Map(row.matches.map((match) => [matchIdentityKey(match.kind, match.identity), match.status]));
    const evaluationsWithStatus = evaluations.map((entry) => ({
      ...entry,
      checkerStatus: checkerSentinelStatus(entry.sentinel, checkerMatches),
    }));
    if (evaluationsWithStatus.some(({ checkerStatus }) => checkerStatus === "unmatched")) {
      skipped.push(
        skip(
          row,
          "sentinel-still-open",
          "the artifact's per-sentinel matches do not confirm every sentinel condition on this decision",
        ),
      );
      continue;
    }
    const checkerAbsentCount = evaluationsWithStatus.filter(({ checkerStatus }) => checkerStatus === "absent").length;
    const absentBookable = split
      ? checkerAbsentCount > 0 && checkerAbsentCount < evaluationsWithStatus.length
      : checkerAbsentCount === evaluationsWithStatus.length;
    if (
      !absentBookable ||
      // A checker-confirmed absence must also be absent on the registry this
      // run re-read: an artifact verdict may never outrun the registry bytes.
      evaluationsWithStatus.some(({ checkerStatus, evaluation }) => checkerStatus === "absent" && !evaluation.absent)
    ) {
      skipped.push(
        skip(
          row,
          "sentinel-still-open",
          evaluations.flatMap(({ evaluation }) => evaluation.openLabels).join("; ") ||
            "the registry disagrees with the artifact's closure claim",
        ),
      );
      continue;
    }
    // Equal counts alone do not establish the mapping: two task rows with two
    // copies of one sentinel attribute one closure twice. Every checker
    // identity the decision's sentinels resolve to must be distinct.
    const identityKeys = sentinels.flatMap((sentinel) => sentinelMatchKeys(sentinel));
    const distinctIdentityCount = new Set(identityKeys).size;
    if (
      (latest.taskIds.length > 0 && latest.taskIds.length !== sentinels.length) ||
      identityKeys.length !== distinctIdentityCount
    ) {
      const detail =
        latest.taskIds.length > 0 && latest.taskIds.length !== sentinels.length
          ? `the decision records ${latest.taskIds.length} task rows against ${sentinels.length} sentinels`
          : `the decision's ${sentinels.length} sentinels resolve to only ${distinctIdentityCount} distinct checker identities`;
      skipped.push(
        skip(row, "ambiguous-task-mapping", `${detail}; closed facts cannot be attributed without a one-to-one mapping`),
      );
      continue;
    }
    // Successor scopes match per sentinel: each gap successor match's causes
    // name the scope of that one sentinel, never of every carried sibling.
    const successorCausesByGapId = new Map<string, Set<string>>();
    for (const match of row.matches) {
      if (match.kind !== "gap" || match.status !== "successor") continue;
      const causes = successorCausesByGapId.get(match.identity) ?? new Set<string>();
      for (const cause of match.causes ?? []) causes.add(cause);
      successorCausesByGapId.set(match.identity, causes);
    }
    const built = buildDecisionForResolution({
      latest,
      split,
      group,
      evaluations: evaluationsWithStatus,
      successorCausesByGapId,
      assetTaskIds: groupAssetTaskIds(registry, row.claimGroupId),
      reviewedAt,
      reviewer,
      registryFingerprint: registry.fingerprint,
      identityFingerprint: resolutions.identityFingerprint,
      captureClockSec: registry.captureClockSec,
    });
    if (!built.ok) {
      skipped.push(skip(row, built.reason, built.detail));
      continue;
    }
    candidates.push(built.decision);
    booked.push({
      claimGroupId: row.claimGroupId,
      verdict: row.verdict,
      factsClosed: built.decision.factsClosed,
      closedTaskIds: built.closedTaskIds,
      remainingTaskIds: built.remainingTaskIds,
      decisionRecord: built.decision,
    });
    triggerFiredGroups.push(row.claimGroupId);
  }

  if (candidates.length === 0) {
    return { ledger: input.ledger, captureClockSec: registry.captureClockSec, booked, skipped };
  }
  const appended = appendCurationLedgerDecisions({
    ledger: input.ledger,
    decisions: candidates,
    triggerFiredGroups,
  });
  return { ledger: appended.ledger, captureClockSec: registry.captureClockSec, booked, skipped };
}

const USAGE = `Usage: npx tsx scripts/maintenance/apply-sentinel-closures.ts \\
  --resolutions <path> --registry <path> [options]

Apply sentinel-sweep verdicts as append-only curation-ledger decisions.

Options:
  --resolutions <path>  sentinel-resolutions.json from the sweep checker (required)
  --registry <path>     The same missing-data registry JSON the checker read (required)
  --ledger <path>       Ledger path (default ${CURATION_LEDGER_PATH})
  --run-id <id>         Reviewer suffix (default: the registry capture clock -> sentinel-sweep/<id>)
  --write               Append to the ledger; without it the run is a preview
  --dry-run             Explicit preview; conflicts with --write
  -h, --help            Show this help

The artifact must be replay-verified, carry the current checker version in
inputs.checkerVersion (archived verdicts must be regenerated before booking),
and name the registry SHA-256 and capture
clock it was computed from; the applier re-verifies sentinel absence and derives
factsClosed from verified-absent sentinels over the decision's task rows. A
closed verdict books a promote (every checker match absent); still-open with
reason sentinels-partially-absent books a partial promote only when at least one
sentinel is checker-confirmed absent, carrying every outstanding (present,
adverse, successor) sentinel and the current registry task rows (a reason
sentinel whose schema-3 projection has no task row of its own carries the
projection's single covering task); every booking requires a rated asset and a
one-to-one task/sentinel mapping with one distinct task row per carried
sentinel; every other
verdict is reported, never booked. Structured-pending-production rows that have
not verified admission wait (spp-admission-failed) instead of booking a reject.`;

interface ApplierCliOutput {
  write(text: string): unknown;
}

export interface ApplySentinelClosuresCliResult {
  booked: number;
  skipped: number;
  ledgerDecisions: number;
  dryRun: boolean;
}

export function runApplySentinelClosuresCli(
  argv: readonly string[],
  io: { stdout: ApplierCliOutput } = { stdout: process.stdout },
): ApplySentinelClosuresCliResult {
  const { values } = parseStrictCliArgs(argv, {
    conflicts: [["write", "dry-run"]],
    options: {
      resolutions: { type: "string" },
      registry: { type: "string" },
      ledger: { type: "string" },
      "run-id": { type: "string" },
      write: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, io.stdout)) {
    return { booked: 0, skipped: 0, ledgerDecisions: 0, dryRun: true };
  }
  const ledgerPath = typeof values.ledger === "string" ? values.ledger : CURATION_LEDGER_PATH;
  const resolutionsPath = requireCliString(values.resolutions, "--resolutions");
  const registryPath = requireCliString(values.registry, "--registry");
  const runId = typeof values["run-id"] === "string" ? values["run-id"] : undefined;
  const write = values.write === true;

  const registryBytes = readFileSync(registryPath);
  const registryFingerprint = sha256Hex(registryBytes);
  let registryJson: unknown;
  try {
    registryJson = JSON.parse(registryBytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new SentinelApplyError(
      "registry-schema-invalid",
      `${registryPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let resolutionsJson: unknown;
  try {
    resolutionsJson = JSON.parse(readFileSync(resolutionsPath, "utf8")) as unknown;
  } catch (error) {
    throw new SentinelApplyError(
      "resolutions-schema-invalid",
      `${resolutionsPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const existing = readCurationLedger(ledgerPath);
  let result: ApplySentinelClosuresResult;
  try {
    result = applySentinelClosures({
      ledger: existing.ledger,
      registry: registryJson,
      resolutions: resolutionsJson,
      registryFingerprint,
      ...(runId === undefined ? {} : { runId }),
    });
  } catch (error) {
    if (error instanceof LedgerAppendError) {
      throw new SentinelApplyError("ledger-append-rejected", error.message);
    }
    throw error;
  }
  if (write && result.booked.length > 0) {
    writeCurationLedger({ path: ledgerPath, ledger: result.ledger, expectedSha256: existing.sha256 });
  }
  const skippedByReason = new Map<string, number>();
  for (const entry of result.skipped) {
    skippedByReason.set(entry.reason, (skippedByReason.get(entry.reason) ?? 0) + 1);
  }
  const factsClosed = result.booked.reduce((sum, entry) => sum + entry.factsClosed, 0);
  const lines = [
    `${write ? "Applied" : "Preview (dry run)"}: ${result.booked.length} booked, ${result.skipped.length} skipped`,
    `Booked: ${result.booked.length} promote, factsClosed ${factsClosed}`,
    ...(result.booked.length === 0
      ? []
      : result.booked.map(
          (entry) =>
            `  - promote ${entry.claimGroupId} (${entry.verdict}, factsClosed ${entry.factsClosed})`,
        )),
    ...(skippedByReason.size === 0
      ? []
      : [`Skipped: ${[...skippedByReason.entries()].map(([reason, count]) => `${reason}=${count}`).join(", ")}`]),
    `Registry: ${registryFingerprint} @ ${result.captureClockSec}`,
    `Ledger decisions: ${existing.ledger.decisions.length} -> ${result.ledger.decisions.length}`,
    write ? `Wrote ${ledgerPath}` : "Dry run: pass --write to append.",
  ];
  io.stdout.write(`${lines.join("\n")}\n`);
  return {
    booked: result.booked.length,
    skipped: result.skipped.length,
    ledgerDecisions: result.ledger.decisions.length,
    dryRun: !write,
  };
}

runDirectCli(import.meta.url, () => {
  runApplySentinelClosuresCli(process.argv.slice(2));
}, { label: "apply-sentinel-closures", usage: USAGE });

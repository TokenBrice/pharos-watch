import { readFileSync } from "node:fs";
import { z } from "zod";
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
 * Every other verdict is reported and never booked. An SPP row whose admission
 * has not verified is a wait state, never a reviewed rejection: it is skipped
 * with `spp-admission-failed` and books nothing. Nothing is booked when the
 * artifact was not replay-verified, names a different registry digest, clock or
 * ledger version, the group's latest decision is already booked, the asset is
 * quarantined, a sentinel is still open (or prose), or no task row closed.
 */

/**
 * Verdict axis of the sweep checker's artifact. Restated rather than imported:
 * `scripts/` is excluded from the worker TypeScript project and cannot import
 * `worker/scripts/`. The contract test in `__tests__/apply-sentinel-closures.test.ts`
 * runs the checker's own report through this parser, so drift fails there.
 */
export const SENTINEL_VERDICTS = ["closed", "still-open", "replaced-adversely", "unverifiable"] as const;
export type SentinelVerdict = (typeof SENTINEL_VERDICTS)[number];

/** SPP admission axis, independent of the verdict. */
export const SENTINEL_ADMISSIONS = ["verified", "failed", "not-applicable", "unverifiable"] as const;
export type SentinelAdmission = (typeof SENTINEL_ADMISSIONS)[number];

const STRUCTURED_PENDING_PRODUCTION = "structured-pending-production";
const SPLIT_REASON = "sentinels-partially-absent";
const REQUIRED_CLOSURE_EVIDENCE = "replay-verified";

export type SentinelApplyFailureReason =
  | "resolutions-schema-invalid"
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
const sha256Text = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 hex digest");
const clockSec = z.number().int().nonnegative();

const SentinelResolutionRowSchema = z
  .object({
    claimGroupId: nonEmptyText,
    verdict: z.enum(SENTINEL_VERDICTS),
    reason: nonEmptyText,
    admission: z.enum(SENTINEL_ADMISSIONS),
    ledgerDecisionIndex: z.number().int().nonnegative(),
    registryFingerprint: sha256Text.optional(),
    asOfSec: clockSec.nullable().optional(),
    openItemCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const SentinelResolutionsArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    inputs: z
      .object({
        registry: z
          .object({
            missingDataRegistryFingerprint: sha256Text,
            registrySha256: sha256Text,
            binding: z.object({ asOfSec: clockSec }).passthrough().nullable().optional(),
          })
          .passthrough(),
        ledger: z.object({ decisionCount: z.number().int().nonnegative() }).passthrough(),
        closureEvidence: nonEmptyText,
      })
      .passthrough(),
    groups: z.array(SentinelResolutionRowSchema).min(1),
  })
  .passthrough();

export interface SentinelResolutionRow {
  claimGroupId: string;
  verdict: SentinelVerdict;
  reason: string;
  admission: SentinelAdmission;
  ledgerDecisionIndex: number;
  openItemCount?: number;
}

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
    rows.push({
      claimGroupId: row.claimGroupId,
      verdict: row.verdict,
      reason: row.reason,
      admission: row.admission,
      ledgerDecisionIndex: row.ledgerDecisionIndex,
      ...(row.openItemCount === undefined ? {} : { openItemCount: row.openItemCount }),
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

const RegistryAssetSchema = z
  .object({
    assetId: nonEmptyText,
    currentScore: z
      .object({ ratingStatus: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    missingItems: z.array(RegistryItemSchema),
  })
  .passthrough();

const RegistrySchema = z
  .object({
    schemaVersion: z.literal(2),
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
}

export interface RegistryIndex {
  fingerprint: string;
  captureClockSec: number;
  groups: ReadonlyMap<string, RegistryGroupIndex>;
  assetIds: ReadonlySet<string>;
  ratingStatusByAsset: ReadonlyMap<string, string | null>;
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
  }>();
  const assetIds = new Set<string>();
  const ratingStatusByAsset = new Map<string, string | null>();
  for (const asset of parsed.data.stablecoins) {
    assetIds.add(asset.assetId);
    ratingStatusByAsset.set(asset.assetId, asset.currentScore?.ratingStatus ?? null);
    for (const item of asset.missingItems) {
      let group = groups.get(item.claimGroupId);
      if (!group) {
        group = {
          items: [],
          taskIds: new Set(),
          gapIds: new Set(),
          reasonCodes: new Set(),
          reasonPairs: new Set(),
        };
        groups.set(item.claimGroupId, group);
      }
      group.items.push(item);
      group.taskIds.add(item.taskId);
      if (item.gapId !== null) group.gapIds.add(item.gapId);
      group.reasonCodes.add(item.reasonCode);
      const reason = item.doneWhenScoreReasonAbsent;
      if (reason) group.reasonPairs.add(reasonPairKey(reason.reasonCode, reason.path));
    }
  }
  return {
    fingerprint,
    captureClockSec: parsed.data.snapshot.asOfSec,
    groups,
    assetIds,
    ratingStatusByAsset,
  };
}

export interface SentinelEvaluation {
  machineCheckable: boolean;
  absent: boolean;
  absentLabels: string[];
  openLabels: string[];
}

/**
 * Evaluate one ledger sentinel against its own claim group's open rows. A
 * reason-pair condition counts as absent only when neither the exact pair nor
 * the reason code appears in the group; that keeps path-format drift from
 * manufacturing a closure.
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
    if (gapIds.has(gapId)) {
      result.absent = false;
      result.openLabels.push(`gapId ${gapId} still open`);
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
  return result;
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
  | "no-derived-closure"
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

function sentinelCarryForward(
  evaluationSentinels: readonly { sentinel: unknown; evaluation: SentinelEvaluation }[],
  includeAll: boolean,
): LedgerSentinel[] {
  const carried: LedgerSentinel[] = [];
  for (const { sentinel, evaluation } of evaluationSentinels) {
    if (!includeAll && evaluation.openLabels.length === 0) continue;
    const writable = normalizeWritableLedgerSentinel(sentinel);
    if (writable !== null) carried.push(writable);
  }
  return carried;
}

function buildDecisionForResolution(input: {
  latest: CurationLedgerDecision;
  split: boolean;
  group: RegistryGroupIndex | undefined;
  evaluations: readonly { sentinel: unknown; evaluation: SentinelEvaluation }[];
  reviewedAt: string;
  reviewer: string;
  registryFingerprint: string;
  identityFingerprint: string;
  captureClockSec: number;
}): { decision: NewCurationLedgerDecision; closedTaskIds: string[]; remainingTaskIds: string[] } | null {
  const { latest, split, group, evaluations } = input;
  const currentTaskIds = group?.taskIds ?? new Set<string>();
  const remainingTaskIds = latest.taskIds.filter((taskId) => currentTaskIds.has(taskId));
  const closedTaskIds = latest.taskIds.filter((taskId) => !currentTaskIds.has(taskId));
  const factsClosed = closedTaskIds.length;
  if (factsClosed === 0) return null;
  const provenance =
    `registry ${input.registryFingerprint} @ ${input.captureClockSec} ` +
    `(missing-data identity ${input.identityFingerprint})`;
  const absentEvidence = evaluations
    .flatMap(({ evaluation }) => evaluation.absentLabels)
    .map((label) => `${provenance}: ${label}`);
  return {
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
          `re-derived from registry task rows (${closedTaskIds.join(", ")})`,
        ...absentEvidence,
      ],
      rationale:
        (split
          ? "Mechanical split closure: some sentinels are absent while sibling rows remain open; "
          : "Mechanical sentinel closure: every machine-checkable sentinel on the latest decision is absent ") +
        `on a replay-verified registry sweep in ${provenance} with no adverse replacement. ` +
        "No new issuer evidence was reviewed; factsClosed is re-derived from registry task rows and " +
        "recorded here, never taken from the reviewer.",
      sentinels: split ? sentinelCarryForward(evaluations, false) : [],
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
    const absentCount = evaluations.filter(({ evaluation }) => evaluation.absent).length;
    const absentBookable = split
      ? absentCount > 0 && absentCount < evaluations.length
      : absentCount === evaluations.length;
    if (!absentBookable) {
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
    const built = buildDecisionForResolution({
      latest,
      split,
      group,
      evaluations,
      reviewedAt,
      reviewer,
      registryFingerprint: registry.fingerprint,
      identityFingerprint: resolutions.identityFingerprint,
      captureClockSec: registry.captureClockSec,
    });
    if (built === null) {
      skipped.push(
        skip(row, "no-derived-closure", `none of the ${latest.taskIds.length} recorded task rows left the registry`),
      );
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

The artifact must be replay-verified and name the registry SHA-256 and capture
clock it was computed from; the applier re-verifies sentinel absence and derives
factsClosed from the registry. A closed verdict books a promote (every sentinel
absent); still-open with reason sentinels-partially-absent books a partial
promote carrying the outstanding sentinels; every other verdict is reported,
never booked. Structured-pending-production rows that have not verified
admission wait (spp-admission-failed) instead of booking a reject.`;

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

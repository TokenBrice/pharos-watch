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
 * The sweep checker (DUR-1) owns verdicts: bookable / split / re-review /
 * pending for open groups, admission-verified / admission-failed for
 * structured-pending-production (SPP) groups. This applier independently
 * verifies the parts it can re-derive from the registry it was handed
 * (sentinel absence, group task rows, factsClosed) and books:
 *
 *   bookable, split, admission-verified  -> promote
 *   admission-failed                     -> reject
 *
 * re-review and pending require human review and are reported, never booked.
 * Nothing is booked when the registry is for a different clock/fingerprint, the
 * group's latest decision changed since the sweep read the ledger, the asset is
 * quarantined, the sentinel is still open, or no task row actually closed.
 */

export const SENTINEL_VERDICTS = [
  "bookable",
  "split",
  "re-review",
  "pending",
  "admission-verified",
  "admission-failed",
] as const;
export type SentinelVerdict = (typeof SENTINEL_VERDICTS)[number];

export type SentinelApplyFailureReason =
  | "resolutions-schema-invalid"
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
    items: z.number().int().nonnegative().optional(),
    ledgerDecisionIndex: z.number().int().nonnegative().optional(),
    registryFingerprint: sha256Text.optional(),
    captureClockSec: clockSec.optional(),
  })
  .passthrough();

const SentinelResolutionsArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAtSec: clockSec,
    registryFingerprint: sha256Text.optional(),
    captureClockSec: clockSec.optional(),
    ledgerDecisionCount: z.number().int().nonnegative().optional(),
    rows: z.array(SentinelResolutionRowSchema).min(1),
  })
  .passthrough();

export interface SentinelResolutionRow {
  claimGroupId: string;
  verdict: SentinelVerdict;
  items?: number;
  ledgerDecisionIndex?: number;
}

export interface SentinelResolutions {
  schemaVersion: 1;
  generatedAtSec: number;
  registryFingerprint: string;
  captureClockSec: number;
  ledgerDecisionCount?: number;
  rows: readonly SentinelResolutionRow[];
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

/**
 * Resolve provenance from the artifact root or from every row. Rows must agree
 * on one registry fingerprint and capture clock; mixed provenance is refused.
 */
export function parseSentinelResolutions(value: unknown): SentinelResolutions {
  const parsed = SentinelResolutionsArtifactSchema.safeParse(value);
  if (!parsed.success) {
    throw new SentinelApplyError("resolutions-schema-invalid", describeIssues(parsed.error));
  }
  const artifact = parsed.data;
  let fingerprint = artifact.registryFingerprint;
  let captureClock = artifact.captureClockSec;
  const rows: SentinelResolutionRow[] = [];
  for (const [index, row] of artifact.rows.entries()) {
    const rowFingerprint = row.registryFingerprint ?? fingerprint;
    const rowClock = row.captureClockSec ?? captureClock;
    if (rowFingerprint === undefined || rowClock === undefined) {
      throw new SentinelApplyError(
        "resolutions-schema-invalid",
        `rows.${index}: registryFingerprint and captureClockSec are required at the root or on every row`,
      );
    }
    if (row.registryFingerprint !== undefined && fingerprint !== undefined
      && row.registryFingerprint !== fingerprint) {
      throw new SentinelApplyError(
        "resolutions-schema-invalid",
        `rows.${index}: registryFingerprint disagrees with the artifact root`,
      );
    }
    if (row.captureClockSec !== undefined && captureClock !== undefined
      && row.captureClockSec !== captureClock) {
      throw new SentinelApplyError(
        "resolutions-schema-invalid",
        `rows.${index}: captureClockSec disagrees with the artifact root`,
      );
    }
    if (fingerprint !== undefined && rowFingerprint !== fingerprint) {
      throw new SentinelApplyError(
        "resolutions-schema-invalid",
        `rows.${index}: rows mix registry fingerprints`,
      );
    }
    if (captureClock !== undefined && rowClock !== captureClock) {
      throw new SentinelApplyError(
        "resolutions-schema-invalid",
        `rows.${index}: rows mix capture clocks`,
      );
    }
    fingerprint = rowFingerprint;
    captureClock = rowClock;
    rows.push({
      claimGroupId: row.claimGroupId,
      verdict: row.verdict,
      ...(row.items === undefined ? {} : { items: row.items }),
      ...(row.ledgerDecisionIndex === undefined ? {} : { ledgerDecisionIndex: row.ledgerDecisionIndex }),
    });
  }
  if (fingerprint === undefined || captureClock === undefined) {
    throw new SentinelApplyError(
      "resolutions-schema-invalid",
      "registryFingerprint and captureClockSec are required",
    );
  }
  return {
    schemaVersion: 1,
    generatedAtSec: artifact.generatedAtSec,
    registryFingerprint: fingerprint,
    captureClockSec: captureClock,
    ...(artifact.ledgerDecisionCount === undefined
      ? {}
      : { ledgerDecisionCount: artifact.ledgerDecisionCount }),
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
  | "work-type-mismatch"
  | "missing-sentinel"
  | "non-machine-sentinel"
  | "sentinel-still-open"
  | "stale-row-count"
  | "quarantined-or-missing-asset"
  | "no-derived-closure"
  | "spp-state-mismatch"
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
  decision: "promote" | "reject";
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
  /** Suffix appended to `sentinel-sweep/`; defaults to the artifact's generatedAtSec. */
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
  verdict: SentinelVerdict;
  group: RegistryGroupIndex | undefined;
  evaluations: readonly { sentinel: unknown; evaluation: SentinelEvaluation }[];
  reviewedAt: string;
  reviewer: string;
  registryFingerprint: string;
  captureClockSec: number;
}): { decision: NewCurationLedgerDecision; closedTaskIds: string[]; remainingTaskIds: string[] } | null {
  const { latest, verdict, group, evaluations } = input;
  const currentTaskIds = group?.taskIds ?? new Set<string>();
  const remainingTaskIds = latest.taskIds.filter((taskId) => currentTaskIds.has(taskId));
  const closedTaskIds = latest.taskIds.filter((taskId) => !currentTaskIds.has(taskId));
  const provenance = `registry ${input.registryFingerprint} @ ${input.captureClockSec}:`;
  const absentEvidence = evaluations
    .flatMap(({ evaluation }) => evaluation.absentLabels)
    .map((label) => `${provenance} ${label}`);
  const base = {
    claimGroupId: latest.claimGroupId,
    workType: latest.workType,
    resolutionMode: latest.resolutionMode,
    reviewedAt: input.reviewedAt,
    reviewer: input.reviewer,
    changeRefs: [] as string[],
  };
  if (verdict === "admission-failed") {
    return {
      closedTaskIds,
      remainingTaskIds,
      decision: {
        ...base,
        taskIds: [...latest.taskIds],
        decision: "reject",
        evidence: [
          `${provenance} structured-pending-production admission failed; no fact closed`,
          ...absentEvidence,
        ],
        rationale:
          "Mechanical SPP booking: the sentinel sweep reports the deferred structured evidence " +
          `failed production admission in ${provenance.replace(/:$/, "")}. No new issuer evidence was ` +
          "reviewed and no fact closed; re-author or replace the evidence before promotion.",
        sentinels: sentinelCarryForward(evaluations, true),
        nextReviewTrigger:
          `Re-review when a future registry reopens ${latest.claimGroupId} with admitted evidence ` +
          "or when the rejected source is replaced by a fresh primary source.",
        factsClosed: 0,
      },
    };
  }
  const factsClosed = closedTaskIds.length;
  if (factsClosed === 0) return null;
  const split = verdict === "split";
  return {
    closedTaskIds,
    remainingTaskIds,
    decision: {
      ...base,
      taskIds: [...remainingTaskIds],
      decision: "promote",
      evidence: [
        `${provenance} ${verdict} verdict; factsClosed ${factsClosed} re-derived from registry task rows` +
          (closedTaskIds.length > 0 ? ` (${closedTaskIds.join(", ")})` : ""),
        ...absentEvidence,
      ],
      rationale:
        (split
          ? "Mechanical split closure: some sentinels are absent while sibling rows remain open; "
          : "Mechanical sentinel closure: every machine-checkable sentinel on the latest decision is absent ") +
        `in ${provenance.replace(/:$/, "")} with no adverse replacement reported by the sweep. ` +
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
  if (resolutions.registryFingerprint !== registry.fingerprint) {
    throw new SentinelApplyError(
      "registry-fingerprint-mismatch",
      `artifact ${resolutions.registryFingerprint} != registry bytes ${registry.fingerprint}`,
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
  const runId = input.runId ?? String(resolutions.generatedAtSec);
  if (runId.trim().length === 0) {
    throw new SentinelApplyError("run-id-invalid", "run id must not be blank");
  }
  const reviewer = `sentinel-sweep/${runId}`;
  const reviewedAt = new Date(registry.captureClockSec * 1000).toISOString().slice(0, 10);
  const marker = `registry ${registry.fingerprint} @ ${registry.captureClockSec}:`;
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
      skipped.push(skip(row, "already-applied", `latest decision already cites ${marker.slice(0, -1)}`));
      continue;
    }
    if (row.ledgerDecisionIndex !== undefined) {
      if (row.ledgerDecisionIndex !== latestEntry.index) {
        skipped.push(
          skip(row, "ledger-advanced", `artifact read decision ${row.ledgerDecisionIndex}, latest is ${latestEntry.index}`),
        );
        continue;
      }
    } else if (resolutions.ledgerDecisionCount !== undefined) {
      if (resolutions.ledgerDecisionCount !== input.ledger.decisions.length) {
        skipped.push(
          skip(
            row,
            "stale-ledger-basis",
            `artifact read ${resolutions.ledgerDecisionCount} decisions, ledger has ${input.ledger.decisions.length}`,
          ),
        );
        continue;
      }
    } else {
      skipped.push(skip(row, "stale-ledger-basis", "artifact records neither per-row decision index nor ledger count"));
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
    if (row.items !== undefined && row.items !== (group?.items.length ?? 0)) {
      skipped.push(
        skip(row, "stale-row-count", `artifact counted ${row.items} items, registry has ${group?.items.length ?? 0}`),
      );
      continue;
    }
    if (assetUnavailable(registry, row.claimGroupId)) {
      skipped.push(
        skip(row, "quarantined-or-missing-asset", "asset is absent from the registry or marked pipeline-gap"),
      );
      continue;
    }
    if (row.verdict === "re-review" || row.verdict === "pending") {
      skipped.push(skip(row, "verdict-not-bookable", `verdict ${row.verdict} requires human review`));
      continue;
    }
    if (row.verdict === "admission-verified" || row.verdict === "admission-failed") {
      if (latest.deferState !== "structured-pending-production") {
        skipped.push(
          skip(row, "spp-state-mismatch", `latest deferState is ${latest.deferState ?? "absent"}, not structured-pending-production`),
        );
        continue;
      }
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
    if (row.verdict !== "admission-failed") {
      if (evaluations.some(({ evaluation }) => !evaluation.machineCheckable)) {
        skipped.push(skip(row, "non-machine-sentinel", "a sentinel is prose and cannot authorize a closure"));
        continue;
      }
      const absentCount = evaluations.filter(({ evaluation }) => evaluation.absent).length;
      if (row.verdict === "split" ? absentCount === 0 : absentCount !== evaluations.length) {
        skipped.push(
          skip(
            row,
            "sentinel-still-open",
            evaluations.flatMap(({ evaluation }) => evaluation.openLabels).join("; "),
          ),
        );
        continue;
      }
    }
    const built = buildDecisionForResolution({
      latest,
      verdict: row.verdict,
      group,
      evaluations,
      reviewedAt,
      reviewer,
      registryFingerprint: registry.fingerprint,
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
      decision: built.decision.decision === "reject" ? "reject" : "promote",
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
  --run-id <id>         Reviewer suffix (default: generatedAtSec -> sentinel-sweep/<id>)
  --write               Append to the ledger; without it the run is a preview
  --dry-run             Explicit preview; conflicts with --write
  -h, --help            Show this help

The artifact must name the registry SHA-256 and capture clock it was computed
from. The applier re-verifies sentinel absence and derives factsClosed from the
registry; bookable/admission-verified book promote, admission-failed books
reject, and split books a partial promote with the outstanding sentinels.`;

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
    `Booked: ${result.booked.filter((entry) => entry.decision === "promote").length} promote, ` +
      `${result.booked.filter((entry) => entry.decision === "reject").length} reject, factsClosed ${factsClosed}`,
    ...(result.booked.length === 0
      ? []
      : result.booked.map(
          (entry) =>
            `  - ${entry.decision} ${entry.claimGroupId} (${entry.verdict}, factsClosed ${entry.factsClosed})`,
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

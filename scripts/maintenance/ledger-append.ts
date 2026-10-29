import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { atomicWriteFileSync } from "../lib/atomic-artifact-write.mts";
import {
  assertCliUsage,
  parseStrictCliArgs,
  requireCliString,
  runDirectCli,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import {
  RESOLUTION_MODE_ACTIONS,
  V9_MISSING_DATA_WORK_TYPES,
  type ResolutionMode,
  type WorkType,
} from "../lib/safety-score-v9-missing-data-work-types";

/**
 * The single append path for the Safety Score v9 curation ledger
 * (`.github/artifacts/safety-score-missing-data-reviewed-ledger.json`).
 *
 * The ledger is an append-only review artifact: campaign fragments and the
 * sentinel applier both add decisions here, and nothing may rewrite history.
 * Validation is intentionally asymmetric. Historical rows are read with the
 * vocabulary drift they accumulated (legacy work types, prose sentinels,
 * `family`); newly appended rows must satisfy the current roster, the current
 * work-type/resolution-mode vocabularies and the churn rules.
 */

export const CURATION_LEDGER_PATH =
  ".github/artifacts/safety-score-missing-data-reviewed-ledger.json";
export const CURATION_LEDGER_SCHEMA_VERSION = 1;

/** Canonical field roster and order. New decisions are serialized in this order. */
export const CURATION_LEDGER_DECISION_FIELDS = [
  "claimGroupId",
  "taskIds",
  "workType",
  "resolutionMode",
  "decision",
  "deferState",
  "reviewedAt",
  "reviewer",
  "evidence",
  "rationale",
  "changeRefs",
  "sentinels",
  "nextReviewTrigger",
  "factsClosed",
] as const;

export const CURATION_DECISIONS = ["promote", "reject", "defer"] as const;
export type CurationDecision = (typeof CURATION_DECISIONS)[number];

export const CURATION_WORK_TYPES: ReadonlySet<WorkType> = new Set(
  Object.keys(V9_MISSING_DATA_WORK_TYPES) as WorkType[],
);
export const CURATION_RESOLUTION_MODES: ReadonlySet<ResolutionMode> = new Set([
  "agent-curation",
  ...(Object.keys(RESOLUTION_MODE_ACTIONS) as Exclude<ResolutionMode, "agent-curation">[]),
]);

/**
 * Machine-checkable sentinel form emitted by the registry generator. New
 * decisions should use it; the sentinel sweep only evaluates these forms.
 */
export interface SentinelCondition {
  doneWhenGapIdAbsent: string | null;
  doneWhenScoreReasonAbsent: string | { reasonCode: string; path: unknown } | null;
}

export type LedgerSentinel = string | SentinelCondition;

/** An explicit request to leave the churn parking state with new evidence. */
export interface LedgerUnpark {
  rationale: string;
  evidence: string[];
}

export interface NewCurationLedgerDecision {
  claimGroupId: string;
  taskIds: string[];
  workType: string;
  resolutionMode: string;
  decision: CurationDecision;
  deferState?: string;
  reviewedAt: string;
  reviewer: string;
  evidence: string[];
  rationale: string;
  changeRefs: string[];
  sentinels: LedgerSentinel[];
  nextReviewTrigger: string;
  factsClosed: number;
  unpark?: LedgerUnpark;
}

/**
 * Historical row shape. Extra keys (`family`, legacy variants) are retained so
 * a read/append/write cycle reproduces the stored bytes instead of rewriting
 * history into the current schema.
 */
export interface CurationLedgerDecision {
  claimGroupId: string;
  taskIds: string[];
  workType: string;
  resolutionMode: string;
  decision: CurationDecision;
  deferState?: string | null;
  reviewedAt: string;
  reviewer: string;
  evidence: unknown[];
  rationale: string;
  changeRefs: string[];
  sentinels: unknown;
  nextReviewTrigger: string;
  factsClosed: number;
  [key: string]: unknown;
}

export interface CurationLedger {
  schemaVersion: typeof CURATION_LEDGER_SCHEMA_VERSION;
  description: string;
  decisionFields: readonly string[];
  allowedDecisions: readonly CurationDecision[];
  decisions: readonly CurationLedgerDecision[];
}

export type LedgerAppendFailureReason =
  | "ledger-envelope-invalid"
  | "decision-schema-invalid"
  | "unknown-work-type"
  | "unknown-resolution-mode"
  | "claim-group-work-type-mismatch"
  | "defer-requires-sentinel"
  | "duplicate-decision"
  | "parked-repeated-outcome"
  | "unpark-evidence-not-new"
  | "append-only-violation"
  | "ledger-changed"
  | "decision-input-invalid";

/** Machine-readable refusal. Never converted into a partial append. */
export class LedgerAppendError extends Error {
  readonly reason: LedgerAppendFailureReason;

  constructor(reason: LedgerAppendFailureReason, message: string) {
    super(`${reason}: ${message}`);
    this.name = "LedgerAppendError";
    this.reason = reason;
  }
}

const nonEmptyText = z.string().refine((value) => value.trim().length > 0, "must not be blank");

const SentinelReasonRefSchema = z
  .object({
    reasonCode: nonEmptyText,
    path: z.unknown(),
  })
  .strict();

const SentinelConditionSchema = z
  .object({
    doneWhenGapIdAbsent: nonEmptyText.nullable(),
    doneWhenScoreReasonAbsent: z
      .union([nonEmptyText, SentinelReasonRefSchema])
      .nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.doneWhenGapIdAbsent === null && value.doneWhenScoreReasonAbsent === null) {
      ctx.addIssue({
        code: "custom",
        path: ["doneWhenGapIdAbsent"],
        message: "must name at least one completion condition",
      });
    }
  });

const LedgerSentinelSchema = z.union([nonEmptyText, SentinelConditionSchema]);

/**
 * Keep a historical sentinel only when it satisfies the current writable
 * schema; legacy prose objects are dropped instead of copied into a new row.
 */
export function normalizeWritableLedgerSentinel(value: unknown): LedgerSentinel | null {
  const parsed = LedgerSentinelSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const conditions = parseLedgerSentinel(value);
  if (!conditions.machineCheckable) return null;
  if (conditions.gapIds.length === 1 && conditions.reasonPairs.length === 0 && conditions.reasonCodes.length === 0) {
    return { doneWhenGapIdAbsent: conditions.gapIds[0]!, doneWhenScoreReasonAbsent: null };
  }
  if (conditions.gapIds.length === 0 && conditions.reasonCodes.length === 0 && conditions.reasonPairs.length === 1) {
    const pair = conditions.reasonPairs[0]!;
    return {
      doneWhenGapIdAbsent: null,
      doneWhenScoreReasonAbsent: { reasonCode: pair.reasonCode, path: JSON.parse(pair.pathKey) as unknown },
    };
  }
  if (conditions.gapIds.length === 0 && conditions.reasonPairs.length === 0 && conditions.reasonCodes.length === 1) {
    return { doneWhenGapIdAbsent: null, doneWhenScoreReasonAbsent: conditions.reasonCodes[0]! };
  }
  return null;
}

const LEDGER_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LEDGER_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
// Fractional seconds are bounded so every accepted pattern stays flat (no
// nested quantifier); nine digits covers any ISO-8601 fraction JS can parse.
const LEDGER_TIMESTAMP_FRACTION =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}(?:Z|[+-]\d{2}:\d{2})$/;

/** Ledger `reviewedAt` has historically used date-only and exact UTC timestamps. */
export function parseLedgerInstant(value: string): number | null {
  if (
    !LEDGER_DATE_ONLY.test(value) &&
    !LEDGER_TIMESTAMP.test(value) &&
    !LEDGER_TIMESTAMP_FRACTION.test(value)
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  if (value.length === 10 && new Date(parsed).toISOString().slice(0, 10) !== value) return null;
  return parsed;
}

export const NewCurationLedgerDecisionSchema = z
  .object({
    claimGroupId: nonEmptyText,
    taskIds: z
      .array(nonEmptyText)
      .refine((ids) => new Set(ids).size === ids.length, "task IDs must be unique"),
    workType: nonEmptyText,
    resolutionMode: nonEmptyText,
    decision: z.enum(CURATION_DECISIONS),
    deferState: nonEmptyText.optional(),
    reviewedAt: z.string().refine((value) => parseLedgerInstant(value) !== null, "invalid reviewedAt"),
    reviewer: nonEmptyText,
    evidence: z.array(nonEmptyText).min(1),
    rationale: nonEmptyText,
    changeRefs: z.array(nonEmptyText),
    sentinels: z.array(LedgerSentinelSchema),
    nextReviewTrigger: nonEmptyText,
    factsClosed: z.number().int().min(0),
    unpark: z
      .object({
        rationale: nonEmptyText,
        evidence: z.array(nonEmptyText).min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const HistoricalDecisionSchema = z
  .object({
    claimGroupId: nonEmptyText,
    taskIds: z.array(z.string()),
    workType: nonEmptyText,
    resolutionMode: nonEmptyText,
    decision: z.enum(CURATION_DECISIONS),
    deferState: z.string().nullish(),
    reviewedAt: nonEmptyText,
    reviewer: nonEmptyText,
    // Historical evidence mixes prose with structured capture references; the
    // append path only needs the identity fields, so keep the payload read-lax.
    evidence: z.array(z.unknown()),
    rationale: z.string(),
    changeRefs: z.array(z.string()),
    sentinels: z.unknown(),
    nextReviewTrigger: z.string(),
    factsClosed: z.number().int(),
  })
  .passthrough();

const EnvelopeSchema = z
  .object({
    schemaVersion: z.literal(CURATION_LEDGER_SCHEMA_VERSION),
    description: nonEmptyText,
    decisionFields: z.array(nonEmptyText).min(1),
    allowedDecisions: z.array(z.enum(CURATION_DECISIONS)).min(1),
    decisions: z.array(z.unknown()),
  })
  .strict();

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function sameTextArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Parse and validate a ledger envelope without normalizing stored decisions.
 * The returned objects are the parsed source objects, so serialization keeps
 * historical field order and unknown keys intact.
 */
export function parseCurationLedger(value: unknown): CurationLedger {
  const envelope = EnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    throw new LedgerAppendError("ledger-envelope-invalid", describeIssues(envelope.error));
  }
  if (!sameTextArray(envelope.data.decisionFields, CURATION_LEDGER_DECISION_FIELDS)) {
    throw new LedgerAppendError(
      "ledger-envelope-invalid",
      `decisionFields roster drifted; expected ${CURATION_LEDGER_DECISION_FIELDS.join(", ")}`,
    );
  }
  if (!sameTextArray(envelope.data.allowedDecisions, CURATION_DECISIONS)) {
    throw new LedgerAppendError(
      "ledger-envelope-invalid",
      `allowedDecisions drifted; expected ${CURATION_DECISIONS.join(", ")}`,
    );
  }
  for (const [index, decision] of envelope.data.decisions.entries()) {
    const parsed = HistoricalDecisionSchema.safeParse(decision);
    if (!parsed.success) {
      throw new LedgerAppendError(
        "ledger-envelope-invalid",
        `decisions.${index}: ${describeIssues(parsed.error)}`,
      );
    }
  }
  // `decisions` stays the parsed source objects (validated above) so historical
  // key order and unknown fields survive an append/write cycle unchanged.
  const decisions = envelope.data.decisions as CurationLedgerDecision[];
  return {
    schemaVersion: CURATION_LEDGER_SCHEMA_VERSION,
    description: envelope.data.description,
    decisionFields: envelope.data.decisionFields,
    allowedDecisions: envelope.data.allowedDecisions,
    decisions,
  };
}

export function serializeCurationLedger(ledger: CurationLedger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

export function sha256Hex(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

export interface ReadCurationLedgerResult {
  ledger: CurationLedger;
  sha256: string;
  text: string;
}

export function readCurationLedger(path: string = CURATION_LEDGER_PATH): ReadCurationLedgerResult {
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new LedgerAppendError(
      "ledger-envelope-invalid",
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { ledger: parseCurationLedger(parsed), sha256: sha256Hex(text), text };
}

/** Deterministic JSON for comparison only; historical evidence may hold unsafe numbers. */
export function canonicalLedgerJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalLedgerJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalLedgerJson(record[key])}`);
  return `{${fields.join(",")}}`;
}

function decisionFingerprint(decision: unknown): string {
  return canonicalLedgerJson(decision);
}

function envelopeFingerprint(ledger: CurationLedger): string {
  return canonicalLedgerJson({
    schemaVersion: ledger.schemaVersion,
    description: ledger.description,
    decisionFields: ledger.decisionFields,
    allowedDecisions: ledger.allowedDecisions,
  });
}

/**
 * Validate one candidate against the current schema and vocabulary. Roster
 * order is preserved by the zod object so written decisions are stable.
 */
export function validateNewCurationLedgerDecision(
  candidate: unknown,
  ledger: CurationLedger,
): NewCurationLedgerDecision {
  const parsed = NewCurationLedgerDecisionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new LedgerAppendError("decision-schema-invalid", describeIssues(parsed.error));
  }
  const decision = parsed.data as NewCurationLedgerDecision;
  if (!CURATION_WORK_TYPES.has(decision.workType as WorkType)) {
    throw new LedgerAppendError(
      "unknown-work-type",
      `${decision.claimGroupId}: ${decision.workType} is not a current missing-data work type`,
    );
  }
  if (!CURATION_RESOLUTION_MODES.has(decision.resolutionMode as ResolutionMode)) {
    throw new LedgerAppendError(
      "unknown-resolution-mode",
      `${decision.claimGroupId}: ${decision.resolutionMode} is not a current resolution mode`,
    );
  }
  const groupPrefix = decision.claimGroupId.slice(0, decision.claimGroupId.indexOf(":"));
  if (decision.claimGroupId.indexOf(":") <= 0 || groupPrefix !== decision.workType) {
    throw new LedgerAppendError(
      "claim-group-work-type-mismatch",
      `${decision.claimGroupId} does not start with its workType ${decision.workType}`,
    );
  }
  if (decision.decision === "defer" && decision.sentinels.length === 0) {
    throw new LedgerAppendError(
      "defer-requires-sentinel",
      `${decision.claimGroupId}: a defer must record at least one sentinel`,
    );
  }
  const unpark = decision.unpark;
  if (unpark) {
    const priorEvidence = new Set(
      ledger.decisions
        .filter((entry) => entry.claimGroupId === decision.claimGroupId)
        .flatMap((entry) => entry.evidence)
        .filter((entry): entry is string => typeof entry === "string"),
    );
    if (!unpark.evidence.some((entry) => !priorEvidence.has(entry))) {
      throw new LedgerAppendError(
        "unpark-evidence-not-new",
        `${decision.claimGroupId}: unpark evidence must cite at least one source not already in the group history`,
      );
    }
  }
  return decision;
}

function trailingOutcomeRun(
  decisions: readonly (CurationLedgerDecision | NewCurationLedgerDecision)[],
  claimGroupId: string,
  outcome: CurationDecision,
): number {
  let run = 0;
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index]!;
    if (decision.claimGroupId !== claimGroupId) continue;
    if (decision.decision !== outcome) break;
    run += 1;
  }
  return run;
}

export interface AppendCurationLedgerInput {
  ledger: CurationLedger;
  decisions: readonly unknown[];
  /** Claim groups whose latest named trigger demonstrably fired in this batch. */
  triggerFiredGroups?: Iterable<string>;
}

export interface AppendCurationLedgerResult {
  ledger: CurationLedger;
  appended: readonly NewCurationLedgerDecision[];
}

/**
 * Append decisions to an in-memory ledger. The whole batch is validated before
 * anything is appended, so a rejected candidate never leaves a partial write.
 */
export function appendCurationLedgerDecisions(
  input: AppendCurationLedgerInput,
): AppendCurationLedgerResult {
  if (input.decisions.length === 0) {
    throw new LedgerAppendError("decision-input-invalid", "no decisions were supplied");
  }
  const fingerprints = new Set(input.ledger.decisions.map((entry) => decisionFingerprint(entry)));
  const triggerFired = new Set(input.triggerFiredGroups ?? []);
  const next: Array<CurationLedgerDecision | NewCurationLedgerDecision> = [...input.ledger.decisions];
  const appended: NewCurationLedgerDecision[] = [];
  for (const [index, candidate] of input.decisions.entries()) {
    let decision: NewCurationLedgerDecision;
    try {
      decision = validateNewCurationLedgerDecision(candidate, input.ledger);
    } catch (error) {
      if (error instanceof LedgerAppendError) {
        const candidateGroup =
          typeof candidate === "object" && candidate !== null && "claimGroupId" in candidate
            && typeof candidate.claimGroupId === "string"
            ? candidate.claimGroupId
            : "<unknown group>";
        throw new LedgerAppendError(
          error.reason,
          `decisions.${index} (${candidateGroup}): ` + error.message.slice(error.reason.length + 2),
        );
      }
      throw error;
    }
    const fingerprint = decisionFingerprint(decision);
    if (fingerprints.has(fingerprint)) {
      throw new LedgerAppendError(
        "duplicate-decision",
        `decisions.${index} (${decision.claimGroupId}) already exists in the ledger`,
      );
    }
    if (decision.unpark === undefined && !triggerFired.has(decision.claimGroupId)) {
      const run = trailingOutcomeRun(next, decision.claimGroupId, decision.decision);
      if (run >= 3) {
        throw new LedgerAppendError(
          "parked-repeated-outcome",
          `${decision.claimGroupId}: ${decision.decision} would be identical outcome ${run + 1}; ` +
            "cite unpark evidence or record the fired trigger",
        );
      }
    }
    fingerprints.add(fingerprint);
    next.push(decision);
    appended.push(decision);
  }
  // Appended rows passed the new-decision schema above; historical rows were
  // validated on read, so the union narrows to the stored decision shape.
  const ledger: CurationLedger = { ...input.ledger, decisions: next as CurationLedgerDecision[] };
  assertCurationLedgerAppendOnly(input.ledger, ledger);
  return { ledger, appended };
}

/**
 * Reject any write that would edit, reorder or drop an existing decision.
 * Appends are the only allowed mutation.
 */
export function assertCurationLedgerAppendOnly(
  previous: CurationLedger,
  next: CurationLedger,
): void {
  if (envelopeFingerprint(previous) !== envelopeFingerprint(next)) {
    throw new LedgerAppendError(
      "append-only-violation",
      "ledger envelope metadata changed; only decisions may be appended",
    );
  }
  if (next.decisions.length < previous.decisions.length) {
    throw new LedgerAppendError(
      "append-only-violation",
      `refusing to shrink the ledger from ${previous.decisions.length} to ${next.decisions.length} decisions`,
    );
  }
  for (const [index, decision] of previous.decisions.entries()) {
    if (decisionFingerprint(decision) !== decisionFingerprint(next.decisions[index])) {
      throw new LedgerAppendError(
        "append-only-violation",
        `decisions.${index} (${decision.claimGroupId}) was modified or removed`,
      );
    }
  }
}

export interface WriteCurationLedgerInput {
  path: string;
  ledger: CurationLedger;
  /** SHA-256 of the bytes read before the append (optimistic concurrency). */
  expectedSha256?: string;
}

/**
 * Persist an appended ledger atomically. The on-disk ledger is re-read to
 * prove history is preserved and to detect a concurrent append.
 */
export function writeCurationLedger(input: WriteCurationLedgerInput): void {
  let existing: ReadCurationLedgerResult | null = null;
  try {
    existing = readCurationLedger(input.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  if (existing === null) {
    if (input.expectedSha256 !== undefined) {
      throw new LedgerAppendError("ledger-changed", `${input.path} disappeared after it was read`);
    }
  } else {
    if (input.expectedSha256 !== undefined && existing.sha256 !== input.expectedSha256) {
      throw new LedgerAppendError(
        "ledger-changed",
        `${input.path} changed after it was read; re-read it and retry the append`,
      );
    }
    assertCurationLedgerAppendOnly(existing.ledger, input.ledger);
  }
  const serialized = serializeCurationLedger(input.ledger);
  if (existing?.text === serialized) return;
  atomicWriteFileSync(input.path, serialized);
}

/**
 * Parked state for the worklist renderer. A group is parked when its latest
 * decision is the third or later identical outcome and that decision did not
 * carry an explicit unpark. Parked groups stay in the registry and ledger.
 */
export function curationLedgerParkState(
  decisions: readonly CurationLedgerDecision[],
): ReadonlyMap<string, "parked" | "active"> {
  const latest = indexLatestCurationDecisions(decisions);
  const state = new Map<string, "parked" | "active">();
  for (const [claimGroupId, { decision }] of latest) {
    const run = trailingOutcomeRun(decisions, claimGroupId, decision.decision);
    state.set(claimGroupId, run >= 3 && decision.unpark === undefined ? "parked" : "active");
  }
  return state;
}

/**
 * Latest decision per claim group: the greatest `reviewedAt`, ties to the later
 * appended row. The sweep checker selects the same way, so its per-row decision
 * index resolves to the same row here; taking the last array slot instead would
 * let a backdated append shadow the group's real latest decision.
 */
export function indexLatestCurationDecisions(
  decisions: readonly CurationLedgerDecision[],
): ReadonlyMap<string, { index: number; decision: CurationLedgerDecision }> {
  const latest = new Map<string, { index: number; decision: CurationLedgerDecision }>();
  for (const [index, decision] of decisions.entries()) {
    const current = latest.get(decision.claimGroupId);
    if (current === undefined) {
      latest.set(decision.claimGroupId, { index, decision });
      continue;
    }
    const candidateSec = parseLedgerInstant(decision.reviewedAt) ?? Number.NEGATIVE_INFINITY;
    const currentSec = parseLedgerInstant(current.decision.reviewedAt) ?? Number.NEGATIVE_INFINITY;
    if (candidateSec >= currentSec) latest.set(decision.claimGroupId, { index, decision });
  }
  return latest;
}

export interface ParsedLedgerSentinel {
  /** Machine-readable gap IDs whose absence completes the sentinel. */
  gapIds: string[];
  /** Machine-readable `(reasonCode, path)` pairs whose absence completes the sentinel. */
  reasonPairs: { reasonCode: string; pathKey: string }[];
  /** Reason codes recorded without a path; absent only when the code is absent. */
  reasonCodes: string[];
  /** False for prose sentinels or entries with no completion condition. */
  machineCheckable: boolean;
}

/**
 * Historical rows occasionally store one sentinel object instead of an array.
 * Normalize to a list for the applier without rewriting the stored row.
 */
export function ledgerSentinelList(decision: Pick<CurationLedgerDecision, "sentinels">): readonly unknown[] {
  const sentinels = decision.sentinels;
  if (Array.isArray(sentinels)) return sentinels;
  if (sentinels === null || sentinels === undefined) return [];
  return [sentinels];
}

/**
 * Normalize one ledger sentinel. Prose strings (including JSON-looking
 * strings) are informational only: they can never authorize a closure.
 */
export function parseLedgerSentinel(sentinel: unknown): ParsedLedgerSentinel {
  const result: ParsedLedgerSentinel = {
    gapIds: [],
    reasonPairs: [],
    reasonCodes: [],
    machineCheckable: false,
  };
  if (typeof sentinel === "string") {
    return result;
  }
  if (typeof sentinel !== "object" || sentinel === null || Array.isArray(sentinel)) {
    return result;
  }
  const record = sentinel as Record<string, unknown>;
  const hasGapCondition = Object.hasOwn(record, "doneWhenGapIdAbsent");
  const hasReasonCondition = Object.hasOwn(record, "doneWhenScoreReasonAbsent");
  if (!hasGapCondition && !hasReasonCondition) return result;
  let conditions = 0;
  const gap = record.doneWhenGapIdAbsent;
  if (typeof gap === "string" && gap.trim().length > 0) {
    result.gapIds.push(gap);
    conditions += 1;
  } else if (gap !== null && gap !== undefined) {
    return result;
  }
  const reason = record.doneWhenScoreReasonAbsent;
  if (typeof reason === "string" && reason.trim().length > 0) {
    result.reasonCodes.push(reason);
    conditions += 1;
  } else if (reason !== null && reason !== undefined) {
    if (typeof reason !== "object" || Array.isArray(reason)) return result;
    const reasonRecord = reason as Record<string, unknown>;
    if (typeof reasonRecord.reasonCode !== "string" || reasonRecord.reasonCode.trim().length === 0) {
      return result;
    }
    result.reasonPairs.push({
      reasonCode: reasonRecord.reasonCode,
      pathKey: canonicalLedgerJson(reasonRecord.path ?? null),
    });
    conditions += 1;
  }
  result.machineCheckable = conditions > 0;
  return result;
}

const USAGE = `Usage: npx tsx scripts/maintenance/ledger-append.ts --decisions <path> [options]

Validate new Safety Score v9 curation ledger decisions and append them to the
append-only reviewed ledger.

Options:
  --decisions <path>       JSON file holding one decision object or an array (required)
  --ledger <path>          Ledger path (default ${CURATION_LEDGER_PATH})
  --trigger-fired <group>  Claim group whose recorded trigger demonstrably fired;
                           repeatable. Without it a 4th identical outcome needs unpark evidence.
  --write                  Append to the ledger; without it the run is a preview
  --dry-run                Explicit preview; conflicts with --write
  -h, --help               Show this help

A decision must use the ledger's decisionFields roster, name a current work type
and resolution mode, and include evidence. Defer decisions must carry at least
one sentinel. Identical decisions are rejected, and history is never rewritten.`;

interface AppendCliOutput {
  write(text: string): unknown;
}

function loadDecisionInput(path: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new LedgerAppendError(
      "decision-input-invalid",
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    if ("decisions" in record || "decisionFields" in record || "schemaVersion" in record) {
      throw new LedgerAppendError(
        "decision-input-invalid",
        `${path} looks like a ledger envelope; pass only new decision records`,
      );
    }
    return [parsed];
  }
  throw new LedgerAppendError(
    "decision-input-invalid",
    `${path} must contain a decision object or an array of decisions`,
  );
}

export interface LedgerAppendIo {
  stdout: AppendCliOutput;
}

export function runLedgerAppendCli(
  argv: readonly string[],
  io: LedgerAppendIo = { stdout: process.stdout },
): number {
  const { values } = parseStrictCliArgs(argv, {
    conflicts: [["write", "dry-run"]],
    options: {
      decisions: { type: "string" },
      ledger: { type: "string" },
      "trigger-fired": { type: "string", multiple: true },
      write: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, io.stdout)) return 0;
  const decisionsPath = requireCliString(values.decisions, "--decisions");
  const ledgerPath = typeof values.ledger === "string" ? values.ledger : CURATION_LEDGER_PATH;
  const triggerFired = values["trigger-fired"];
  const triggerFiredGroups =
    typeof triggerFired === "string"
      ? [triggerFired]
      : Array.isArray(triggerFired)
        ? (triggerFired as string[])
        : [];
  const candidates = loadDecisionInput(decisionsPath);
  assertCliUsage(candidates.length > 0, "the decision input is empty");

  const existing = readCurationLedger(ledgerPath);
  const { ledger, appended } = appendCurationLedgerDecisions({
    ledger: existing.ledger,
    decisions: candidates,
    triggerFiredGroups,
  });
  const write = values.write === true;
  if (write) {
    writeCurationLedger({ path: ledgerPath, ledger, expectedSha256: existing.sha256 });
  }
  const lines = [
    `${write ? "Appended decisions" : "Ledger append preview (dry run)"}: ${appended.length}`,
    ...appended.map(
      (decision) =>
        `  - ${decision.decision} ${decision.claimGroupId} @ ${decision.reviewedAt} ` +
        `(factsClosed ${decision.factsClosed}${decision.unpark ? ", unpark" : ""})`,
    ),
    `Ledger decisions: ${existing.ledger.decisions.length} -> ${ledger.decisions.length}`,
    write ? `Wrote ${ledgerPath}` : "Dry run: pass --write to append.",
  ];
  io.stdout.write(`${lines.join("\n")}\n`);
  return appended.length;
}

runDirectCli(import.meta.url, () => {
  runLedgerAppendCli(process.argv.slice(2));
}, { label: "ledger-append", usage: USAGE });

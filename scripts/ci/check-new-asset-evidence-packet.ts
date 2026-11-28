#!/usr/bin/env node

/**
 * New-asset evidence packet gate (PLAN §4.8 DUR-6, §10.5 U1/U2, #1662).
 *
 * Listing a stablecoin, or promoting a pre-launch row to active, needs a
 * committed `schemaVersion: 3` admission receipt. The receipt is the
 * `projectV9CardOpenEvidence` projection for the asset — the `byCard` row plus
 * the question keys with their bucket, obligation count and per-datum
 * documentation flag — in either `prospective-offline` mode (self-contained
 * offline shell + Phase 1a supply observation, recomputed in CI via `--verify`)
 * or `production-capture` mode (replayed against a production capture).
 *
 * Gate contract:
 *  - active registry cardinality ≤ `SAFETY_SCORE_V9_ACTIVE_MAX_ASSETS` (397)
 *    and tracked catalog cardinality ≤ `SAFETY_SCORE_V9_CATALOG_MAX_ASSETS`
 *    (560); no override, checked for any added coin file including pre-launch
 *    stubs, and a non-integer or negative count fails closed as unverifiable;
 *  - ≤ `NEW_ASSET_OPEN_QUESTION_LIMIT` own open questions rooted at the asset;
 *  - zero own non-documentation `missing-mint-authority` datums (U2; no
 *    override);
 *  - `schemaVersion: 3`, exact `registryFingerprint` and
 *    `SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST` (no override);
 *  - for `prospective-offline` receipts: admission clock within
 *    `[maxCuratedReviewSec(cohort), nowSec]` and age ≤
 *    `NEW_ASSET_ADMISSION_CLOCK_MAX_AGE_SEC` (7d), supply `observedAtSec`
 *    ≤ `min(admissionClockSec, retrievedAtSec)`, zero candidate quarantine or
 *    transitive parent `pipeline-gap`, and exact CI recomputation via
 *    `build-safety-score-v9-admission-receipt.ts --verify` (no override);
 *  - the `new-asset-gate-override` owner label bypasses only the open-question
 *    count, never any receipt, binding, clock, quarantine, capacity, or
 *    mint-authority condition.
 *
 * Historical `schemaVersion: 1` and `schemaVersion: 2` receipts stay parseable
 * for archival verification; newly gated candidates must submit
 * `schemaVersion: 3`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import { compareCodeUnits } from "@shared/lib/compare";
import {
  SAFETY_SCORE_V9_ACTIVE_MAX_ASSETS,
  SAFETY_SCORE_V9_CATALOG_MAX_ASSETS,
} from "@shared/lib/safety-score-v9-capacity-limits";
import { isActiveStablecoinMeta, isPreLaunchStablecoinMeta } from "@shared/lib/stablecoins/status";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { UnixSecondsSchema } from "@shared/types/safety-schema-primitives";
import { V9ReasonCodeSchema } from "@shared/types/safety-score-v9";
import { V9ReplaySupplyProvenanceSchema } from "@shared/types/safety-score-v9-facts";
import { V9OpenEvidenceByCardSchema, V9OpenQuestionBucketSchema } from "@shared/types/safety-score-v9-open-evidence";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { STABLECOIN_STATUS_VALUES } from "@shared/types/stablecoin-taxonomy";
import { collectGitPaths } from "../lib/changed-files.mts";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { fingerprintReportCardRegistryRows } from "../lib/report-card-registry-fingerprint";
import { reportViolations, writeJsonReport } from "../lib/report-violations.mts";
import { PER_COIN_SOURCE_DIR } from "../lib/stablecoin-catalog-sources";

/** One owner-tunable constant (R5): ladder target is ≈2 residual questions per asset. */
export const NEW_ASSET_OPEN_QUESTION_LIMIT = 6;
export const NEW_ASSET_GATE_OVERRIDE_LABEL = "new-asset-gate-override";
export const NEW_ASSET_RECEIPT_DIR = ".github/artifacts/new-asset-evidence-packet";
export const NEW_ASSET_RECEIPT_KIND = "safety-score-v9-new-asset-admission-receipt";

/**
 * Maximum age (7 days) of a prospective-offline admission clock relative to
 * gate evaluation time (R5). Dedicated to admission receipts so supply-restore
 * tuning cannot silently alter admission freshness.
 */
export const NEW_ASSET_ADMISSION_CLOCK_MAX_AGE_SEC = 7 * 86_400;

export const PROSPECTIVE_ADMISSION_INPUT_ID_PREFIX = "prospective-admission:v1:" as const;
export const PROSPECTIVE_ABSENT_RUNTIME_LANES = [
  "chain-supply",
  "dex",
  "live-reserves",
  "peg",
  "redemption",
] as const;

export const PROSPECTIVE_VERIFY_FAILURE_KINDS = [
  "recomputed-receipt-mismatch",
  "stale-admission-clock",
  "prospective-asset-quarantined",
  "prospective-parent-pipeline-gap",
] as const;

export type ProspectiveVerifyFailureKind = (typeof PROSPECTIVE_VERIFY_FAILURE_KINDS)[number];

export type ProspectiveReceiptVerificationResult =
  | { ok: true }
  | { ok: false; kind: ProspectiveVerifyFailureKind; message: string };

const MISSING_MINT_AUTHORITY_CODE = "missing-mint-authority" as const;
const ASSET_ID_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*$/u;
const SHA256_HEX_SCHEMA = z.string().regex(/^[0-9a-f]{64}$/u);
const PROSPECTIVE_INPUT_ID_SCHEMA = z.string().regex(/^prospective-admission:v1:[0-9a-f]{64}$/u);
const ProspectiveAbsentRuntimeLaneSchema = z.enum(PROSPECTIVE_ABSENT_RUNTIME_LANES);

const USAGE = `Usage: npm run check:new-asset-evidence-packet -- [options]

Gates the Safety Score admission receipt of every stablecoin this PR lists, and
of every pre-launch row it promotes to active. A schemaVersion 3 receipt is
emitted by \`npm run safety-score-v9:admit-receipt\` and committed under
${NEW_ASSET_RECEIPT_DIR}/<assetId>.json.

Options:
      --base=<ref>          Git ref the PR targets (default: PR_BASE_SHA, GITHUB_BASE_SHA, origin/main)
      --head=<ref>          Git ref under test (default: PR_HEAD_SHA, GITHUB_HEAD_SHA, HEAD)
      --receipt-dir=<path>  Committed receipt directory (default: ${NEW_ASSET_RECEIPT_DIR})
      --override            The ${NEW_ASSET_GATE_OVERRIDE_LABEL} owner label is present; bypasses the question count only
      --json                Print the report as JSON
  -h, --help                Show this help

Exit codes: 0 admitted, 1 gate violation, 2 usage error.`;

/** The coin fields admission classification reads; everything else stays with `check:stablecoin-data`. */
export interface CoinAdmissionSnapshot {
  id: string;
  status: StablecoinMeta["status"];
}

export type NewAssetGateOrigin = "listing" | "promotion";

export interface NewAssetGateCandidate {
  assetId: string;
  path: string;
  origin: NewAssetGateOrigin;
}

export interface SkippedCoinPath {
  path: string;
  reason: string;
}

const ReceiptQuestionCodeSchema = z
  .strictObject({
    code: V9ReasonCodeSchema,
    obligations: z.number().int().positive(),
    /** True when the T2 documentation classifier assigned this datum a documentation reason. */
    documentation: z.boolean(),
  });

const ReceiptQuestionSchema = z
  .strictObject({
    questionKey: z.string().min(1).max(512),
    bucket: V9OpenQuestionBucketSchema,
    /** Rooted at another card: counted once at its root, disclosed but not gated here. */
    inherited: z.boolean(),
    obligations: z.number().int().positive(),
    codes: z.array(ReceiptQuestionCodeSchema).min(1),
  })
  .superRefine((question, ctx) => {
    const codeObligations = question.codes.reduce((total, code) => total + code.obligations, 0);
    if (codeObligations !== question.obligations) {
      ctx.addIssue({
        code: "custom",
        path: ["codes"],
        message: `question codes account for ${codeObligations} obligations, expected ${question.obligations}`,
      });
    }
    const documentationCodes = question.codes.filter((code) => code.documentation).length;
    if (question.bucket === "documentation" && documentationCodes !== question.codes.length) {
      ctx.addIssue({
        code: "custom",
        path: ["codes"],
        message: "a documentation question carries only documentation-classed datums",
      });
    }
    if (question.bucket !== "documentation" && documentationCodes === question.codes.length) {
      ctx.addIssue({
        code: "custom",
        path: ["codes"],
        message: `a ${question.bucket} question carries at least one counted datum`,
      });
    }
    if (
      new Set(question.codes.map((code) => `${code.code}\u0000${code.documentation ? "1" : "0"}`)).size !==
      question.codes.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["codes"],
        message: "question (code, documentation) pairs are unique",
      });
    }
  });

export const ProspectiveSupplyObservationSchema = z
  .strictObject({
    circulating: z.record(z.string().min(1), z.number().finite().nonnegative()),
    observedAtSec: UnixSecondsSchema.nullable(),
    ...V9ReplaySupplyProvenanceSchema.shape,
  })
  .superRefine((observation, ctx) => {
    if (getCirculatingRawOrNull(observation) === null) {
      ctx.addIssue({
        code: "custom",
        path: ["circulating"],
        message: "supply observation requires at least one observed USD circulating bucket",
      });
    }
  });

export type ProspectiveSupplyObservation = z.infer<typeof ProspectiveSupplyObservationSchema>;

const CaptureReceiptBaseFields = {
  kind: z.literal(NEW_ASSET_RECEIPT_KIND),
  assetId: z.string().min(1),
  captureId: z.string().min(1),
  captureClockSec: z.number().int().positive(),
  registryFingerprint: SHA256_HEX_SCHEMA,
  card: V9OpenEvidenceByCardSchema,
  questions: z.array(ReceiptQuestionSchema),
};

const NewAssetAdmissionReceiptV1ObjectSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...CaptureReceiptBaseFields,
});

const NewAssetAdmissionReceiptV2ObjectSchema = z.strictObject({
  schemaVersion: z.literal(2),
  ...CaptureReceiptBaseFields,
  evaluationBuildDigest: SHA256_HEX_SCHEMA,
});

const NewAssetAdmissionReceiptV3ProductionCaptureObjectSchema = z.strictObject({
  schemaVersion: z.literal(3),
  receiptMode: z.literal("production-capture"),
  ...CaptureReceiptBaseFields,
  evaluationBuildDigest: SHA256_HEX_SCHEMA,
});

const NewAssetAdmissionReceiptV3ProspectiveOfflineObjectSchema = z.strictObject({
  schemaVersion: z.literal(3),
  receiptMode: z.literal("prospective-offline"),
  kind: z.literal(NEW_ASSET_RECEIPT_KIND),
  assetId: z.string().min(1),
  prospectiveInputId: PROSPECTIVE_INPUT_ID_SCHEMA,
  admissionClockSec: z.number().int().positive(),
  evaluatedCohortIds: z.array(z.string().min(1)).min(1),
  absentRuntimeLanes: z.array(ProspectiveAbsentRuntimeLaneSchema).min(1),
  supplyObservation: ProspectiveSupplyObservationSchema,
  registryFingerprint: SHA256_HEX_SCHEMA,
  evaluationBuildDigest: SHA256_HEX_SCHEMA,
  card: V9OpenEvidenceByCardSchema,
  questions: z.array(ReceiptQuestionSchema),
});

function isUniqueSortedCodeUnits(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index++) {
    if (compareCodeUnits(values[index - 1]!, values[index]!) >= 0) return false;
  }
  return true;
}

/**
 * U1 admission receipt. `card` is CNT-1's published by-card row, so the gate
 * reads the same counts the publication would; `questions` is the audit trail
 * behind those counts and the only place the documentation class of a
 * `missing-mint-authority` datum is recorded.
 *
 * Historical `schemaVersion: 1` and `schemaVersion: 2` receipts stay parseable
 * for archival verification, while newly gated candidates must supply
 * `schemaVersion: 3` (`prospective-offline` or `production-capture`).
 */
export const NewAssetAdmissionReceiptSchema = z
  .union([
    NewAssetAdmissionReceiptV1ObjectSchema,
    NewAssetAdmissionReceiptV2ObjectSchema,
    NewAssetAdmissionReceiptV3ProductionCaptureObjectSchema,
    NewAssetAdmissionReceiptV3ProspectiveOfflineObjectSchema,
  ])
  .superRefine((receipt, ctx) => {
    if (receipt.card.id !== receipt.assetId) {
      ctx.addIssue({ code: "custom", path: ["card", "id"], message: "card row must be the receipt's asset" });
    }
    if (receipt.schemaVersion === 3 && receipt.receiptMode === "prospective-offline") {
      if (!isUniqueSortedCodeUnits(receipt.evaluatedCohortIds)) {
        ctx.addIssue({
          code: "custom",
          path: ["evaluatedCohortIds"],
          message: "evaluatedCohortIds must be unique and sorted",
        });
      }
      if (!receipt.evaluatedCohortIds.includes(receipt.assetId)) {
        ctx.addIssue({
          code: "custom",
          path: ["evaluatedCohortIds"],
          message: "evaluatedCohortIds must include assetId",
        });
      }
      if (
        !isUniqueSortedCodeUnits(receipt.absentRuntimeLanes) ||
        receipt.absentRuntimeLanes.length !== PROSPECTIVE_ABSENT_RUNTIME_LANES.length ||
        receipt.absentRuntimeLanes.some((lane, index) => lane !== PROSPECTIVE_ABSENT_RUNTIME_LANES[index])
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["absentRuntimeLanes"],
          message: `absentRuntimeLanes must list all absent offline lanes (${PROSPECTIVE_ABSENT_RUNTIME_LANES.join(", ")})`,
        });
      }
    }
    const questionKeys = receipt.questions.map((question) => question.questionKey);
    if (new Set(questionKeys).size !== questionKeys.length) {
      ctx.addIssue({ code: "custom", path: ["questions"], message: "question keys are unique" });
    }
    const open = receipt.questions.filter((question) => question.bucket === "open");
    if (open.length !== receipt.card.openBucketQuestionsCarried) {
      ctx.addIssue({
        code: "custom",
        path: ["card", "openBucketQuestionsCarried"],
        message: `card claims ${receipt.card.openBucketQuestionsCarried} open questions, list has ${open.length}`,
      });
    }
    const inheritedOpen = open.filter((question) => question.inherited).length;
    if (inheritedOpen !== receipt.card.inheritedOpenBucketQuestionsCarried) {
      ctx.addIssue({
        code: "custom",
        path: ["card", "inheritedOpenBucketQuestionsCarried"],
        message: `card claims ${receipt.card.inheritedOpenBucketQuestionsCarried} inherited open questions, list has ${inheritedOpen}`,
      });
    }
    const openObligations = open.reduce((total, question) => total + question.obligations, 0);
    if (openObligations !== receipt.card.openBucketObligationsCarried) {
      ctx.addIssue({
        code: "custom",
        path: ["card", "openBucketObligationsCarried"],
        message: `card claims ${receipt.card.openBucketObligationsCarried} open obligations, list has ${openObligations}`,
      });
    }
    const documentationObligations = receipt.questions.reduce(
      (total, question) =>
        total + question.codes
          .filter((code) => code.documentation)
          .reduce((datumTotal, code) => datumTotal + code.obligations, 0),
      0,
    );
    if (documentationObligations !== receipt.card.documentationObligationsCarried) {
      ctx.addIssue({
        code: "custom",
        path: ["card", "documentationObligationsCarried"],
        message: `card claims ${receipt.card.documentationObligationsCarried} documentation obligations, list has ${documentationObligations}`,
      });
    }
  });

export type NewAssetAdmissionReceipt = z.infer<typeof NewAssetAdmissionReceiptSchema>;
export type ProspectiveOfflineAdmissionReceipt = Extract<
  NewAssetAdmissionReceipt,
  { schemaVersion: 3; receiptMode: "prospective-offline" }
>;
export type ProductionCaptureAdmissionReceipt = Extract<
  NewAssetAdmissionReceipt,
  { schemaVersion: 3; receiptMode: "production-capture" }
>;

export type NewAssetGateFailureKind =
  | "invalid-asset-id"
  | "missing-receipt"
  | "invalid-receipt"
  | "mismatched-receipt"
  | "stale-receipt"
  | "stale-evaluation-build"
  | "stale-admission-clock"
  | "recomputed-receipt-mismatch"
  | "prospective-asset-quarantined"
  | "prospective-parent-pipeline-gap"
  | "active-capacity-exceeded"
  | "catalog-capacity-exceeded"
  | "open-question-limit"
  | "missing-mint-authority";

export interface NewAssetGateFailure {
  assetId: string;
  origin: NewAssetGateOrigin | "catalog";
  kind: NewAssetGateFailureKind;
  message: string;
}

export interface NewAssetGatePass {
  assetId: string;
  origin: NewAssetGateOrigin;
  receiptMode: "prospective-offline" | "production-capture";
  captureId: string | null;
  prospectiveInputId: string | null;
  openQuestions: number;
  inheritedOpenQuestions: number;
  overridden: boolean;
}

export interface NewAssetGateReport {
  candidates: NewAssetGateCandidate[];
  passed: NewAssetGatePass[];
  failures: NewAssetGateFailure[];
  warnings: string[];
}

export interface EvaluateNewAssetEvidencePacketInput {
  candidates: readonly NewAssetGateCandidate[];
  registryFingerprint: string;
  evaluationBuildDigest?: string;
  /** Active stablecoin count on this branch checkout; checked against `SAFETY_SCORE_V9_ACTIVE_MAX_ASSETS`. */
  activeAssetCount?: number;
  /** Tracked catalog count on this branch checkout; checked against `SAFETY_SCORE_V9_CATALOG_MAX_ASSETS`. */
  catalogAssetCount?: number;
  /** Reference Unix seconds for admission clock freshness/future checks. */
  nowSec?: number;
  override: boolean;
  /** Raw committed receipt JSON for the candidate, or null when none is committed. */
  readReceipt: (candidate: NewAssetGateCandidate) => string | null;
  /** Recomputes and verifies a prospective-offline receipt against the checkout; fail-closed when omitted. */
  verifyProspectiveReceipt?: (
    candidate: NewAssetGateCandidate,
    receipt: ProspectiveOfflineAdmissionReceipt,
  ) => ProspectiveReceiptVerificationResult;
}

/** True for a direct child of the per-coin source directory (`coins/<id>.json`). */
export function isPerCoinAssetPath(path: string): boolean {
  const prefix = `${PER_COIN_SOURCE_DIR}/`;
  if (!path.startsWith(prefix) || !path.endsWith(".json")) return false;
  const fileName = path.slice(prefix.length, -".json".length);
  return fileName.length > 0 && !fileName.includes("/");
}

/** Reads only the fields admission classification needs; a malformed file is unreadable, not a verdict. */
export function parseCoinAdmissionSnapshot(raw: string): CoinAdmissionSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim().length === 0) return null;
  if (record.status === undefined) return { id: record.id, status: undefined };
  const status = STABLECOIN_STATUS_VALUES.find((candidate) => candidate === record.status);
  return status === undefined ? null : { id: record.id, status };
}

/**
 * Splits the PR's coin-file changes into gated candidates and untouched paths.
 * An added active asset is a listing; a pre-launch -> active modification is a
 * promotion. Any other modified coin — the normal curation edit on an existing
 * asset — is never gated.
 */
export function classifyNewAssetGateCandidates({
  addedPaths,
  modifiedPaths,
  readHeadCoin,
  readBaseCoin,
}: {
  addedPaths: readonly string[];
  modifiedPaths: readonly string[];
  readHeadCoin: (path: string) => CoinAdmissionSnapshot | null;
  readBaseCoin: (path: string) => CoinAdmissionSnapshot | null;
}): { candidates: NewAssetGateCandidate[]; skipped: SkippedCoinPath[] } {
  const candidates: NewAssetGateCandidate[] = [];
  const skipped: SkippedCoinPath[] = [];
  for (const path of [...addedPaths].sort(compareCodeUnits)) {
    const coin = readHeadCoin(path);
    if (coin === null) {
      skipped.push({ path, reason: "unreadable-coin-file" });
      continue;
    }
    if (!isActiveStablecoinMeta(coin)) {
      skipped.push({ path, reason: `not-a-listing (${coin.status ?? "unreadable"})` });
      continue;
    }
    candidates.push({ assetId: coin.id, path, origin: "listing" });
  }
  for (const path of [...modifiedPaths].sort(compareCodeUnits)) {
    const head = readHeadCoin(path);
    if (head === null) {
      skipped.push({ path, reason: "unreadable-coin-file" });
      continue;
    }
    if (!isActiveStablecoinMeta(head)) {
      skipped.push({ path, reason: `not-a-promotion (${head.status ?? "unreadable"})` });
      continue;
    }
    const base = readBaseCoin(path);
    if (base === null) {
      skipped.push({ path, reason: "no-base-coin-file" });
      continue;
    }
    if (!isPreLaunchStablecoinMeta(base)) {
      skipped.push({ path, reason: "existing-asset" });
      continue;
    }
    candidates.push({ assetId: head.id, path, origin: "promotion" });
  }
  candidates.sort(
    (left, right) => compareCodeUnits(left.assetId, right.assetId) || compareCodeUnits(left.path, right.path),
  );
  return { candidates, skipped };
}

function formatReceiptIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
}

/**
 * Applies the gate to already-detected candidates. Pure: the registry
 * fingerprint, active count, committed receipts, and prospective verifier are
 * inputs, so the CLI and the tests share one decision path.
 */
export function evaluateNewAssetEvidencePacket({
  candidates,
  registryFingerprint,
  evaluationBuildDigest = SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
  activeAssetCount,
  catalogAssetCount,
  nowSec = Math.floor(Date.now() / 1_000),
  override,
  readReceipt,
  verifyProspectiveReceipt,
}: EvaluateNewAssetEvidencePacketInput): NewAssetGateReport {
  const report: NewAssetGateReport = { candidates: [...candidates], passed: [], failures: [], warnings: [] };
  const fail = (candidate: NewAssetGateCandidate, kind: NewAssetGateFailureKind, message: string): void => {
    report.failures.push({ assetId: candidate.assetId, origin: candidate.origin, kind, message });
  };
  // An unreadable count fails closed like an overage, but names a registry-load defect, not a cap to raise.
  const capacityFailureMessage = (
    scope: "active" | "catalog",
    count: number | undefined,
    limitName: string,
    limit: number,
    admits: string,
  ): string | null => {
    if (count === undefined) return null;
    if (!Number.isSafeInteger(count) || count < 0) {
      return `${scope} stablecoin count ${count} is not a non-negative integer, so ${limitName} (${limit}) cannot be ` +
        "verified; fix the registry count, not the cap (this condition has no override)";
    }
    return count > limit
      ? `${scope} stablecoin count ${count} exceeds ${limitName} (${limit}); cannot admit ${admits} without raising V9 ` +
        "capacity (this condition has no override)"
      : null;
  };
  const capacityFailures = [
    ["active", "active-capacity-exceeded", capacityFailureMessage("active", activeAssetCount,
      "SAFETY_SCORE_V9_ACTIVE_MAX_ASSETS", SAFETY_SCORE_V9_ACTIVE_MAX_ASSETS, "active listing or promotion")],
    ["catalog", "catalog-capacity-exceeded", capacityFailureMessage("catalog", catalogAssetCount,
      "SAFETY_SCORE_V9_CATALOG_MAX_ASSETS", SAFETY_SCORE_V9_CATALOG_MAX_ASSETS, "catalog addition")],
  ] as const;

  // A stub-only diff has no candidate to carry the registry-wide caps, so each over-cap count reports once.
  if (candidates.length === 0) {
    for (const [assetId, kind, message] of capacityFailures) {
      if (message !== null) report.failures.push({ assetId, origin: "catalog", kind, message });
    }
  }

  for (const candidate of candidates) {
    let failed = false;
    for (const [, kind, message] of capacityFailures) {
      if (message === null) continue;
      failed = true;
      fail(candidate, kind, message);
    }
    if (!ASSET_ID_PATTERN.test(candidate.assetId)) {
      fail(candidate, "invalid-asset-id", `asset id "${candidate.assetId}" cannot name a receipt file; fix the per-coin id`);
      continue;
    }
    const rawReceipt = readReceipt(candidate);
    if (rawReceipt === null) {
      fail(
        candidate,
        "missing-receipt",
        `no committed admission receipt at ${NEW_ASSET_RECEIPT_DIR}/${candidate.assetId}.json; emit a schemaVersion 3 ` +
          "receipt on this branch via `npm run safety-score-v9:admit-receipt` and commit it",
      );
      continue;
    }
    let parsedReceipt: unknown;
    try {
      parsedReceipt = JSON.parse(rawReceipt);
    } catch (error) {
      fail(candidate, "invalid-receipt", `receipt is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const admission = NewAssetAdmissionReceiptSchema.safeParse(parsedReceipt);
    if (!admission.success) {
      fail(candidate, "invalid-receipt", formatReceiptIssues(admission.error));
      continue;
    }
    const receipt = admission.data;
    if (receipt.assetId !== candidate.assetId) {
      fail(candidate, "mismatched-receipt", `receipt names asset "${receipt.assetId}"`);
      continue;
    }
    if (receipt.schemaVersion !== 3) {
      fail(
        candidate,
        "stale-evaluation-build",
        `receipt uses historical schemaVersion ${receipt.schemaVersion}; ` +
          "emit a schemaVersion 3 receipt on this branch via `npm run safety-score-v9:admit-receipt` (this condition has no override)",
      );
      continue;
    }
    if (receipt.registryFingerprint !== registryFingerprint) {
      fail(
        candidate,
        "stale-receipt",
        `receipt binds registry ${receipt.registryFingerprint}, this checkout is ${registryFingerprint}; ` +
          "re-run `npm run safety-score-v9:admit-receipt` on this branch so the addition is inside the receipt",
      );
      continue;
    }
    if (receipt.evaluationBuildDigest !== evaluationBuildDigest) {
      fail(
        candidate,
        "stale-evaluation-build",
        `receipt binds evaluation build ${receipt.evaluationBuildDigest}, this checkout is ${evaluationBuildDigest}; ` +
          "re-run `npm run safety-score-v9:admit-receipt` on this branch so the receipt binds the current Safety Score build " +
          "(this condition has no override)",
      );
      continue;
    }

    if (receipt.receiptMode === "prospective-offline") {
      if (receipt.admissionClockSec > nowSec) {
        fail(
          candidate,
          "stale-admission-clock",
          `admissionClockSec ${receipt.admissionClockSec} is in the future relative to ${nowSec} ` +
            "(this condition has no override)",
        );
        continue;
      }
      const clockAgeSec = nowSec - receipt.admissionClockSec;
      if (clockAgeSec > NEW_ASSET_ADMISSION_CLOCK_MAX_AGE_SEC) {
        fail(
          candidate,
          "stale-admission-clock",
          `admissionClockSec ${receipt.admissionClockSec} is ${clockAgeSec}s old ` +
            `(max ${NEW_ASSET_ADMISSION_CLOCK_MAX_AGE_SEC}s); regenerate the prospective receipt on this branch ` +
            "(this condition has no override)",
        );
        continue;
      }
      const { observedAtSec, retrievedAtSec } = receipt.supplyObservation;
      if (observedAtSec !== null && observedAtSec > Math.min(receipt.admissionClockSec, retrievedAtSec)) {
        fail(
          candidate,
          "stale-admission-clock",
          `supplyObservation.observedAtSec (${observedAtSec}) exceeds min(admissionClockSec=${receipt.admissionClockSec}, ` +
            `retrievedAtSec=${retrievedAtSec}) (this condition has no override)`,
        );
        continue;
      }
      if (!verifyProspectiveReceipt) {
        fail(
          candidate,
          "recomputed-receipt-mismatch",
          "prospective-offline receipt verification was not configured (this condition has no override)",
        );
        continue;
      }
      const verification = verifyProspectiveReceipt(candidate, receipt);
      if (!verification.ok) {
        fail(candidate, verification.kind, verification.message);
        continue;
      }
    }

    const ownOpen = receipt.questions.filter((question) => question.bucket === "open" && !question.inherited);
    const inheritedOpen = receipt.card.inheritedOpenBucketQuestionsCarried;
    const mintDatums = receipt.questions.filter(
      (question) => !question.inherited &&
        question.codes.some((code) => code.code === MISSING_MINT_AUTHORITY_CODE && !code.documentation),
    );
    const inheritedMintQuestionKeys = receipt.questions
      .filter(
        (question) => question.inherited &&
          question.codes.some((code) => code.code === MISSING_MINT_AUTHORITY_CODE && !code.documentation),
      )
      .map((question) => question.questionKey)
      .sort(compareCodeUnits);
    if (inheritedMintQuestionKeys.length > 0) {
      report.warnings.push(
        `${candidate.assetId}: inherits ${inheritedMintQuestionKeys.length} non-documentation missing-mint-authority ` +
          `question(s) from another asset's profile: ${inheritedMintQuestionKeys.join(", ")}`,
      );
    }

    if (mintDatums.length > 0) {
      failed = true;
      fail(
        candidate,
        "missing-mint-authority",
        `non-documentation missing-mint-authority datum(s): ` +
          `${mintDatums.map((question) => question.questionKey).sort(compareCodeUnits).join(", ")}; ` +
          "author the reviewed mint-authority profile (this condition has no override)",
      );
    }
    if (ownOpen.length > NEW_ASSET_OPEN_QUESTION_LIMIT) {
      if (override) {
        report.warnings.push(
          `${candidate.assetId}: ${ownOpen.length} open questions admitted under the ${NEW_ASSET_GATE_OVERRIDE_LABEL} owner label`,
        );
      } else {
        failed = true;
        fail(
          candidate,
          "open-question-limit",
          `${ownOpen.length} open questions (limit ${NEW_ASSET_OPEN_QUESTION_LIMIT}): ` +
            `${ownOpen.map((question) => question.questionKey).sort(compareCodeUnits).join(", ")}; ` +
            `close them or add the ${NEW_ASSET_GATE_OVERRIDE_LABEL} label`,
        );
      }
    }
    if (failed) continue;
    report.passed.push({
      assetId: candidate.assetId,
      origin: candidate.origin,
      receiptMode: receipt.receiptMode,
      captureId: receipt.receiptMode === "production-capture" ? receipt.captureId : null,
      prospectiveInputId: receipt.receiptMode === "prospective-offline" ? receipt.prospectiveInputId : null,
      openQuestions: ownOpen.length,
      inheritedOpenQuestions: inheritedOpen,
      overridden: ownOpen.length > NEW_ASSET_OPEN_QUESTION_LIMIT,
    });
  }
  return report;
}

async function loadNewAssetRegistryState(): Promise<{
  registryFingerprint: string;
  activeAssetCount: number;
  catalogAssetCount: number;
}> {
  const [{ ACTIVE_STABLECOINS, FROZEN_STABLECOINS, TRACKED_SOURCE_COINS }, { DEAD_STABLECOINS }] = await Promise.all([
    import("@shared/lib/stablecoins/registry"),
    import("@shared/lib/dead-stablecoins"),
  ]);
  return {
    registryFingerprint: fingerprintReportCardRegistryRows({
      activeStablecoins: ACTIVE_STABLECOINS,
      frozenStablecoins: FROZEN_STABLECOINS,
      deadStablecoins: DEAD_STABLECOINS,
    }),
    activeAssetCount: ACTIVE_STABLECOINS.length,
    catalogAssetCount: TRACKED_SOURCE_COINS.length,
  };
}

/**
 * The PR checkout's registry fingerprint, recomputed from the loaded registry —
 * the same authority the replay snapshot uses. Loaded lazily so importing this
 * module (tests, helper reuse) never materializes the full catalog.
 */
export async function computeNewAssetRegistryFingerprint(): Promise<string> {
  return (await loadNewAssetRegistryState()).registryFingerprint;
}

const VerifyChildResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    kind: z.enum(PROSPECTIVE_VERIFY_FAILURE_KINDS),
    message: z.string().min(1),
  }),
]);

/**
 * ADR-2 clean CI recomputation: spawns the Worker-bound verifier CLI rather
 * than importing `worker/src/**` into `scripts/`.
 */
export function verifyCommittedProspectiveReceipt(
  receiptPath: string,
  { nowSec, cwd }: { nowSec: number; cwd: string },
): ProspectiveReceiptVerificationResult {
  const scriptPath = resolve(cwd, "worker/scripts/build-safety-score-v9-admission-receipt.ts");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--verify", receiptPath, "--now", String(nowSec), "--json"],
    { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
  );
  if (result.error) {
    return {
      ok: false,
      kind: "recomputed-receipt-mismatch",
      message: `prospective receipt verification failed to spawn: ${result.error.message}`,
    };
  }
  const stdout = result.stdout.trim();
  if (stdout.length > 0) {
    try {
      const parsed = VerifyChildResponseSchema.safeParse(JSON.parse(stdout));
      if (parsed.success) {
        if (parsed.data.ok && result.status === 0) return { ok: true };
        if (!parsed.data.ok) return { ok: false, kind: parsed.data.kind, message: parsed.data.message };
      }
    } catch {
      // Fall through to fail-closed error below.
    }
  }
  const stderr = result.stderr.trim();
  return {
    ok: false,
    kind: "recomputed-receipt-mismatch",
    message:
      `prospective receipt verification exited ${result.status ?? "signal"}` +
      `${stderr.length > 0 ? `: ${stderr.slice(0, 400)}` : stdout.length > 0 ? `: ${stdout.slice(0, 400)}` : ""}`,
  };
}

function readGitUtf8(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function resolveMergeBase(base: string, head: string, cwd: string): string {
  try {
    const mergeBase = readGitUtf8(["merge-base", base, head], cwd).trim();
    return mergeBase.length > 0 ? mergeBase : base;
  } catch {
    return base;
  }
}

function readWorktreeCoin(path: string, cwd: string): CoinAdmissionSnapshot | null {
  try {
    return parseCoinAdmissionSnapshot(readFileSync(resolve(cwd, path), "utf8"));
  } catch {
    return null;
  }
}

function readGitCoin(ref: string, path: string, cwd: string): CoinAdmissionSnapshot | null {
  try {
    return parseCoinAdmissionSnapshot(readGitUtf8(["show", `${ref}:${path}`], cwd));
  } catch {
    return null;
  }
}

function readCommittedReceipt(assetId: string, receiptDir: string, cwd: string): string | null {
  try {
    return readFileSync(resolve(cwd, receiptDir, `${assetId}.json`), "utf8");
  } catch {
    return null;
  }
}

export interface NewAssetEvidencePacketCheckResult {
  base: string;
  head: string;
  mergeBase: string;
  registryFingerprint: string;
  evaluationBuildDigest: string;
  activeAssetCount: number | null;
  activeCapacityLimit: number;
  catalogAssetCount: number | null;
  catalogCapacityLimit: number;
  override: boolean;
  receiptDir: string;
  report: NewAssetGateReport;
  skipped: SkippedCoinPath[];
}

export async function inspectNewAssetEvidencePacket(
  { base, head, receiptDir, override, cwd, nowSec = Math.floor(Date.now() / 1_000) }: {
    base: string;
    head: string;
    receiptDir: string;
    override: boolean;
    cwd: string;
    nowSec?: number;
  },
): Promise<NewAssetEvidencePacketCheckResult> {
  const mergeBase = resolveMergeBase(base, head, cwd);
  const changed = (diffFilter: string): string[] =>
    collectGitPaths({ kind: "range", base: mergeBase, head, diffFilter }, { cwd }).filter(isPerCoinAssetPath);
  const addedPaths = changed("A");
  const modifiedPaths = changed("M");
  const { candidates, skipped } = classifyNewAssetGateCandidates({
    addedPaths,
    modifiedPaths,
    readHeadCoin: (path) => readWorktreeCoin(path, cwd),
    readBaseCoin: (path) => readGitCoin(mergeBase, path, cwd),
  });
  const registryState = candidates.length === 0 && addedPaths.length === 0
    ? null
    : await loadNewAssetRegistryState();
  const registryFingerprint = registryState?.registryFingerprint ?? "";
  const activeAssetCount = registryState?.activeAssetCount ?? null;
  const catalogAssetCount = registryState?.catalogAssetCount ?? null;
  const evaluationBuildDigest = SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST;
  const report = evaluateNewAssetEvidencePacket({
    candidates,
    registryFingerprint,
    evaluationBuildDigest,
    ...(activeAssetCount === null ? {} : { activeAssetCount }),
    ...(catalogAssetCount === null ? {} : { catalogAssetCount }),
    nowSec,
    override,
    readReceipt: (candidate) => readCommittedReceipt(candidate.assetId, receiptDir, cwd),
    verifyProspectiveReceipt: (candidate) =>
      verifyCommittedProspectiveReceipt(resolve(cwd, receiptDir, `${candidate.assetId}.json`), { nowSec, cwd }),
  });
  return {
    base,
    head,
    mergeBase,
    registryFingerprint,
    evaluationBuildDigest,
    activeAssetCount,
    activeCapacityLimit: SAFETY_SCORE_V9_ACTIVE_MAX_ASSETS,
    catalogAssetCount,
    catalogCapacityLimit: SAFETY_SCORE_V9_CATALOG_MAX_ASSETS,
    override,
    receiptDir,
    report,
    skipped,
  };
}

export async function runNewAssetEvidencePacketCheck(
  argv: readonly string[],
  { cwd = process.cwd() }: { cwd?: string } = {},
): Promise<number> {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      base: { type: "string" },
      head: { type: "string" },
      "receipt-dir": { type: "string" },
      override: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return 0;

  const base = typeof values.base === "string"
    ? values.base
    : process.env.PR_BASE_SHA || process.env.GITHUB_BASE_SHA || "origin/main";
  const head = typeof values.head === "string" ? values.head : process.env.PR_HEAD_SHA || process.env.GITHUB_HEAD_SHA || "HEAD";
  const receiptDir = typeof values["receipt-dir"] === "string" ? values["receipt-dir"] : NEW_ASSET_RECEIPT_DIR;
  const result = await inspectNewAssetEvidencePacket({
    base,
    head,
    receiptDir,
    override: values.override === true,
    cwd,
  });
  const { report } = result;
  const failedCandidates = new Set(
    report.failures
      .filter((failure) => failure.origin !== "catalog")
      .map((failure) => `${failure.assetId}\u0000${failure.origin}`),
  );
  const admitted = report.candidates.length - failedCandidates.size;

  if (values.json === true) {
    writeJsonReport(result);
    return report.failures.length > 0 ? 1 : 0;
  }
  for (const entry of result.skipped) {
    process.stdout.write(`skip ${entry.path}: ${entry.reason}\n`);
  }
  if (report.candidates.length === 0 && report.failures.length === 0) {
    process.stdout.write(`New-asset evidence packet: no added or promoted stablecoins in ${result.mergeBase}...${head}.\n`);
    return 0;
  }
  for (const pass of report.passed) {
    const provenance = pass.receiptMode === "prospective-offline"
      ? `prospective ${pass.prospectiveInputId}`
      : `capture ${pass.captureId}`;
    process.stdout.write(
      `ok ${pass.assetId} (${pass.origin}): ${pass.openQuestions} open question(s)` +
        `${pass.inheritedOpenQuestions > 0 ? `, ${pass.inheritedOpenQuestions} inherited` : ""}` +
        `${pass.overridden ? ` [${NEW_ASSET_GATE_OVERRIDE_LABEL}]` : ""} · ${provenance}\n`,
    );
  }
  for (const warning of report.warnings) process.stdout.write(`warning: ${warning}\n`);
  return reportViolations({
    label: "new-asset evidence packet",
    heading: "New-asset evidence packet gate failed",
    violations: report.failures.map((failure) => `${failure.assetId} (${failure.origin}, ${failure.kind}): ${failure.message}`),
    hint:
      `Generate a schemaVersion 3 receipt on this branch with \`npm run safety-score-v9:admit-receipt\` ` +
      `(registry fingerprint ${result.registryFingerprint || "not computed"}). The ${NEW_ASSET_GATE_OVERRIDE_LABEL} label ` +
      "bypasses only the open-question count, never the receipt, clock, verification, capacity, or mint-authority checks.",
    scannedCount: admitted,
  });
}

runDirectCli(
  import.meta.url,
  async () => {
    process.exitCode = await runNewAssetEvidencePacketCheck(process.argv.slice(2));
  },
  { label: "new-asset-evidence-packet", usage: USAGE },
);

#!/usr/bin/env node

/**
 * New-asset evidence packet gate (PLAN §4.8 DUR-6, §10.5 U1/U2).
 *
 * Listing a stablecoin, or promoting a pre-launch row to active, now needs a
 * committed admission receipt. The receipt is the replay's
 * `countV9OpenEvidence` projection for the asset — the `byCard` row plus the
 * question keys with their bucket, obligation count and a per-datum
 * documentation flag. This check never re-derives the counting model:
 * `open-questions.ts` owns the keys and buckets, this file only admits the
 * receipt, binds it to the PR's registry and enforces the two gate conditions.
 *
 * Gate contract:
 *  - ≤ `NEW_ASSET_OPEN_QUESTION_LIMIT` open questions rooted at the asset;
 *  - zero non-documentation `missing-mint-authority` datums (U2);
 *  - the receipt's `registryFingerprint` must equal the fingerprint of the PR
 *    checkout's registry (a receipt replayed before the addition is stale);
 *  - the `new-asset-gate-override` owner label bypasses only the question
 *    count: never the receipt, its fingerprint binding, or the mint condition.
 *
 * Existing assets are out of scope. Candidates are coin files the PR *adds*
 * with an active lifecycle status, plus modified files whose status moves
 * pre-launch -> active (promotion). Pre-launch stubs publish no scored
 * questions, so they are not gated until promotion.
 *
 * Receipt shape (committed at `.github/artifacts/new-asset-evidence-packet/<assetId>.json`):
 * `{ schemaVersion: 1, kind, assetId, captureId, captureClockSec,
 *    registryFingerprint, card, questions }`; `NewAssetAdmissionReceiptSchema`
 * is the authority.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { compareCodeUnits } from "@shared/lib/compare";
import { isActiveStablecoinMeta, isPreLaunchStablecoinMeta } from "@shared/lib/stablecoins/status";
import type { StablecoinMeta } from "@shared/types";
import { V9ReasonCodeSchema } from "@shared/types/safety-score-v9";
import { V9OpenEvidenceByCardSchema, V9OpenQuestionBucketSchema } from "@shared/types/safety-score-v9-open-evidence";
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

const MISSING_MINT_AUTHORITY_CODE = "missing-mint-authority" as const;
const ASSET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const USAGE = `Usage: npm run check:new-asset-evidence-packet -- [options]

Gates the Safety Score admission receipt of every stablecoin this PR lists, and
of every pre-launch row it promotes to active. A receipt is the replay's
countV9OpenEvidence projection for the asset, committed under
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
    if (new Set(question.codes.map((code) => code.code)).size !== question.codes.length) {
      ctx.addIssue({ code: "custom", path: ["codes"], message: "question reason codes are unique" });
    }
  });

/**
 * U1 admission receipt. `card` is CNT-1's published by-card row, so the gate
 * reads the same counts the publication would; `questions` is the audit trail
 * behind those counts and the only place the documentation class of a
 * `missing-mint-authority` datum is recorded.
 */
export const NewAssetAdmissionReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal(NEW_ASSET_RECEIPT_KIND),
    assetId: z.string().min(1),
    captureId: z.string().min(1).max(120),
    captureClockSec: z.number().int().positive(),
    registryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    card: V9OpenEvidenceByCardSchema,
    questions: z.array(ReceiptQuestionSchema),
  })
  .superRefine((receipt, ctx) => {
    if (receipt.card.id !== receipt.assetId) {
      ctx.addIssue({ code: "custom", path: ["card", "id"], message: "card row must be the receipt's asset" });
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

export type NewAssetGateFailureKind =
  | "invalid-asset-id"
  | "missing-receipt"
  | "invalid-receipt"
  | "mismatched-receipt"
  | "stale-receipt"
  | "open-question-limit"
  | "missing-mint-authority";

export interface NewAssetGateFailure {
  assetId: string;
  origin: NewAssetGateOrigin;
  kind: NewAssetGateFailureKind;
  message: string;
}

export interface NewAssetGatePass {
  assetId: string;
  origin: NewAssetGateOrigin;
  captureId: string;
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
  override: boolean;
  /** Raw committed receipt JSON for the candidate, or null when none is committed. */
  readReceipt: (candidate: NewAssetGateCandidate) => string | null;
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
 * fingerprint and the committed receipts are inputs, so the CLI and the tests
 * share one decision path.
 */
export function evaluateNewAssetEvidencePacket({
  candidates,
  registryFingerprint,
  override,
  readReceipt,
}: EvaluateNewAssetEvidencePacketInput): NewAssetGateReport {
  const report: NewAssetGateReport = { candidates: [...candidates], passed: [], failures: [], warnings: [] };
  const fail = (candidate: NewAssetGateCandidate, kind: NewAssetGateFailureKind, message: string): void => {
    report.failures.push({ assetId: candidate.assetId, origin: candidate.origin, kind, message });
  };
  for (const candidate of candidates) {
    if (!ASSET_ID_PATTERN.test(candidate.assetId)) {
      fail(candidate, "invalid-asset-id", `asset id "${candidate.assetId}" cannot name a receipt file; fix the per-coin id`);
      continue;
    }
    const rawReceipt = readReceipt(candidate);
    if (rawReceipt === null) {
      fail(
        candidate,
        "missing-receipt",
        `no committed admission receipt at ${NEW_ASSET_RECEIPT_DIR}/${candidate.assetId}.json; replay the newest ` +
          "production capture against this branch and commit the countV9OpenEvidence projection",
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
    if (receipt.registryFingerprint !== registryFingerprint) {
      fail(
        candidate,
        "stale-receipt",
        `receipt replayed registry ${receipt.registryFingerprint}, this checkout is ${registryFingerprint}; ` +
          "re-run the replay on this branch so the addition is inside the receipt",
      );
      continue;
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

    let failed = false;
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
      captureId: receipt.captureId,
      openQuestions: ownOpen.length,
      inheritedOpenQuestions: inheritedOpen,
      overridden: ownOpen.length > NEW_ASSET_OPEN_QUESTION_LIMIT,
    });
  }
  return report;
}

/**
 * The PR checkout's registry fingerprint, recomputed from the loaded registry —
 * the same authority the replay snapshot uses. Loaded lazily so importing this
 * module (tests, helper reuse) never materializes the full catalog.
 */
export async function computeNewAssetRegistryFingerprint(): Promise<string> {
  const [{ ACTIVE_STABLECOINS, FROZEN_STABLECOINS }, { DEAD_STABLECOINS }] = await Promise.all([
    import("@shared/lib/stablecoins/registry"),
    import("@shared/lib/dead-stablecoins"),
  ]);
  return fingerprintReportCardRegistryRows({
    activeStablecoins: ACTIVE_STABLECOINS,
    frozenStablecoins: FROZEN_STABLECOINS,
    deadStablecoins: DEAD_STABLECOINS,
  });
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
  override: boolean;
  receiptDir: string;
  report: NewAssetGateReport;
  skipped: SkippedCoinPath[];
}

export async function inspectNewAssetEvidencePacket(
  { base, head, receiptDir, override, cwd }: {
    base: string;
    head: string;
    receiptDir: string;
    override: boolean;
    cwd: string;
  },
): Promise<NewAssetEvidencePacketCheckResult> {
  const mergeBase = resolveMergeBase(base, head, cwd);
  const changed = (diffFilter: string): string[] =>
    collectGitPaths({ kind: "range", base: mergeBase, head, diffFilter }, { cwd }).filter(isPerCoinAssetPath);
  const { candidates, skipped } = classifyNewAssetGateCandidates({
    addedPaths: changed("A"),
    modifiedPaths: changed("M"),
    readHeadCoin: (path) => readWorktreeCoin(path, cwd),
    readBaseCoin: (path) => readGitCoin(mergeBase, path, cwd),
  });
  const registryFingerprint = candidates.length === 0 ? "" : await computeNewAssetRegistryFingerprint();
  const report = evaluateNewAssetEvidencePacket({
    candidates,
    registryFingerprint,
    override,
    readReceipt: (candidate) => readCommittedReceipt(candidate.assetId, receiptDir, cwd),
  });
  return { base, head, mergeBase, registryFingerprint, override, receiptDir, report, skipped };
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
  const admitted = report.candidates.length - new Set(report.failures.map((failure) => `${failure.assetId}\u0000${failure.origin}`)).size;

  if (values.json === true) {
    writeJsonReport(result);
    return report.failures.length > 0 ? 1 : 0;
  }
  for (const entry of result.skipped) {
    process.stdout.write(`skip ${entry.path}: ${entry.reason}\n`);
  }
  if (report.candidates.length === 0) {
    process.stdout.write(`New-asset evidence packet: no added or promoted stablecoins in ${result.mergeBase}...${head}.\n`);
    return 0;
  }
  for (const pass of report.passed) {
    process.stdout.write(
      `ok ${pass.assetId} (${pass.origin}): ${pass.openQuestions} open question(s)` +
        `${pass.inheritedOpenQuestions > 0 ? `, ${pass.inheritedOpenQuestions} inherited` : ""}` +
        `${pass.overridden ? ` [${NEW_ASSET_GATE_OVERRIDE_LABEL}]` : ""} · capture ${pass.captureId}\n`,
    );
  }
  for (const warning of report.warnings) process.stdout.write(`warning: ${warning}\n`);
  return reportViolations({
    label: "new-asset evidence packet",
    heading: "New-asset evidence packet gate failed",
    violations: report.failures.map((failure) => `${failure.assetId} (${failure.origin}, ${failure.kind}): ${failure.message}`),
    hint:
      `A receipt is the replay's countV9OpenEvidence projection for the asset; it must be replayed on this branch ` +
      `(registry fingerprint ${result.registryFingerprint || "not computed"}). The ${NEW_ASSET_GATE_OVERRIDE_LABEL} label ` +
      "bypasses only the open-question count, never the receipt or the mint-authority condition.",
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

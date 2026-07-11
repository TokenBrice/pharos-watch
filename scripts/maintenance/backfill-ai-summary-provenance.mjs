#!/usr/bin/env node
/**
 * One-shot idempotent backfill: writes operator-confirmed AI-disclosure
 * provenance onto every entry of `data/ai-summaries.json` that does not
 * already carry `authoredBy`. Existing entries that already declare an
 * `authoredBy` are left untouched, so the script is safe to re-run after
 * the `write-ai-summaries` skill starts emitting curated values.
 *
 * Values applied per entry (only when missing):
 *   authoredBy = "ai"
 *   model      = --model, AI_SUMMARY_MODEL, MODEL_OVERRIDE, or the legacy default
 *   reviewedBy = AI_SUMMARY_REVIEWED_BY
 *   reviewedAt = AI_SUMMARY_REVIEWED_AT
 *   factsAsOf  = entry.updatedAt
 *
 * Run via:
 *   AI_SUMMARY_REVIEWED_BY="@TokenBrice" AI_SUMMARY_REVIEWED_AT="2026-05-15" npm run backfill:ai-summary-provenance -- --model claude-opus-4-7
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertCliUsage,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = process.cwd();
const SUMMARIES_PATH = resolve(ROOT, "data/ai-summaries.json");
const USAGE = `Usage: npm run backfill:ai-summary-provenance -- [options]

Options:
  --model <name>  Model identifier (overrides AI_SUMMARY_MODEL)
  --dry-run       Validate and report changes without writing the file
  -h, --help      Show this help

Required environment:
  AI_SUMMARY_REVIEWED_BY
  AI_SUMMARY_REVIEWED_AT (YYYY-MM-DD)`;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** @param {readonly string[]} argv @param {Record<string, string | undefined>} [env] */
export function parseAiSummaryBackfillArgs(argv, env = process.env) {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      "dry-run": { type: "boolean" },
      model: { type: "string" },
    },
  });
  const help = values.help === true;
  const reviewedBy = env.AI_SUMMARY_REVIEWED_BY?.trim() ?? "";
  const reviewedAt = env.AI_SUMMARY_REVIEWED_AT?.trim() ?? "";
  const model = typeof values.model === "string"
    ? values.model.trim()
    : env.AI_SUMMARY_MODEL?.trim() || env.MODEL_OVERRIDE?.trim() || "claude-opus-4-7";
  if (!help) {
    assertCliUsage(Boolean(reviewedBy), "AI_SUMMARY_REVIEWED_BY is required");
    assertCliUsage(isIsoDate(reviewedAt), "AI_SUMMARY_REVIEWED_AT must be a real YYYY-MM-DD date");
    assertCliUsage(Boolean(model), "--model must be non-empty");
  }
  return {
    dryRun: values["dry-run"] === true,
    help,
    model,
    reviewedAt,
    reviewedBy,
  };
}

export function backfillAiSummaryProvenance(data, defaults, { onInvalidEntry } = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("AI summaries did not parse to an object root");
  }

  let updated = 0;
  let skipped = 0;
  for (const id of Object.keys(data)) {
    const entry = data[id];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      onInvalidEntry?.(id);
      skipped += 1;
      continue;
    }
    if (typeof entry.authoredBy === "string") {
      skipped += 1;
      continue;
    }
    const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : "";
    data[id] = {
      title: entry.title,
      text: entry.text,
      updatedAt: entry.updatedAt,
      authoredBy: "ai",
      model: defaults.model,
      reviewedBy: defaults.reviewedBy,
      reviewedAt: defaults.reviewedAt,
      factsAsOf: updatedAt,
    };
    updated += 1;
  }
  return { data, skipped, updated };
}

export function runAiSummaryProvenanceBackfill({
  argv = process.argv.slice(2),
  env = process.env,
  summariesPath = SUMMARIES_PATH,
} = {}) {
  const options = parseAiSummaryBackfillArgs(argv, env);
  if (writeCliHelpIfRequested(options, USAGE)) return;

  const data = JSON.parse(readFileSync(summariesPath, "utf8"));
  const result = backfillAiSummaryProvenance(data, options, {
    onInvalidEntry: (id) => process.stderr.write(`backfill: entry ${id} is not an object, skipping\n`),
  });
  if (!options.dryRun) {
    writeFileSync(summariesPath, `${JSON.stringify(result.data, null, 2)}\n`, "utf8");
  }

  process.stdout.write(
    `backfill-ai-summary-provenance: ${options.dryRun ? "would update" : "updated"} ${result.updated}, ${result.skipped} skipped\n`,
  );
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runAiSummaryProvenanceBackfill(), {
    label: "backfill-ai-summary-provenance",
    usage: USAGE,
  });
}

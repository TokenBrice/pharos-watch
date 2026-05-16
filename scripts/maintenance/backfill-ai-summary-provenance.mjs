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
 *   model      = "claude-opus-4-7"
 *   reviewedBy = AI_SUMMARY_REVIEWED_BY
 *   reviewedAt = AI_SUMMARY_REVIEWED_AT
 *   factsAsOf  = entry.updatedAt
 *
 * Run via:
 *   AI_SUMMARY_REVIEWED_BY="@TokenBrice" AI_SUMMARY_REVIEWED_AT="2026-05-15" npm run backfill:ai-summary-provenance
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const SUMMARIES_PATH = resolve(ROOT, "data/ai-summaries.json");

const reviewedBy = process.env.AI_SUMMARY_REVIEWED_BY?.trim();
const reviewedAt = process.env.AI_SUMMARY_REVIEWED_AT?.trim();
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

if (!reviewedBy || !reviewedAt || !ISO_DATE_RE.test(reviewedAt)) {
  process.stderr.write(
    [
      "backfill: AI_SUMMARY_REVIEWED_BY and ISO-date AI_SUMMARY_REVIEWED_AT are required.",
      "This script records human-review provenance; do not infer reviewedAt from updatedAt.",
      'Example: AI_SUMMARY_REVIEWED_BY="@TokenBrice" AI_SUMMARY_REVIEWED_AT="2026-05-15" npm run backfill:ai-summary-provenance',
    ].join("\n") + "\n",
  );
  process.exit(1);
}

const DEFAULTS = {
  authoredBy: "ai",
  model: "claude-opus-4-7",
  reviewedBy,
  reviewedAt,
};

const raw = readFileSync(SUMMARIES_PATH, "utf8");
const data = JSON.parse(raw);

if (!data || typeof data !== "object" || Array.isArray(data)) {
  process.stderr.write(`backfill: ${SUMMARIES_PATH} did not parse to an object root\n`);
  process.exit(1);
}

let updated = 0;
let skipped = 0;

for (const id of Object.keys(data)) {
  const entry = data[id];
  if (!entry || typeof entry !== "object") {
    process.stderr.write(`backfill: entry ${id} is not an object, skipping\n`);
    skipped += 1;
    continue;
  }
  if (typeof entry.authoredBy === "string") {
    skipped += 1;
    continue;
  }
  const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : "";
  // Rebuild the entry preserving original key order for the legacy fields
  // (title, text, updatedAt) and then appending the provenance block.
  const next = {
    title: entry.title,
    text: entry.text,
    updatedAt: entry.updatedAt,
    authoredBy: DEFAULTS.authoredBy,
    model: DEFAULTS.model,
    reviewedBy: DEFAULTS.reviewedBy,
    reviewedAt: DEFAULTS.reviewedAt,
    factsAsOf: updatedAt,
  };
  data[id] = next;
  updated += 1;
}

// Preserve the existing JSON style: 2-space indent + trailing newline.
const serialized = `${JSON.stringify(data, null, 2)}\n`;
writeFileSync(SUMMARIES_PATH, serialized, "utf8");

process.stdout.write(
  `backfill-ai-summary-provenance: ${updated} updated, ${skipped} skipped\n`,
);

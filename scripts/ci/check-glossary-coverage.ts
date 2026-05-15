#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GLOSSARY } from "../../src/lib/glossary";

const ROOT = process.cwd();
const SUMMARIES_PATH = "data/ai-summaries.json";
const TERM_MARKER_RE = /\{\{term:([a-z0-9-]+)\}\}/g;

interface SummaryRecord {
  text?: unknown;
}

function readSummaries(): Record<string, SummaryRecord> {
  const path = resolve(ROOT, SUMMARIES_PATH);
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${SUMMARIES_PATH}: expected a JSON object at the root`);
  }
  return parsed as Record<string, SummaryRecord>;
}

const summaries = readSummaries();
const knownSlugs = new Set(Object.keys(GLOSSARY));

let totalMarkers = 0;
const uniqueSlugs = new Set<string>();
const missingBySummary = new Map<string, Set<string>>();

for (const [summaryId, entry] of Object.entries(summaries)) {
  const text = typeof entry?.text === "string" ? entry.text : "";
  if (!text) continue;

  for (const match of text.matchAll(TERM_MARKER_RE)) {
    totalMarkers += 1;
    const slug = match[1];
    uniqueSlugs.add(slug);
    if (!knownSlugs.has(slug)) {
      let bucket = missingBySummary.get(summaryId);
      if (!bucket) {
        bucket = new Set<string>();
        missingBySummary.set(summaryId, bucket);
      }
      bucket.add(slug);
    }
  }
}

if (missingBySummary.size > 0) {
  process.stderr.write("Glossary coverage check failed — unknown {{term:slug}} markers:\n");
  for (const [summaryId, slugs] of missingBySummary) {
    process.stderr.write(`  ${summaryId}: ${Array.from(slugs).sort().join(", ")}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `Glossary coverage: ${totalMarkers} markers across ${uniqueSlugs.size} unique slug(s) OK\n`,
);

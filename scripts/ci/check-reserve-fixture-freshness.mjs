#!/usr/bin/env node
/**
 * Checks that every reserve adapter fixture carries a
 * <!-- captured-at: YYYY-MM-DDTHH:MM:SSZ --> header and is no older than
 * MAX_AGE_DAYS days from today.
 */

import { readFileSync, readdirSync } from "fs";
import path from "path";

const MAX_AGE_DAYS = 90;
const FIXTURES_DIR = new URL(
  "../worker/src/cron/reserve-adapters/__tests__/fixtures",
  import.meta.url,
).pathname;

// Matches: <!-- captured-at: 2026-04-16T21:31:55Z -->
const CAPTURED_AT_RE = /<!--\s*captured-at:\s*(\d{4}-\d{2}-\d{2}T[\d:]+Z)\s*-->/;

const files = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".html"))
  .sort();

const today = new Date();
const missing = [];
const stale = [];
const ok = [];

for (const file of files) {
  const fullPath = path.join(FIXTURES_DIR, file);
  const content = readFileSync(fullPath, "utf8");
  const match = content.match(CAPTURED_AT_RE);

  if (!match) {
    missing.push(file);
    continue;
  }

  const capturedAt = new Date(match[1]);
  const ageMs = today - capturedAt;
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

  if (ageDays > MAX_AGE_DAYS) {
    stale.push({ file, ageDays, capturedAt: match[1] });
  } else {
    ok.push({ file, ageDays });
  }
}

let failed = false;

if (missing.length > 0) {
  console.error(`\nMissing captured-at header (${missing.length} fixture(s)):`);
  for (const f of missing) {
    console.error(`  - ${f}`);
  }
  failed = true;
}

if (stale.length > 0) {
  console.error(`\nStale fixtures older than ${MAX_AGE_DAYS} days (${stale.length} fixture(s)):`);
  for (const { file, ageDays, capturedAt } of stale) {
    console.error(`  - ${file}  (captured: ${capturedAt}, age: ${ageDays} days)`);
  }
  failed = true;
}

if (ok.length > 0) {
  console.log(`\nFresh fixtures (${ok.length}):`);
  for (const { file, ageDays } of ok) {
    console.log(`  v ${file}  (${ageDays} days old)`);
  }
}

if (failed) {
  console.error(
    `\ncheck:reserve-fixture-freshness FAILED — refresh stale/missing fixtures before merging.`,
  );
  process.exit(1);
} else {
  console.log(`\nAll ${ok.length} fixture(s) are fresh (<=${MAX_AGE_DAYS} days). OK.`);
  process.exit(0);
}

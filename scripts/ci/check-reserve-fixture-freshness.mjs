#!/usr/bin/env node
/**
 * Checks that every reserve adapter fixture carries a
 * <!-- captured-at: YYYY-MM-DDTHH:MM:SSZ --> header and is no older than
 * MAX_AGE_DAYS days from today.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

export const MAX_AGE_DAYS = 90;
export const FIXTURES_DIR = new URL(
  "../../worker/src/cron/reserve-adapters/__tests__/fixtures",
  import.meta.url,
).pathname;

// Matches: <!-- captured-at: 2026-04-16T21:31:55Z -->
export const CAPTURED_AT_RE = /<!--\s*captured-at:\s*(\d{4}-\d{2}-\d{2}T[\d:]+Z)\s*-->/;

export function parseCapturedAtHeader(content) {
  const match = content.match(CAPTURED_AT_RE);
  if (!match) return null;

  const capturedAt = new Date(match[1]);
  if (Number.isNaN(capturedAt.getTime())) return null;

  return {
    iso: match[1],
    date: capturedAt,
  };
}

export function evaluateReserveFixtureFreshness({
  fixturesDir = FIXTURES_DIR,
  now = new Date(),
  maxAgeDays = MAX_AGE_DAYS,
} = {}) {
  const files = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".html"))
    .sort();

  const missing = [];
  const stale = [];
  const ok = [];

  for (const file of files) {
    const fullPath = path.join(fixturesDir, file);
    const content = readFileSync(fullPath, "utf8");
    const parsed = parseCapturedAtHeader(content);

    if (!parsed) {
      missing.push(file);
      continue;
    }

    const ageMs = now - parsed.date;
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

    if (ageDays > maxAgeDays) {
      stale.push({ file, ageDays, capturedAt: parsed.iso });
    } else {
      ok.push({ file, ageDays });
    }
  }

  return { files, missing, stale, ok };
}

export function renderReserveFixtureFreshnessResult(result, maxAgeDays = MAX_AGE_DAYS) {
  const lines = [];

  if (result.missing.length > 0) {
    lines.push(`\nMissing captured-at header (${result.missing.length} fixture(s)):`);
    for (const f of result.missing) {
      lines.push(`  - ${f}`);
    }
  }

  if (result.stale.length > 0) {
    lines.push(`\nStale fixtures older than ${maxAgeDays} days (${result.stale.length} fixture(s)):`);
    for (const { file, ageDays, capturedAt } of result.stale) {
      lines.push(`  - ${file}  (captured: ${capturedAt}, age: ${ageDays} days)`);
    }
  }

  if (result.ok.length > 0) {
    lines.push(`\nFresh fixtures (${result.ok.length}):`);
    for (const { file, ageDays } of result.ok) {
      lines.push(`  v ${file}  (${ageDays} days old)`);
    }
  }

  const failed = result.missing.length > 0 || result.stale.length > 0;
  if (failed) {
    lines.push(`\ncheck:reserve-fixture-freshness FAILED — refresh stale/missing fixtures before merging.`);
  } else {
    lines.push(`\nAll ${result.ok.length} fixture(s) are fresh (<=${maxAgeDays} days). OK.`);
  }

  return `${lines.join("\n")}\n`;
}

export function runCli() {
  const result = evaluateReserveFixtureFreshness();
  const failed = result.missing.length > 0 || result.stale.length > 0;
  const output = renderReserveFixtureFreshnessResult(result);
  if (failed) {
    console.error(output.trimEnd());
    return 1;
  }

  console.log(output.trimEnd());
  return 0;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  process.exit(runCli());
}

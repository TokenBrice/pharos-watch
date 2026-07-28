#!/usr/bin/env node
/**
 * Tripwire for stale feature flags.
 *
 * Each entry in `src/lib/feature-flags.ts` carries an `// expiresAt: YYYY-MM-DD`
 * comment immediately above the flag-key assignment. This script:
 *   - Fails (exit 1) when any flag's `expiresAt` is today or earlier.
 *   - Warns to stderr (exit 0) when a flag expires within the next 30 days.
 *   - Reports healthy state to stdout (exit 0) otherwise.
 *
 * Retirement guidance lives in `docs/process/feature-flags.md`.
 *
 * Run directly when reviewing feature-flag lifecycle changes.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FLAGS_PATH = "src/lib/feature-flags.ts";
const WARN_WINDOW_DAYS = 30;
const RETIREMENT_DOC = "docs/process/feature-flags.md";

// Match an `// expiresAt: YYYY-MM-DD [— reason]` comment on a single line.
// Linear, no backtracking — avoids `security/detect-unsafe-regex`.
const COMMENT_LINE_RE = /^\s*\/\/\s*expiresAt:\s*(\d{4}-\d{2}-\d{2})(.*)$/;
// Match an `identifier:` flag-key on the following code line.
const FLAG_KEY_LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/;

function parseFlags(source) {
  const lines = source.split(/\r?\n/);
  const flags = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const commentMatch = COMMENT_LINE_RE.exec(lines[i]);
    if (!commentMatch) continue;
    const keyMatch = FLAG_KEY_LINE_RE.exec(lines[i + 1]);
    if (!keyMatch) continue;
    const [, expiresAt, rest] = commentMatch;
    const [, flag] = keyMatch;
    const reason = rest.replace(/^\s*[—-]\s*/, "").trim();
    flags.push({ flag, expiresAt, reason });
  }
  return flags;
}

function daysBetween(fromDate, toDate) {
  const ms = toDate.getTime() - fromDate.getTime();
  return Math.floor(ms / 86_400_000);
}

const sourcePath = resolve(process.cwd(), FLAGS_PATH);
let source;
try {
  source = readFileSync(sourcePath, "utf8");
} catch (err) {
  process.stderr.write(
    `check-stale-flags: could not read ${FLAGS_PATH}: ${err.message}\n`,
  );
  process.exit(1);
}

const flags = parseFlags(source);
if (flags.length === 0) {
  process.stderr.write(
    `check-stale-flags: found no \`// expiresAt: YYYY-MM-DD\` comments in ${FLAGS_PATH}. ` +
      `Either the file moved or the comment convention changed; see ${RETIREMENT_DOC}.\n`,
  );
  process.exit(1);
}

const today = new Date();
today.setUTCHours(0, 0, 0, 0);

const expired = [];
const approaching = [];

for (const entry of flags) {
  const expiresAt = new Date(`${entry.expiresAt}T00:00:00Z`);
  if (Number.isNaN(expiresAt.getTime())) {
    process.stderr.write(
      `check-stale-flags: invalid date for flag \`${entry.flag}\`: ${entry.expiresAt}\n`,
    );
    process.exit(1);
  }
  const daysUntil = daysBetween(today, expiresAt);
  if (daysUntil <= 0) {
    expired.push({ ...entry, daysUntil });
  } else if (daysUntil <= WARN_WINDOW_DAYS) {
    approaching.push({ ...entry, daysUntil });
  }
}

if (expired.length > 0) {
  process.stderr.write(
    `check-stale-flags: ${expired.length} feature flag(s) past their expiresAt date.\n`,
  );
  for (const entry of expired) {
    const suffix = entry.reason ? ` — ${entry.reason}` : "";
    process.stderr.write(
      `  ${entry.flag} expired ${entry.expiresAt}${suffix}\n`,
    );
  }
  process.stderr.write(
    `\nRetire (flip on + remove off-path) or extend the expiresAt with a documented rationale. ` +
      `See ${RETIREMENT_DOC}.\n`,
  );
  process.exit(1);
}

for (const entry of approaching) {
  const suffix = entry.reason ? ` — ${entry.reason}` : "";
  process.stderr.write(
    `WARN: ${entry.flag} expires in ${entry.daysUntil} day(s) on ${entry.expiresAt}${suffix}\n`,
  );
}

const oldest = flags
  .map((entry) => ({
    ...entry,
    daysUntil: daysBetween(today, new Date(`${entry.expiresAt}T00:00:00Z`)),
  }))
  .sort((a, b) => a.daysUntil - b.daysUntil)[0];

process.stdout.write(
  `check-stale-flags: all ${flags.length} flags healthy ` +
    `(${approaching.length} warning, 0 expired); oldest \`${oldest.flag}\` expires in ${oldest.daysUntil} day(s) on ${oldest.expiresAt}.\n`,
);
process.exit(0);

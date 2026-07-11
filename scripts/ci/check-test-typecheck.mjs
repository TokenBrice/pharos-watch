#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASELINE_PATH = resolve("scripts/lib/test-typecheck-baseline.json");
const UPDATE_BASELINE = process.argv.includes("--update-baseline");
const TSC_COMMAND = [
  "tsc",
  "--noEmit",
  "-p",
  "tsconfig.test-typecheck.json",
  "--pretty",
  "false",
];

function parseDiagnostics(output, cwd = process.cwd()) {
  const diagnosticsByKey = new Map();
  const unparsedErrors = [];
  const diagnosticPattern = /^(.+\.(?:ts|tsx))\((\d+),(\d+)\): error TS(\d+): (.+)$/;
  const errorPattern = /(^|\s)error TS\d+:/;
  for (const line of output.split("\n")) {
    const match = diagnosticPattern.exec(line);
    if (!match) {
      if (errorPattern.test(line)) unparsedErrors.push(line);
      continue;
    }
    const [, file, lineNumber, columnNumber, code, message] = match;
    const normalizedMessage = normalizeDiagnosticMessage(message, cwd);
    const key = `${file}\0${code}\0${normalizedMessage}`;
    const entry = diagnosticsByKey.get(key) ?? {
      file,
      code: `TS${code}`,
      message: normalizedMessage,
      count: 0,
      examples: [],
    };
    entry.count += 1;
    if (entry.examples.length < 3) {
      entry.examples.push(`${lineNumber}:${columnNumber}`);
    }
    diagnosticsByKey.set(key, entry);
  }
  return {
    diagnostics: [...diagnosticsByKey.values()].sort((a, b) =>
      a.file.localeCompare(b.file) ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
    ),
    unparsedErrors,
  };
}

function failTscExecution(message, output) {
  console.error(`[typecheck:tests] ${message}`);
  const trimmedOutput = output.trim();
  if (trimmedOutput) {
    console.error("[typecheck:tests] Raw tsc output:");
    console.error(trimmedOutput);
  }
  process.exit(1);
}

function baselineKey(entry) {
  return `${entry.file}\0${entry.code}\0${normalizeDiagnosticMessage(entry.message)}`;
}

function normalizeDiagnosticMessage(message, cwd = process.cwd()) {
  const repoRoot = resolve(cwd).replace(/[\\/]+$/, "");
  const repoRootForwardSlashes = repoRoot.replaceAll("\\", "/");
  return String(message)
    .replaceAll(repoRoot, "<repo>")
    .replaceAll(repoRootForwardSlashes, "<repo>")
    .replace(/\s+/g, " ")
    .trim();
}

function readBaseline() {
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    return Array.isArray(parsed.diagnostics) ? parsed.diagnostics : [];
  } catch (error) {
    if (UPDATE_BASELINE) return [];
    throw error;
  }
}

function formatDiagnostic(entry) {
  const locations = entry.examples?.length ? ` (${entry.examples.join(", ")})` : "";
  return `${entry.file}${locations}: ${entry.code}: ${entry.message} [count=${entry.count}]`;
}

function aggregateDiagnostics(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const key = baselineKey(entry);
    const aggregate = byKey.get(key) ?? {
      file: entry.file,
      code: entry.code,
      message: entry.message,
      count: 0,
      examples: [],
    };
    aggregate.count += entry.count;
    aggregate.examples.push(...(entry.examples ?? []).slice(0, Math.max(0, 3 - aggregate.examples.length)));
    byKey.set(key, aggregate);
  }
  return byKey;
}

const tsc = spawnSync("npx", TSC_COMMAND, {
  cwd: process.cwd(),
  encoding: "utf8",
  shell: process.platform === "win32",
});
const output = `${tsc.stdout ?? ""}${tsc.stderr ?? ""}`;
const { diagnostics, unparsedErrors } = parseDiagnostics(output, process.cwd());

if (tsc.error) {
  failTscExecution(`Failed to start ${TSC_COMMAND[0]}: ${tsc.error.message}`, output);
}
if (tsc.signal) {
  failTscExecution(`${TSC_COMMAND[0]} exited after signal ${tsc.signal}.`, output);
}
if (tsc.status !== 0 && unparsedErrors.length > 0) {
  failTscExecution(
    `${TSC_COMMAND[0]} failed with ${unparsedErrors.length} unparsed TypeScript diagnostic line(s); refusing to treat the test typecheck as a clean ratchet run.`,
    output,
  );
}
if (tsc.status !== 0 && diagnostics.length === 0) {
  failTscExecution(
    `${TSC_COMMAND[0]} failed without parseable test-file diagnostics; refusing to treat the test typecheck as a clean ratchet run.`,
    output,
  );
}

if (UPDATE_BASELINE) {
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify({
      generatedBy: "npm run typecheck:tests:update-baseline",
      command: `npx ${TSC_COMMAND.join(" ")}`,
      diagnostics,
    }, null, 2)}\n`,
  );
  console.log(`[typecheck:tests] Wrote ${diagnostics.length} diagnostic baseline entries to ${BASELINE_PATH}.`);
  process.exit(0);
}

const baseline = readBaseline();
const baselineByKey = aggregateDiagnostics(baseline);
const failures = [];
const resolved = [];

const currentByKey = aggregateDiagnostics(diagnostics);
for (const entry of currentByKey.values()) {
  const previous = baselineByKey.get(baselineKey(entry));
  if (!previous) {
    failures.push(`new ${formatDiagnostic(entry)}`);
  } else if (entry.count > previous.count) {
    failures.push(`increased ${formatDiagnostic(entry)}; baseline count=${previous.count}`);
  }
}

for (const entry of baselineByKey.values()) {
  const current = currentByKey.get(baselineKey(entry));
  if (!current || current.count < entry.count) {
    resolved.push(formatDiagnostic({
      ...entry,
      count: entry.count - (current?.count ?? 0),
      examples: current?.examples ?? entry.examples,
    }));
  }
}

if (failures.length > 0) {
  console.error(`[typecheck:tests] Test typecheck introduced ${failures.length} new/increased diagnostic group(s).`);
  for (const failure of failures.slice(0, 50)) console.error(`- ${failure}`);
  if (failures.length > 50) console.error(`... ${failures.length - 50} more`);
  console.error("[typecheck:tests] Fix the new diagnostics, or update the baseline only when intentionally accepting debt.");
  process.exit(1);
}

console.log(
  `[typecheck:tests] No new test type diagnostics. Current debt: ${diagnostics.length} group(s), ${
    diagnostics.reduce((sum, entry) => sum + entry.count, 0)
  } total diagnostic(s).`,
);
if (resolved.length > 0) {
  console.log(`[typecheck:tests] ${resolved.length} baseline group(s) improved; run npm run typecheck:tests:update-baseline to shrink the baseline.`);
}

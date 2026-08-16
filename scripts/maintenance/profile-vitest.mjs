#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { localBin } from "../lib/local-bin.mts";

const DEFAULT_OUTPUT = resolve(tmpdir(), "pharos-vitest-profile.json");
const DEFAULT_TOP_LIMIT = 20;
const DEFAULT_FILE_THRESHOLD_MS = 10_000;
const DEFAULT_TEST_THRESHOLD_MS = 1_000;

function printUsage() {
  console.log(`Usage: npm run test:profile -- [profile options] -- [vitest args]

Profile options:
  --output <path>             Write profile summary JSON (default: ${DEFAULT_OUTPUT})
  --raw-output <path>         Write raw Vitest JSON report (default: <output>.vitest.json)
  --baseline <path>           Compare counts/timings with a prior profile or Vitest JSON report
  --top <count>               Number of top files/tests to print (default: ${DEFAULT_TOP_LIMIT})
  --file-threshold-ms <ms>    Slow file threshold (default: ${DEFAULT_FILE_THRESHOLD_MS})
  --test-threshold-ms <ms>    Slow individual test threshold (default: ${DEFAULT_TEST_THRESHOLD_MS})

Examples:
  npm run test:profile -- --output /tmp/pharos-vitest-profile.json
  npm run test:profile -- --output /tmp/pharos-vitest-threads.json -- --pool=threads
  npm run test:profile -- --output /tmp/pharos-src-profile.json -- --dir src
`);
}

function readValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative number`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    output: DEFAULT_OUTPUT,
    rawOutput: null,
    baseline: null,
    topLimit: DEFAULT_TOP_LIMIT,
    fileThresholdMs: DEFAULT_FILE_THRESHOLD_MS,
    testThresholdMs: DEFAULT_TEST_THRESHOLD_MS,
  };
  const vitestArgs = [];
  let passThrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (passThrough) {
      vitestArgs.push(arg);
      continue;
    }

    if (arg === "--") {
      passThrough = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--output") {
      options.output = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
      continue;
    }

    if (arg === "--raw-output") {
      options.rawOutput = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--raw-output=")) {
      options.rawOutput = arg.slice("--raw-output=".length);
      continue;
    }

    if (arg === "--baseline") {
      options.baseline = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--baseline=")) {
      options.baseline = arg.slice("--baseline=".length);
      continue;
    }

    if (arg === "--top") {
      options.topLimit = parseNumber(readValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--top=")) {
      options.topLimit = parseNumber(arg.slice("--top=".length), "--top");
      continue;
    }

    if (arg === "--file-threshold-ms") {
      options.fileThresholdMs = parseNumber(readValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--file-threshold-ms=")) {
      options.fileThresholdMs = parseNumber(arg.slice("--file-threshold-ms=".length), "--file-threshold-ms");
      continue;
    }

    if (arg === "--test-threshold-ms") {
      options.testThresholdMs = parseNumber(readValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--test-threshold-ms=")) {
      options.testThresholdMs = parseNumber(arg.slice("--test-threshold-ms=".length), "--test-threshold-ms");
      continue;
    }

    vitestArgs.push(arg);
  }

  options.output = resolvePath(options.output);
  options.rawOutput = resolvePath(options.rawOutput ?? deriveRawOutput(options.output));
  options.baseline = options.baseline ? resolvePath(options.baseline) : null;
  return { options, vitestArgs };
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function deriveRawOutput(output) {
  const ext = extname(output);
  if (!ext) {
    return `${output}.vitest.json`;
  }
  return `${output.slice(0, -ext.length)}.vitest${ext}`;
}

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function buildVitestArgs(rawOutput, vitestArgs) {
  const [maybeCommand, ...rest] = vitestArgs;
  const command = maybeCommand === "run" ? maybeCommand : "run";
  const args = maybeCommand === "run" ? rest : vitestArgs;

  return [
    command,
    ...args,
    "--reporter=json",
    "--outputFile",
    rawOutput,
  ];
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function relativize(path) {
  return relative(process.cwd(), path).split("\\").join("/") || path;
}

function fileEnvironment(file) {
  try {
    const contents = readFileSync(file, "utf8");
    const match = contents.match(/@vitest-environment\s+([^\s]+)/);
    return match?.[1] ?? "node";
  } catch {
    return "unknown";
  }
}

function durationForFile(result) {
  const startTime = Number(result.startTime);
  const endTime = Number(result.endTime);
  if (Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime) {
    return endTime - startTime;
  }
  return (result.assertionResults ?? []).reduce((sum, test) => sum + (Number(test.duration) || 0), 0);
}

function summarizeReport(report, wallMs, thresholds, topLimit) {
  const fileRows = [];
  const testRows = [];
  const split = {};

  for (const result of report.testResults ?? []) {
    const absolutePath = result.name;
    const file = relativize(absolutePath);
    const tests = result.assertionResults ?? [];
    const fileDurationMs = durationForFile(result);
    const testDurationMs = tests.reduce((sum, test) => sum + (Number(test.duration) || 0), 0);
    const environment = fileEnvironment(absolutePath);

    split[environment] ??= {
      files: 0,
      tests: 0,
      summedFileMs: 0,
      summedTestMs: 0,
    };
    split[environment].files += 1;
    split[environment].tests += tests.length;
    split[environment].summedFileMs += fileDurationMs;
    split[environment].summedTestMs += testDurationMs;

    fileRows.push({
      file,
      environment,
      tests: tests.length,
      status: result.status,
      fileDurationMs,
      testDurationMs,
      unattributedMs: Math.max(0, fileDurationMs - testDurationMs),
    });

    for (const test of tests) {
      const durationMs = Number(test.duration) || 0;
      testRows.push({
        file,
        fullName: test.fullName,
        status: test.status,
        durationMs,
      });
    }
  }

  const sortedFiles = [...fileRows].sort((a, b) => b.fileDurationMs - a.fileDurationMs);
  const sortedTests = [...testRows].sort((a, b) => b.durationMs - a.durationMs);
  const slowFiles = sortedFiles.filter((file) => file.fileDurationMs > thresholds.fileThresholdMs);
  const slowTests = sortedTests.filter((test) => test.durationMs > thresholds.testThresholdMs);

  return {
    totals: {
      files: report.testResults?.length ?? 0,
      tests: report.numTotalTests ?? testRows.length,
      passedTests: report.numPassedTests ?? 0,
      failedTests: report.numFailedTests ?? 0,
      pendingTests: report.numPendingTests ?? 0,
      wallMs,
      summedFileMs: fileRows.reduce((sum, file) => sum + file.fileDurationMs, 0),
      summedTestMs: fileRows.reduce((sum, file) => sum + file.testDurationMs, 0),
      slowFiles: slowFiles.length,
      slowTests: slowTests.length,
      success: Boolean(report.success),
    },
    split,
    topFiles: sortedFiles.slice(0, topLimit),
    topTests: sortedTests.slice(0, topLimit),
    slowFiles,
    slowTests,
  };
}

function baselineSummary(path) {
  if (!path) {
    return null;
  }
  const data = loadJson(path);
  if (data.totals) {
    return {
      path,
      files: data.totals.files,
      tests: data.totals.tests,
      wallMs: data.totals.wallMs,
      summedFileMs: data.totals.summedFileMs,
      summedTestMs: data.totals.summedTestMs,
    };
  }
  if (data.testResults) {
    const summary = summarizeReport(data, null, {
      fileThresholdMs: Number.POSITIVE_INFINITY,
      testThresholdMs: Number.POSITIVE_INFINITY,
    }, 0);
    return {
      path,
      files: summary.totals.files,
      tests: summary.totals.tests,
      wallMs: estimateRawWallMs(data),
      summedFileMs: summary.totals.summedFileMs,
      summedTestMs: summary.totals.summedTestMs,
    };
  }
  throw new Error(`Unsupported baseline format: ${path}`);
}

function estimateRawWallMs(report) {
  const startTime = Number(report.startTime);
  const endTimes = (report.testResults ?? []).map((result) => Number(result.endTime)).filter(Number.isFinite);
  const endTime = Math.max(...endTimes);
  if (Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime) {
    return endTime - startTime;
  }
  return null;
}

function buildDeltas(current, baseline) {
  if (!baseline) {
    return null;
  }
  return {
    files: current.files - baseline.files,
    tests: current.tests - baseline.tests,
    wallMs: diffNullable(current.wallMs, baseline.wallMs),
    summedFileMs: diffNullable(current.summedFileMs, baseline.summedFileMs),
    summedTestMs: diffNullable(current.summedTestMs, baseline.summedTestMs),
  };
}

function diffNullable(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) {
    return null;
  }
  return current - baseline;
}

function formatMs(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2)}s`;
  }
  return `${value.toFixed(0)}ms`;
}

function formatDelta(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatMs(value)}`;
}

function printRows(rows, formatter) {
  if (rows.length === 0) {
    console.log("  none");
    return;
  }
  rows.forEach((row, index) => {
    console.log(`  ${index + 1}. ${formatter(row)}`);
  });
}

function printSummary(profile) {
  const { totals, split, topFiles, topTests, slowFiles, slowTests, baseline } = profile;

  console.log("\nVitest profile");
  console.log(`  raw report: ${profile.rawReportPath}`);
  console.log(`  summary:    ${profile.outputPath}`);
  console.log(`  files/tests: ${totals.files} files / ${totals.tests} tests`);
  console.log(`  wall: ${formatMs(totals.wallMs)}; summed file time: ${formatMs(totals.summedFileMs)}; summed test time: ${formatMs(totals.summedTestMs)}`);
  console.log(`  slow thresholds: files > ${formatMs(profile.thresholds.fileThresholdMs)}, tests > ${formatMs(profile.thresholds.testThresholdMs)}`);

  if (baseline?.deltas) {
    console.log(`  baseline: ${baseline.path}`);
    console.log(`  deltas: ${baseline.deltas.files >= 0 ? "+" : ""}${baseline.deltas.files} files, ${baseline.deltas.tests >= 0 ? "+" : ""}${baseline.deltas.tests} tests, wall ${formatDelta(baseline.deltas.wallMs)}, summed file ${formatDelta(baseline.deltas.summedFileMs)}`);
  }

  console.log("\nEnvironment split");
  for (const [environment, stats] of Object.entries(split).sort(([a], [b]) => a.localeCompare(b))) {
    const avg = stats.tests > 0 ? stats.summedFileMs / stats.tests : 0;
    console.log(`  ${environment}: ${stats.files} files / ${stats.tests} tests; summed file ${formatMs(stats.summedFileMs)}; avg ${formatMs(avg)}/test`);
  }

  console.log("\nFiles above threshold");
  printRows(slowFiles, (file) => `${formatMs(file.fileDurationMs)} ${file.file} (${file.tests} tests, ${file.environment})`);

  console.log("\nTests above threshold");
  printRows(slowTests, (test) => `${formatMs(test.durationMs)} ${test.file} - ${test.fullName}`);

  console.log("\nTop files");
  printRows(topFiles, (file) => `${formatMs(file.fileDurationMs)} ${file.file} (${file.tests} tests, ${file.environment}, gap ${formatMs(file.unattributedMs)})`);

  console.log("\nTop individual tests");
  printRows(topTests, (test) => `${formatMs(test.durationMs)} ${test.file} - ${test.fullName}`);
}

function main() {
  const { options, vitestArgs } = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  ensureParent(options.output);
  ensureParent(options.rawOutput);

  const commandArgs = buildVitestArgs(options.rawOutput, vitestArgs);
  const command = localBin("vitest");
  const start = performance.now();
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
  });
  const wallMs = performance.now() - start;

  if (result.error) {
    throw result.error;
  }

  if (!existsSync(options.rawOutput)) {
    process.exit(result.status ?? 1);
  }

  const report = loadJson(options.rawOutput);
  const thresholds = {
    fileThresholdMs: options.fileThresholdMs,
    testThresholdMs: options.testThresholdMs,
  };
  const summary = summarizeReport(report, wallMs, thresholds, options.topLimit);
  const baseline = baselineSummary(options.baseline);
  const profile = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    command: [command, ...commandArgs],
    outputPath: options.output,
    rawReportPath: options.rawOutput,
    baseline: baseline
      ? {
          ...baseline,
          deltas: buildDeltas(summary.totals, baseline),
        }
      : null,
    thresholds,
    ...summary,
  };

  writeFileSync(options.output, `${JSON.stringify(profile, null, 2)}\n`);
  printSummary(profile);

  process.exit(result.status ?? 1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

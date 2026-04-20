#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOTS = ["worker/src/handlers/scheduled", "worker/src/cron"];
const WAIVER_FILE = "scripts/lib/cron-abort-contract-waivers.json";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);

function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "__mocks__") continue;
      collectFiles(entryPath, files);
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

function readWaivers(cwd) {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, WAIVER_FILE), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isWaived(waivers, file, lineText) {
  return waivers.some((waiver) =>
    waiver &&
    waiver.file === file &&
    typeof waiver.lineIncludes === "string" &&
    lineText.includes(waiver.lineIncludes) &&
    typeof waiver.reason === "string" &&
    waiver.reason.length > 0
  );
}

export function scanCronAbortContract(roots = DEFAULT_ROOTS, cwd = process.cwd()) {
  const waivers = readWaivers(cwd);
  const violations = [];
  const scannedFiles = [];

  for (const root of roots) {
    const files = collectFiles(join(cwd, root));
    scannedFiles.push(...files);
    for (const file of files) {
      const rel = relative(cwd, file).replaceAll("\\", "/");
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        const trimmed = line.trim();
        const dropsSignal =
          /\brunLeasedCron\([^,\n]+,\s*\(\s*\)\s*=>/.test(trimmed) ||
          /\b_signal\b.*AbortSignal/.test(trimmed);
        if (!dropsSignal || isWaived(waivers, rel, trimmed)) continue;
        violations.push({ file: rel, line: index + 1, text: trimmed });
      }
    }
  }

  return { scannedFiles, violations };
}

export function main(cwd = process.cwd()) {
  const report = scanCronAbortContract(DEFAULT_ROOTS, cwd);
  if (report.violations.length > 0) {
    process.stderr.write("Cron abort contract violations:\n\n");
    for (const violation of report.violations) {
      process.stderr.write(`  ${violation.file}:${violation.line}: ${violation.text}\n`);
    }
    process.stderr.write("\nFix: accept and pass the cron AbortSignal, or add a documented waiver.\n");
    return 1;
  }

  process.stdout.write(
    `Cron abort contract: OK (${report.scannedFiles.length} file${report.scannedFiles.length === 1 ? "" : "s"} scanned)\n`,
  );
  return 0;
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  process.exitCode = main();
}

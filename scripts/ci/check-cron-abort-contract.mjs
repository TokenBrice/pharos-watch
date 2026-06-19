#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { collectSourceFilesUnderRoot } from "../lib/source-files.mjs";

const DEFAULT_ROOTS = ["worker/src/handlers/scheduled", "worker/src/cron"];
const WAIVER_FILE = "scripts/lib/cron-abort-contract-waivers.json";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const EXCLUDED_DIRS = new Set(["__tests__", "__mocks__"]);
const CRON_REACHABLE_LIB_ROOT = "worker/src/lib";
const LEASED_CRON_CALLEES = new Set(["runLeasedCron", "runBestEffortScheduledJobWithOutcome"]);
const SIGNAL_AWARE_CALLEES = new Set([
  "batchExecute",
  "fetchWithRetry",
  "runWithAbort",
  "runWithOverloadRetry",
  "setCacheIfNewer",
  "sleepWithSignal",
  "writeFreshnessSentinel",
]);

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

function normalizeRel(cwd, file) {
  return relative(cwd, file).replaceAll("\\", "/");
}

function isInsideRel(rel, root) {
  return rel === root || rel.startsWith(`${root}/`);
}

function resolveLocalImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    ...[...SOURCE_EXTENSIONS].map((extension) => `${base}${extension}`),
    ...[...SOURCE_EXTENSIONS].map((extension) => join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (!statSync(candidate).isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(extname(candidate))) continue;
    return candidate;
  }
  return null;
}

function parseSourceFile(file) {
  const source = readFileSync(file, "utf8");
  const scriptKind = extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return {
    source,
    sourceFile: ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind),
  };
}

function collectImportSpecifiers(sourceFile) {
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function collectCronAbortContractFiles(roots, cwd) {
  const queue = [];
  const seen = new Set();
  for (const root of roots) {
    for (const file of collectSourceFilesUnderRoot(root, cwd, {
      extensions: SOURCE_EXTENSIONS,
      excludedDirs: EXCLUDED_DIRS,
    })) {
      queue.push(file);
    }
  }

  const libRoot = CRON_REACHABLE_LIB_ROOT;
  const collected = [];
  while (queue.length > 0) {
    const file = queue.shift();
    const rel = normalizeRel(cwd, file);
    if (seen.has(rel)) continue;
    seen.add(rel);
    collected.push(file);

    const { sourceFile } = parseSourceFile(file);
    for (const specifier of collectImportSpecifiers(sourceFile)) {
      const imported = resolveLocalImport(file, specifier);
      if (!imported) continue;
      const importedRel = normalizeRel(cwd, imported);
      if (isInsideRel(importedRel, libRoot) && !seen.has(importedRel)) {
        queue.push(imported);
      }
    }
  }

  return collected.sort((a, b) => normalizeRel(cwd, a).localeCompare(normalizeRel(cwd, b)));
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
}

function oneLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function isFunctionLikeNode(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function parameterSignalNames(node, sourceFile) {
  const names = new Set();
  const bodyText = node.body ? node.body.getText(sourceFile) : "";
  for (const parameter of node.parameters ?? []) {
    const typeText = parameter.type?.getText(sourceFile) ?? "";
    if (ts.isIdentifier(parameter.name)) {
      const name = parameter.name.text;
      if (name === "signal" || /\bAbortSignal\b/.test(typeText)) {
        names.add(name);
      }
      if (bodyText.includes(`${name}.signal`)) {
        names.add(`${name}.signal`);
      }
      continue;
    }
    if (ts.isObjectBindingPattern(parameter.name)) {
      for (const element of parameter.name.elements) {
        if (ts.isIdentifier(element.name) && element.name.text === "signal") {
          names.add("signal");
        }
      }
    }
  }
  return names;
}

function expressionUsesSignal(text) {
  return /\bsignal\b/i.test(text) ||
    /\b[A-Za-z_$][\w$]*signal[\w$]*\b/i.test(text) ||
    /\.\s*signal\b/i.test(text);
}

function callArgsUseSignal(node, sourceFile) {
  return expressionUsesSignal(node.arguments.map((arg) => arg.getText(sourceFile)).join(" "));
}

function fetchCallHasSignal(node, sourceFile) {
  if (node.arguments.length < 2) return false;
  return expressionUsesSignal(node.arguments.slice(1).map((arg) => arg.getText(sourceFile)).join(" "));
}

function isGlobalFetchCall(node) {
  return ts.isIdentifier(node.expression) && node.expression.text === "fetch";
}

function loopIsLongOrAsync(node, sourceFile) {
  const text = node.getText(sourceFile);
  const lineCount = text.split("\n").length;
  if (ts.isForStatement(node) && !node.condition) return true;
  if (ts.isDoStatement(node)) return true;
  if (ts.isWhileStatement(node) && node.expression.getText(sourceFile) === "true") return true;
  if (lineCount < 12) return false;
  return /\bawait\b/.test(text) ||
    /\b(?:fetch|fetchWithRetry|batchExecute|runWithOverloadRetry|setCacheIfNewer|sleepWithSignal|writeFreshnessSentinel)\s*\(/.test(text);
}

function loopHasAbortCheck(node, sourceFile) {
  const text = node.statement.getText(sourceFile);
  return /\b(?:throwIfAborted|rethrowIfAborted|runWithAbort|sleepWithSignal|fetchWithRetry|buildDirectApiRequestSignal|createTimeoutSignal)\s*\(/.test(text) ||
    (expressionUsesSignal(text) && /\b(?:fetchWithRetry|batchExecute|runWithOverloadRetry|setCacheIfNewer|sleepWithSignal|writeFreshnessSentinel)\s*\(/.test(text)) ||
    /\b\w*signal\w*(?:\?\.|\.)aborted\b/i.test(text);
}

function reportViolation({ violations, waivers, rel, lines, sourceFile, node, code, message }) {
  const lineIndex = lineOf(sourceFile, node);
  const snippet = oneLine(lines[lineIndex] ?? node.getText(sourceFile).slice(0, 180));
  const text = `${code}: ${message}: ${snippet}`;
  if (isWaived(waivers, rel, text) || isWaived(waivers, rel, snippet)) return;
  violations.push({ file: rel, line: lineIndex + 1, code, text });
}

function scanFile(file, cwd, waivers) {
  const rel = normalizeRel(cwd, file);
  const { source, sourceFile } = parseSourceFile(file);
  const lines = source.split("\n");
  const violations = [];
  const functionStack = [];
  const reported = new Set();
  const report = (node, code, message) => {
    const before = violations.length;
    reportViolation({ violations, waivers, rel, lines, sourceFile, node, code, message });
    if (violations.length === before) return;
    const violation = violations[violations.length - 1];
    const key = `${violation.file}:${violation.line}:${violation.code}`;
    if (!reported.has(key)) {
      reported.add(key);
      return;
    }
    violations.pop();
  };

  const visit = (node) => {
    if (isFunctionLikeNode(node)) {
      const parentSignals = functionStack.at(-1)?.signals ?? new Set();
      const signals = new Set([...parentSignals, ...parameterSignalNames(node, sourceFile)]);
      functionStack.push({ signals });
      ts.forEachChild(node, visit);
      functionStack.pop();
      return;
    }

    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const typeText = node.type?.getText(sourceFile) ?? "";
      if (node.name.text === "_signal" && /\bAbortSignal\b/.test(typeText)) {
        report(node, "unused-abort-signal", "AbortSignal parameters must not be named _signal");
      }
    }

    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && LEASED_CRON_CALLEES.has(name)) {
        for (const arg of node.arguments) {
          if ((ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && arg.parameters.length === 0) {
            report(arg, "missing-cron-signal", `${name} callback must accept the cron AbortSignal`);
          }
        }
      }

      const context = functionStack.at(-1);
      if (context?.signals.size) {
        if (isGlobalFetchCall(node) && !fetchCallHasSignal(node, sourceFile)) {
          report(node, "dropped-fetch-signal", "fetch() inside a signal-aware function must pass a signal");
        } else if (name && SIGNAL_AWARE_CALLEES.has(name) && !callArgsUseSignal(node, sourceFile)) {
          report(node, "dropped-helper-signal", `${name}() inside a signal-aware function must pass the available signal`);
        }
      }
    }

    if (
      (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) &&
      functionStack.at(-1)?.signals.size &&
      loopIsLongOrAsync(node, sourceFile) &&
      !loopHasAbortCheck(node, sourceFile)
    ) {
      report(node, "loop-missing-abort-check", "long or async loop in a signal-aware function must check for abort");
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function scanCronAbortContract(roots = DEFAULT_ROOTS, cwd = process.cwd()) {
  const waivers = readWaivers(cwd);
  const scannedFiles = collectCronAbortContractFiles(roots, cwd);
  const violations = scannedFiles.flatMap((file) => scanFile(file, cwd, waivers));
  return { scannedFiles, violations };
}

export function main(cwd = process.cwd()) {
  const report = scanCronAbortContract(DEFAULT_ROOTS, cwd);
  if (report.violations.length > 0) {
    process.stderr.write("Cron abort contract violations:\n\n");
    for (const violation of report.violations) {
      process.stderr.write(`  ${violation.file}:${violation.line}: ${violation.text}\n`);
    }
    process.stderr.write("\nFix: accept and pass the cron AbortSignal, propagate it to abort-aware calls, or add a documented waiver.\n");
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

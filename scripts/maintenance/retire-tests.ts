#!/usr/bin/env node

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import ts from "typescript";
import {
  assertCliUsage,
  parseStrictCliArgs,
  runDirectCli,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { collectSourceFilesUnderRoots } from "../lib/source-files.mts";
import { getScriptKind } from "../lib/ts-ast.mts";
import { ALWAYS_RUN_TEST_FILES, CRITICAL_TEST_FILES } from "../lib/critical-test-files.mts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const REFERENCE_SCAN_EXTENSIONS = [".md", ".mdx", ".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx", ".json", ".yml", ".yaml"];
const REFERENCE_SCAN_EXCLUDED_DIRS = ["node_modules", ".git", ".next", "out", "coverage", ".cache", ".worktrees", "worktrees", "agents", "dist", "public"];
// A reference scan is a line-oriented grep, not an index: bound the bytes read
// by oversized generated data and fixture envelopes.
const REFERENCE_SCAN_MAX_BYTES = 2 * 1024 * 1024;
// Append-only evidence ledgers and the secret-scan baseline keep historical
// paths on purpose; nothing validates them as live test files.
const HISTORICAL_REFERENCE_PREFIXES = [".github/artifacts/"];
const SKIPPED_REFERENCE_FILES = new Set([".gitleaksignore", "package-lock.json"]);

export type RetirementRegistryFormat = "json" | "source";

/**
 * The literal half of the protected set. `CRITICAL_TEST_FILES` is derived from
 * the live import scan in `critical-ownership.mts`, so a security or auth owner
 * test can be critical without any list in this file naming it; retiring one
 * still needs `--replacement` so the behaviour keeps an owner.
 */
export const DERIVED_PROTECTED_TEST_FILES: ReadonlySet<string> = new Set([...ALWAYS_RUN_TEST_FILES, ...CRITICAL_TEST_FILES]);

export interface RetirementRegistry {
  /** Repo-relative registry file; must exist or planning fails closed. */
  file: string;
  /** Human label used in printed edits and refusals. */
  label: string;
  format: RetirementRegistryFormat;
  /** A listed path is a protected contract: removal requires --replacement. */
  protected?: boolean;
  /** Removing the last element of the owning list would orphan it: requires --replacement. */
  requiresOwner?: boolean;
  /** A named singleton reference cannot be deleted mechanically: requires --replacement. */
  requiresRepoint?: boolean;
}

/**
 * Every registry that names a test file by exact path and fails when that path
 * disappears. Adding one here is the mirror image of enrolling a test: deletion
 * stays as cheap as addition only if each owner edits the same set.
 */
export const RETIREMENT_REGISTRIES: readonly RetirementRegistry[] = [
  {
    file: "scripts/lib/critical-test-files.mts",
    label: "ALWAYS_RUN_TEST_FILES / critical contract lists",
    format: "source",
    protected: true,
    requiresOwner: true,
  },
  {
    file: "scripts/lib/provider-resilience-registry.mjs",
    label: "provider resilience surface tests",
    format: "source",
    requiresOwner: true,
  },
  {
    file: "docs/doc-ownership.json",
    label: "doc-ownership testOwnership",
    format: "json",
    requiresOwner: true,
  },
  {
    file: "scripts/lib/critical-coverage.mjs",
    label: "critical-coverage waiver ownerTest",
    format: "source",
    requiresRepoint: true,
  },
  {
    file: "scripts/lib/critical-ownership.mts",
    label: "vitest isolation project lists",
    format: "source",
  },
  {
    file: "scripts/lib/pr-lanes.mts",
    label: "PR lane command roster",
    format: "source",
  },
  {
    file: "scripts/maintenance/run-v9-resource-lane.ts",
    label: "required V9 resource case file",
    format: "source",
    requiresRepoint: true,
  },
  {
    file: "vitest.config.ts",
    label: "vitest project configuration",
    format: "source",
  },
];

export interface RegistryEdit {
  file: string;
  line: number;
  /** Nearest named list/singleton that owns the reference, for example `tests[1]`. */
  owner: string;
  action: "repoint" | "remove";
  path: string;
  replacement?: string;
  before: string[];
  after: string[];
}

export interface ManualReference {
  file: string;
  line: number;
  /** `path` is an exact repo-relative hit; `basename` is a prose mention in Markdown. */
  match: "path" | "basename";
  path: string;
  text: string;
}

export interface EvidenceCase {
  path: string;
  title: string;
}

export interface RetirementPlan {
  root: string;
  paths: string[];
  replacement?: string;
  edits: RegistryEdit[];
  manual: ManualReference[];
  cases: EvidenceCase[];
  errors: string[];
  /** Registry rewrites computed (and syntax-verified) by planning. */
  writes: Array<{ file: string; content: string }>;
}

export interface RetirementOptions {
  root?: string;
  paths: readonly string[];
  replacement?: string;
  registries?: readonly RetirementRegistry[];
  /** Defaults to the live `ALWAYS_RUN_TEST_FILES`/`CRITICAL_TEST_FILES`. */
  derivedProtectedTestFiles?: Iterable<string>;
}

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

interface LiteralHit {
  start: number;
  end: number;
  owner: string;
  /** Element count of the enclosing array literal, 0 when the literal is not in one. */
  listSize: number;
  /** Start offset of the enclosing array literal; identifies the list across hits. */
  listStart: number;
}

export interface AppliedRetirement {
  written: string[];
  deleted: string[];
}

function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function parseRegistry(format: RetirementRegistryFormat, file: string, text: string): ts.SourceFile {
  return format === "json"
    ? ts.parseJsonText(file, text)
    : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, getScriptKind(file));
}

function collectLiteralHits(sourceFile: ts.SourceFile, target: string): LiteralHit[] {
  const hits: LiteralHit[] = [];

  function visit(node: ts.Node, ancestors: readonly ts.Node[]): void {
    if (ts.isStringLiteral(node) && node.text === target) {
      hits.push({
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        ...describeOwner(ancestors, node, sourceFile),
      });
      return;
    }
    const next = [...ancestors, node];
    ts.forEachChild(node, (child) => visit(child, next));
  }

  visit(sourceFile, []);
  return hits;
}

/**
 * Walk outward for the nearest array (the list being edited) and the nearest
 * named owner (property assignment or variable declaration). Parent pointers are
 * not available on JSON source files, so the caller supplies its own ancestry.
 */
function describeOwner(
  ancestors: readonly ts.Node[],
  node: ts.Node,
  sourceFile: ts.SourceFile,
): { owner: string; listSize: number; listStart: number } {
  let list: ts.ArrayLiteralExpression | undefined;
  let name: string | undefined;
  for (let index = ancestors.length - 1; index >= 0 && (list === undefined || name === undefined); index -= 1) {
    const ancestor = ancestors[index]!;
    if (list === undefined && ts.isArrayLiteralExpression(ancestor)) list = ancestor;
    if (name === undefined && ts.isPropertyAssignment(ancestor)) {
      name = ts.isStringLiteralLike(ancestor.name) || ts.isIdentifier(ancestor.name) ? ancestor.name.text : undefined;
    }
    if (name === undefined && ts.isVariableDeclaration(ancestor) && ts.isIdentifier(ancestor.name)) name = ancestor.name.text;
  }
  const listSize = list?.elements.length ?? 0;
  const listStart = list?.getStart(sourceFile) ?? -1;
  const position = list?.elements.findIndex((element) => element === node) ?? -1;
  if (name !== undefined && position >= 0) return { owner: `${name}[${position}]`, listSize, listStart };
  if (name !== undefined) return { owner: name, listSize, listStart };
  return { owner: position >= 0 ? `[${position}]` : "<list>", listSize, listStart };
}

function previousNonSpaceIndex(text: string, before: number): number {
  for (let index = before - 1; index >= 0; index -= 1) {
    if (!/\s/.test(text[index] ?? "")) return index;
  }
  return -1;
}

/**
 * Remove one array element, preferring the whole line when the item owns it and
 * the preceding comma when it is the last element without a trailing comma.
 */
function buildRemovalEdit(text: string, start: number, end: number): TextEdit | null {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const newlineIndex = text.indexOf("\n", end);
  const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
  const prefix = text.slice(lineStart, start);
  const suffix = text.slice(end, lineEnd);
  const nextLineStart = Math.min(lineEnd + 1, text.length);

  if (!/^[ \t]*$/.test(prefix)) {
    const commaAfter = /^[ \t]*,[ \t]*/.exec(suffix);
    if (commaAfter) return { start, end: end + commaAfter[0].length, text: "" };
    const commaBefore = /,[ \t]*$/.exec(prefix);
    if (commaBefore) return { start: start - commaBefore[0].length, end, text: "" };
    return null;
  }

  if (/^[ \t]*,[ \t]*$/.test(suffix)) return { start: lineStart, end: nextLineStart, text: "" };
  if (!/^[ \t]*$/.test(suffix)) return null;
  const previous = previousNonSpaceIndex(text, lineStart);
  // Last element without a trailing comma: take the previous comma and keep the
  // line break, so the closing bracket stays on its own line.
  if (previous >= 0 && text[previous] === ",") return { start: previous, end: lineEnd, text: "" };
  return { start: lineStart, end: nextLineStart, text: "" };
}

/** Count the hits each array literal loses, so two retirements cannot empty one list unnoticed. */
function countRetirementsByList(hits: readonly LiteralHit[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const hit of hits) counts.set(hit.listStart, (counts.get(hit.listStart) ?? 0) + 1);
  return counts;
}

function applyEdits(text: string, edits: readonly TextEdit[]): { content: string; error?: string } {
  const sorted = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]!.end > sorted[index]!.start) {
      return { content: text, error: "overlapping retirement edits" };
    }
  }
  let content = text;
  for (const edit of [...sorted].reverse()) {
    content = `${content.slice(0, edit.start)}${edit.text}${content.slice(edit.end)}`;
  }
  return { content };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineIndexAt(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= index) low = middle;
    else high = middle - 1;
  }
  return low;
}

function describeEdit(text: string, starts: readonly number[], edit: TextEdit): Pick<RegistryEdit, "before" | "after"> {
  const startLine = lineIndexAt(starts, Math.max(0, Math.min(edit.start, text.length)));
  const endLine = lineIndexAt(starts, Math.max(0, Math.min(Math.max(edit.end, edit.start + 1), text.length) - 1));
  const lines = text.split("\n");
  const before = lines.slice(startLine, endLine + 1).map((line) => line.trimEnd());
  if (edit.text === "") return { before, after: [] };
  const source = lines[startLine] ?? "";
  const lineStart = starts[startLine] ?? 0;
  const next = `${source.slice(0, edit.start - lineStart)}${edit.text}${source.slice(edit.end - lineStart)}`;
  return { before, after: [next.trimEnd()] };
}

/**
 * `["exec", "--", "vitest", "run", <test files…>]` roster entries: the owning
 * guard is the file list after `run`. Retiring the last one leaves syntactically
 * valid arguments that silently run the wrong selection instead of the lane.
 */
function findEmptyVitestRunRosters(sourceFile: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      const elements = node.elements;
      const runIndex = elements.findIndex((element, index) => {
        const previous = index > 0 ? elements[index - 1] : undefined;
        return ts.isStringLiteralLike(element)
          && element.text === "run"
          && previous !== undefined
          && ts.isStringLiteralLike(previous)
          && previous.text === "vitest";
      });
      if (runIndex >= 0) {
        const testArguments = elements
          .slice(runIndex + 1)
          .filter((element) => !(ts.isStringLiteralLike(element) && element.text.startsWith("-")));
        if (testArguments.length === 0) {
          lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

function verifyRegistryRewrite(registry: RetirementRegistry, next: string, retired: readonly string[]): string | null {
  if (registry.format === "json") {
    try {
      JSON.parse(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `${registry.file}: retirement edit would leave invalid JSON (${message})`;
    }
  } else {
    const emitted = ts.transpileModule(next, {
      fileName: registry.file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    for (const diagnostic of emitted.diagnostics ?? []) {
      if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
      return `${registry.file}: retirement edit would leave a syntax error (${message})`;
    }
  }
  const reparsed = parseRegistry(registry.format, registry.file, next);
  for (const path of retired) {
    if (collectLiteralHits(reparsed, path).length > 0) return `${registry.file}: retirement edit would leave ${path} referenced`;
  }
  for (const line of findEmptyVitestRunRosters(reparsed)) {
    return (
      `${registry.file}:${line}: retirement edit would leave a \`vitest run\` roster entry with no test argument; ` +
      "pass --replacement <existing test file> or edit the roster by hand"
    );
  }
  return null;
}

function readReferenceFile(root: string, file: string): string | null {
  try {
    const absolute = resolve(root, file);
    if (statSync(absolute).size > REFERENCE_SCAN_MAX_BYTES) return null;
    return readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

/** Trim a matched line to a window around the hit; prose lines are long. */
function excerptFor(line: string, needle: string): string {
  const trimmed = line.trim();
  const index = trimmed.indexOf(needle);
  if (index < 0) return trimmed.slice(0, 160);
  const start = Math.max(0, index - 60);
  const end = Math.min(trimmed.length, index + needle.length + 60);
  return `${start > 0 ? "…" : ""}${trimmed.slice(start, end)}${end < trimmed.length ? "…" : ""}`;
}

function collectManualReferences(
  root: string,
  retired: readonly string[],
  writes: readonly { file: string; content: string }[],
): ManualReference[] {
  const nextByFile = new Map(writes.map((write) => [write.file, write.content]));
  const retiredSet = new Set(retired);
  const candidates = retired.map((path) => ({ path, name: basename(path) }));
  const references: ManualReference[] = [];
  const seen = new Set<string>();

  const files = collectSourceFilesUnderRoots(["."], root, {
    extensions: REFERENCE_SCAN_EXTENSIONS,
    excludedDirs: REFERENCE_SCAN_EXCLUDED_DIRS,
  });

  for (const file of files) {
    if (retiredSet.has(file)) continue;
    if (SKIPPED_REFERENCE_FILES.has(file)) continue;
    if (HISTORICAL_REFERENCE_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
    const content = nextByFile.get(file) ?? readReferenceFile(root, file);
    if (content === null) continue;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      for (const candidate of candidates) {
        const exact = line.includes(candidate.path);
        const prose = !exact && file.endsWith(".md") && line.includes(candidate.name);
        if (!exact && !prose) continue;
        const key = `${file}:${index + 1}:${candidate.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        references.push({
          file,
          line: index + 1,
          match: exact ? "path" : "basename",
          path: candidate.path,
          text: excerptFor(line, exact ? candidate.path : candidate.name),
        });
      }
    }
  }

  return references;
}

function collectEvidenceCases(root: string, path: string): EvidenceCase[] {
  const text = readReferenceFile(root, path);
  if (text === null) return [{ path, title: "" }];
  const titles = new Set<string>();
  for (const match of text.matchAll(/^[ \t]*(?:it|test)\b[^\n(]*\(\s*(["'`])([^"'`\n]+)\1/gm)) {
    titles.add(match[2] ?? "");
  }
  if (titles.size === 0) return [{ path, title: "" }];
  return [...titles].map((title) => ({ path, title }));
}

/**
 * Plan a test retirement: every registry edit (fail closed on protected
 * contracts, orphaned owner lists, missing paths and unverifiable rewrites),
 * every remaining hand-fix reference, and the evidence template rows.
 */
export function planTestRetirement({
  root = process.cwd(),
  paths,
  replacement: rawReplacement,
  registries = RETIREMENT_REGISTRIES,
  derivedProtectedTestFiles = DERIVED_PROTECTED_TEST_FILES,
}: RetirementOptions): RetirementPlan {
  const errors: string[] = [];
  const derivedProtected = new Set(derivedProtectedTestFiles);
  const retired = [...new Set(paths.map(normalizeRepoPath))].filter((path) => path.length > 0);
  if (retired.length === 0) errors.push("Provide at least one test path to retire.");
  for (const path of retired) {
    if (path.startsWith("/") || path.startsWith("../") || path.includes("/../")) {
      errors.push(`${path}: expected a repo-relative test path`);
    } else if (!TEST_FILE_PATTERN.test(path)) {
      errors.push(`${path}: not a test file (*.test.* or *.spec.*)`);
    } else if (!isFile(resolve(root, path))) {
      errors.push(`${path}: test file not found`);
    }
  }

  const replacement = rawReplacement === undefined ? undefined : normalizeRepoPath(rawReplacement);
  if (replacement !== undefined) {
    if (retired.includes(replacement)) {
      errors.push(`${replacement}: --replacement cannot be one of the retired paths`);
    } else if (!TEST_FILE_PATTERN.test(replacement)) {
      errors.push(`${replacement}: --replacement must name a test file (*.test.* or *.spec.*)`);
    } else if (!isFile(resolve(root, replacement))) {
      errors.push(`${replacement}: --replacement test file not found`);
    }
  }

  const edits: RegistryEdit[] = [];
  const writes: Array<{ file: string; content: string }> = [];
  const protectedRefusals = new Set<string>();

  for (const registry of registries) {
    const absolute = resolve(root, registry.file);
    if (!isFile(absolute)) {
      errors.push(`${registry.file}: retirement registry missing (${registry.label}); update RETIREMENT_REGISTRIES`);
      continue;
    }
    const text = readFileSync(absolute, "utf8");
    const starts = lineStarts(text);
    const sourceFile = parseRegistry(registry.format, registry.file, text);
    const fileEdits: TextEdit[] = [];
    const hitsByPath = new Map(retired.map((path) => [path, collectLiteralHits(sourceFile, path)] as const));
    const retirementsByList = countRetirementsByList([...hitsByPath.values()].flat());
    const orphanedLists = new Set<number>();

    for (const path of retired) {
      for (const hit of hitsByPath.get(path) ?? []) {
        const line = lineIndexAt(starts, hit.start) + 1;
        if (registry.requiresRepoint === true && replacement === undefined) {
          errors.push(
            `${registry.file}:${line}: ${path} (${hit.owner}) is a named reference; pass --replacement <existing test> or hand-edit ${registry.label}`,
          );
          continue;
        }
        if (registry.protected === true && replacement === undefined) {
          protectedRefusals.add(path);
          errors.push(
            `${path}: listed in ${registry.file}:${line} (${hit.owner}) as a protected contract; pass --replacement <existing test file> so the behaviour keeps an owner`,
          );
          continue;
        }
        const remaining = hit.listSize - (retirementsByList.get(hit.listStart) ?? 0);
        if (registry.requiresOwner === true && hit.listSize > 0 && remaining <= 0 && replacement === undefined) {
          // One refusal per list: two retirements that empty it together are one defect.
          if (!orphanedLists.has(hit.listStart)) {
            orphanedLists.add(hit.listStart);
            errors.push(
              `${registry.file}:${line}: removing ${path} would leave ${hit.owner} with no test; pass --replacement <existing test file>`,
            );
          }
          continue;
        }

        const action = replacement === undefined ? "remove" : "repoint";
        const edit: TextEdit | null = replacement === undefined
          ? buildRemovalEdit(text, hit.start, hit.end)
          : { start: hit.start + 1, end: hit.end - 1, text: replacement };
        if (edit === null) {
          errors.push(`${registry.file}:${line}: cannot mechanically remove ${path} from ${hit.owner}; edit it by hand`);
          continue;
        }
        fileEdits.push(edit);
        edits.push({
          file: registry.file,
          line,
          owner: hit.owner,
          action,
          path,
          ...(replacement === undefined ? {} : { replacement }),
          ...describeEdit(text, starts, edit),
        });
      }
    }

    if (fileEdits.length === 0) continue;
    const applied = applyEdits(text, fileEdits);
    if (applied.error !== undefined) {
      errors.push(`${registry.file}: ${applied.error}`);
      continue;
    }
    const problem = verifyRegistryRewrite(registry, applied.content, retired);
    if (problem !== null) {
      errors.push(problem);
      continue;
    }
    writes.push({ file: registry.file, content: applied.content });
  }

  // The literal registries above name only the enumerated half of the protected
  // set; `CRITICAL_TEST_FILES` is derived from the live test scan, so a retired
  // path outside every literal list still needs --replacement.
  if (replacement === undefined) {
    for (const path of retired) {
      if (protectedRefusals.has(path) || !derivedProtected.has(path)) continue;
      errors.push(
        `${path}: derived into ALWAYS_RUN_TEST_FILES/CRITICAL_TEST_FILES by the test scan (critical-ownership.mts); ` +
          "pass --replacement <existing test file> so the behaviour keeps an owner",
      );
    }
  }

  const manual = collectManualReferences(root, retired, writes);
  const cases = retired.flatMap((path) => collectEvidenceCases(root, path));

  return {
    root,
    paths: retired,
    ...(replacement === undefined ? {} : { replacement }),
    edits,
    manual,
    cases,
    errors,
    writes,
  };
}

/** Apply a plan whose errors are empty. Registry rewrites land before deletions. */
export function applyRetirementPlan(plan: RetirementPlan): AppliedRetirement {
  if (plan.errors.length > 0) {
    throw new Error(`Refusing to apply a retirement plan with ${plan.errors.length} error(s)`);
  }
  const written: string[] = [];
  for (const write of plan.writes) {
    writeFileSync(resolve(plan.root, write.file), write.content);
    written.push(write.file);
  }
  const deleted: string[] = [];
  for (const path of plan.paths) {
    const absolute = resolve(plan.root, path);
    if (!isFile(absolute)) continue;
    unlinkSync(absolute);
    deleted.push(path);
  }
  return { written, deleted };
}

export function formatRetirementPlan(plan: RetirementPlan, { applied = false }: { applied?: boolean } = {}): string {
  if (plan.errors.length > 0) {
    const lines = ["Test retirement refused — nothing was changed:", ...plan.errors.map((error) => `  - ${error}`), ""];
    return `${lines.join("\n")}\n`;
  }

  const lines: string[] = [applied ? "Test retirement applied" : "Test retirement plan (dry run)"];
  for (const path of plan.paths) lines.push(`  retire: ${path}`);
  if (plan.replacement !== undefined) lines.push(`  replacement: ${plan.replacement}`);
  lines.push("");

  if (plan.edits.length === 0) {
    lines.push("Registry edits (0): no registered list names these paths.", "");
  } else {
    lines.push(`Registry edits (${plan.edits.length}):`);
    for (const edit of plan.edits) {
      const target = edit.replacement === undefined ? edit.path : `${edit.path} -> ${edit.replacement}`;
      lines.push(`  ${edit.file}:${edit.line} ${edit.owner} ${edit.action} ${target}`);
      for (const line of edit.before) lines.push(`    - ${line}`);
      for (const line of edit.after) lines.push(`    + ${line}`);
    }
    lines.push("");
  }

  if (plan.manual.length > 0) {
    lines.push(`Other references to fix by hand (${plan.manual.length}):`);
    for (const reference of plan.manual) {
      lines.push(`  ${reference.file}:${reference.line} (${reference.match}) ${reference.text}`);
    }
    lines.push("");
  } else {
    lines.push("Other references to fix by hand (0).", "");
  }

  lines.push(
    'Evidence (docs/testing.md "Test evidence rules" -> "Deletions name their evidence"):',
    "| Deleted case | Surviving test path | Exact test title |",
    "| --- | --- | --- |",
  );
  for (const evidence of plan.cases) {
    const title = evidence.title === "" ? "<exact title>" : `"${evidence.title.replaceAll("|", "\\|")}"`;
    lines.push(`| \`${evidence.path}\` — ${title} | | |`);
  }
  lines.push("");

  if (applied) {
    lines.push(`Applied: ${plan.writes.length} registry file(s) written, ${plan.paths.length} test file(s) deleted.`);
    if (plan.manual.length > 0) lines.push(`Fix the ${plan.manual.length} remaining reference(s) above by hand and run the owning checks.`);
  } else {
    lines.push(
      `Dry run: no files changed. Re-run with --write to apply ${plan.writes.length} registry edit file(s) and delete ${plan.paths.length} test file(s).`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const USAGE = `Usage: npm run tests:retire -- <test paths…> [--replacement <path>] [--write]

Print (default, dry run) every registry edit and every hand-fix reference a test
deletion needs, plus the docs/testing.md evidence template.
--write applies the registry edits and deletes the retired test files.

Options:
  --replacement <path>  existing test file that keeps the behaviour's evidence;
                        required for ALWAYS_RUN_TEST_FILES/critical lists and
                        whenever an edit would orphan a registered owner
  --write               apply the registry edits and delete the files
  -h, --help            print this help

Enrolled registries: ${RETIREMENT_REGISTRIES.map((registry) => registry.file).join(", ")}.`;

runDirectCli(import.meta.url, () => {
  const { values, positionals } = parseStrictCliArgs(process.argv.slice(2), {
    allowPositionals: true,
    options: {
      replacement: { type: "string" },
      write: { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  assertCliUsage(positionals.length > 0, "Provide at least one test path to retire");

  const plan = planTestRetirement({
    paths: positionals,
    ...(typeof values.replacement === "string" ? { replacement: values.replacement } : {}),
  });
  if (plan.errors.length > 0) {
    console.log(formatRetirementPlan(plan));
    process.exitCode = 1;
    return;
  }
  if (values.write !== true) {
    console.log(formatRetirementPlan(plan));
    return;
  }
  applyRetirementPlan(plan);
  console.log(formatRetirementPlan(plan, { applied: true }));
}, { label: "tests:retire", usage: USAGE });

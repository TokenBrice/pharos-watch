#!/usr/bin/env node
/**
 * Parity canary for the static PR test planner.
 *
 * For each of the last N first-parent commits, materialize the commit's tree,
 * ask the authoritative Vitest runtime which tests `--changed <parent>` would
 * select (through the same `related` filter, with the changed set supplied as
 * data so no history rewriting is needed), and compare it with
 * `planPrTestSelection`. The check fails when the static planner misses a file
 * Vitest selects; static-only extras are reported but allowed, because the
 * planner is allowed to run more tests than the runtime, never fewer. A run
 * that compares nothing is also a failure: a commit that changed an executable
 * test must select one, and at least one commit in the window must produce a
 * non-empty comparison on either side.
 *
 * The canary replays the *current* planner over older trees, so a commit that
 * predates one of the planner's own inputs cannot be planned at all. That commit
 * is reported as not comparable with the fallback reason instead of failing the
 * run; it is never a parity pass, and the run-level rule above still fails a
 * window that only ever fell back.
 *
 * Usage: node --import tsx scripts/ci/check-test-plan-parity.ts [--commits=N]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv as processArgv } from "node:process";
import { parseCliInteger, parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { collectGitPaths } from "../lib/changed-files.mts";
import { localBin } from "../lib/local-bin.mts";
import { isNightlyTestFile } from "../lib/nightly-test-tier.mts";
import { buildPrImportGraph, collectExecutableTestFiles, planPrTestSelection, type PrTestSelectionMode } from "../lib/pr-import-graph.mts";
import { parseVitestFileList } from "../lib/pr-test-selection.mts";

const DEFAULT_COMMITS = 5;
const WORK_DIR = ".tmp/test-plan-parity";
/**
 * The changed set travels as a file in the temporary tree, read relative to the
 * spawn's working directory. One environment string is capped at 128 KiB on
 * Linux, which a merge touching about a thousand files exceeds (E2BIG).
 */
const RELATED_FILES_NAME = ".parity.related.json";

export interface CommitParity {
  commit: string;
  parent: string;
  changed: number;
  mode: PrTestSelectionMode;
  staticCount: number;
  viteCount: number;
  /** C8 data-only routing is an intentional subset; it is not compared. */
  skipped?: "data-only";
  /** Tests Vitest selects that the static planner misses (failures). */
  missing: string[];
  /** Tests only the static planner selects (allowed: run more, never less). */
  staticOnly: number;
  /** Vite selected nothing although the static planner found tests. */
  vacuous: boolean;
  /** At least one selection was non-empty, so the commit compared something. */
  comparable: boolean;
  /** The commit changed an executable test file, yet neither side selected one. */
  unproven: boolean;
  /**
   * The planner cannot plan this tree (it predates one of the planner's own
   * inputs), so the commit proves nothing either way — never a parity pass.
   */
  fallback?: string;
}

/**
 * A commit the static planner cannot plan. The canary replays the current
 * planner over historical trees, so a commit older than one of the planner's
 * inputs always falls back; reporting it as not comparable keeps the nightly
 * from failing on history while the run-level "compared nothing" rule still
 * catches a window that produced no evidence.
 */
export function incomparableCommit(
  commit: string,
  parent: string,
  changed: number,
  mode: PrTestSelectionMode,
  reason: string,
): CommitParity {
  return {
    commit,
    parent,
    changed,
    mode,
    staticCount: 0,
    viteCount: 0,
    fallback: reason,
    missing: [],
    staticOnly: 0,
    vacuous: false,
    comparable: false,
    unproven: false,
  };
}

/**
 * Compare one commit's selections. `vacuous` catches a broken `related` filter
 * that returns nothing: a static selection with no Vite counterpart is not a
 * pass, it is missing evidence. `unproven` covers the mirror case of a commit
 * that changed an executable test file — such a commit must reach a selection
 * on both sides, so two empty sets mean the planner or the filter is broken.
 */
export function compareCommitSelections(
  mode: PrTestSelectionMode,
  staticFiles: readonly string[],
  viteFiles: readonly string[],
  changedExecutableTests = 0,
): Pick<CommitParity, "mode" | "staticCount" | "viteCount" | "skipped" | "missing" | "staticOnly" | "vacuous" | "comparable" | "unproven"> {
  if (mode === "data-only") {
    return {
      mode,
      staticCount: staticFiles.length,
      viteCount: 0,
      skipped: "data-only",
      missing: [],
      staticOnly: 0,
      vacuous: false,
      comparable: false,
      unproven: false,
    };
  }
  const staticSet = new Set(staticFiles);
  const viteSet = new Set(viteFiles);
  return {
    mode,
    staticCount: staticFiles.length,
    viteCount: viteFiles.length,
    missing: viteFiles.filter((file) => !staticSet.has(file)).sort(),
    staticOnly: staticFiles.filter((file) => !viteSet.has(file)).length,
    vacuous: staticFiles.length > 0 && viteFiles.length === 0,
    comparable: staticFiles.length > 0 || viteFiles.length > 0,
    unproven: changedExecutableTests > 0 && staticFiles.length === 0 && viteFiles.length === 0,
  };
}

/**
 * Failure lines for a whole run. A run that compared nothing (every commit
 * data-only or selecting nothing on both sides) is a failure too: printing
 * "covers Vitest" while comparing nothing is a vacuous pass.
 */
export function summarizeParityFailures(results: readonly CommitParity[]): string[] {
  const failures: string[] = [];
  const missing = results.reduce((count, result) => count + result.missing.length, 0);
  const vacuous = results.filter((result) => result.vacuous).map((result) => result.commit.slice(0, 12));
  const unproven = results.filter((result) => result.unproven).map((result) => result.commit.slice(0, 12));
  if (missing > 0) failures.push(`static planner missed ${missing} Vitest-selected file(s)`);
  if (vacuous.length > 0) failures.push(`Vitest selected nothing for ${vacuous.join(", ")} despite a static selection`);
  if (unproven.length > 0) failures.push(`changed executable test(s) selected nothing for ${unproven.join(", ")}`);
  if (failures.length === 0 && !results.some((result) => result.comparable)) {
    failures.push(
      `compared no non-vacuous selection across ${results.length} commit(s) (all data-only, fell back or empty); rerun with a larger --commits window`,
    );
  }
  return failures;
}

function git(args: readonly string[], cwd = process.cwd(), encoding: "utf8" | null = "utf8"): string {
  const result = spawnSync("git", [...args], { cwd, encoding, maxBuffer: 1024 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr ?? "").trim()}`);
  return String(result.stdout ?? "");
}

function listFirstParentCommits(count: number): string[] {
  return git(["rev-list", "--first-parent", `-${count}`, "HEAD"]).trim().split("\n").filter(Boolean);
}

function parentOf(commit: string): string {
  return git(["rev-parse", `${commit}^`]).trim();
}

/** Paths ignored by git that the commit's tree needs for module resolution (generated inputs, local env). */
function ignoredResolutionInputs(cwd: string): string[] {
  return git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], cwd)
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !/^(?:node_modules|\.next|out|coverage|\.tmp|agents|\.cache)\//.test(path))
    .filter((path) => path !== "node_modules" && !path.includes("node_modules/"))
    .sort();
}

/**
 * Materialize a commit tree without touching refs, branches or the caller's
 * worktree: `git archive` the commit, symlink the shared dependency tree, and
 * symlink ignored generated inputs from the checkout.
 */
function materializeTree(commit: string, root: string, cwd: string): string {
  const tree = join(root, commit.slice(0, 12));
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  const archived = spawnSync("bash", ["-c", `git archive ${commit} | tar -x -C ${JSON.stringify(tree)}`], { cwd, encoding: "utf8" });
  if (archived.error) throw archived.error;
  if (archived.status !== 0) throw new Error(`git archive ${commit} failed: ${String(archived.stderr ?? "").trim()}`);
  for (const target of ["node_modules", "worker/node_modules"]) {
    const source = resolve(cwd, target);
    if (existsSync(source)) symlinkSync(source, join(tree, target), "dir");
  }
  for (const path of ignoredResolutionInputs(cwd)) {
    const destination = join(tree, path);
    if (existsSync(destination)) continue;
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(resolve(cwd, path), destination, "file");
  }
  writeFileSync(join(tree, ".parity.vitest.config.ts"), [
    "// Generated by scripts/ci/check-test-plan-parity.ts; removed with the temporary tree.",
    'import { readFileSync } from "node:fs";',
    'import { defineConfig, mergeConfig } from "vitest/config";',
    'import base from "./vitest.config";',
    "",
    "export default mergeConfig(base, defineConfig({",
    `  test: { related: JSON.parse(readFileSync(${JSON.stringify(RELATED_FILES_NAME)}, "utf8")) },`,
    "}));",
    "",
  ].join("\n"));
  return tree;
}

export function checkCommitParity(commit: string, { root = process.cwd(), workDir = WORK_DIR }: { root?: string; workDir?: string } = {}): CommitParity {
  const parent = parentOf(commit);
  const changed = collectGitPaths({ kind: "range", base: parent, head: commit, noRenames: true }, { cwd: root, execFile: (_file, args) => git(args, root) });
  const tree = materializeTree(commit, join(root, workDir), root);
  try {
    const graph = buildPrImportGraph({ cwd: tree, testFiles: collectExecutableTestFiles(tree) });
    const changedExecutableTests = changed.filter((file) => graph.testFileSet.has(file)).length;
    const staticSelection = planPrTestSelection(changed, { graph });
    if (staticSelection.fallback) return incomparableCommit(commit, parent, changed.length, staticSelection.mode, staticSelection.fallback);
    if (staticSelection.mode === "data-only") {
      // C8 deliberately selects less than the transitive closure; replaying
      // Vitest's selection here would compare two different policies.
      return {
        commit,
        parent,
        changed: changed.length,
        ...compareCommitSelections(staticSelection.mode, staticSelection.files, [], changedExecutableTests),
      };
    }
    writeFileSync(join(tree, RELATED_FILES_NAME), JSON.stringify(changed.map((file) => join(tree, file))));
    const listed = spawnSync(localBin("vitest"), ["list", "--filesOnly", "--config", ".parity.vitest.config.ts"], {
      cwd: tree,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
    });
    if (listed.error) throw listed.error;
    if (listed.status !== 0) throw new Error(`vitest list failed for ${commit}: ${String(listed.stderr ?? "").slice(-2000)}`);
    // The nightly tier is a deliberate planner subset, so both sides of the
    // comparison keep only PR-tier files.
    const viteFiles = parseVitestFileList(listed.stdout ?? "").filter((file) => !isNightlyTestFile(file));
    return {
      commit,
      parent,
      changed: changed.length,
      ...compareCommitSelections(staticSelection.mode, staticSelection.files, viteFiles, changedExecutableTests),
    };
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

export function main(argv: readonly string[] = processArgv.slice(2)): number {
  const { values } = parseStrictCliArgs(argv, { options: { commits: { type: "string", default: String(DEFAULT_COMMITS) } } });
  if (writeCliHelpIfRequested(values, "Usage: node --import tsx scripts/ci/check-test-plan-parity.ts [--commits=N]")) return 0;
  const commits = parseCliInteger(values.commits, { name: "--commits", min: 1, max: 50 });
  const root = process.cwd();
  const results: CommitParity[] = [];
  for (const commit of listFirstParentCommits(commits)) {
    const result = checkCommitParity(commit, { root });
    results.push(result);
    process.stdout.write(
      `[test-plan-parity] ${result.commit.slice(0, 12)} vs ${result.parent.slice(0, 12)}: ${result.changed} changed, mode ${result.mode}`
        + `${result.skipped ? ` (skipped: ${result.skipped})` : ""}, static ${result.staticCount}, vite ${result.viteCount}, `
        + `missing ${result.missing.length}, static-only ${result.staticOnly}${result.vacuous ? ", VACUOUS" : ""}`
        + `${result.unproven ? ", UNPROVEN" : ""}`
        + `${result.fallback ? `, NOT COMPARABLE (${result.fallback})` : ""}\n`,
    );
    for (const file of result.missing.slice(0, 10)) process.stdout.write(`  missing: ${file}\n`);
  }
  const failures = summarizeParityFailures(results);
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`[test-plan-parity] FAIL: ${failure}\n`);
    return 1;
  }
  process.stdout.write(`[test-plan-parity] OK: static selection covers Vitest for ${results.length} commit(s)\n`);
  return 0;
}

runDirectCli(import.meta.url, () => {
  process.exitCode = main();
});

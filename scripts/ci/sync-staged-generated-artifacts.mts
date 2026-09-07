#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, globSync, lstatSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { GENERATED_ARTIFACT_REGISTRY, selectAutoStageArtifactIds, selectGeneratedArtifacts } from "../lib/automation-registry.mjs";
import { collectGitPaths, collectStagedFiles, normalizeRepoPaths, splitNullDelimited } from "../lib/changed-files.mts";
import { selectChangedGeneratedArtifactIds } from "./select-generated-artifacts.mts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

// `automation-registry.mjs` is untyped JS; name the shape this module relies on.
interface RegistryArtifact {
  id: string;
  command: string;
  reproducibility: string;
  outputPaths: string[];
  sourcePaths: string[];
}

interface SyncOptions {
  cwd?: string;
  execFile?: typeof execFileSync;
  log?: (message: string) => unknown;
  runCommand?: (command: string) => number;
  stagedFiles?: readonly string[];
}

interface SyncResult {
  blocked: string[];
  manual: string[];
  regenerated: string[];
}

interface OutputState {
  contents?: Buffer;
  globMembers?: string[];
  existed: boolean;
  path: string;
  tracked: boolean;
  wasClean: boolean;
}

function globOutputFiles(pattern: string, cwd: string): string[] {
  return globSync(pattern, { cwd }).filter((path) => !lstatSync(resolve(cwd, path)).isDirectory());
}

/**
 * A git hook is synchronous, so this cannot use the async `runShellCommand`
 * from command-runner.mts.
 */
function runShellCommandSync(command: string, cwd: string): number {
  try {
    execFileSync("/bin/sh", ["-c", command], { cwd, stdio: "inherit" });
    return 0;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : 1;
  }
}

function collectUnstagedPaths(
  cwd: string,
  execFile: typeof execFileSync,
  stagedFiles: readonly string[],
): string[] {
  const unstagedTracked = collectGitPaths({ kind: "working", noRenames: true, diffFilter: "ACMRTD" }, { cwd, execFile });
  const workingAndUntracked = collectGitPaths(
    { kind: "working", noRenames: true, includeUntracked: true, diffFilter: "ACMRTD" },
    { cwd, execFile },
  );
  const staged = new Set(normalizeRepoPaths(stagedFiles));

  // The includeUntracked form compares tracked files with HEAD, so it also
  // reports clean staged paths. Keep the ordinary diff to catch staged-plus-
  // unstaged edits, and add only the broader result's genuinely new paths.
  return [...new Set([
    ...unstagedTracked,
    ...workingAndUntracked.filter((path) => !staged.has(path)),
  ])];
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => path === pattern || matchesGlob(path, pattern));
}

/**
 * Paths git ignores, resolved in one batch. Glob output paths are reported as
 * tracked: `git check-ignore` matches literal paths, and a conservative
 * "tracked" answer only risks an extra warning, never a silent miss.
 */
function collectIgnoredPaths(
  paths: readonly string[],
  cwd: string,
  execFile: typeof execFileSync,
): Set<string> {
  const literal = paths.filter((path) => !path.includes("*"));
  if (literal.length === 0) return new Set();
  try {
    // Exit code 1 means "nothing ignored" and throws; exit 128 is a real error.
    const output = execFile("git", ["check-ignore", "--stdin", "-z"], {
      cwd,
      encoding: "utf8",
      input: `${literal.join("\0")}\0`,
    });
    return new Set(normalizeRepoPaths(splitNullDelimited(String(output))));
  } catch {
    return new Set();
  }
}

function captureOutputStates(
  outputPaths: readonly string[],
  cwd: string,
  execFile: typeof execFileSync,
): OutputState[] {
  return outputPaths.map((path) => {
    const options = { cwd, encoding: "utf8" as const };
    const status = String(execFile("git", ["status", "--porcelain", "--", path], options));
    let tracked = false;
    try {
      execFile("git", ["ls-files", "--error-unmatch", "--", path], options);
      tracked = true;
    } catch {
      // An untracked output has no index version to restore with git checkout.
    }
    // `git checkout -- <path>` restores the working tree from the index, so an
    // output is restorable whenever its working tree matches the index: porcelain
    // status empty, or index-only (`XY` with a blank worktree column).
    const worktreeClean = status.split("\n").filter(Boolean).every((line) => tracked && line[1] === " ");
    const absolutePath = resolve(cwd, path);
    const existed = existsSync(absolutePath);
    return {
      ...(/[*?\[\]{}]/.test(path) ? { globMembers: globOutputFiles(path, cwd) } : {}),
      ...(existed && !tracked && statSync(absolutePath).isFile() ? { contents: readFileSync(absolutePath) } : {}),
      existed, path, tracked, wasClean: worktreeClean,
    };
  });
}

function restoreOutputStates(
  outputStates: readonly OutputState[],
  cwd: string,
  execFile: typeof execFileSync,
): void {
  const options = { cwd, encoding: "utf8" as const };

  for (const state of outputStates) {
    if (state.globMembers) {
      const originalMembers = new Set(state.globMembers);
      for (const path of globOutputFiles(state.path, cwd)) {
        if (!originalMembers.has(path)) rmSync(resolve(cwd, path), { force: true });
      }
    }
    if (state.tracked) {
      execFile("git", ["checkout", "--", state.path], options);
    } else if (state.contents) {
      writeFileSync(resolve(cwd, state.path), state.contents);
    } else if (!state.existed) {
      rmSync(resolve(cwd, state.path), { recursive: true, force: true });
    }
  }
}

export function syncStagedGeneratedArtifacts({
  cwd = process.cwd(),
  execFile = execFileSync,
  log = console.log,
  runCommand,
  stagedFiles,
}: SyncOptions = {}): SyncResult {
  const run = runCommand ?? ((command: string) => runShellCommandSync(command, cwd));
  const staged = stagedFiles ?? collectStagedFiles({ cwd, diffFilter: "ACMRD", execFile });
  if (staged.length === 0) return { blocked: [], manual: [], regenerated: [] };

  const { autoStage, manual: manualCandidates } = selectAutoStageArtifactIds(
    selectChangedGeneratedArtifactIds(staged),
  );
  if (autoStage.length === 0 && manualCandidates.length === 0) return { blocked: [], manual: [], regenerated: [] };

  const registryById = new Map(
    (GENERATED_ARTIFACT_REGISTRY as RegistryArtifact[]).map((artifact) => [artifact.id, artifact]),
  );
  const outputPathsFor = (id: string): string[] => registryById.get(id)?.outputPaths ?? [];

  // Execution includes prerequisites; staging authority remains autoStage only.
  const artifacts: RegistryArtifact[] = autoStage.length === 0 ? [] : selectGeneratedArtifacts({ only: autoStage });
  for (const artifact of artifacts) {
    if (artifact.reproducibility === "network-derived") {
      throw new Error(`[staged-artifacts] refusing network-derived prerequisite ${artifact.id}`);
    }
    if (!artifact.command || artifact.outputPaths.length === 0) {
      throw new Error(`[staged-artifacts] generator ${artifact.id} is incomplete`);
    }
  }

  // Only warn about artifacts a human could actually commit. A gitignored
  // projection is rebuilt on demand, so naming it here is noise on every
  // coin or docs commit.
  const ignored = collectIgnoredPaths(manualCandidates.flatMap(outputPathsFor), cwd, execFile);
  const manual = manualCandidates.filter((id) => outputPathsFor(id).some((path) => !ignored.has(path)));
  const unstaged = collectUnstagedPaths(cwd, execFile, staged);

  // The generators read the working tree, not the index. Staging output derived
  // from an unstaged source edit would pin content that is not in the commit.
  const blocked = artifacts.filter((artifact) =>
    unstaged.some((path) => matchesAny(path, artifact.sourcePaths)),
  ).map((artifact) => artifact.id);

  if (blocked.length > 0) {
    throw new Error(
      `[staged-artifacts] refusing to regenerate ${blocked.join(", ")}: their sources have unstaged working-tree ` +
        "changes, so the output would not match the commit. Stage or stash those changes, or set " +
        "PHAROS_SKIP_ARTIFACT_HOOK=1 and regenerate manually.",
    );
  }

  const outputPaths = [...new Set(artifacts.flatMap((artifact) => artifact.outputPaths))];
  const outputStates = captureOutputStates(outputPaths, cwd, execFile);
  const dirtyOutputs = outputStates.filter((state) => !state.wasClean).map((state) => state.path);
  if (dirtyOutputs.length > 0) {
    throw new Error(`[staged-artifacts] refusing to overwrite dirty outputs: ${dirtyOutputs.join(", ")}`);
  }
  const regenerated: string[] = [];
  try {
    for (const artifact of artifacts) {
      const { id } = artifact;
      log(`[staged-artifacts] regenerating ${id}`);
      const status = run(artifact.command);
      if (status !== 0) {
        throw new Error(`[staged-artifacts] ${id} generator failed with exit code ${status}: ${artifact.command}`);
      }
      regenerated.push(id);
    }
  } catch (error) {
    restoreOutputStates(outputStates, cwd, execFile);
    throw error;
  }

  if (regenerated.length > 0) {
    execFile("git", ["add", "--", ...new Set(autoStage.flatMap(outputPathsFor))], { cwd, encoding: "utf8" });
  }

  if (regenerated.length > 0) {
    log(`[staged-artifacts] staged: ${autoStage.join(", ")}`);
  }
  if (manual.length > 0) {
    log(
      `[staged-artifacts] NOT auto-staged (regenerate manually if this commit should carry them): ${manual.join(", ")}`,
    );
  }

  return { blocked: [], manual, regenerated };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  try {
    syncStagedGeneratedArtifacts();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { matchesGlob } from "node:path";
import { GENERATED_ARTIFACT_REGISTRY, selectAutoStageArtifactIds } from "../lib/automation-registry.mjs";
import { collectStagedFiles, splitNullDelimited } from "../lib/changed-files.mts";
import { selectChangedGeneratedArtifactIds } from "./select-generated-artifacts.mts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

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

function collectUnstagedPaths(cwd: string, execFile: typeof execFileSync): string[] {
  return splitNullDelimited(
    String(execFile("git", ["diff", "--name-only", "--diff-filter=ACMRTD", "-z"], { cwd, encoding: "utf8" })),
  ).map((path) => path.replaceAll("\\", "/"));
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => path === pattern || matchesGlob(path, pattern));
}

export function syncStagedGeneratedArtifacts({
  cwd = process.cwd(),
  execFile = execFileSync,
  log = console.log,
  runCommand,
  stagedFiles,
}: SyncOptions = {}): SyncResult {
  const run = runCommand ?? ((command: string) => runShellCommandSync(command, cwd));
  const staged = stagedFiles ?? collectStagedFiles({ cwd });
  if (staged.length === 0) return { blocked: [], manual: [], regenerated: [] };

  const { autoStage, manual } = selectAutoStageArtifactIds(selectChangedGeneratedArtifactIds(staged));
  if (autoStage.length === 0 && manual.length === 0) return { blocked: [], manual: [], regenerated: [] };

  const registryById = new Map(GENERATED_ARTIFACT_REGISTRY.map((artifact) => [artifact.id, artifact]));
  const unstaged = collectUnstagedPaths(cwd, execFile);

  // The generators read the working tree, not the index. Staging output derived
  // from an unstaged source edit would pin content that is not in the commit.
  const blocked = autoStage.filter((id) =>
    unstaged.some((path) => matchesAny(path, registryById.get(id)?.sourcePaths ?? [])),
  );

  if (blocked.length > 0) {
    throw new Error(
      `[staged-artifacts] refusing to regenerate ${blocked.join(", ")}: their sources have unstaged working-tree ` +
        "changes, so the output would not match the commit. Stage or stash those changes, or set " +
        "PHAROS_SKIP_ARTIFACT_HOOK=1 and regenerate manually.",
    );
  }

  const regenerated: string[] = [];
  for (const id of autoStage) {
    const artifact = registryById.get(id);
    if (!artifact) continue;
    log(`[staged-artifacts] regenerating ${id}`);
    const status = run(artifact.command);
    if (status !== 0) {
      throw new Error(`[staged-artifacts] ${id} generator failed with exit code ${status}: ${artifact.command}`);
    }
    execFile("git", ["add", "--", ...artifact.outputPaths], { cwd, encoding: "utf8" });
    regenerated.push(id);
  }

  if (regenerated.length > 0) {
    log(`[staged-artifacts] staged: ${regenerated.join(", ")}`);
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

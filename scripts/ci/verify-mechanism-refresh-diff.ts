#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  isSameProtocolApiSourceSnapshot,
  replayProtocolApiMeasurement,
} from "../lib/mechanism-measurement/protocol-api";
import { assertCliUsage, parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const USAGE = `Usage: node --import tsx scripts/ci/verify-mechanism-refresh-diff.ts \\
  --asset <id> --stage <validate-branch|prepare-branch|restore-artifacts|verify-diff> [--artifacts-dir <path>]

Validates ownership of an automated protocol API refresh branch, prepares that
branch, restores captured artifacts without replacing identical snapshots, or
verifies that its pull-request diff is append-only.`;

type VerificationStage = "validate-branch" | "prepare-branch" | "restore-artifacts" | "verify-diff";

interface CommandResult {
  status: number;
  stdout: string;
}

export interface MechanismRefreshVerifierOptions {
  asset: string;
  stage: VerificationStage;
  artifactsDir?: string;
}

interface MechanismRefreshVerifierDependencies {
  cwd?: string;
  repository?: string;
  run?: (file: string, args: readonly string[]) => CommandResult;
}

function githubError(title: string, message: string): Error {
  return new Error(`::error title=${title}::${message}`);
}

function createCommandRunner(cwd: string): (file: string, args: readonly string[]) => CommandResult {
  return (file, args) => {
    const result = spawnSync(file, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: result.status ?? 1, stdout: result.stdout };
  };
}

function requireSuccess(result: CommandResult, description: string): string {
  if (result.status !== 0) throw new Error(`${description} failed`);
  return result.stdout;
}

export function parseMechanismRefreshVerifierArgs(
  argv: readonly string[],
): (MechanismRefreshVerifierOptions & { help: false }) | { help: true } {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      asset: { type: "string" },
      stage: { type: "string" },
      "artifacts-dir": { type: "string" },
    },
  });
  if (values.help === true) return { help: true };
  assertCliUsage(typeof values.asset === "string" && values.asset.length > 0, "--asset is required");
  assertCliUsage(
    values.stage === "validate-branch" || values.stage === "prepare-branch"
      || values.stage === "restore-artifacts" || values.stage === "verify-diff",
    "--stage must be validate-branch, prepare-branch, restore-artifacts, or verify-diff",
  );
  const artifactsDir = values["artifacts-dir"];
  if (values.stage === "restore-artifacts") {
    assertCliUsage(
      typeof artifactsDir === "string" && artifactsDir.length > 0,
      "--artifacts-dir is required only for restore-artifacts",
    );
    return { asset: values.asset, help: false, stage: values.stage, artifactsDir };
  }
  assertCliUsage(artifactsDir === undefined, "--artifacts-dir is required only for restore-artifacts");
  return { asset: values.asset, help: false, stage: values.stage };
}

export function verifyAppendOnlyMechanismRefreshDiff(
  asset: string,
  dependencies: MechanismRefreshVerifierDependencies = {},
): void {
  const cwd = dependencies.cwd ?? process.cwd();
  const run = dependencies.run ?? createCommandRunner(cwd);
  const root = `shared/data/safety-score-v9/mechanism-measurements/${asset}`;
  const diff = requireSuccess(
    run("git", ["diff", "--name-status", "origin/main...HEAD"]),
    "Mechanism refresh diff inspection",
  );
  for (const line of diff.split("\n")) {
    if (!line) continue;
    const [status, path] = line.split("\t");
    if (status !== "A") {
      throw githubError("Non-append-only mechanism PR", `${path} has status ${status}.`);
    }
    if (!path?.startsWith(`${root}/`) || !path.endsWith("-protocol-api.json")) {
      throw githubError("Unexpected mechanism PR diff", `${path} is outside the target artifact set.`);
    }
  }
}

export function restoreMechanismRefreshArtifacts(asset: string, artifactsDir: string, cwd = process.cwd()): void {
  const root = `shared/data/safety-score-v9/mechanism-measurements/${asset}`;
  const capturedRoot = join(artifactsDir, root);
  for (const entry of readdirSync(capturedRoot, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const source = join(entry.parentPath, entry.name);
    const path = join(root, relative(capturedRoot, source));
    if (!entry.isFile() || !path.endsWith("-protocol-api.json")) {
      throw githubError("Unexpected mechanism artifact", `${path} is not a target protocol API artifact.`);
    }
    const incoming = replayProtocolApiMeasurement(JSON.parse(readFileSync(source, "utf8")));
    const destination = join(cwd, path);
    if (existsSync(destination)) {
      const existing = replayProtocolApiMeasurement(JSON.parse(readFileSync(destination, "utf8")));
      if (!isSameProtocolApiSourceSnapshot(existing, incoming)) {
        throw githubError("Conflicting mechanism artifact", `${path} exists with different source content or derivation.`);
      }
      // Preserve immutable first-capture metadata already present in the PR.
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

function inspectBranchState(
  options: MechanismRefreshVerifierOptions,
  dependencies: MechanismRefreshVerifierDependencies,
): void {
  const cwd = dependencies.cwd ?? process.cwd();
  const run = dependencies.run ?? createCommandRunner(cwd);
  const repository = dependencies.repository ?? process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  const branch = `automated/protocol-api-mechanism-refresh/${options.asset}`;

  requireSuccess(run("git", ["fetch", "origin", "main:refs/remotes/origin/main"]), "Main branch fetch");
  const historyText = requireSuccess(
    run("gh", [
      "pr", "list", "--repo", repository, "--state", "all", "--base", "main", "--head", branch,
      "--limit", "100", "--json", "number,state,mergedAt",
    ]),
    "Mechanism refresh PR history lookup",
  );
  const history = JSON.parse(historyText) as Array<{ mergedAt: string | null; state: string }>;
  const openPrCount = history.filter((entry) => entry.state === "OPEN").length;
  const closedUnmergedCount = history.filter((entry) => entry.state === "CLOSED" && entry.mergedAt == null).length;
  const remoteStatus = run("git", ["ls-remote", "--exit-code", "--heads", "origin", branch]).status;

  if (remoteStatus === 2) {
    if (openPrCount !== 0) {
      throw githubError("Inconsistent mechanism refresh branch", `${branch} has an open PR but no remote branch.`);
    }
    if (closedUnmergedCount !== 0) {
      throw githubError(
        "Closed unmerged mechanism refresh",
        `${branch} has closed-unmerged PR history; refusing to recreate it.`,
      );
    }
    if (options.stage === "prepare-branch") {
      requireSuccess(
        run("git", ["update-ref", "-d", `refs/remotes/origin/${branch}`]),
        "Missing mechanism refresh tracking ref cleanup",
      );
      requireSuccess(run("git", ["checkout", "-B", branch, "origin/main"]), "Mechanism refresh branch checkout");
    }
    return;
  }
  if (remoteStatus !== 0) {
    throw githubError("Mechanism refresh branch lookup failed", `Could not inspect ${branch}.`);
  }
  if (openPrCount > 1) {
    throw githubError("Ambiguous mechanism refresh PR", `${branch} has ${openPrCount} open PRs.`);
  }
  if (openPrCount === 1) {
    if (options.stage === "prepare-branch") {
      requireSuccess(
        run("git", ["fetch", "origin", `${branch}:refs/remotes/origin/${branch}`]),
        "Mechanism refresh branch fetch",
      );
      requireSuccess(run("git", ["checkout", "-B", branch, `origin/${branch}`]), "Mechanism refresh branch checkout");
      requireSuccess(run("git", ["rebase", "origin/main"]), "Mechanism refresh branch rebase");
    }
    return;
  }
  if (closedUnmergedCount !== 0) {
    throw githubError(
      "Closed unmerged mechanism refresh",
      `${branch} has closed-unmerged PR history; refusing to recreate it.`,
    );
  }

  requireSuccess(
    run("git", ["fetch", "origin", `${branch}:refs/remotes/origin/${branch}`]),
    "Mechanism refresh branch fetch",
  );
  const ancestor = run("git", ["merge-base", "--is-ancestor", `origin/${branch}`, "origin/main"]);
  if (ancestor.status !== 0) {
    const mergedText = requireSuccess(
      run("gh", [
        "pr", "list", "--repo", repository, "--state", "merged", "--base", "main", "--head", branch,
        "--limit", "100", "--json", "headRefOid",
      ]),
      "Merged mechanism refresh PR lookup",
    );
    const mergedPrs = JSON.parse(mergedText) as Array<{ headRefOid: string }>;
    const branchHead = requireSuccess(
      run("git", ["rev-parse", `origin/${branch}`]),
      "Mechanism refresh branch head lookup",
    ).trim();
    // A historical merge of the same branch name cannot authorize deleting
    // later, unreviewed commits. Match the current tip to the merged PR head.
    if (ancestor.status === 1 && mergedPrs.some((entry) => entry.headRefOid === branchHead)) {
      requireSuccess(
        run("gh", ["api", "--method", "DELETE", `repos/${repository}/git/refs/heads/${branch}`]),
        "Merged mechanism refresh branch deletion",
      );
      // The next force-with-lease push must expect a missing remote branch,
      // not the now-deleted tip left in this checkout's remote-tracking ref.
      requireSuccess(
        run("git", ["update-ref", "-d", `refs/remotes/origin/${branch}`]),
        "Merged mechanism refresh tracking ref cleanup",
      );
      if (options.stage === "prepare-branch") {
        requireSuccess(run("git", ["checkout", "-B", branch, "origin/main"]), "Mechanism refresh branch checkout");
      }
      return;
    }
    throw githubError(
      "Unowned mechanism refresh history",
      `${branch} has unmerged commits but no open PR; refusing to overwrite it.`,
    );
  }
  if (options.stage === "prepare-branch") {
    requireSuccess(run("git", ["checkout", "-B", branch, "origin/main"]), "Mechanism refresh branch checkout");
  }
}

export function verifyMechanismRefresh(
  options: MechanismRefreshVerifierOptions,
  dependencies: MechanismRefreshVerifierDependencies = {},
): void {
  if (options.stage === "restore-artifacts") {
    if (!options.artifactsDir) throw new Error("--artifacts-dir is required for restore-artifacts");
    restoreMechanismRefreshArtifacts(options.asset, options.artifactsDir, dependencies.cwd);
    return;
  }
  if (options.stage === "verify-diff") {
    verifyAppendOnlyMechanismRefreshDiff(options.asset, dependencies);
    return;
  }
  inspectBranchState(options, dependencies);
}

export function runMechanismRefreshVerifierCli(argv: readonly string[] = process.argv.slice(2)): void {
  const options = parseMechanismRefreshVerifierArgs(argv);
  if (options.help) {
    writeCliHelpIfRequested(options, USAGE);
    return;
  }
  verifyMechanismRefresh(options);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runMechanismRefreshVerifierCli(), { usage: USAGE });
}

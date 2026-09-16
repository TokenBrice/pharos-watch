#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { assertCliUsage, parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const USAGE = `Usage: node --import tsx scripts/ci/verify-mechanism-refresh-diff.ts \\
  --asset <id> --stage <validate-branch|prepare-branch|verify-diff>

Validates ownership of an automated protocol API refresh branch, prepares that
branch when requested, or verifies that its pull-request diff is append-only.`;

type VerificationStage = "validate-branch" | "prepare-branch" | "verify-diff";

interface CommandResult {
  status: number;
  stdout: string;
}

export interface MechanismRefreshVerifierOptions {
  asset: string;
  stage: VerificationStage;
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
    },
  });
  if (values.help === true) return { help: true };
  assertCliUsage(typeof values.asset === "string" && values.asset.length > 0, "--asset is required");
  assertCliUsage(
    values.stage === "validate-branch" || values.stage === "prepare-branch" || values.stage === "verify-diff",
    "--stage must be validate-branch, prepare-branch, or verify-diff",
  );
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

  requireSuccess(
    run("git", ["fetch", "origin", `${branch}:refs/remotes/origin/${branch}`]),
    "Mechanism refresh branch fetch",
  );
  const ancestor = run("git", ["merge-base", "--is-ancestor", `origin/${branch}`, "origin/main"]);
  if (ancestor.status !== 0) {
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
  if (options.stage === "verify-diff") {
    verifyAppendOnlyMechanismRefreshDiff(options.asset, dependencies);
    return;
  }
  inspectBranchState(options, dependencies);
}

export function runMechanismRefreshVerifierCli(argv: readonly string[] = process.argv.slice(2)): void {
  const options = parseMechanismRefreshVerifierArgs(argv);
  if (writeCliHelpIfRequested(options, USAGE)) return;
  verifyMechanismRefresh(options);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runMechanismRefreshVerifierCli(), { usage: USAGE });
}

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  assertCliUsage,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

const USAGE = `Usage: node --import tsx scripts/ci/open-automated-refresh-pr.ts \\
  --branch <branch> --path <pathspec> [--path <pathspec> ...] \\
  --title <title> --body <body> [--auto-merge]

Creates a commit from the requested paths, updates the automation branch with
force-with-lease, and creates a PR when that branch has no open PR.

Required environment:
  AUTOMATION_GITHUB_TOKEN  Bot or PAT token used for git and GitHub CLI auth

Options:
  --branch <branch>  Automation branch to reset and update
  --path <pathspec>  Git pathspec to commit; repeat for multiple pathspecs
  --title <title>    Commit message and PR title
  --body <body>      PR body
  --auto-merge       Queue a newly created PR for squash auto-merge
  -h, --help         Show this help`;

export interface AutomatedRefreshPrOptions {
  autoMerge: boolean;
  body: string;
  branch: string;
  paths: string[];
  title: string;
}

interface CommandOptions {
  capture?: boolean;
  env?: NodeJS.ProcessEnv;
}

type CommandExecutor = (
  file: string,
  args: readonly string[],
  options?: CommandOptions,
) => string;

interface AutomatedRefreshPrDependencies {
  automationToken?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  exec?: CommandExecutor;
  log?: (message: string) => void;
}

function createCommandExecutor(cwd: string, baseEnv: NodeJS.ProcessEnv): CommandExecutor {
  return (file, args, { capture = false, env = baseEnv } = {}) => {
    const output = execFileSync(file, [...args], {
      cwd,
      encoding: "utf8",
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    return typeof output === "string" ? output : "";
  };
}

export function parseAutomatedRefreshPrArgs(argv: readonly string[]): AutomatedRefreshPrOptions & { help: boolean } {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      "auto-merge": { type: "boolean" },
      body: { type: "string" },
      branch: { type: "string" },
      path: { type: "string", multiple: true },
      title: { type: "string" },
    },
  });

  if (values.help === true) {
    return { autoMerge: false, body: "", branch: "", help: true, paths: [], title: "" };
  }

  assertCliUsage(typeof values.branch === "string", "--branch is required");
  assertCliUsage(Array.isArray(values.path) && values.path.length > 0, "at least one --path is required");
  assertCliUsage(typeof values.title === "string", "--title is required");
  assertCliUsage(typeof values.body === "string", "--body is required");

  return {
    autoMerge: values["auto-merge"] === true,
    body: values.body,
    branch: values.branch,
    help: false,
    paths: values.path as string[],
    title: values.title,
  };
}

export function openAutomatedRefreshPr(
  options: AutomatedRefreshPrOptions,
  dependencies: AutomatedRefreshPrDependencies = {},
): "created" | "updated" {
  const env = dependencies.env ?? process.env;
  const automationToken = dependencies.automationToken ?? env.AUTOMATION_GITHUB_TOKEN;
  if (!automationToken?.trim()) {
    throw new Error(
      "AUTOMATION_GITHUB_TOKEN is required and must be a bot or PAT token so automated refresh PRs trigger normal pull_request checks.",
    );
  }

  const cwd = dependencies.cwd ?? process.cwd();
  const exec = dependencies.exec ?? createCommandExecutor(cwd, env);
  const log = dependencies.log ?? console.log;
  const githubEnv: NodeJS.ProcessEnv = { ...env, GH_TOKEN: automationToken };
  delete githubEnv.GITHUB_TOKEN;

  exec("git", ["config", "user.name", BOT_NAME]);
  exec("git", ["config", "user.email", BOT_EMAIL]);
  exec("git", ["checkout", "-B", options.branch]);
  exec("git", ["add", "--", ...options.paths]);
  exec("git", ["commit", "-m", options.title]);
  exec("gh", ["auth", "setup-git"], { env: githubEnv });
  exec("git", ["push", "--force-with-lease", "-u", "origin", options.branch], { env: githubEnv });

  let openPr = false;
  try {
    const state = exec("gh", ["pr", "view", options.branch, "--json", "state", "--jq", ".state"], {
      capture: true,
      env: githubEnv,
    });
    openPr = state.trim() === "OPEN";
  } catch {
    openPr = false;
  }

  if (openPr) {
    log(`Existing open PR for ${options.branch} updated by force-push.`);
    return "updated";
  }

  exec("gh", [
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    options.branch,
    "--title",
    options.title,
    "--body",
    options.body,
  ], { env: githubEnv });

  if (options.autoMerge) {
    exec("gh", ["pr", "merge", options.branch, "--squash", "--auto"], { env: githubEnv });
  }

  return "created";
}

export function runAutomatedRefreshPrCli(argv: readonly string[] = process.argv.slice(2)): void {
  const options = parseAutomatedRefreshPrArgs(argv);
  if (writeCliHelpIfRequested(options, USAGE)) return;
  openAutomatedRefreshPr(options);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runAutomatedRefreshPrCli(), {
    label: "automated-refresh-pr",
    usage: USAGE,
  });
}

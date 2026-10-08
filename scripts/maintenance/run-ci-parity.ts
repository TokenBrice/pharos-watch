#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseStrictCliArgs, runDirectCli } from "../lib/cli-args.mjs";
import { assertPinnedRuntime, readRuntimeVersions, type RuntimeVersions } from "../lib/runtime-guard.mts";
import { computeReceiptOutcome, firstActionableError, readPrCheckReceipt, writePrCheckReceipt, type PrCheckReceipt, type PrCheckReceiptLeaf } from "../lib/pr-check-receipt.mts";
import { collectChangedFiles } from "../lib/changed-files.mts";
import { classifyChangedFiles } from "../ci/classify-deploy-changes.ts";
import { deriveBaseCriticalOwnership, collectOwningTests } from "../lib/critical-ownership.mts";
import { CRITICAL_FILES, CRITICAL_OWNERSHIP } from "../lib/critical-coverage.mjs";
import { getPrLane, buildPrLaneCommandArgs } from "../lib/pr-lanes.mts";
import { PR_TEST_PLAN_PATH, readPrTestPlan, type PrTestPlan } from "../lib/pr-test-plan.mts";
import { buildPrStaticCheckPlan } from "./run-pr-static-checks.ts";
import { runLocalTrustedGitleaks } from "../ci/run-gitleaks.ts";

const RESULT_PATH = ".tmp/ci-parity-result.json";
const SHA = /^[a-f0-9]{40}$/;
export const CI_PARITY_LIMITATIONS = "Production-only exclusions: live refresh/current providers, remote migrations/deploys, Cloudflare account state, production upload/UUID/markers, and live health. GitHub artifact transport and hosted-runner OS are not reproduced; strict remote protection remains authoritative.";

export interface ParityCommand {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
export interface ParityCommandResult { status: number; output?: string }
export type ParityCommandRunner = (command: ParityCommand) => Promise<ParityCommandResult>;

// Keep only workstation tool/cache settings, not application credentials or
// selection overrides. The independent checkout never reads author .env files.
export function parityEnvironment(env: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "npm_config_cache", "NPM_CONFIG_CACHE", "PLAYWRIGHT_BROWSERS_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  const clean: NodeJS.ProcessEnv = { NODE_ENV: "development" };
  for (const name of allowed) if (env[name] !== undefined) clean[name] = env[name];
  return { ...clean, CI: "true", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

export const runParityCommand: ParityCommandRunner = (command) => {
  const { promise, resolve: resolveResult } = Promise.withResolvers<ParityCommandResult>();
  let output = "";
  const child = spawn(command.executable, command.args, {
    cwd: command.cwd, env: command.env, stdio: ["ignore", "pipe", "pipe"], timeout: command.timeoutMs,
  });
  const collect = (chunk: Buffer) => {
    process.stdout.write(chunk);
    output = (output + chunk.toString()).slice(-128 * 1024);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (error) => resolveResult({ status: 1, output: error.message }));
  child.on("close", (status, signal) => resolveResult({ status: status ?? 1, output: output || (signal ? `Terminated by ${signal}` : "") }));
  return promise;
};

export function printCiParityPlan(log: (message: string) => void): void {
  log("[check:pr --ci-parity] OPT-IN PLAN ONLY; no checks, fetch, clone, install, or receipt write.");
  for (const step of [
    "Guard pinned Node/npm; refuse dirty tracked files; fetch origin/main (unless --no-fetch, which is incomplete); freeze latest main and committed branch HEAD.",
    "Clone full needed history independently under os.tmpdir() with git clone --no-local --no-checkout; never use git worktree or copy ignored/.env files.",
    "Detach at base, merge branch HEAD without committing, fail merge-conflict, commit the merge tree with fixed identity; record base/head/merge SHA/tree separately.",
    "Run clean npm ci using the npm cache, bootstrap:generated and bootstrap:generated:history, and setup-workspace's tracked-output immutability assertion.",
    "Check ripgrep; install Playwright Firefox only for selected OG checks (installation/system prerequisites must succeed).",
    "Run trusted-base branch-range and tested-merge-resolution secret scans, plus candidate-policy validation.",
    "Classify frozen base/branch HEAD, serialize the test plan on the merge checkout, and execute all static/docs owners.",
    "Execute every explicit plain-test partition with CI's four/eight-shard rule, serialized to bound memory; no unsharded replacement.",
    "Execute selected critical-coverage shards, merge/completeness/touched ratchet with frozen refs, and the selected representative Pages artifact lane.",
    "Aggregate every leaf into the author's .tmp/pr-check-receipts/<headSha>.json; remove the clone in finally unless --keep-clone (print retained path).",
  ]) log(`[ci-parity] ${step}`);
  log(`[ci-parity] ${CI_PARITY_LIMITATIONS}`);
  log("[ci-parity] Accepts --base=<latest-main-sha>, --head=<checked-out-head-sha>, --no-fetch, --keep-clone, --plan. Skip/filter/weaker flags are rejected. Plans are not readiness proof; target-main advances require revalidation.");
}

interface ParityOptions {
  repoRoot?: string;
  env?: Partial<NodeJS.ProcessEnv>;
  runCommand?: ParityCommandRunner;
  runtimeVersions?: () => RuntimeVersions;
  makeTemporaryRoot?: () => string;
  removeTemporaryRoot?: (path: string) => void;
  readChildReceipt?: (path: string) => PrCheckReceipt;
  writeReceipt?: typeof writePrCheckReceipt;
  log?: (message: string) => void;
  now?: () => number;
}

export async function runCiParity(argv: readonly string[], {
  repoRoot = process.cwd(), env = process.env, runCommand = runParityCommand,
  runtimeVersions = readRuntimeVersions, makeTemporaryRoot = () => mkdtempSync(join(tmpdir(), "pharos-ci-parity-")),
  removeTemporaryRoot = (path) => rmSync(path, { recursive: true, force: true }),
  readChildReceipt = readPrCheckReceipt, writeReceipt = writePrCheckReceipt,
  log = console.log, now = Date.now,
}: ParityOptions = {}): Promise<number> {
  const { values } = parseStrictCliArgs(argv, { options: {
    "ci-parity": { type: "boolean" }, base: { type: "string" }, head: { type: "string" },
    "no-fetch": { type: "boolean" }, "keep-clone": { type: "boolean" }, plan: { type: "boolean" },
  } });
  if (values.help) { printCiParityPlan(log); return 0; }
  const runtime = runtimeVersions();
  assertPinnedRuntime(runtime, repoRoot);
  if (values.plan) { printCiParityPlan(log); return 0; }
  const startedAt = now();
  const childEnv = parityEnvironment(env);
  const noFetch = values["no-fetch"] === true;
  const leaves: PrCheckReceiptLeaf[] = [];
  let temporaryRoot: string | undefined;
  let baseSha = "";
  let headSha = "";
  let mergeSha: string | undefined;
  let mergeTree: string | undefined;
  let treeClean = false;
  let weakened = noFetch;
  let stage = "resolve-head";
  const run = async (id: string, executable: string, args: string[], cwd = repoRoot, extraEnv: Partial<NodeJS.ProcessEnv> = {}) => {
    stage = id;
    const start = now();
    let result: ParityCommandResult;
    try { result = await runCommand({ id, executable, args, cwd, env: { ...childEnv, ...extraEnv } }); }
    catch (error) { result = { status: 1, output: error instanceof Error ? error.message : String(error) }; }
    leaves.push({ id, command: [executable, ...args].join(" "), durationMs: now() - start,
      status: result.status === 0 ? "passed" : "failed",
      ...(result.status ? { firstError: firstActionableError(result.output, `${id} failed`) } : {}),
    });
    if (result.status !== 0) throw new Error(`${id === "merge" ? "merge-conflict" : id}: ${firstActionableError(result.output, "command failed")}`);
    return result.output?.trim() ?? "";
  };
  const commitRef = async (id: string, ref: string, cwd = repoRoot) => {
    const sha = await run(id, "git", ["rev-parse", "--verify", `${ref}^{commit}`], cwd);
    if (!SHA.test(sha)) throw new Error(`${id}: expected a full commit SHA`);
    return sha;
  };
  try {
    headSha = await commitRef("resolve-head", "HEAD");
    if (values.head && values.head !== headSha) throw new Error("head-mismatch: --head must equal committed checkout HEAD");
    treeClean = (await run("tracked-state", "git", ["status", "--porcelain", "--untracked-files=no"])).length === 0;
    if (!treeClean) throw new Error("dirty-tree: commit or stash tracked changes before parity; only committed HEAD is tested");
    if ((await run("history", "git", ["rev-parse", "--is-shallow-repository"])) !== "false") {
      throw new Error("shallow-history: full Git history is required; fetch complete history before parity");
    }
    if (!noFetch) await run("fetch", "git", ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    baseSha = await commitRef("resolve-base", "refs/remotes/origin/main");
    if (values.base && values.base !== baseSha) throw new Error("stale-base: --base must equal the latest resolved origin/main SHA");
    temporaryRoot = makeTemporaryRoot();
    const clone = join(temporaryRoot, "repo");
    await run("clone", "git", ["clone", "--no-local", "--no-checkout", repoRoot, clone]);
    // A newly fetched remote-tracking target need not be advertised as a local
    // branch by clone. Transfer both frozen refs, never ambient ignored bytes.
    await run("clone-refs", "git", ["fetch", "--no-tags", repoRoot, `${baseSha}:refs/pharos/ci-parity/base`, `${headSha}:refs/pharos/ci-parity/head`], clone);
    await run("detach-base", "git", ["checkout", "--detach", baseSha], clone);
    const identity = { GIT_AUTHOR_NAME: "Pharos CI parity", GIT_AUTHOR_EMAIL: "ci-parity@pharos.invalid", GIT_COMMITTER_NAME: "Pharos CI parity", GIT_COMMITTER_EMAIL: "ci-parity@pharos.invalid", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
    await run("merge", "git", ["-c", "core.hooksPath=/dev/null", "merge", "--no-ff", "--no-commit", headSha], clone, identity);
    mergeTree = await run("merge-tree", "git", ["write-tree"], clone);
    if (!SHA.test(mergeTree)) throw new Error("merge-tree: expected a full tree SHA");
    mergeSha = await run("merge-commit", "git", ["-c", "commit.gpgSign=false", "commit-tree", mergeTree, "-p", baseSha, ...(headSha === baseSha ? [] : ["-p", headSha]), "-m", "Pharos local CI parity merge"], clone, identity);
    if (!SHA.test(mergeSha)) throw new Error("merge-commit: expected a full commit SHA");
    await run("detach-merge", "git", ["checkout", "--detach", mergeSha], clone);
    log(`[ci-parity] base=${baseSha} branch-head=${headSha} merge=${mergeSha} tree=${mergeTree}`);
    await run("npm-ci", "npm", ["ci"], clone);
    await run("bootstrap-generated", "npm", ["run", "bootstrap:generated"], clone);
    await run("bootstrap-history", "npm", ["run", "bootstrap:generated:history"], clone);
    await run("bootstrap-immutability", "node", ["--input-type=module", "-e", 'import { assertBootstrapTrackedOutputsUnchanged } from "./scripts/lib/bootstrap-tracked-outputs.mts"; assertBootstrapTrackedOutputsUnchanged();'], clone);
    stage = "readiness-pipeline";
    const child = await runCommand({ id: stage, executable: "node", args: ["--import", "tsx", "scripts/maintenance/run-ci-parity.ts", "--execute-clone"], cwd: clone,
      env: { ...childEnv, PR_BASE_SHA: baseSha, PR_HEAD_SHA: headSha, PHAROS_PARITY_MERGE_SHA: mergeSha } });
    const receipt = readChildReceipt(resolve(clone, RESULT_PATH));
    if (receipt.baseSha !== baseSha || receipt.headSha !== headSha || receipt.mergeSha !== mergeSha || receipt.mergeTree !== mergeTree) {
      throw new Error("receipt-identity: child receipt does not describe the frozen merge");
    }
    leaves.push(...receipt.leaves);
    weakened ||= receipt.outcome === "incomplete" || receipt.weakened;
    if (child.status !== 0 && !receipt.leaves.some((leaf) => leaf.status === "failed")) {
      throw new Error("readiness-pipeline: failed without a failed leaf");
    }
  } catch (error) {
    const firstError = error instanceof Error ? error.message : String(error);
    log(`[ci-parity] ${firstError}`);
    leaves.push({ id: stage, command: "ci-parity setup/receipt", durationMs: 0, status: "failed", firstError });
  } finally {
    if (temporaryRoot) {
      if (values["keep-clone"]) log(`[ci-parity] Kept independent clone: ${join(temporaryRoot, "repo")}`);
      else {
        try { removeTemporaryRoot(temporaryRoot); }
        catch (error) { leaves.push({ id: "cleanup", command: "remove temporary clone", status: "failed", durationMs: 0, firstError: String(error) }); }
      }
    }
    log(`[ci-parity] ${CI_PARITY_LIMITATIONS}`);
    const outcome = computeReceiptOutcome(leaves, weakened);
    if (SHA.test(headSha)) writeReceipt({ schemaVersion: 1, ...runtime, mode: "ci-parity", baseSha, headSha, mergeSha, mergeTree, treeClean,
      flags: { "ci-parity": true, noFetch, keepClone: values["keep-clone"] === true, executionProfile: "serialized-ci-partitions" }, weakened,
      startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(now()).toISOString(), leaves, outcome,
    }, repoRoot);
    log(`[ci-parity] Outcome: ${outcome}${outcome === "incomplete" ? " (--no-fetch or missing proof; not readiness proof)" : ""}`);
  }
  return computeReceiptOutcome(leaves, weakened) === "failed" ? 1 : 0;
}

interface CloneOptions {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  runCommand?: ParityCommandRunner;
  runSecrets?: typeof runLocalTrustedGitleaks;
  changedFiles?: string[];
  readPlan?: (path: string) => PrTestPlan;
  log?: (message: string) => void;
  runtimeVersions?: () => RuntimeVersions;
  classifyFiles?: typeof classifyChangedFiles;
}

/** Same readiness owners as plain check:pr, but on a merge checkout with the
 * manifest's explicit CI partitions. Selection refs never become merge refs. */
export async function runCiParityClone({ env = process.env, repoRoot = process.cwd(), runCommand = runParityCommand,
  runSecrets = runLocalTrustedGitleaks, changedFiles, readPlan = readPrTestPlan, log = console.log, runtimeVersions = readRuntimeVersions,
  classifyFiles = (files) => classifyChangedFiles(files, { baseOwnership: deriveBaseCriticalOwnership(env.PR_BASE_SHA!, files) }),
}: CloneOptions = {}): Promise<PrCheckReceipt> {
  const baseSha = env.PR_BASE_SHA ?? "";
  const headSha = env.PR_HEAD_SHA ?? "";
  const mergeSha = env.PHAROS_PARITY_MERGE_SHA ?? "";
  if (![baseSha, headSha, mergeSha].every((sha) => SHA.test(sha))) throw new Error("Frozen base, branch head and tested merge SHAs are required.");
  const startedAt = Date.now();
  const leaves: PrCheckReceiptLeaf[] = [];
  let mergeTree = "";
  const execute = async (id: string, executable: string, args: string[], timeoutMinutes = 15) => {
    const start = Date.now();
    let result: ParityCommandResult;
    try { result = await runCommand({ id, executable, args, cwd: repoRoot, env, timeoutMs: timeoutMinutes * 60_000 }); }
    catch (error) { result = { status: 1, output: String(error) }; }
    leaves.push({ id, command: [executable, ...args].join(" "), status: result.status === 0 ? "passed" : "failed", durationMs: Date.now() - start,
      ...(result.status ? { firstError: firstActionableError(result.output, `${id} failed`) } : {}),
    });
    return result;
  };
  try {
    const identity = await execute("tested-tree", "git", ["rev-parse", "HEAD", "HEAD^{tree}"]);
    const [testedSha, tree] = identity.output?.trim().split(/\r?\n/) ?? [];
    if (identity.status !== 0 || testedSha !== mergeSha || typeof tree !== "string" || !SHA.test(tree)) throw new Error("Test checkout does not match frozen merge identity");
    mergeTree = tree;
    const files = changedFiles ?? collectChangedFiles({ base: baseSha, head: headSha, cwd: repoRoot });
    const classification = classifyFiles(files);
    env = { ...env, DEPLOY_BASE_SHA: baseSha, DEPLOY_HEAD_SHA: headSha, DEPLOY_EVENT_NAME: "push" };
    const code = !classification.docsOnly;
    let plan: PrTestPlan | undefined;
    if (code) {
      const selected = await execute("test-plan", "npm", ["run", "test:pr", "--", `--base=${baseSha}`, `--plan-out=${PR_TEST_PLAN_PATH}`]);
      if (selected.status === 0) plan = readPlan(resolve(repoRoot, PR_TEST_PLAN_PATH));
    }
    const rg = await execute("prerequisite:ripgrep", "rg", ["--version"]);
    if (rg.status !== 0) throw new Error("prerequisite:ripgrep: install rg on PATH before parity");
    if (classification.playwrightFirefoxRequired) {
      const firefox = await execute("prerequisite:firefox", "npx", ["--no-install", "playwright", "install", "--with-deps", "firefox"]);
      if (firefox.status !== 0) throw new Error("prerequisite:firefox: selected OG checks require Playwright Firefox and system dependencies");
    }
    const secretStart = Date.now();
    try {
      const scan = await runSecrets({ baseSha, headSha, mergeSha, repoRoot });
      leaves.push({ id: "gitleaks", command: "trusted-base range/merge-resolution + candidate policy", status: scan.exitCode === 0 ? "passed" : "failed", durationMs: Date.now() - secretStart,
        ...(scan.exitCode ? { firstError: scan.summary } : {}) });
    } catch { leaves.push({ id: "gitleaks", command: "trusted-base range/merge-resolution + candidate policy", status: "failed", durationMs: Date.now() - secretStart, firstError: "Trusted secret scan failed during setup" }); }
    await execute("classifier-smoke", "node", ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/ci/classify-deploy-changes.ts"]);
    for (const lane of [getPrLane("static-compile"), getPrLane("static-guards")]) {
      if (!code) continue;
      const group = lane.id === "static-compile" ? "compile" : "guards";
      for (const command of buildPrStaticCheckPlan(files, { group, skipDocSync: classification.docsChanged }).commands) {
        const args = command.name === "lint:changed" ? [`--base=${baseSha}`, `--head=${headSha}`] : command.args ?? [];
        await execute(`${lane.id}:${command.name}`, "npm", ["run", command.name, ...(args.length ? ["--", ...args] : [])], lane.timeoutMinutes);
      }
    }
    const docs = getPrLane("docs");
    for (const command of docs.commands) {
      if (classification.docsChanged) await execute(command.id, command.program, [...command.args], docs.timeoutMinutes);
      else leaves.push({ id: command.id, command: [command.program, ...command.args].join(" "), status: "not-selected", durationMs: 0 });
    }
    const tests = getPrLane("tests");
    if (plan) {
      if (plan.base !== baseSha) throw new Error("Serialized test plan has the wrong frozen base");
      env = { ...env, PR_TEST_PLAN_FILE: PR_TEST_PLAN_PATH };
      for (let shard = 1; shard <= plan.shardCount; shard++) {
        const command = tests.commands[0];
        await execute(`pr-tests:${shard}/${plan.shardCount}`, command.program, buildPrLaneCommandArgs(command, { base: baseSha, shard, shardCount: plan.shardCount }), tests.timeoutMinutes);
      }
    } else if (!code) leaves.push({ id: "pr-tests", command: "explicit CI test partitions", status: "not-selected", durationMs: 0 });
    const coverage = getPrLane("critical-coverage-shards");
    if (classification.criticalCoverageChanged) {
      const shardCount = Math.max(1, Math.min(coverage.shards!, collectOwningTests(CRITICAL_FILES, CRITICAL_OWNERSHIP).length));
      env = { ...env, CRITICAL_COVERAGE_COMPARE_REF: baseSha };
      for (let shard = 1; shard <= shardCount; shard++) {
        const command = coverage.commands[0];
        await execute(`critical-coverage:${shard}/${shardCount}`, command.program, buildPrLaneCommandArgs(command, { shard, shardCount }), coverage.timeoutMinutes);
      }
      const merge = getPrLane("critical-coverage").commands.find((command) => command.id === "critical-coverage-merge")!;
      await execute(merge.id, merge.program, [...merge.args], getPrLane("critical-coverage").timeoutMinutes);
    } else leaves.push({ id: "critical-coverage", command: "coverage shards + completeness/ratchet merge", status: "not-selected", durationMs: 0 });
    const pages = getPrLane("pages-artifact");
    if (classification.pagesArtifactRequired) {
      for (const command of pages.commands) await execute(command.id, command.program, [...command.args], pages.timeoutMinutes);
    } else leaves.push({ id: "pages-artifact", command: "npm run check:pages-artifact", status: "not-selected", durationMs: 0 });
  } catch (error) {
    leaves.push({ id: "clone-setup", command: "ci-parity clone prerequisites/selection", status: "failed", durationMs: 0, firstError: error instanceof Error ? error.message : String(error) });
  }
  for (const leaf of leaves) log(`[ci-parity] ${leaf.status} | ${leaf.durationMs}ms | ${leaf.id}${leaf.firstError ? ` | ${leaf.firstError}` : ""}`);
  return { schemaVersion: 1, ...runtimeVersions(), mode: "ci-parity", baseSha, headSha, mergeSha, mergeTree, treeClean: true,
    flags: { "ci-parity": true, executionProfile: "serialized-ci-partitions" }, weakened: false,
    startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), leaves, outcome: computeReceiptOutcome(leaves, false) };
}

runDirectCli(import.meta.url, async () => {
  if (process.argv.slice(2).includes("--execute-clone")) {
    parseStrictCliArgs(process.argv.slice(2), { options: { "execute-clone": { type: "boolean" } } });
    const receipt = await runCiParityClone();
    mkdirSync(resolve(".tmp"), { recursive: true });
    writeFileSync(resolve(RESULT_PATH), `${JSON.stringify(receipt, null, 2)}\n`);
    process.exitCode = receipt.outcome === "failed" ? 1 : 0;
  } else process.exitCode = await runCiParity(process.argv.slice(2));
});

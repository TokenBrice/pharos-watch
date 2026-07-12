import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RECEIPT_PATH = resolve(REPO_ROOT, ".cache/merge-gate/receipt.json");
const RECEIPT_SCHEMA_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const IMPLEMENTATION_PATHS = [
  "scripts/maintenance/test-merge-gate.mjs",
  "scripts/lib/automation-registry.mjs",
  "scripts/lib/deploy-impact.mjs",
  "scripts/lib/telegram-load-guard.mjs",
  "scripts/lib/validation-lanes.mjs",
];

const PROFILE_ENV_PATTERN = /^(?:NEXT_PUBLIC_|SMOKE_|STATIC_EXPORT_|PUBLIC_DATASETS_|API_BASE_URL$)/;

const PROFILE_DEFAULTS = {
  MERGE_GATE_NATIVE_ENV: "0",
  MERGE_GATE_PAGES_SMOKE: "1",
  MERGE_GATE_PRODUCTION_ENV: "0",
  MERGE_GATE_WORKER_SMOKE: "0",
};

/**
 * @typedef {object} MergeGateIdentityOptions
 * @property {string} [baseRef]
 * @property {Record<string, string | undefined>} [env]
 * @property {typeof execFileSync} [execFile]
 * @property {boolean} [fullDeploy]
 * @property {string} [headRef]
 * @property {string} [nodeVersion]
 * @property {string} [repoRoot]
 */

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(path) {
  return existsSync(path) ? sha256(readFileSync(path)) : "missing";
}

function hashFiles(repoRoot, paths) {
  return sha256(paths.map((path) => `${path}:${hashFile(resolve(repoRoot, path))}`).join("\n"));
}

function runGit(args, { execFile = execFileSync, repoRoot = REPO_ROOT } = {}) {
  return String(execFile("git", args, { cwd: repoRoot, encoding: "utf8" })).trim();
}

function resolveCommit(ref, options) {
  return runGit(["rev-parse", "--verify", `${ref}^{commit}`], options);
}

function getWorktreeStatus(options) {
  return runGit(["status", "--porcelain=v1", "--untracked-files=all"], options);
}

function getOriginFingerprint(options) {
  try {
    return sha256(runGit(["remote", "get-url", "origin"], options));
  } catch {
    return "no-origin";
  }
}

function getNodeMajor(nodeVersion = process.versions.node) {
  return Number.parseInt(String(nodeVersion).split(".")[0] ?? "", 10);
}

export function getMergeGateProfileHash(env = process.env) {
  const profile = {
    ...PROFILE_DEFAULTS,
    ...Object.fromEntries(
      Object.keys(env)
        .filter((key) => PROFILE_ENV_PATTERN.test(key) && env[key] !== undefined)
        .sort()
        .map((key) => [key, env[key]]),
    ),
  };
  for (const key of Object.keys(PROFILE_DEFAULTS)) {
    if (env[key] !== undefined) profile[key] = env[key];
  }
  return sha256(JSON.stringify(profile));
}

/** @param {MergeGateIdentityOptions} [options] */
export function buildMergeGateReceiptIdentity({
  baseRef = "origin/main",
  env = process.env,
  execFile = execFileSync,
  fullDeploy = false,
  headRef = "HEAD",
  nodeVersion = process.versions.node,
  repoRoot = REPO_ROOT,
} = {}) {
  const gitOptions = { execFile, repoRoot };
  return {
    baseCommit: fullDeploy ? "FULL_DEPLOY" : resolveCommit(baseRef, gitOptions),
    gateImplementationHash: hashFiles(repoRoot, IMPLEMENTATION_PATHS),
    headCommit: resolveCommit(headRef, gitOptions),
    lockfileHash: hashFile(resolve(repoRoot, "package-lock.json")),
    nodeMajor: getNodeMajor(nodeVersion),
    originHash: getOriginFingerprint(gitOptions),
    profileHash: getMergeGateProfileHash(env),
    schemaVersion: RECEIPT_SCHEMA_VERSION,
  };
}

/** @param {MergeGateIdentityOptions & { now?: number, receiptPath?: string }} [options] */
export function writeMergeGateReceipt({ now = Date.now(), receiptPath = RECEIPT_PATH, ...identityOptions } = {}) {
  const gitOptions = {
    execFile: identityOptions.execFile ?? execFileSync,
    repoRoot: identityOptions.repoRoot ?? REPO_ROOT,
  };
  if (getWorktreeStatus(gitOptions)) {
    return { written: false, reason: "worktree is not clean" };
  }

  const receipt = {
    ...buildMergeGateReceiptIdentity(identityOptions),
    createdAt: new Date(now).toISOString(),
  };
  mkdirSync(dirname(receiptPath), { recursive: true });
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(temporaryPath, receiptPath);
  return { written: true, receipt };
}

/** @param {MergeGateIdentityOptions & { maxAgeMs?: number, now?: number, receiptPath?: string }} [options] */
export function checkMergeGateReceipt({
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
  receiptPath = RECEIPT_PATH,
  ...identityOptions
} = {}) {
  if (!existsSync(receiptPath)) {
    return { valid: false, reason: "receipt is missing" };
  }

  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch {
    return { valid: false, reason: "receipt is unreadable" };
  }

  const gitOptions = {
    execFile: identityOptions.execFile ?? execFileSync,
    repoRoot: identityOptions.repoRoot ?? REPO_ROOT,
  };
  if (getWorktreeStatus(gitOptions)) {
    return { valid: false, reason: "worktree is not clean" };
  }

  const createdAt = Date.parse(receipt.createdAt ?? "");
  if (!Number.isFinite(createdAt) || now - createdAt < 0 || now - createdAt > maxAgeMs) {
    return { valid: false, reason: "receipt is expired" };
  }

  let expected;
  try {
    expected = buildMergeGateReceiptIdentity(identityOptions);
  } catch {
    return { valid: false, reason: "pushed refs could not be resolved" };
  }

  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key] !== value) {
      return { valid: false, reason: `${key} changed` };
    }
  }

  return { valid: true, reason: "validated committed state matches" };
}

export { RECEIPT_PATH };

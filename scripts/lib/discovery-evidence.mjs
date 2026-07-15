import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED_ARTIFACT_REGISTRY } from "./automation-registry.mjs";

const ZERO_SHA = /^0+$/;
const require = createRequire(import.meta.url);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeFileList(raw) {
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter(Boolean);
}

function gitOutput(execFile, args) {
  return execFile("git", args, { encoding: "utf8" });
}

/**
 * @param {{
 *   baseRef?: string,
 *   execFile: (file: string, args: string[], options: { encoding: "utf8" }) => string,
 *   forceFullDeploy?: boolean,
 *   headRef?: string,
 *   stagedMode?: boolean,
 * }} options
 */
export function collectDiscoveryChangedFiles({
  baseRef = "origin/main",
  execFile,
  forceFullDeploy = false,
  headRef = "HEAD",
  stagedMode = false,
}) {
  const sources = { committed: [], staged: [], untracked: [], worktree: [] };
  let fallbackFullDeploy = forceFullDeploy || !baseRef || ZERO_SHA.test(baseRef);
  if (stagedMode) {
    sources.staged = normalizeFileList(gitOutput(execFile, ["diff", "--name-only", "--cached"]));
  } else {
    if (baseRef && !ZERO_SHA.test(baseRef)) {
      try {
        sources.committed = normalizeFileList(
          gitOutput(execFile, ["diff", "--name-only", "--no-renames", `${baseRef}...${headRef}`]),
        );
      } catch {
        fallbackFullDeploy = true;
      }
    }
    sources.staged = normalizeFileList(gitOutput(execFile, ["diff", "--name-only", "--cached"]));
    sources.worktree = normalizeFileList(gitOutput(execFile, ["diff", "--name-only"]));
    sources.untracked = normalizeFileList(gitOutput(execFile, ["ls-files", "--others", "--exclude-standard"]));
  }

  return {
    fallbackFullDeploy,
    sources,
    union: [...new Set(Object.values(sources).flat())].sort(),
  };
}

function hashFile(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return `non-file:${stat.mode}:${stat.size}`;
    return sha256(readFileSync(path));
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    return `unreadable:${error?.code ?? "unknown"}`;
  }
}

export function captureDiscoverySnapshot({ execFile, files = [] } = {}) {
  let head = "unknown";
  let status = "";
  try {
    head = gitOutput(execFile, ["rev-parse", "HEAD"]).trim() || "unknown";
    status = gitOutput(execFile, ["status", "--porcelain=v1", "--untracked-files=all"]);
  } catch {
    // The command plan can still run, but the report cannot claim a stable snapshot.
  }
  const fileHashes = Object.fromEntries(files.map((file) => [file, hashFile(resolve(process.cwd(), file))]));
  const fingerprint = sha256(JSON.stringify({ fileHashes, head, status }));
  return {
    clean: status.trim().length === 0,
    fileHashes,
    fingerprint,
    head,
    statusHash: sha256(status),
  };
}

export function compareDiscoverySnapshots(start, end) {
  const paths = [...new Set([...Object.keys(start.fileHashes ?? {}), ...Object.keys(end.fileHashes ?? {})])];
  const changedPaths = paths.filter((path) => start.fileHashes?.[path] !== end.fileHashes?.[path]).sort();
  return {
    changedPaths,
    moved: start.fingerprint !== end.fingerprint,
  };
}

function fileSha(path) {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

function installedPackagesMatchLockfile(repoRoot) {
  const lockPath = resolve(repoRoot, "package-lock.json");
  const installPath = resolve(repoRoot, "node_modules/.package-lock.json");
  if (!existsSync(lockPath) || !existsSync(installPath)) return false;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const install = JSON.parse(readFileSync(installPath, "utf8"));
    return Object.entries(install.packages ?? {}).every(([path, installed]) => {
      if (!path.startsWith("node_modules/")) return true;
      const expected = lock.packages?.[path];
      return (
        expected &&
        expected.version === installed.version &&
        expected.resolved === installed.resolved &&
        expected.integrity === installed.integrity &&
        Boolean(expected.link) === Boolean(installed.link)
      );
    });
  } catch {
    return false;
  }
}

function browserAvailability() {
  try {
    const { chromium, firefox } = require("@playwright/test");
    return {
      chromium: existsSync(chromium.executablePath()),
      firefox: existsSync(firefox.executablePath()),
    };
  } catch {
    return { chromium: false, firefox: false };
  }
}

function publicConfig(env) {
  const entries = Object.keys(env)
    .filter((key) => key === "NEXT_PUBLIC_GA_ID" || key.startsWith("NEXT_PUBLIC_PHAROS_"))
    .sort()
    .map((key) => [key, env[key] ?? ""]);
  return {
    hash: sha256(JSON.stringify(entries)),
    keyCount: entries.length,
    profile: env.MERGE_GATE_PRODUCTION_ENV === "1" ? "production" : "offline",
  };
}

function bootstrapOutputPresence(repoRoot) {
  const paths = GENERATED_ARTIFACT_REGISTRY.filter((artifact) => artifact.bootstrap)
    .flatMap((artifact) => artifact.outputPaths)
    .filter((path) => !path.includes("*"));
  const missing = paths.filter((path) => !existsSync(resolve(repoRoot, path)));
  return { complete: missing.length === 0, missing, outputCount: paths.length };
}

export function collectDiscoveryEnvironment({ env = process.env, repoRoot = process.cwd() } = {}) {
  const expectedNode = readFileSync(resolve(repoRoot, ".nvmrc"), "utf8").trim().replace(/^v/, "");
  const actualNode = process.version.replace(/^v/, "");
  const lockfilePath = resolve(repoRoot, "package-lock.json");
  const installSnapshotPath = resolve(repoRoot, "node_modules/.package-lock.json");
  const installConsistent = installedPackagesMatchLockfile(repoRoot);
  const bootstrap = bootstrapOutputPresence(repoRoot);
  const environment = {
    architecture: arch(),
    browsers: browserAvailability(),
    bootstrap: {
      ...bootstrap,
      cleanInstallEquivalent: installConsistent && bootstrap.complete,
    },
    install: {
      consistentWithLockfile: installConsistent,
      lockfileSha256: fileSha(lockfilePath),
      snapshotSha256: fileSha(installSnapshotPath),
    },
    node: {
      actual: actualNode,
      exactMatch: actualNode === expectedNode,
      expected: expectedNode,
    },
    operatingSystem: platform(),
    publicConfig: publicConfig(env),
  };
  return {
    ...environment,
    fingerprint: sha256(JSON.stringify(environment)),
  };
}

export function hashDiscoveryValue(value) {
  return sha256(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}

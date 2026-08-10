#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { resolve } from "node:path";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

export const GITLEAKS_VERSION = "8.30.0";
export const GITLEAKS_LINUX_X64_TARBALL_SHA256 = "79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e";
const ZERO_SHA = /^0+$/;

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseOptions(argv, env) {
  const mode = argv.includes("--worktree") ? "worktree" : "range";
  const baseRef = env.GITLEAKS_BASE_REF ?? "origin/main";
  const headRef = env.GITLEAKS_HEAD_REF ?? "HEAD";
  return { baseRef, fullHistory: env.GITLEAKS_FULL_HISTORY === "1" || ZERO_SHA.test(baseRef), headRef, mode };
}

export function buildGitleaksWorktreeInput({ execFile = execFileSync } = {}) {
  const diff = execFile("git", ["diff", "--no-ext-diff", "--unified=0", "HEAD", "--"], { encoding: "utf8" });
  const addedLines = diff
    .split(/\r?\n/g)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  const untracked = execFile("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const chunks = [Buffer.from(`${addedLines.join("\n")}\n`)];
  for (const path of untracked) {
    try {
      chunks.push(Buffer.from(`\nFILE:${path}\n`), readFileSync(resolve(process.cwd(), path)), Buffer.from("\n"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return Buffer.concat(chunks);
}

export async function ensurePinnedGitleaks({
  cacheRoot = resolve(process.cwd(), ".cache/gitleaks"),
  fetchImpl = fetch,
  execFile = execFileSync,
} = {}) {
  if (platform() !== "linux" || arch() !== "x64") {
    throw new Error(`Pinned Gitleaks bootstrap supports linux/x64, received ${platform()}/${arch()}`);
  }

  const versionDir = resolve(cacheRoot, GITLEAKS_VERSION);
  const binaryPath = resolve(versionDir, "gitleaks");
  const markerPath = resolve(versionDir, "verified.json");
  if (existsSync(binaryPath) && existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      if (
        marker.tarballSha256 === GITLEAKS_LINUX_X64_TARBALL_SHA256 &&
        marker.binarySha256 === sha256File(binaryPath)
      ) {
        return binaryPath;
      }
    } catch {
      // Replace incomplete or unverified cache entries below.
    }
  }

  mkdirSync(versionDir, { recursive: true });
  const tempDir = resolve(versionDir, `.install-${process.pid}-${Date.now()}`);
  const tarballPath = resolve(tempDir, "gitleaks.tar.gz");
  mkdirSync(tempDir, { recursive: true });
  try {
    const url = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`;
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`download returned HTTP ${response.status}`);
    writeFileSync(tarballPath, Buffer.from(await response.arrayBuffer()));
    const actualSha = sha256File(tarballPath);
    if (actualSha !== GITLEAKS_LINUX_X64_TARBALL_SHA256) {
      throw new Error(`tarball checksum mismatch: expected ${GITLEAKS_LINUX_X64_TARBALL_SHA256}, received ${actualSha}`);
    }

    execFile("tar", ["-xzf", tarballPath, "-C", tempDir, "gitleaks"], { stdio: "ignore" });
    const extractedBinary = resolve(tempDir, "gitleaks");
    chmodSync(extractedBinary, 0o755);
    renameSync(extractedBinary, binaryPath);
    writeFileSync(
      markerPath,
      `${JSON.stringify(
        {
          binarySha256: sha256File(binaryPath),
          tarballSha256: GITLEAKS_LINUX_X64_TARBALL_SHA256,
          version: GITLEAKS_VERSION,
        },
        null,
        2,
      )}\n`,
    );
    return binaryPath;
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

/**
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   ensureBinary?: () => Promise<string>,
 *   buildWorktreeInput?: () => Buffer,
 *   runBinary?: (binary: string, args: string[], options: Record<string, unknown>) => { status?: number | null, error?: unknown },
 * }} [options]
 */
export async function runGitleaks({
  argv = process.argv.slice(2),
  buildWorktreeInput = buildGitleaksWorktreeInput,
  env = process.env,
  ensureBinary = ensurePinnedGitleaks,
  runBinary = spawnSync,
} = {}) {
  const options = parseOptions(argv, env);
  const binaryPath = await ensureBinary();
  const worktreeMode = options.mode === "worktree";
  const args = worktreeMode
    ? [
        "stdin",
        "--no-banner",
        "--redact",
        "--exit-code",
        "1",
        "--config=.gitleaks.toml",
        "--gitleaks-ignore-path=.gitleaksignore",
      ]
    : options.fullHistory
      ? ["git", "--no-banner", "--redact", "--verbose", "--exit-code", "1", "."]
      : [
          "git",
          "--no-banner",
          "--redact",
          "--verbose",
          "--exit-code",
          "1",
          `--log-opts=--no-merges ${options.baseRef}..${options.headRef}`,
          ".",
        ];
  const result = runBinary(binaryPath, args, {
    ...(worktreeMode ? { input: buildWorktreeInput() } : {}),
    stdio: worktreeMode ? ["pipe", "inherit", "inherit"] : "inherit",
  });
  return { status: result.status ?? (result.error ? 1 : 0) };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  try {
    const result = await runGitleaks();
    process.exitCode = result.status;
  } catch (error) {
    console.error(`[gitleaks] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

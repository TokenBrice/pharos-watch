#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isBuiltin } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const GITLEAKS_VERSION = "8.30.0";
const GITLEAKS_PINS = {
  "linux-x64": {
    assetSuffix: "linux_x64.tar.gz",
    sha256: "79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e",
  },
  "linux-arm64": {
    assetSuffix: "linux_arm64.tar.gz",
    sha256: "b4cbbb6ddf7d1b2a603088cd03a4e3f7ce48ee7fd449b51f7de6ee2906f5fa2f",
  },
  "darwin-arm64": {
    assetSuffix: "darwin_arm64.tar.gz",
    sha256: "b251ab2bcd4cd8ba9e56ff37698c033ebf38582b477d21ebd86586d927cf87e7",
  },
  "darwin-x64": {
    assetSuffix: "darwin_x64.tar.gz",
    sha256: "ca221d012d247080c2f6f61f4b7a83bffa2453806b0c195c795bbe9a8c775ed5",
  },
} as const;
const ZERO_SHA = /^0+$/;
const FALCON_SELF_TEST_PATH =
  "shared/data/safety-score-v9/mechanism-measurements/usdf-falcon/2099-01-01T00-00-00.000Z-a1b2c3d4e5f6-protocol-api.json";

interface GitleaksRunResult {
  status?: number | null;
  error?: unknown;
}

type GitleaksRunner = (binary: string, args: string[], options: Record<string, unknown>) => GitleaksRunResult;

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface GitleaksOptions {
  baseRef: string;
  fullHistory: boolean;
  headRef: string;
  lenientPlatform: boolean;
  mode: "tree" | "worktree" | "range";
  snapshotTrusted?: string;
  policyRoot?: string;
  trustedRoot?: string;
  candidatePolicy: boolean;
  localTrusted: boolean;
  help: boolean;
}

function parseOptions(argv: readonly string[], env: NodeJS.ProcessEnv): GitleaksOptions {
  const { values, tokens } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      range: { type: "boolean" },
      tree: { type: "boolean" },
      worktree: { type: "boolean" },
      "local-trusted": { type: "boolean" },
      base: { type: "string" },
      head: { type: "string" },
      "lenient-platform": { type: "boolean" },
      "snapshot-trusted": { type: "string" },
      "policy-root": { type: "string" },
      "trusted-root": { type: "string" },
      "candidate-policy": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error(`--${token.name} may only be specified once`);
    seen.add(token.name);
  }
  const modes = ["range", "tree", "worktree", "local-trusted", "snapshot-trusted"].filter((name) => seen.has(name));
  if (modes.length > 1) throw new Error("Select only one Gitleaks mode");
  if (!values["local-trusted"] && (seen.has("base") || seen.has("head"))) {
    throw new Error("--base and --head require --local-trusted");
  }
  if (values["local-trusted"] && !values.help) {
    validateLocalTrustedRefs(values.base ?? "", values.head ?? "");
    if (["lenient-platform", "policy-root", "trusted-root", "candidate-policy"].some((name) => seen.has(name))) {
      throw new Error("--local-trusted cannot override or skip trusted policy");
    }
  }
  const mode = values.worktree ? "worktree" : values.tree ? "tree" : "range";
  const baseRef = values.base ?? env.GITLEAKS_BASE_REF ?? "origin/main";
  const headRef = values.head ?? env.GITLEAKS_HEAD_REF ?? "HEAD";
  const directory = (value: string | undefined) => {
    if (value === undefined) return undefined;
    if (!value.trim()) throw new Error("Gitleaks directory options require a non-empty directory");
    return resolve(value);
  };
  return {
    baseRef,
    fullHistory: env.GITLEAKS_FULL_HISTORY === "1" || ZERO_SHA.test(baseRef),
    headRef,
    lenientPlatform: values["lenient-platform"] ?? false,
    mode,
    snapshotTrusted: directory(values["snapshot-trusted"]),
    policyRoot: directory(values["policy-root"]),
    trustedRoot: directory(values["trusted-root"]),
    candidatePolicy: values["candidate-policy"] ?? false,
    localTrusted: values["local-trusted"] ?? false,
    help: values.help ?? false,
  };
}

const SCANNER_PATH = "scripts/ci/run-gitleaks.ts";
const POLICY_FILES = [".gitleaks.toml", ".gitleaksignore"];

/**
 * A dependency-free lexical pass over import/re-export statements. Comments and
 * string contents are tokens, never executable syntax. Computed imports and
 * package dependencies fail closed: a trusted snapshot must run without npm.
 */
function localImportSpecifiers(source: string): string[] {
  const tokens: string[] = [];
  let offset = source.startsWith("#!") ? source.indexOf("\n") : 0;
  if (offset === -1) offset = source.length;
  while (offset < source.length) {
    if (/\s/.test(source[offset])) {
      offset += 1;
      continue;
    }
    const start = offset;
    const character = source[offset];
    if (source.startsWith("//", offset)) {
      const end = source.indexOf("\n", offset + 2);
      offset = end === -1 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", offset)) {
      const end = source.indexOf("*/", offset + 2);
      if (end === -1) throw new Error("Unterminated trusted scanner comment");
      offset = end + 2;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      offset += 1;
      let closed = false;
      while (offset < source.length) {
        if (source[offset] === "\\") {
          offset += 2;
        } else if (source[offset++] === character) {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error("Unterminated trusted scanner string");
      const token = source.slice(start, offset);
      if (character === "`" && token.includes("${") && /\b(?:import|require)\s*\(/.test(token)) {
        throw new Error("Cannot snapshot imports inside template expressions");
      }
      tokens.push(token);
      continue;
    }
    // Regex literals must not be mistaken for quoted strings or import syntax.
    // At expression-start positions "/" is a regex; otherwise it is division.
    const previous = tokens.at(-1);
    if (character === "/" &&
      (!previous || ["(", "[", "{", "=", ":", ",", ";", "!", "?", "&", "|", "return", "=>"].includes(previous))) {
      offset += 1;
      let inCharacterClass = false;
      let closed = false;
      while (offset < source.length) {
        const next = source[offset++];
        if (next === "\n" || next === "\r") throw new Error("Unterminated trusted scanner regex literal");
        if (next === "\\") {
          offset += 1;
        } else if (next === "[") {
          inCharacterClass = true;
        } else if (next === "]") {
          inCharacterClass = false;
        } else if (next === "/" && !inCharacterClass) {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error("Unterminated trusted scanner regex literal");
      while (offset < source.length && /[a-z]/.test(source[offset])) offset += 1;
    } else if (/[A-Za-z_$0-9]/.test(character)) {
      offset += 1;
      while (offset < source.length && /[\w$]/.test(source[offset])) offset += 1;
    } else {
      offset += source.startsWith("=>", offset) ? 2 : 1;
    }
    tokens.push(source.slice(start, offset));
  }
  const specifiers: string[] = [];
  const literal = (token: string | undefined) => {
    if (!token || !/^["']/.test(token) || token.includes("\\")) {
      throw new Error("Trusted scanner imports must use unescaped literal specifiers");
    }
    return token.slice(1, -1);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "require" && tokens[index + 1] === "(") {
      if (tokens[index + 3] !== ")") throw new Error("Cannot snapshot computed scanner require");
      specifiers.push(literal(tokens[index + 2]));
    } else if (token === "import" && tokens[index - 1] !== ".") {
      if (tokens[index + 1] === ".") continue; // import.meta
      if (tokens[index + 1] === "(") {
        if (tokens[index + 3] !== ")" && tokens[index + 3] !== ",") {
          throw new Error("Cannot snapshot computed scanner import");
        }
        specifiers.push(literal(tokens[index + 2]));
      } else if (/^["']/.test(tokens[index + 1] ?? "")) {
        specifiers.push(literal(tokens[index + 1]));
      } else {
        while (++index < tokens.length && tokens[index] !== "from" && tokens[index] !== ";") {}
        if (tokens[index] !== "from") throw new Error("Cannot resolve trusted scanner import");
        specifiers.push(literal(tokens[index + 1]));
      }
    } else if (token === "export" && ["*", "{"].includes(tokens[index + 1])) {
      while (++index < tokens.length && tokens[index] !== "from" && tokens[index] !== ";") {}
      if (tokens[index] === "from") specifiers.push(literal(tokens[index + 1]));
    }
  }
  return specifiers;
}

export function collectGitleaksTrustedFiles(repoRoot: string): string[] {
  const root = realpathSync(repoRoot);
  const files = new Set<string>();
  const visit = (path: string) => {
    const absolute = realpathSync(path);
    const name = relative(root, absolute);
    if (isAbsolute(name) || name === ".." || name.startsWith("../")) {
      throw new Error(`Trusted scanner dependency escapes repository: ${path}`);
    }
    if (resolve(path) !== absolute) throw new Error(`Cannot snapshot symlinked scanner dependency: ${path}`);
    if (files.has(name)) return;
    if (!statSync(absolute).isFile()) throw new Error(`Not a scanner file: ${path}`);
    files.add(name);
    for (const specifier of localImportSpecifiers(readFileSync(absolute, "utf8"))) {
      if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith(".")) {
        throw new Error(`Cannot snapshot non-local scanner import: ${specifier}`);
      }
      // Node's ESM resolver requires the exact filename, including its extension.
      visit(resolve(dirname(absolute), specifier));
    }
  };
  visit(resolve(root, SCANNER_PATH));
  for (const path of POLICY_FILES) {
    const absolute = resolve(root, path);
    if (!statSync(absolute).isFile()) throw new Error(`Not a policy file: ${path}`);
    files.add(path);
  }
  // Self-test fixture bytes are generated inline, not read from repository files.
  return [...files].sort();
}

export function snapshotGitleaksTrustedInputs(repoRoot: string, destination: string): void {
  const files = collectGitleaksTrustedFiles(repoRoot);
  mkdirSync(destination, { recursive: true });
  for (const path of files) {
    const target = resolve(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(repoRoot, path), target);
  }
  // Explicit ESM resolution avoids relying on the checkout's package.json.
  writeFileSync(resolve(destination, "package.json"), '{"private":true,"type":"module"}\n');
}

export function gitleaksCandidateMatchesTrusted(repoRoot: string, trustedRoot: string): boolean {
  const candidate = collectGitleaksTrustedFiles(repoRoot);
  const trusted = collectGitleaksTrustedFiles(trustedRoot);
  return candidate.length === trusted.length && candidate.every((path, index) =>
    path === trusted[index] &&
    readFileSync(resolve(repoRoot, path)).equals(readFileSync(resolve(trustedRoot, path))));
}

function validateLocalTrustedRefs(baseSha: string, headSha: string): void {
  if (![baseSha, headSha].every((sha) => /^[0-9a-f]{40}$/.test(sha) && !ZERO_SHA.test(sha))) {
    throw new Error("--local-trusted requires --base and --head as full, non-zero commit SHAs");
  }
}

/** Materialize only the scanner's committed import closure and policy. */
function materializeGitleaksRevision(repoRoot: string, sha: string, destination: string): void {
  const visited = new Set<string>();
  const visit = (path: string, scanner: boolean) => {
    const target = resolve(destination, path);
    const name = relative(destination, target);
    if (isAbsolute(name) || name === ".." || name.startsWith("../")) {
      throw new Error("Scanner dependency escapes its revision snapshot");
    }
    if (visited.has(name)) return;
    visited.add(name);
    const entry = execFileSync("git", ["ls-tree", sha, "--", name], { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
    if (!/^100(?:644|755) blob /.test(entry)) throw new Error("Missing or non-regular scanner input");
    const bytes = execFileSync("git", ["show", `${sha}:${name}`], { cwd: repoRoot, stdio: "pipe", maxBuffer: 16 * 1024 * 1024 });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    if (!scanner) return;
    for (const specifier of localImportSpecifiers(bytes.toString("utf8"))) {
      if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith(".")) throw new Error("Scanner snapshot requires dependency-free local imports");
      visit(relative(destination, resolve(dirname(target), specifier)), true);
    }
  };
  visit(SCANNER_PATH, true);
  for (const path of POLICY_FILES) visit(path, false);
  writeFileSync(resolve(destination, "package.json"), '{"private":true,"type":"module"}\n');
}

interface LocalTrustedGitleaksOptions {
  baseSha: string;
  headSha: string;
  mergeSha?: string;
  repoRoot: string;
}

const runGitleaksMode: GitleaksRunner = (binary, args, options) => spawnSync(binary, [
  args[0], "--input-type=module", "--eval",
  // Older trusted CLIs used exit 1 for both setup errors and findings. Calling
  // their existing mode function preserves scans while distinguishing throws.
  "import(process.argv[1]).then(({runGitleaks}) => runGitleaks({argv:process.argv.slice(2)}))" +
    ".then(({status}) => { process.exitCode = status; }).catch(() => { process.exitCode = 2; });",
  pathToFileURL(args[1]).href, ...args.slice(2),
], options);

/**
 * CI's security sequence on frozen local commits. The temporary detached scan
 * repository borrows objects read-only (no clone, branch, or worktree creation).
 * Its HEAD is the requested head unless a parity caller supplies mergeSha.
 * The latter additionally includes synthetic merge-resolution lines; range
 * selection and candidate inputs remain frozen to the branch headSha.
 * Each pass runs the revision's own scanner, never the candidate for trusted
 * passes. Scanner output retains the existing --redact contract.
 */
export async function runLocalTrustedGitleaks(
  { baseSha, headSha, mergeSha, repoRoot }: LocalTrustedGitleaksOptions,
  { runScanner = runGitleaksMode }: { runScanner?: GitleaksRunner } = {},
): Promise<{ ok: boolean; exitCode: number; summary: string }> {
  try {
    validateLocalTrustedRefs(baseSha, headSha);
    if (mergeSha !== undefined) validateLocalTrustedRefs(baseSha, mergeSha);
  } catch {
    return { ok: false, exitCode: 2, summary: "Trusted secret scan requires full, non-zero base/head and optional merge commit SHAs." };
  }
  let temporaryRoot: string | undefined;
  let stage = "setup";
  const result = (exitCode: number, summary: string) => ({ ok: exitCode === 0, exitCode, summary });
  try {
    const root = realpathSync(repoRoot);
    for (const sha of [baseSha, headSha, ...(mergeSha ? [mergeSha] : [])]) {
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root, stdio: "pipe" });
    }
    temporaryRoot = mkdtempSync(join(tmpdir(), "pharos-trusted-gitleaks-"));
    const baseRoot = join(temporaryRoot, "base");
    const candidateRoot = join(temporaryRoot, "candidate");
    const trustedRoot = join(temporaryRoot, "trusted");
    materializeGitleaksRevision(root, baseSha, baseRoot);
    // Private HEAD/index/refs; read-only alternates avoid copying full history.
    execFileSync("git", ["init", "--quiet", "--bare", join(candidateRoot, ".git")], { stdio: "pipe" });
    execFileSync("git", ["--git-dir", join(candidateRoot, ".git"), "config", "core.bare", "false"], { stdio: "pipe" });
    writeFileSync(join(candidateRoot, ".git/HEAD"), `${mergeSha ?? headSha}\n`);
    const objects = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "objects"], {
      cwd: root, encoding: "utf8", stdio: "pipe",
    }).trim();
    writeFileSync(join(candidateRoot, ".git/objects/info/alternates"), `${objects}\n`);
    const env = { ...process.env, GITLEAKS_BASE_REF: baseSha, GITLEAKS_HEAD_REF: headSha, GITLEAKS_FULL_HISTORY: "0" };
    const scan = (scannerRoot: string, args: string[]) => {
      const outcome = runScanner(process.execPath, [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(scannerRoot, SCANNER_PATH), ...args,
      ], { cwd: candidateRoot, env, stdio: "inherit" });
      if (outcome.error || outcome.status == null) return 2;
      return outcome.status === 0 ? 0 : outcome.status === 1 ? 1 : 2;
    };
    stage = "snapshot";
    let status = scan(baseRoot, [`--snapshot-trusted=${trustedRoot}`]);
    if (status !== 0) return result(2, "Trusted secret scan could not snapshot base inputs.");
    stage = "trusted range";
    status = scan(trustedRoot, ["--range", `--policy-root=${trustedRoot}`]);
    if (status !== 0) return result(status, `Trusted secret scan failed at ${stage}.`);
    stage = "trusted merge resolutions";
    status = scan(trustedRoot, ["--tree", `--policy-root=${trustedRoot}`]);
    if (status !== 0) return result(status, `Trusted secret scan failed at ${stage}.`);
    stage = "candidate policy";
    materializeGitleaksRevision(root, headSha, candidateRoot);
    status = scan(candidateRoot, ["--range", "--candidate-policy", `--trusted-root=${trustedRoot}`]);
    return result(status, status === 0 ? "Trusted secret scans and candidate policy check passed." : `Trusted secret scan failed at ${stage}.`);
  } catch {
    // Git errors can include blob contents; never echo raw setup exceptions.
    return result(2, `Trusted secret scan setup failed at ${stage}; verify full local commit history and scanner inputs.`);
  } finally {
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function resolveGitleaksPin(platformKey: string): (typeof GITLEAKS_PINS)[keyof typeof GITLEAKS_PINS] | undefined {
  return GITLEAKS_PINS[platformKey as keyof typeof GITLEAKS_PINS];
}

function addedHunkLines(diff: string, combined: boolean): string[] {
  const added: string[] = [];
  let prefixLength = 0;
  for (const line of diff.split(/\r?\n/g)) {
    if (line.startsWith("diff ")) {
      prefixLength = 0;
      continue;
    }
    const hunk = /^(@{2,}) /.exec(line);
    if (hunk) {
      prefixLength = combined ? hunk[1].length - 1 : 1;
      continue;
    }
    if (prefixLength > 0 && line.startsWith("+".repeat(prefixLength))) {
      added.push(line.slice(prefixLength));
    }
  }
  return added;
}

export function buildGitleaksWorktreeInput({
  execFile = execFileSync,
}: { execFile?: (file: string, args: string[], options: { encoding: "utf8" }) => string } = {}): Buffer {
  const diff = execFile("git", ["diff", "--no-ext-diff", "--unified=0", "HEAD", "--"], { encoding: "utf8" });
  const addedLines = addedHunkLines(diff, false);
  const untracked = execFile("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const chunks = [Buffer.from(`${addedLines.join("\n")}\n`)];
  for (const path of untracked) {
    try {
      chunks.push(Buffer.from(`\nFILE:${path}\n`), readFileSync(resolve(process.cwd(), path)), Buffer.from("\n"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Lines merge commits introduce relative to *both* parents — i.e. content that
 * came from the conflict resolution rather than from either side's
 * already-scanned history. Combined diff prefixes those lines with `++`. The
 * checked-out HEAD contributes its own resolution lines, and every merge
 * commit inside the requested range is enumerated the same way: the range scan
 * uses `--no-merges`, and a resolution-only line from an earlier merge is
 * already present in the PR-head parent by the time the checked-out merge is
 * diffed, so HEAD alone cannot see it.
 */
export function buildGitleaksMergeResolutionInput({
  baseRef = "origin/main",
  execFile = execFileSync,
  headRef = "HEAD",
}: {
  baseRef?: string;
  execFile?: (file: string, args: string[], options: { encoding: "utf8" }) => string;
  headRef?: string;
} = {}): Buffer {
  const parents = execFile("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { encoding: "utf8" }).trim().split(/\s+/g);
  const resolutionLines: string[] = [];
  if (parents.length >= 3) resolutionLines.push(...combinedDiffResolutionLines(execFile, "HEAD"));
  const merges = execFile("git", ["rev-list", "--merges", `${baseRef}..${headRef}`], { encoding: "utf8" });
  for (const merge of merges.trim().split(/\n+/g).filter(Boolean)) {
    resolutionLines.push(...combinedDiffResolutionLines(execFile, merge));
  }
  return Buffer.from(`${resolutionLines.join("\n")}\n`);
}

function combinedDiffResolutionLines(
  execFile: (file: string, args: string[], options: { encoding: "utf8" }) => string,
  commit: string,
): string[] {
  const combined = execFile("git", ["diff-tree", "--cc", "--no-color", "-r", commit], { encoding: "utf8" });
  return addedHunkLines(combined, true);
}

export async function ensurePinnedGitleaks({
  cacheRoot = resolve(process.cwd(), ".cache/gitleaks"),
  fetchImpl = fetch,
  execFile = execFileSync,
  platformKey = `${platform()}-${arch()}`,
}: {
  cacheRoot?: string;
  fetchImpl?: typeof fetch;
  execFile?: (file: string, args: string[], options: { stdio: "ignore" }) => unknown;
  platformKey?: string;
} = {}): Promise<string> {
  const pin = resolveGitleaksPin(platformKey);
  if (!pin) throw new Error(`No pinned Gitleaks binary for ${platformKey.replace("-", "/")}`);

  const versionDir = resolve(cacheRoot, `${GITLEAKS_VERSION}-${platformKey}`);
  const binaryPath = resolve(versionDir, "gitleaks");
  const markerPath = resolve(versionDir, "verified.json");
  if (existsSync(binaryPath) && existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      if (
        marker.tarballSha256 === pin.sha256 &&
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
    const url = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${pin.assetSuffix}`;
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`download returned HTTP ${response.status}`);
    writeFileSync(tarballPath, Buffer.from(await response.arrayBuffer()));
    const actualSha = sha256File(tarballPath);
    if (actualSha !== pin.sha256) {
      throw new Error(`tarball checksum mismatch: expected ${pin.sha256}, received ${actualSha}`);
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
          tarballSha256: pin.sha256,
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

export function runGitleaksConfigSelfTest(
  binaryPath: string,
  { runBinary = spawnSync, policyRoot = process.cwd() }: { runBinary?: GitleaksRunner; policyRoot?: string } = {},
): void {
  const root = mkdtempSync(join(tmpdir(), "pharos-gitleaks-self-test-"));
  const configPath = resolve(policyRoot, ".gitleaks.toml");

  try {
    const falconLabel = ["ARIA", "B71VABWJ", "T8GB"].join("_");
    const credential = ["A1b2C3d4E5f6G7h8", "I9j0K1l2M3n4O5p6"].join("");
    const solanaMint = ["Cfuy5T6osdazUeLego5LF", "ycBQebm9PP3H7VNdCndXXEN"].join("");
    const gitbookUuid = ["54e9714e-c65f-4b0c", "-8bcf-c7869956dd20"].join("");
    const tronUsdt = ["TR7NHqjeKQxGTCi8q8", "ZY4pL8otSzgjLj6t"].join("");
    const tronUsdtHex = ["a614f803b6fd780986a42", "c78ec9c7f77e6ded13c"].join("");
    const legacyUsdvPool = ["DmXXwEcK2c7fuVoW6TBzF5", "UDByhuQBHZS1qHnwprvHFH"].join("");
    const spikoAuthority = ["GhRFGntEPkDi3ass8HYPqd", "qWMZQ4F4hs8a3QfNtT622h"].join("");
    const midasProspectusUuid = ["d80ceabb-07a6-4dc4", "-9020-70ec86b4f42f"].join("");
    const apyxAttestationUuid = ["0386fd1d-2316-4320", "-b799-96ec6c4e827e"].join("");
    const matrixdockUuids = [
      ["3cad87ae-7846-4bfe", "-ba2e-411fbf166f60"].join(""),
      ["cad709b6-47f1-427d", "-ad14-443fa5cd76e1"].join(""),
      ["d5a97752-ca3b-46d3", "-9077-16ac2bc11ee8"].join(""),
    ];
    const gldtLeg = ["gldt-reverse", "swap-to-specific-gld-nft"].join("-");
    const evidenceGapPath = "shared/data/safety-score-v9/evidence-gap-classifications-v1.json";
    const researchUuids = [
      ["34ae6ee1-5f94-4ce9", "-87e8-c98bcec11762"].join(""),
      ["19d915b4-356f-4abd", "-a4b2-d331515adc22"].join(""),
      ["79d5fd49-deae-41b4", "-a809-9e1afaa02f32"].join(""),
      ["7a7a500e-1321-4e9d", "-8046-46ae8199e244"].join(""),
      ["9bfe7105-c648-406b", "-b51c-b9c4431bc335"].join(""),
    ];
    const researchGldtMatches = [
      ["gldt-gold-dao", "df16e419ba0"].join("-"),
      ["gldt-gold-dao", "8e6db88665b"].join("-"),
      ["gldt-gold-dao", "4d85e1c0e1b"].join("-"),
      ["gldt-gold-dao", "3892111dfe4"].join("-"),
      ["gldt-launches", "as-the-worl"].join("-"),
    ];
    const transferIdentifiers = [
      ["0x06723dcb428eddb160c5adfc2d0a5e5", "adc184bf6a7298780c3cbf3fa764f709b"].join(""),
      ["CAJD2IBSP7VO2VYJQUYJSOGP", "JINTUYV7MQITINXVPTIH3CCLCUENNMW4"].join(""),
      ["TN3cfcFhLrdNZhMdHZ", "VZ4z2XFWb7uB9CXg"].join(""),
      ["7bxM8cRFZpzonzZtzmrcW", "HNX1dijrEVU4VkjjtVyBmqE"].join(""),
    ];
    const solanaUsdcInputMint = ["EPjFWdd5AufqSSqeM2qN1", "xzybapC8G4wEGGkZwyTDt1v"].join("");
    const uniXautPair = [
      "UNI0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
      "XAUT0x68749665ff8d2d112fa859aa293f07a622782f38",
    ].join("/");
    const supplyAttributionSlotKey = ["v9Supply", "AttributionOffset"].join("");
    const publicControls = [
      {
        path: "scripts/maintenance/run-worker-smoke.mjs",
        // SAFETY: The scanner control interpolates a fixed slot-key literal, not external input; preserve its fixture value.
        value: { query: `SELECT state FROM cron_slot_executions WHERE slot_key = '${supplyAttributionSlotKey}'` },
      },
      {
        path: "worker/src/lib/__tests__/v9-slot-window.test.ts",
        value: { currentSlotKey: supplyAttributionSlotKey },
      },
      {
        path: "worker/scripts/repair-tron-blacklist-amounts.ts",
        value: { token: tronUsdt, tokenHex: tronUsdtHex },
      },
      {
        path: "worker/scripts/__tests__/repair-tron-blacklist-amounts.test.ts",
        value: { token: tronUsdt },
      },
      {
        path: "worker/src/lib/__tests__/fixtures/usdv-jupiter-quotes.json",
        value: { ammKey: legacyUsdvPool },
      },
      {
        path: "shared/data/stablecoins/domains/risk-review/usdh-hubble.json",
        value: { key: `kamino-ktoken:${solanaMint}` },
      },
      {
        path: "shared/data/stablecoins/coins/xaum-matrixdock.json",
        value: { url: `https://2505056629-files.gitbook.io/a.pdf?alt=media&token=${gitbookUuid}` },
      },
      ...["safo-spiko-usd", "ustbl-spiko", "eursafo-spiko"].map((id) => ({
        path: `shared/data/stablecoins/domains/mint-authority/${id}.json`,
        value: { key: `solana:key:${spikoAuthority}` },
      })),
      ...[
        "shared/data/stablecoins/coins/mhyper-midas.json",
        "shared/data/stablecoins/domains/compliance/mtbill-midas.json",
        "shared/lib/redemption-backstop-configs/offchain-issuer/non-usd-and-tokenized.ts",
        ".github/workflows/artifacts/safety-score-missing-data-reviewed-ledger.json",
      ].map((path) => ({
        path,
        value: { url: `https://3475141875-files.gitbook.io/a.pdf?alt=media&token=${midasProspectusUuid}` },
      })),
      {
        path: "shared/data/stablecoins/domains/reserves/apyusd-apyx.json",
        value: { url: `https://1731598137-files.gitbook.io/a.pdf?alt=media&token=${apyxAttestationUuid}` },
      },
      ...matrixdockUuids.map((uuid) => ({
        path: "shared/lib/redemption-backstop-configs/offchain-issuer/commodity.ts",
        value: { url: `https://2505056629-files.gitbook.io/a.pdf?alt=media&token=${uuid}` },
      })),
      {
        path: "shared/lib/redemption-backstop-configs/offchain-issuer/commodity.ts",
        value: { leg: gldtLeg },
      },
      {
        path: ".github/workflows/artifacts/safety-score-missing-data-reviewed-ledger.json",
        value: { evidence: `token0/token1 -> ${uniXautPair}; getReserves0x0902f1ac` },
      },
      ...researchUuids.map((uuid) => ({
        path: evidenceGapPath,
        value: { url: `https://files.gitbook.com/a.pdf?alt=media&token=${uuid}` },
      })),
      {
        path: evidenceGapPath,
        value: { url: `https://files.gitbook.com/a.pdf?alt=media&token=${["168abe3d-0650-454c", "-bfa5-592b7c08ad83"].join("")}` },
      },
      {
        path: evidenceGapPath,
        value: { componentKey: `control:mint-meta:krusdc-keyrock:${["fe24dc6831", "77afe51d19"].join("")}` },
      },
      ...[
        ["58c911b9-1ab7-495c", "-97ba-d379fe9c4e5e"].join(""),
        ["9bfe7105-c648-406b", "-b51c-b9c4431bc335"].join(""),
      ].map((uuid) => ({
        path: "shared/lib/redemption-backstop-configs/offchain-issuer/coverage-and-stablecoin-audit.ts",
        value: { url: `https://3475141875-files.gitbook.io/a.pdf?alt=media&token=${uuid}` },
      })),
      ...["raydium-wave4-simulation", "solana-clmm-wave4-pinned"].map((fixture) => ({
        path: `worker/src/cron/dex-liquidity/__tests__/fixtures/${fixture}.json`,
        value: { tokenMintIn: solanaUsdcInputMint },
      })),
      {
        path: "shared/data/stablecoins/domains/risk-review/feusd-felix.json",
        value: { coreTokenId: ["0x88102bea0bbad5f3", "01f6e9e4dacdf979"].join("") },
      },
      {
        path: "shared/data/safety-score-v9/wrapper-allocation-reviews-v1.json",
        value: { description: `Token runtime keccak256=${["0x511f4a291580f38c1482a112c65ac6fcc", "455169f9739e90e68713b41958e5d22"].join("")}; wrapper runtime unchanged.` },
      },
      ...researchGldtMatches.map((match) => ({
        path: evidenceGapPath,
        value: { id: `uw-${match}` },
      })),
      {
        path: "shared/data/safety-score-v9/operational-resilience-overlays-v1.json",
        value: { url: `https://medium.com/@GoldDAO/${researchGldtMatches[4]}` },
      },
      ...transferIdentifiers.map((identifier) => ({
        path: "shared/data/safety-score-v9/transfer-review-overlays-v1.json",
        value: { contractOrTokenId: identifier },
      })),
    ];
    const awsKey = ["AKIA", "Q7M2V3N4P6R2S3T5"].join("");
    // Multiple controls share a path. Keep each on its own line so report
    // assertions address every original fixture, not merely the file as a whole.
    const falconControl = { path: FALCON_SELF_TEST_PATH, value: { key: falconLabel } };
    for (const group of ["public", "aws", "generic"] as const) {
      const controls = group === "aws" ? publicControls : [falconControl, ...publicControls];
      const scanRoot = resolve(root, group);
      const linesByPath = new Map<string, string[]>();
      const assertions: { path: string; line: number }[] = [];
      for (const control of controls) {
        const lines = linesByPath.get(control.path) ?? [];
        const value = group === "aws"
          ? { ...control.value, aws_access_key_id: awsKey }
          : group === "generic"
            ? control.path === FALCON_SELF_TEST_PATH ? { api_key: credential } : { ...control.value, api_key: credential }
            : control.value;
        lines.push(JSON.stringify(value));
        linesByPath.set(control.path, lines);
        assertions.push({ path: control.path, line: lines.length });
      }
      for (const [path, lines] of linesByPath) {
        const fixture = resolve(scanRoot, path);
        mkdirSync(dirname(fixture), { recursive: true });
        writeFileSync(fixture, `${lines.join("\n")}\n`);
      }
      const report = resolve(root, `${group}-report.json`);
      const result = runBinary(binaryPath, [
        "dir", "--no-banner", "--redact", "--exit-code", "1",
        `--config=${configPath}`, "--gitleaks-ignore-path=/dev/null",
        "--report-format=json", `--report-path=${report}`, scanRoot,
      ], { encoding: "utf8", stdio: "pipe" });
      if (result.error || result.status !== (group === "public" ? 0 : 1)) {
        throw new Error(`Gitleaks ${group} self-test failed with status ${result.status ?? "unknown"}`);
      }
      // Go's JSON encoder can represent an empty findings slice as null.
      const findings: { File: string; StartLine: number; RuleID: string }[] = JSON.parse(readFileSync(report, "utf8")) ?? [];
      if (!Array.isArray(findings) || findings.some((finding) =>
        finding == null || typeof finding.File !== "string" || !Number.isInteger(finding.StartLine) || typeof finding.RuleID !== "string")) {
        throw new Error(`Invalid Gitleaks ${group} self-test report`);
      }
      for (const { path, line } of assertions) {
        const matches = findings.filter((finding) =>
          resolve(scanRoot, finding.File) === resolve(scanRoot, path) && finding.StartLine === line);
        const expectedRule = group === "aws" ? "aws-access-token" : "generic-api-key";
        if (group === "public" ? matches.length !== 0 : !matches.some((finding) => finding.RuleID === expectedRule)) {
          throw new Error(`Gitleaks ${group} control failed: ${path}:${line} (${expectedRule})`);
        }
      }
      if (group === "public" && findings.length !== 0) {
        throw new Error("Unexpected finding in public Gitleaks controls");
      }
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

/**
 */
export async function runGitleaks({
  argv = process.argv.slice(2),
  buildMergeResolutionInput = buildGitleaksMergeResolutionInput,
  buildWorktreeInput = buildGitleaksWorktreeInput,
  env = process.env,
  ensureBinary = ensurePinnedGitleaks,
  platformKey = `${platform()}-${arch()}`,
  runBinary = spawnSync,
}: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  ensureBinary?: (options?: { cacheRoot?: string; platformKey?: string }) => Promise<string>;
  buildMergeResolutionInput?: (refs: { baseRef: string; headRef: string }) => Buffer;
  buildWorktreeInput?: () => Buffer;
  platformKey?: string;
  runBinary?: GitleaksRunner;
} = {}): Promise<{ status: number }> {
  const options = parseOptions(argv, env);
  if (options.help) {
    console.log("Usage: run-gitleaks.ts --local-trusted --base=<sha> --head=<sha>\n" +
      "Or: --range | --tree | --worktree [--policy-root=<dir>]\n" +
      "Snapshot: --snapshot-trusted=<dir>; candidate: --range --candidate-policy --trusted-root=<dir>\n" +
      "Local trusted exits: 0 clean, 1 findings, 2 usage/setup error. CI additionally scans its synthetic PR merge.");
    return { status: 0 };
  }
  if (options.localTrusted) {
    const result = await runLocalTrustedGitleaks({
      baseSha: options.baseRef, headSha: options.headRef, repoRoot: process.cwd(),
    });
    console.log(`[gitleaks] ${result.summary}`);
    return { status: result.exitCode };
  }
  if (options.snapshotTrusted) {
    snapshotGitleaksTrustedInputs(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), options.snapshotTrusted);
    return { status: 0 };
  }
  if (options.candidatePolicy) {
    if (!options.trustedRoot) throw new Error("--candidate-policy requires --trusted-root");
    if (options.policyRoot || options.mode !== "range") throw new Error("--candidate-policy requires the cwd range policy");
    if (gitleaksCandidateMatchesTrusted(process.cwd(), options.trustedRoot)) {
      console.log("[gitleaks] candidate policy identical to trusted base; skipping");
      return { status: 0 };
    }
  }
  if (!resolveGitleaksPin(platformKey)) {
    const displayPlatform = platformKey.replace("-", "/");
    if (options.lenientPlatform) {
      console.warn(`[gitleaks] SKIPPED: no pinned binary for ${displayPlatform}`);
      return { status: 0 };
    }
    throw new Error(`No pinned Gitleaks binary for ${displayPlatform}`);
  }
  const binaryPath = await ensureBinary({
    ...(options.policyRoot ? { cacheRoot: resolve(options.policyRoot, ".cache/gitleaks") } : {}),
    platformKey,
  });
  runGitleaksConfigSelfTest(binaryPath, { runBinary, policyRoot: options.policyRoot });
  // `.gitleaksignore` fingerprints are commit-pinned, which only a history scan can honour, so both
  // stdin lanes carry exactly the bytes the range scan cannot see: uncommitted edits (worktree) or
  // the lines a merge resolution introduced in neither parent's history (tree). Anything flagged in
  // those bytes is new and has no fingerprint to hide behind.
  const stdinMode = options.mode === "worktree" || options.mode === "tree";
  const args = stdinMode
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
  if (options.policyRoot) {
    // Explicit flags prevent the target checkout's config/ignore from influencing
    // either history or stdin scans. Git and merge-resolution inputs stay in cwd.
    const policyArgs = [
      `--config=${resolve(options.policyRoot, ".gitleaks.toml")}`,
      `--gitleaks-ignore-path=${resolve(options.policyRoot, ".gitleaksignore")}`,
    ];
    if (stdinMode) args.splice(5, 2, ...policyArgs);
    else args.splice(args.length - 1, 0, ...policyArgs);
  }
  const result = runBinary(binaryPath, args, {
    ...(options.mode === "worktree" ? { input: buildWorktreeInput() } : {}),
    ...(options.mode === "tree" ? { input: buildMergeResolutionInput({ baseRef: options.baseRef, headRef: options.headRef }) } : {}),
    stdio: stdinMode ? ["pipe", "inherit", "inherit"] : "inherit",
  });
  return { status: result.status ?? 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runGitleaks()
    .then((result) => {
      process.exitCode = result.status;
    })
    .catch((error) => {
      console.error(`[gitleaks] FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    });
}

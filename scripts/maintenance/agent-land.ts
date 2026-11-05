#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, matchesGlob, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseStrictCliArgs, requireCliString, runDirectCli } from "../lib/cli-args.mjs";

const USAGE = "Usage: agent:land --lane L --target T --review review.json --message-file msg [--apply]";
const DEFERRED = "safety-score-v9-evaluation-build";
const DIFF = ["--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=none", "--src-prefix=a/", "--dst-prefix=b/"];
// Validator-owned bookkeeping, never an exemption for generator writes.
const VALIDATOR_INTERNALS = [
  ".cache/eslint/**", ".cache/vitest-stablecoin-artifacts/**", ".cache/vitest-latest-schema-sqlite/**",
  ".cache/release-check/worker-bundle-public/**", ".cache/release-check/worker-bundle-heavy/**",
  ".next/types/**", "next-env.d.ts", "tsconfig.tsbuildinfo", "tsconfig.typecheck.tsbuildinfo",
  "tsconfig.test-typecheck.tsbuildinfo", "worker/tsconfig.tsbuildinfo",
];

interface LandArgs {
  lane: string;
  target: string;
  review: string;
  messageFile: string;
  apply: boolean;
  help: boolean;
}

interface ArtifactPlan {
  ids: string[];
  outputs: string[];
  generate: unknown[];
  check: unknown[];
  checkIds: string[];
  pending: string[];
  validatorOutputs: string[];
}

interface Command {
  stage: string;
  cwd: string;
  executable: string;
  args: string[];
}

interface Runtime {
  planArtifacts?: (root: string, paths: string[]) => ArtifactPlan;
  runCommand?: (command: Command) => void;
  log?: (message: string) => unknown;
}

export function parseAgentLandArgs(argv: readonly string[] = []): LandArgs {
  const { values } = parseStrictCliArgs(argv, { options: {
    lane: { type: "string" }, target: { type: "string" }, review: { type: "string" },
    "message-file": { type: "string" }, apply: { type: "boolean" },
  } });
  const help = values.help === true;
  const path = (name: string) => help ? "" : resolve(requireCliString(values[name], `--${name}`));
  return { lane: path("lane"), target: path("target"), review: path("review"),
    messageFile: path("message-file"), apply: values.apply === true, help };
}

function environment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", TSX_DISABLE_CACHE: "1" };
}

const executables = new Map<string, string>();

function pinExecutables(roots: string[]) {
  for (const name of ["git", "npm"]) {
    if (executables.has(name)) continue;
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      const path = resolve(directory, name);
      try {
        accessSync(path, constants.X_OK);
        if (!lstatSync(realpathSync(path)).isFile()) continue;
        executables.set(name, path);
        break;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    if (!executables.has(name)) throw new Error(`Executable not found on startup PATH: ${name}`);
  }
  for (const root of roots.map(path => realpathSync(path))) {
    const modules = join(root, "node_modules");
    const excluded = [root, ...(existsSync(modules) ? [realpathSync(modules)] : [])];
    for (const executable of executables.values()) {
      if ([executable, realpathSync(executable)].some(path => excluded.some(base => path === base || path.startsWith(`${base}${sep}`)))) {
        throw new Error(`Executable must be outside repositories and their node_modules: ${executable}`);
      }
    }
  }
}

function execute(command: Command, input?: Buffer, allowed = [0]): Buffer {
  const result = spawnSync(executables.get(command.executable) ?? command.executable, command.args, {
    cwd: command.cwd, env: environment(), input, maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error || result.signal || !allowed.includes(result.status ?? -1) ||
    (result.status === 1 && (result.stderr?.length || (command.args.includes("--no-index") && !result.stdout?.length)))) {
    throw new Error(`${command.stage}: ${command.executable} failed (status ${result.status}, signal ${result.signal ?? "none"})` +
      `\n${result.error?.message ?? ""}${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`);
  }
  return result.stdout;
}

function git(root: string, args: string[], input?: Buffer, allowed?: number[], stage = `git ${args[0]}`) {
  return execute({ stage, cwd: root, executable: "git",
    args: ["--no-replace-objects", "-c", "core.filemode=true", "-c", "core.quotePath=true", ...args] }, input, allowed);
}

const hash = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");
const sorted = (paths: string[]) => [...new Set(paths)].sort();
const nul = (bytes: Buffer) => bytes.toString("utf8").split("\0").filter(Boolean);

function safePath(path: string) {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\ufffd") || path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git" ||
      part === ".env.local" || part.startsWith(".dev.vars"))) {
    throw new Error(`Unsupported path: ${JSON.stringify(path)}`);
  }
  return path;
}

function fileState(root: string, path: string, deleted = false) {
  safePath(path);
  const missing = { path, mode: "000000", sha256: null };
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const parent = join(root, ...parts.slice(0, i));
    try {
      if (!lstatSync(parent).isDirectory()) {
        if (deleted) return missing;
        throw new Error(`Non-directory parent: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return missing;
      throw error;
    }
  }
  const absolute = join(root, path);
  let stat;
  try { stat = lstatSync(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return missing;
    throw error;
  }
  if (stat.isSymbolicLink()) return { path, mode: "120000", sha256: hash(readlinkSync(absolute, { encoding: "buffer" })) };
  if (deleted && stat.isDirectory()) return missing;
  if (!stat.isFile()) throw new Error(`Unsupported file/gitlink: ${path}`);
  return { path, mode: stat.mode & 0o100 ? "100755" : "100644", sha256: hash(readFileSync(absolute)) };
}

function trackedDiff(root: string, cached = false) {
  const base = ["diff", ...(cached ? ["--cached"] : [])];
  const raw = nul(git(root, [...base, "--raw", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color",
    "--ignore-submodules=none", "-z", "HEAD", "--"]));
  const patch = git(root, [...base, ...DIFF, "HEAD", "--"]);
  const chunks: Buffer[] = [];
  if (patch.length && patch.indexOf("diff --git ") !== 0) throw new Error("Unsupported Git patch header");
  for (let start = 0; start < patch.length;) {
    const next = patch.indexOf("\ndiff --git ", start);
    const end = next < 0 ? patch.length : next + 1;
    chunks.push(patch.subarray(start, end));
    start = end;
  }
  if (raw.length % 2) throw new Error("Invalid Git raw entries");
  let offset = 0;
  const entries = new Map<string, { deleted: boolean; body: Buffer }>();
  for (let index = 0; index < raw.length; index += 2) {
    const header = raw[index].split(" ");
    if (header[0] === ":160000" || header[1] === "160000") throw new Error("Unsupported gitlink in lane delta");
    const status = header.at(-1);
    // A file/symlink type change emits deletion and addition patch sections.
    const count = status === "T" ? 2 : 1;
    entries.set(safePath(raw[index + 1]), { deleted: status === "D", body: Buffer.concat(chunks.slice(offset, offset + count)) });
    offset += count;
  }
  if (offset !== chunks.length) throw new Error("Git patch/path count changed");
  return entries;
}

function readInput(path: string) {
  safePath(path.split("/").at(-1) ?? "");
  if (!lstatSync(path).isFile()) throw new Error(`Expected a regular input file: ${path}`);
  return readFileSync(path);
}

function identity(path: string) {
  const root = realpathSync(path);
  if (realpathSync(git(root, ["rev-parse", "--show-toplevel"]).toString().trim()) !== root) {
    throw new Error(`Expected checkout root: ${path}`);
  }
  const symbolicRef = git(root, ["symbolic-ref", "-q", "HEAD"], undefined, [0, 1]).toString().trim() || null;
  if (symbolicRef !== null && !symbolicRef.startsWith("refs/heads/")) throw new Error("Expected local branch or detached HEAD");
  const attributes = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/attributes"]).toString().trim();
  const globalAttributes = resolve(root, git(root, ["config", "--path", "--get", "core.attributesFile"], undefined, [0, 1]).toString().trim()
    || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git", "attributes"));
  return { root, commonDir: realpathSync(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim()),
    symbolicRef, detached: symbolicRef === null,
    configSha256: hash(git(root, ["config", "--null", "--list"])),
    attributesSha256: existsSync(attributes) ? hash(readInput(attributes)) : null,
    globalAttributes: { path: globalAttributes, sha256: existsSync(globalAttributes) ? hash(readInput(realpathSync(globalAttributes))) : null },
    head: git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).toString().trim() };
}

function idle(root: string) {
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
    const path = git(root, ["rev-parse", "--path-format=absolute", "--git-path", marker]).toString().trim();
    if (existsSync(path)) throw new Error(`In-progress Git operation in ${root}: ${marker}`);
  }
  if (git(root, ["ls-files", "--unmerged", "-z"]).length) throw new Error(`Unmerged index in ${root}`);
}

function changedPaths(root: string) {
  return sorted([...nul(git(root, ["diff", "--name-only", "--no-renames", "--ignore-submodules=none", "-z", "HEAD", "--"])),
    ...nul(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))]).map(safePath);
}

function newSymlinkDiff(root: string, path: string) {
  const content = readlinkSync(join(root, path), { encoding: "buffer" });
  const oid = git(root, ["hash-object", "--stdin"], content).toString().trim();
  const quoted = git(root, ["ls-files", "--others", "--exclude-standard", "--", path]).toString().slice(0, -1);
  if (!quoted) throw new Error(`Missing untracked symlink: ${path}`);
  const prefixed = (prefix: string) => quoted.startsWith('"') ? `"${prefix}/${quoted.slice(1)}` : `${prefix}/${quoted}`;
  // Diff stdin, never the symlink path: no-index otherwise dereferences directory links.
  const patch = git(root, ["diff", ...DIFF, "--text", "--no-index", "--", "/dev/null", "-"], content, [0, 1]);
  const hunk = patch.indexOf("\n@@ ");
  if (hunk < 0) throw new Error(`Missing symlink diff: ${path}`);
  const tab = !quoted.startsWith('"') && path.includes(" ") ? "\t" : "";
  return Buffer.concat([Buffer.from(`diff --git ${prefixed("a")} ${prefixed("b")}\nnew file mode 120000\n` +
    `index ${"0".repeat(oid.length)}..${oid}\n--- /dev/null\n+++ ${prefixed("b")}${tab}\n`), patch.subarray(hunk + 1)]);
}

function snapshot(root: string) {
  const untracked = new Set(nul(git(root, ["ls-files", "--others", "--exclude-standard", "-z"])));
  const tracked = trackedDiff(root);
  const paths = sorted([...tracked.keys(), ...untracked]).map(safePath);
  const files = paths.map((path) => ({ ...fileState(root, path, tracked.get(path)?.deleted), untracked: untracked.has(path) }));
  const diff = paths.map((path, index) => untracked.has(path)
    ? files[index].mode === "120000" ? newSymlinkDiff(root, path)
      : git(root, ["diff", ...DIFF, "--no-index", "--", "/dev/null", path], undefined, [0, 1])
    : tracked.get(path)!.body);
  return { paths, files, diff: Buffer.concat(diff) };
}

// Import in a fresh target-owned process: combined-tree code must own selection and commands.
const ARTIFACT_PLAN = `
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const load = p => import(pathToFileURL(resolve(p)).href);
const { selectChangedGeneratedArtifactIds } = await load('scripts/ci/select-generated-artifacts.mts');
const { selectGeneratedArtifacts } = await load('scripts/lib/automation-registry.mjs');
const { buildGeneratedArtifactExecutionPhases } = await load('scripts/maintenance/run-generated-artifacts.ts');
const deferred = ${JSON.stringify(DEFERRED)};
const selected = selectChangedGeneratedArtifactIds(JSON.parse(process.argv[1])).filter(id => id !== deferred);
const artifacts = selected.length ? selectGeneratedArtifacts({ only: selected }) : [];
// Vitest refreshes this registered closure when its metadata stamp is cold.
const validatorArtifacts = selectGeneratedArtifacts({ only: ['stablecoin-client-registry'] });
const all = [...artifacts, ...validatorArtifacts];
if (all.some(a => a.id === deferred)) throw Error('Deferred evaluation is a required dependency; land manually');
for (const a of all) if (a.bootstrap !== true) throw Error('Not offline bootstrap-safe: ' + a.id);
const ids = artifacts.map(a => a.id);
const checkIds = artifacts.filter(a => a.checkable !== false).map(a => a.id);
console.log(JSON.stringify({ ids, checkIds,
  outputs: [...new Set(artifacts.flatMap(a => a.outputPaths))].sort(),
  generate: ids.length ? buildGeneratedArtifactExecutionPhases({ bootstrap: true, only: ids }) : [],
  check: checkIds.length ? buildGeneratedArtifactExecutionPhases({ check: true, integrityOnly: true, only: checkIds }) : [],
  pending: [deferred], validatorOutputs: [...new Set(validatorArtifacts.flatMap(a => a.outputPaths))].sort() }));
`;

function planArtifacts(root: string, paths: string[]): ArtifactPlan {
  const output = execute({ stage: "artifact plan", cwd: root, executable: process.execPath,
    args: ["--import", "tsx", "--input-type=module", "-e", ARTIFACT_PLAN, JSON.stringify(paths)] });
  const plan: ArtifactPlan = JSON.parse(output.toString());
  [...plan.outputs, ...plan.validatorOutputs].forEach(safePath);
  return plan;
}

function commands(root: string, paths: string[], artifacts: ArtifactPlan): Command[] {
  const command = (stage: string, executable: string, args: string[]) => ({ stage, cwd: root, executable, args });
  const runner = ["--import", "tsx", "scripts/maintenance/run-generated-artifacts.ts"];
  return [
    ...(artifacts.ids.length ? [command("generation", process.execPath, [...runner, "--bootstrap", `--only=${artifacts.ids.join(",")}`])] : []),
    ...(artifacts.checkIds.length ? [command("artifact checks", process.execPath,
      [...runner, "--check", "--integrity-only", `--only=${artifacts.checkIds.join(",")}`])] : []),
    command("focused checks", "npm", ["run", "check:focused", "--", ...paths.flatMap((path) => ["--file", path])]),
    command("unused code", "npm", ["run", "check:unused-code"]),
  ];
}

export function buildLandingPlan(options: LandArgs, runtime: Runtime = {}) {
  pinExecutables([options.lane, options.target, resolve(import.meta.dirname, "../..")]);
  const lane = identity(options.lane);
  const target = identity(options.target);
  if (lane.root === target.root || lane.commonDir !== target.commonDir) throw new Error("Require distinct roots sharing a Git common directory");
  idle(lane.root);
  idle(target.root);
  git(lane.root, ["diff", "--cached", "--quiet", "--exit-code"]);
  git(target.root, ["diff", "--cached", "--quiet", "--exit-code"]);
  if (changedPaths(target.root).length) throw new Error("Target must be clean, including nonignored untracked files");
  git(lane.root, ["merge-base", "--is-ancestor", lane.head, target.head]);
  const state = snapshot(lane.root);
  if (!state.paths.length) throw new Error("Empty lane changes");
  const artifacts = (runtime.planArtifacts ?? planArtifacts)(target.root, state.paths);
  outputInventory(target.root, artifacts.outputs);
  outputInventory(target.root, artifacts.validatorOutputs);
  const review = { version: 1, lane, target, paths: state.paths, files: state.files, validatorInternals: VALIDATOR_INTERNALS,
    diffSha256: hash(state.diff), messageSha256: hash(readInput(options.messageFile)), artifacts };
  return { review, diff: state.diff, commands: commands(target.root, state.paths, artifacts) };
}

function same(actual: unknown, expected: unknown, label: string) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} changed; stop and review again`);
}

function stage(root: string, paths: string[]) {
  const deleted = new Set(nul(git(root, ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=D", "-z", "--"])));
  // Cherry-pick already removed these index entries; git add cannot match absent paths.
  const toStage = paths.filter(path => !deleted.has(path) || fileState(root, path, true).mode !== "000000");
  if (toStage.length) git(root, ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], Buffer.from(`${toStage.join("\0")}\0`));
}

function stagedDiff(root: string, paths: string[]) {
  const entries = trackedDiff(root, true);
  same(sorted([...entries.keys()]), paths, "Staged paths");
  return Buffer.concat(paths.map(path => entries.get(path)!.body));
}

function indexEntries(root: string, paths: string[], tree?: string) {
  const entries = new Map(nul(git(root, tree ? ["ls-tree", "-r", "-z", tree, "--"] : ["ls-files", "--stage", "-z"]))
    .map(entry => {
      const tab = entry.indexOf("\t"), [mode, middle, last] = entry.slice(0, tab).split(" ");
      if (!tree && last !== "0") throw new Error("Unmerged index while pinning reviewed blobs");
      return [entry.slice(tab + 1), { mode, oid: tree ? last : middle }] as const;
    }));
  return paths.map(path => ({ path, ...(entries.get(path) ?? { mode: "000000", oid: null }) }));
}

function repositoryInventory(root: string) {
  const files = new Map<string, string>();
  function visit(directory: string) {
    for (const name of readdirSync(join(root, directory))) {
      if (name.toLowerCase() === ".git" || name === "node_modules") continue;
      const path = directory ? `${directory}/${name}` : name;
      const stat = lstatSync(join(root, path), { bigint: true });
      if (stat.isDirectory()) visit(path);
      // Metadata detects ignored writes without opening credentials or following symlinks.
      else files.set(path, [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"));
    }
  }
  visit("");
  return files;
}

function inventoryChanges(before: Map<string, string>, after: Map<string, string>) {
  return sorted([...before.keys(), ...after.keys()]).filter(path => before.get(path) !== after.get(path));
}

function ownsPath(path: string, pattern: string) {
  return path === pattern || matchesGlob(path, pattern) ||
    (!/[?*\[\]{}]/.test(pattern) && path.startsWith(`${pattern}/`));
}

function validatorInventory(files: Map<string, string>, outputs: string[]) {
  return new Map([...files].filter(([path]) =>
    ![...VALIDATOR_INTERNALS, ...outputs].some(pattern => ownsPath(path, pattern))));
}

function allowedPaths(paths: string[], source: string[], outputs: string[]) {
  for (const path of paths) {
    safePath(path);
    if (!source.includes(path) && !outputs.some(pattern => ownsPath(path, pattern))) {
      throw new Error(`Undeclared output write: ${JSON.stringify(path)}`);
    }
  }
}

function outputInventory(root: string, outputs: string[]) {
  const files = new Set<string>();
  function visit(path: string) {
    safePath(path);
    let stat;
    try { stat = lstatSync(join(root, path)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlink at generated output: ${path}`);
    if (stat.isDirectory()) for (const name of readdirSync(join(root, path))) visit(`${path}/${name}`);
    else if (outputs.some(pattern => ownsPath(path, pattern))) files.add(path);
  }
  for (const pattern of outputs) {
    safePath(pattern);
    const parts = pattern.split("/");
    const wildcard = parts.findIndex(part => /[?*\[\]{}]/.test(part));
    const prefix = wildcard < 0 ? parts : parts.slice(0, wildcard);
    if (!prefix.length) throw new Error(`Unbounded output ownership: ${pattern}`);
    for (let i = 1; i < prefix.length; i++) {
      const path = join(root, ...prefix.slice(0, i));
      try {
        if (!lstatSync(path).isDirectory()) throw new Error(`Unsafe output parent: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    visit(prefix.join("/"));
  }
  return sorted([...files]).map(path => fileState(root, path));
}

function commit(expected: ReturnType<typeof identity>, message: string, diff: Buffer, paths: string[], pinned: ReturnType<typeof indexEntries>) {
  const { root, head: parent } = expected;
  same(stagedDiff(root, paths), diff, "Index before commit");
  same(indexEntries(root, pinned.map(file => file.path)), pinned, "Reviewed index before commit");
  same(identity(root), expected, "Identity before commit");
  // Hooks can rewrite the reviewed index; landing commits must use exactly that index.
  git(root, ["-c", "core.hooksPath=/dev/null", "commit", "-F", message], undefined, undefined, "git commit");
  const head = identity(root).head;
  same(indexEntries(root, pinned.map(file => file.path), head), pinned, "Reviewed commit tree");
  same(identity(root), { ...expected, head }, "Identity after commit");
  same(git(root, ["rev-parse", `${head}^`]).toString().trim(), parent, "Commit parent");
  return head;
}

export function runAgentLand(argv: readonly string[] = process.argv.slice(2), runtime: Runtime = {}) {
  const options = parseAgentLandArgs(argv);
  const log = runtime.log ?? console.log;
  if (options.help) { log(USAGE); return; }
  const plan = buildLandingPlan(options, runtime);
  const reviewed = existsSync(options.review) ? JSON.parse(readInput(options.review).toString()) : null;
  if (reviewed !== null) same(plan.review, reviewed, "Review");
  log(plan.diff.toString("utf8"));
  log("Stages: stage reviewed literal lane paths; commit lane with -F message; cherry-pick --no-commit; " +
    "recheck artifact ownership; pin reviewed index blobs; generate; stage concrete output paths; validate; commit target with -F message.");
  log(`Command plan:\n${JSON.stringify(plan.commands, null, 2)}`);
  log(`Review proposal (save this JSON):\n${JSON.stringify(plan.review, null, 2)}`);
  log(`Pending final integration-head generation/check: ${DEFERRED}`);
  if (!options.apply) return plan;
  if (reviewed === null) throw new Error("Apply requires a saved version-1 review");
  same(buildLandingPlan(options, runtime).review, reviewed, "Immediate pre-stage review");
  same(JSON.parse(readInput(options.review).toString()), reviewed, "Saved review");
  const { lane, target, paths, artifacts, messageSha256 } = plan.review;
  same(identity(lane.root), lane, "Lane identity before staging");
  stage(lane.root, paths);
  same(hash(stagedDiff(lane.root, paths)), plan.review.diffSha256, "Staged lane delta");
  same(snapshot(lane.root).files, plan.review.files.map((file) => ({ ...file, untracked: false })), "Lane content");
  same(hash(readInput(options.messageFile)), messageSha256, "Message");
  const sourceCommit = commit(lane, options.messageFile, plan.diff, paths, indexEntries(lane.root, paths));
  log(`Lane commit: ${sourceCommit}`);
  same(identity(target.root), target, "Target identity");
  idle(target.root);
  git(target.root, ["diff", "--cached", "--quiet", "--exit-code"]);
  if (changedPaths(target.root).length) throw new Error("Target changed before cherry-pick");
  git(target.root, ["-c", "rerere.enabled=false", "-c", "rerere.autoupdate=false", "cherry-pick", "--no-commit", sourceCommit],
    undefined, undefined, "git cherry-pick");
  const reviewedSource = paths.filter(path => !artifacts.outputs.some(pattern => ownsPath(path, pattern)))
    .map(path => fileState(target.root, path, true));
  const pinned = indexEntries(target.root, paths);
  same((runtime.planArtifacts ?? planArtifacts)(target.root, paths), artifacts, "Combined artifact ownership");
  allowedPaths(changedPaths(target.root), paths, artifacts.outputs);
  const run = runtime.runCommand ?? ((command: Command) => { const out = execute(command); if (out.length) log(out.toString()); });
  const beforeOutputs = outputInventory(target.root, artifacts.outputs);
  const beforeFiles = repositoryInventory(target.root);
  const generation = plan.commands.find((command) => command.stage === "generation");
  same(identity(target.root), target, "Target identity before generation");
  if (generation) run(generation);
  same(identity(target.root), target, "Target identity after generation");
  same(reviewedSource.map(({ path }) => fileState(target.root, path, true)), reviewedSource, "Reviewed source after generation");
  const afterOutputs = outputInventory(target.root, artifacts.outputs);
  const afterFiles = repositoryInventory(target.root);
  allowedPaths(inventoryChanges(beforeFiles, afterFiles), paths, artifacts.outputs);
  const outputChanges = sorted([...beforeOutputs, ...afterOutputs].map(file => file.path))
    .filter(path => !isDeepStrictEqual(beforeOutputs.find(file => file.path === path), afterOutputs.find(file => file.path === path)));
  const generated = snapshot(target.root);
  allowedPaths(generated.paths, paths, artifacts.outputs);
  same(identity(target.root), target, "Target identity before staging");
  stage(target.root, generated.paths.filter(path => !paths.includes(path) && artifacts.outputs.some(pattern => ownsPath(path, pattern))));
  const combined = snapshot(target.root);
  same(repositoryInventory(target.root), afterFiles, "Repository files after staging");
  const staged = stagedDiff(target.root, combined.paths);
  same(staged, combined.diff, "Staged target delta");
  const validatorArtifacts = outputInventory(target.root, artifacts.validatorOutputs);
  for (const command of commands(target.root, sorted([...paths, ...combined.paths, ...outputChanges]), artifacts)) {
    if (command.stage !== "generation") {
      same(identity(target.root), target, "Target identity before validation");
      run(command);
    }
  }
  same(identity(target.root), target, "Target identity after validators");
  idle(target.root);
  same(snapshot(target.root), combined, "Target content after validators");
  same(outputInventory(target.root, artifacts.outputs), afterOutputs, "Generated outputs after validators");
  same(outputInventory(target.root, artifacts.validatorOutputs), validatorArtifacts, "Validator artifact content");
  same(validatorInventory(repositoryInventory(target.root), artifacts.validatorOutputs),
    validatorInventory(afterFiles, artifacts.validatorOutputs), "Repository files after validators");
  same(stagedDiff(target.root, combined.paths), staged, "Index after validators");
  same(hash(readInput(options.messageFile)), messageSha256, "Message");
  same(JSON.parse(readInput(options.review).toString()), reviewed, "Saved review");
  const targetCommit = commit(target, options.messageFile, staged, combined.paths, pinned);
  log(`Lane applied: ${sourceCommit} -> ${targetCommit}; final integration validation still required.`);
  return { sourceCommit, targetCommit };
}

runDirectCli(import.meta.url, () => runAgentLand(), { label: "[agent:land]", usage: USAGE });

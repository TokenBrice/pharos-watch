import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseStrictCliArgs, requireCliString, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { assertPinnedRuntime } from "../lib/runtime-guard.mts";

const USAGE = "agent:worktree --path P --base REF [--apply]\nPreview is read-only. Apply using the printed SHA to reproduce a preview. No fetch or credential copying.";
const PREPARE = "node --import tsx scripts/maintenance/prepare-workspace.ts";

interface WorktreeArgs {
  path: string;
  base: string;
  apply: boolean;
  help: boolean;
}

interface CommandResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  stdout?: string | null;
  stderr?: string | null;
}

interface WorktreeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  output?: (text: string) => void;
  runCommand?: (command: string, args: string[], options: {
    cwd: string; env: NodeJS.ProcessEnv; encoding: "utf8"; maxBuffer: number;
  }) => CommandResult;
}

export function parseAgentWorktreeArgs(argv: readonly string[]): WorktreeArgs {
  const { values } = parseStrictCliArgs(argv, { options: {
    path: { type: "string" }, base: { type: "string" }, apply: { type: "boolean" },
  } });
  return {
    path: values.help ? "" : requireCliString(values.path, "--path"),
    base: values.help ? "" : requireCliString(values.base, "--base"),
    apply: values.apply === true,
    help: values.help === true,
  };
}

function commands({ env = process.env, runCommand = spawnSync }: WorktreeOptions, record = (_entry: object) => {}) {
  return (stage: string, command: string, args: string[], cwd: string, environment = env): string => {
    // Lifecycle children must not inherit a donor repository or trigger a lazy fetch.
    const childEnv = { ...environment };
    for (const name of Object.keys(childEnv)) if (name.startsWith("GIT_")) delete childEnv[name];
    Object.assign(childEnv, { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" });
    const result = runCommand(command, args, { cwd, env: childEnv, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    record({ stage, command, args, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
    if (result.error || result.status !== 0 || result.signal) {
      throw new Error(`${stage}: ${command} failed (status=${result.status}, signal=${result.signal ?? "none"})${result.error ? `: ${result.error.message}` : ""}\n${result.stderr ?? ""}`);
    }
    return (result.stdout ?? "").replace(/\r?\n$/, "");
  };
}

function unusedDestination(path: string): string {
  if (lstatSync(path, { throwIfNoEntry: false })) throw new Error(`Destination already exists: ${path}`);
  const parent = dirname(path);
  if (lstatSync(parent, { throwIfNoEntry: false })) return join(realpathSync(parent), basename(path));
  return join(unusedDestination(parent), basename(path));
}

export function buildWorktreePlan(args: Pick<WorktreeArgs, "path" | "base">, options: WorktreeOptions = {}) {
  const run = commands(options);
  const cwd = options.cwd ?? process.cwd();
  const destination = unusedDestination(resolve(cwd, args.path));
  const root = realpathSync(run("repository root", "git", ["rev-parse", "--show-toplevel"], cwd));
  const commonDirectory = realpathSync(run("common directory", "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], root));
  const sha = run("resolve base", "git", ["rev-parse", "--verify", "--end-of-options", `${args.base}^{commit}`], root);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error("resolve base: invalid commit SHA");
  try {
    if (run("history", "git", ["rev-parse", "--is-shallow-repository"], root) !== "false") {
      throw new Error("history: shallow repositories are unsupported; fetch full history manually");
    }
    run("history", "git", ["rev-list", "--count", sha], root);
    const show = (path: string) => run("bootstrap revision", "git", ["show", `${sha}:${path}`], root).trim();
    const manifestSource = show("package.json");
    let manifest: { scripts?: Record<string, unknown>; workspaces?: unknown };
    try {
      manifest = JSON.parse(manifestSource);
    } catch (error) {
      throw new Error("bootstrap revision: cannot read package.json", { cause: error });
    }
    if (manifest?.scripts?.prepare !== PREPARE
      || !["bootstrap:generated", "bootstrap:generated:history"].every((name) => {
        const command = manifest.scripts?.[name];
        return typeof command === "string" && command.trim().length > 0;
      })
      || !/^v?\d+\.\d+\.\d+$/.test(show(".nvmrc"))) {
      throw new Error("bootstrap revision: unsupported prepare scripts or runtime pin");
    }
    // Only the reviewed lifecycle implementation proves ordinary plus history preparation.
    if (show("scripts/maintenance/prepare-workspace.ts") !== readFileSync(new URL("./prepare-workspace.ts", import.meta.url), "utf8").trim()) {
      throw new Error("bootstrap revision: unsupported prepare-workspace implementation");
    }
    const workspaces = manifest.workspaces ?? [];
    if (!Array.isArray(workspaces) || !workspaces.every((path): path is string =>
      typeof path === "string" && path.split("/").every((part) =>
        /^[\w.-]+$/.test(part) && ![".", "..", ".git"].includes(part)))) {
      throw new Error("bootstrap revision: unsupported literal workspace paths");
    }
    run("bootstrap revision", "git", ["cat-file", "-e", `${sha}:package-lock.json`], root);
    return { root, destination, commonDirectory, ref: args.base, sha, workspaces };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nDestination ${destination}\nSHA ${sha}`, { cause: error });
  }
}

export function runAgentWorktree(argv = process.argv.slice(2), options: WorktreeOptions = {}) {
  const args = parseAgentWorktreeArgs(argv);
  const output = options.output ?? ((text: string) => process.stdout.write(text));
  if (writeCliHelpIfRequested(args, USAGE, { write: output })) return;
  const plan = buildWorktreePlan(args, options);
  const { root, destination, commonDirectory, sha } = plan;
  output(`REF ${JSON.stringify(plan.ref)}\nSHA ${sha}\nDestination ${destination}\nPlan: detached worktree; pinned runtime; isolated npm ci --foreground-scripts --ignore-scripts=false; verify identity, install and tracked outputs.\n`);
  if (!args.apply) return plan;

  let stage = "create worktree";
  let logFd: number | undefined;
  const pending: object[] = [];
  const record = (entry: object) => {
    if (logFd === undefined) pending.push(entry);
    else writeSync(logFd, `${JSON.stringify(entry)}\n`);
  };
  const run = commands(options, record);
  const git = (...gitArgs: string[]) => run(stage, "git", gitArgs, destination);
  const verify = () => {
    if (realpathSync(destination) !== destination
      || realpathSync(git("rev-parse", "--show-toplevel")) !== destination
      || realpathSync(git("rev-parse", "--path-format=absolute", "--git-common-dir")) !== commonDirectory
      || git("rev-parse", "HEAD") !== sha
      || git("rev-parse", "--abbrev-ref", "HEAD") !== "HEAD") {
      throw new Error("Worktree identity or detached HEAD changed");
    }
    if (git("status", "--porcelain=v1", "--untracked-files=no")) throw new Error("Tracked output drift; inspect the retained worktree");
  };
  const installPaths = ["", ...plan.workspaces].map((path) => join(destination, path, "node_modules"));
  const verifyInstallParent = (path: string) => {
    for (let parent = dirname(path); parent !== destination; parent = dirname(parent)) {
      const stat = lstatSync(parent, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || realpathSync(parent) !== parent)) {
        throw new Error(`Install parent is not isolated: ${path}`);
      }
    }
  };
  try {
    unusedDestination(destination);
    run(stage, "git", ["worktree", "add", "--detach", "--", destination, sha], root);
    stage = "create log";
    git("check-ignore", "--quiet", "--no-index", "--", "agents/agent-worktree/");
    const agents = join(destination, "agents");
    if (lstatSync(agents, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("agents must not be a symlink");
    mkdirSync(agents, { recursive: true });
    const log = join(mkdtempSync(join(agents, "agent-worktree-")), "stages.jsonl");
    logFd = openSync(log, "wx", 0o600);
    for (const entry of pending) record(entry);
    output(`Log ${log}\n`);

    stage = "verify checkout";
    verify();
    const installEnv = { ...(options.env ?? process.env) };
    for (const name of ["CI", "GITHUB_ACTIONS", "PHAROS_PREPARE_BOOTSTRAP"]) delete installEnv[name];
    // npm run can carry the caller's prefix/workspace selection into a new checkout.
    for (const name of Object.keys(installEnv)) {
      if (/^npm_config_(prefix|local_prefix|global|location|workspace|workspaces)$/i.test(name)) delete installEnv[name];
    }
    stage = "runtime";
    assertPinnedRuntime({
      node: run(stage, "node", ["--version"], destination, installEnv),
      npm: run(stage, "npm", ["--version"], destination, installEnv),
    }, destination);
    stage = "install";
    for (const path of installPaths) {
      verifyInstallParent(path);
      if (lstatSync(path, { throwIfNoEntry: false })) throw new Error(`Install path already exists: ${path}`);
    }
    run(stage, "npm", ["ci", "--foreground-scripts", "--ignore-scripts=false"], destination, installEnv);
    stage = "verify installation";
    verify();
    for (const [index, path] of installPaths.entries()) {
      verifyInstallParent(path);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if ((!stat && index === 0) || (stat && (!stat.isDirectory() || realpathSync(path) !== path))) {
        throw new Error(`Install is missing or not isolated: ${path}`);
      }
    }
    record({ stage: "complete", destination, sha });
    output(`Prepared ${destination} at ${sha}. Setup verified; test readiness and scratch imports remain unverified.\n`);
    return plan;
  } catch (error) {
    const message = `${stage}: ${error instanceof Error ? error.message : String(error)}\nRetained destination ${destination}\nSHA ${sha}`;
    record({ stage, error: message });
    throw new Error(message, { cause: error });
  } finally {
    if (logFd !== undefined) closeSync(logFd);
  }
}

runDirectCli(import.meta.url, () => { runAgentWorktree(); }, { label: "agent:worktree", usage: USAGE });

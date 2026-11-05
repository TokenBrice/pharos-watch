import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { buildPrepareWorkspaceCommands as steps, runPrepareWorkspace } from "../maintenance/prepare-workspace";
import { runAgentWorktree as run } from "../maintenance/agent-worktree";
import { withTempRepo } from "./helpers/test-state";

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
it.each([
  [{}, ["bootstrap:generated", "bootstrap:generated:history"]],
  [{ GITHUB_ACTIONS: "true" }, []],
  [{ CI: "1", PHAROS_PREPARE_BOOTSTRAP: "1" }, ["bootstrap:generated"]],
])("prepare %j", (env, names) => {
  expect(steps(env)).toEqual(names.map(name => ["npm", ["run", name]]));
  const child = vi.fn(() => ({ status: 1 }));
  expect(runPrepareWorkspace({ env, runCommand: child })).toEqual({ status: names.length ? 1 : 0 });
  expect(child).toHaveBeenCalledTimes(names.length ? 1 : 0);
});
it.each([
  ["ok", null, 5], ["worktree", /create worktree:.*status=7/, 0], ["runtime", /runtime:.*requires/, 2],
  ["install", /install:.*status=7/, 3], ["signal", /install:.*SIGTERM/, 3], ["spawn", /install:.*spawn failure/, 3],
  ["prepare", /install:.*status=7/, 4], ["HEAD", /verify installation:.*identity/, 5], ["drift", /Tracked output drift/, 5],
  ["node_modules", /not isolated/, 5], ["worker/node_modules", /not isolated/, 5],
  ["shared/contracts/node_modules", /not isolated/, 5], ["existing-contracts", /install: Install path already exists/, 2],
  ["parent-contracts", /install: Install parent is not isolated/, 2],
  ["--show-toplevel", /identity/, 5],
  ["directory", /already exists/, 0], ["dangling", /already exists/, 0], ["shallow", /history: shallow/, 0],
  ["workspace", /unsupported literal workspace paths/, 0], ["rev-list", /history:.*status=7/, 0], ["unsupported", /bootstrap revision: unsupported/, 0],
] as const)("worktree %s", (fault, error, count) => {
  const files = Object.fromEntries([".nvmrc", "package.json", "scripts/maintenance/prepare-workspace.ts"].map(p => [p, fs.readFileSync(p, "utf8")]));
  if (fault === "workspace") files["package.json"] = files["package.json"].replace('"worker"', '"../outside"');
  if (fault === "unsupported") files["package.json"] = "{}";
  withTempRepo("p10", { ...files, "package-lock.json": "{}", "worker/.gitkeep": "", "shared/contracts/.gitkeep": "", ".gitignore": "agents/\n.env.local\n.dev.vars", ".env.local": "sentinel", ".dev.vars": "sentinel" }, cwd => {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
    if (fault === "existing-contracts") fs.symlinkSync(cwd, `${cwd}/shared/contracts/node_modules`);
    if (fault === "parent-contracts") {
      fs.rmSync(`${cwd}/shared`, { recursive: true });
      fs.symlinkSync(cwd, `${cwd}/shared`);
    }
    git("init"); git("config", "core.hooksPath", "/dev/null"); git("add", "."); git("commit", "-qm", "base");
    const path = `${cwd}/P`, args = ["--path", path, "--base", "HEAD"], calls: string[] = [];
    let installed = false, output = "";
    if (fault === "directory") fs.mkdirSync(path);
    if (fault === "dangling") fs.symlinkSync(`${cwd}/absent`, path);
    if (fault === "shallow") fs.writeFileSync(`${cwd}/.git/shallow`, git("rev-parse", "HEAD"));
    const index = `${cwd}/.git/index`;
    const snapshot = () => [git("status", "--porcelain"), git("worktree", "list", "--porcelain"), fs.readFileSync(index), fs.statSync(index).mtimeMs];
    const before = snapshot(), read = vi.spyOn(fs, "readFileSync");
    syncBuiltinESMExports();
    const invoke = (apply = false) => run([...args, ...(apply ? ["--apply"] : [])], {
      cwd, output: (text: string) => { output += text; },
      env: { CI: "1", GITHUB_ACTIONS: "1", PHAROS_PREPARE_BOOTSTRAP: "1" },
      runCommand(cmd, argv, opts) {
        if (cmd === "git") {
          if (installed && [3, 4].includes(count)) throw Error("late verification");
          if (argv[0] === fault) return { status: 7 };
          if (installed && argv.includes(fault)) return { status: 0, stdout: cwd };
          return spawnSync(cmd, argv, opts);
        }
        calls.push([cmd, ...argv].join(" "));
        expect(opts.cwd).toBe(path);
        for (const name of ["CI", "GITHUB_ACTIONS", "PHAROS_PREPARE_BOOTSTRAP"]) expect(opts.env[name]).toBeUndefined();
        if (argv[0] === "--version") return { status: 0, stdout: cmd === "node" ? (fault === "runtime" ? "0" : process.version) : "11.0" };
        installed = true;
        if (fault !== "node_modules") fs.mkdirSync(`${path}/node_modules`);
        if (["install", "signal", "spawn"].includes(fault)) return { status: fault === "install" ? 7 : 0, signal: fault === "signal" ? "SIGTERM" : null, error: fault === "spawn" ? Error("spawn failure") : undefined };
        const result = runPrepareWorkspace({ env: opts.env, runCommand(cmd, argv) {
          calls.push([cmd, ...argv].join(" "));
          return { status: fault === "prepare" ? 7 : 0 };
        } });
        if (fault === "HEAD") git("-C", path, "update-ref", "HEAD", git("rev-parse", "HEAD"));
        if (fault === "drift") fs.writeFileSync(`${path}/.nvmrc`, "0");
        if (fault.endsWith("node_modules")) fs.symlinkSync(cwd, `${path}/${fault}`);
        return result;
      },
    })!;
    const act = () => {
      let plan;
      try { plan = invoke(); } finally { expect(snapshot()).toEqual(before); }
      args[3] = plan.sha;
      expect(fs.existsSync(path)).toBe(false);
      git("commit", "--allow-empty", "-qm", "move");
      return invoke(true);
    };
    if (error) expect(act).toThrow(error);
    else {
      act();
      expect(git("-C", path, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "HEAD", "--abbrev-ref", "HEAD")).toBe([fs.realpathSync(path), `${cwd}/.git`, args[3], "HEAD"].join("\n"));
    }
    expect(calls).toEqual(["node --version", "npm --version", "npm ci --foreground-scripts --ignore-scripts=false", ...steps({}).map(([cmd, argv]) => [cmd, ...argv].join(" "))].slice(0, count));
    expect(output.includes("Prepared ")).toBe(!error);
    expect(!!fs.lstatSync(path, { throwIfNoEntry: false })).toBe(count !== 0 || ["directory", "dangling"].includes(fault));
    for (const name of [".env.local", ".dev.vars"]) expect(fs.existsSync(`${path}/${name}`)).toBe(false);
    expect(read.mock.calls.some(([p]) => /\.(env\.local|dev\.vars)$/.test(String(p)))).toBe(false);
  });
});

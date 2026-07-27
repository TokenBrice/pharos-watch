import { execFileSync } from "node:child_process";

function normalizePath(path) {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

export function parseChangedFileArgs(argv = [], env = process.env) {
  let base = env.PR_BASE_SHA || env.GITHUB_BASE_SHA || "origin/main";
  let head = env.PR_HEAD_SHA || env.GITHUB_HEAD_SHA || "HEAD";
  const rest = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base" || arg === "--head") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--base") base = value;
      else head = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--base=")) {
      base = arg.slice("--base=".length);
      continue;
    }
    if (arg.startsWith("--head=")) {
      head = arg.slice("--head=".length);
      continue;
    }
    rest.push(arg);
  }

  return { base, head, rest };
}

export function collectChangedFiles({
  base = "origin/main",
  cwd = process.cwd(),
  execFile = execFileSync,
  head = "HEAD",
} = {}) {
  const output = execFile(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", "-z", `${base}...${head}`],
    { cwd, encoding: "utf8" },
  );

  return [
    ...new Set(
      String(output)
        .split("\0")
        .map(normalizePath)
        .filter(Boolean),
    ),
  ].sort();
}

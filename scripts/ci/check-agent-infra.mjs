#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const errors = [];
const warnings = [];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function read(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function listFiles(path, predicate = () => true) {
  const output = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && predicate(absolute)) output.push(absolute);
    }
  };
  walk(resolve(ROOT, path));
  return output.sort();
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  return Object.fromEntries(
    match[1]
      .split("\n")
      .map((line) => line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/))
      .filter(Boolean)
      .map((entry) => [entry[1], entry[2].replace(/^['"]|['"]$/g, "")]),
  );
}

const packageJson = JSON.parse(read("package.json"));
const skillRoot = resolve(ROOT, ".codex/skills");
const skillNames = readdirSync(skillRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const name of skillNames) {
  const path = `.codex/skills/${name}/SKILL.md`;
  const body = read(path);
  const frontmatter = parseFrontmatter(body);
  if (!frontmatter?.name || !frontmatter?.description) {
    errors.push(`${path}: frontmatter must define name and description`);
  } else if (frontmatter.name !== name) {
    errors.push(`${path}: frontmatter name must match its directory`);
  }

  for (const match of body.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
    if (!packageJson.scripts?.[match[1]]) {
      errors.push(`${path}: references missing npm script ${match[1]}`);
    }
  }
  if (body.includes("/home/ahirice/Documents/git/pharos-watch")) {
    errors.push(`${path}: use repo-relative paths instead of an absolute checkout path`);
  }
}

const agentsAlias = resolve(ROOT, ".agents/skills");
if (
  !existsSync(agentsAlias) ||
  !lstatSync(agentsAlias).isSymbolicLink() ||
  realpathSync(agentsAlias) !== realpathSync(skillRoot)
) {
  errors.push(".agents/skills must be a symlink to the canonical .codex/skills directory");
}

for (const path of [
  "AGENTS.md",
  "CLAUDE.md",
  "functions/AGENTS.md",
  "shared/AGENTS.md",
  "shared/data/stablecoins/AGENTS.md",
  "src/AGENTS.md",
  "worker/AGENTS.md",
]) {
  const size = Buffer.byteLength(read(path));
  if (size > 16 * 1024) errors.push(`${path}: instruction file exceeds the 16 KiB repo budget`);
}

if (read("docs/agent-task-router.md").includes("agent-code-map.md")) {
  errors.push("docs/agent-task-router.md: references the retired generated agent code map");
}

if (existsSync(resolve(ROOT, ".cache/pharos-agent-hooks"))) {
  errors.push(".cache/pharos-agent-hooks: obsolete persistent hook state still exists");
}

for (const absolute of listFiles(".claude/workflows", (path) => path.endsWith(".mjs"))) {
  const relative = absolute.slice(ROOT.length + 1);
  const body = readFileSync(absolute, "utf8");
  if (body.includes("/home/ahirice/Documents/git/pharos-watch")) {
    errors.push(`${relative}: use workflow-relative output paths`);
  }
  if (body.includes("~/.claude/plugins/cache") || body.includes("/.claude/plugins/cache")) {
    errors.push(`${relative}: hidden user plugin-cache dependency is not portable`);
  }
  if (/Today is 20\d\d-\d\d-\d\d|all \d{3,} tracked stablecoins/.test(body)) {
    errors.push(`${relative}: embeds a volatile date or tracked-asset count`);
  }
  try {
    const wrapped = body.replace(/^import .*$/gm, "").replace(/^export\s+const\s+meta\s*=/m, "const meta =");
    new AsyncFunction("args", "log", "$", "$$", "output", wrapped);
  } catch (error) {
    errors.push(`${relative}: workflow syntax is invalid (${error instanceof Error ? error.message : String(error)})`);
  }
}

const localClaudeSettings = resolve(ROOT, ".claude/settings.local.json");
if (existsSync(localClaudeSettings)) {
  try {
    const local = JSON.parse(readFileSync(localClaudeSettings, "utf8"));
    const disabled = Object.entries(local.skillOverrides ?? {})
      .filter(([name, value]) => value === "off" && skillNames.includes(name))
      .map(([name]) => name)
      .sort();
    if (disabled.length > 0) warnings.push(`local Claude settings disable repo skills: ${disabled.join(", ")}`);
  } catch {
    warnings.push(".claude/settings.local.json could not be parsed");
  }
}

try {
  const hooksPath = execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (hooksPath !== ".githooks") warnings.push(`core.hooksPath is ${hooksPath || "unset"}; expected .githooks`);
} catch {
  warnings.push("core.hooksPath is unset; run npm run prepare or git config core.hooksPath .githooks");
}

for (const warning of warnings) console.warn(`[agent-infra] WARNING: ${warning}`);
if (errors.length > 0) {
  console.error("Agent infrastructure check failed:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`Agent infrastructure check passed (${skillNames.length} skills, ${warnings.length} local warning(s)).`);

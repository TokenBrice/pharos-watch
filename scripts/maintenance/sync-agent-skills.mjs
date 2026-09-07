#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const CANONICAL_SKILLS_PATH = ".codex/skills";
const CLAUDE_SKILLS_PATH = ".claude/skills";
const OMP_SKILLS_PATH = ".agents/skills";
// Claude does not consume this Codex-only display metadata; all other companions mirror.
const ALLOWLISTED_COMPANION_PATH = "agents/openai.yaml";

const USAGE = `Usage: node scripts/maintenance/sync-agent-skills.mjs [--check|--write]

Options:
  --check       Validate the canonical skill tree and Claude facade (default)
  --write       Create or repair Claude facade directories and symlinks
  -h, --help    Show this help`;

/** @param {string} path */
function readStats(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * @param {string} path
 * @returns {{ path: string, name: string, isDirectory: boolean, isSymlink: boolean }[] | null}
 */
function readDirectoryEntries(path) {
  const stats = readStats(path);
  if (!stats?.isDirectory()) return null;

  return readdirSync(path)
    .map((name) => {
      const entryPath = join(path, name);
      const entryStats = readStats(entryPath);
      return {
        path: entryPath,
        name,
        isDirectory: entryStats?.isDirectory() === true,
        isSymlink: entryStats?.isSymbolicLink() === true,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** @param {string} root @param {string} path */
function displayPath(root, path) {
  return relative(root, path) || ".";
}

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const childRelativePath = relative(parent, child);
  return (
    childRelativePath.length > 0
    && childRelativePath !== ".."
    && !childRelativePath.startsWith(`..${sep}`)
    && !isAbsolute(childRelativePath)
  );
}

/** @param {string} path */
function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** @param {string} rootDir @param {string} skillPath @param {string[]} violations */
function checkCanonicalSymlinks(rootDir, skillPath, violations) {
  const rootRealPath = realPath(rootDir);
  for (const entry of readDirectoryEntries(skillPath) ?? []) {
    if (entry.isSymlink) {
      const target = realPath(entry.path);
      if (!target) {
        violations.push(`${displayPath(rootDir, entry.path)} is a broken symlink`);
      } else if (!rootRealPath || (target !== rootRealPath && !isInside(rootRealPath, target))) {
        violations.push(`${displayPath(rootDir, entry.path)} resolves outside repository`);
      }
    } else if (entry.isDirectory) {
      checkCanonicalSymlinks(rootDir, entry.path, violations);
    }
  }
}

/** @param {string} facadePath @param {string} canonicalPath */
function expectedSymlinkTarget(facadePath, canonicalPath) {
  return relative(dirname(facadePath), canonicalPath).split(sep).join("/");
}

/** @param {string} rootDir @param {string[]} violations */
function checkOmpSkillsLink(rootDir, violations) {
  const ompSkillsPath = join(rootDir, OMP_SKILLS_PATH);
  const stats = readStats(ompSkillsPath);
  if (!stats) {
    violations.push(`${OMP_SKILLS_PATH} must be a symlink to ../.codex/skills`);
    return;
  }
  if (!stats.isSymbolicLink()) {
    violations.push(`${OMP_SKILLS_PATH} is not a symlink; expected ../.codex/skills`);
    return;
  }

  let target;
  try {
    target = readlinkSync(ompSkillsPath);
  } catch {
    violations.push(`${OMP_SKILLS_PATH} symlink target cannot be read`);
    return;
  }
  if (target !== "../.codex/skills") {
    violations.push(`${OMP_SKILLS_PATH} points to ${target}; expected ../.codex/skills`);
  }

  const resolvedTarget = realPath(ompSkillsPath);
  const canonicalPath = join(rootDir, CANONICAL_SKILLS_PATH);
  const canonicalRealPath = existsSync(canonicalPath) ? realPath(canonicalPath) : null;
  if (!resolvedTarget) {
    violations.push(`${OMP_SKILLS_PATH} is a broken symlink`);
  } else if (canonicalRealPath && resolvedTarget !== canonicalRealPath) {
    violations.push(`${OMP_SKILLS_PATH} does not resolve to ${CANONICAL_SKILLS_PATH}`);
  }
}

/** @param {string} frontmatterPath @param {string} skillName @param {string[]} violations */
function checkFrontmatter(frontmatterPath, skillName, violations) {
  let source;
  try {
    source = readFileSync(frontmatterPath, "utf8");
  } catch {
    violations.push(`${frontmatterPath} SKILL.md cannot be read`);
    return;
  }

  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    violations.push(`${frontmatterPath} has no YAML frontmatter opening delimiter`);
    return;
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex < 0) {
    violations.push(`${frontmatterPath} has no YAML frontmatter closing delimiter`);
    return;
  }

  let frontmatter;
  try {
    frontmatter = parseYaml(lines.slice(1, closingIndex).join("\n"));
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message.split("\n", 1)[0]}` : "";
    violations.push(`${frontmatterPath} YAML frontmatter does not parse${detail}`);
    return;
  }

  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    violations.push(`${frontmatterPath} YAML frontmatter must be a mapping`);
    return;
  }

  const name = frontmatter.name;
  const description = frontmatter.description;
  if (typeof name !== "string" || name.trim().length === 0) {
    violations.push(`${frontmatterPath} frontmatter requires a non-empty name`);
  } else if (name !== skillName) {
    violations.push(`${frontmatterPath} frontmatter name ${JSON.stringify(name)} does not match directory ${skillName}`);
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    violations.push(`${frontmatterPath} frontmatter requires a non-empty description`);
  }
}

/**
 * @param {string} skillPath
 * @returns {string[]}
 */
function collectPhysicalFiles(skillPath) {
  const stats = readStats(skillPath);
  if (!stats?.isDirectory()) return [];

  const files = [];
  for (const entry of readdirSync(skillPath)) {
    const entryPath = join(skillPath, entry);
    const entryStats = readStats(entryPath);
    if (!entryStats || entryStats.isSymbolicLink()) continue;
    if (entryStats.isDirectory()) {
      files.push(...collectPhysicalFiles(entryPath));
    } else if (entryStats.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

/** @param {string} path */
function contentHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** @param {string} rootDir @param {string[]} canonicalSkillPaths @param {string[]} facadeSkillPaths @param {string[]} violations */
function checkDuplicatePhysicalBodies(rootDir, canonicalSkillPaths, facadeSkillPaths, violations) {
  const canonicalByHash = new Map();
  for (const skillPath of canonicalSkillPaths) {
    for (const filePath of collectPhysicalFiles(skillPath)) {
      try {
        const hash = contentHash(filePath);
        const paths = canonicalByHash.get(hash) ?? [];
        paths.push(filePath);
        canonicalByHash.set(hash, paths);
      } catch {
        violations.push(`${displayPath(rootDir, filePath)} cannot be hashed`);
      }
    }
  }

  for (const skillPath of facadeSkillPaths) {
    for (const filePath of collectPhysicalFiles(skillPath)) {
      try {
        const matches = canonicalByHash.get(contentHash(filePath));
        if (matches?.length) {
          violations.push(
            `duplicate physical body ${displayPath(rootDir, filePath)} matches ${displayPath(rootDir, matches[0])}`,
          );
        }
      } catch {
        violations.push(`${displayPath(rootDir, filePath)} cannot be hashed`);
      }
    }
  }
}

/** @param {string} skillName @param {string} skillPath @param {string} entryPath */
function isAllowlistedCompanion(skillName, skillPath, entryPath) {
  if (skillName.length === 0) return false;
  const relativeEntryPath = relative(skillPath, entryPath).split(sep).join("/");
  if (relativeEntryPath === ALLOWLISTED_COMPANION_PATH) return true;
  if (relativeEntryPath !== dirname(ALLOWLISTED_COMPANION_PATH).split(sep).join("/")) return false;

  const files = collectPhysicalFiles(entryPath);
  return files.length > 0 && files.every((filePath) => (
    relative(skillPath, filePath).split(sep).join("/") === ALLOWLISTED_COMPANION_PATH
  ));
}

/** @param {string} rootDir @param {string} agentsPath */
function listAllowlistedEntries(rootDir, agentsPath) {
  const entries = collectPhysicalFiles(agentsPath);
  if (entries.length === 0) return [displayPath(rootDir, agentsPath)];
  return entries.map((entryPath) => displayPath(rootDir, entryPath));
}

/**
 * @param {string} rootDir
 * @param {string} skillName
 * @param {{ path: string, name: string, isDirectory: boolean, isSymlink: boolean }[]} canonicalEntries
 * @param {{ path: string, name: string, isDirectory: boolean, isSymlink: boolean }[]} facadeEntries
 * @param {string[]} violations
 * @param {string[]} allowlisted
 */
function checkFacadeSkill(
  rootDir,
  skillName,
  canonicalEntries,
  facadeEntries,
  violations,
  allowlisted,
) {
  const canonicalSkillPath = join(rootDir, CANONICAL_SKILLS_PATH, skillName);
  const facadeSkillPath = join(rootDir, CLAUDE_SKILLS_PATH, skillName);
  const canonicalByName = new Map(canonicalEntries.map((entry) => [entry.name, entry]));

  for (const canonicalEntry of canonicalEntries) {
    if (isAllowlistedCompanion(skillName, canonicalSkillPath, canonicalEntry.path)) {
      allowlisted.push(...listAllowlistedEntries(rootDir, canonicalEntry.path));
      continue;
    }

    if (!facadeEntries.some((entry) => entry.name === canonicalEntry.name)) {
      violations.push(
        `missing facade symlink ${displayPath(rootDir, join(facadeSkillPath, canonicalEntry.name))}`,
      );
    }
  }

  let canonicalRealPath = null;
  try {
    canonicalRealPath = realpathSync(canonicalSkillPath);
  } catch {
    // The containing skill directory was already reported as unavailable.
  }

  for (const facadeEntry of facadeEntries) {
    const facadeEntryPath = facadeEntry.path;
    const canonicalEntry = canonicalByName.get(facadeEntry.name);
    if (!canonicalEntry) {
      violations.push(`unexpected facade entry ${displayPath(rootDir, facadeEntryPath)}`);
    }

    if (!facadeEntry.isSymlink) {
      violations.push(
        facadeEntry.name === "SKILL.md"
          ? `${displayPath(rootDir, facadeEntryPath)} is a physical SKILL.md; it must be a symlink`
          : `${displayPath(rootDir, facadeEntryPath)} must be a symlink`,
      );
      continue;
    }

    let rawTarget;
    try {
      rawTarget = readlinkSync(facadeEntryPath);
    } catch {
      violations.push(`${displayPath(rootDir, facadeEntryPath)} symlink target cannot be read`);
      continue;
    }
    if (isAbsolute(rawTarget)) {
      violations.push(`${displayPath(rootDir, facadeEntryPath)} must use a relative symlink target`);
    }

    const resolvedTarget = realPath(facadeEntryPath);
    if (!resolvedTarget) {
      violations.push(`${displayPath(rootDir, facadeEntryPath)} is a broken symlink`);
      continue;
    }
    if (!canonicalRealPath || !isInside(canonicalRealPath, resolvedTarget)) {
      violations.push(
        `${displayPath(rootDir, facadeEntryPath)} resolves outside canonical skill directory`,
      );
      continue;
    }

    if (canonicalEntry) {
      let expectedRealPath = null;
      try {
        expectedRealPath = realpathSync(canonicalEntry.path);
      } catch {
        // The canonical entry was already reported as unavailable.
      }
      if (expectedRealPath && resolvedTarget !== expectedRealPath) {
        violations.push(
          `${displayPath(rootDir, facadeEntryPath)} points to ${displayPath(rootDir, resolvedTarget)}; expected ${displayPath(rootDir, canonicalEntry.path)}`,
        );
      }
    }
  }
}

/**
 * Inspect the repository-local skill layout without changing it.
 *
 * @param {string} [rootDir]
 * @returns {{ violations: string[], allowlisted: string[], canonicalSkills: string[], facadeSkills: string[] }}
 */
export function inspectAgentSkills(rootDir = process.cwd()) {
  const resolvedRoot = resolve(rootDir);
  const canonicalRoot = join(resolvedRoot, CANONICAL_SKILLS_PATH);
  const facadeRoot = join(resolvedRoot, CLAUDE_SKILLS_PATH);
  const violations = [];
  const allowlisted = [];

  const canonicalRootEntries = readDirectoryEntries(canonicalRoot);
  if (!canonicalRootEntries) {
    violations.push(`${CANONICAL_SKILLS_PATH} must be an existing directory`);
  }
  const facadeRootEntries = readDirectoryEntries(facadeRoot);
  if (!facadeRootEntries) {
    violations.push(`${CLAUDE_SKILLS_PATH} must be an existing directory`);
  }

  checkOmpSkillsLink(resolvedRoot, violations);

  const canonicalSkillEntries = new Map(
    (canonicalRootEntries ?? [])
      .filter((entry) => entry.isDirectory)
      .map((entry) => [entry.name, entry]),
  );
  const facadeSkillEntries = new Map(
    (facadeRootEntries ?? [])
      .filter((entry) => entry.isDirectory)
      .map((entry) => [entry.name, entry]),
  );

  for (const entry of canonicalRootEntries ?? []) {
    if (!entry.isDirectory) {
      violations.push(`${displayPath(resolvedRoot, entry.path)} must be a skill directory`);
    }
  }
  for (const entry of facadeRootEntries ?? []) {
    if (!entry.isDirectory) {
      violations.push(`${displayPath(resolvedRoot, entry.path)} must be a skill directory`);
    }
  }

  for (const skillName of [...canonicalSkillEntries.keys()].sort()) {
    if (!facadeSkillEntries.has(skillName)) {
      violations.push(`missing facade skill directory ${displayPath(resolvedRoot, join(facadeRoot, skillName))}`);
    }
  }
  for (const skillName of [...facadeSkillEntries.keys()].sort()) {
    if (!canonicalSkillEntries.has(skillName)) {
      violations.push(`unexpected facade skill directory ${displayPath(resolvedRoot, join(facadeRoot, skillName))}`);
    }
  }

  const canonicalSkillPaths = [];
  const facadeSkillPaths = [...facadeSkillEntries.values()].map((entry) => entry.path);
  for (const skillName of [...canonicalSkillEntries.keys()].sort()) {
    const canonicalSkillPath = canonicalSkillEntries.get(skillName).path;
    canonicalSkillPaths.push(canonicalSkillPath);
    checkCanonicalSymlinks(resolvedRoot, canonicalSkillPath, violations);
    checkFrontmatter(join(canonicalSkillPath, "SKILL.md"), skillName, violations);

    const facadeSkillEntry = facadeSkillEntries.get(skillName);
    if (!facadeSkillEntry) continue;
    const facadeEntries = readDirectoryEntries(facadeSkillEntry.path);
    if (!facadeEntries) {
      violations.push(`${displayPath(resolvedRoot, facadeSkillEntry.path)} must be a directory`);
      continue;
    }
    const canonicalEntries = readDirectoryEntries(canonicalSkillPath) ?? [];
    checkFacadeSkill(
      resolvedRoot,
      skillName,
      canonicalEntries,
      facadeEntries,
      violations,
      allowlisted,
    );
  }

  checkDuplicatePhysicalBodies(resolvedRoot, canonicalSkillPaths, facadeSkillPaths, violations);

  return {
    violations: [...new Set(violations)],
    allowlisted: [...new Set(allowlisted)].sort(),
    canonicalSkills: [...canonicalSkillEntries.keys()].sort(),
    facadeSkills: [...facadeSkillEntries.keys()].sort(),
  };
}

/** @param {string} rootDir */
function repairFacade(rootDir) {
  const resolvedRoot = resolve(rootDir);
  const canonicalRoot = join(resolvedRoot, CANONICAL_SKILLS_PATH);
  const facadeRoot = join(resolvedRoot, CLAUDE_SKILLS_PATH);
  const changes = [];
  const canonicalRootEntries = readDirectoryEntries(canonicalRoot);
  if (!canonicalRootEntries) return changes;

  const canonicalSkillEntries = canonicalRootEntries.filter((entry) => entry.isDirectory);
  const facadeRootStats = readStats(facadeRoot);
  if (!facadeRootStats) {
    mkdirSync(facadeRoot, { recursive: true });
    changes.push(`created directory ${displayPath(resolvedRoot, facadeRoot)}`);
  } else if (!facadeRootStats.isDirectory()) {
    return changes;
  }

  for (const skillEntry of canonicalSkillEntries) {
    const skillName = skillEntry.name;
    const canonicalSkillPath = skillEntry.path;
    const facadeSkillPath = join(facadeRoot, skillName);
    const facadeSkillStats = readStats(facadeSkillPath);
    if (!facadeSkillStats) {
      mkdirSync(facadeSkillPath, { recursive: true });
      changes.push(`created directory ${displayPath(resolvedRoot, facadeSkillPath)}`);
    } else if (!facadeSkillStats.isDirectory()) {
      continue;
    }

    const canonicalEntries = readDirectoryEntries(canonicalSkillPath) ?? [];
    for (const canonicalEntry of canonicalEntries) {
      const facadeEntryPath = join(facadeSkillPath, canonicalEntry.name);
      const shouldCreateMissing = !isAllowlistedCompanion(skillName, canonicalSkillPath, canonicalEntry.path);
      const facadeEntryStats = readStats(facadeEntryPath);
      if (!facadeEntryStats) {
        if (!shouldCreateMissing) continue;
        const target = expectedSymlinkTarget(facadeEntryPath, canonicalEntry.path);
        symlinkSync(target, facadeEntryPath);
        changes.push(`created symlink ${displayPath(resolvedRoot, facadeEntryPath)} -> ${target}`);
        continue;
      }
      if (!facadeEntryStats.isSymbolicLink()) continue;

      const expectedTarget = expectedSymlinkTarget(facadeEntryPath, canonicalEntry.path);
      let currentTarget;
      try {
        currentTarget = readlinkSync(facadeEntryPath);
      } catch {
        currentTarget = null;
      }
      if (currentTarget !== expectedTarget) {
        unlinkSync(facadeEntryPath);
        symlinkSync(expectedTarget, facadeEntryPath);
        changes.push(
          `repaired symlink ${displayPath(resolvedRoot, facadeEntryPath)} -> ${expectedTarget}`,
        );
      }
    }
  }

  return changes;
}

/**
 * Check the skill facade, optionally repairing only its directories and symlinks.
 *
 * @param {{ rootDir?: string, write?: boolean }} [options]
 * @returns {{ status: number, changes: string[], violations: string[], allowlisted: string[], canonicalSkills: string[], facadeSkills: string[] }}
 */
export function syncAgentSkills({ rootDir = process.cwd(), write = false } = {}) {
  const changes = write ? repairFacade(rootDir) : [];
  const inspection = inspectAgentSkills(rootDir);
  return {
    status: inspection.violations.length > 0 ? 1 : 0,
    changes,
    ...inspection,
  };
}

/** @param {readonly string[]} argv */
export function parseAgentSkillsArgs(argv) {
  const { values } = parseStrictCliArgs(argv, {
    conflicts: [["check", "write"]],
    options: {
      check: { type: "boolean" },
      write: { type: "boolean" },
    },
  });
  return {
    check: values.check === true || values.write !== true,
    help: values.help === true,
    write: values.write === true,
  };
}

/** @param {readonly string[]} argv @param {string} [rootDir] */
export function runAgentSkillsCli(argv = process.argv.slice(2), rootDir = process.cwd()) {
  const options = parseAgentSkillsArgs(argv);
  if (writeCliHelpIfRequested(options, USAGE)) return 0;

  const result = syncAgentSkills({ rootDir, write: options.write });
  for (const change of result.changes) console.log(`[sync-agent-skills] ${change}`);
  for (const violation of result.violations) console.error(`[sync-agent-skills] ${violation}`);

  if (result.status !== 0) return result.status;
  if (result.changes.length === 0 && options.write) {
    console.log("[sync-agent-skills] --write: no changes needed");
  }
  console.log(
    `[sync-agent-skills] OK (${result.canonicalSkills.length} skills; ${result.allowlisted.length} allowlisted companion entr${result.allowlisted.length === 1 ? "y" : "ies"})`,
  );
  return 0;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => {
    const status = runAgentSkillsCli();
    if (status !== 0) process.exitCode = status;
  }, { label: "sync-agent-skills", usage: USAGE });
}

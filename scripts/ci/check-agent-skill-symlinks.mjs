#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = process.cwd();
const roots = [".agents", ".claude/skills", ".codex/skills"];
const waiverPath = "scripts/lib/agent-skill-symlink-waivers.json";
const waivers = JSON.parse(readFileSync(resolve(root, waiverPath), "utf8"));
const dateOnlyRe = /^\d{4}-\d{2}-\d{2}$/;

function normalize(path) {
  return path.replaceAll("\\", "/");
}

function isInsideRepo(absPath) {
  const rel = normalize(relative(root, absPath));
  return rel === "" || (!rel.startsWith("../") && rel !== "..");
}

function collectSymlinks(baseRel) {
  const out = [];
  const baseAbs = resolve(root, baseRel);

  function walk(absDir) {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const absPath = join(absDir, entry.name);
      const relPath = normalize(relative(root, absPath));
      const stat = lstatSync(absPath);
      if (stat.isSymbolicLink()) {
        out.push(relPath);
        continue;
      }
      if (stat.isDirectory()) walk(absPath);
    }
  }

  walk(baseAbs);
  return out;
}

const symlinkPaths = roots.flatMap(collectSymlinks).sort();
const symlinkSet = new Set(symlinkPaths);
const errors = [];

const canonicalSkillsRoot = resolve(root, ".codex/skills");
const claudeSkillsRoot = resolve(root, ".claude/skills");
const sharedSkillsAlias = resolve(root, ".agents/skills");
const canonicalSkillNames = readdirSync(canonicalSkillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (!existsSync(sharedSkillsAlias) || !lstatSync(sharedSkillsAlias).isSymbolicLink()) {
  errors.push(".agents/skills: required cross-agent skill discovery alias is missing");
} else if (realpathSync(sharedSkillsAlias) !== realpathSync(canonicalSkillsRoot)) {
  errors.push(".agents/skills: alias must resolve to .codex/skills");
}

for (const name of canonicalSkillNames) {
  const claudeEntrypoint = resolve(claudeSkillsRoot, name, "SKILL.md");
  const canonicalEntrypoint = resolve(canonicalSkillsRoot, name, "SKILL.md");
  if (!existsSync(claudeEntrypoint)) {
    errors.push(`.claude/skills/${name}/SKILL.md: mirror is missing`);
    continue;
  }
  if (!lstatSync(claudeEntrypoint).isSymbolicLink()) {
    errors.push(`.claude/skills/${name}/SKILL.md: mirror must be a symlink`);
    continue;
  }
  if (realpathSync(claudeEntrypoint) !== realpathSync(canonicalEntrypoint)) {
    errors.push(`.claude/skills/${name}/SKILL.md: mirror does not resolve to the canonical skill`);
  }
}

for (const [relPath, waiver] of Object.entries(waivers)) {
  if (!symlinkSet.has(relPath)) {
    errors.push(`${relPath}: waiver is stale; symlink no longer exists`);
  }
  if (!waiver || typeof waiver !== "object") {
    errors.push(`${relPath}: waiver metadata is missing`);
    continue;
  }
  if (typeof waiver.owner !== "string" || waiver.owner.trim() === "") {
    errors.push(`${relPath}: waiver owner is required`);
  }
  if (typeof waiver.reason !== "string" || waiver.reason.trim() === "") {
    errors.push(`${relPath}: waiver reason is required`);
  }
  if (typeof waiver.reviewAfter !== "string" || !dateOnlyRe.test(waiver.reviewAfter)) {
    errors.push(`${relPath}: waiver reviewAfter must be YYYY-MM-DD`);
  }
}

for (const relPath of symlinkPaths) {
  const absPath = resolve(root, relPath);
  const target = readlinkSync(absPath);
  let realTarget;
  try {
    realTarget = realpathSync(resolve(dirname(absPath), target));
  } catch {
    if (!waivers[relPath]) {
      errors.push(`${relPath}: broken symlink -> ${target}`);
    }
    continue;
  }
  if (!isInsideRepo(realTarget) && !waivers[relPath]) {
    errors.push(`${relPath}: external symlink target requires a waiver (${target})`);
  }
}

if (errors.length > 0) {
  console.error("Agent skill symlink check failed:");
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

console.log(`Agent skill symlink check passed (${symlinkPaths.length} symlink(s)).`);

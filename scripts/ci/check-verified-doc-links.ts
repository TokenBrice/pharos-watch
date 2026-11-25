#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { collectMarkdownFiles, getVerifiedDocFiles, iterInlineCodeSpans, splitLines } from "../lib/doc-files.mts";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import { reportViolations } from "../lib/report-violations.mts";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { collectMarkdownReferences, requiresDocNavigation } from "../lib/doc-markdown.mts";
import { PUBLIC_DOC_BY_SLUG, preparePublicDocMarkdown } from "../../shared/lib/public-docs.ts";

const USAGE = `Usage: node --import tsx scripts/ci/check-verified-doc-links.ts [--skills-only]

Options:
  --skills-only   Check only the agent skill tree (links, source paths, scripts, artifact ids, symbol homes)
  -h, --help      Show this help`;

const NAVIGATION_SCAN_LINES = 20;
const ROOT_PATH_PREFIXES = [
  ".agents/",
  ".ci/",
  ".claude/",
  ".codex/",
  ".github/",
  "data/",
  "docs/",
  "functions/",
  "public/",
  "scripts/",
  "shared/",
  "src/",
  "worker/",
];

const ROOT_FILE_NAMES = new Set([
  ".env.example",
  ".gitleaksignore",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "next.config.ts",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
  "tsconfig.typecheck.json",
  "vitest.config.ts",
]);

// Cited by design while absent from a clean checkout: an ignored per-checkout
// file and a policy file that only exists once it has been qualified.
const OPTIONAL_PATHS = new Set([
  ".ci/safety-score-v9-resource-budget.json",
  ".codex/hooks.json",
]);

interface HistoricalCandidate {
  revision: string;
  path: string;
}


function trimToken(token: string): string {
  return stripLineColumnSuffix(token
    .trim()
    .replace(/^[("'[{]+/, "")
    .replace(/[)"'\]},.;]+$/, ""));
}

function isUnsignedInteger(value: string): boolean {
  if (value.length === 0) return false;
  for (const char of value) {
    if (char < "0" || char > "9") return false;
  }
  return true;
}

function stripLineColumnSuffix(value: string): string {
  const parts = value.split(":");
  if (parts.length <= 1 || !isUnsignedInteger(parts.at(-1) ?? "")) {
    return value;
  }
  parts.pop();
  if (parts.length > 1 && isUnsignedInteger(parts.at(-1) ?? "")) {
    parts.pop();
  }
  return parts.join(":");
}

function shouldSkipCandidate(candidate: string): boolean {
  return (
    candidate.length === 0 ||
    candidate.endsWith("/") ||
    candidate.includes("*") ||
    candidate.includes("<") ||
    candidate.includes(">") ||
    candidate.includes("{") ||
    candidate.includes("}") ||
    candidate.includes("...") ||
    candidate.includes("$") ||
    candidate.includes("\\")
  );
}

function isRepoPathCandidate(candidate: string): boolean {
  if (ROOT_FILE_NAMES.has(candidate) || /^[\w.-]+\.config\.[cm]?[jt]s$/.test(candidate)) return true;
  return ROOT_PATH_PREFIXES.some((prefix) => candidate.startsWith(prefix));
}

function normalizeCandidate(token: string): string | null {
  const stripped = trimToken(token).split("#", 1)[0];
  if (!isRepoPathCandidate(stripped) || shouldSkipCandidate(stripped) || OPTIONAL_PATHS.has(stripped)) {
    return null;
  }
  return stripped;
}

function parseHistoricalCandidate(token: string): HistoricalCandidate | null {
  const stripped = trimToken(token);
  const match = stripped.match(/^git:([0-9a-f]{7,40}):(.+)$/i);
  if (!match) return null;
  const [, revision = "", path = ""] = match;
  if (!isRepoPathCandidate(path) || shouldSkipCandidate(path)) return null;
  return { revision, path };
}

interface ResolvedDocTarget {
  filePath: string;
  fragment: string | null;
}

function hasExplicitScheme(target: string): boolean {
  const colonIndex = target.indexOf(":");
  if (colonIndex <= 0) return false;

  const firstSlashIndex = target.indexOf("/");
  const firstHashIndex = target.indexOf("#");
  const firstBoundaryIndex = [firstSlashIndex, firstHashIndex]
    .filter((index) => index >= 0)
    .reduce((min, index) => Math.min(min, index), Number.POSITIVE_INFINITY);

  if (firstBoundaryIndex < colonIndex) {
    return false;
  }

  for (let index = 0; index < colonIndex; index += 1) {
    const char = target[index].toLowerCase();
    const isLetter = char >= "a" && char <= "z";
    if (!isLetter) {
      return false;
    }
  }

  return true;
}

function isExternalTarget(target: string): boolean {
  return target.startsWith("mailto:") || target.includes("://") || hasExplicitScheme(target);
}

function resolveDocTarget(sourceFile: string, target: string, repoRoot: string): ResolvedDocTarget {
  const [rawPath, rawFragment] = target.split("#", 2);
  const fragment = rawFragment?.trim() || null;

  if (!rawPath) {
    return { filePath: sourceFile, fragment };
  }

  if (rawPath.startsWith("/")) {
    return {
      filePath: resolve(repoRoot, rawPath.slice(1)),
      fragment,
    };
  }

  return {
    filePath: resolve(dirname(sourceFile), rawPath),
    fragment,
  };
}

export function collectAdrNavigationViolations(content: string): string[] {
  const headings: string[] = [];
  const navigation: string[] = [];
  for (const line of splitLines(content)) {
    const heading = /^#### ADR-(\d+)\s*$/.exec(line);
    if (heading) headings.push(heading[1]);
    if (line.startsWith("Read an individual decision rather than the entire record collection:")) {
      for (const entry of line.matchAll(/\(#adr-(\d+)\)/g)) navigation.push(entry[1]);
    }
  }

  const violations: string[] = [];
  const headingIds = new Set(headings);
  const navigationIds = new Set(navigation);
  for (const id of headingIds) {
    if (!navigationIds.has(id)) {
      violations.push(`docs/architecture.md: ADR-${id} heading is missing from the ADR quick-nav`);
    }
  }
  for (const id of navigationIds) {
    if (!headingIds.has(id)) {
      violations.push(`docs/architecture.md: ADR-${id} quick-nav entry has no heading`);
    }
  }
  for (const [label, ids] of [["heading", headings], ["quick-nav entry", navigation]] as const) {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
    }
    for (const id of duplicates) {
      violations.push(`docs/architecture.md: duplicate ADR-${id} ${label}`);
    }
  }
  return violations;
}

export function collectNavigationBlockViolations(
  filePaths: readonly string[],
  repoRoot = process.cwd(),
): string[] {
  const violations: string[] = [];

  for (const filePath of filePaths) {
    const content = readFileSync(filePath, "utf8");
    const lines = splitLines(content);
    if (relative(repoRoot, filePath).replaceAll("\\", "/") === "docs/architecture.md") {
      violations.push(...collectAdrNavigationViolations(content));
    }
    if (!requiresDocNavigation(content)) continue;

    const hasTopNavigation = lines
      .slice(0, NAVIGATION_SCAN_LINES)
      .some((line) => line.startsWith("> **Agent navigation**"));
    if (!hasTopNavigation) {
      violations.push(
        `${relative(repoRoot, filePath)}: docs at or above 400 lines or 50 KB must include a top `
          + `\`> **Agent navigation**\` block (docs/README.md#documentation-rules)`,
      );
    }
  }

  return violations;
}

export function collectLinkViolations(filePaths: readonly string[], repoRoot: string): string[] {
  const errors: string[] = [];
  const anchorCache = new Map<string, Set<string>>();

  for (const filePath of filePaths) {
    const content = readFileSync(filePath, "utf8");

    for (const target of collectMarkdownReferences(content).links) {
      if (!target) continue;
      const publicDocLink = /^https:\/\/pharos\.watch\/docs\/([^/?#]+)/.exec(target);
      if (!publicDocLink && isExternalTarget(target)) continue;

      const publicDoc = publicDocLink ? PUBLIC_DOC_BY_SLUG.get(publicDocLink[1]) : undefined;
      if (publicDocLink && !publicDoc) {
        errors.push(`${relative(repoRoot, filePath)} -> ${target}: unknown public documentation slug "${publicDocLink[1]}"`);
        continue;
      }

      const resolvedTarget = publicDoc
        ? {
          filePath: resolve(repoRoot, "docs", publicDoc.source),
          fragment: target.split("#", 2)[1]?.trim() || null,
        }
        : resolveDocTarget(filePath, target, repoRoot);
      const repoRelative = relative(repoRoot, resolvedTarget.filePath).replaceAll("\\", "/");
      if (repoRelative === ".." || repoRelative.startsWith("../") || isAbsolute(repoRelative)) {
        errors.push(`${relative(repoRoot, filePath)} -> ${target}: absolute path is outside the repo`);
        continue;
      }
      if (!existsSync(resolvedTarget.filePath) || !statSync(resolvedTarget.filePath).isFile()) {
        errors.push(`${relative(repoRoot, filePath)} -> ${target}: target file does not exist`);
        continue;
      }

      if (!resolvedTarget.fragment) continue;

      const anchorCacheKey = publicDoc ? `public:${resolvedTarget.filePath}` : resolvedTarget.filePath;
      if (!anchorCache.has(anchorCacheKey)) {
        const markdown = readFileSync(resolvedTarget.filePath, "utf8");
        const renderedMarkdown = publicDoc ? preparePublicDocMarkdown(markdown, { stripTitle: true }) : markdown;
        anchorCache.set(anchorCacheKey, collectMarkdownReferences(renderedMarkdown).anchors);
      }

      const anchors = anchorCache.get(anchorCacheKey);
      if (!anchors || !anchors.has(resolvedTarget.fragment)) {
        errors.push(
          `${relative(repoRoot, filePath)} -> ${target}: missing heading anchor "#${resolvedTarget.fragment}" in ${relative(repoRoot, resolvedTarget.filePath)}`,
        );
      }
    }
  }

  return errors;
}
export function collectSourcePathViolations(filePaths: readonly string[], repoRoot: string): string[] {
  const errors: string[] = [];
  for (const filePath of filePaths) {
    const content = readFileSync(filePath, "utf8");
    for (const span of iterInlineCodeSpans(content)) {
      for (const rawToken of span.value.split(/\s+/)) {
        const historical = parseHistoricalCandidate(rawToken);
        if (historical) {
          const result = spawnSync("git", ["cat-file", "-e", `${historical.revision}:${historical.path}`], {
            cwd: repoRoot,
            stdio: "ignore",
          });
          if (result.status !== 0) {
            errors.push(`${relative(repoRoot, filePath)}:${span.line}: ${historical.revision}:${historical.path} does not exist`);
          }
          continue;
        }
        const candidate = normalizeCandidate(rawToken);
        if (!candidate) continue;
        const resolved = resolve(repoRoot, candidate);
        const repoRelative = relative(repoRoot, resolved);
        if (repoRelative === ".." || repoRelative.startsWith("../") || isAbsolute(repoRelative)) {
          errors.push(`${relative(repoRoot, filePath)}:${span.line}: ${candidate} resolves outside the repo`);
          continue;
        }
        if (!existsSync(resolved) || (!statSync(resolved).isFile() && !statSync(resolved).isDirectory())) {
          errors.push(`${relative(repoRoot, filePath)}:${span.line}: ${candidate} does not exist`);
        }
      }
    }
  }
  return errors;
}

export interface SkillReferenceCatalog {
  npmScripts: ReadonlySet<string>;
  /** Accepted only on a line that names the `worker` workspace. */
  workerScripts: ReadonlySet<string>;
  artifactIds: ReadonlySet<string>;
}

function loadSkillReferenceCatalog(repoRoot: string): SkillReferenceCatalog {
  const scriptsOf = (packagePath: string) => new Set(Object.keys(
    (JSON.parse(readFileSync(resolve(repoRoot, packagePath), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {},
  ));
  return {
    npmScripts: scriptsOf("package.json"),
    workerScripts: scriptsOf("worker/package.json"),
    artifactIds: new Set(GENERATED_ARTIFACT_REGISTRY.map((artifact) => artifact.id)),
  };
}

/** A name that only reaches the file through an import or a comment is not its home. */
function declaresSymbol(source: string, symbol: string): boolean {
  return source
    .replace(/\bimport\s[^;]*?\sfrom\s*["'][^"']+["'];?/gs, "")
    .replace(/\/\/.*$/gm, "")
    .split(/[^\w$]+/)
    .includes(symbol);
}

/**
 * Skill bodies are procedures agents execute, so a renamed script, artifact id
 * or moved symbol sends a run down a dead path. Cite a symbol as
 * `` `SYMBOL` in `repo/path.ts` `` to have its home checked.
 */
export function collectSkillReferenceViolations(
  filePaths: readonly string[],
  repoRoot: string,
  catalog: SkillReferenceCatalog = loadSkillReferenceCatalog(repoRoot),
): string[] {
  const errors: string[] = [];
  for (const filePath of filePaths) {
    const label = relative(repoRoot, filePath);
    for (const [index, line] of splitLines(readFileSync(filePath, "utf8")).entries()) {
      const where = `${label}:${index + 1}`;
      for (const [, rawName = ""] of line.matchAll(/\bnpm run ([A-Za-z0-9][\w:.-]*)/g)) {
        const name = rawName.replace(/[.:]+$/, "");
        if (!catalog.npmScripts.has(name) && !(catalog.workerScripts.has(name) && /\bworker\b/.test(line))) {
          errors.push(`${where}: npm run ${name} is not a package script`);
        }
      }
      if (line.includes("generated")) {
        for (const [, ids = ""] of line.matchAll(/--only(?:=|\s+)([a-z0-9,-]+)/g)) {
          for (const id of ids.split(",").filter(Boolean)) {
            if (!catalog.artifactIds.has(id)) errors.push(`${where}: --only=${id} is not a generated artifact id`);
          }
        }
      }
      for (const [, symbol = "", rawPath = ""] of line.matchAll(/`([A-Za-z_$][\w$]*)(?:\(\))?` (?:in|from) `([^`\s]+)`/g)) {
        const candidate = normalizeCandidate(rawPath);
        if (!candidate || !/\.(?:ts|tsx|mts|mjs|json)$/.test(candidate)) continue;
        const sourcePath = resolve(repoRoot, candidate);
        if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) continue;
        if (!declaresSymbol(readFileSync(sourcePath, "utf8"), symbol)) {
          errors.push(`${where}: ${symbol} is not in ${candidate}`);
        }
      }
    }
  }
  return errors;
}

export function main(repoRoot = process.cwd(), { skillsOnly = false }: { skillsOnly?: boolean } = {}): number {
  const verifiedDocFiles = skillsOnly ? [] : getVerifiedDocFiles(repoRoot);
  const skillsRoot = resolve(repoRoot, ".codex/skills");
  const skillFiles = existsSync(skillsRoot) ? collectMarkdownFiles(skillsRoot) : [];
  const errors = [
    ...collectLinkViolations([...verifiedDocFiles, ...skillFiles], repoRoot),
    ...collectNavigationBlockViolations(verifiedDocFiles, repoRoot),
    ...collectSourcePathViolations([...verifiedDocFiles, ...skillFiles], repoRoot),
    ...collectSkillReferenceViolations(skillFiles, repoRoot),
  ];

  return reportViolations({
    label: skillsOnly ? "Agent skill references" : "Verified documentation links",
    heading: skillsOnly ? "Agent skill reference check failed" : "Verified documentation link check failed",
    violations: errors,
    scannedCount: verifiedDocFiles.length + skillFiles.length,
  });
}

runDirectCli(import.meta.url, () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: { "skills-only": { type: "boolean" } } });
  if (writeCliHelpIfRequested({ help: values.help === true }, USAGE)) return;
  process.exitCode = main(process.cwd(), { skillsOnly: values["skills-only"] === true });
}, { label: "check-verified-doc-links", usage: USAGE });

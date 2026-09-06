#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { getVerifiedDocFiles, splitLines } from "../lib/doc-files.mts";
import { reportViolations } from "../lib/report-violations.mts";
import { runAsCli } from "../lib/source-files.mts";
import { collectMarkdownReferences, requiresDocNavigation } from "../lib/doc-markdown.mts";

const NAVIGATION_SCAN_LINES = 20;

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

export function collectNavigationBlockViolations(
  filePaths: readonly string[],
  repoRoot = process.cwd(),
): string[] {
  const violations: string[] = [];

  for (const filePath of filePaths) {
    const content = readFileSync(filePath, "utf8");
    const lines = splitLines(content);
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
      if (!target || isExternalTarget(target)) continue;

      const resolvedTarget = resolveDocTarget(filePath, target, repoRoot);
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

      if (!anchorCache.has(resolvedTarget.filePath)) {
        anchorCache.set(resolvedTarget.filePath, collectMarkdownReferences(readFileSync(resolvedTarget.filePath, "utf8")).anchors);
      }

      const anchors = anchorCache.get(resolvedTarget.filePath);
      if (!anchors || !anchors.has(resolvedTarget.fragment)) {
        errors.push(
          `${relative(repoRoot, filePath)} -> ${target}: missing heading anchor "#${resolvedTarget.fragment}" in ${relative(repoRoot, resolvedTarget.filePath)}`,
        );
      }
    }
  }

  return errors;
}

export function main(repoRoot = process.cwd()): number {
  const verifiedDocFiles = getVerifiedDocFiles(repoRoot);
  const errors = [
    ...collectLinkViolations(verifiedDocFiles, repoRoot),
    ...collectNavigationBlockViolations(verifiedDocFiles, repoRoot),
  ];

  return reportViolations({
    label: "Verified documentation links",
    heading: "Verified documentation link check failed",
    violations: errors,
    scannedCount: verifiedDocFiles.length,
  });
}

runAsCli(import.meta.url, main);

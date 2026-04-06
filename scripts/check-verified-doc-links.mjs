#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const repoRoot = process.cwd();
const docsRoot = resolve(repoRoot, "docs");
const verifiedDocFiles = [
  resolve(repoRoot, "README.md"),
  ...collectMarkdownFiles(docsRoot),
];

function collectMarkdownFiles(rootDir) {
  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(entryPath));
      continue;
    }
    if (entry.isFile() && extname(entry.name) === ".md") {
      files.push(entryPath);
    }
  }
  return files;
}

function splitLines(text) {
  return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function stripMarkdownLinks(text) {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function collapseRepeatedChar(text, char) {
  let result = "";
  let previousWasChar = false;

  for (const current of text) {
    if (current === char) {
      if (!previousWasChar) {
        result += current;
      }
      previousWasChar = true;
      continue;
    }
    previousWasChar = false;
    result += current;
  }

  return result;
}

function slugifyHeading(text) {
  let normalized = stripMarkdownLinks(text.trim().toLowerCase()).replace(/[`*~]/g, "");
  let result = "";

  for (const char of normalized) {
    const isLetterOrNumber = /[\p{Letter}\p{Number}]/u.test(char);
    if (isLetterOrNumber || char === "_" || char === "-" || /\s/u.test(char)) {
      result += char;
    }
  }

  result = result.trim().replace(/\s+/g, "-");
  return collapseRepeatedChar(result, "-");
}

function collectAnchors(filePath) {
  const anchors = new Set();
  const duplicateCounts = new Map();
  let inFence = false;

  for (const line of splitLines(readFileSync(filePath, "utf8"))) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (!headingMatch) continue;

    const baseSlug = slugifyHeading(headingMatch[1]);
    if (!baseSlug) continue;

    const seenCount = duplicateCounts.get(baseSlug) ?? 0;
    duplicateCounts.set(baseSlug, seenCount + 1);
    anchors.add(seenCount === 0 ? baseSlug : `${baseSlug}-${seenCount}`);
  }

  return anchors;
}

function hasExplicitScheme(target) {
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

function isExternalTarget(target) {
  return target.startsWith("mailto:") || target.includes("://") || hasExplicitScheme(target);
}

function resolveDocTarget(sourceFile, target) {
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

function stripEnclosingAngleBrackets(value) {
  if (value.startsWith("<") && value.endsWith(">") && value.length > 1) {
    return value.slice(1, -1);
  }
  return value;
}

function findClosingBracket(line, startIndex) {
  let depth = 0;

  for (let index = startIndex; index < line.length; index += 1) {
    const char = line[index];
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function findLinkTargetEnd(line, startIndex) {
  if (line[startIndex] === "<") {
    const end = line.indexOf(">", startIndex + 1);
    return end >= 0 ? end : -1;
  }

  let nestedParens = 0;

  for (let index = startIndex; index < line.length; index += 1) {
    const char = line[index];
    if (char === "(") {
      nestedParens += 1;
      continue;
    }
    if (char === ")") {
      if (nestedParens === 0) {
        return index;
      }
      nestedParens -= 1;
      continue;
    }
  }

  return -1;
}

function* iterMarkdownLinks(content) {
  let inFence = false;

  for (const line of splitLines(content)) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    for (let index = 0; index < line.length; index += 1) {
      const startsImage = line[index] === "!" && line[index + 1] === "[";
      const bracketIndex = startsImage ? index + 1 : index;
      if (line[bracketIndex] !== "[") continue;

      const closingBracket = findClosingBracket(line, bracketIndex);
      if (closingBracket < 0 || line[closingBracket + 1] !== "(") {
        continue;
      }

      const targetStart = closingBracket + 2;
      const targetEnd = findLinkTargetEnd(line, targetStart);
      if (targetEnd < 0) {
        continue;
      }

      yield stripEnclosingAngleBrackets(line.slice(targetStart, targetEnd).trim());
      index = targetEnd;
    }
  }
}

const errors = [];
const anchorCache = new Map();

for (const filePath of verifiedDocFiles) {
  const content = readFileSync(filePath, "utf8");

  for (const target of iterMarkdownLinks(content)) {
    if (!target || isExternalTarget(target)) continue;

    const resolvedTarget = resolveDocTarget(filePath, target);
    if (!resolvedTarget.filePath.startsWith(repoRoot)) {
      errors.push(`${relative(repoRoot, filePath)} -> ${target}: absolute path is outside the repo`);
      continue;
    }
    if (!existsSync(resolvedTarget.filePath) || !statSync(resolvedTarget.filePath).isFile()) {
      errors.push(`${relative(repoRoot, filePath)} -> ${target}: target file does not exist`);
      continue;
    }

    if (!resolvedTarget.fragment) continue;

    if (!anchorCache.has(resolvedTarget.filePath)) {
      anchorCache.set(resolvedTarget.filePath, collectAnchors(resolvedTarget.filePath));
    }

    const anchors = anchorCache.get(resolvedTarget.filePath);
    if (!anchors.has(resolvedTarget.fragment)) {
      errors.push(
        `${relative(repoRoot, filePath)} -> ${target}: missing heading anchor "#${resolvedTarget.fragment}" in ${relative(repoRoot, resolvedTarget.filePath)}`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error("Verified documentation link check failed:");
  for (const error of errors) {
    console.error(`  ${error}`);
  }
  process.exit(1);
}

console.log(`Verified documentation links passed for ${verifiedDocFiles.length} files.`);

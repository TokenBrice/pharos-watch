#!/usr/bin/env node

/**
 * Banned-phrase lint for the Stablecoin Picker surface.
 *
 * Scans the engine editorial templates, the Selector route hard-coded copy,
 * Selector components, and checked-in editorial worked examples for
 * marketing/recommendation phrases that violate the Selector editorial policy.
 *
 * Patterns intentionally use negative lookbehind / lookahead so that legitimate compound forms
 * (e.g. "safer", "safety", "safely", "safeguard", "unsafe", "Safety Score") do not trigger.
 *
 * To allow an intentional use of a banned phrase on a single line (e.g. test fixtures or this
 * script itself documenting the patterns), append the comment marker:
 *
 *     // banned-phrase-allow: <reason>
 *
 * Anywhere on the same line. Lines containing the marker are skipped entirely.
 *
 * Wired into `scripts/lib/validate-contract.mjs` as
 * `npm run check:selector-banned-phrases`; runs as a prebuild gate, not via ESLint.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), "..", "..");

const SCAN_TARGETS = [
  { kind: "file", path: "shared/lib/selector/what-to-watch-templates.ts" },
  { kind: "file", path: "shared/lib/selector/why-keys.ts" },
  { kind: "dir", path: "shared/lib/selector", extensions: [".ts"], excludeBasenames: ["why-keys.ts", "what-to-watch-templates.ts"] },
  { kind: "dir", path: "src/app/screener/picker", extensions: [".ts", ".tsx"] },
  { kind: "dir", path: "src/components/selector", extensions: [".ts", ".tsx"] },
  {
    kind: "file",
    path: "scripts/fixtures/selector-editorial-examples.md",
  },
];

// Banned-phrase regexes (per spec §11 revisions). Each entry is `{ name, re }`.
// Patterns use the global flag plus per-match position tracking so we can report line numbers.
const BANNED_PATTERNS = [
  { name: "Pharos recommends", re: /\bPharos\s+recommends?\b/gi },
  { name: "Top pick", re: /\btop\s+pick\b/gi },
  // "Safe" without the qualifying suffix family (safer, safety, safely, safeguard) and without
  // a preceding alphabetic char (unsafe, etc.).
  { name: "Safe (unqualified)", re: /(?<![A-Za-z-])safe(?![A-Za-z])/gi },
  { name: "Best yield-bearing", re: /\bbest\s+yield(?:-|\s+)bearing\b/gi },
  { name: "Trusted by", re: /\btrusted\s+by\b/gi },
  { name: "Battle-tested", re: /\bbattle(?:-|\s+)tested\b/gi },
  { name: "Probably/likely/reliably (epistemic hedge)", re: /\b(?:probably|likely|reliably)\b/gi },
  { name: "We recommend (buy/hold/use)", re: /\bwe recommend (?:you )?(?:buy|hold|use)\b/gi },
  { name: "Easy/simple/convenient", re: /\b(?:easy|simple|convenient)\b/gi },
  { name: "Strongest current reading on that axis", re: /\bstrongest\s+current\s+reading\s+on\s+that\s+axis\b/gi },
  { name: "Deprecated rail", re: /\bdeprecated\s+rail\b/gi },
  { name: "Cannot tolerate", re: /\bcannot\s+tolerate\b/gi },
  // Imperative "use X for venue-access/custody/yield/trading" — narrow on Selector profile vocab.
  { name: "Use [X] for [venue/custody/yield/trading]", re: /\buse\s+\w+\s+for\s+(?:venue\s+access|custody|yield|trading)\b/gi },
  { name: "Surfaced opportunities", re: /\bsurfaced\s+opportunities\b/gi },
  { name: "Hold safely", re: /\bhold\s+safely\b/gi },
  // Raw key fallbacks: these stay narrow so type declarations, fixtures, and editorial
  // documentation can still name keys while visible fallback code cannot print them.
  { name: "Raw whyKey join fallback", re: /\bwhyKeys\b[^\n]*\.join\s*\(/gi },
  { name: "Raw reasonKey interpolation fallback", re: /\$\{\s*(?:entry\.)?reasonKey\s*\}/g },
];

const ALLOW_MARKER = "banned-phrase-allow:";

async function pathExists(absPath) {
  try {
    await stat(absPath);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

async function collectFiles(target) {
  const abs = join(REPO_ROOT, target.path);
  if (target.kind === "file") {
    if (!(await pathExists(abs))) {
      throw new Error(`required scan target missing: ${target.path}`);
    }
    return [{ path: abs, sectionBounds: null }];
  }
  if (!(await pathExists(abs))) {
    throw new Error(`required scan target missing: ${target.path}`);
  }
  const stats = await stat(abs);
  if (!stats.isDirectory()) {
    return [];
  }
  const extensions = target.extensions ?? [];
  const excludeBasenames = new Set(target.excludeBasenames ?? []);
  const acc = [];
  await walkDir(abs, extensions, excludeBasenames, acc);
  return acc.map((path) => ({ path, sectionBounds: null }));
}

async function walkDir(absDir, extensions, excludeBasenames, acc) {
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "__tests__") continue;
    const entryPath = join(absDir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(entryPath, extensions, excludeBasenames, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    if (excludeBasenames.has(entry.name)) continue;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    if (extensions.length === 0 || extensions.some((ext) => entry.name.endsWith(ext))) {
      acc.push(entryPath);
    }
  }
}

function findLineNumber(source, charIndex) {
  // 1-indexed line number for the offset `charIndex` in `source`.
  let line = 1;
  for (let i = 0; i < charIndex && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function findLine(source, charIndex) {
  let start = charIndex;
  while (start > 0 && source.charCodeAt(start - 1) !== 10) {
    start -= 1;
  }
  let end = charIndex;
  while (end < source.length && source.charCodeAt(end) !== 10) {
    end += 1;
  }
  return source.slice(start, end);
}

function resolveSectionBounds(source, sectionBounds) {
  if (!sectionBounds) return { startIndex: 0, endIndex: source.length };
  const startIndex = source.indexOf(sectionBounds.startHeading);
  if (startIndex < 0) {
    throw new Error(`startHeading "${sectionBounds.startHeading}" not found`);
  }
  const endSearchFrom = startIndex + sectionBounds.startHeading.length;
  const endIndex = source.indexOf(sectionBounds.endHeading, endSearchFrom);
  return {
    startIndex,
    endIndex: endIndex < 0 ? source.length : endIndex,
  };
}

async function scanFile(file) {
  const findings = [];
  let source;
  try {
    source = await readFile(file.path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return findings;
    throw err;
  }
  return scanSource(file.path, source, file.sectionBounds);
}

function scanSource(filePath, source, sectionBounds = null) {
  const findings = [];
  let bounds;
  try {
    bounds = resolveSectionBounds(source, sectionBounds);
  } catch (err) {
    console.error(`check:selector-banned-phrases: ${relative(REPO_ROOT, filePath)}: ${err.message}`);
    findings.push({
      file: filePath,
      line: 1,
      rule: "section-bound-error",
      match: "",
      excerpt: err.message,
    });
    return findings;
  }
  for (const rule of BANNED_PATTERNS) {
    rule.re.lastIndex = 0;
    let match;
    while ((match = rule.re.exec(source)) !== null) {
      const matchStart = match.index;
      if (matchStart < bounds.startIndex || matchStart >= bounds.endIndex) continue;
      const lineText = findLine(source, matchStart);
      if (lineText.includes(ALLOW_MARKER)) continue;
      findings.push({
        file: filePath,
        line: findLineNumber(source, matchStart),
        rule: rule.name,
        match: match[0],
        excerpt: lineText.trim().slice(0, 160),
      });
    }
  }
  return findings;
}

async function main() {
  const filesToScan = [];
  const seenKeys = new Set();
  for (const target of SCAN_TARGETS) {
    const files = await collectFiles(target);
    for (const file of files) {
      const key = `${file.path}|${file.sectionBounds ? `${file.sectionBounds.startHeading}->${file.sectionBounds.endHeading}` : "all"}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      filesToScan.push(file);
    }
  }

  const findings = [];
  for (const file of filesToScan) {
    const fileFindings = await scanFile(file);
    findings.push(...fileFindings);
  }

  if (findings.length === 0) {
    console.log(`check:selector-banned-phrases: ok (scanned ${filesToScan.length} file${filesToScan.length === 1 ? "" : "s"})`);
    return 0;
  }

  console.error(`check:selector-banned-phrases: ${findings.length} banned-phrase hit${findings.length === 1 ? "" : "s"}`);
  for (const finding of findings) {
    const rel = relative(REPO_ROOT, finding.file);
    console.error(`  ${rel}:${finding.line}  [${finding.rule}] "${finding.match}"`);
    console.error(`    ${finding.excerpt}`);
  }
  console.error("");
  console.error("Allow a specific occurrence by appending  // banned-phrase-allow: <reason>  on the same line.");
  return 1;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  const exitCode = await main();
  process.exit(exitCode);
}

export {
  BANNED_PATTERNS,
  collectFiles,
  scanSource,
  scanFile,
};

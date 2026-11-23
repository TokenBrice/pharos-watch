#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { compileSheet, encodePlan, type CompactPlan, type SelectorMatch } from "beasties/compiler";
import { createProcessor } from "beasties/runtime";
import { runDirectCli } from "../lib/cli-args.mjs";
import { gatedHtmlRoutes } from "./report-build-size.mjs";

// `gates` narrows the pass to the HTML routes whose bytes the artifact gates
// measure, plus the largest exported pages so the blocking largest-HTML ceiling
// always measures an inlined page. Anything else (including unset) keeps the
// full public pass.
export const CRITICAL_CSS_SCOPE_GATES = "gates";
export const GATE_SCOPED_LARGEST_HTML_PAGES = 3;

export function collectCriticalCssPages(outDir: string): string[] {
  return readdirSync(outDir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !path.relative(outDir, file).startsWith(`admin${path.sep}`))
    .sort();
}

/**
 * Gate-scoped selection is a subset of the public pass. A missing gate route or
 * an unrecognised scope falls back to the full pass so a scoped run never
 * processes less than the artifact gates can prove. The largest pre-inline
 * pages are always included because `largestHtmlBytes` measures every exported
 * HTML file; without them a non-gate page could overtake the gate routes and
 * the PR build would measure its un-inlined size.
 */
export function selectCriticalCssPages(
  outDir: string,
  scope: string | undefined = process.env.PHAROS_CRITICAL_CSS_SCOPE,
  pages: readonly string[] = collectCriticalCssPages(outDir),
): string[] {
  if (scope !== CRITICAL_CSS_SCOPE_GATES) return [...pages];
  const relative = new Set(pages.map((file) => path.relative(outDir, file).split(path.sep).join("/")));
  const routes = gatedHtmlRoutes();
  if (routes.length === 0 || !routes.every((route) => relative.has(route))) return [...pages];
  const largest = [...pages]
    .map((file) => ({ file, size: statSync(file).size }))
    .sort((a, b) => b.size - a.size || a.file.localeCompare(b.file))
    .slice(0, GATE_SCOPED_LARGEST_HTML_PAGES)
    .map((entry) => entry.file);
  return [...new Set([...routes.map((route) => path.join(outDir, ...route.split("/"))), ...largest])].sort();
}

export function criticalCssWorkerCount(pageCount: number): number {
  const override = process.env.PHAROS_CRITICAL_CSS_WORKERS;
  const requested = override === undefined ? availableParallelism() - 1 : Number(override);
  if (override !== undefined && (!Number.isSafeInteger(requested) || requested < 1)) {
    throw new Error("PHAROS_CRITICAL_CSS_WORKERS must be a positive integer.");
  }
  return Math.max(1, Math.min(requested, pageCount));
}

// Bust the previous loader's one-week public cache when changing activation timing.
const asyncCssLoaderPath = "/critical-css-loader.js?v=2";
const asyncStylesheetPattern =
  /<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\/_next\/static\/(?:chunks|css)\/[^"']+\.css)(?=[^>]*\bmedia=["']print["'])(?=[^>]*\bonload=["']this\.media\s*=\s*["']all["']["'])[^>]*>/gi;
// Share metadata Next emits after its stylesheets and scripts. React escapes `>`
// in attribute values, so a tag ends at its first `>`.
const shareMetadataPattern =
  /<title\b[^>]*>[\s\S]*?<\/title>|<meta\b(?=[^>]*\b(?:name|property)=["'](?:description|og:[^"']*|twitter:[^"']*|article:[^"']*)["'])[^>]*>|<link\b(?=[^>]*\brel=["']canonical["'])[^>]*>/gi;

/**
 * Link-preview crawlers read only the start of a page (Slack fetches about the
 * first 32 KB), so the title, description, canonical and og/twitter/article tags
 * move, in document order, to just before the inlined critical style. The style
 * stays ahead of the stylesheets it stands in for.
 */
function hoistShareMetadata(html: string): string {
  const styleStart = html.search(/<style\b/);
  const styleClose = styleStart < 0 ? -1 : html.indexOf("</style>", styleStart);
  const headEnd = html.indexOf("</head>");
  if (styleClose < 0 || headEnd < styleClose) return html;
  const styleEnd = styleClose + "</style>".length;
  const rest = html.slice(styleEnd, headEnd);
  const tags = rest.match(shareMetadataPattern);
  if (!tags) return html;
  return html.slice(0, styleStart) + tags.join("") + html.slice(styleStart, styleEnd)
    + rest.replace(shareMetadataPattern, "") + html.slice(headEnd);
}

interface OptimizationResult {
  beforeBytes: number;
  afterBytes: number;
  skipped?: boolean;
}

const logLevels = ["trace", "debug", "info", "warn", "error", "silent"] as const;
type LogLevel = Exclude<(typeof logLevels)[number], "silent">;
interface OptimizationLog {
  level: LogLevel;
  message: string;
}

export interface PageOptimizationResult extends OptimizationResult {
  label: string;
  logs: OptimizationLog[];
}

// Beasties drops leading selector functions (`:where(...)`, `:is(...)`) unless
// listed in `allowRules`; `compileCriticalCssPlans` keeps them during parsing
// and immediately narrows each `match[i] === true` entry to a DOM token check.
// `.dark` theme tokens are matched naturally via `<html class="dark">` without
// forcing unused `.dark:*` utility classes onto every page.
const CRITICAL_CSS_ALLOW_RULES: Array<string | RegExp> = [
  /^:(?:where|is)\(/,
  // Header's portalled Sheet is absent from SSR; keep its viewport, rail and motion rules.
  ".fixed", ".inset-0", ".inset-y-0", ".left-0", ".z-modal", ".h-full", ".w-full", ".sm\\:max-w-full",
  ".overflow-y-auto", ".min-h-16", ".min-w-14", ".grid-cols-2", ".gap-4", ".mt-2",
  ".border-r", ".border-border\\/45", ".border-transparent", ".bg-black\\/50", ".bg-card", ".bg-muted", ".bg-muted\\/60",
  ".p-0", ".py-4", ".pt-3", ".pl-\\[14px\\]", ".pb-\\[calc\\(env\\(safe-area-inset-bottom\\)\\+0\\.5rem\\)\\]",
  ".leading-tight", ".tabular-nums", ".shadow-lg", ".transition", ".transition-\\[background-color\\,border-color\\,color\\,box-shadow\\]",
  ".\\[animation-fill-mode\\:backwards\\]", ".fade-in", ".slide-in-from-left-2", ".slide-in-from-right-2",
  /^\.(?:motion-reduce\\:)?data-\\\[state\\=(?:open|closed)\\\]\\:(?:animate-|duration-|fade-|slide-)/,
  ".motion-reduce\\:animate-none",
];

function unescapeCssIdent(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_, group: string) =>
    group.length > 1 && /^[0-9a-fA-F]/.test(group)
      ? String.fromCodePoint(Number.parseInt(group.trim(), 16))
      : group,
  );
}

/**
 * Keeps only strictly conjunctive selector segments: drops `:not(...)`
 * arguments and any parenthesized group containing a top-level `,` alternation
 * so every extracted token is mandatory across all matching branches.
 */
function extractMandatorySelectorSegments(selector: string): string {
  let out = "";
  let index = 0;
  while (index < selector.length) {
    const ch = selector[index]!;
    if (ch === "\\") {
      out += selector.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (ch === "[") {
      let cursor = index + 1;
      while (cursor < selector.length && selector[cursor] !== "]") {
        cursor += selector[cursor] === "\\" ? 2 : 1;
      }
      out += selector.slice(index, Math.min(cursor + 1, selector.length));
      index = Math.min(cursor + 1, selector.length);
      continue;
    }
    if (ch === "(") {
      let depth = 1;
      let cursor = index + 1;
      let inBrackets = false;
      let hasTopLevelComma = false;
      while (cursor < selector.length && depth > 0) {
        const c = selector[cursor]!;
        if (c === "\\") {
          cursor += 2;
          continue;
        }
        if (c === "[") inBrackets = true;
        else if (c === "]") inBrackets = false;
        else if (!inBrackets) {
          if (c === "(") depth += 1;
          else if (c === ")") depth -= 1;
          else if (c === "," && depth === 1) hasTopLevelComma = true;
        }
        cursor += 1;
      }
      const inner = selector.slice(index + 1, cursor - 1);
      if (/:not$/i.test(out)) {
        out = out.slice(0, -4);
      } else if (!hasTopLevelComma) {
        out += `(${extractMandatorySelectorSegments(inner)})`;
      } else {
        out += " ";
      }
      index = cursor;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

// Index just past the CSS identifier at `start`. Backslash escapes (`\[`,
// `\32 `) stay inside it, so a Tailwind class such as
// `.group-data-\[expanded\=false\]\/evidence\:hidden` is one token.
function cssIdentEnd(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length) {
    const ch = input[cursor]!;
    if (ch === "\\") {
      cursor += 1;
      let hexCount = 0;
      while (cursor < input.length && hexCount < 6 && /[0-9a-fA-F]/.test(input[cursor]!)) {
        cursor += 1;
        hexCount += 1;
      }
      if (hexCount > 0) {
        if (cursor < input.length && /\s/.test(input[cursor]!)) cursor += 1;
      } else if (cursor < input.length) {
        cursor += 1;
      }
      continue;
    }
    if (!/[A-Za-z0-9_-]/.test(ch)) break;
    cursor += 1;
  }
  return cursor;
}

// Index just past the `]` or `)` that closes `input[start]`, stepping over
// escapes and quoted strings.
function blockEnd(input: string, start: number): number {
  const open = input[start]!;
  const close = open === "[" ? "]" : ")";
  let depth = 0;
  let quote = "";
  for (let cursor = start; cursor < input.length; cursor += 1) {
    const ch = input[cursor]!;
    if (ch === "\\") cursor += 1;
    else if (quote) quote = ch === quote ? "" : quote;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === open) depth += 1;
    else if (ch === close && --depth === 0) return cursor + 1;
  }
  return input.length;
}

// Pseudo-classes whose arguments are selectors (`:not(...)` is already removed
// by `extractMandatorySelectorSegments`). Other arguments (`:nth-child(odd)`,
// `:lang(en)`, `::part(x)`) are skipped, never read as tags.
const SELECTOR_ARGUMENT_PSEUDOS = new Set(["is", "where", "has"]);

export function narrowFunctionalSelectorMatch(selector: string): SelectorMatch {
  const mandatory = extractMandatorySelectorSegments(selector);
  const classes = new Set<string>();
  const attrs = new Set<string>();
  const tags = new Set<string>();
  let compoundStart = true;
  let index = 0;
  while (index < mandatory.length) {
    const ch = mandatory[index]!;
    if (ch === "." || ch === "#") {
      const end = cssIdentEnd(mandatory, index + 1);
      if (ch === "." && end > index + 1) classes.add(unescapeCssIdent(mandatory.slice(index + 1, end)));
      index = end;
      compoundStart = false;
    } else if (ch === "[") {
      let nameStart = index + 1;
      while (/\s/.test(mandatory[nameStart] ?? "")) nameStart += 1;
      const nameEnd = cssIdentEnd(mandatory, nameStart);
      if (nameEnd > nameStart) attrs.add(unescapeCssIdent(mandatory.slice(nameStart, nameEnd)).toLowerCase());
      index = blockEnd(mandatory, index);
      compoundStart = false;
    } else if (ch === ":") {
      const nameStart = mandatory[index + 1] === ":" ? index + 2 : index + 1;
      index = cssIdentEnd(mandatory, nameStart);
      const name = mandatory.slice(nameStart, index).toLowerCase();
      if (mandatory[index] === "(" && !SELECTOR_ARGUMENT_PSEUDOS.has(name)) index = blockEnd(mandatory, index);
      compoundStart = false;
    } else if (compoundStart && /[a-zA-Z]/.test(ch)) {
      const end = cssIdentEnd(mandatory, index);
      tags.add(unescapeCssIdent(mandatory.slice(index, end)).toLowerCase());
      index = end;
      compoundStart = false;
    } else {
      compoundStart = /[\s(>+,~]/.test(ch);
      index += 1;
    }
  }
  if (classes.size === 0 && attrs.size === 0 && tags.size === 0) return true;
  return {
    ...(classes.size > 0 ? { classes: [...classes] } : {}),
    ...(attrs.size > 0 ? { attrs: [...attrs] } : {}),
    ...(tags.size > 0 ? { tags: [...tags] } : {}),
  };
}

function collectStylesheetFiles(outDir: string): string[] {
  return readdirSync(outDir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !path.relative(outDir, file).startsWith(`admin${path.sep}`))
    .sort();
}

export function compileCriticalCssPlans(outDir: string): { plans: CompactPlan[]; warnings: string[] } {
  const warnings: string[] = [];
  const plans: CompactPlan[] = [];
  for (const cssFile of collectStylesheetFiles(outDir)) {
    const href = `/${path.relative(outDir, cssFile).split(path.sep).join("/")}`;
    const sheet = compileSheet(readFileSync(cssFile, "utf8"), {
      href,
      allowRules: CRITICAL_CSS_ALLOW_RULES,
      exact: true,
    });
    // Fonts are never inlined or preloaded (`fonts: false, inlineFonts: false`).
    // Dropping @font-face rules also prevents beasties/runtime from enabling
    // full-text unicode-range codepoint scanning and busting its page cache.
    // Pointer-hover rules (`@media (hover:hover)`) cannot affect initial paint
    // and activate as soon as the async stylesheet loads.
    sheet.rules = sheet.rules.filter(
      (rule) => !rule.fontFace && !rule.wrap?.some((wrap) => /\(\s*hover\s*:\s*hover\s*\)/i.test(wrap)),
    );
    for (const rule of sheet.rules) {
      if (!rule.selectors || !rule.match) continue;
      for (let index = 0; index < rule.selectors.length; index += 1) {
        const selector = rule.selectors[index]!;
        if (rule.match[index] === true && /^:(?:where|is)\(/.test(selector)) {
          rule.match[index] = narrowFunctionalSelectorMatch(selector);
        }
      }
    }
    warnings.push(...sheet.warnings);
    plans.push(encodePlan(sheet));
  }
  return { plans, warnings };
}

// beasties/runtime scans `html.toLowerCase()` but slices attribute values from
// the original by the same indices. U+0130 is the only code point whose
// lowercase changes UTF-16 length, so each one would shift every later class
// read; a same-length noncharacter without case mapping stands in for it.
const LENGTH_CHANGING_LOWERCASE = "\u0130";
const LOWERCASE_PLACEHOLDER = "\uFDD0";

function resolveLogThreshold(): number {
  const raw = process.env.BEASTIES_LOG_LEVEL || "error";
  const index = logLevels.indexOf(raw as (typeof logLevels)[number]);
  return index >= 0 ? index : logLevels.indexOf("error");
}

function partitionFilesBySize(files: readonly string[], poolSize: number): string[][] {
  const weighted = files
    .map((file) => ({ file, size: statSync(file).size }))
    .sort((left, right) => right.size - left.size || left.file.localeCompare(right.file));
  const partitions = Array.from({ length: poolSize }, () => ({ bytes: 0, files: [] as string[] }));
  for (const entry of weighted) {
    let lightest = partitions[0]!;
    for (let index = 1; index < partitions.length; index += 1) {
      if (partitions[index]!.bytes < lightest.bytes) lightest = partitions[index]!;
    }
    lightest.files.push(entry.file);
    lightest.bytes += entry.size;
  }
  return partitions.map((partition) => partition.files).filter((partition) => partition.length > 0);
}

// A worker owns one compiled-plan processor and processes its partition
// sequentially. Source CSS is never pruned, so workers only write their own HTML.
export async function optimizeCriticalCssBatch(
  outDir: string,
  filePaths: string[],
  plans?: CompactPlan[],
): Promise<PageOptimizationResult[]> {
  const threshold = resolveLogThreshold();
  const logWarn = logLevels.indexOf("warn") >= threshold;
  const compiled = plans ? { plans, warnings: [] as string[] } : compileCriticalCssPlans(outDir);
  let logs: OptimizationLog[] = [];
  const processor = createProcessor(compiled.plans, {
    preload: "media",
    inlineFonts: false,
    fonts: false,
    cache: { maxSize: 2000 },
    logger: logWarn ? { warn: (message) => logs.push({ level: "warn", message }) } : undefined,
  });
  const results: PageOptimizationResult[] = [];
  for (let index = 0; index < filePaths.length; index += 1) {
    const filePath = filePaths[index]!;
    logs = index === 0 && logWarn
      ? compiled.warnings.map((message) => ({ level: "warn" as const, message }))
      : [];
    const label = path.relative(path.dirname(outDir), filePath);
    const result = optimizePage(processor, filePath, label);
    results.push({ ...result, label, logs });
  }
  return results;
}

export async function optimizeCriticalCssPages(
  outDir: string,
  filePaths: string[],
  workerCount = criticalCssWorkerCount(filePaths.length),
): Promise<PageOptimizationResult[]> {
  const files = [...filePaths].sort();
  if (files.length === 0) return [];
  const { plans, warnings } = compileCriticalCssPlans(outDir);
  const threshold = resolveLogThreshold();
  const compileLogs: OptimizationLog[] = logLevels.indexOf("warn") >= threshold
    ? warnings.map((message) => ({ level: "warn", message }))
    : [];
  const poolSize = Math.min(workerCount, files.length);
  if (poolSize === 1) {
    const results = await optimizeCriticalCssBatch(outDir, files, plans);
    if (results.length > 0 && compileLogs.length > 0) {
      results[0]!.logs = [...compileLogs, ...results[0]!.logs];
    }
    return results;
  }

  const partitions = partitionFilesBySize(files, poolSize);
  const workers: Worker[] = [];
  try {
    const pending = partitions.map((partition) => {
      // scripts/maintenance/critical-css-worker.mjs registers tsx in the worker
      // before importing this module, without relying on inherited loader hooks.
      const worker = new Worker(new URL("./critical-css-worker.mjs", import.meta.url), {
        workerData: { outDir, filePaths: partition, plans },
      });
      workers.push(worker);
      return new Promise<PageOptimizationResult[]>((resolve, reject) => {
        let received = false;
        worker.once("message", (results: PageOptimizationResult[]) => {
          received = true;
          resolve(results);
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (!received) reject(new Error(`Critical CSS worker exited without results (code ${code}).`));
        });
      });
    });
    const results = (await Promise.all(pending)).flat().sort((a, b) =>
      a.label < b.label ? -1 : a.label > b.label ? 1 : 0,
    );
    if (results.length > 0 && compileLogs.length > 0) {
      results[0]!.logs = [...compileLogs, ...results[0]!.logs];
    }
    return results;
  } finally {
    // In particular, stop the other partitions before reporting a page failure.
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

function optimizePage(
  processor: ReturnType<typeof createProcessor>,
  filePath: string,
  label: string,
): OptimizationResult {
  const before = readFileSync(filePath, "utf8");

  // Re-running Beasties on an already-optimized page re-attaches onload
  // handlers and duplicates the style block; treat processed pages as done.
  if (before.includes('data-pharos-critical-css="async"')) {
    const bytes = Buffer.byteLength(before);
    return { beforeBytes: bytes, afterBytes: bytes, skipped: true };
  }

  const htmlTag = before.match(/<html\b[^>]*>/i)?.[0];
  if (!htmlTag) throw new Error(`${label}: missing HTML root for theme extraction.`);
  if (before.includes(LOWERCASE_PLACEHOLDER)) {
    throw new Error(`${label}: contains U+FDD0, the reserved U+0130 placeholder.`);
  }
  // Match runtime dark variants without shipping a forced theme to the browser.
  const darkHtmlTag = /\sclass\s*=/i.test(htmlTag)
    ? htmlTag.replace(/(\sclass\s*=\s*)(["'])(.*?)\2/i, "$1$2$3 dark$2")
    : htmlTag.replace(/>$/, ' class="dark">');
  // Portfolio's before-paint bootstrap selects these rules before full CSS loads.
  const extractionHtmlTag = before.includes('src="/portfolio-bootstrap.js"')
    ? darkHtmlTag.replace(/>$/, " data-portfolio-empty>")
    : darkHtmlTag;
  let after = processor.process(
    before.replace(htmlTag, extractionHtmlTag).replaceAll(LENGTH_CHANGING_LOWERCASE, LOWERCASE_PLACEHOLDER),
  )
    .replaceAll(LOWERCASE_PLACEHOLDER, LENGTH_CHANGING_LOWERCASE)
    .replace(/<html\b[^>]*>/i, htmlTag);

  // Scope async stylesheet rewriting and loader insertion to <head> so huge
  // inline RSC <script> payloads in <body> are never scanned by link regexes.
  const headCloseIndex = after.search(/<\/head>/i);
  const headSlice = headCloseIndex >= 0 ? after.slice(0, headCloseIndex) : after;
  const tailSlice = headCloseIndex >= 0 ? after.slice(headCloseIndex) : "";

  let hasAsyncStylesheet = false;
  let rewrittenHead = headSlice.replace(asyncStylesheetPattern, (tag) => {
    hasAsyncStylesheet = true;
    const withoutInlineHandler = tag.replace(/\s+onload=["']this\.media\s*=\s*["']all["']["']/i, "");

    if (/\sdata-pharos-critical-css=/.test(withoutInlineHandler)) {
      return withoutInlineHandler;
    }

    return withoutInlineHandler.replace(/\s*\/?>$/, ' data-pharos-critical-css="async">');
  });

  if (hasAsyncStylesheet && !rewrittenHead.includes(`src="${asyncCssLoaderPath}"`)) {
    const lastLink = [...rewrittenHead.matchAll(/<link\b[^>]*data-pharos-critical-css="async"[^>]*>/g)].at(-1)!;
    const insertAt = lastLink.index + lastLink[0].length;
    rewrittenHead = `${rewrittenHead.slice(0, insertAt)}<script src="${asyncCssLoaderPath}" async></script>${rewrittenHead.slice(insertAt)}`;
  }
  after = hoistShareMetadata(rewrittenHead + tailSlice);

  const withoutNoscript = after.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");

  if (!/<style\b[^>]*>/.test(after)) {
    throw new Error(`${label}: Beasties did not inline a critical style block.`);
  }

  if (/<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\/_next\/static\/(?:chunks|css)\/[^"']+\.css)(?![^>]*\bmedia=["']print["'])[^>]*>/i.test(withoutNoscript)) {
    throw new Error(`${label}: still has a render-blocking Next CSS link outside <noscript>.`);
  }

  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(withoutNoscript)) {
    throw new Error(`${label}: contains an inline event handler outside <noscript>.`);
  }

  if (hasAsyncStylesheet && !after.includes(`<script src="${asyncCssLoaderPath}" async></script>`)) {
    throw new Error(`${label}: has async critical CSS without the CSP-safe async loader script.`);
  }

  if (after !== before) {
    writeFileSync(filePath, after);
  }

  return { beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after) };
}

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const outDir = path.join(root, "out");
  if (!existsSync(path.join(outDir, "index.html"))) {
    console.error("[critical-css] Missing out/index.html. Run next build first.");
    process.exit(1);
  }

  const scope = process.env.PHAROS_CRITICAL_CSS_SCOPE;
  const allPages = collectCriticalCssPages(outDir);
  const pages = selectCriticalCssPages(outDir, scope, allPages);
  const startedAt = Date.now();
  try {
    const results = await optimizeCriticalCssPages(outDir, pages);
    // Worker completion order cannot reorder diagnostics.
    for (const result of results) {
      for (const log of result.logs) console[log.level](log.message);
    }
    const beforeBytes = results.reduce((bytes, result) => bytes + result.beforeBytes, 0);
    const afterBytes = results.reduce((bytes, result) => bytes + result.afterBytes, 0);
    const skipped = results.filter((result) => result.skipped).length;
    const scopeLabel = pages.length < allPages.length ? ` (gate-scoped: ${pages.length}/${allPages.length} public pages)` : "";
    console.log(
      `[critical-css] Optimized ${results.length - skipped} public HTML pages, skipped ${skipped} already-inlined pages` +
      `${scopeLabel} (${beforeBytes} -> ${afterBytes} bytes, ${Date.now() - startedAt}ms total).`,
    );
  } catch (error) {
    console.error(`[critical-css] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

runDirectCli(import.meta.url, main);

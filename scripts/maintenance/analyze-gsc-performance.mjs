#!/usr/bin/env node

import { appendGscReportPreamble, runAsyncDirect } from "../lib/gsc-report.mts";
import {
  collectInputEntries,
  compareText,
  firstNumberToken,
  normalizeHeaderName,
  parseCsv,
  uniqueHeaders,
} from "./analyze-gsc-coverage.mjs";

const DEFAULT_TARGET_CTR = 0.045;
const DEFAULT_MIN_IMPRESSIONS = 100;
const DEFAULT_TOP_COUNT = 20;
const SITE_ORIGIN = "https://pharos.watch";

const CLICK_HEADERS = ["Clicks"];
const IMPRESSION_HEADERS = ["Impressions"];
const CTR_HEADERS = ["CTR", "Click through rate", "Click-through rate"];
const POSITION_HEADERS = ["Position", "Average position", "Avg position"];
const PAGE_HEADERS = ["Page", "Pages", "Top pages", "Landing page", "Landing Page", "Page URL", "URL", "URLs"];
const QUERY_HEADERS = ["Query", "Queries", "Top queries", "Search query", "Search Query"];
const DASHBOARD_PATHS = new Set([
  "/coverage/",
  "/liquidity/",
  "/safety-scores/",
  "/stability-index/",
  "/freezewatch/",
  "/flows/",
  "/timeline/",
  "/dependency-map/",
  "/yield/",
  "/funding/",
  "/alt-pegs/",
  "/cemetery/",
  "/compliance/",
  "/screener/",
]);

function findHeader(headers, candidates) {
  const lookup = new Map(headers.map((header) => [normalizeHeaderName(header), header]));
  for (const candidate of candidates) {
    const header = lookup.get(normalizeHeaderName(candidate));
    if (header) return header;
  }
  return "";
}

function recordFromRow(headers, row) {
  const record = {};
  headers.forEach((header, index) => {
    record[header] = String(row[index] ?? "").trim();
  });
  return record;
}

function findPerformanceTable(text) {
  const rows = parseCsv(text);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const headers = uniqueHeaders(rows[rowIndex] ?? []);
    const clicksHeader = findHeader(headers, CLICK_HEADERS);
    const impressionsHeader = findHeader(headers, IMPRESSION_HEADERS);
    const pageHeader = findHeader(headers, PAGE_HEADERS);
    const queryHeader = findHeader(headers, QUERY_HEADERS);
    if (!clicksHeader || !impressionsHeader || (!pageHeader && !queryHeader)) continue;

    return {
      headerRowIndex: rowIndex,
      headers,
      clicksHeader,
      impressionsHeader,
      ctrHeader: findHeader(headers, CTR_HEADERS),
      positionHeader: findHeader(headers, POSITION_HEADERS),
      pageHeader,
      queryHeader,
      records: rows.slice(rowIndex + 1).map((row) => recordFromRow(headers, row)),
    };
  }
  return null;
}

function parseFiniteNumber(value) {
  const token = firstNumberToken(value);
  if (!token) return null;
  const parsed = Number(token);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCount(value) {
  const parsed = parseFiniteNumber(value);
  if (parsed === null) return null;
  return Math.max(0, Math.trunc(parsed));
}

function parseCtr(value) {
  const raw = String(value ?? "").trim();
  const parsed = parseFiniteNumber(raw);
  if (parsed === null) return null;
  if (raw.includes("%") || parsed > 1) return parsed / 100;
  return parsed;
}

function parseTargetCtr(value) {
  const parsed = parseCtr(value);
  if (parsed === null || parsed <= 0 || parsed >= 1) {
    throw new Error(`Invalid target CTR: ${value}`);
  }
  return parsed;
}

function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${optionName}: ${value}`);
  }
  return parsed;
}

function normalizeDimension(value) {
  return String(value ?? "").trim();
}

function normalizePageUrl(value) {
  const raw = normalizeDimension(value);
  if (!raw || /^total$/i.test(raw)) return null;
  try {
    const parsed = new URL(raw, SITE_ORIGIN);
    const pathname = parsed.pathname || "/";
    const queryKeys = [...new Set([...parsed.searchParams.keys()].filter(Boolean))].sort(compareText);
    return {
      path: pathname.endsWith("/") || pathname.includes(".") ? pathname : `${pathname}/`,
      url: parsed.origin === SITE_ORIGIN ? pathname : parsed.toString(),
      origin: parsed.origin,
      queryKeys,
    };
  } catch {
    return null;
  }
}

function pageFamilyForPath(pathname) {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/stablecoin/")) return "stablecoin-detail";
  if (pathname === "/stablecoins/") return "stablecoins-hub";
  if (/^\/stablecoins\/(backing|governance|infrastructure)\/[^/]+\/?$/.test(pathname)) {
    return "stablecoin-taxonomy-detail";
  }
  if (/^\/stablecoins\/(backing|governance|infrastructure)\/?$/.test(pathname)) return "stablecoin-taxonomy-hub";
  if (pathname.startsWith("/stablecoins/")) return "peg-taxonomy-detail";
  if (pathname === "/chains/") return "chains-hub";
  if (pathname.startsWith("/chains/")) return "chain-detail";
  if (pathname === "/compare/") return "non-indexable-or-retired";
  if (pathname.startsWith("/compare/")) return "compare-detail";
  if (pathname === "/digest/") return "digest-hub";
  if (pathname.startsWith("/digest/")) return "digest-detail";
  if (pathname === "/docs/") return "docs-hub";
  if (pathname.startsWith("/docs/")) return "docs-detail";
  if (pathname === "/depeg/") return "depeg-hub";
  if (pathname.startsWith("/depeg/")) return "depeg-event";
  if (pathname === "/learn/case-studies/") return "case-studies-hub";
  if (pathname.startsWith("/learn/case-studies/")) return "case-study-detail";
  if (pathname === "/learn/mechanisms/") return "mechanisms-hub";
  if (pathname.startsWith("/learn/mechanisms/")) return "mechanism-detail";
  if (pathname === "/learn/glossary/") return "glossary-hub";
  if (pathname === "/learn/") return "learn-hub";
  if (pathname === "/methodology/") return "methodology-hub";
  if (pathname.startsWith("/methodology/")) return "methodology-detail";
  if (DASHBOARD_PATHS.has(pathname)) return "dashboard";
  if (pathname.startsWith("/admin/") || pathname.startsWith("/admin-api/")) return "non-indexable-or-retired";
  if (pathname.startsWith("/portfolio/") || pathname.startsWith("/blacklist/")) return "non-indexable-or-retired";
  return "static-hub";
}

function emptyAggregate() {
  return {
    clicks: 0,
    impressions: 0,
    positionWeighted: 0,
    positionImpressions: 0,
    rowCount: 0,
  };
}

function addMetrics(target, row) {
  target.clicks += row.clicks;
  target.impressions += row.impressions;
  target.rowCount += 1;
  if (row.position !== null) {
    target.positionWeighted += row.position * row.impressions;
    target.positionImpressions += row.impressions;
  }
}

function finishAggregate(aggregate, targetCtr) {
  const ctr = aggregate.impressions > 0 ? aggregate.clicks / aggregate.impressions : 0;
  const targetClickGap = Math.max(0, Math.ceil(targetCtr * aggregate.impressions - aggregate.clicks));
  const averagePosition =
    aggregate.positionImpressions > 0 ? aggregate.positionWeighted / aggregate.positionImpressions : null;
  return {
    ...aggregate,
    ctr,
    averagePosition,
    targetClickGap,
  };
}

function normalizeSourceLabel(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function parsePerformanceRows(entry, table) {
  const rows = [];
  let skippedMetricRows = 0;
  for (const record of table.records) {
    const clicks = parseCount(record[table.clicksHeader]);
    const impressions = parseCount(record[table.impressionsHeader]);
    if (clicks === null || impressions === null) {
      const hasMetricText =
        String(record[table.clicksHeader] ?? "").trim() || String(record[table.impressionsHeader] ?? "").trim();
      if (hasMetricText) skippedMetricRows += 1;
      continue;
    }

    const page = table.pageHeader ? normalizePageUrl(record[table.pageHeader]) : null;
    const query = table.queryHeader ? normalizeDimension(record[table.queryHeader]) : "";
    if (!page && (!query || /^total$/i.test(query))) continue;

    rows.push({
      clicks,
      impressions,
      ctr: table.ctrHeader ? parseCtr(record[table.ctrHeader]) : null,
      position: table.positionHeader ? parseFiniteNumber(record[table.positionHeader]) : null,
      page,
      query,
      sourceLabel: normalizeSourceLabel(entry.sourceLabel),
    });
  }
  return { rows, skippedMetricRows };
}

function aggregatePerformanceRows(rows, targetCtr, minImpressions, topCount) {
  const siteAggregate = emptyAggregate();
  const pages = new Map();
  const queries = new Map();
  const families = new Map();

  for (const row of rows) {
    if (row.page) {
      addMetrics(siteAggregate, row);

      const family = pageFamilyForPath(row.page.path);
      if (!families.has(family)) {
        families.set(family, {
          family,
          pages: new Set(),
          sources: new Set(),
          ...emptyAggregate(),
        });
      }
      const familyAggregate = families.get(family);
      familyAggregate.pages.add(row.page.path);
      familyAggregate.sources.add(row.sourceLabel);
      addMetrics(familyAggregate, row);

      if (!pages.has(row.page.path)) {
        pages.set(row.page.path, {
          path: row.page.path,
          displayUrl: row.page.origin === SITE_ORIGIN ? row.page.path : row.page.url,
          family,
          queries: new Set(),
          queryKeys: new Set(),
          sources: new Set(),
          ...emptyAggregate(),
        });
      }
      const pageAggregate = pages.get(row.page.path);
      if (row.query) pageAggregate.queries.add(row.query);
      for (const queryKey of row.page.queryKeys) pageAggregate.queryKeys.add(queryKey);
      pageAggregate.sources.add(row.sourceLabel);
      addMetrics(pageAggregate, row);
    } else if (row.query) {
      if (!queries.has(row.query)) {
        queries.set(row.query, {
          query: row.query,
          sources: new Set(),
          ...emptyAggregate(),
        });
      }
      const queryAggregate = queries.get(row.query);
      queryAggregate.sources.add(row.sourceLabel);
      addMetrics(queryAggregate, row);
    }
  }

  const pageRows = [...pages.values()].map((page) => ({
    ...finishAggregate(page, targetCtr),
    queryCount: page.queries.size,
    queryKeys: [...page.queryKeys].sort(compareText),
    sources: [...page.sources].sort(compareText),
  }));
  const queryRows = [...queries.values()].map((query) => ({
    ...finishAggregate(query, targetCtr),
    sources: [...query.sources].sort(compareText),
  }));
  const familyRows = [...families.values()]
    .map((family) => ({
      ...finishAggregate(family, targetCtr),
      pageCount: family.pages.size,
      sources: [...family.sources].sort(compareText),
    }))
    .sort((left, right) => {
      const byGap = right.targetClickGap - left.targetClickGap;
      if (byGap !== 0) return byGap;
      const byImpressions = right.impressions - left.impressions;
      if (byImpressions !== 0) return byImpressions;
      return compareText(left.family, right.family);
    });

  const priorityPages = pageRows
    .filter((page) => page.impressions >= minImpressions && page.targetClickGap > 0)
    .sort((left, right) => {
      const byGap = right.targetClickGap - left.targetClickGap;
      if (byGap !== 0) return byGap;
      const byImpressions = right.impressions - left.impressions;
      if (byImpressions !== 0) return byImpressions;
      return compareText(left.path, right.path);
    })
    .slice(0, topCount);

  const lowSamplePages = pageRows
    .filter((page) => page.impressions > 0 && page.impressions < minImpressions && page.targetClickGap > 0)
    .sort((left, right) => {
      const byImpressions = right.impressions - left.impressions;
      if (byImpressions !== 0) return byImpressions;
      const byGap = right.targetClickGap - left.targetClickGap;
      if (byGap !== 0) return byGap;
      return compareText(left.path, right.path);
    })
    .slice(0, Math.min(topCount, 10));

  const queryOpportunities = queryRows
    .filter((query) => query.impressions >= minImpressions && query.targetClickGap > 0)
    .sort((left, right) => {
      const byGap = right.targetClickGap - left.targetClickGap;
      if (byGap !== 0) return byGap;
      const byImpressions = right.impressions - left.impressions;
      if (byImpressions !== 0) return byImpressions;
      return compareText(left.query, right.query);
    })
    .slice(0, topCount);

  return {
    site: finishAggregate(siteAggregate, targetCtr),
    families: familyRows,
    pages: pageRows.sort((left, right) => compareText(left.path, right.path)),
    queries: queryRows.sort((left, right) => compareText(left.query, right.query)),
    priorityPages,
    lowSamplePages,
    queryOpportunities,
  };
}

export async function analyzeGscPerformanceInputs(inputPaths, options = {}) {
  const targetCtr = options.targetCtr ?? DEFAULT_TARGET_CTR;
  const minImpressions = options.minImpressions ?? DEFAULT_MIN_IMPRESSIONS;
  const topCount = options.topCount ?? DEFAULT_TOP_COUNT;
  const collected = collectInputEntries(inputPaths);
  const notes = [...collected.notes];
  const rows = [];
  let performanceFileCount = 0;
  let skippedMetricRows = 0;
  let pageRows = 0;
  let queryOnlyRows = 0;

  for (const entry of collected.entries) {
    const table = findPerformanceTable(entry.text);
    if (!table) continue;
    performanceFileCount += 1;
    const parsed = parsePerformanceRows(entry, table);
    skippedMetricRows += parsed.skippedMetricRows;
    rows.push(...parsed.rows);
    pageRows += parsed.rows.filter((row) => row.page).length;
    queryOnlyRows += parsed.rows.filter((row) => !row.page && row.query).length;
  }

  notes.sort(compareText);

  return {
    inputs: collected.inputs,
    notes,
    options: {
      targetCtr,
      minImpressions,
      topCount,
    },
    parsedFileCounts: {
      csv: collected.entries.length,
      performance: performanceFileCount,
      pageRows,
      queryOnlyRows,
      skippedMetricRows,
    },
    ...aggregatePerformanceRows(rows, targetCtr, minImpressions, topCount),
  };
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatCtr(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatPosition(value) {
  return value === null ? "n/a" : value.toFixed(1);
}

function formatSources(sources) {
  if (!sources || sources.length === 0) return "";
  return ` | sources=${sources.slice(0, 3).join(", ")}${sources.length > 3 ? `, +${sources.length - 3}` : ""}`;
}

function formatAggregateMetrics(aggregate) {
  return [
    `impressions=${formatInteger(aggregate.impressions)}`,
    `clicks=${formatInteger(aggregate.clicks)}`,
    `ctr=${formatCtr(aggregate.ctr)}`,
    `avgPosition=${formatPosition(aggregate.averagePosition)}`,
    `targetClickGap=${formatInteger(aggregate.targetClickGap)}`,
  ].join(" | ");
}

function positionBucket(value) {
  if (value === null) return "n/a";
  if (value <= 3) return "1-3";
  if (value <= 5) return "4-5";
  if (value <= 10) return "6-10";
  if (value <= 20) return "11-20";
  return "20+";
}

function labelsForPage(page, minImpressions) {
  const labels = [];
  if (page.impressions < minImpressions) labels.push("low-sample");
  if (page.queryKeys.length > 0) labels.push("noncanonical-query");
  if (page.family === "non-indexable-or-retired") labels.push("possible-noindex/retired");
  if (page.impressions >= minImpressions && page.targetClickGap > 0) {
    labels.push(page.averagePosition !== null && page.averagePosition > 10 ? "ranking-first" : "quick-win");
  }
  return labels.length > 0 ? labels.join(",") : "none";
}

export function renderGscPerformanceReport(report) {
  const lines = [];
  appendGscReportPreamble(lines, {
    title: "GSC Performance CTR Inventory",
    detailLines: [
      `Target CTR: ${formatCtr(report.options.targetCtr)}`,
      `Minimum impressions for priority rows: ${formatInteger(report.options.minImpressions)}`,
    ],
    inputs: report.inputs,
    notes: report.notes,
    parsedFileCounts: [
      ["CSV files", report.parsedFileCounts.csv],
      ["Performance CSV files", report.parsedFileCounts.performance],
      ["Page rows", report.parsedFileCounts.pageRows],
      ["Query-only rows", report.parsedFileCounts.queryOnlyRows],
      ...(report.parsedFileCounts.skippedMetricRows > 0
        ? [["Skipped rows with malformed metrics", report.parsedFileCounts.skippedMetricRows]]
        : []),
    ],
  });

  lines.push("Site CTR:");
  lines.push(`- ${formatAggregateMetrics(report.site)}`);
  lines.push("");

  lines.push("Family CTR gaps:");
  if (report.families.length === 0) {
    lines.push("- none");
  } else {
    for (const family of report.families) {
      lines.push(
        `- ${family.family} | pages=${formatInteger(family.pageCount)} | ${formatAggregateMetrics(family)}${formatSources(family.sources)}`,
      );
    }
  }
  lines.push("");

  lines.push("Priority pages below target:");
  if (report.priorityPages.length === 0) {
    lines.push("- none");
  } else {
    for (const page of report.priorityPages) {
      lines.push(
        `- ${page.displayUrl} | family=${page.family} | ${formatAggregateMetrics(page)} | positionBucket=${positionBucket(page.averagePosition)} | queries=${formatInteger(page.queryCount)} | queryKeys=${page.queryKeys.join(",") || "none"} | labels=${labelsForPage(page, report.options.minImpressions)}${formatSources(page.sources)}`,
      );
    }
  }
  lines.push("");

  lines.push("Low-sample pages below target:");
  if (report.lowSamplePages.length === 0) {
    lines.push("- none");
  } else {
    for (const page of report.lowSamplePages) {
      lines.push(
        `- ${page.displayUrl} | family=${page.family} | ${formatAggregateMetrics(page)} | positionBucket=${positionBucket(page.averagePosition)} | labels=${labelsForPage(page, report.options.minImpressions)}${formatSources(page.sources)}`,
      );
    }
  }
  lines.push("");

  lines.push("Query opportunities below target:");
  if (report.queryOpportunities.length === 0) {
    lines.push("- none");
  } else {
    for (const query of report.queryOpportunities) {
      lines.push(`- ${query.query} | ${formatAggregateMetrics(query)}${formatSources(query.sources)}`);
    }
  }
  lines.push("");

  lines.push("Recommended triage order:");
  lines.push("- Start with the largest family targetClickGap, then inspect its priority pages.");
  lines.push(
    "- Compare high-impression query opportunities against the current title and meta description for matching pages.",
  );
  lines.push("- Re-run after each GSC export refresh; Search Console performance data lags live deploys.");

  return `${lines.join("\n")}\n`;
}

function usage() {
  return [
    "Usage: npm run analyze:gsc-performance -- [options] <gsc-performance-export-dir-or-file> [...more paths]",
    "",
    "Accepts GSC performance export directories, ZIP files, CSV files, and XLSX/XLS files.",
    "XLSX/XLS files are reported as unsupported unless the data is exported as CSV; this script does not add dependencies.",
    "",
    "Options:",
    `  --target-ctr <value>      Target CTR as a fraction or percent, default ${formatCtr(DEFAULT_TARGET_CTR)}`,
    `  --min-impressions <n>    Minimum impressions for priority rows, default ${DEFAULT_MIN_IMPRESSIONS}`,
    `  --top <n>                Number of page/query opportunities to print, default ${DEFAULT_TOP_COUNT}`,
  ].join("\n");
}

/**
 * @param {string[]} [argv]
 * @param {{ write(chunk: string): unknown }} [stdout]
 * @param {{ write(chunk: string): unknown }} [stderr]
 */
export async function runCli(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr) {
  const args = [];
  const options = {
    targetCtr: DEFAULT_TARGET_CTR,
    minImpressions: DEFAULT_MIN_IMPRESSIONS,
    topCount: DEFAULT_TOP_COUNT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      stdout.write(`${usage()}\n`);
      return 0;
    }
    if (arg === "--target-ctr") {
      options.targetCtr = parseTargetCtr(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--target-ctr=")) {
      options.targetCtr = parseTargetCtr(arg.slice("--target-ctr=".length));
    } else if (arg === "--min-impressions") {
      options.minImpressions = parsePositiveInteger(argv[index + 1], "--min-impressions");
      index += 1;
    } else if (arg.startsWith("--min-impressions=")) {
      options.minImpressions = parsePositiveInteger(arg.slice("--min-impressions=".length), "--min-impressions");
    } else if (arg === "--top") {
      options.topCount = parsePositiveInteger(argv[index + 1], "--top");
      index += 1;
    } else if (arg.startsWith("--top=")) {
      options.topCount = parsePositiveInteger(arg.slice("--top=".length), "--top");
    } else if (arg.startsWith("-")) {
      stderr.write(`Unknown option: ${arg}\n\n${usage()}\n`);
      return 1;
    } else {
      args.push(arg);
    }
  }

  if (args.length === 0) {
    stderr.write(`${usage()}\n`);
    return 1;
  }

  try {
    const report = await analyzeGscPerformanceInputs(args, options);
    stdout.write(renderGscPerformanceReport(report));
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

runAsyncDirect(import.meta.url, process.argv[1], runCli);

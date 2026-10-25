#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendGscReportPreamble,
  appendGscReportSection,
  collectInputEntries,
  compareText,
  findHeader,
  formatGscUsage,
  parseCsv,
  parseCsvNumber,
  parsePositiveNumber,
  recordFromCsvRow,
  runAsyncDirect,
  runGscCli,
  uniqueHeaders,
  writeGscUnknownOption,
  writeGscUsage,
} from "../lib/gsc-report.mts";

// Site position curve fitted to Pharos's own Search Console data (Poisson grid
// fit, 2026-10-25 SEO plan OS1): expected CTR = min(0.6, A * position^-B).
// A flat target is 6-12x too high at positions 6-9, and industry curves sit
// 5-10x above what this SERP mix allows. `--target-ctr` overrides it flat.
const CTR_CURVE_A = 0.132;
const CTR_CURVE_B = 1.64;
const CTR_CURVE_CAP = 0.6;
const DEFAULT_BRAND_PATTERN = "pharos";
const DEFAULT_MIN_IMPRESSIONS = 100;
const DEFAULT_TOP_COUNT = 20;
const SITE_ORIGIN = "https://pharos.watch";
const STABLECOIN_COINS_DIR = fileURLToPath(new URL("../../shared/data/stablecoins/coins/", import.meta.url));

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

/** Expected CTR at an average position on the site curve; null without a usable position. */
export function expectedCtr(position) {
  if (position === null || !Number.isFinite(position) || position <= 0) return null;
  return Math.min(CTR_CURVE_CAP, CTR_CURVE_A * position ** -CTR_CURVE_B);
}

/** Registry status by stablecoin id, read from the checked-in coin records. */
function loadStablecoinStatusById() {
  const statuses = new Map();
  for (const name of fs.readdirSync(STABLECOIN_COINS_DIR)) {
    if (!name.endsWith(".json")) continue;
    const coin = JSON.parse(fs.readFileSync(path.join(STABLECOIN_COINS_DIR, name), "utf8"));
    if (typeof coin.id === "string") statuses.set(coin.id, coin.status ?? "active");
  }
  return statuses;
}

function stablecoinStatusBucket(status) {
  if (status === undefined) return "unlisted";
  if (status === "active" || status === "pre-launch" || status === "frozen") return status;
  return "inactive";
}

function parseBrandPattern(value) {
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp -- operator-supplied pattern for a local read-only report
    return new RegExp(String(value), "i");
  } catch {
    throw new Error(`Invalid --brand-pattern regular expression: ${value}`);
  }
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
      records: rows.slice(rowIndex + 1).map((row) => recordFromCsvRow(headers, row)),
    };
  }
  return null;
}

function parseCount(value) {
  const parsed = parseCsvNumber(value);
  if (parsed === null) return null;
  return Math.max(0, Math.trunc(parsed));
}

function parseCtr(value) {
  const raw = String(value ?? "").trim();
  const parsed = parseCsvNumber(raw);
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
      // Search Console lists in-page sitelinks (#context) as their own URL rows.
      fragment: parsed.hash.length > 1 ? parsed.hash : null,
    };
  } catch {
    return null;
  }
}

function pageFamilyForPath(pathname, stablecoinStatusById) {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/stablecoin/")) {
    const id = pathname.split("/")[2] ?? "";
    return `stablecoin-detail:${stablecoinStatusBucket(stablecoinStatusById.get(id))}`;
  }
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
    // Expectation covers only rows with a usable position (or a flat override).
    expectedClicks: 0,
    expectationClicks: 0,
    expectationImpressions: 0,
  };
}

function addMetrics(target, row, targetCtr) {
  target.clicks += row.clicks;
  target.impressions += row.impressions;
  target.rowCount += 1;
  if (row.position !== null) {
    target.positionWeighted += row.position * row.impressions;
    target.positionImpressions += row.impressions;
  }
  const expected = targetCtr ?? expectedCtr(row.position);
  if (expected !== null) {
    target.expectedClicks += expected * row.impressions;
    target.expectationClicks += row.clicks;
    target.expectationImpressions += row.impressions;
  }
}

function sumAggregates(aggregates) {
  const total = emptyAggregate();
  for (const aggregate of aggregates) {
    for (const key of Object.keys(total)) total[key] += aggregate[key];
  }
  return total;
}

function finishAggregate(aggregate) {
  const ctr = aggregate.impressions > 0 ? aggregate.clicks / aggregate.impressions : 0;
  const averagePosition =
    aggregate.positionImpressions > 0 ? aggregate.positionWeighted / aggregate.positionImpressions : null;
  const hasExpectation = aggregate.expectationImpressions > 0;
  return {
    ...aggregate,
    ctr,
    averagePosition,
    expectedCtr: hasExpectation ? aggregate.expectedClicks / aggregate.expectationImpressions : null,
    actualToExpected:
      hasExpectation && aggregate.expectedClicks > 0 ? aggregate.expectationClicks / aggregate.expectedClicks : null,
    // Signed: positive means clicks below the curve, negative means above it.
    clickGap: hasExpectation ? Math.round(aggregate.expectedClicks - aggregate.expectationClicks) : null,
  };
}

function compareClickGap(left, right) {
  return (right.clickGap ?? Number.NEGATIVE_INFINITY) - (left.clickGap ?? Number.NEGATIVE_INFINITY);
}

function normalizeSourceLabel(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function parsePerformanceRows(entry, table) {
  // Standalone CSVs share their export directory; ZIP members retain their archive and directory.
  const containerExtension = path.extname(entry.containerPath).toLowerCase();
  const captureKey = containerExtension === ".zip"
    ? `${entry.containerPath}:${path.posix.dirname(entry.relativePath)}`
    : containerExtension === ".csv" ? path.dirname(entry.containerPath)
    : path.resolve(entry.containerPath, path.posix.dirname(entry.relativePath));
  const grain = table.pageHeader ? (table.queryHeader ? "page-query" : "page") : "query";
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
      position: table.positionHeader ? parseCsvNumber(record[table.positionHeader]) : null,
      page,
      query,
      sourceLabel: normalizeSourceLabel(entry.sourceLabel),
      captureKey,
      grain,
    });
  }
  return { rows, skippedMetricRows };
}

function aggregatePerformanceRows(rows, { targetCtr, minImpressions, topCount, brandPattern, stablecoinStatusById }) {
  const siteAggregate = emptyAggregate();
  const pages = new Map();
  const queries = new Map();
  const families = new Map();
  const captures = new Set(rows.map((row) => row.captureKey));
  if (captures.size > 1) {
    throw new Error(`Ambiguous GSC performance captures: ${[...captures].join(", ")}. Analyze each export separately; date-window overlap is not proven.`);
  }
  // Sitelink rows (#fragment URLs) are folded into a per-page note, never summed into page totals.
  const sitelinks = new Map();
  for (const row of rows.filter((row) => row.page?.fragment)) {
    if (!sitelinks.has(row.page.path)) sitelinks.set(row.page.path, { impressions: 0, clicks: 0, fragments: new Set() });
    const note = sitelinks.get(row.page.path);
    note.impressions += row.impressions;
    note.clicks += row.clicks;
    note.fragments.add(row.page.fragment);
  }
  const pathRows = rows.filter((row) => !row.page?.fragment);
  const pageTotals = new Set();
  for (const row of pathRows.filter((row) => row.grain === "page" && row.page)) {
    if (pageTotals.has(row.page.path)) {
      throw new Error(`Ambiguous duplicate page totals for ${row.page.path}; retain one coherent export.`);
    }
    pageTotals.add(row.page.path);
  }

  // Separate query totals are authoritative for overlapping combined rows.
  const queryTotals = new Set(pathRows.filter((row) => !row.page && row.query).map((row) => row.query));
  for (const row of pathRows) {
    if (row.page) {
      const authoritative = row.grain === "page" || !pageTotals.has(row.page.path);
      if (authoritative) addMetrics(siteAggregate, row, targetCtr);

      const family = pageFamilyForPath(row.page.path, stablecoinStatusById);
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
      if (authoritative) addMetrics(familyAggregate, row, targetCtr);

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
      if (authoritative) addMetrics(pageAggregate, row, targetCtr);
    }
    if (row.query && (!row.page || !queryTotals.has(row.query))) {
      if (!queries.has(row.query)) {
        queries.set(row.query, {
          query: row.query,
          sources: new Set(),
          ...emptyAggregate(),
        });
      }
      const queryAggregate = queries.get(row.query);
      queryAggregate.sources.add(row.sourceLabel);
      addMetrics(queryAggregate, row, targetCtr);
    }
  }

  const fragmentNotes = [...sitelinks.keys()]
    .filter((pagePath) => !pages.has(pagePath))
    .sort(compareText)
    .map((pagePath) => `Sitelink fragment rows without a page total: ${pagePath} (${[...sitelinks.get(pagePath).fragments].sort(compareText).join(", ")})`);
  const pageRows = [...pages.values()].map((page) => {
    const sitelink = sitelinks.get(page.path);
    return {
      ...finishAggregate(page),
      queryCount: page.queries.size,
      queryKeys: [...page.queryKeys].sort(compareText),
      sources: [...page.sources].sort(compareText),
      sitelinkImpressions: sitelink?.impressions ?? 0,
      sitelinkClicks: sitelink?.clicks ?? 0,
      sitelinkFragments: sitelink ? [...sitelink.fragments].sort(compareText) : [],
    };
  });
  const queryRows = [...queries.values()].map((query) => ({
    ...finishAggregate(query),
    brand: brandPattern.test(query.query),
    sources: [...query.sources].sort(compareText),
  }));
  const queryAggregates = [...queries.values()];
  const querySplit = {
    brand: finishAggregate(sumAggregates(queryAggregates.filter((query) => brandPattern.test(query.query)))),
    nonBrand: finishAggregate(sumAggregates(queryAggregates.filter((query) => !brandPattern.test(query.query)))),
  };
  const familyRows = [...families.values()]
    .map((family) => ({
      ...finishAggregate(family),
      pageCount: family.pages.size,
      sources: [...family.sources].sort(compareText),
    }))
    .sort((left, right) => {
      const byGap = compareClickGap(left, right);
      if (byGap !== 0) return byGap;
      const byImpressions = right.impressions - left.impressions;
      if (byImpressions !== 0) return byImpressions;
      return compareText(left.family, right.family);
    });

  const priorityPages = pageRows
    .filter((page) => page.impressions >= minImpressions && page.clickGap > 0)
    .sort((left, right) => {
      const byGap = compareClickGap(left, right);
      if (byGap !== 0) return byGap;
      const byImpressions = right.impressions - left.impressions;
      if (byImpressions !== 0) return byImpressions;
      return compareText(left.path, right.path);
    })
    .slice(0, topCount);

  const lowSamplePages = pageRows
    .filter((page) => page.impressions > 0 && page.impressions < minImpressions && page.clickGap > 0)
    .sort((left, right) => {
      const byImpressions = right.impressions - left.impressions;
      if (byImpressions !== 0) return byImpressions;
      const byGap = compareClickGap(left, right);
      if (byGap !== 0) return byGap;
      return compareText(left.path, right.path);
    })
    .slice(0, Math.min(topCount, 10));

  const queryOpportunities = queryRows
    .filter((query) => !query.brand && query.impressions >= minImpressions && query.clickGap > 0)
    .sort((left, right) => {
      const byGap = compareClickGap(left, right);
      if (byGap !== 0) return byGap;
      const byImpressions = right.impressions - left.impressions;
      if (byImpressions !== 0) return byImpressions;
      return compareText(left.query, right.query);
    })
    .slice(0, topCount);

  return {
    site: finishAggregate(siteAggregate),
    querySplit,
    fragmentRowCount: rows.length - pathRows.length,
    fragmentNotes,
    families: familyRows,
    pages: pageRows.sort((left, right) => compareText(left.path, right.path)),
    queries: queryRows.sort((left, right) => compareText(left.query, right.query)),
    priorityPages,
    lowSamplePages,
    queryOpportunities,
  };
}

export async function analyzeGscPerformanceInputs(inputPaths, options = {}) {
  const targetCtr = options.targetCtr ?? null;
  const brandPatternSource = options.brandPattern ?? DEFAULT_BRAND_PATTERN;
  const brandPattern = parseBrandPattern(brandPatternSource);
  const stablecoinStatusById = options.stablecoinStatusById ?? loadStablecoinStatusById();
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

  const aggregates = aggregatePerformanceRows(rows, { targetCtr, minImpressions, topCount, brandPattern, stablecoinStatusById });
  if (aggregates.fragmentRowCount > 0) {
    notes.push(`Folded ${aggregates.fragmentRowCount} #fragment sitelink rows into per-page notes; they are not summed into page totals.`);
  }
  notes.push(...aggregates.fragmentNotes);
  notes.sort(compareText);

  return {
    inputs: collected.inputs,
    notes,
    options: {
      targetCtr,
      brandPattern: brandPatternSource,
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
    rows,
    ...aggregates,
  };
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatCtr(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function formatRatio(value) {
  return value === null ? "n/a" : `${value.toFixed(2)}x`;
}

function formatGap(value) {
  return value === null ? "n/a" : formatInteger(value);
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
    `expectedCtr=${formatCtr(aggregate.expectedCtr)}`,
    `actual/expected=${formatRatio(aggregate.actualToExpected)}`,
    `clickGap=${formatGap(aggregate.clickGap)}`,
  ].join(" | ");
}

function formatSitelinks(page) {
  if (page.sitelinkFragments.length === 0) return "";
  return ` | sitelinks=${page.sitelinkFragments.join(",")} (${formatInteger(page.sitelinkImpressions)} impr, ${formatInteger(page.sitelinkClicks)} clicks)`;
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
  if (page.impressions >= minImpressions && page.clickGap > 0) {
    labels.push(page.averagePosition !== null && page.averagePosition > 10 ? "ranking-first" : "quick-win");
  }
  return labels.length > 0 ? labels.join(",") : "none";
}

export function renderGscPerformanceReport(report) {
  const lines = [];
  appendGscReportPreamble(lines, {
    title: "GSC Performance CTR Inventory",
    detailLines: [
      report.options.targetCtr === null
        ? `Expected CTR: site position curve min(${formatCtr(CTR_CURVE_CAP)}, ${CTR_CURVE_A} x position^-${CTR_CURVE_B})`
        : `Expected CTR: flat --target-ctr override ${formatCtr(report.options.targetCtr)}`,
      `Brand query pattern: /${report.options.brandPattern}/i (excluded from query opportunities)`,
      `Minimum impressions for priority rows: ${formatInteger(report.options.minImpressions)}`,
      "Analyze 28-day exports: three-month windows carry decayed news-spike impressions.",
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

  lines.push("Query CTR by brand match:");
  lines.push(`- brand | ${formatAggregateMetrics(report.querySplit.brand)}`);
  lines.push(`- non-brand | ${formatAggregateMetrics(report.querySplit.nonBrand)}`);
  lines.push("");

  appendGscReportSection(lines, "Family CTR gaps:", report.families, (family) =>
    `${family.family} | pages=${formatInteger(family.pageCount)} | ${formatAggregateMetrics(family)}${formatSources(family.sources)}`,
  );

  appendGscReportSection(lines, "Priority pages below target:", report.priorityPages, (page) =>
    `${page.displayUrl} | family=${page.family} | ${formatAggregateMetrics(page)} | positionBucket=${positionBucket(page.averagePosition)} | queries=${formatInteger(page.queryCount)} | queryKeys=${page.queryKeys.join(",") || "none"} | labels=${labelsForPage(page, report.options.minImpressions)}${formatSitelinks(page)}${formatSources(page.sources)}`,
  );

  appendGscReportSection(lines, "Low-sample pages below target:", report.lowSamplePages, (page) =>
    `${page.displayUrl} | family=${page.family} | ${formatAggregateMetrics(page)} | positionBucket=${positionBucket(page.averagePosition)} | labels=${labelsForPage(page, report.options.minImpressions)}${formatSources(page.sources)}`,
  );

  appendGscReportSection(lines, "Query opportunities below target:", report.queryOpportunities, (query) =>
    `${query.query} | ${formatAggregateMetrics(query)}${formatSources(query.sources)}`,
  );

  lines.push("Recommended triage order:");
  lines.push("- Start with the largest family clickGap (clicks below the site curve), then inspect its priority pages.");
  lines.push(
    "- Compare high-impression query opportunities against the current title and meta description for matching pages.",
  );
  lines.push("- Re-run after each GSC export refresh; Search Console performance data lags live deploys.");

  return `${lines.join("\n")}\n`;
}

function usage() {
  return formatGscUsage([
    "Usage: npm run analyze:gsc-performance -- [options] <gsc-performance-export-dir-or-file> [...more paths]",
    "",
    "Accepts GSC performance export directories, ZIP files, CSV files, and XLSX/XLS files.",
    "XLSX/XLS files are reported as unsupported unless the data is exported as CSV; this script does not add dependencies.",
    "",
    "Options:",
    `  --target-ctr <value>      Flat target CTR (fraction or percent) instead of the site position curve`,
    `  --brand-pattern <regex>  Case-insensitive brand query pattern, default ${DEFAULT_BRAND_PATTERN}`,
    `  --min-impressions <n>    Minimum impressions for priority rows, default ${DEFAULT_MIN_IMPRESSIONS}`,
    `  --top <n>                Number of page/query opportunities to print, default ${DEFAULT_TOP_COUNT}`,
  ]);
}

/**
 * @param {string[]} [argv]
 * @param {{ write(chunk: string): unknown }} [stdout]
 * @param {{ write(chunk: string): unknown }} [stderr]
 */
export async function runCli(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr) {
  const args = [];
  const options = {
    targetCtr: null,
    brandPattern: DEFAULT_BRAND_PATTERN,
    minImpressions: DEFAULT_MIN_IMPRESSIONS,
    topCount: DEFAULT_TOP_COUNT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      writeGscUsage(stdout, usage());
      return 0;
    }
    if (arg === "--target-ctr") {
      options.targetCtr = parseTargetCtr(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--target-ctr=")) {
      options.targetCtr = parseTargetCtr(arg.slice("--target-ctr=".length));
    } else if (arg === "--brand-pattern") {
      options.brandPattern = parseBrandPattern(argv[index + 1]).source;
      index += 1;
    } else if (arg.startsWith("--brand-pattern=")) {
      options.brandPattern = parseBrandPattern(arg.slice("--brand-pattern=".length)).source;
    } else if (arg === "--min-impressions") {
      options.minImpressions = parsePositiveNumber(argv[index + 1], "--min-impressions", { integer: true });
      index += 1;
    } else if (arg.startsWith("--min-impressions=")) {
      options.minImpressions = parsePositiveNumber(
        arg.slice("--min-impressions=".length),
        "--min-impressions",
        { integer: true },
      );
    } else if (arg === "--top") {
      options.topCount = parsePositiveNumber(argv[index + 1], "--top", { integer: true });
      index += 1;
    } else if (arg.startsWith("--top=")) {
      options.topCount = parsePositiveNumber(arg.slice("--top=".length), "--top", { integer: true });
    } else if (arg.startsWith("-")) {
      writeGscUnknownOption(stderr, arg, usage());
      return 1;
    } else {
      args.push(arg);
    }
  }

  if (args.length === 0) {
    writeGscUsage(stderr, usage());
    return 1;
  }

  return runGscCli(async () => {
    const report = await analyzeGscPerformanceInputs(args, options);
    stdout.write(renderGscPerformanceReport(report));
    return 0;
  }, stderr);
}

runAsyncDirect(import.meta.url, process.argv[1], runCli);

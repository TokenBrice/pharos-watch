#!/usr/bin/env node

import path from "node:path";
import {
  appendGscReportPreamble,
  appendGscReportSection,
  collectInputEntries,
  cleanPathLabel,
  compareText,
  findHeader,
  firstNumberToken,
  formatGscUsage,
  hasHeader,
  KNOWN_GSC_FILES,
  parseCsv,
  parseCsvNumber,
  recordFromCsvRow,
  runAsyncDirect,
  runGscCli,
  uniqueHeaders,
  writeGscUnknownOption,
  writeGscUsage,
} from "../lib/gsc-report.mts";

export {
  collectInputEntries,
  compareText,
  firstNumberToken,
  findHeader,
  hasHeader,
  isDigit,
  normalizeHeaderName,
  parseCsv,
  parseCsvNumber,
  recordFromCsvRow,
  stripBom,
  uniqueHeaders,
} from "../lib/gsc-report.mts";

const ISSUE_NAME_HEADERS = [
  "Reason",
  "Issue",
  "Status",
  "Page indexing issue",
  "Why pages aren't indexed",
  "Why pages are not indexed",
  "Indexing reason",
];

const PAGE_COUNT_HEADERS = ["Pages", "Affected pages", "Affected URLs", "URLs", "Count", "Examples"];
const URL_HEADERS = ["URL", "Page", "Address", "Indexed URL", "Submitted URL"];

const LIVE_CHECK_FIELDS = [
  "issue",
  "pathQueryKey",
  "sampleUrl",
  "urlCount",
  "gscInspectionVerdict",
  "currentHttpStatus",
  "robotsMetaDirective",
  "canonicalTarget",
  "sitemapOrInternalLinkEvidence",
  "ownerAction",
  "notes",
];

function normalizeIssueKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\uFEFF/, "")
    .replace(/\.(csv|zip|xlsx|xls)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(csv|zip|xlsx|xls|table|metadata|drilldown|export)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function csvRecords(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], records: [], rawRows: [] };
  const headers = uniqueHeaders(rows[0] ?? []);
  const records = rows.slice(1).map((row) => recordFromCsvRow(headers, row));
  return { headers, records, rawRows: rows };
}

function getField(record, candidates) {
  for (const candidate of candidates) {
    const key = findHeader(Object.keys(record), [candidate]);
    if (key && String(record[key] ?? "").trim()) return String(record[key]).trim();
  }
  return "";
}

function parseCount(value) {
  const parsed = parseCsvNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function isPlainCountText(value) {
  let cleaned = String(value ?? "")
    .replaceAll(",", "")
    .trim();
  if (cleaned.startsWith("<") || cleaned.startsWith(">")) cleaned = cleaned.slice(1).trim();
  const token = firstNumberToken(cleaned);
  return token.length > 0 && token === cleaned;
}

function firstNonNumericText(record) {
  for (const value of Object.values(record)) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) continue;
    if (parseCount(trimmed) !== null && isPlainCountText(trimmed)) continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) continue;
    return trimmed;
  }
  return "";
}

function csvKind(entry, parsed) {
  const name = entry.fileName.toLowerCase();
  if (name === "chart.csv") return "chart";
  if (name === "metadata.csv") return "metadata";
  if (name === "table.csv") return "table";
  if (name === "critical issues.csv" || name === "non-critical issues.csv") return "issue";
  if (hasHeader(parsed.headers, URL_HEADERS)) return "table";
  if (hasHeader(parsed.headers, ISSUE_NAME_HEADERS) && hasHeader(parsed.headers, PAGE_COUNT_HEADERS)) return "issue";
  return "unknown";
}

function severityFromFileName(fileName) {
  const lower = fileName.toLowerCase();
  if (lower === "critical issues.csv") return "critical";
  if (lower === "non-critical issues.csv") return "non-critical";
  return "unspecified";
}

function severityRank(value) {
  if (value === "critical") return 0;
  if (value === "non-critical") return 1;
  return 2;
}

function groupEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const directory = path.posix.dirname(entry.relativePath);
    const groupDirectory = directory === "." ? "" : directory;
    const key = `${entry.containerPath}\0${groupDirectory}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        containerPath: entry.containerPath,
        containerName: entry.containerName,
        groupDirectory,
        entries: [],
      });
    }
    groups.get(key).entries.push(entry);
  }
  return [...groups.values()].sort((left, right) => compareText(left.key, right.key));
}

function groupName(group) {
  if (group.groupDirectory) return cleanPathLabel(group.groupDirectory);
  return group.containerName || cleanPathLabel(group.containerPath);
}

function parseMetadata(text) {
  const rows = parseCsv(text);
  const pairs = [];
  for (const row of rows) {
    if (row.length < 2) continue;
    const key = String(row[0] ?? "").trim();
    const value = row
      .slice(1)
      .map((cell) => String(cell ?? "").trim())
      .filter(Boolean)
      .join(" | ");
    if (key && value) pairs.push({ key, value });
  }
  return pairs;
}

function inferIssueNameFromMetadata(metadataPairs) {
  const strong = [];
  const weak = [];
  for (const pair of metadataPairs) {
    const key = normalizeIssueKey(pair.key);
    const value = String(pair.value ?? "").trim();
    if (!value || /^value$/i.test(value) || /^page indexing$/i.test(value)) continue;
    if (/\b(issue|reason|filter)\b/.test(key)) strong.push(value);
    if (/\b(status|not indexed|indexed)\b/.test(key)) weak.push(value);
  }
  return strong[0] ?? weak[0] ?? "";
}

function parseIssueRows(entry, parsed) {
  const severity = severityFromFileName(entry.fileName);
  return parsed.records
    .map((record, rowIndex) => {
      const issueName = getField(record, ISSUE_NAME_HEADERS) || firstNonNumericText(record);
      if (!issueName) return null;
      const pages = parseCount(getField(record, PAGE_COUNT_HEADERS));
      return {
        issueName,
        issueKey: normalizeIssueKey(issueName),
        severity,
        pages,
        source: getField(record, ["Source"]),
        validation: getField(record, ["Validation"]),
        trend: getField(record, ["Trend"]),
        sourceLabel: entry.sourceLabel,
        rowIndex: rowIndex + 2,
      };
    })
    .filter(Boolean);
}

function parseChartSummary(entry, parsed) {
  const latest = parsed.records.at(-1) ?? {};
  const date =
    getField(latest, ["Date", "Day"]) || Object.entries(latest).find(([key]) => /date|day/i.test(key))?.[1] || "";
  const latestMetrics = Object.entries(latest)
    .filter(([key, value]) => String(value ?? "").trim() && !/^(date|day)$/i.test(key.trim()))
    .slice(0, 5)
    .map(([key, value]) => `${key}=${value}`);

  return {
    sourceLabel: entry.sourceLabel,
    rowCount: parsed.records.length,
    latestDate: String(date ?? "").trim(),
    latestMetrics,
  };
}

function extractUrlFromRecord(record) {
  const direct = getField(record, URL_HEADERS);
  if (direct) return direct;
  for (const value of Object.values(record)) {
    const trimmed = String(value ?? "").trim();
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("/")) return trimmed;
  }
  return "";
}

function pathQueryKeyForUrl(url) {
  try {
    const parsed = new URL(url, "https://pharos.watch");
    const queryKeys = [...new Set([...parsed.searchParams.keys()].filter(Boolean))].sort(compareText);
    return `${parsed.pathname || "/"}${queryKeys.length > 0 ? `?${queryKeys.join("&")}` : ""}`;
  } catch {
    return String(url ?? "").trim() || "(unknown-url)";
  }
}

function parseTableDrilldown(entry, parsed, group, metadataPairs) {
  const metadataIssueName = inferIssueNameFromMetadata(metadataPairs);
  const inferredName = metadataIssueName || groupName(group);
  const issueName = inferredName || "Unknown drilldown";
  const urls = [
    ...new Set(parsed.records.map((record) => extractUrlFromRecord(record)).filter((url) => url.length > 0)),
  ].sort(compareText);

  const urlGroups = new Map();
  for (const url of urls) {
    const key = pathQueryKeyForUrl(url);
    if (!urlGroups.has(key)) {
      urlGroups.set(key, { key, urls: [] });
    }
    urlGroups.get(key).urls.push(url);
  }

  return {
    issueName,
    issueKey: normalizeIssueKey(issueName),
    sourceLabel: entry.sourceLabel,
    urlCount: urls.length,
    urls,
    urlGroups: [...urlGroups.values()].sort((left, right) => compareText(left.key, right.key)),
  };
}

function parseGroup(group) {
  const parsedEntries = group.entries.map((entry) => ({ entry, parsed: csvRecords(entry.text) }));
  const metadataPairs = parsedEntries
    .filter(({ entry, parsed }) => csvKind(entry, parsed) === "metadata")
    .flatMap(({ entry }) => parseMetadata(entry.text));

  const issueRows = [];
  const charts = [];
  const drilldowns = [];
  let metadataFileCount = 0;
  let unknownCsvCount = 0;

  for (const { entry, parsed } of parsedEntries) {
    const kind = csvKind(entry, parsed);
    if (kind === "metadata") {
      metadataFileCount += 1;
    } else if (kind === "issue") {
      issueRows.push(...parseIssueRows(entry, parsed));
    } else if (kind === "chart") {
      charts.push(parseChartSummary(entry, parsed));
    } else if (kind === "table") {
      drilldowns.push(parseTableDrilldown(entry, parsed, group, metadataPairs));
    } else {
      const lower = entry.fileName.toLowerCase();
      if (KNOWN_GSC_FILES.has(lower)) unknownCsvCount += 1;
    }
  }

  return { issueRows, charts, drilldowns, metadataFileCount, unknownCsvCount };
}

function aggregateIssues(issueRows) {
  const byKey = new Map();
  for (const row of issueRows) {
    const key = `${row.severity}\0${row.issueKey}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        issueName: row.issueName,
        issueKey: row.issueKey,
        severity: row.severity,
        rows: [],
        sourceValues: new Set(),
        validationValues: new Set(),
        trendValues: new Set(),
      });
    }
    const aggregate = byKey.get(key);
    aggregate.rows.push(row);
    if (row.source) aggregate.sourceValues.add(row.source);
    if (row.validation) aggregate.validationValues.add(row.validation);
    if (row.trend) aggregate.trendValues.add(row.trend);
  }

  return [...byKey.values()]
    .map((aggregate) => {
      const pageRows = aggregate.rows.map((row) => row.pages).filter((value) => value !== null);
      const pages = pageRows.length > 0 ? pageRows.reduce((sum, value) => sum + value, 0) : null;
      return {
        ...aggregate,
        pages,
        hasAffectedPages: pageRows.length === 0 || pageRows.some((value) => value > 0),
        sourceValues: [...aggregate.sourceValues].sort(compareText),
        validationValues: [...aggregate.validationValues].sort(compareText),
        trendValues: [...aggregate.trendValues].sort(compareText),
      };
    })
    .sort((left, right) => {
      const bySeverity = severityRank(left.severity) - severityRank(right.severity);
      if (bySeverity !== 0) return bySeverity;
      return compareText(left.issueName, right.issueName);
    });
}

function aggregateUrlGroups(drilldowns) {
  const byKey = new Map();
  for (const drilldown of drilldowns) {
    for (const url of drilldown.urls) {
      const key = pathQueryKeyForUrl(url);
      if (!byKey.has(key)) {
        byKey.set(key, { key, urls: new Set(), issues: new Set() });
      }
      const aggregate = byKey.get(key);
      aggregate.urls.add(url);
      aggregate.issues.add(drilldown.issueName);
    }
  }

  return [...byKey.values()]
    .map((aggregate) => ({
      key: aggregate.key,
      urls: [...aggregate.urls].sort(compareText),
      issues: [...aggregate.issues].sort(compareText),
    }))
    .sort((left, right) => compareText(left.key, right.key));
}

export async function analyzeGscCoverageInputs(inputPaths) {
  const collected = collectInputEntries(inputPaths);
  const groups = groupEntries(collected.entries);

  const issueRows = [];
  const charts = [];
  const drilldowns = [];
  let metadataFileCount = 0;
  let unknownCsvCount = 0;

  for (const group of groups) {
    const parsed = parseGroup(group);
    issueRows.push(...parsed.issueRows);
    charts.push(...parsed.charts);
    drilldowns.push(...parsed.drilldowns);
    metadataFileCount += parsed.metadataFileCount;
    unknownCsvCount += parsed.unknownCsvCount;
  }

  const issueCounts = aggregateIssues(issueRows);
  const drilldownKeys = new Set(drilldowns.map((drilldown) => drilldown.issueKey).filter(Boolean));
  const missingDrilldowns = issueCounts.filter(
    (issue) => issue.hasAffectedPages && issue.issueKey && !drilldownKeys.has(issue.issueKey),
  );

  return {
    inputs: collected.inputs,
    notes: collected.notes,
    parsedFileCounts: {
      csv: collected.entries.length,
      chart: charts.length,
      metadata: metadataFileCount,
      issue: issueRows.length,
      drilldown: drilldowns.length,
      unknown: unknownCsvCount,
    },
    charts: charts.sort((left, right) => compareText(left.sourceLabel, right.sourceLabel)),
    issueCounts,
    drilldowns: drilldowns.sort((left, right) => {
      const byIssue = compareText(left.issueName, right.issueName);
      if (byIssue !== 0) return byIssue;
      return compareText(left.sourceLabel, right.sourceLabel);
    }),
    urlGroups: aggregateUrlGroups(drilldowns),
    missingDrilldowns,
  };
}

function formatPages(value) {
  return value === null ? "unknown" : String(value);
}

function formatValues(label, values) {
  if (!values || values.length === 0) return "";
  return ` | ${label}=${values.join(", ")}`;
}

export function renderGscCoverageReport(report) {
  const lines = [];
  appendGscReportPreamble(lines, {
    title: "GSC Coverage Inventory",
    inputs: report.inputs,
    notes: report.notes,
    parsedFileCounts: [
      ["CSV files", report.parsedFileCounts.csv],
      ["Chart.csv files", report.parsedFileCounts.chart],
      ["Metadata.csv files", report.parsedFileCounts.metadata],
      ["Issue rows", report.parsedFileCounts.issue],
      ["Table.csv drilldowns", report.parsedFileCounts.drilldown],
      ...(report.parsedFileCounts.unknown > 0
        ? [["Unrecognized known GSC CSV files", report.parsedFileCounts.unknown]]
        : []),
    ],
  });

  appendGscReportSection(lines, "Chart snapshots:", report.charts, (chart) => {
    const metricSuffix = chart.latestMetrics.length > 0 ? ` | latest=${chart.latestMetrics.join(", ")}` : "";
    const dateSuffix = chart.latestDate ? ` | latestDate=${chart.latestDate}` : "";
    return `${chart.sourceLabel} | rows=${chart.rowCount}${dateSuffix}${metricSuffix}`;
  });

  appendGscReportSection(lines, "Issue counts:", report.issueCounts, (issue) =>
    `[${issue.severity}] ${issue.issueName} | pages=${formatPages(issue.pages)} | exportRows=${issue.rows.length}` +
    formatValues("source", issue.sourceValues) +
    formatValues("validation", issue.validationValues) +
    formatValues("trend", issue.trendValues),
  );

  const issueKeys = new Set(report.issueCounts.map((issue) => issue.issueKey));
  appendGscReportSection(lines, "Drilldown issue mapping:", report.drilldowns, (drilldown) => {
    const matched = issueKeys.has(drilldown.issueKey) ? "yes" : "no";
    return `${drilldown.issueName} | urls=${drilldown.urlCount} | pathQueryGroups=${drilldown.urlGroups.length} | matchedIssue=${matched} | source=${drilldown.sourceLabel}`;
  });

  appendGscReportSection(lines, "URL groups by path/query key:", report.urlGroups, (group) => {
    const samples = group.urls.slice(0, 3).join(", ");
    return `${group.key} | urls=${group.urls.length} | issues=${group.issues.join(", ")} | samples=${samples}`;
  });

  appendGscReportSection(lines, "Missing drilldowns:", report.missingDrilldowns, (issue) =>
    `[${issue.severity}] ${issue.issueName} | pages=${formatPages(issue.pages)} | expected=export matching Table.csv drilldown before URL-level triage`,
  );

  lines.push("Manual live-check plan fields:");
  lines.push(`- ${LIVE_CHECK_FIELDS.join(", ")}`);
  lines.push("");
  lines.push("Manual live-check plan rows:");
  if (report.urlGroups.length === 0) {
    lines.push("- none until Table.csv drilldowns are supplied");
  } else {
    for (const group of report.urlGroups) {
      lines.push(
        `- issue=${group.issues.join(", ")} | pathQueryKey=${group.key} | sampleUrl=${group.urls[0]} | urlCount=${group.urls.length} | liveCheckFields=${LIVE_CHECK_FIELDS.slice(4).join(",")}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function usage() {
  return formatGscUsage([
    "Usage: npm run analyze:gsc-coverage -- <gsc-export-dir-or-file> [...more paths]",
    "",
    "Accepts GSC coverage/drilldown directories, ZIP files, CSV files, and XLSX/XLS files.",
    "XLSX/XLS files are reported as unsupported unless the data is exported as CSV; this script does not add dependencies.",
  ]);
}

export async function runCli(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr) {
  const args = [];
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      writeGscUsage(stdout, usage());
      return 0;
    }
    if (arg.startsWith("-")) {
      writeGscUnknownOption(stderr, arg, usage());
      return 1;
    }
    args.push(arg);
  }

  if (args.length === 0) {
    writeGscUsage(stderr, usage());
    return 1;
  }

  return runGscCli(async () => {
    const report = await analyzeGscCoverageInputs(args);
    stdout.write(renderGscCoverageReport(report));
    return 0;
  }, stderr);
}

runAsyncDirect(import.meta.url, process.argv[1], runCli);

#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { appendGscReportPreamble, runAsyncDirect } from "../lib/gsc-report.mts";

const CSV_EXT = ".csv";
const ZIP_EXT = ".zip";
const UNSUPPORTED_SHEET_EXTENSIONS = new Set([".xlsx", ".xls"]);
const KNOWN_GSC_FILES = new Set([
  "chart.csv",
  "critical issues.csv",
  "non-critical issues.csv",
  "metadata.csv",
  "table.csv",
]);

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

export function compareText(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  const lowerLeft = left.toLowerCase();
  const lowerRight = right.toLowerCase();
  if (lowerLeft < lowerRight) return -1;
  if (lowerLeft > lowerRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function normalizeHeaderName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\uFEFF/, "")
    .replace(/[^a-z0-9]+/g, "");
}

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

function cleanPathLabel(value) {
  const base = path.basename(String(value ?? ""));
  return base
    .replace(/\.(csv|zip|xlsx|xls)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

function cleanStandaloneCsvIssueLabel(value) {
  const base = path.basename(String(value ?? ""));
  return base
    .replace(/\.(csv|zip|xlsx|xls)$/i, "")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function displayPath(inputPath) {
  const relative = path.relative(process.cwd(), inputPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return inputPath;
  return relative;
}

export function stripBom(value) {
  return String(value ?? "").replace(/^\uFEFF/, "");
}

export function parseCsv(text) {
  const input = stripBom(String(text ?? ""));
  if (input.length === 0) return [];

  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char === "\r") {
      if (input[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0 || input.endsWith(",")) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((candidate) => candidate.some((value) => value.trim().length > 0));
}

export function uniqueHeaders(headers) {
  const seen = new Map();
  return headers.map((header, index) => {
    const trimmed = stripBom(String(header ?? "").trim()) || `column_${index + 1}`;
    const key = normalizeHeaderName(trimmed) || `column${index + 1}`;
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? trimmed : `${trimmed}_${count + 1}`;
  });
}

function csvRecords(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], records: [], rawRows: [] };
  const headers = uniqueHeaders(rows[0] ?? []);
  const records = rows.slice(1).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = String(row[index] ?? "").trim();
    });
    return record;
  });
  return { headers, records, rawRows: rows };
}

function buildHeaderLookup(record) {
  const lookup = new Map();
  for (const key of Object.keys(record)) {
    lookup.set(normalizeHeaderName(key), key);
  }
  return lookup;
}

function getField(record, candidates) {
  const lookup = buildHeaderLookup(record);
  for (const candidate of candidates) {
    const key = lookup.get(normalizeHeaderName(candidate));
    if (key && String(record[key] ?? "").trim()) return String(record[key]).trim();
  }
  return "";
}

function hasHeader(headers, candidates) {
  const normalized = new Set(headers.map((header) => normalizeHeaderName(header)));
  return candidates.some((candidate) => normalized.has(normalizeHeaderName(candidate)));
}

export function isDigit(char) {
  return char >= "0" && char <= "9";
}

export function firstNumberToken(value) {
  const cleaned = String(value ?? "").replaceAll(",", "");
  for (let index = 0; index < cleaned.length; index += 1) {
    const char = cleaned[index] ?? "";
    const startsNegativeNumber = char === "-" && isDigit(cleaned[index + 1] ?? "");
    if (!isDigit(char) && !startsNegativeNumber) continue;

    let end = index + (startsNegativeNumber ? 1 : 0);
    let sawDot = false;
    while (end < cleaned.length) {
      const next = cleaned[end] ?? "";
      if (isDigit(next)) {
        end += 1;
      } else if (next === "." && !sawDot) {
        sawDot = true;
        end += 1;
      } else {
        break;
      }
    }
    const token = cleaned.slice(index, end);
    return token === "-" || token === "." || token === "-." ? "" : token;
  }
  return "";
}

function parseCount(value) {
  const token = firstNumberToken(value);
  if (!token) return null;
  const parsed = Number(token);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
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

function normalizeZipEntryPath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function decodeZipName(buffer) {
  return buffer.toString("utf8");
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function readZipCsvEntries(buffer, zipPath) {
  const notes = [];
  const entries = [];
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    notes.push(`${zipPath}: unsupported ZIP file; central directory was not found.`);
    return { entries, notes };
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      notes.push(`${zipPath}: unsupported ZIP file; central directory entry ${index + 1} is malformed.`);
      break;
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    const entryName = normalizeZipEntryPath(decodeZipName(buffer.subarray(nameStart, nameEnd)));
    offset = nameEnd + extraLength + commentLength;

    if (!entryName || entryName.endsWith("/")) continue;

    const ext = path.posix.extname(entryName).toLowerCase();
    const zipEntryLabel = `${zipPath}:${entryName}`;
    if (UNSUPPORTED_SHEET_EXTENSIONS.has(ext)) {
      notes.push(
        `${zipEntryLabel}: XLSX/XLS parsing is unsupported without adding a dependency; export this GSC data as CSV or ZIP of CSV files.`,
      );
      continue;
    }
    if (ext !== CSV_EXT) continue;

    if ((flags & 0x1) !== 0) {
      notes.push(`${zipEntryLabel}: encrypted ZIP entries are unsupported; skipped.`);
      continue;
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      notes.push(`${zipEntryLabel}: ZIP64 entries are unsupported; skipped.`);
      continue;
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      notes.push(`${zipEntryLabel}: ZIP compression method ${compressionMethod} is unsupported; skipped.`);
      continue;
    }
    if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      notes.push(`${zipEntryLabel}: local ZIP header is malformed; skipped.`);
      continue;
    }

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      notes.push(`${zipEntryLabel}: compressed payload is truncated; skipped.`);
      continue;
    }

    const compressed = buffer.subarray(dataStart, dataEnd);
    const payload = compressionMethod === 8 ? inflateRawSync(compressed) : compressed;
    entries.push({ entryName, buffer: payload, sourceLabel: zipEntryLabel });
  }

  return { entries, notes };
}

function addCsvEntry(collected, inputPath, containerPath, containerName, relativePath, buffer, sourceLabel) {
  const normalizedRelativePath = normalizeZipEntryPath(relativePath);
  collected.entries.push({
    inputPath,
    containerPath,
    containerName,
    relativePath: normalizedRelativePath,
    fileName: path.posix.basename(normalizedRelativePath),
    sourceLabel,
    text: buffer.toString("utf8"),
  });
}

function addUnsupportedSheetNote(notes, label) {
  notes.push(
    `${label}: XLSX/XLS parsing is unsupported without adding a dependency; export this GSC data as CSV or ZIP of CSV files.`,
  );
}

function collectFromFile(filePath, collected, options = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const inputPath = options.inputPath ?? filePath;
  const sourceLabel = options.sourceLabel ?? displayPath(filePath);

  if (ext === CSV_EXT) {
    const relativePath = options.relativePath ?? path.basename(filePath);
    const containerPath = options.containerPath ?? filePath;
    const containerName = options.containerName ?? cleanPathLabel(filePath);
    addCsvEntry(collected, inputPath, containerPath, containerName, relativePath, readFileSync(filePath), sourceLabel);
    return;
  }

  if (ext === ZIP_EXT) {
    const zipBuffer = readFileSync(filePath);
    const zipPathLabel = sourceLabel;
    const zipContainerName = cleanPathLabel(filePath);
    const { entries, notes } = readZipCsvEntries(zipBuffer, zipPathLabel);
    collected.notes.push(...notes);
    for (const entry of entries) {
      addCsvEntry(collected, inputPath, filePath, zipContainerName, entry.entryName, entry.buffer, entry.sourceLabel);
    }
    return;
  }

  if (UNSUPPORTED_SHEET_EXTENSIONS.has(ext)) {
    addUnsupportedSheetNote(collected.notes, sourceLabel);
  }
}

function walkDirectory(directoryPath, collected, inputPath, rootDirectory) {
  const entries = readdirSync(directoryPath, { withFileTypes: true }).sort((left, right) =>
    compareText(left.name, right.name),
  );
  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(absolutePath, collected, inputPath, rootDirectory);
      continue;
    }
    if (!entry.isFile()) continue;

    const relativePath = path.relative(rootDirectory, absolutePath).replaceAll(path.sep, "/");
    const ext = path.extname(entry.name).toLowerCase();
    if (ext === CSV_EXT) {
      const fileName = path.posix.basename(relativePath).toLowerCase();
      const isStandaloneCsv = !KNOWN_GSC_FILES.has(fileName);
      addCsvEntry(
        collected,
        inputPath,
        isStandaloneCsv ? absolutePath : rootDirectory,
        isStandaloneCsv ? cleanStandaloneCsvIssueLabel(absolutePath) : cleanPathLabel(rootDirectory),
        isStandaloneCsv ? path.basename(absolutePath) : relativePath,
        readFileSync(absolutePath),
        displayPath(absolutePath),
      );
    } else if (ext === ZIP_EXT) {
      collectFromFile(absolutePath, collected, { inputPath, sourceLabel: displayPath(absolutePath) });
    } else if (UNSUPPORTED_SHEET_EXTENSIONS.has(ext)) {
      addUnsupportedSheetNote(collected.notes, displayPath(absolutePath));
    }
  }
}

export function collectInputEntries(inputPaths) {
  const collected = { entries: [], notes: [], inputs: [] };
  const resolvedInputs = inputPaths.map((inputPath) => path.resolve(inputPath)).sort(compareText);

  for (const inputPath of resolvedInputs) {
    collected.inputs.push(displayPath(inputPath));
    if (!existsSync(inputPath)) {
      collected.notes.push(`${displayPath(inputPath)}: input path does not exist; skipped.`);
      continue;
    }

    const stats = statSync(inputPath);
    if (stats.isDirectory()) {
      walkDirectory(inputPath, collected, inputPath, inputPath);
    } else if (stats.isFile()) {
      collectFromFile(inputPath, collected, { inputPath, sourceLabel: displayPath(inputPath) });
    }
  }

  collected.entries.sort((left, right) => {
    const byContainer = compareText(left.containerPath, right.containerPath);
    if (byContainer !== 0) return byContainer;
    return compareText(left.relativePath, right.relativePath);
  });
  collected.notes = [...new Set(collected.notes)].sort(compareText);
  return collected;
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

  lines.push("Chart snapshots:");
  if (report.charts.length === 0) {
    lines.push("- none");
  } else {
    for (const chart of report.charts) {
      const metricSuffix = chart.latestMetrics.length > 0 ? ` | latest=${chart.latestMetrics.join(", ")}` : "";
      const dateSuffix = chart.latestDate ? ` | latestDate=${chart.latestDate}` : "";
      lines.push(`- ${chart.sourceLabel} | rows=${chart.rowCount}${dateSuffix}${metricSuffix}`);
    }
  }
  lines.push("");

  lines.push("Issue counts:");
  if (report.issueCounts.length === 0) {
    lines.push("- none");
  } else {
    for (const issue of report.issueCounts) {
      lines.push(
        `- [${issue.severity}] ${issue.issueName} | pages=${formatPages(issue.pages)} | exportRows=${issue.rows.length}` +
          formatValues("source", issue.sourceValues) +
          formatValues("validation", issue.validationValues) +
          formatValues("trend", issue.trendValues),
      );
    }
  }
  lines.push("");

  lines.push("Drilldown issue mapping:");
  if (report.drilldowns.length === 0) {
    lines.push("- none");
  } else {
    const issueKeys = new Set(report.issueCounts.map((issue) => issue.issueKey));
    for (const drilldown of report.drilldowns) {
      const matched = issueKeys.has(drilldown.issueKey) ? "yes" : "no";
      lines.push(
        `- ${drilldown.issueName} | urls=${drilldown.urlCount} | pathQueryGroups=${drilldown.urlGroups.length} | matchedIssue=${matched} | source=${drilldown.sourceLabel}`,
      );
    }
  }
  lines.push("");

  lines.push("URL groups by path/query key:");
  if (report.urlGroups.length === 0) {
    lines.push("- none");
  } else {
    for (const group of report.urlGroups) {
      const samples = group.urls.slice(0, 3).join(", ");
      lines.push(`- ${group.key} | urls=${group.urls.length} | issues=${group.issues.join(", ")} | samples=${samples}`);
    }
  }
  lines.push("");

  lines.push("Missing drilldowns:");
  if (report.missingDrilldowns.length === 0) {
    lines.push("- none");
  } else {
    for (const issue of report.missingDrilldowns) {
      lines.push(
        `- [${issue.severity}] ${issue.issueName} | pages=${formatPages(issue.pages)} | expected=export matching Table.csv drilldown before URL-level triage`,
      );
    }
  }
  lines.push("");

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
  return [
    "Usage: npm run analyze:gsc-coverage -- <gsc-export-dir-or-file> [...more paths]",
    "",
    "Accepts GSC coverage/drilldown directories, ZIP files, CSV files, and XLSX/XLS files.",
    "XLSX/XLS files are reported as unsupported unless the data is exported as CSV; this script does not add dependencies.",
  ].join("\n");
}

export async function runCli(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr) {
  const args = [];
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      stdout.write(`${usage()}\n`);
      return 0;
    }
    if (arg.startsWith("-")) {
      stderr.write(`Unknown option: ${arg}\n\n${usage()}\n`);
      return 1;
    }
    args.push(arg);
  }

  if (args.length === 0) {
    stderr.write(`${usage()}\n`);
    return 1;
  }

  const report = await analyzeGscCoverageInputs(args);
  stdout.write(renderGscCoverageReport(report));
  return 0;
}

runAsyncDirect(import.meta.url, process.argv[1], runCli);

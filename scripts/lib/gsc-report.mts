import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { toErrorMessage } from "@shared/lib/error-utils";
import { isDirectRun } from "./smoke-runtime.mjs";

const CSV_EXT = ".csv";
const ZIP_EXT = ".zip";
const UNSUPPORTED_SHEET_EXTENSIONS = new Set([".xlsx", ".xls"]);
export const KNOWN_GSC_FILES = new Set([
  "chart.csv",
  "critical issues.csv",
  "non-critical issues.csv",
  "metadata.csv",
  "table.csv",
]);

export interface GscInputEntry {
  inputPath: string;
  containerPath: string;
  containerName: string;
  relativePath: string;
  fileName: string;
  sourceLabel: string;
  text: string;
}

export interface GscCollectedInputs {
  entries: GscInputEntry[];
  notes: string[];
  inputs: string[];
}

interface GscCollectionOptions {
  inputPath?: string;
  sourceLabel?: string;
  relativePath?: string;
  containerPath?: string;
  containerName?: string;
}

interface ZipCsvEntry {
  entryName: string;
  buffer: Buffer;
  sourceLabel: string;
}

export interface GscOutput {
  write(text: string): unknown;
}

export function compareText(a: unknown, b: unknown): number {
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

export function normalizeHeaderName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\uFEFF/, "")
    .replace(/[^a-z0-9]+/g, "");
}

export function stripBom(value: unknown): string {
  return String(value ?? "").replace(/^\uFEFF/, "");
}

export function parseCsv(text: unknown): string[][] {
  const input = stripBom(String(text ?? ""));
  if (input.length === 0) return [];

  const rows: string[][] = [];
  let row: string[] = [];
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

export function uniqueHeaders(headers: readonly unknown[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header, index) => {
    const trimmed = stripBom(String(header ?? "").trim()) || `column_${index + 1}`;
    const key = normalizeHeaderName(trimmed) || `column${index + 1}`;
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? trimmed : `${trimmed}_${count + 1}`;
  });
}

export function recordFromCsvRow(headers: readonly string[], row: readonly unknown[]): Record<string, string> {
  return Object.fromEntries(headers.map((header, index) => [header, String(row[index] ?? "").trim()]));
}

export function findHeader(headers: readonly string[], candidates: readonly string[]): string {
  const lookup = new Map(headers.map((header) => [normalizeHeaderName(header), header]));
  for (const candidate of candidates) {
    const header = lookup.get(normalizeHeaderName(candidate));
    if (header) return header;
  }
  return "";
}

export const hasHeader = (headers: readonly string[], candidates: readonly string[]): boolean => findHeader(headers, candidates) !== "";

export function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

export function firstNumberToken(value: unknown): string {
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

export function parseCsvNumber(value: unknown): number | null {
  const token = firstNumberToken(value); const parsed = Number(token);
  return token && Number.isFinite(parsed) ? parsed : null;
}

export function parsePositiveNumber(value: unknown, optionName: string, { integer = false } = {}): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`Invalid ${optionName}: ${value}`);
  }
  return parsed;
}

export function displayPath(inputPath: string): string {
  const relative = path.relative(process.cwd(), inputPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return inputPath;
  return relative;
}

function normalizeZipEntryPath(value: unknown): string {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function decodeZipName(buffer: Buffer): string {
  return buffer.toString("utf8");
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const signature = 0x06054b50;
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function readZipCsvEntries(buffer: Buffer, zipPath: string): { entries: ZipCsvEntry[]; notes: string[] } {
  const notes: string[] = [];
  const entries: ZipCsvEntry[] = [];
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

function addCsvEntry(
  collected: GscCollectedInputs,
  inputPath: string,
  containerPath: string,
  containerName: string,
  relativePath: string,
  buffer: Buffer,
  sourceLabel: string,
): void {
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

function addUnsupportedSheetNote(notes: string[], label: string): void {
  notes.push(
    `${label}: XLSX/XLS parsing is unsupported without adding a dependency; export this GSC data as CSV or ZIP of CSV files.`,
  );
}

function collectFromFile(filePath: string, collected: GscCollectedInputs, options: GscCollectionOptions = {}): void {
  const ext = path.extname(filePath).toLowerCase();
  const inputPath = options.inputPath ?? filePath;
  const sourceLabel = options.sourceLabel ?? displayPath(filePath);

  if (ext === CSV_EXT) {
    const relativePath = options.relativePath ?? path.basename(filePath);
    const containerPath = options.containerPath ?? filePath;
    const containerName = options.containerName ?? cleanPathLabel(filePath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- report inputs are explicit CLI arguments
    addCsvEntry(collected, inputPath, containerPath, containerName, relativePath, readFileSync(filePath), sourceLabel);
    return;
  }

  if (ext === ZIP_EXT) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- report inputs are explicit CLI arguments
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

export function cleanPathLabel(value: unknown): string {
  const base = path.basename(String(value ?? ""));
  return base
    .replace(/\.(csv|zip|xlsx|xls)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

function cleanStandaloneCsvIssueLabel(value: unknown): string {
  const base = path.basename(String(value ?? ""));
  return base
    .replace(/\.(csv|zip|xlsx|xls)$/i, "")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function walkDirectory(directoryPath: string, collected: GscCollectedInputs, inputPath: string, rootDirectory: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- report inputs are explicit CLI arguments
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
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- report inputs are explicit CLI arguments
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

export function collectInputEntries(inputPaths: readonly string[]): GscCollectedInputs {
  const collected: GscCollectedInputs = { entries: [], notes: [], inputs: [] };
  const resolvedInputs = inputPaths.map((inputPath) => path.resolve(inputPath)).sort(compareText);

  for (const inputPath of resolvedInputs) {
    collected.inputs.push(displayPath(inputPath));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- report inputs are explicit CLI arguments
    if (!existsSync(inputPath)) {
      collected.notes.push(`${displayPath(inputPath)}: input path does not exist; skipped.`);
      continue;
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- report inputs are explicit CLI arguments
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

export function formatGscUsage(lines: readonly string[]): string {
  return lines.join("\n");
}

export function writeGscUsage(output: GscOutput, usage: string): void {
  output.write(`${usage}\n`);
}

export function writeGscUnknownOption(output: GscOutput, arg: string, usage: string): void {
  output.write(`Unknown option: ${arg}\n\n${usage}\n`);
}

export function writeGscError(output: GscOutput, error: unknown): void {
  output.write(`${toErrorMessage(error)}\n`);
}

export async function runGscCli(
  action: () => number | void | Promise<number | void>,
  stderr: GscOutput = process.stderr,
): Promise<number> {
  try {
    return (await action()) ?? 0;
  } catch (error) {
    writeGscError(stderr, error);
    return 1;
  }
}

export function appendGscReportSection<T>(
  lines: string[],
  title: string,
  values: readonly T[],
  render: (value: T) => string = (value) => String(value),
  empty = "- none",
): void {
  lines.push(title.endsWith(":") ? title : `${title}:`);
  if (values.length === 0) {
    lines.push(empty);
  } else {
    for (const value of values) lines.push(`- ${render(value)}`);
  }
  lines.push("");
}

export function appendGscReportPreamble(lines: string[], {
  title,
  detailLines = [],
  inputs,
  notes,
  parsedFileCounts,
}: {
  title: string;
  detailLines?: readonly string[];
  inputs: readonly string[];
  notes: readonly string[];
  parsedFileCounts: readonly (readonly [string, number])[];
}): void {
  lines.push(title);
  lines.push("No live network checks were performed.");
  for (const detail of detailLines) lines.push(detail);
  lines.push("");

  appendGscReportSection(lines, "Inputs", inputs);
  appendGscReportSection(lines, "Unsupported or skipped files", notes);

  lines.push("Parsed files:");
  for (const [label, count] of parsedFileCounts) {
    lines.push(`- ${label}: ${count}`);
  }
  lines.push("");
}

export function runAsyncDirect(importMetaUrl: string, argv1: string | undefined, runCli: () => Promise<number>): boolean {
  if (!isDirectRun(importMetaUrl, argv1)) return false;

  runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(toErrorMessage(error));
      process.exitCode = 1;
    },
  );
  return true;
}

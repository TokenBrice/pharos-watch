/* eslint-disable security/detect-non-literal-fs-filename -- repo-local validator reads checked-in files under the repository root only. */
/* eslint-disable security/detect-non-literal-regexp -- this validator builds small scoped regexes from fixed local labels/constants. */
/* eslint-disable security/detect-unsafe-regex -- the regexes run only on bounded checked-in source/docs, not untrusted input. */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Failure = {
  file: string;
  label: string;
  expected: string;
  found: string | null;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../../..");

export function read(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf-8");
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeNumber(value: string): number {
  return Number(value.replace(/[_,$`]/g, "").trim());
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

export function findLineValue(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match?.[1] ?? null;
}

export function getTableRowCells(text: string, rowLabel: string): string[] | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells[0] === rowLabel) {
      return cells.slice(1);
    }
  }
  return null;
}

export function getFirstNumberFromText(text: string): number | null {
  const match = text.match(/-?\d[\d,]*(?:\.\d+)?/);
  return match ? normalizeNumber(match[0]) : null;
}

export function getAllNumbersFromText(text: string): number[] {
  return Array.from(text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g), (match) => normalizeNumber(match[0]));
}

export function extractConstNumber(source: string, name: string): number {
  const pattern = new RegExp(
    `(?:export\\s+)?const\\s+${escapeRegex(name)}(?:\\s*:[^=]+)?\\s*=\\s*([0-9][0-9_]*(?:\\.\\d+)?)`,
  );
  const value = findLineValue(source, pattern);
  if (!value) {
    throw new Error(`Could not find constant ${name}`);
  }
  return normalizeNumber(value);
}

export function extractObjectBlock(source: string, name: string): string {
  const pattern = new RegExp(
    `(?:export\\s+)?const\\s+${escapeRegex(name)}(?:\\s*:[^=]+)?\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*(?:as const)?;`,
  );
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Could not find object block ${name}`);
  }
  return match[1];
}

export function extractNumericObject(source: string, name: string): Record<string, number> {
  const block = extractObjectBlock(source, name);
  const entries: Record<string, number> = {};
  const pattern = /^\s*(?:"([^"]+)"|([A-Za-z0-9_]+))\s*:\s*([0-9][0-9_]*(?:\.\d+)?)\s*,?/gm;

  for (const match of block.matchAll(pattern)) {
    const key = match[1] ?? match[2];
    if (!key) continue;
    entries[key] = normalizeNumber(match[3]);
  }

  return entries;
}

export function extractStringObject(source: string, name: string): Record<string, string> {
  const block = extractObjectBlock(source, name);
  const entries: Record<string, string> = {};
  const pattern = /^\s*(?:"([^"]+)"|([A-Za-z0-9_]+))\s*:\s*"([^"]+)"\s*,?/gm;

  for (const match of block.matchAll(pattern)) {
    const key = match[1] ?? match[2];
    if (!key) continue;
    entries[key] = match[3];
  }

  return entries;
}

export function extractGradeThresholds(source: string): Record<string, number> {
  const pattern =
    /(?:export\s+)?const\s+GRADE_THRESHOLDS(?:\s*:[^=]+)?\s*=\s*\[([\s\S]*?)\];/;
  const match = source.match(pattern);
  if (!match) {
    throw new Error("Could not find GRADE_THRESHOLDS array");
  }

  const thresholds: Record<string, number> = {};
  const rowPattern = /\{\s*grade:\s*"([^"]+)",\s*min:\s*([0-9][0-9_]*)\s*\}/g;
  for (const row of match[1].matchAll(rowPattern)) {
    thresholds[row[1]] = normalizeNumber(row[2]);
  }
  return thresholds;
}

export function extractBandRows(source: string): Array<{ range: string; band: string }> {
  const thresholds = Array.from(
    source.matchAll(/if \(score <= (\d+)\) return "([A-Z]+)";/g),
    (match) => ({ upper: normalizeNumber(match[1]), band: match[2] }),
  );

  if (thresholds.length !== 4) {
    throw new Error("Could not parse DEWS threat-band thresholds");
  }

  const rows: Array<{ range: string; band: string }> = [];
  let lower = 0;
  for (const { upper, band } of thresholds) {
    rows.push({ range: `${lower}-${upper}`, band });
    lower = upper + 1;
  }
  rows.push({ range: `${lower}-100`, band: "DANGER" });
  return rows;
}

export function extractNamedMultipliers(source: string, names: string[]): Record<string, number> {
  const multipliers: Record<string, number> = {};
  for (const name of names) {
    const value = findLineValue(source, new RegExp(`${escapeRegex(name)}\\s*\\*\\s*(0?\\.\\d+)`));
    if (!value) {
      throw new Error(`Could not find multiplier for ${name}`);
    }
    multipliers[name] = normalizeNumber(value);
  }
  return multipliers;
}

export function expectEqual(
  failures: Failure[],
  file: string,
  label: string,
  found: string | null,
  expected: string,
): void {
  if (found !== expected) {
    failures.push({ file, label, expected, found });
  }
}

export function expectNumber(
  failures: Failure[],
  file: string,
  label: string,
  found: number | null,
  expected: number,
): void {
  const expectedText = formatNumber(expected);
  const foundText = found === null ? null : formatNumber(found);
  if (found === null || found !== expected) {
    failures.push({ file, label, expected: expectedText, found: foundText });
  }
}

export function requireTableRow(text: string, file: string, rowLabel: string): string[] {
  const row = getTableRowCells(text, rowLabel);
  if (!row) {
    throw new Error(`Could not find table row "${rowLabel}" in ${file}`);
  }
  return row;
}

/* eslint-disable security/detect-non-literal-fs-filename -- repo-local validator reads checked-in files under the repository root only. */
/* eslint-disable security/detect-unsafe-regex -- the regexes run only on bounded checked-in docs, not untrusted input. */

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

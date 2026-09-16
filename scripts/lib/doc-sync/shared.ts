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


export function findLineValue(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match?.[1] ?? null;
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


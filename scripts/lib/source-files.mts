import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { isDirectRun } from "./smoke-runtime.mjs";

export const DEFAULT_SOURCE_FILE_EXCLUDED_DIRS = new Set(["__tests__", "__mocks__", "node_modules"]);

interface CollectSourceFileOptions {
  extensions?: Iterable<string>;
  excludedDirs?: Iterable<string>;
  skipDotEntries?: boolean;
}

export function resolveSourceRoot(root: string, cwd = process.cwd()): string {
  return isAbsolute(root) ? root : join(cwd, root);
}

/**
 * @param {string} rootDir
 * @param {{ extensions?: Iterable<string>, excludedDirs?: Iterable<string>, skipDotEntries?: boolean }} [options]
 */
export function collectSourceFiles(
  rootDir: string,
  {
    extensions,
    excludedDirs = DEFAULT_SOURCE_FILE_EXCLUDED_DIRS,
    skipDotEntries = false,
  }: CollectSourceFileOptions = {},
): string[] {
  const extensionSet = extensions instanceof Set ? extensions : new Set(extensions ?? []);
  const excludedDirSet = excludedDirs instanceof Set ? excludedDirs : new Set(excludedDirs ?? []);
  const files: string[] = [];

  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skipDotEntries && entry.name.startsWith(".")) continue;
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excludedDirSet.has(entry.name)) continue;
        visit(entryPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (extensionSet.size > 0 && !extensionSet.has(extname(entry.name))) continue;
      files.push(entryPath);
    }
  }

  visit(rootDir);
  return files;
}

/**
 * @param {string} root
 * @param {string} cwd
 * @param {{ extensions?: Iterable<string>, excludedDirs?: Iterable<string>, skipDotEntries?: boolean }} [options]
 */
export function collectSourceFilesUnderRoot(
  root: string,
  cwd = process.cwd(),
  { extensions, excludedDirs, skipDotEntries }: CollectSourceFileOptions = {},
): string[] {
  const absolute = resolveSourceRoot(root, cwd);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [absolute];
  return collectSourceFiles(absolute, { extensions, excludedDirs, skipDotEntries });
}

export function formatScannedOk(label: string, count: number): string {
  return `${label}: OK (${count} file${count === 1 ? "" : "s"} scanned)\n`;
}

export function runAsCli(importMetaUrl: string, main: () => number | void): void {
  if (isDirectRun(importMetaUrl, process.argv[1])) {
    const exitCode = main();
    if (exitCode !== undefined) process.exitCode = exitCode;
  }
}

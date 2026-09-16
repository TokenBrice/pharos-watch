import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";

export const DEFAULT_SOURCE_FILE_EXCLUDED_DIRS = new Set(["__tests__", "__mocks__", "node_modules"]);

interface CollectSourceFileOptions {
  extensions?: Iterable<string>;
  excludedDirs?: Iterable<string>;
  skipDotEntries?: boolean;
}

export function normalizeRelPath(path: string): string {
  return path.replaceAll("\\", "/");
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
    // The scanner intentionally walks the caller-selected source root.
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

/**
 * @param {readonly string[]} roots
 * @param {string} cwd
 * @param {{ extensions?: Iterable<string>, excludedDirs?: Iterable<string>, skipDotEntries?: boolean }} [options]
 */
export function collectSourceFilesUnderRoots(
  roots: readonly string[],
  cwd = process.cwd(),
  options: CollectSourceFileOptions = {},
): string[] {
  const extensionSet = options.extensions === undefined ? undefined : new Set(options.extensions);
  const excludedDirSet = options.excludedDirs === undefined
    ? undefined
    : options.excludedDirs instanceof Set
      ? options.excludedDirs
      : new Set(options.excludedDirs);
  const normalizedOptions: CollectSourceFileOptions = {
    ...options,
    ...(extensionSet === undefined ? {} : { extensions: extensionSet }),
    ...(excludedDirSet === undefined ? {} : { excludedDirs: excludedDirSet }),
  };

  return roots
    .flatMap((root) => collectSourceFilesUnderRoot(root, cwd, normalizedOptions))
    .filter((file) => extensionSet === undefined || extensionSet.size === 0 || extensionSet.has(extname(file)))
    .map((file) => relative(cwd, file).replaceAll("\\", "/"))
    .sort();
}

export function formatScannedOk(label: string, count: number): string {
  return `${label}: OK (${count} file${count === 1 ? "" : "s"} scanned)\n`;
}


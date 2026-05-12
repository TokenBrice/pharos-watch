import { readdirSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";

export const DEFAULT_SOURCE_FILE_EXCLUDED_DIRS = new Set(["__tests__", "__mocks__", "node_modules"]);

export function resolveSourceRoot(root, cwd = process.cwd()) {
  return isAbsolute(root) ? root : join(cwd, root);
}

export function collectSourceFiles(rootDir, { extensions, excludedDirs = DEFAULT_SOURCE_FILE_EXCLUDED_DIRS } = {}) {
  const extensionSet = extensions instanceof Set ? extensions : new Set(extensions ?? []);
  const excludedDirSet = excludedDirs instanceof Set ? excludedDirs : new Set(excludedDirs ?? []);
  const files = [];

  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
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

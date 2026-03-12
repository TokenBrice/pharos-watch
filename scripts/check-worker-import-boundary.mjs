import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WORKER_SRC_DIR = "worker/src";
const SOURCE_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"]);
const WORKER_TO_FRONTEND_IMPORT_PATTERN =
  /(?:from\s+["'][^"']*(?:@\/|src\/)|import\s*\(\s*["'][^"']*(?:@\/|src\/))/;
const FRONTEND_TO_WORKER_IMPORT_PATTERN =
  /(?:from\s+["'][^"']*worker\/src\/|import\s*\(\s*["'][^"']*worker\/src\/)/;

function isSourceFile(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return SOURCE_FILE_EXTENSIONS.has(path.slice(dot));
}

function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      collectFiles(fullPath, files);
      continue;
    }
    if (stats.isFile() && isSourceFile(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function formatMatches(matches) {
  for (const match of matches) {
    process.stderr.write(`${match.file}:${match.line}:${match.text}\n`);
  }
}

function runBoundaryCheck(label, { excludeTests, rootDir, forbiddenPattern }) {
  try {
    const files = collectFiles(rootDir);
    const matches = [];
    for (const file of files) {
      if (excludeTests && file.includes("/__tests__/")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (forbiddenPattern.test(lines[i])) {
          matches.push({
            file,
            line: i + 1,
            text: lines[i],
          });
        }
      }
    }

    if (matches.length > 0) {
      console.error(`[boundary] ${label} failed: found forbidden imports`);
      formatMatches(matches);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`[boundary] ${label} fallback check failed`);
    console.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

const allWorkerOk = runBoundaryCheck("all worker sources", {
  rootDir: WORKER_SRC_DIR,
  excludeTests: false,
  forbiddenPattern: WORKER_TO_FRONTEND_IMPORT_PATTERN,
});

const nonTestWorkerOk = runBoundaryCheck("non-test worker sources", {
  rootDir: WORKER_SRC_DIR,
  excludeTests: true,
  forbiddenPattern: WORKER_TO_FRONTEND_IMPORT_PATTERN,
});

const appDirs = ["src", "shared", "scripts"];
const allFrontendBoundaryOk = appDirs.every((dir) =>
  runBoundaryCheck(`${dir} sources`, {
    rootDir: dir,
    excludeTests: false,
    forbiddenPattern: FRONTEND_TO_WORKER_IMPORT_PATTERN,
  }));

if (!allWorkerOk || !nonTestWorkerOk || !allFrontendBoundaryOk) {
  process.exit(1);
}

console.log("[boundary] Worker import boundary checks passed");

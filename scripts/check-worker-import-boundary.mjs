import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WORKER_SRC_DIR = "worker/src";
const FORBIDDEN_IMPORT_FRAGMENT = "src/lib/";
const SOURCE_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"]);

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

function runFallbackCheck(label, { excludeTests }) {
  try {
    const files = collectFiles(WORKER_SRC_DIR);
    const matches = [];
    for (const file of files) {
      if (excludeTests && file.includes("/__tests__/")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes(FORBIDDEN_IMPORT_FRAGMENT)) {
          matches.push({
            file,
            line: i + 1,
            text: lines[i],
          });
        }
      }
    }

    if (matches.length > 0) {
      console.error(`[boundary] ${label} failed: found forbidden worker -> src/lib imports`);
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

function runCheck(label, args) {
  const result = spawnSync("rg", args, {
    encoding: "utf8",
  });

  if (result.error && result.error.code === "ENOENT") {
    // CI environments may not have ripgrep preinstalled. Fall back to a Node scan.
    const excludeTests = args.includes("--glob");
    return runFallbackCheck(label, { excludeTests });
  }

  if (result.status === 1) {
    return true;
  }

  if (result.status === 0) {
    console.error(`[boundary] ${label} failed: found forbidden worker -> src/lib imports`);
    if (result.stdout) process.stderr.write(result.stdout);
    return false;
  }

  console.error(`[boundary] ${label} check failed to execute rg`);
  if (result.stderr) process.stderr.write(result.stderr);
  return false;
}

const allWorkerOk = runCheck("all worker sources", [
  "-n",
  FORBIDDEN_IMPORT_FRAGMENT,
  WORKER_SRC_DIR,
]);

const nonTestWorkerOk = runCheck("non-test worker sources", [
  "-n",
  FORBIDDEN_IMPORT_FRAGMENT,
  WORKER_SRC_DIR,
  "--glob",
  "!**/__tests__/**",
]);

if (!allWorkerOk || !nonTestWorkerOk) {
  process.exit(1);
}

console.log("[boundary] Worker import boundary checks passed");

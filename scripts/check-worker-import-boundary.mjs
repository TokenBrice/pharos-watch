import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WORKER_SRC_DIR = "worker/src";
const SOURCE_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"]);
const WORKER_TO_FRONTEND_IMPORT_PATTERN = /(?:from\s+["'][^"']*(?:@\/|src\/)|import\s*\(\s*["'][^"']*(?:@\/|src\/))/;
const FRONTEND_TO_WORKER_IMPORT_PATTERN = /(?:from\s+["'][^"']*worker\/src\/|import\s*\(\s*["'][^"']*worker\/src\/)/;

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

// Named cross-boundary validators that intentionally import worker sources to
// assert invariants. Keep this list minimal and document why each entry exists.
// Adding a new waiver is an architectural decision: prefer pushing shared
// metadata into `shared/` and update MAX_BOUNDARY_WAIVERS only when the
// architectural exception is reviewed.
const BOUNDARY_WAIVERS = [
  {
    id: "frozen-invariants-lifecycle-registry-check",
    file: "scripts/check-frozen-invariants.ts",
    reason: "Freeze validation must assert frozen IDs are absent from worker registries and frontend compare fixtures.",
  },
];
const MAX_BOUNDARY_WAIVERS = 1;
if (BOUNDARY_WAIVERS.length > MAX_BOUNDARY_WAIVERS) {
  console.error(
    `[boundary] BOUNDARY_WAIVERS has ${BOUNDARY_WAIVERS.length} entries; cap is ${MAX_BOUNDARY_WAIVERS}. ` +
      "Each waiver is an architectural exception — push shared metadata into `shared/` instead of growing the list, " +
      "or raise MAX_BOUNDARY_WAIVERS with a documented review.",
  );
  process.exit(1);
}
const BOUNDARY_EXEMPT_FILES = new Set(BOUNDARY_WAIVERS.map((waiver) => waiver.file));

function runBoundaryCheck(label, { excludeTests, rootDir, forbiddenPattern }) {
  try {
    const files = collectFiles(rootDir);
    const matches = [];
    for (const file of files) {
      if (excludeTests && file.includes("/__tests__/")) continue;
      if (BOUNDARY_EXEMPT_FILES.has(file)) continue;
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

const appDirs = ["src", "shared", "scripts", "functions"];
const allFrontendBoundaryOk = appDirs.every((dir) =>
  runBoundaryCheck(`${dir} sources`, {
    rootDir: dir,
    excludeTests: false,
    forbiddenPattern: FRONTEND_TO_WORKER_IMPORT_PATTERN,
  }),
);

if (!allWorkerOk || !allFrontendBoundaryOk) {
  process.exit(1);
}

console.log("[boundary] Worker import boundary checks passed");

// ADR-2 has two halves. The frontend→worker half (`src/`, `shared/`,
// `scripts/`, `functions/` must not import `worker/src/**`) is expressed as a
// `no-restricted-imports` block in `eslint.config.mjs`, so it runs on every
// changed file via `lint:changed` instead of only when a worker file moves.
// This script keeps the half ESLint cannot express — the worker→frontend ban is
// on *any* `@/` or `src/` specifier, not the enumerable `src/lib/*` shapes the
// ESLint block lists — plus the waiver registry and its cross-checks.
import { readFileSync } from "node:fs";
import { collectSourceFiles } from "../lib/source-files.mts";

const WORKER_SRC_DIR = "worker/src";
const ESLINT_CONFIG_PATH = "eslint.config.mjs";
const SOURCE_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"]);
const SOURCE_FILE_EXCLUDED_DIRS = new Set<string>();
const WORKER_TO_FRONTEND_IMPORT_PATTERN = /(?:from\s+["'][^"']*(?:@\/|src\/)|import\s*\(\s*["'][^"']*(?:@\/|src\/))/;

interface BoundaryMatch {
  file: string;
  line: number;
  text: string;
}

interface BoundaryCheckOptions {
  excludeTests: boolean;
  rootDir: string;
  forbiddenPattern: RegExp;
}

function formatMatches(matches: readonly BoundaryMatch[]): void {
  for (const match of matches) {
    process.stderr.write(`${match.file}:${match.line}:${match.text}\n`);
  }
}

// Named cross-boundary validators that intentionally import worker sources to
// assert invariants. Keep this list minimal and document why each entry exists.
// Adding a new waiver is an architectural decision: prefer pushing shared
// metadata into `shared/` and update MAX_BOUNDARY_WAIVERS only when the
// architectural exception is reviewed.
//
// Every entry below MUST have a matching section in
// `docs/process/boundary-waivers.md`. The invariant is enforced by
// `scripts/__tests__/worker-boundary-waivers.test.ts`. Each entry's `file` must
// also appear in `FRONTEND_TO_WORKER_WAIVED_FILES` in `eslint.config.mjs`,
// which is where the frontend→worker rule now lives; `checkEslintWaiverSync()`
// below fails the check if the two drift apart.
const BOUNDARY_WAIVERS = [
  {
    id: "frozen-invariants-lifecycle-registry-check",
    file: "scripts/ci/check-frozen-invariants.ts",
    reason: "Freeze validation must assert frozen IDs are absent from worker registries and frontend compare fixtures.",
  },
];
const MAX_BOUNDARY_WAIVERS = 1;
if (BOUNDARY_WAIVERS.length > MAX_BOUNDARY_WAIVERS) {
  console.error(
    `[boundary] BOUNDARY_WAIVERS has ${BOUNDARY_WAIVERS.length} entries; cap is ${MAX_BOUNDARY_WAIVERS}. ` +
      "Each waiver is an architectural exception — push shared metadata into `shared/` instead of growing the list, " +
      "or raise MAX_BOUNDARY_WAIVERS with a documented review and update docs/process/boundary-waivers.md.",
  );
  process.exit(1);
}
const BOUNDARY_EXEMPT_FILES = new Set(BOUNDARY_WAIVERS.map((waiver) => waiver.file));

function runBoundaryCheck(label: string, { excludeTests, rootDir, forbiddenPattern }: BoundaryCheckOptions): boolean {
  try {
    const files = collectSourceFiles(rootDir, {
      extensions: SOURCE_FILE_EXTENSIONS,
      excludedDirs: SOURCE_FILE_EXCLUDED_DIRS,
    });
    const matches: BoundaryMatch[] = [];
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

// The frontend→worker half is enforced by ESLint, so every waived file has to
// be excluded there too. Assert the two lists agree; a waiver that is only
// recorded here would silently stop being waived (and one that is only ignored
// in the ESLint config would escape the cap and the documentation requirement).
function checkEslintWaiverSync() {
  let config: string;
  try {
    config = readFileSync(ESLINT_CONFIG_PATH, "utf8");
  } catch (error) {
    console.error(`[boundary] unable to read ${ESLINT_CONFIG_PATH}`);
    console.error(error instanceof Error ? error.message : String(error));
    return false;
  }

  const missing = BOUNDARY_WAIVERS.filter((waiver) => !config.includes(`"${waiver.file}"`));
  if (missing.length > 0) {
    console.error(
      `[boundary] waiver drift: ${ESLINT_CONFIG_PATH} must ignore every BOUNDARY_WAIVERS file for the frontend→worker rule`,
    );
    for (const waiver of missing) console.error(`  ${waiver.id}: ${waiver.file}`);
    return false;
  }

  return true;
}

const allWorkerOk = runBoundaryCheck("all worker sources", {
  rootDir: WORKER_SRC_DIR,
  excludeTests: false,
  forbiddenPattern: WORKER_TO_FRONTEND_IMPORT_PATTERN,
});

const waiversInSync = checkEslintWaiverSync();

if (!allWorkerOk || !waiversInSync) {
  process.exit(1);
}

console.log("[boundary] Worker import boundary checks passed");

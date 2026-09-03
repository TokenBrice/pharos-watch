import {
  collectOwningTests,
  deriveCriticalOwnership,
  normalizeOwnershipPath,
  type CriticalOwnership,
} from "./critical-ownership.mts";
import { CRITICAL_FILES } from "./critical-coverage.mjs";
const generatedCriticalOwnership = deriveCriticalOwnership({ sourceFiles: CRITICAL_FILES });

export const GLOBAL_INVARIANT_TEST_FILES: string[] = [
  "src/lib/__tests__/reserve-coinid-validation.test.ts",
  "worker/src/cron/__tests__/telegram-recap-cost-boundary.test.ts",
];

export const CRITICAL_CONTRACT_TEST_FILES: string[] = [
  "src/lib/__tests__/api-fetch-contracts.test.ts",
  "src/lib/__tests__/api-endpoints.test.ts",
  ...GLOBAL_INVARIANT_TEST_FILES,
  "worker/src/__tests__/index.fetch.test.ts",
  "worker/src/api/__tests__/router-contract.test.ts",
  "worker/src/api/__tests__/cache-passthrough.test.ts",
  "worker/src/api/__tests__/peg-summary.test.ts",
  "worker/src/api/__tests__/report-cards-v9.test.ts",
  "worker/src/api/__tests__/stability-index.test.ts",
  "worker/src/api/__tests__/dex-liquidity.test.ts",
  "worker/src/api/__tests__/yield-rankings.test.ts",
  "worker/src/api/__tests__/yield-history.test.ts",
  "worker/src/api/__tests__/stress-signals.test.ts",
  "worker/src/api/__tests__/mint-burn-flows.test.ts",
  "worker/src/api/__tests__/mint-burn-flows-endpoint-contract.test.ts",
  "worker/src/api/__tests__/stablecoin-reserves.test.ts",
  "worker/src/api/__tests__/depeg-events.test.ts",
  "worker/src/api/__tests__/events.test.ts",
];

// Always-on contracts protect the public response and schema boundary.
const USER_FACING_CONTRACT_TEST_FILES: string[] = [
  // Public API response serialization must not drift between endpoint modes.
  "worker/src/lib/__tests__/api-response.test.ts",
  // Public API schemas are the compatibility contract for generated clients.
  "worker/src/lib/__tests__/api-schema.test.ts",
  // Access and origin gates are the first authorization boundary.
  "worker/src/handlers/http/__tests__/gates.test.ts",
  // Admin/site-proxy credential acceptance must remain fail-closed.
  "worker/src/lib/__tests__/auth.test.ts",
  // Scheduled dispatch must continue selecting the registered runner.
  "worker/src/__tests__/index.scheduled.test.ts",
  // Supply attribution is a user-facing input to Safety Score publication.
  "worker/src/lib/__tests__/safety-score-v9-supply-attribution-contract.test.ts",
  // The 15-minute cron sync is the source of the public market snapshot.
  "worker/src/cron/__tests__/sync-stablecoins.test.ts",
  // Public health's freshness/degraded response is an operator and user contract.
  "worker/src/lib/__tests__/public-health-assessment.test.ts",
  // Reserve endpoint response and availability are public detail-page data.
  "worker/src/api/__tests__/stablecoin-reserves.test.ts",
  // Pagination metadata is consumed by public API clients and pages.
  "worker/src/lib/__tests__/api-pagination.test.ts",
  // API parameter normalization is part of the public request contract.
  "worker/src/lib/__tests__/api-params.test.ts",
  // Freshness headers tell clients whether a public snapshot is trustworthy.
  "worker/src/lib/__tests__/api-freshness.test.ts",
];

export const ALWAYS_RUN_TEST_FILES: string[] = [
  ...new Set([
    ...CRITICAL_CONTRACT_TEST_FILES,
    ...GLOBAL_INVARIANT_TEST_FILES,
    ...USER_FACING_CONTRACT_TEST_FILES,
  ]),
];

export const CRITICAL_TEST_FILES: string[] = collectOwningTests(CRITICAL_FILES, generatedCriticalOwnership);

export interface CriticalCoverageBuildOptions {
  changedFiles?: readonly string[];
  criticalFiles?: readonly string[];
  ownership?: CriticalOwnership;
}

function selectCriticalCoverageFiles({
  changedFiles,
  criticalFiles = CRITICAL_FILES,
}: CriticalCoverageBuildOptions): string[] {
  if (changedFiles === undefined) return [...criticalFiles];
  const changed = new Set(changedFiles.map(normalizeOwnershipPath));
  return criticalFiles.filter((file) => changed.has(normalizeOwnershipPath(file)));
}

function buildCriticalCoverageOptions(criticalFiles: readonly string[]): string[] {
  return [
    "--coverage",
    "--coverage.thresholds.lines=0",
    // The all-critical suite contains wall-clock-sensitive contract tests.
    // Unbounded file workers can starve those probes on large local/CI hosts.
    "--maxWorkers=4",
    // Scope v8 remapping to the enrolled critical source. Per-file numbers for
    // the enrolled files are unchanged, but the reporter stops remapping the
    // rest of the loaded module graph — the heaviest part of this invocation.
    ...criticalFiles.map((file) => `--coverage.include=${escapeCoverageIncludeGlob(file)}`),
  ];
}

export function buildCriticalContractTestArgs(extraArgs: readonly string[] = []): string[] {
  return ["run", ...CRITICAL_CONTRACT_TEST_FILES, ...extraArgs];
}

// coverage.include values are globs; enrolled paths like
// functions/api/admin/[[path]].ts would otherwise parse as character classes
// and silently drop those files from lcov (surfacing as MISSING failures).
export function escapeCoverageIncludeGlob(file: string): string {
  return file.replace(/[\\[\](){}*?!+@|]/g, "\\$&");
}

export function buildCriticalCoverageArgs(
  extraArgs: readonly string[] = [],
  options: CriticalCoverageBuildOptions = {},
): string[] {
  const selectedSources = selectCriticalCoverageFiles(options);
  const ownership = options.ownership ?? generatedCriticalOwnership;
  // A touched source pays only for tests that import it; full runs pass all
  // enrolled sources and therefore retain the complete derived owner set.
  const selectedTests = collectOwningTests(selectedSources, ownership);
  return [
    "run",
    ...buildCriticalCoverageOptions(selectedSources),
    ...selectedTests,
    ...extraArgs,
  ];
}

export function countCriticalCoverageShards(
  options: CriticalCoverageBuildOptions = {},
  maxShards = 4,
): number {
  const selectedSources = selectCriticalCoverageFiles(options);
  const ownership = options.ownership ?? generatedCriticalOwnership;
  const selectedTests = collectOwningTests(selectedSources, ownership);
  return Math.max(1, Math.min(maxShards, selectedTests.length));
}

export function buildCriticalCoverageMergeArgs(
  reportsDirectory = ".vitest-reports",
  options: CriticalCoverageBuildOptions = {},
): string[] {
  return [...buildCriticalCoverageOptions(selectCriticalCoverageFiles(options)), `--merge-reports=${reportsDirectory}`];
}

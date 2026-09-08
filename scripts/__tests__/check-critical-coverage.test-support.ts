import { runCriticalCoverageCheck, CRITICAL_COVERAGE_BRANCH_FLOORS } from "../ci/check-critical-coverage.ts";
import { CRITICAL_FILES } from "../lib/critical-coverage.mjs";
import { captureProcessExit, mockConsole, mockExecFileSync, mockFsImpl, testEnv } from "../test-utils/ci-script-test-helpers";

type CoverageFixture = {
  branchCoverage?: Partial<Record<string, { brf?: number; brh?: number }>>;
  lineCoverage?: Partial<Record<string, { lf?: number; lh?: number }>>;
};

export function buildCriticalLcov({ branchCoverage = {}, lineCoverage = {} }: CoverageFixture = {}) {
  return CRITICAL_FILES.map((file) => {
    const { lf = 10, lh = 10 } = lineCoverage[file] ?? {};
    const { brf, brh } = branchCoverage[file] ?? (CRITICAL_COVERAGE_BRANCH_FLOORS[file] == null ? {} : { brf: 10, brh: 10 });
    return [
      `SF:${file}`,
      `DA:1,${lh > 0 ? 1 : 0}`,
      `LF:${lf}`,
      `LH:${lh}`,
      ...(brf == null ? [] : [`BRF:${brf}`, `BRH:${brh}`]),
      "end_of_record",
    ].join("\n");
  }).join("\n");
}

export function runCoverageFixture({
  env,
  lcov,
  baseline,
  execFile = mockExecFileSync(() => ""),
}: {
  env: Record<string, string>;
  lcov: string;
  baseline?: { files: Record<string, number> };
  execFile?: NonNullable<Parameters<typeof runCriticalCoverageCheck>[0]>["execFile"];
}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const files = new Map([["coverage/lcov.info", lcov]]);
  if (baseline) files.set(".ci/critical-coverage-baseline.json", JSON.stringify(baseline));
  runCriticalCoverageCheck({
    env: testEnv(env),
    fsImpl: mockFsImpl({
      existsSync: (path: string) => files.has(path),
      readFileSync: (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`missing ${path}`);
        return value;
      },
    }),
    execFile,
    consoleImpl: mockConsole({
      log: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
      error: (message: string) => errors.push(message),
    }),
    completenessOptions: { candidateFiles: [], criticalFiles: [], ownership: new Map(), waivers: {}, ownershipWaivers: {} },
    exit: captureProcessExit((code) => { if (code !== undefined) exits.push(code); }),
  });
  return { logs, errors, exits };
}

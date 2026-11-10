/**
 * Vitest setup inputs, shared by `vitest.config.ts` and the static PR test
 * planner. Setup code shapes how every test in its scope executes without
 * appearing in any test's import graph, so the planner treats these files (and
 * their import closures) as force-rerun inputs.
 */
export const VITEST_GLOBAL_SETUP_FILES = [
  "scripts/test/ensure-fresh-stablecoin-artifacts.ts",
  "scripts/test/prepare-latest-schema-sqlite-template.ts",
] as const;

export const VITEST_PROJECT_SETUP_FILES: Readonly<Record<string, readonly string[]>> = {
  "worker-shared": ["worker/src/test-helpers/setup-shared-isolation.ts"],
  src: ["src/test/setup.ts"],
};

export const VITEST_SETUP_FILES: readonly string[] = [
  ...VITEST_GLOBAL_SETUP_FILES,
  ...Object.values(VITEST_PROJECT_SETUP_FILES).flat(),
];

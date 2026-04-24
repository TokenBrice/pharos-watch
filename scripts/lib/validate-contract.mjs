export const VALIDATE_PREBUILD_COMMANDS = [
  "npm run audit:deps",
  "npm run audit:pricing-providers",
  "npm run lint",
  "npm run typecheck",
  "npm run check:cemetery-dataset",
  "npm run check:cron-abort-contract",
  "npm run check:cron-connections",
  "npm run check:cron-sync",
  "npm run check:doc-counts",
  "npm run check:doc-source-paths",
  "npm run check:doc-sync",
  "npm run check:duplicate-exports",
  "npm run check:env-contract",
  "npm run check:hotspot-ratchet",
  "npm run check:llms-txt",
  "npm run check:migrations",
  "npm run check:openapi",
  "npm run check:postman",
  "npm run check:redemption-backstops",
  "npm run check:shared-cycles",
  "npm run check:sql-safety",
  "npm run check:stablecoin-data",
  "npm run check:unused-code",
  "npm run check:verified-doc-links",
  "npm run check:world-map",
  "npm run check:worker-boundary",
];

export const VALIDATE_PREBUILD_MAX_PARALLEL = 8;

export const VALIDATE_PREBUILD_TASK_NAMES = VALIDATE_PREBUILD_COMMANDS.map((cmd) => {
  const prefix = "npm run ";
  if (!cmd.startsWith(prefix)) {
    throw new Error(`validate:prebuild only supports npm-script commands. Received: ${cmd}`);
  }
  return cmd.slice(prefix.length);
});

// Keep the top-level CI/merge-gate contract as the umbrella script while the
// package-level implementation delegates to the shared registry above.
export const COMMON_VALIDATE_PREBUILD_COMMANDS = [
  "npm run validate:prebuild",
];

export const PAGES_VALIDATE_COMMANDS = [
  "npm run build",
  "npm run seo:check",
];

export const COMMON_VALIDATE_POSTBUILD_COMMANDS = [
  "npm run test:noncritical",
  "npm run coverage:critical",
];

export const WORKER_VALIDATE_COMMANDS = [
  "npm run typecheck:worker",
  "npm run typecheck:worker-scripts",
];

export function buildValidateCommandPlan({
  pagesChanged = true,
  workerChanged = true,
} = {}) {
  return [
    ...COMMON_VALIDATE_PREBUILD_COMMANDS,
    ...(pagesChanged ? PAGES_VALIDATE_COMMANDS : []),
    ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
    ...(workerChanged ? WORKER_VALIDATE_COMMANDS : []),
  ];
}

export function buildCiValidateStepPlan({
  pagesChanged = true,
  workerChanged = true,
} = {}) {
  return [
    ...COMMON_VALIDATE_PREBUILD_COMMANDS.map((cmd) => ({ cmd, condition: null })),
    ...PAGES_VALIDATE_COMMANDS.map((cmd) => ({
      cmd,
      condition: pagesChanged ? "pages_changed" : null,
    })),
    ...COMMON_VALIDATE_POSTBUILD_COMMANDS.map((cmd) => ({ cmd, condition: null })),
    ...WORKER_VALIDATE_COMMANDS.map((cmd) => ({
      cmd,
      condition: workerChanged ? "worker_changed" : null,
    })),
  ];
}

export function buildCiValidateCommands() {
  return buildValidateCommandPlan();
}

export function buildValidatePrebuildRunnerArgs({ continueOnError = false } = {}) {
  const args = [
    "-l",
    "--aggregate-output",
    "--max-parallel",
    String(VALIDATE_PREBUILD_MAX_PARALLEL),
    ...VALIDATE_PREBUILD_TASK_NAMES,
  ];

  if (continueOnError) {
    args.splice(2, 0, "--continue-on-error");
  }

  return args;
}

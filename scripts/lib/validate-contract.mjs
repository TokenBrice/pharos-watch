export const COMMON_VALIDATE_PREBUILD_COMMANDS = [
  "npm run audit:deps",
  "npm run audit:pricing-providers",
  "npm run lint",
  "npm run typecheck",
  "npm run check:worker-boundary",
  "npm run check:shared-cycles",
  "npm run check:migrations",
  "npm run check:cron-sync",
  "npm run check:cron-connections",
  "npm run check:doc-counts",
  "npm run check:verified-doc-links",
  "npm run check:doc-sync",
  "npm run check:env-contract",
  "npm run check:duplicate-exports",
  "npm run check:redemption-backstops",
  "npm run check:unused-code",
  "npm run check:hotspot-ratchet",
  "npm run check:sql-safety",
  "npm run check:stablecoin-data",
];

export const PAGES_VALIDATE_COMMANDS = [
  "npm run build",
  "npm run seo:check",
];

export const COMMON_VALIDATE_POSTBUILD_COMMANDS = [
  "npm test",
  "npm run coverage:critical",
];

export const WORKER_VALIDATE_COMMANDS = ["cd worker && npx tsc --noEmit"];

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
  return buildCiValidateStepPlan().map((step) => step.cmd);
}

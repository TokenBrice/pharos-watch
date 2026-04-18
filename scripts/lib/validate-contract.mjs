// Single umbrella command that fans out the prebuild audits, typecheck, lint,
// and check:* guardrails across available CPU cores via npm-run-all2. Keeping
// this as a one-entry list preserves the parity contract and the merge-gate
// dry-run summary while still dropping ~60-90s off the sequential runtime.
export const COMMON_VALIDATE_PREBUILD_COMMANDS = [
  "npm run validate:prebuild",
];

export const PAGES_VALIDATE_COMMANDS = [
  "npm run build",
  "npm run seo:check",
];

export const COMMON_VALIDATE_POSTBUILD_COMMANDS = [
  "npm test",
  "npm run coverage:critical",
];

export const WORKER_VALIDATE_COMMANDS = [
  "cd worker && npx tsc --noEmit",
  "cd worker && npx tsc --noEmit -p tsconfig.scripts.json",
];

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

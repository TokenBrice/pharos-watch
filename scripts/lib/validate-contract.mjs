import { VALIDATION_COMMAND_DEPLOY_IMPACT_REGISTRY } from "./automation-registry.mjs";

export const VALIDATE_PREBUILD_COMMANDS = [
  "npm run audit:deps",
  "npm run audit:pricing-providers",
  "npm run check:provider-resilience",
  "npm run lint",
  "npm run lint:typed",
  "npm run typecheck",
  "npm run check:agent-doc-sync",
  "npm run check:agent-skill-symlinks",
  "npm run check:attestor-tier-coverage",
  "npm run check:client-registry-imports",
  "npm run check:cron-abort-contract",
  "npm run check:cron-console-usage",
  "npm run check:cron-connections",
  "npm run check:cron-sync",
  "npm run check:dependency-coverage",
  "npm run check:doc-counts",
  "npm run check:doc-source-paths",
  "npm run check:doc-sync",
  "npm run check:duplicate-exports",
  "npm run check:env-contract",
  "npm run check:frozen-invariants",
  "npm run check:generated-artifacts",
  "npm run check:glossary-coverage",
  "npm run check:one-liner-coverage",
  "npm run check:mechanism-archetype-coverage",
  "npm run check:archetype-explainer-coverage",
  "npm run check:hook-polling-window",
  "npm run check:hotspot-ratchet",
  "npm run check:migrations",
  "npm run check:price-bounds-parity",
  "npm run check:redemption-backstops",
  "npm run check:redemption-coverage-audit",
  "npm run check:reserve-fixture-freshness",
  "npm run check:selector-banned-phrases",
  "npm run check:site-csp-sync",
  "npm run check:script-entrypoints",
  "npm run check:shared-cycles",
  "npm run check:shared-types-imports",
  "npm run check:sql-safety",
  "npm run check:stale-flags",
  "npm run check:stablecoin-data",
  "npm run check:supply-helper-usage",
  "npm run check:unused-code",
  "npm run check:verified-doc-links",
  "npm run check:world-map",
  "npm run check:worker-boundary",
];

export const VALIDATE_PREBUILD_MAX_PARALLEL = 8;

// Keep the top-level CI/merge-gate contract as the umbrella script while the
// package-level implementation delegates to the shared registry above.
export const COMMON_VALIDATE_PREBUILD_COMMANDS = ["npm run validate:prebuild"];
export const VALIDATE_PREBUILD_SURFACE_ENV = "VALIDATE_PREBUILD_SURFACE";

export const PAGES_VALIDATE_COMMANDS = [
  "npm run build",
  "npm run test:a11y",
  "npm run check:feature-flag-inlining",
  "npm run seo:check",
  "npm run check:phishing-signatures",
  "npm run check:classifier-sensitive-copy",
  "npm run check:build-size",
  "npm run check:build-attribution",
];

// 2 shards: per-shard runner fixed cost (~45s checkout/setup) outweighed the
// ~77s of vitest per shard at 4; see Mythos audit P3-63 before raising again.
export const NONCRITICAL_TEST_SHARD_COUNT = 2;

export function buildNoncriticalTestShardCommands(shardCount = NONCRITICAL_TEST_SHARD_COUNT) {
  return Array.from({ length: shardCount }, (_value, index) => {
    const shard = index + 1;
    return `npm run test:noncritical -- --shard=${shard}/${shardCount}`;
  });
}

export const COMMON_VALIDATE_POSTBUILD_COMMANDS = [
  ...buildNoncriticalTestShardCommands(),
  "npm run coverage:critical",
];

export const PAGES_SMOKE_VALIDATE_COMMANDS = ["npm run validate:pages-smoke"];

export const WORKER_VALIDATE_COMMANDS = [
  "npm run typecheck:worker",
  "npm run validate:worker-scheduled-smoke",
];

export const WORKER_SMOKE_VALIDATE_COMMANDS = ["npm run validate:worker-smoke"];

export function buildValidateCommandPlan({ pagesChanged = true, workerChanged = true } = {}) {
  return [
    ...COMMON_VALIDATE_PREBUILD_COMMANDS,
    ...(pagesChanged ? PAGES_VALIDATE_COMMANDS : []),
    ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
    ...(workerChanged ? WORKER_VALIDATE_COMMANDS : []),
  ];
}

export function buildCiValidateStepPlan({ pagesChanged = true, runPagesBuild = true, workerChanged = true } = {}) {
  return [
    ...COMMON_VALIDATE_PREBUILD_COMMANDS.map((cmd) => ({ cmd, condition: null })),
    ...PAGES_VALIDATE_COMMANDS.map((cmd) => ({
      cmd,
      condition: pagesChanged && runPagesBuild ? "pages_changed && run_pages_build_and_seo" : null,
    })),
    ...buildNoncriticalTestShardCommands().map((cmd) => ({ cmd, condition: null })),
    { cmd: "npm run coverage:critical", condition: null },
    ...WORKER_VALIDATE_COMMANDS.map((cmd) => ({
      cmd,
      condition: workerChanged ? "worker_changed" : null,
    })),
  ];
}

export function buildCiValidateCommands() {
  return [
    ...COMMON_VALIDATE_PREBUILD_COMMANDS,
    ...PAGES_VALIDATE_COMMANDS,
    ...buildNoncriticalTestShardCommands(),
    "npm run coverage:critical",
    ...WORKER_VALIDATE_COMMANDS,
  ];
}

function normalizeValidationCommand(command) {
  if (command.startsWith("npm run test:noncritical -- --shard=")) {
    return "npm run test:noncritical";
  }
  return command;
}

export function normalizeValidatePrebuildSurface(surface) {
  if (surface === "pages" || surface === "worker" || surface === "full") {
    return surface;
  }
  return "full";
}

const validationCommandDeployImpactByCommand = new Map(
  VALIDATION_COMMAND_DEPLOY_IMPACT_REGISTRY.map((entry) => [entry.command, entry.deployImpact]),
);

export function shouldRunValidatePrebuildCommandForSurface(command, surface) {
  const normalizedSurface = normalizeValidatePrebuildSurface(surface);
  const deployImpact = validationCommandDeployImpactByCommand.get(normalizeValidationCommand(command)) ?? "full";

  if (deployImpact === "validation-only" || deployImpact === "full" || normalizedSurface === "full") {
    return true;
  }

  return deployImpact === normalizedSurface;
}

export function buildValidatePrebuildCommandsForSurface(surface) {
  return VALIDATE_PREBUILD_COMMANDS.filter((command) =>
    shouldRunValidatePrebuildCommandForSurface(command, surface),
  );
}

export function validateValidationCommandImpactRegistry(commands = [
  ...VALIDATE_PREBUILD_COMMANDS,
  ...COMMON_VALIDATE_PREBUILD_COMMANDS,
  ...PAGES_VALIDATE_COMMANDS,
  ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
  ...WORKER_VALIDATE_COMMANDS,
  ...PAGES_SMOKE_VALIDATE_COMMANDS,
  ...WORKER_SMOKE_VALIDATE_COMMANDS,
]) {
  const classifiedCommands = new Set(VALIDATION_COMMAND_DEPLOY_IMPACT_REGISTRY.map((entry) => entry.command));
  const missing = [...new Set(commands.map(normalizeValidationCommand))].filter(
    (command) => !classifiedCommands.has(command),
  );
  if (missing.length > 0) {
    throw new Error(`Missing validation deploy-impact classification for: ${missing.join(", ")}`);
  }
}

validateValidationCommandImpactRegistry();

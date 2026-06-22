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
  "npm run check:oracle-risk-coverage:enforce",
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
export const VALIDATE_PREBUILD_TIER_ENV = "VALIDATE_PREBUILD_TIER";
export const VALIDATE_PREBUILD_TIERS = ["blocking", "surface", "full"];

const VALIDATE_PREBUILD_TIER_RANK = {
  blocking: 0,
  surface: 1,
  full: 2,
};

export const VALIDATION_COMMAND_TIER_REGISTRY = [
  { command: "npm run audit:deps", tier: "full" },
  { command: "npm run audit:pricing-providers", tier: "surface" },
  { command: "npm run check:provider-resilience", tier: "surface" },
  { command: "npm run lint", tier: "blocking" },
  { command: "npm run lint:typed", tier: "blocking" },
  { command: "npm run typecheck", tier: "blocking" },
  { command: "npm run check:agent-doc-sync", tier: "full" },
  { command: "npm run check:agent-skill-symlinks", tier: "full" },
  { command: "npm run check:attestor-tier-coverage", tier: "surface" },
  { command: "npm run check:client-registry-imports", tier: "blocking" },
  { command: "npm run check:cron-abort-contract", tier: "surface" },
  { command: "npm run check:cron-console-usage", tier: "surface" },
  { command: "npm run check:cron-connections", tier: "blocking" },
  { command: "npm run check:cron-sync", tier: "blocking" },
  { command: "npm run check:dependency-coverage", tier: "full" },
  { command: "npm run check:doc-counts", tier: "full" },
  { command: "npm run check:doc-source-paths", tier: "full" },
  { command: "npm run check:doc-sync", tier: "full" },
  { command: "npm run check:duplicate-exports", tier: "full" },
  { command: "npm run check:env-contract", tier: "blocking" },
  { command: "npm run check:frozen-invariants", tier: "surface" },
  { command: "npm run check:generated-artifacts", tier: "blocking" },
  { command: "npm run check:glossary-coverage", tier: "full" },
  { command: "npm run check:one-liner-coverage", tier: "full" },
  { command: "npm run check:mechanism-archetype-coverage", tier: "surface" },
  { command: "npm run check:archetype-explainer-coverage", tier: "surface" },
  { command: "npm run check:hook-polling-window", tier: "surface" },
  { command: "npm run check:hotspot-ratchet", tier: "full" },
  { command: "npm run check:migrations", tier: "blocking" },
  { command: "npm run check:price-bounds-parity", tier: "surface" },
  { command: "npm run check:redemption-backstops", tier: "surface" },
  { command: "npm run check:redemption-coverage-audit", tier: "full" },
  { command: "npm run check:reserve-fixture-freshness", tier: "full" },
  { command: "npm run check:selector-banned-phrases", tier: "full" },
  { command: "npm run check:site-csp-sync", tier: "blocking" },
  { command: "npm run check:script-entrypoints", tier: "full" },
  { command: "npm run check:shared-cycles", tier: "surface" },
  { command: "npm run check:shared-types-imports", tier: "surface" },
  { command: "npm run check:sql-safety", tier: "blocking" },
  { command: "npm run check:stale-flags", tier: "full" },
  { command: "npm run check:stablecoin-data", tier: "blocking" },
  { command: "npm run check:oracle-risk-coverage:enforce", tier: "surface" },
  { command: "npm run check:supply-helper-usage", tier: "blocking" },
  { command: "npm run check:unused-code", tier: "full" },
  { command: "npm run check:verified-doc-links", tier: "full" },
  { command: "npm run check:world-map", tier: "full" },
  { command: "npm run check:worker-boundary", tier: "blocking" },
];

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

export function normalizeValidatePrebuildTier(tier) {
  if (tier === "blocking" || tier === "surface" || tier === "full") {
    return tier;
  }
  return "full";
}

export function resolveValidatePrebuildTier(tier, { ci = process.env.CI } = {}) {
  const requestedTier = normalizeValidatePrebuildTier(tier);
  if (ci === "true" && requestedTier !== "full") {
    return {
      ciOverride: true,
      effectiveTier: "full",
      requestedTier,
    };
  }

  return {
    ciOverride: false,
    effectiveTier: requestedTier,
    requestedTier,
  };
}

const validationCommandDeployImpactByCommand = new Map(
  VALIDATION_COMMAND_DEPLOY_IMPACT_REGISTRY.map((entry) => [entry.command, entry.deployImpact]),
);

const validationCommandTierByCommand = new Map(
  VALIDATION_COMMAND_TIER_REGISTRY.map((entry) => [entry.command, entry.tier]),
);

export function shouldRunValidatePrebuildCommandForSurface(command, surface) {
  const normalizedSurface = normalizeValidatePrebuildSurface(surface);
  const deployImpact = validationCommandDeployImpactByCommand.get(normalizeValidationCommand(command)) ?? "full";

  if (deployImpact === "validation-only" || deployImpact === "full" || normalizedSurface === "full") {
    return true;
  }

  return deployImpact === normalizedSurface;
}

export function shouldRunValidatePrebuildCommandForTier(command, tier) {
  const normalizedTier = normalizeValidatePrebuildTier(tier);
  if (normalizedTier === "full") {
    return true;
  }

  const commandTier = validationCommandTierByCommand.get(normalizeValidationCommand(command)) ?? "full";
  return VALIDATE_PREBUILD_TIER_RANK[commandTier] <= VALIDATE_PREBUILD_TIER_RANK[normalizedTier];
}

export function shouldRunValidatePrebuildCommand(command, { surface, tier } = {}) {
  return (
    shouldRunValidatePrebuildCommandForSurface(command, surface) &&
    shouldRunValidatePrebuildCommandForTier(command, tier)
  );
}

export function buildValidatePrebuildCommands({ surface, tier } = {}) {
  return VALIDATE_PREBUILD_COMMANDS.filter((command) =>
    shouldRunValidatePrebuildCommand(command, { surface, tier }),
  );
}

export function buildValidatePrebuildCommandsForSurface(surface) {
  return buildValidatePrebuildCommands({ surface, tier: "full" });
}

export function buildValidatePrebuildCommandsForSurfaceAndTier(surface, tier) {
  return buildValidatePrebuildCommands({ surface, tier });
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

export function validateValidationCommandTierRegistry(commands = VALIDATE_PREBUILD_COMMANDS) {
  const classifiedCommands = new Set();
  const duplicates = [];
  const invalid = [];

  for (const entry of VALIDATION_COMMAND_TIER_REGISTRY) {
    const normalizedCommand = normalizeValidationCommand(entry.command);
    if (classifiedCommands.has(normalizedCommand)) {
      duplicates.push(normalizedCommand);
    }
    classifiedCommands.add(normalizedCommand);
    if (!VALIDATE_PREBUILD_TIERS.includes(entry.tier)) {
      invalid.push(`${entry.command}=${entry.tier}`);
    }
  }

  if (duplicates.length > 0) {
    throw new Error(`Duplicate validation tier classification for: ${[...new Set(duplicates)].join(", ")}`);
  }

  if (invalid.length > 0) {
    throw new Error(`Invalid validation tier classification for: ${invalid.join(", ")}`);
  }

  const missing = [...new Set(commands.map(normalizeValidationCommand))].filter(
    (command) => !classifiedCommands.has(command),
  );
  if (missing.length > 0) {
    throw new Error(`Missing validation tier classification for: ${missing.join(", ")}`);
  }
}

// Self-validation is opt-in so that merely importing a constant (e.g. tests
// pulling in NONCRITICAL_TEST_SHARD_COUNT) does not trigger the full registry
// scan or throw. The validate-ci-parity test calls this explicitly, and CI can
// force it via VALIDATE_CONTRACT_SELF_CHECK=1.
if (process.env.VALIDATE_CONTRACT_SELF_CHECK === "1") {
  validateValidationCommandImpactRegistry();
  validateValidationCommandTierRegistry();
}

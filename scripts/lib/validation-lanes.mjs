const SURFACES = ["full", "pages", "worker"];
const IMPACT_BUCKETS = ["full", "validation-only", "pages", "worker"];
const PHASES = ["prebuild", "manual-advisory", "pages", "postbuild", "worker", "smoke", "orchestration"];

export const VALIDATE_PREBUILD_SURFACE_ENV = "VALIDATE_PREBUILD_SURFACE";
export const VALIDATE_PREBUILD_SKIP_COMMANDS_ENV = "VALIDATE_PREBUILD_SKIP_COMMANDS";
export const VALIDATE_PREBUILD_INCLUDE_ADVISORY_ENV = "VALIDATE_PREBUILD_INCLUDE_ADVISORY";
export const VALIDATE_PREBUILD_MAX_PARALLEL = 8;
export const NONCRITICAL_TEST_SHARD_COUNT = 2;

function prebuild(command, prebuildOrder, surfaces = SURFACES, terminal = false) {
  return { command, phase: "prebuild", prebuildOrder, surfaces, ...(terminal ? { terminal: true } : {}) };
}

function advisoryPrebuild(command, prebuildOrder, surfaces = SURFACES, terminal = false) {
  return { ...prebuild(command, prebuildOrder, surfaces, terminal), blocking: false };
}

/** @returns {{ command: string, phase: string, prebuildOrder?: number, phaseOrder?: number, surfaces: string[] }} */
function ordered(command, phase, phaseOrder, surfaces = SURFACES) {
  return { command, phase, ...(phaseOrder === undefined ? {} : { phaseOrder }), surfaces };
}

function impactPaths({ full = [], validationOnly = [], pages = [], worker = [] } = {}) {
  return { full, "validation-only": validationOnly, pages, worker };
}

export const VALIDATION_LANES = [
  {
    id: "format-and-lint",
    impactPaths: impactPaths(),
    leaves: [prebuild("npm run lint", 5), prebuild("npm run lint:typed", 6)],
  },
  {
    id: "root-and-worker-typecheck",
    impactPaths: impactPaths({
      validationOnly: ["tsconfig.test-typecheck.json"],
    }),
    leaves: [
      prebuild("npm run typecheck", 7),
      prebuild("npm run typecheck:tests", 8),
      ordered("npm run typecheck:worker", "worker", 1, ["full", "worker"]),
    ],
  },
  {
    id: "unit-and-domain-tests",
    impactPaths: impactPaths({
      full: ["scripts/maintenance/run-noncritical-tests.mjs"],
    }),
    leaves: [ordered("npm run test:noncritical", "postbuild", 1)],
  },
  {
    id: "d1-migration-and-runtime-safety",
    impactPaths: impactPaths({
      full: [
        "scripts/ci/check-cron-abort-contract.mjs",
        "scripts/ci/check-cron-console-usage.mjs",
        "scripts/lib/cron-console-usage-baseline.json",
        "scripts/ci/check-cron-connection-budget.ts",
        "scripts/ci/check-cron-schedule-sync.ts",
        "scripts/ci/check-frozen-invariants.ts",
      ],
      worker: [
        "scripts/ci/check-json-parse-ratchet.mjs",
        "scripts/lib/json-parse-ratchet-baseline.json",
        "scripts/ci/check-worker-migrations.mjs",
        "scripts/ci/check-sql-interpolation-safety.mjs",
      ],
    }),
    leaves: [
      advisoryPrebuild("npm run check:cron-abort-contract", 13),
      advisoryPrebuild("npm run check:cron-console-usage", 14),
      prebuild("npm run check:cron-connections", 16, ["full", "worker"]),
      prebuild("npm run check:cron-sync", 17, ["full", "worker"]),
      advisoryPrebuild("npm run check:frozen-invariants", 23),
      advisoryPrebuild("npm run check:json-parse-ratchet", 15, ["full", "worker"]),
      prebuild("npm run check:migrations", 27, ["full", "worker"]),
      prebuild("npm run check:sql-safety", 33, ["full", "worker"]),
    ],
  },
  {
    id: "catalog-schema-and-data",
    impactPaths: impactPaths({
      full: [
        "scripts/maintenance/audit-pricing-provider-config.ts",
        "shared/lib/pricing-provider-config.ts",
        "scripts/ci/check-provider-resilience.mjs",
        "scripts/lib/provider-resilience-registry.mjs",
        "scripts/maintenance/generate-dependency-coverage-audit.ts",
        "scripts/lib/dependency-coverage-baseline.json",
        "shared/lib/__tests__/peg-price-bounds.test.ts",
        "shared/lib/peg-price-bounds.ts",
        "shared/types/core.ts",
        "scripts/ci/check-redemption-backstops.ts",
        "scripts/maintenance/generate-redemption-coverage-audit.ts",
        "scripts/lib/redemption-coverage-audit-baseline.json",
        "scripts/ci/check-stablecoin-data.ts",
        "scripts/ci/check-oracle-risk-coverage.ts",
        "scripts/lib/oracle-risk-coverage.ts",
        "scripts/ci/check-mechanism-archetype-coverage.ts",
        "scripts/lib/mechanism-archetype-coverage.ts",
        "scripts/ci/check-supply-helper-usage.mjs",
      ],
      validationOnly: ["worker/src/cron/reserve-adapters/__tests__/http-html-fixture-coverage.test.ts"],
      pages: [
        "scripts/ci/check-client-registry-imports.mjs",
        "scripts/fixtures/selector-editorial-examples.md",
        "scripts/maintenance/build-world-map-svg.ts",
      ],
    }),
    leaves: [
      advisoryPrebuild("npm run audit:pricing-providers", 2),
      advisoryPrebuild("npm run check:provider-resilience", 3),
      prebuild("npm run check:client-registry-imports", 11, ["full", "pages"]),
      advisoryPrebuild("npm run check:dependency-coverage", 41),
      advisoryPrebuild("npm run check:redemption-backstops", 28),
      ordered("npm run check:redemption-coverage-audit", "manual-advisory", undefined),
      prebuild("npm run check:stablecoin-data", 35, ["full", "pages"]),
      advisoryPrebuild("npm run check:oracle-risk-coverage:enforce", 36),
      advisoryPrebuild("npm run check:mechanism-archetype-coverage", 42),
      advisoryPrebuild("npm run check:supply-helper-usage", 37),
      ordered("npm run check:world-map", "manual-advisory", undefined, ["full", "pages"]),
    ],
  },
  {
    id: "generated-output-build-and-seo",
    impactPaths: impactPaths({
      pages: [
        "scripts/maintenance/run-generated-artifacts.mjs",
        "scripts/ci/check-feature-flag-inlining.mjs",
        "scripts/ci/check-seo-static.mjs",
        "scripts/maintenance/report-build-size.mjs",
        "scripts/ci/check-build-attribution.mjs",
      ],
    }),
    leaves: [
      prebuild("npm run check:generated-artifacts", 24, ["full", "pages"], true),
      ordered("npm run build", "pages", 1, ["full", "pages"]),
      ordered("npm run check:feature-flag-inlining", "pages", 3, ["full", "pages"]),
      ordered("npm run seo:check", "pages", 4, ["full", "pages"]),
      ordered("npm run check:build-size", "manual-advisory", undefined, ["full", "pages"]),
      ordered("npm run check:build-attribution", "manual-advisory", undefined, ["full", "pages"]),
    ],
  },
  {
    id: "browser-and-accessibility",
    impactPaths: impactPaths({ pages: ["scripts/maintenance/run-pages-smoke.mjs"] }),
    leaves: [
      ordered("npm run test:a11y", "manual-advisory", undefined, ["full", "pages"]),
      ordered("npm run validate:pages-smoke", "smoke", 1, ["full", "pages"]),
    ],
  },
  {
    id: "security-dependencies-and-repository-policy",
    impactPaths: impactPaths({
      full: [
        "scripts/ci/check-env-contract.mjs",
        "scripts/ci/check-hotspot-ratchet.mjs",
        "scripts/ci/check-shared-types-imports.mjs",
        "scripts/ci/check-site-csp-sync.ts",
        "shared/lib/site-csp.ts",
        "shared/lib/runtime-origins.json",
        "public/_headers",
        "scripts/ci/check-unused-code.mjs",
        "scripts/ci/check-worker-import-boundary.mjs",
      ],
      validationOnly: [
        "package-lock.json",
        "package.json",
        "worker/package.json",
        "scripts/ci/check-agent-doc-sync.mjs",
        "scripts/ci/check-agent-skill-symlinks.mjs",
        "scripts/lib/agent-skill-symlink-waivers.json",
        "scripts/ci/check-cli-args-policy.mjs",
        "scripts/lib/cli-argv-policy.mjs",
        "scripts/lib/cli-args.mjs",
        "worker/scripts/lib/destructive-operation-guard.ts",
        "scripts/ci/check-doc-counts.mjs",
        "scripts/ci/check-doc-source-paths.mjs",
        "scripts/ci/check-doc-sync.ts",
        "scripts/ci/check-hook-polling-window.mjs",
        "scripts/ci/check-script-entrypoints.mjs",
        "scripts/ci/check-stale-flags.mjs",
        "scripts/ci/check-verified-doc-links.mjs",
      ],
      pages: ["scripts/ci/check-phishing-signatures.mjs", "scripts/ci/check-classifier-sensitive-copy.mjs"],
      worker: ["scripts/ci/check-worker-wrangler-config.ts", "worker/wrangler.toml"],
    }),
    leaves: [
      advisoryPrebuild("npm run audit:deps", 1),
      advisoryPrebuild("npm run check:agent-doc-sync", 9),
      advisoryPrebuild("npm run check:agent-skill-symlinks", 10),
      advisoryPrebuild("npm run check:cli-args-policy", 12),
      advisoryPrebuild("npm run check:doc-counts", 19),
      advisoryPrebuild("npm run check:doc-source-paths", 20),
      advisoryPrebuild("npm run check:doc-sync", 21),
      prebuild("npm run check:env-contract", 22),
      ordered("npm run check:phishing-signatures", "pages", 5, ["full", "pages"]),
      ordered("npm run check:classifier-sensitive-copy", "pages", 6, ["full", "pages"]),
      advisoryPrebuild("npm run check:hook-polling-window", 25),
      advisoryPrebuild("npm run check:hotspot-ratchet", 26),
      advisoryPrebuild("npm run check:script-entrypoints", 30),
      advisoryPrebuild("npm run check:shared-cycles", 31),
      prebuild("npm run check:shared-types-imports", 32),
      prebuild("npm run check:site-csp-sync", 29, ["full", "pages"]),
      advisoryPrebuild("npm run check:stale-flags", 34),
      advisoryPrebuild("npm run check:unused-code", 38),
      advisoryPrebuild("npm run check:verified-doc-links", 39),
      prebuild("npm run check:worker-boundary", 40, ["full", "worker"]),
      prebuild("npm run check:worker-config", 18, ["full", "worker"]),
    ],
  },
  {
    id: "worker-preview-and-smoke",
    impactPaths: impactPaths({
      worker: ["scripts/ci/check-fetch-body-timeouts.mjs", "scripts/maintenance/run-worker-smoke.mjs"],
    }),
    leaves: [
      advisoryPrebuild("npm run check:fetch-body-timeouts", 4, ["full", "worker"]),
      ordered("npm run validate:worker-smoke", "smoke", 2, ["full", "worker"]),
    ],
  },
  {
    id: "deploy-promotion-and-rollback",
    impactPaths: impactPaths({
      full: ["scripts/maintenance/run-validate-prebuild.mjs", "scripts/maintenance/run-validation-phase.mjs"],
    }),
    leaves: [ordered("npm run validate:prebuild", "orchestration", 1)],
  },
];

const ALL_LEAVES = VALIDATION_LANES.flatMap((lane) => lane.leaves);

function commandsForPhase(phase) {
  return ALL_LEAVES.filter((leaf) => leaf.phase === phase)
    .sort(
      (left, right) =>
        (left.phaseOrder ?? Number.MAX_SAFE_INTEGER) - (right.phaseOrder ?? Number.MAX_SAFE_INTEGER) ||
        left.command.localeCompare(right.command),
    )
    .map((leaf) => leaf.command);
}

export const ALL_VALIDATE_PREBUILD_COMMANDS = ALL_LEAVES.filter((leaf) => leaf.phase === "prebuild")
  .sort((left, right) => left.prebuildOrder - right.prebuildOrder)
  .map((leaf) => leaf.command);

export const VALIDATE_PREBUILD_COMMANDS = ALL_LEAVES.filter(
  (leaf) => leaf.phase === "prebuild" && leaf.blocking !== false,
)
  .sort((left, right) => left.prebuildOrder - right.prebuildOrder)
  .map((leaf) => leaf.command);

export const MANUAL_ADVISORY_VALIDATE_COMMANDS = commandsForPhase("manual-advisory");
export const COMMON_VALIDATE_PREBUILD_COMMANDS = commandsForPhase("orchestration");
export const PAGES_VALIDATE_COMMANDS = commandsForPhase("pages");
export const PAGES_SMOKE_VALIDATE_COMMANDS = commandsForPhase("smoke").filter(
  (command) => command === "npm run validate:pages-smoke",
);
export const WORKER_VALIDATE_COMMANDS = commandsForPhase("worker");
export const WORKER_SMOKE_VALIDATE_COMMANDS = commandsForPhase("smoke").filter(
  (command) => command === "npm run validate:worker-smoke",
);

export function buildNoncriticalTestShardCommands(shardCount = NONCRITICAL_TEST_SHARD_COUNT) {
  return Array.from({ length: shardCount }, (_value, index) => {
    const shard = index + 1;
    return `npm run test:noncritical -- --shard=${shard}/${shardCount}`;
  });
}

export const COMMON_VALIDATE_POSTBUILD_COMMANDS = buildNoncriticalTestShardCommands();

export function normalizeValidatePrebuildSurface(surface) {
  return SURFACES.includes(surface) ? surface : "full";
}

export function parseValidatePrebuildSkipCommands(value) {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  return value
    .split(",")
    .map((command) => command.trim())
    .filter(Boolean);
}

export function shouldIncludeAdvisoryPrebuildChecks(value) {
  return value === true || value === "1" || value === "true" || value === "full" || value === "all";
}

/**
 * @typedef {object} ValidatePrebuildCommandOptions
 * @property {string} [surface]
 * @property {string[]} [skipCommands]
 * @property {boolean} [includeAdvisory]
 */

/** @param {ValidatePrebuildCommandOptions} [options] */
export function buildValidatePrebuildCommands({ surface, skipCommands, includeAdvisory = false } = {}) {
  const normalizedSurface = normalizeValidatePrebuildSurface(surface);
  const skipped = new Set(skipCommands ?? []);
  return ALL_LEAVES.filter(
    (leaf) =>
      leaf.phase === "prebuild" &&
      leaf.surfaces.includes(normalizedSurface) &&
      (includeAdvisory || leaf.blocking !== false) &&
      !skipped.has(leaf.command),
  )
    .sort((left, right) => left.prebuildOrder - right.prebuildOrder)
    .map((leaf) => leaf.command);
}

/**
 * @param {string | undefined} surface
 * @param {Omit<ValidatePrebuildCommandOptions, "surface">} [options]
 */
export function buildValidatePrebuildCommandsForSurface(surface, options = {}) {
  return buildValidatePrebuildCommands({ surface, ...options });
}

export function buildValidateCommandPlan({ pagesChanged = true, workerChanged = true } = {}) {
  return [
    ...COMMON_VALIDATE_PREBUILD_COMMANDS,
    ...(pagesChanged ? PAGES_VALIDATE_COMMANDS : []),
    ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
    ...(workerChanged ? WORKER_VALIDATE_COMMANDS : []),
  ];
}

export function flattenValidationImpactPaths(impact) {
  if (!IMPACT_BUCKETS.includes(impact)) {
    throw new Error(`Unknown validation impact bucket: ${impact}`);
  }
  return [...new Set(VALIDATION_LANES.flatMap((lane) => lane.impactPaths[impact]))].sort();
}

export const VALIDATION_IMPACT_PATHS = Object.fromEntries(
  IMPACT_BUCKETS.map((impact) => [impact, flattenValidationImpactPaths(impact)]),
);

function validateUniqueOrder(leaves, phase) {
  if (leaves.length === 0) return;
  const orders = leaves.map((leaf) => (phase === "prebuild" ? leaf.prebuildOrder : leaf.phaseOrder));
  if (orders.some((order) => typeof order !== "number" || !Number.isInteger(order) || order < 1)) {
    throw new Error(`${phase} orders must be positive integers`);
  }
  if (new Set(orders).size !== orders.length) {
    throw new Error(`${phase} orders must be unique`);
  }
}

export function validateValidationLanes(lanes = VALIDATION_LANES) {
  if (!Array.isArray(lanes)) {
    throw new Error("Validation lanes must be an array");
  }

  const laneIds = new Set();
  const commands = new Set();
  const leaves = lanes.flatMap((lane) => lane.leaves ?? []);

  for (const lane of lanes) {
    if (laneIds.has(lane.id)) throw new Error(`Duplicate validation lane id: ${lane.id}`);
    laneIds.add(lane.id);
    if (!lane.impactPaths || IMPACT_BUCKETS.some((impact) => !Array.isArray(lane.impactPaths[impact]))) {
      throw new Error(`Invalid impact-path buckets for validation lane: ${lane.id}`);
    }

    for (const leaf of lane.leaves ?? []) {
      if (commands.has(leaf.command)) throw new Error(`Duplicate validation lane command: ${leaf.command}`);
      commands.add(leaf.command);
      if (!PHASES.includes(leaf.phase)) throw new Error(`Unknown validation phase for ${leaf.command}: ${leaf.phase}`);
      if (!Array.isArray(leaf.surfaces) || leaf.surfaces.length === 0) {
        throw new Error(`Validation leaf must have at least one surface: ${leaf.command}`);
      }
      for (const surface of leaf.surfaces) {
        if (!SURFACES.includes(surface)) throw new Error(`Unknown validation surface for ${leaf.command}: ${surface}`);
      }
    }
  }

  const terminalLeaves = leaves.filter((leaf) => leaf.terminal === true);
  if (terminalLeaves.length !== 1)
    throw new Error(`Expected one terminal prebuild barrier; received ${terminalLeaves.length}`);
  const [terminal] = terminalLeaves;
  if (terminal.command !== "npm run check:generated-artifacts" || terminal.phase !== "prebuild") {
    throw new Error("The terminal prebuild barrier must be npm run check:generated-artifacts");
  }

  const phaseLeaves = (phase) => leaves.filter((leaf) => leaf.phase === phase);
  validateUniqueOrder(phaseLeaves("prebuild"), "prebuild");
  validateUniqueOrder(phaseLeaves("pages"), "pages");
  validateUniqueOrder(phaseLeaves("worker"), "worker");
  validateUniqueOrder(phaseLeaves("smoke"), "smoke");

  const orchestrationLeaves = leaves.filter((leaf) => leaf.phase === "orchestration");
  if (orchestrationLeaves.length !== 1)
    throw new Error(`Expected one orchestration leaf; received ${orchestrationLeaves.length}`);
}

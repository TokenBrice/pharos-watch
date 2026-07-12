const SURFACES = ["full", "pages", "worker"];
const IMPACT_BUCKETS = ["full", "validation-only", "pages", "worker"];
const PHASES = ["prebuild", "manual-advisory", "pages", "postbuild", "worker", "smoke", "orchestration"];

export const VALIDATE_PREBUILD_SURFACE_ENV = "VALIDATE_PREBUILD_SURFACE";
export const VALIDATE_PREBUILD_SKIP_COMMANDS_ENV = "VALIDATE_PREBUILD_SKIP_COMMANDS";
export const VALIDATE_PREBUILD_MAX_PARALLEL = 8;
export const NONCRITICAL_TEST_SHARD_COUNT = 2;

function prebuild(command, prebuildOrder, surfaces = SURFACES, terminal = false) {
  return { command, phase: "prebuild", prebuildOrder, surfaces, ...(terminal ? { terminal: true } : {}) };
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
      validationOnly: [
        "scripts/ci/check-test-typecheck.mjs",
        "scripts/lib/test-typecheck-baseline.json",
        "tsconfig.test-typecheck.json",
      ],
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
      full: ["scripts/maintenance/run-noncritical-tests.mjs", "scripts/maintenance/run-critical-coverage.mjs"],
    }),
    leaves: [ordered("npm run test:noncritical", "postbuild", 1), ordered("npm run coverage:critical", "postbuild", 2)],
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
        "worker/src/__tests__/index.scheduled.test.ts",
      ],
    }),
    leaves: [
      prebuild("npm run check:cron-abort-contract", 13),
      prebuild("npm run check:cron-console-usage", 14),
      prebuild("npm run check:cron-connections", 16),
      prebuild("npm run check:cron-sync", 17),
      prebuild("npm run check:frozen-invariants", 23),
      prebuild("npm run check:json-parse-ratchet", 15, ["full", "worker"]),
      prebuild("npm run check:migrations", 27, ["full", "worker"]),
      prebuild("npm run check:sql-safety", 33, ["full", "worker"]),
      ordered("npm run validate:worker-scheduled-smoke", "worker", 2, ["full", "worker"]),
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
      prebuild("npm run audit:pricing-providers", 2),
      prebuild("npm run check:provider-resilience", 3),
      prebuild("npm run check:client-registry-imports", 11, ["full", "pages"]),
      ordered("npm run check:dependency-coverage", "manual-advisory", undefined),
      prebuild("npm run check:redemption-backstops", 28),
      ordered("npm run check:redemption-coverage-audit", "manual-advisory", undefined),
      prebuild("npm run check:stablecoin-data", 35),
      prebuild("npm run check:oracle-risk-coverage:enforce", 36),
      prebuild("npm run check:supply-helper-usage", 37),
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
      ordered("npm run check:build-size", "pages", 7, ["full", "pages"]),
      ordered("npm run check:build-attribution", "pages", 8, ["full", "pages"]),
    ],
  },
  {
    id: "browser-and-accessibility",
    impactPaths: impactPaths({ pages: ["scripts/maintenance/run-pages-smoke.mjs"] }),
    leaves: [
      ordered("npm run test:a11y", "pages", 2, ["full", "pages"]),
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
      prebuild("npm run audit:deps", 1),
      prebuild("npm run check:agent-doc-sync", 9),
      prebuild("npm run check:agent-skill-symlinks", 10),
      prebuild("npm run check:cli-args-policy", 12),
      prebuild("npm run check:doc-counts", 19),
      prebuild("npm run check:doc-source-paths", 20),
      prebuild("npm run check:doc-sync", 21),
      prebuild("npm run check:env-contract", 22),
      ordered("npm run check:phishing-signatures", "pages", 5, ["full", "pages"]),
      ordered("npm run check:classifier-sensitive-copy", "pages", 6, ["full", "pages"]),
      prebuild("npm run check:hook-polling-window", 25),
      prebuild("npm run check:hotspot-ratchet", 26),
      prebuild("npm run check:script-entrypoints", 30),
      prebuild("npm run check:shared-cycles", 31),
      prebuild("npm run check:shared-types-imports", 32),
      prebuild("npm run check:site-csp-sync", 29),
      prebuild("npm run check:stale-flags", 34),
      prebuild("npm run check:unused-code", 38),
      prebuild("npm run check:verified-doc-links", 39),
      prebuild("npm run check:worker-boundary", 40),
      prebuild("npm run check:worker-config", 18, ["full", "worker"]),
    ],
  },
  {
    id: "worker-preview-and-smoke",
    impactPaths: impactPaths({
      worker: ["scripts/ci/check-fetch-body-timeouts.mjs", "scripts/maintenance/run-worker-smoke.mjs"],
    }),
    leaves: [
      prebuild("npm run check:fetch-body-timeouts", 4, ["full", "worker"]),
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
    .sort((left, right) => left.phaseOrder - right.phaseOrder)
    .map((leaf) => leaf.command);
}

export const VALIDATE_PREBUILD_COMMANDS = ALL_LEAVES.filter((leaf) => leaf.phase === "prebuild")
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

export const COMMON_VALIDATE_POSTBUILD_COMMANDS = [...buildNoncriticalTestShardCommands(), "npm run coverage:critical"];

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

export function buildValidatePrebuildCommands({ surface, skipCommands } = {}) {
  const normalizedSurface = normalizeValidatePrebuildSurface(surface);
  const skipped = new Set(skipCommands ?? []);
  return ALL_LEAVES.filter(
    (leaf) => leaf.phase === "prebuild" && leaf.surfaces.includes(normalizedSurface) && !skipped.has(leaf.command),
  )
    .sort((left, right) => left.prebuildOrder - right.prebuildOrder)
    .map((leaf) => leaf.command);
}

export function buildValidatePrebuildCommandsForSurface(surface) {
  return buildValidatePrebuildCommands({ surface });
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

function validateContiguousOrder(leaves, phase, expectedCount) {
  if (leaves.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} ${phase} leaves; received ${leaves.length}`);
  }
  const orders = leaves.map((leaf) => (phase === "prebuild" ? leaf.prebuildOrder : leaf.phaseOrder));
  const expectedOrders = Array.from({ length: expectedCount }, (_value, index) => index + 1);
  if (new Set(orders).size !== expectedCount || !expectedOrders.every((order) => orders.includes(order))) {
    throw new Error(`${phase} orders must be unique and contiguous from 1 to ${expectedCount}`);
  }
}

export function validateValidationLanes(lanes = VALIDATION_LANES) {
  if (!Array.isArray(lanes) || lanes.length !== 10) {
    throw new Error(
      `Expected exactly 10 validation lanes; received ${Array.isArray(lanes) ? lanes.length : "non-array"}`,
    );
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

  if (commands.size !== 58) throw new Error(`Expected exactly 58 unique validation leaves; received ${commands.size}`);
  const phaseLeaves = (phase) => leaves.filter((leaf) => leaf.phase === phase);
  validateContiguousOrder(phaseLeaves("prebuild"), "prebuild", 40);
  if (phaseLeaves("manual-advisory").length !== 3) {
    throw new Error("Expected exactly 3 manual-advisory leaves");
  }
  validateContiguousOrder(phaseLeaves("pages"), "pages", 8);
  validateContiguousOrder(phaseLeaves("worker"), "worker", 2);
  validateContiguousOrder(phaseLeaves("smoke"), "smoke", 2);

  const orchestrationLeaves = leaves.filter((leaf) => leaf.phase === "orchestration");
  if (orchestrationLeaves.length !== 1)
    throw new Error(`Expected one orchestration leaf; received ${orchestrationLeaves.length}`);
}

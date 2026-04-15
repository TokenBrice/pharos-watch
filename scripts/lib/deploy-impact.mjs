export function normalizeRepoPath(path) {
  return path.replaceAll("\\", "/");
}

const WORKER_CHANGE_PREFIXES = [
  "shared/",
  "worker/",
];

const PAGES_CHANGE_PREFIXES = [
  "data/",
  "functions/",
  "public/",
  "shared/",
  "src/",
];

const FULL_DEPLOY_INFRA_PATHS = new Set([
  ".github/workflows/deploy-cloudflare.yml",
  ".github/workflows/validate-ci.yml",
  "package-lock.json",
  "package.json",
  "scripts/classify-deploy-changes.mjs",
]);

const FULL_DEPLOY_INFRA_PREFIXES = [
  ".github/actions/",
  "scripts/lib/",
];

const FULL_DEPLOY_GUARDRAIL_EXACT_PATHS = new Set([
  "scripts/audit-pricing-provider-config.ts",
  "scripts/check-critical-coverage.mjs",
  "scripts/check-cron-connection-budget.ts",
  "scripts/check-cron-schedule-sync.ts",
  "scripts/check-doc-counts.mjs",
  "scripts/check-doc-sync.ts",
  "scripts/check-duplicate-exports.mjs",
  "scripts/check-env-contract.mjs",
  "scripts/check-hotspot-ratchet.mjs",
  "scripts/check-redemption-backstops.ts",
  "scripts/check-seo-static.mjs",
  "scripts/check-shared-cycles.mjs",
  "scripts/check-sql-interpolation-safety.mjs",
  "scripts/check-stablecoin-data.ts",
  "scripts/check-unused-code.mjs",
  "scripts/check-verified-doc-links.mjs",
  "scripts/check-worker-import-boundary.mjs",
  "scripts/check-worker-migrations.mjs",
  "scripts/smoke-api.mjs",
  "scripts/smoke-ops.mjs",
  "scripts/smoke-transport.mjs",
  "scripts/smoke-ui.mjs",
  "scripts/test-merge-gate.mjs",
]);

const PAGES_ONLY_INFRA_PATHS = new Set([
  ".github/workflows/pages-prepare.yml",
  ".github/workflows/pages-publish.yml",
  ".github/workflows/pages-release.yml",
  ".github/workflows/rebuild-pages.yml",
]);

const WORKER_CHANGE_EXACT_PATHS = new Set([
  "scripts/check-cron-schedule-sync.ts",
  "scripts/check-worker-import-boundary.mjs",
  "scripts/check-worker-migrations.mjs",
  "scripts/smoke-api.mjs",
]);

const PAGES_CHANGE_EXACT_PATHS = new Set([
  "next.config.ts",
  "postcss.config.mjs",
  "scripts/check-seo-static.mjs",
  "scripts/generate-redirects.ts",
  "scripts/serve-static-export.mjs",
  "scripts/smoke-ui.mjs",
  "scripts/sync-digests.ts",
  "tsconfig.json",
]);

export function hasWorkerDeployImpact(files) {
  return files.some((file) =>
    FULL_DEPLOY_INFRA_PATHS.has(file)
    || FULL_DEPLOY_GUARDRAIL_EXACT_PATHS.has(file)
    || WORKER_CHANGE_EXACT_PATHS.has(file)
    || FULL_DEPLOY_INFRA_PREFIXES.some((prefix) => file.startsWith(prefix))
    || WORKER_CHANGE_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
}

export function hasPagesDeployImpact(files) {
  return files.some((file) =>
    FULL_DEPLOY_INFRA_PATHS.has(file)
    || FULL_DEPLOY_GUARDRAIL_EXACT_PATHS.has(file)
    || PAGES_ONLY_INFRA_PATHS.has(file)
    || PAGES_CHANGE_EXACT_PATHS.has(file)
    || FULL_DEPLOY_INFRA_PREFIXES.some((prefix) => file.startsWith(prefix))
    || PAGES_CHANGE_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
}

export function hasDeployImpact(files) {
  return hasWorkerDeployImpact(files) || hasPagesDeployImpact(files);
}

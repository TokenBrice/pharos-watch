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

const PAGES_ONLY_INFRA_PATHS = new Set([
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
    || WORKER_CHANGE_EXACT_PATHS.has(file)
    || WORKER_CHANGE_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
}

export function hasPagesDeployImpact(files) {
  return files.some((file) =>
    FULL_DEPLOY_INFRA_PATHS.has(file)
    || PAGES_ONLY_INFRA_PATHS.has(file)
    || PAGES_CHANGE_EXACT_PATHS.has(file)
    || PAGES_CHANGE_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
}

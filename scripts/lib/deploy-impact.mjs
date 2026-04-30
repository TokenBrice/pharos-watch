export function normalizeRepoPath(path) {
  return path.replaceAll("\\", "/");
}

const WORKER_CHANGE_PREFIXES = [
  "shared/",
  "worker/",
];

const WORKER_PROMOTION_EXACT_PATHS = new Set([
  "worker/package.json",
  "worker/tsconfig.json",
  "worker/wrangler.toml",
]);

const WORKER_PROMOTION_PREFIXES = [
  "worker/assets/",
  "worker/migrations/",
  "worker/src/",
];

const WORKER_ROOT_RUNTIME_PACKAGES = new Set([
  "@adraffy/ens-normalize",
  "@cf-wasm/resvg",
  "@noble/ciphers",
  "@noble/curves",
  "@noble/hashes",
  "@resvg/resvg-wasm",
  "@resvg/resvg-wasm-legacy",
  "@scure/base",
  "@scure/bip32",
  "@scure/bip39",
  "@shuding/opentype.js",
  "abitype",
  "base64-js",
  "camelize",
  "color-name",
  "css-background-parser",
  "css-box-shadow",
  "css-color-keywords",
  "css-gradient-parser",
  "css-to-react-native",
  "emoji-regex-xs",
  "escape-html",
  "eventemitter3",
  "fflate",
  "hex-rgb",
  "isows",
  "linebreak",
  "ox",
  "pako",
  "parse-css-color",
  "postcss-value-parser",
  "react",
  "satori",
  "string.prototype.codepointat",
  "tiny-inflate",
  "unicode-trie",
  "viem",
  "ws",
  "yoga-layout",
  "zod",
]);

const WORKER_PROMOTION_SHARED_EXCLUDED_PATHS = new Set([
  "shared/lib/pharosville-api-contract.ts",
  "shared/lib/public-docs.ts",
  "shared/types/pharosville.ts",
]);

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
  "scripts/check-cron-abort-contract.mjs",
  "scripts/check-cron-connection-budget.ts",
  "scripts/check-cron-schedule-sync.ts",
  "scripts/check-doc-source-paths.mjs",
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
  "scripts/generate-cemetery-dataset.ts",
  "scripts/rollback-pages-deployment.mjs",
  "scripts/run-critical-coverage.mjs",
  "scripts/run-noncritical-tests.mjs",
  "scripts/run-validate-postbuild.mjs",
  "scripts/run-validate-prebuild.mjs",
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
  "scripts/build-world-map-svg.ts",
  "scripts/generate-docs-metadata.ts",
  "scripts/generate-llms-txt.ts",
  "scripts/generate-markdown-exports.ts",
  "scripts/generate-openapi-spec.ts",
  "scripts/generate-postman-collection.ts",
  "scripts/serve-static-export.mjs",
  "scripts/smoke-ui.mjs",
  "scripts/sync-digests.ts",
  "tsconfig.json",
]);

function isTestPath(file) {
  return /(^|\/)__tests__\/.*\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function isWorkerPromotionSharedPath(file) {
  return file.startsWith("shared/")
    && !WORKER_PROMOTION_SHARED_EXCLUDED_PATHS.has(file)
    && !isTestPath(file);
}

function isWorkerPromotionPath(file) {
  if (isTestPath(file)) {
    return false;
  }
  return WORKER_PROMOTION_EXACT_PATHS.has(file)
    || WORKER_PROMOTION_PREFIXES.some((prefix) => file.startsWith(prefix))
    || isWorkerPromotionSharedPath(file);
}

function parseQuotedJsonKey(line) {
  if (!line.startsWith("\"")) {
    return null;
  }
  const closingQuoteIndex = line.indexOf("\"", 1);
  if (closingQuoteIndex === -1) {
    return null;
  }
  return {
    key: line.slice(1, closingQuoteIndex),
    rest: line.slice(closingQuoteIndex + 1).trimStart(),
  };
}

function normalizeLockPackageName(packagePath) {
  if (packagePath.startsWith("@")) {
    const [scope, name] = packagePath.split("/");
    return scope && name ? `${scope}/${name}` : packagePath;
  }
  return packagePath.split("/")[0] ?? packagePath;
}

export function extractPackageNamesFromDiff(diffText) {
  const names = new Set();
  for (const rawLine of diffText.split(/\r?\n/g)) {
    if (
      (!rawLine.startsWith("+") && !rawLine.startsWith("-"))
      || rawLine.startsWith("+++")
      || rawLine.startsWith("---")
    ) {
      continue;
    }
    const line = rawLine.slice(1).trim();
    const parsed = parseQuotedJsonKey(line);
    if (!parsed) {
      continue;
    }
    if (parsed.key.startsWith("node_modules/")) {
      names.add(normalizeLockPackageName(parsed.key.slice("node_modules/".length)));
      continue;
    }
    if (parsed.rest.startsWith(":")) {
      names.add(parsed.key);
    }
  }
  return [...names];
}

export function hasWorkerPackagePromotionImpact(diffText) {
  return extractPackageNamesFromDiff(diffText).some((name) => WORKER_ROOT_RUNTIME_PACKAGES.has(name));
}

export function hasWorkerDeployImpact(files) {
  return files.some((file) =>
    FULL_DEPLOY_INFRA_PATHS.has(file)
    || FULL_DEPLOY_GUARDRAIL_EXACT_PATHS.has(file)
    || WORKER_CHANGE_EXACT_PATHS.has(file)
    || FULL_DEPLOY_INFRA_PREFIXES.some((prefix) => file.startsWith(prefix))
    || WORKER_CHANGE_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
}

export function hasWorkerPromotionImpact(files) {
  return files.some((file) => isWorkerPromotionPath(file));
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

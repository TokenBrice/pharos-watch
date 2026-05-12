import { DEPLOY_IMPACT_REGISTRY } from "./automation-registry.mjs";

export function normalizeRepoPath(path) {
  return path.replaceAll("\\", "/");
}

const FULL_DEPLOY_INFRA_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.fullDeployInfra.exactPaths);
const FULL_DEPLOY_GUARDRAIL_EXACT_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.fullDeployGuardrails.exactPaths);
const PAGES_ONLY_INFRA_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.pages.workflowOnlyExactPaths);
const PAGES_CHANGE_EXACT_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.pages.exactPaths);
const WORKER_CHANGE_EXACT_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.worker.exactPaths);
const WORKER_PROMOTION_EXACT_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.workerPromotion.exactPaths);
const WORKER_PROMOTION_SHARED_EXCLUDED_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.workerPromotion.sharedExcludedPaths);
const WORKER_ROOT_RUNTIME_PACKAGES = new Set(DEPLOY_IMPACT_REGISTRY.workerRootRuntimePackages);

const FULL_DEPLOY_INFRA_PREFIXES = DEPLOY_IMPACT_REGISTRY.fullDeployInfra.prefixes;
const PAGES_CHANGE_PREFIXES = DEPLOY_IMPACT_REGISTRY.pages.prefixes;
const WORKER_CHANGE_PREFIXES = DEPLOY_IMPACT_REGISTRY.worker.prefixes;
const WORKER_PROMOTION_PREFIXES = DEPLOY_IMPACT_REGISTRY.workerPromotion.prefixes;

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

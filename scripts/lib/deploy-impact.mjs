import { DEPLOY_IMPACT_REGISTRY } from "./automation-registry.mjs";

export function normalizeRepoPath(path) {
  return path.replaceAll("\\", "/");
}

const FULL_DEPLOY_INFRA_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.fullDeployInfra.exactPaths);
const FULL_DEPLOY_GUARDRAIL_EXACT_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.fullDeployGuardrails.exactPaths);
const PAGES_ONLY_INFRA_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.pages.workflowOnlyExactPaths);
const PAGES_CHANGE_EXACT_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.pages.exactPaths);
const WORKER_CHANGE_EXACT_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.worker.exactPaths);
const WORKER_PROMOTION_EXCLUDED_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.workerPromotion.excludedPaths ?? []);
const WORKER_PROMOTION_EXACT_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.workerPromotion.exactPaths);
const WORKER_SHARED_EXCLUDED_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.worker.sharedExcludedPaths ?? []);
const WORKER_PROMOTION_SHARED_EXCLUDED_PATHS = new Set(DEPLOY_IMPACT_REGISTRY.workerPromotion.sharedExcludedPaths);
const WORKER_ROOT_RUNTIME_PACKAGES = new Set(DEPLOY_IMPACT_REGISTRY.workerRootRuntimePackages);
const LOCKFILE_PACKAGE_METADATA_KEYS = new Set([
  "bin",
  "cpu",
  "dependencies",
  "engines",
  "integrity",
  "license",
  "optionalDependencies",
  "os",
  "peerDependencies",
  "resolved",
  "version",
]);
const UNKNOWN_LOCKFILE_PACKAGE_CHANGE = "*lockfile-package-change*";
const PAGES_UI_EXACT_PATHS = new Set(["next.config.ts", "package.json", "package-lock.json"]);
const FULL_DEPLOY_INFRA_PREFIXES = DEPLOY_IMPACT_REGISTRY.fullDeployInfra.prefixes;
const PAGES_CHANGE_PREFIXES = DEPLOY_IMPACT_REGISTRY.pages.prefixes;
const WORKER_CHANGE_PREFIXES = DEPLOY_IMPACT_REGISTRY.worker.prefixes;
const WORKER_PROMOTION_PREFIXES = DEPLOY_IMPACT_REGISTRY.workerPromotion.prefixes;
const WORKER_SHARED_EXCLUDED_PREFIXES = DEPLOY_IMPACT_REGISTRY.worker.sharedExcludedPrefixes ?? [];
const WORKER_PROMOTION_SHARED_EXCLUDED_PREFIXES = DEPLOY_IMPACT_REGISTRY.workerPromotion.sharedExcludedPrefixes ?? [];

function isTestPath(file) {
  return /(^|\/)__tests__\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function isPagesImpactPath(file) {
  return (
    FULL_DEPLOY_INFRA_PATHS.has(file) ||
    FULL_DEPLOY_GUARDRAIL_EXACT_PATHS.has(file) ||
    PAGES_ONLY_INFRA_PATHS.has(file) ||
    PAGES_CHANGE_EXACT_PATHS.has(file) ||
    FULL_DEPLOY_INFRA_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
    PAGES_CHANGE_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
}

function isWorkerPromotionSharedPath(file) {
  return (
    file.startsWith("shared/") &&
    !WORKER_PROMOTION_SHARED_EXCLUDED_PATHS.has(file) &&
    !WORKER_PROMOTION_SHARED_EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
    !isTestPath(file)
  );
}

function isWorkerSharedDeployPath(file) {
  return (
    file.startsWith("shared/") &&
    !WORKER_SHARED_EXCLUDED_PATHS.has(file) &&
    !WORKER_SHARED_EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
    !isTestPath(file)
  );
}

function isWorkerPromotionPath(file) {
  if (WORKER_PROMOTION_EXCLUDED_PATHS.has(file) || isTestPath(file)) {
    return false;
  }
  return (
    WORKER_PROMOTION_EXACT_PATHS.has(file) ||
    WORKER_PROMOTION_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
    isWorkerPromotionSharedPath(file)
  );
}

function parseQuotedJsonKey(line) {
  if (!line.startsWith('"')) {
    return null;
  }
  const closingQuoteIndex = line.indexOf('"', 1);
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
  let currentFile = null;
  let currentLockPackageName = null;
  let hunkLockPackageName = null;
  let hunkHasUnknownLockPackageMetadataChange = false;

  function flushHunk() {
    if (hunkLockPackageName) {
      names.add(hunkLockPackageName);
    } else if (hunkHasUnknownLockPackageMetadataChange) {
      names.add(UNKNOWN_LOCKFILE_PACKAGE_CHANGE);
    }
    hunkLockPackageName = null;
    hunkHasUnknownLockPackageMetadataChange = false;
  }

  for (const rawLine of diffText.split(/\r?\n/g)) {
    if (rawLine.startsWith("diff --git ")) {
      flushHunk();
      const match = rawLine.match(/ b\/(.+)$/);
      currentFile = match ? match[1].trim() : null;
      currentLockPackageName = null;
      continue;
    }
    if (rawLine.startsWith("+++ b/")) {
      currentFile = rawLine.slice("+++ b/".length).trim();
      currentLockPackageName = null;
      continue;
    }
    if (rawLine.startsWith("@@")) {
      flushHunk();
      currentLockPackageName = null;
      continue;
    }
    if (rawLine.startsWith("---")) {
      continue;
    }

    if (!rawLine.startsWith("+") && !rawLine.startsWith("-") && !rawLine.startsWith(" ")) {
      continue;
    }

    const line = rawLine.slice(1).trim();
    const parsed = parseQuotedJsonKey(line);
    if (!parsed) {
      continue;
    }

    if (parsed.key.startsWith("node_modules/")) {
      const packageName = normalizeLockPackageName(parsed.key.slice("node_modules/".length));
      currentLockPackageName = packageName;
      hunkLockPackageName = packageName;
      if (rawLine.startsWith("+") || rawLine.startsWith("-")) {
        names.add(packageName);
      }
      continue;
    }

    if (!parsed.rest.startsWith(":")) {
      continue;
    }

    if (currentFile === "package-lock.json" && LOCKFILE_PACKAGE_METADATA_KEYS.has(parsed.key)) {
      if (currentLockPackageName) {
        hunkLockPackageName = currentLockPackageName;
      } else if (rawLine.startsWith("+") || rawLine.startsWith("-")) {
        hunkHasUnknownLockPackageMetadataChange = true;
      }
      continue;
    }

    if (rawLine.startsWith("+") || rawLine.startsWith("-")) {
      names.add(parsed.key);
    }
  }
  flushHunk();
  return [...names];
}

export function hasWorkerPackagePromotionImpact(diffText) {
  return extractPackageNamesFromDiff(diffText).some(
    (name) => name === UNKNOWN_LOCKFILE_PACKAGE_CHANGE || WORKER_ROOT_RUNTIME_PACKAGES.has(name),
  );
}

export function hasWorkerDeployImpact(files) {
  return files.some(
    (file) =>
      FULL_DEPLOY_INFRA_PATHS.has(file) ||
      FULL_DEPLOY_GUARDRAIL_EXACT_PATHS.has(file) ||
      WORKER_CHANGE_EXACT_PATHS.has(file) ||
      FULL_DEPLOY_INFRA_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
      WORKER_CHANGE_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
      isWorkerSharedDeployPath(file),
  );
}

export function hasWorkerPromotionImpact(files) {
  return files.some((file) => isWorkerPromotionPath(file));
}

export function hasPagesDeployImpact(files) {
  return files.some((file) => isPagesImpactPath(file));
}

export function hasPagesPublishImpact(files) {
  return files.some((file) => !isTestPath(file) && isPagesImpactPath(file));
}

export function hasPagesUiImpact(files) {
  return files.some(
    (file) =>
      !isTestPath(file) &&
      (PAGES_UI_EXACT_PATHS.has(file) || PAGES_CHANGE_PREFIXES.some((prefix) => file.startsWith(prefix))),
  );
}

export function hasOnlyInternalDocsImpact(files) {
  return (
    files.length > 0 &&
    !hasDeployImpact(files) &&
    files.every((file) => file.startsWith("docs/") || (!file.includes("/") && file.endsWith(".md")))
  );
}

export function hasDeployImpact(files) {
  return hasWorkerDeployImpact(files) || hasPagesDeployImpact(files);
}

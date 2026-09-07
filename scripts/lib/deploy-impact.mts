import { DEPLOY_IMPACT_REGISTRY } from "./automation-registry.mjs";

export function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/");
}

const FULL_DEPLOY_INFRA_PATHS = new Set<string>(DEPLOY_IMPACT_REGISTRY.fullDeployInfra.exactPaths);
const FULL_DEPLOY_GUARDRAIL_EXACT_PATHS = new Set<string>(DEPLOY_IMPACT_REGISTRY.fullDeployGuardrails.exactPaths);
const PAGES_ONLY_INFRA_PATHS = new Set<string>(DEPLOY_IMPACT_REGISTRY.pages.workflowOnlyExactPaths);
const PAGES_CHANGE_EXACT_PATHS = new Set<string>(DEPLOY_IMPACT_REGISTRY.pages.exactPaths);
const WORKER_CHANGE_EXACT_PATHS = new Set<string>(DEPLOY_IMPACT_REGISTRY.worker.exactPaths);
const WORKER_RELEASE_EXCLUDED_PATHS = new Set<string>(DEPLOY_IMPACT_REGISTRY.workerRelease.excludedPaths ?? []);
const WORKER_RELEASE_EXACT_PATHS = new Set<string>(DEPLOY_IMPACT_REGISTRY.workerRelease.exactPaths);
const WORKER_SHARED_EXCLUDED_PATHS = new Set<string>(DEPLOY_IMPACT_REGISTRY.worker.sharedExcludedPaths ?? []);
const WORKER_RELEASE_SHARED_EXCLUDED_PATHS = new Set<string>(DEPLOY_IMPACT_REGISTRY.workerRelease.sharedExcludedPaths);
const PAGES_UI_EXACT_PATHS = new Set<string>(["next.config.ts", "package.json", "package-lock.json"]);
const DOCS_ONLY_EXCLUDED_PATHS = new Set<string>(["docs/editorial-style.md"]);
const FULL_DEPLOY_INFRA_PREFIXES = DEPLOY_IMPACT_REGISTRY.fullDeployInfra.prefixes;
const PAGES_CHANGE_PREFIXES = DEPLOY_IMPACT_REGISTRY.pages.prefixes;
const WORKER_CHANGE_PREFIXES = DEPLOY_IMPACT_REGISTRY.worker.prefixes;
const WORKER_RELEASE_PREFIXES = DEPLOY_IMPACT_REGISTRY.workerRelease.prefixes;
const WORKER_SHARED_EXCLUDED_PREFIXES = DEPLOY_IMPACT_REGISTRY.worker.sharedExcludedPrefixes ?? [];
const WORKER_RELEASE_SHARED_EXCLUDED_PREFIXES = DEPLOY_IMPACT_REGISTRY.workerRelease.sharedExcludedPrefixes ?? [];

function isTestPath(file: string): boolean {
  return /(^|\/)__tests__\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function isPagesImpactPath(file: string): boolean {
  return (
    FULL_DEPLOY_INFRA_PATHS.has(file) ||
    FULL_DEPLOY_GUARDRAIL_EXACT_PATHS.has(file) ||
    PAGES_ONLY_INFRA_PATHS.has(file) ||
    PAGES_CHANGE_EXACT_PATHS.has(file) ||
    FULL_DEPLOY_INFRA_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
    PAGES_CHANGE_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
}

function isWorkerReleaseSharedPath(file: string): boolean {
  return (
    file.startsWith("shared/") &&
    !WORKER_RELEASE_SHARED_EXCLUDED_PATHS.has(file) &&
    !WORKER_RELEASE_SHARED_EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
    !isTestPath(file)
  );
}

function isWorkerSharedDeployPath(file: string): boolean {
  return (
    file.startsWith("shared/") &&
    !WORKER_SHARED_EXCLUDED_PATHS.has(file) &&
    !WORKER_SHARED_EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
    !isTestPath(file)
  );
}

function isWorkerReleasePath(file: string): boolean {
  if (WORKER_RELEASE_EXCLUDED_PATHS.has(file) || isTestPath(file)) {
    return false;
  }
  return (
    WORKER_RELEASE_EXACT_PATHS.has(file) ||
    WORKER_RELEASE_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
    isWorkerReleaseSharedPath(file)
  );
}

export function hasWorkerDeployImpact(files: readonly string[]): boolean {
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

export function hasWorkerReleaseImpact(files: readonly string[]): boolean {
  return files.some((file) => isWorkerReleasePath(file));
}

export function hasPagesDeployImpact(files: readonly string[]): boolean {
  return files.some((file) => isPagesImpactPath(file));
}

export function hasPagesPublishImpact(files: readonly string[]): boolean {
  return files.some((file) => !isTestPath(file) && isPagesImpactPath(file));
}

export function hasPagesUiImpact(files: readonly string[]): boolean {
  return files.some(
    (file) =>
      !isTestPath(file) &&
      (PAGES_UI_EXACT_PATHS.has(file) || PAGES_CHANGE_PREFIXES.some((prefix) => file.startsWith(prefix))),
  );
}

export function hasOnlyInternalDocsImpact(files: readonly string[]): boolean {
  return (
    files.length > 0 &&
    !hasDeployImpact(files) &&
    files.every(
      (file) =>
        !DOCS_ONLY_EXCLUDED_PATHS.has(file) &&
        (file.startsWith("docs/") || (!file.includes("/") && file.endsWith(".md"))),
    )
  );
}

export function hasDeployImpact(files: readonly string[]): boolean {
  return hasWorkerDeployImpact(files) || hasPagesDeployImpact(files);
}

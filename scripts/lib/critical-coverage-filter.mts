import { fileURLToPath } from "node:url";
import { BaseCoverageProvider } from "vitest/coverage";

const INSTALLED = Symbol.for("pharos.critical-coverage-filter");
// Plain repo-relative paths only: no glob, escape, quote, dot-segment or absolute spelling.
const PLAIN_RELATIVE_PATH = /^[\w-][\w.-]*(?:\/[\w-][\w.-]*)*$/;

/** Enrolled include paths when every one is plain; null leaves matching to Vitest alone. */
function literalIncludes(include: string[] | undefined): string[] | null {
  return include?.length && include.every((pattern) => PLAIN_RELATIVE_PATH.test(pattern)) ? include : null;
}

/**
 * Vitest global setup for the critical coverage runner only (#1718). Upstream
 * persists every script each suite loaded and applies `coverage.include` after
 * merging them all; owner suites load the full registry graph, and
 * `isIncluded` recompiles every include glob for each new file, so report
 * generation dominated the weekly ratchet. Each suite's V8 result is filtered
 * before persistence: when every include is a plain relative path, a substring
 * prefilter (a superset of the `contains` glob match), then the provider's own
 * predicate, so included scripts' ranges, counts and offsets are untouched.
 * Main process only; workers keep the built-in runtime.
 */
export default function installCriticalCoverageFilter(): void {
  const prototype = BaseCoverageProvider.prototype as BaseCoverageProvider & { [INSTALLED]?: true };
  if (prototype[INSTALLED]) return;
  const persist = prototype.onAfterSuiteRun;
  prototype.onAfterSuiteRun = function (this: BaseCoverageProvider, meta) {
    const coverage = meta.coverage as { result?: { url: string }[] } | undefined;
    if (!Array.isArray(coverage?.result)) return persist.call(this, meta);
    const literals = literalIncludes(this.options.include);
    const result = coverage.result.filter((entry) => {
      const file = fileURLToPath(entry.url);
      const slashed = file.replaceAll("\\", "/");
      return (literals === null || literals.some((path) => slashed.includes(path))) && this.isIncluded(file);
    });
    return persist.call(this, { ...meta, coverage: { ...coverage, result } });
  };
  prototype[INSTALLED] = true;
}

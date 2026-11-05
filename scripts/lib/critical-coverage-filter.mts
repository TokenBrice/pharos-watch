import { fileURLToPath } from "node:url";
import { BaseCoverageProvider } from "vitest/coverage";

const INSTALLED = Symbol.for("pharos.critical-coverage-filter");
const GLOB_SYNTAX = /[*?[\]{}()!+@|]/;

/** Unescaped literal include paths, or null when any include is a real glob. */
function literalIncludes(include: string[] | undefined): string[] | null {
  if (!include?.length || include.some((pattern) => GLOB_SYNTAX.test(pattern.replace(/\\./g, "")))) return null;
  return include.map((pattern) => pattern.replace(/\\(.)/g, "$1"));
}

/**
 * Vitest global setup for the critical coverage runner only (#1718). Upstream
 * persists every script each suite loaded and applies `coverage.include` after
 * merging them all; owner suites load the full registry graph, and
 * `isIncluded` recompiles every include glob for each new file, so report
 * generation dominated the weekly ratchet. Each suite's V8 result is filtered
 * before persistence: a substring prefilter over the enrolled literal paths (a
 * superset of the `contains` glob match), then the provider's own predicate, so
 * included scripts' ranges, counts and offsets are untouched. Main process
 * only; workers keep the built-in runtime.
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
      return (literals === null || literals.some((path) => file.includes(path))) && this.isIncluded(file);
    });
    return persist.call(this, { ...meta, coverage: { ...coverage, result } });
  };
  prototype[INSTALLED] = true;
}

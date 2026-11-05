import { fileURLToPath } from "node:url";
import { BaseCoverageProvider } from "vitest/coverage";

const INSTALLED = Symbol.for("pharos.critical-coverage-filter");
type Decisions = { include: string[] | undefined; literals: string[] | null; byUrl: Map<string, boolean> };
// One decision per script URL per provider: suites reload the same registry modules,
// and repeating the checks per suite blocks the main process that serves worker transforms.
const decisions = new WeakMap<BaseCoverageProvider, Decisions>();
// Plain repo-relative paths only: no glob, escape, quote, dot-segment or absolute spelling.
const PLAIN_SEGMENT = /^[\w-][\w.-]*$/;

/** Enrolled include paths when every one is plain; null leaves matching to Vitest alone. */
function literalIncludes(include: string[] | undefined): string[] | null {
  const plain = (pattern: string) => pattern.split("/").every((segment) => PLAIN_SEGMENT.test(segment));
  return include?.length && include.every(plain) ? include : null;
}

/**
 * Vitest global setup for the critical coverage runner only (#1718). Upstream
 * persists every script each suite loaded and applies `coverage.include` after
 * merging them all; owner suites load the full registry graph, and
 * `isIncluded` recompiles every include glob for each new file, so report
 * generation dominated the weekly ratchet. When every include is a plain
 * relative path, each suite's V8 result keeps only scripts whose path contains
 * one (a superset of the `contains` glob match; Vitest's own predicate still
 * decides at report time), so included scripts' ranges, counts and offsets are
 * untouched. The filter never calls `isIncluded`: it recompiles every include
 * glob per new file (~200 ms here) and would block the main process that serves
 * worker transforms. Any other include spelling disables filtering. Main
 * process only; workers keep the built-in runtime.
 */
export default function installCriticalCoverageFilter(): void {
  const prototype = BaseCoverageProvider.prototype as BaseCoverageProvider & { [INSTALLED]?: true };
  if (prototype[INSTALLED]) return;
  const persist = prototype.onAfterSuiteRun;
  prototype.onAfterSuiteRun = function (this: BaseCoverageProvider, meta) {
    const coverage = meta.coverage as { result?: { url: string }[] } | undefined;
    if (!Array.isArray(coverage?.result)) return persist.call(this, meta);
    let cache = decisions.get(this);
    if (!cache || cache.include !== this.options.include) {
      cache = { include: this.options.include, literals: literalIncludes(this.options.include), byUrl: new Map() };
      decisions.set(this, cache);
    }
    const { literals, byUrl } = cache;
    if (literals === null) return persist.call(this, meta);
    const result = coverage.result.filter((entry) => {
      let keep = byUrl.get(entry.url);
      if (keep === undefined) {
        const slashed = fileURLToPath(entry.url).replaceAll("\\", "/");
        keep = literals.some((path) => slashed.includes(path));
        byUrl.set(entry.url, keep);
      }
      return keep;
    });
    return persist.call(this, { ...meta, coverage: { ...coverage, result } });
  };
  prototype[INSTALLED] = true;
}

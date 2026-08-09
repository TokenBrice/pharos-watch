#!/usr/bin/env tsx

/**
 * Structural gate over the dependency graph.
 *
 * The full dependency-coverage report (`npm run audit:dependency-coverage`)
 * stays a manual curation tool: most of its counters describe a real backlog
 * that moves slowly and ratcheting it only produced bookkeeping commits.
 *
 * Four of its counters are different — they are legitimately zero and a
 * non-zero value means a reviewed record went missing or stale, not that the
 * backlog grew: manual dependency review gaps, stale reserve dispositions,
 * unavailable target disposition gaps, and adapter mapping review gaps. Those
 * plus the zero-tolerance graph invariants (self-edges, duplicate edges,
 * cycles, overweight effective sets, unknown targets, depType-without-coinId)
 * are what this check enforces.
 *
 * The analysis itself is not duplicated here: this re-bins the audit's own
 * summary rather than re-deriving it.
 */

import {
  buildDependencyCoverageAudit,
  evaluateDependencyCoverageStructure,
} from "../maintenance/generate-dependency-coverage-audit";

const audit = buildDependencyCoverageAudit({ generatedAt: new Date().toISOString() });
const failures = evaluateDependencyCoverageStructure(audit);

if (failures.length > 0) {
  process.stderr.write(`Dependency review-gap check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.stderr.write("Run `npm run audit:dependency-coverage` for the full report.\n");
  process.exit(1);
}

process.stdout.write(
  `Dependency review gaps OK (${audit.summary.activeCount} active assets, ` +
    `${audit.summary.staticEdgeCount} static edges, 0 review gaps).\n`,
);

#!/usr/bin/env tsx

/**
 * Structural gate over the dependency graph.
 *
 * The full dependency-coverage report (`npm run audit:dependency-coverage`)
 * stays a manual curation tool: most of its counters describe a real backlog
 * that moves slowly and ratcheting it only produced bookkeeping commits.
 *
 * Three of its counters are different — they are legitimately zero and a
 * non-zero value means a reviewed record went missing or stale, not that the
 * backlog grew: manual dependency review gaps, stale reserve dispositions,
 * and unavailable target disposition gaps. Adapter mapping registry integrity
 * is also structural, but missing-review coverage requires report-card
 * provenance and is therefore reported as not evaluated by this entrypoint.
 * Those checks plus the zero-tolerance graph invariants (self-edges, duplicate
 * edges, cycles, overweight effective sets, unknown targets,
 * depType-without-coinId) are what this check enforces.
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
  `Dependency structural checks OK (${audit.summary.activeCount} active assets, ` +
    `${audit.summary.staticEdgeCount} static edges, ` +
    `${audit.summary.adapterMappingReviewGapCount} adapter registry-integrity gaps). ` +
    "Adapter-mapping missing-review population NOT EVALUATED (no report cards supplied).\n",
);

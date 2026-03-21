# Codebase Audit Plan — 2026-03-21

## Scope

Full-repository architectural audit of the Stablecoin Dashboard / Pharos codebase across three equal pillars:

1. Redundancy elimination
2. Code quality improvement
3. Long-term sustainability and maintainability

## Inventory Summary

- Frontend: Next.js 16 static export in `src/`
- Shared runtime-neutral logic: `shared/`
- Pages Functions ops proxy: `functions/`
- Worker API + cron + D1: `worker/`
- CI / policy scripts: `scripts/`
- Docs corpus: `docs/`

## Required Context Read

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- `package.json`
- `worker/package.json`
- `.github/workflows/*`

## Audit Method

1. Build repo inventory and identify module boundaries.
2. Run three parallel analysis tracks:
   - redundancy
   - code quality
   - sustainability
3. Perform local cross-checks on shared hotspots and CI/deploy surfaces.
4. Correlate compound issues spanning multiple pillars.
5. Produce a remediation roadmap grouped by effort and dependency.

## Expected Deliverables

- Consolidated audit report in `agents/audits/`
- Supporting research notes in `agents/research/` if needed
- Final user-facing summary with the highest-priority issues and next actions

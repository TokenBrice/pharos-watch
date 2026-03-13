# Documentation Health Report — 2026-03-13

## Scope

- Authoritative docs audited: `52`
  - Root docs: `README.md`, `AGENTS.md`, `CLAUDE.md`, `agents/README.md`
  - `/docs` corpus: `48` files (`47` Markdown files + `1` TSV reference artifact)
- Archival docs inventoried structurally: `243` Markdown/text artifacts under `/agents`
- Full manifest: `agents/audits/2026-03-13-documentation-manifest.tsv`

The `/agents` archive was reviewed as documentation architecture rather than line-by-line canonical product documentation. The authoritative source-of-truth surface remains live code plus `/docs`.

## Verification Surfaces

The audit was cross-checked against the live worktree, including:

- `package.json`
- `worker/package.json`
- `src/app/about/*`
- `src/app/methodology/*`
- `src/components/homepage-client.tsx`
- `src/components/contagion-graph.tsx`
- `src/hooks/use-compare-data-model.ts`
- `shared/lib/api-endpoints.ts`
- `shared/lib/cron-jobs.ts`
- `shared/lib/status-thresholds.ts`
- `worker/src/api/*`
- `worker/src/cron/*`
- `worker/src/handlers/*`
- `worker/src/lib/*`
- `worker/wrangler.toml`

## Findings Summary

- Critical: `0`
- Major: `7`
- Minor: `0`

## Major Issues Found And Fixed

1. Archive-boundary drift:
   - `/agents` was not clearly documented as archival working material, and its folder-governance doc no longer matched the real tree or filename conventions.
   - Fixed by replacing `agents/README - FOLDER ORGANIZATION.md` with `agents/README.md` and making the archive/canonical boundary explicit.

2. Root guidance drift:
   - `AGENTS.md` and `CLAUDE.md` required `/about` updates but did not point readers to `docs/about-page.md`, omitted the repo-root `functions/` runtime surface, and summarized worker scheduling with stale counts.
   - Fixed in both root guidance docs.

3. Hard-coded migration count drift:
   - `README.md` and `docs/architecture.md` still documented `72` worker migrations while the live tree contains `73`.
   - Fixed to match the current migration inventory.

4. Worker infrastructure drift:
   - `docs/worker-infrastructure.md` still referenced `worker/src/lib/status-thresholds.ts` after the thresholds moved to `shared/lib/status-thresholds.ts`.
   - The same doc also described public API rate limiting as an in-memory pre-router limiter instead of the current D1-backed distributed limiter with isolate-local fallback.
   - Both sections were corrected.

5. Homepage route-contract drift:
   - `docs/homepage.md` claimed all major research-band subsections were wrapped in `SectionErrorBoundary`.
   - Live code wraps `CategoryStats` and `TotalMcapChart`, but `PegDiversityChart` renders directly.
   - The doc now reflects the actual boundary coverage.

6. Compare route-contract drift:
   - `docs/cemetery-and-compare.md` said compare pulled supply-history charts from per-coin detail `GET /api/stablecoin/:id`.
   - Live compare code uses per-coin `GET /api/supply-history` queries plus per-coin `GET /api/mint-burn-flows` queries.
   - The doc was updated to match the current query model and reliability surface.

7. Dependency-map UI drift:
   - `docs/dependency-map.md` documented a `Min edge` control and hidden-link marker behavior that no longer exists in the UI.
   - The doc now reflects the current `Focus` control group and conditional neighborhood picker only.

## Remediation Completed

Files changed directly in this pass:

- `AGENTS.md`
- `CLAUDE.md`
- `README.md`
- `agents/README.md`
- `docs/architecture.md`
- `docs/worker-infrastructure.md`
- `docs/homepage.md`
- `docs/cemetery-and-compare.md`
- `docs/dependency-map.md`
- `agents/audits/2026-03-13-documentation-manifest.tsv`
- `agents/audits/2026-03-13-documentation-health-report.md`

## Coverage Notes

- The authoritative `/docs` corpus was checked against live code and current repo structure.
- The wider `/agents` archive was inventoried and structurally reviewed so stale plans/audits no longer masquerade as canonical docs.
- No new application-doc files were required for this pass; the main issues were drift and archive-boundary clarity.

## Verification

- Relative Markdown link validation passed.
- Exact file-path references in the audited root/docs surface resolved after remediation.
- `npm run lint` passed.
- `npm test` passed: `198` files, `1707` tests.
- `cd worker && npx tsc --noEmit` passed.
- `npm run check:worker-boundary` passed.
- `npm run check:migrations` passed and validated `73` worker migrations.
- `npm run build` passed.

## Notes

- Unrelated in-progress worktree changes were present in status-related code/docs and were left intact.

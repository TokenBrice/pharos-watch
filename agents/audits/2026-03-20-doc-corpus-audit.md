# 2026-03-20 Documentation Corpus Audit

## Scope

Full `/docs` verification against the current codebase, plus cross-checks against `README.md`, `AGENTS.md`, and `CLAUDE.md`.

## Workflow

1. Inventory source-of-truth registries and counts.
2. Verify system docs (`architecture.md`, `api-reference.md`, `worker-infrastructure.md`, `testing.md`, `deployment-process.md`, `worker-and-api-limits.md`, `data-flow-map.md`, `scripts.md`).
3. Verify feature and methodology docs.
4. Verify route/page and design docs.
5. Check cross-document consistency and identify documentation gaps.

## Verified Findings

- `docs/architecture.md`, `docs/worker-infrastructure.md`, and `README.md` were stale on the worker migration count (`75` documented vs `77` actual files in `worker/migrations/`).
- `docs/api-reference.md` was missing `feeDescription` on the redemption-backstop response contract even though the shared schema now exposes it.
- `docs/redemption-backstops.md` and `docs/stablecoin-detail-page.md` lagged the live redemption-fee behavior after the `feeDescription` rollout (`v1.1` methodology, descriptive fee text, `details_json` persistence).
- The docs corpus had no timeline docs for pricing pipeline or chain health even though the app exposes public changelog routes for both and the shared version sources already exist.

## Coverage Decisions

- Created `docs/chain-health-timeline.md` from `shared/lib/chain-health-version.ts`.
- Created `docs/pricing-pipeline-timeline.md` from `shared/lib/pricing-pipeline-version.ts`.
- Updated `docs/README.md`, `docs/methodology-page.md`, `docs/chains-page.md`, and `docs/pricing-pipeline.md` so the new timeline docs are discoverable and part of the update contract.

## Verification Commands

- `npm run check:doc-counts` ✅
- `npm run lint` ✅ (warnings only; no errors)
- `npm test` ✅ (`259` files, `2466` passed, `1` todo)
- `cd worker && npx tsc --noEmit` ✅
- `npm run build` ✅

# Worker Agent Notes

Applies to `worker/`.

## Read First

- Start with the routed owning sections and `docs/worker-infrastructure.md#module-initialization`.
- Fetch/API work: `docs/worker-and-api-limits.md#connection-budget-operating-assumption` and `docs/worker-infrastructure.md#http-request-handling`.
- Cron, scheduled dispatch, lease, timeout, or slot lifecycle work: `docs/worker-infrastructure.md#cron-scheduling` and `docs/process/cron-trigger-policy.md#target`; use the routed pipeline section of `docs/data-flow-map.md` when data flow changes.
- Migration/deploy work: `docs/deployment-process.md` § “CI Deploy Sequence” and `worker/migrations/MANIFEST.md` § “Baseline (0000)” / § “Individual Migrations (current active files)”. Never reuse a migration sequence.
- Safety Score V9: `docs/report-cards.md` § “V9 Model”, `docs/process/safety-score-equivalence-harness.md` § “When to use it”, and `docs/process/safety-score-curation-expiry-sweep.md` § “1. Capture the current production input”.
- DEX work: `docs/dex-liquidity.md` § “Discovery Cron”; Telegram/digest work: `docs/telegram-architecture.md` § “Seam overview” and `docs/digest-pipeline.md` § “Overview”.

Route with `node --import tsx scripts/ci/pharos-change-contract.ts --file <path>`.

## Rules

- Do not read `Env` bindings at module initialization; derive runtime config inside request or scheduled contexts.
- Worker code may import `@shared/*`, but must not import frontend `src/` modules.
- Wire shapes and vocabularies belong to one schema in `shared/types/`; import that schema and its derived type instead of creating Worker-only interfaces or literal-union copies. Reuse primitive schemas and registry-derived mappings per `shared/AGENTS.md` and ADR-32.
- Supply at publication, scoring, filtering, and history/delta boundaries uses `getCirculatingRawOrNull()` and historical `*OrNull` helpers; preserve null with an availability reason. Raw zero-default helpers are permitted only where availability is explicitly proven, including a genuine observed zero.
- For cron capacity and connection rules, follow `docs/process/cron-trigger-policy.md` § “Target”.
- For D1 row null normalization and identity checks, follow `loadBlacklistCurrentBalanceMap()` in `worker/src/lib/blacklist-current-balances.ts`.
- `worker/wrangler.toml` changes require `npm run check:worker-config`; migration changes require `npm run check:migrations`.

## Common Checks

- Typecheck with `cd worker && npx tsc --noEmit`; check schedules with `npm run check:cron-sync` and `npm run check:cron-connections`.
- Focused tests live beside their owning unit in `__tests__/`; cron lane modules use `worker/src/cron/<lane>/__tests__/`, while flat cron modules use `worker/src/cron/__tests__/`. API, library, and handler suites follow their corresponding owner directories.

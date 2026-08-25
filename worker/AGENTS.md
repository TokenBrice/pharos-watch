# Worker Agent Notes

Applies to `worker/**`.

## Read First

- `docs/worker-infrastructure.md`
- `docs/worker-and-api-limits.md`
- `docs/data-flow-map.md`
- `docs/deployment-process.md` for migration or deploy-path work
- `docs/process/cron-trigger-policy.md` for cron trigger, schedule, or slot work

Per-change routing is owned by `docs/doc-ownership.json`; run `node --import tsx scripts/ci/pharos-change-contract.ts` for the docs, checks, and rules that match the exact files you touch. The list above is the offline starting point, not the full contract.

## Rules

See root AGENTS.md / CLAUDE.md Hard Rules for cross-cutting rules. This file only documents worker-specific items.

- Do not read `Env` bindings at module initialization time. Derive runtime config inside request or scheduled contexts.
- Preserve the `worker/src` boundary: worker code may import `@shared/*`, but must not import frontend `src/*` modules.
- Treat cron trigger slots as capacity decisions. Heavy fetch work competes for the same per-trigger connection pool.
- `value != null` is the intentional D1 null/undefined guard style in worker code.

## Common Checks

- `cd worker && npx tsc --noEmit`
- `npm run check:cron-sync`
- `npm run check:cron-connections`
- `npm run check:migrations`
- Focused worker API or cron Vitest suites for the touched module

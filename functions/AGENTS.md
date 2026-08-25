# Pages Functions Agent Notes

Applies to `functions/**`.

## Read First

- `docs/architecture.md`
- `docs/worker-infrastructure.md`
- `docs/operator-origin-access.md`
- `docs/deployment-process.md`

Per-change routing is owned by `docs/doc-ownership.json`; run `node --import tsx scripts/ci/pharos-change-contract.ts` for the docs, checks, and rules that match the exact files you touch. The list above is the offline starting point, not the full contract.

## Rules

See root AGENTS.md / CLAUDE.md Hard Rules for cross-cutting rules. This file only documents functions-specific items.

- Pages Functions own same-origin proxy behavior for browser-facing website and operator lanes.
- Production `/_site-data/*` hosts require `SITE_API_ORIGIN` and forward `SITE_API_SHARED_SECRET` to the Worker site-data lane.
- `site-api.pharos.watch` is internal, not a browser surface.
- Keep Pages env contracts aligned with `functions/lib/ops-env.ts`, `functions/lib/site-api-env.ts`, and `.env.example`.
- Do not import `worker/src/**`; shared cross-runtime policy belongs in `shared/lib/**`.

- For `functions/selector-snapshot/**`, read `docs/screener-picker-page.md`. It owns the write controls, trusted-provenance contract, retention behavior, and escalation path; source batching against the shared Workers connection budget lives in `functions/lib/selector-canonical-snapshot.ts`. Do not duplicate that volatile implementation snapshot here.

## Common Checks

- Pages Functions tests under `functions/**/__tests__`
- `npm run check:env-contract`
- `npm run test:smoke-transport` when host routing changes
- `npm run lint:changed` (ESLint enforces the ADR-2 `worker/src/**` import ban)

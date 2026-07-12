# Pages Functions Agent Notes

Applies to `functions/**`.

## Read First

- `docs/architecture.md`
- `docs/worker-infrastructure.md`
- `docs/operator-origin-access.md`
- `docs/deployment-process.md`

## Rules

See root AGENTS.md / CLAUDE.md Hard Rules for cross-cutting rules. This file only documents functions-specific items.

- Pages Functions own same-origin proxy behavior for browser-facing website and operator lanes.
- Production `/_site-data/*` hosts require `SITE_API_ORIGIN` and forward `SITE_API_SHARED_SECRET` to the Worker site-data lane.
- `site-api.pharos.watch` is internal, not a browser surface.
- Keep Pages env contracts aligned with `functions/lib/ops-env.ts`, `functions/lib/site-api-env.ts`, and `.env.example`.
- Do not import `worker/src/**`; shared cross-runtime policy belongs in `shared/lib/**`.

- For `functions/selector-snapshot/**`, read `docs/screener-picker-page.md`. It owns the write controls, trusted-provenance contract, source batching, retention behavior, and escalation path; do not duplicate that volatile implementation snapshot here.

## Common Checks

- Pages Functions tests under `functions/__tests__`
- `npm run check:env-contract`
- `npm run check:worker-boundary`

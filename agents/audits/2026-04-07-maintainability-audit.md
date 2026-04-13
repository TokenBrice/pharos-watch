# Maintainability Audit — 2026-04-07

## Validation baseline

- `npm run check:unused-code` ✅
- `npm run check:hotspot-ratchet` ✅
- `npm run audit:deps` ✅
- `npm run lint` ✅
- `npm run typecheck` ✅
- `npm test` ✅ (`425` files, `3964` tests)
- `cd worker && npx tsc --noEmit` ✅
- `npm run build` ✅

## Highest-impact findings

1. `worker/src/cron/stability-index.ts` writes a fresh PSI sample even when DEWS is unavailable by defaulting `dewsStressBreadth` to `0`; `worker/src/api/stability-index.ts` then serves that sample without surfacing the degraded dependency to clients.
2. `worker/src/lib/api-utils.ts` has become a 700+ line mixed-responsibility dependency hub used in `59` worker imports, increasing coupling between freshness policy, response shaping, param parsing, and cache handling.
3. `worker/src/api/backfill-depegs.ts` still mixes admin request parsing, FX orchestration, historical-source resolution, dry-run diffing, and mutation logic, with duplicated preview-building branches.
4. `worker/src/cron/sync-live-reserves.ts` / `worker/src/cron/sync-live-reserves-core.ts` lose fallback-chain failure context because the wrapper rethrows the primary error after fallback attempts fail.
5. `src/app/safety-scores/client.tsx` and `src/app/stability-index/client.tsx` remain large route clients without direct route-level tests, despite containing substantial derived-state and presentation logic.

## Supporting notes

- `functions/_site-data/[[path]].ts` and `functions/api/admin/[[path]].ts` share the same Pages-proxy shape (timeout, forwarded-header policy, upstream fetch, response shaping) but duplicate the orchestration around those shared utilities.
- `worker/src/api/mint-burn-flows.ts` has already extracted some shared helpers, but aggregate and per-coin paths still repeat query/fallback/cache patterns that can be consolidated further.
- `worker/src/lib/api-utils.ts` also embeds the current clamp-based numeric-query parsing behavior, while `docs/api-reference.md` describes bad numeric/filter inputs as `400` cases, so the public contract is currently ambiguous.

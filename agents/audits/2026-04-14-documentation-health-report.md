# Documentation Health Report - 2026-04-14

## Scope Audited

- 57 files under `/docs/`
- root `README.md`, `AGENTS.md`, `CLAUDE.md`
- `worker/migrations/MANIFEST.md`
- `shared/data/stablecoins/PROVENANCE_NOTES.md`
- live documentation surfaces under `src/app/coverage/**` and `src/app/methodology/**`

Historical/tooling markdown discovered but not treated as code-synchronized product documentation:

- `/agents/`: 689 tracked archival working artifacts
- `.claude/skills/`: 11 tracked local skill docs
- `.codex-autorunner/`: 12 tracked autorunner/tooling docs

Reason: `docs/README.md` and `agents/README.md` define `/docs/` plus root `README.md` as the verified product corpus and `/agents/` as working-artifact history. Historical artifacts should not be rewritten to match current code unless they become normative docs.

## Findings

- Critical: 0
- Major: 6
- Minor: 7

## Major Fixes

- Added missing admin API reference and architecture entries for `GET /api/api-keys/audit-log`.
- Updated Worker cron documentation from 13 to 14 trigger slots, including the isolated `9,24,39,54 * * * *` `status-self-check` lane and the current connection-budget table.
- Updated operator-origin docs to include the live `site-api.pharos.watch` Worker custom domain.
- Corrected `/status/` docs from noindex to public/indexable, matching route metadata and sitemap behavior.
- Corrected Worker env binding wording for `PUBLIC_API_AUTH_MODE` and Cloudflare Access pairing requirements.
- Split the status data-flow row into public hooks/API (`usePublicEndpointProbes`, `usePublicStatusHistory`, `/api/public-status-history`) and admin hooks/API (`useStatus`, `useEndpointProbes`, `useStatusHistory`).

## Minor Fixes

- Updated `/chains/` status badge docs from `experimental` to `mature`.
- Updated `/portfolio/` status badge docs from `experimental` to `beta`.
- Replaced stale `worker/src/lib/jwt-verify.ts` documentation with `shared/lib/cloudflare-access-jwt.ts`.
- Clarified `MAINTENANCE_MODE=true` applies after CORS preflight handling, so `OPTIONS` requests are not part of the kill switch.
- Replaced stale or non-literal path references such as `shared/lib/api-endpoints.ts` and brace-glob module paths with resolvable paths or directory surfaces.
- Updated stale external links for CoinGecko Onchain, Jupiter Price API, and DefiLlama Protocols.
- Aligned DEX Liquidity component copy with `LIQUIDITY_SCORE_WEIGHTS[4].label` (`Diversity`) in the Markdown methodology doc, the live methodology page, and the doc-sync guard.

## Validation

Passed:

- `npm run check:doc-counts`
- `npm run check:verified-doc-links`
- `npm run check:doc-sync`
- `npm run check:env-contract`
- `npm run check:redemption-backstops`
- `npm run check:cron-sync`
- `npm run check:cron-connections`
- `npm run check:migrations`
- custom path-reference scan: 1105 backticked path-like references resolved
- custom external-link scan: all primary-doc external links resolved, except `https://dexscreener.com/` returns a Cloudflare challenge to automation while remaining the intended public site
- `npm run lint`
- `npm run typecheck`
- `npm test` (464 files, 4468 tests)
- `npm run build`
- `npm run seo:check`

Noted validation caveat:

- `npm run test:merge-gate` reported zero changed files and skipped because its diff detector did not include the current working-tree edits. Direct validation commands above were run instead.

## Structural Changes

- Added this health report.
- Added `agents/audits/2026-04-14-documentation-audit-manifest.md`.
- No docs were moved, split, merged, or deleted.

## Remaining Concerns

- `/agents/` contains many point-in-time audits/plans/investigations that are expected to drift from current code. Treat them as archive unless a specific artifact is promoted into `/docs/`.
- External link automation cannot fully verify DexScreener because its homepage returns a Cloudflare challenge to non-browser requests.


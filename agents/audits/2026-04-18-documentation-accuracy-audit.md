# Documentation Accuracy Audit - 2026-04-18

Scope: README, the full `docs/` corpus, `/about/`, `/methodology/`, and the API reference surface. Code was treated as source of truth.

## Coverage

- API/reference: endpoint metadata, auth lanes, freshness headers, cache profiles, public API rate limiting, admin mutation requirements, site-data and ops proxy behavior.
- Methodology: Safety Scores, pricing, DEWS/depeg, blacklist tracker, mint/burn flows, Chain Health, PSI, redemption backstops, liquidity.
- Operations: cron schedule inventory, connection budgets, digest runtime, deployment inputs, runbooks, env contracts, scripts, generated agent code map.
- Route docs: About, Coverage, stablecoin detail, Chains, Status, Compare, Funding route map.
- Data-model docs: live reserves, supply snapshots, DEX liquidity, Telegram, digest, classification.

## Main Corrections Applied

- Updated cron documentation to 16 runner slots and 31 status-tracked jobs, including the `*/5 * * * *` manual digest poll and `0 3 * * *` prune slot.
- Corrected API freshness semantics to the code-backed `8x`/`12x` runway and fixed `/api/chains` max-age documentation to 1800 seconds.
- Documented `X-Pharos-Admin: 1` for mutating admin routes and the `Retry-After` header for rate limiting.
- Updated methodology copy for stale DEX scoring, DEWS contagion amplification, blacklist coverage/cadence, mint/burn configured-chain semantics, pricing DEX promotion, and Chain Health cadence.
- Updated data-source and model docs for supply snapshots, live reserve adapter counts, Balancer/direct DEX coverage, digest distribution, Telegram schema, operator Access bindings, and funding route indexing.
- Regenerated `docs/agent-code-map.md`.

## Validation

- `npm run check:doc-counts`
- `npm run check:doc-source-paths`
- `npm run check:verified-doc-links`
- `npm run check:doc-sync`
- `npm run check:env-contract`
- `npm run check:cron-sync`
- `npm run check:cron-connections`
- `npm run typecheck`
- `npm run lint`
- `npm test -- src/lib/__tests__/api-reference-doc.test.ts src/app/methodology/page.test.tsx src/lib/__tests__/methodology-version.test.ts`

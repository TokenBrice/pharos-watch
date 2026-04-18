# Documentation Verification Second Pass - 2026-04-19

Scope: second verification pass after the 2026-04-18 documentation correction wave. Code, tests, workflow files, and checked-in data remained the source of truth.

## Additional Areas Verified

- API reference edge cases: auth/proxy status codes, admin mutation headers, object `_meta` examples, query-param clamp/default behavior, OG error modes.
- Methodology nuance: DEWS liquidity fail-closed behavior, public DEWS formula amplifiers, PSI no-publish behavior on DEWS query failure, Safety Score operation order, depeg recovery close conditions, redemption hook cadence.
- Route/page contracts not deeply changed in the first pass: coverage ordering, stablecoin-detail rail vs DOM order, dependency-map edge source, funding route noindex/nofollow, sitemap caveats, admin status top fold.
- Operations/runbooks/scripts: admin POST script auth headers, Pages Functions site-data bindings, classifier usage in PR/deploy workflows, blacklist remediation actions, stablecoins-cache direct-call auth pattern.
- Design/docs system: breadcrumb primitive guidance, typography carve-outs, cemetery theme behavior, generated agent code map route cap, doc ownership/timeline routing, non-canonical documentation map status.
- Data/domain docs: Telegram launch snapshot, yield variant/optional-source roster, feedback schema inventory, DEX schema lineage, FX/metals cadence.

## Validation

- `npm run check:doc-counts`
- `npm run check:doc-source-paths`
- `npm run check:verified-doc-links`
- `npm run check:doc-sync`
- `npm run check:env-contract`
- `npm run typecheck`
- `npm run typecheck:worker-scripts`
- `npm run lint`
- `npm run check:hotspot-ratchet`
- `npm test -- src/lib/__tests__/api-reference-doc.test.ts src/app/methodology/page.test.tsx src/lib/__tests__/methodology-version.test.ts scripts/__tests__/doc-sync.test.ts scripts/__tests__/rollback-pages-deployment.test.ts`
- `bash -n scripts/backfill-gold-depegs.sh && bash -n scripts/backfill-non-usd-depegs.sh`
- `git diff --check`

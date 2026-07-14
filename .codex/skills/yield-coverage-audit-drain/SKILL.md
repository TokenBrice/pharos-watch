---
name: yield-coverage-audit-drain
description: Drain the Pharos Yield Intelligence coverage-audit queue into reviewed source coverage, documented intentional gaps, or watchlisted deferrals. Use monthly after `yield-coverage-audit` runs, after yield coverage drops, or when promoting queue candidates such as `native-exact-pool`, `lending-allowlist`, `source-family-adapter`, `stale-auto-lending-override`, or `quarantine-ready-to-restore`.
---

# Yield Coverage Audit Drain

Monthly operator workflow for turning the cached `yield-coverage-audit`
queue into safe Yield Intelligence coverage changes. The audit queue is a
starting point, not authority: every promotion must be verified against live
source data, local stablecoin identity, safety/publication gates, and the
current methodology docs.

## Required Context

1. Read root `AGENTS.md`, `docs/agent-task-router.md`, and the matched yield
   docs before editing.
2. Read scoped instructions before touching files under `worker/`, `shared/`,
   `src/`, or `shared/data/stablecoins/`.
3. Inspect these source entrypoints before changing behavior:
   - `worker/src/cron/yield-coverage-audit.ts`
   - `worker/src/cron/yield-config*.ts`
   - `worker/src/cron/yield-sync/resolve-helpers.ts`
   - `worker/src/cron/fetch-tbill-rate.ts` if benchmark sources change
   - `shared/types/status.ts` when queue payload shape changes
4. Treat `/docs/` and `README.md` as verified docs. Use `/agents/` only for
   scratch notes or handoffs.

## Queue Snapshot

Prefer a read-only production/cache snapshot. The cache key is
`yield-coverage-audit`; status also exposes a bounded view through
`yieldHealth.coverageAudit`.

Use whichever access path is already authenticated in the workspace:

```bash
npx wrangler d1 execute stablecoin-db --remote --command "select key, value, updated_at from cache where key = 'yield-coverage-audit';"
```

If remote D1 is unavailable, run the local monthly audit path or use the most
recent cached payload already present in test fixtures or run output. Do not
mutate production D1 from this skill.

Record the snapshot date, `reportedAt`, queue counts, and whether the payload
was production, local, or fixture-derived.

## Decision Workflow

### 1. Triage queue items

Handle queue items by `kind`:

- `stale-auto-lending-override`: verify the mapped DeFiLlama pool still exists,
  is single-exposure, is stablecoin-marked, remains in an allowlisted project,
  clears the APY and TVL floor, and is not collision-blocked. Remove stale pins
  or repoint to a verified replacement.
- `native-exact-pool`: verify tracked stablecoin identity by chain/address or a
  documented wrapper variant. Promote only exact native holder-yield rows.
- `lending-allowlist`: verify DeFiLlama protocol category is Lending, CDP, RWA
  Lending, or Uncollateralized Lending. Add allowlist slugs only from the queue
  or a clearly equivalent candidate, not broad protocol hunting.
- `source-family-adapter`: require a reusable protocol-native API/on-chain
  adapter shape. Do not add one-off scrapers for pages without stable machine
  payloads.
- `quarantine-ready-to-restore`: verify the live deterministic probe, the
  exchange-rate envelope, source freshness, and reason the adapter was
  quarantined before restoring hourly coverage.
- `manifest-missing` / `ranking-missing`: check whether this is a source gap,
  publication gate, safety gate, stale benchmark, or intentional gap. Do not
  force coverage around a guard without written rationale.

### 2. Verify source identity

For each candidate:

1. Pull live DeFiLlama Yields data from `https://yields.llama.fi/pools` or the
   candidate chart endpoint.
2. Match the candidate to local stablecoin metadata by contract address,
   wrapper mapping, chain alias, and symbol. Symbol-only matches are acceptable
   only when address data is unavailable and no same-symbol collision exists.
3. For CoinGecko-derived or contract-derived identity, use existing Pharos
   chain IDs from `shared/lib/chains/index.ts`; do not invent unsupported chain
   identifiers.
4. Add same-symbol false-positive guards to
   `AUTO_LENDING_COLLISION_BLOCKLIST` when a live pool is valid but belongs to a
   different tracked asset.
5. For safety-bypass candidates, add a code comment explaining why the bypass is
   limited and why the exact pool is acceptable. Use bypasses sparingly.

### 3. Promote, reject, or defer

Promote only when the candidate passes identity, source, APY/TVL, and
publication gates:

- Exact stablecoin yield-bearing pools usually belong in `YIELD_POOL_MAP` or an
  explicit source-family config.
- Non-yield-bearing venue opportunities belong in `AUTO_LENDING_POOL_MAP` only
  when the pinned DeFiLlama UUID is safer than generic discovery.
- Reusable lending protocols belong in `LENDING_PROTOCOL_ALLOWLIST`; keep labels
  in `LENDING_PROTOCOL_LABELS`.
- Benchmark-derived assets require a benchmark fetcher, cache schema, yield
  benchmark type update, rate-derived config, tests, and docs/source roster
  updates.

Reject or defer when:

- The pool is multi-exposure, below floor, reward-only/no base yield, or
  same-symbol but wrong asset.
- The product page shows APY but no stable public machine-readable endpoint.
- The source is gated by login/session headers, legal accreditation, or
  undisclosed off-chain reporting.
- A native module exists but lacks a verified adapter path. Document the
  candidate and next review date instead of adding speculative code.

## Documentation and Versioning

Update docs whenever source roster, benchmark registry, publication gates,
queue payload shape, or methodology-visible behavior changes.

Typical files:

- `docs/yield-intelligence.md`
- `docs/yield-intelligence-timeline.md`
- `docs/status-dashboard.md` and `docs/runbooks/yield-health.md` for status
  surface changes
- `docs/about-page.md` and `src/app/about/content.ts` for new external source
  providers
- `src/app/methodology/sections/monitoring/yield-intelligence-section.tsx`
  for methodology UI copy
- `shared/lib/methodology-versions/yield-methodology.ts`
- `shared/data/methodology-changelogs/yield-methodology/v*.ts`

Yield methodology versions are numeric. Read the current version from
`shared/lib/methodology-versions/yield-methodology.ts` and pick the next
strictly greater numeric value (integer-segment comparison: `8.3` > `8.292`,
so extend the same segment, e.g. `8.292` → `8.293`). Never trust a version
number quoted in a doc or skill — the source file wins.

## Validation

Run focused tests for changed surfaces first, then the broader gates:

```bash
npx vitest run worker/src/cron/__tests__/yield-config-registry.test.ts worker/src/cron/__tests__/yield-coverage-audit.test.ts worker/src/cron/__tests__/yield-helpers.test.ts worker/src/lib/status/__tests__/yield-health.test.ts
npm run check:stablecoin-data
```

If the reviewed changes will be published, use `pharos-release-runner` after
the focused checks. GitHub's required `PR gate` is authoritative; the heavy
local merge gate is optional rehearsal work.

Add `worker/src/cron/__tests__/fetch-tbill-rate.test.ts` when benchmarks change,
and frontend status/methodology tests when public status or UI copy changes.

## Output

End the drain with:

- Snapshot source and date.
- Promotions, grouped by config file.
- Rejections/deferrals with one-line rationale and next review trigger.
- Tests run and their result.
- Any remaining queue health risk.

## Hard Stops

- Do not add manual/on-chain/CMC/DEX supply overrides.
- Do not multiply DefiLlama list-endpoint circulating values by price.
- Do not lower global lending APY/TVL/safety gates to win coverage.
- Do not add broad protocol allowlists outside queue/category-gated evidence.
- Do not scrape unstable product pages when a durable API/source contract is not
  confirmed.

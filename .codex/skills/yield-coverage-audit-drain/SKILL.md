---
name: yield-coverage-audit-drain
description: Drain the Pharos Yield Intelligence coverage-audit queue into reviewed source coverage, documented intentional gaps, or watchlisted deferrals. Use monthly after `yield-coverage-audit` runs, after yield coverage drops, or when promoting queue candidates such as `native-exact-pool`, `lending-allowlist`, `source-family-adapter`, `stale-auto-lending-override`, or `quarantine-ready-to-restore`.
---

Read `docs/editorial-style.md` before writing. Its universal rules and the named `technical-evidence` register govern all Pharos-owned prose; this skill adds only factual, sourcing, schema, and format requirements.

# Yield Coverage Audit Drain

Turn the `yield-coverage-audit` queue into reviewed Yield Intelligence changes.
The queue is a lead: verify live source data,
local identity, safety/publication gates, and current methodology docs.

## Required Context

Read routed yield docs and scoped instructions.
Inspect `worker/src/cron/yield-coverage-audit.ts`, the relevant
resolver/config source under `worker/src/cron/yield-sync/` or
`worker/src/lib/yield-config/`, and `shared/types/status.ts` when the payload
changes. Verified docs own durable policy; `/agents/` is scratch only.

## Queue Snapshot

Prefer a read-only production/cache snapshot. The cache key is
`yield-coverage-audit`; status also exposes a bounded view through
`yieldHealth.coverageAudit`.

Use an already authenticated read-only path, for example:

```bash
npx wrangler d1 execute stablecoin-db --remote --command "select key, value, updated_at from cache where key = 'yield-coverage-audit';"
```

If remote D1 is unavailable, use the latest fixture or prior run output. The
audit runs only from `worker/src/handlers/scheduled/monthly-yield-audit.ts`;
do not mutate production D1.

Record date, `reportedAt`, counts, and whether evidence is production, local,
or fixture-derived.

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
- `unmatched-high-tvl-pool` / `missing-protocol`: a high-TVL stablecoin pool or
  protocol has no local coverage mapping. Decide venue map, allowlist, or
  adapter candidacy. Record a documented intentional gap; do not leave the
  row unaddressed just because it is watch-severity.
- `venue-risk-config-missing`: an active source's venue protocol has no
  reviewed entry in `YIELD_RISK_CONFIG`
  (`shared/lib/yield-source-risk-registry.ts`). Author a reviewed risk entry
  from source evidence; do not guess sub-scores.
- `stale-venue-risk-score`: a `YIELD_RISK_CONFIG` entry's `reviewedAt` has
  exceeded the review cadence. Re-review the venue and refresh the entry
  (sub-scores and `reviewedAt`); do not bump the date without a re-review.
- `manifest-missing` / `ranking-missing`: check whether this is a source gap,
  publication gate, safety gate, stale benchmark, or intentional gap. Do not
  force coverage around a guard without written rationale.

The kind list above mirrors `YieldCoverageAuditQueueItemKind` in
`shared/types/status/yield-liquidity.ts`. The source file wins; triage any
kind not listed here from its emitting code in
`worker/src/cron/yield-coverage-audit.ts`.

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

Update routed docs when the source roster, benchmark registry, publication
gates, queue shape, or methodology-visible behavior changes. New providers
also update `docs/about-page.md`; methodology changes update the owning UI/doc,
`shared/lib/methodology-versions/yield-methodology.ts`, and the structured
`shared/data/methodology-changelogs/yield-methodology/` entry. Read the current
numeric version from source and choose a strictly greater numeric value.

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

If the queue is empty, report source/date and zero counts, then stop; do not
hunt outside the queue. Otherwise report promotions by config, rejections and
deferrals with next trigger, checks, and remaining queue-health risk.

## Hard Stops

- Do not add manual/on-chain/CMC/DEX supply overrides.
- Do not multiply DefiLlama list-endpoint circulating values by price.
- Do not lower global lending APY/TVL/safety gates to win coverage.
- Do not add broad protocol allowlists outside queue/category-gated evidence.
- Do not scrape unstable product pages when a durable API/source contract is not
  confirmed.

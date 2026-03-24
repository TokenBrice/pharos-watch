# Blacklist Attribution Gap Reduction Ranking

Date: 2026-03-24

## Scope

Broad exploration of how to reduce the number of blacklist events for which Pharos does not attribute an amount, with emphasis on EVM coverage and impact-vs-effort ranking.

This note focuses on:

- current production gap shape
- whether the remaining gaps are real coverage failures or stale backlog artifacts
- the highest-return remediation paths

It does **not** revisit the full Tron historical-balance problem in depth; that is covered separately in `agents/research/2026-03-24-tron-blacklist-amount-research.md`.

## Production Snapshot

Source: remote D1 queries run against `stablecoin-db` on 2026-03-24 via `wrangler d1 execute --remote`.

### Overall counts

- total blacklist rows: `15,208`
- resolved: `14,892`
- recoverable gaps (`recoverable_pending`, `provider_failed`, `ambiguous`): `26`
- permanently unavailable: `290`

That means:

- recoverable gap ratio: `0.17%`
- resolved ratio: `97.92%`
- permanently unavailable ratio: `1.91%`

### Critical observation

There are **no recoverable gaps in the last 365 days**.

In the last 90 days:

- `1,012` rows are `resolved`
- `290` rows are `permanently_unavailable`
- `0` rows are recoverable gaps

So the live EVM system is currently performing well. The remaining recoverable problem is a **legacy backlog cohort**, not an active cross-chain coverage failure.

### Where the recoverable gaps are

All `26` recoverable rows are:

- `stablecoin = USDC`
- `chain = Avalanche`
- `event_type = blacklist`
- `amount_status = recoverable_pending`
- timestamp range: `2022-03-29` to `2022-08-06`

Every recoverable row is also missing the newer provenance fields:

- `contract_address IS NULL` for all `26`
- `config_key IS NULL` for all `26`

This strongly indicates a stranded pre-provenance legacy cohort.

### Legitimate zero-balance events are common

A large share of resolved blacklist/unblacklist rows are valid zero-balance outcomes:

- blacklist rows: `6,515` resolved zero vs `4,898` resolved positive
- unblacklist rows: `1,049` resolved zero vs `246` resolved positive

That matters for prioritization: reducing unattributed rows should not mean forcing a positive-value answer where the truthful result is `0`.

## Key Finding

The highest-return path is **not** broad new EVM provider expansion.

The data says the unresolved EVM problem is almost entirely:

1. one legacy Avalanche USDC backlog
2. weak convergence/visibility for old recoverable rows

I manually tested several of those unresolved Avalanche USDC addresses against the public Avalanche C-Chain RPC using historical `eth_call(balanceOf)` at the event-era block, and they now return `0`.

Example result pattern:

- contract: `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` (USDC on Avalanche)
- historical `eth_call` at the unresolved row block returns `0x...0000`

So at least part of the remaining backlog is **already resolvable today** and should probably become `resolved` with `amount_native = 0`, not remain `recoverable_pending`.

## Ranked Findings

## 1. Add a one-time legacy backfill/rebuild pass for pre-provenance rows

Impact: Very high  
Effort: Low

Why it ranks first:

- It should eliminate essentially all current recoverable EVM gaps in production.
- The current unresolved set is only `26` rows and all belong to one legacy cohort.
- Sample validation shows those rows are now historically queryable and likely resolve to `0`.

Recommended action:

- add a targeted admin/backfill path for rows where:
  - `amount_status IN ('recoverable_pending','provider_failed','ambiguous')`
  - `contract_address IS NULL OR config_key IS NULL`
- resolve config from current canonical mapping
- run historical balance fetch again
- persist `contract_address`, `config_key`, `amount_native`, `amount_usd_at_event`, `amount_source`, `amount_status`

Why this should be a dedicated pass instead of hoping the hourly cron converges:

- these rows have remained unresolved despite the current generic backfill loop
- a deterministic remediation job is easier to verify and safer to reason about than passive eventual convergence

Expected return:

- reduce recoverable gap count from `26` to likely `0`
- move recoverable gap ratio from `0.17%` to effectively `0%`

## 2. Make backfill convergence observable and finite

Impact: High  
Effort: Low to medium

Current weakness:

- if a row stays recoverable for a long time, the system does not explain why it keeps missing
- repeated retries do not appear to leave enough operational breadcrumbs
- there is no explicit notion of "attempted N times with current provider stack and still unresolved"

This is why the Avalanche backlog could survive silently.

Recommended action:

- add per-row retry metadata or a side table for attribution attempts:
  - `attempt_count`
  - `last_attempted_at`
  - `last_error_class`
  - `last_provider`
- expose age-of-gap / oldest-gap metrics in status tooling
- alert if recoverable gaps older than a threshold still exist

Expected return:

- prevents another "silent stranded legacy cohort"
- speeds diagnosis when a provider regression happens

## 3. Add an explicit "resolved zero" validation/admin workflow

Impact: Medium-high  
Effort: Low

Why this matters:

- zero is often the correct answer
- many blacklist/unblacklist rows are already resolved to zero across chains
- the operational goal should be "truthful attribution", not "non-zero attribution"

Recommended action:

- add a tiny audit/admin query that highlights recoverable rows likely to resolve to `0`
- after remediation, record them as normal `resolved` rows, not a special degraded state
- optionally add a narrow internal metric:
  - `resolved_zero`
  - `resolved_positive`
  - `recoverable_gap`

Expected return:

- prevents the team from over-prioritizing already-benign zero-balance cohorts
- makes future support decisions more evidence-based, especially for noisy assets like `EURC`

## 4. Harden the EVM balance provider ladder with one more historical RPC option

Impact: Medium  
Effort: Medium

Current provider ladder for non-mainnet EVM:

1. dRPC archive
2. chain registry RPC (Alchemy if configured, then public fallback)
3. Etherscan proxy best-effort

This is already adequate for current production behavior. There is no evidence today of a broad unresolved problem on Arbitrum, Base, Optimism, Polygon, or Avalanche.

Still, a fourth provider can improve resilience against future outages or chain-specific RPC quirks.

Recommendation:

- only add another provider if it supports historical `eth_call` reliably on the target chains
- prioritize it as a fallback for historical balance reads, not log scans
- keep it behind the same bounded retry/budget model

Good candidates are providers that offer broad EVM archive-state support; the exact vendor choice matters less than:

- historical `eth_call` support on L2s
- predictable timeout behavior
- reasonable cost at blacklist cron volume

Why this is not ranked higher:

- current production data does not show a live multi-chain EVM attribution failure
- provider expansion mostly buys resilience, not immediate gap reduction

## 5. Add a periodic "historical gap sweeper" admin task

Impact: Medium  
Effort: Medium

Recommended action:

- add an admin endpoint or manual cron that:
  - scans old recoverable rows in batches
  - retries with the latest provider ladder
  - upgrades rows to `resolved` or records durable failure metadata

This is different from the one-time legacy rebuild:

- the one-time rebuild clears existing backlog
- the sweeper prevents old rows from staying unresolved forever if providers improve later

Expected return:

- useful for long-lived operational hygiene
- lower immediate return than the one-time rebuild because current backlog is tiny

## 6. Re-open `EURC` only with deterministic mirrored-noise classification

Impact: Medium  
Effort: High

This is not primarily a gap-reduction item for current public support, but it matters for future coverage expansion.

Production evidence:

- `EURC` rows in D1 are overwhelmingly zero-balance (`451/451` blacklist+unblacklist rows resolved to zero)

That is consistent with the earlier finding that Circle mirrors actions across USDC and EURC, creating a lot of noise.

Recommendation:

- do not re-enable `EURC` just to increase event count coverage
- only re-enable if we can classify mirrored zero-balance noise deterministically enough to avoid degrading the public tracker

Why it ranks low for this specific objective:

- it does not reduce unresolved EVM amounts today
- it mostly affects product signal quality, not the current attribution gap

## 7. Tron transfer-history reconstruction remains high-impact but heavy

Impact: High  
Effort: High

Outside strict EVM scope, this remains the biggest absolute amount-attribution opportunity:

- `290` rows are still `permanently_unavailable`
- all are Tron USDT blacklist/unblacklist rows

But this should still rank below the legacy Avalanche cleanup for immediate work because:

- it is materially heavier
- the live EVM system is already near-complete
- the remaining Tron problem needs a different reconstruction model, not just a better RPC

## Recommended Execution Order

1. Run a dedicated legacy Avalanche/legacy-provenance remediation backfill.
2. Add gap-age / retry observability so stranded rows cannot hide.
3. Add a lightweight admin gap sweeper for future historical retries.
4. Only then consider adding another EVM historical RPC provider for resilience.
5. Keep `EURC` gated unless mirrored-noise classification becomes robust.
6. Tackle Tron only if the team wants to pay the higher implementation cost for the next step-change in absolute coverage.

## Bottom Line

If the objective is strictly "reduce the amount of blacklist events for which we are not able to fetch balance", the best impact-vs-effort move is simple:

- do **not** start with broad new EVM infrastructure
- clear the `26` stranded Avalanche USDC legacy rows with a dedicated remediation path
- make future backfill failures observable and finite

That is the only change set that is both:

- immediately material to current production recoverable gaps
- cheap compared with provider expansion or Tron reconstruction

The current live EVM attribution system is already close to complete. The remaining work is mostly about **convergence discipline and backlog repair**, not lack of multi-chain EVM reach.

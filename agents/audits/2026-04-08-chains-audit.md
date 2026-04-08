# `/chains` Audit

Date: 2026-04-08

Scope:
- `/chains/` leaderboard and `/chains/[chain]/` profile frontend
- `GET /api/chains`
- shared chain aggregation, normalization, and Chain Health logic
- `snapshot-chain-supply` history pipeline

Validation run:
- `npm test -- --run src/hooks/__tests__/use-chains.test.ts src/hooks/__tests__/use-chains.test.tsx shared/lib/__tests__/chain-circulating.test.ts shared/lib/__tests__/chain-aggregator.test.ts shared/lib/__tests__/chain-health.test.ts worker/src/api/__tests__/chains.test.ts worker/src/cron/__tests__/snapshot-chain-supply.test.ts 'src/app/chains/[chain]/client.test.tsx'`
- `npm run lint`
- `cd worker && npx tsc --noEmit`
- `npm run build`
- `npm run check:doc-sync`

All of the above passed. Several important issues still remain.

## Findings

### 1. High: `snapshot-chain-supply` can persist wrong chain history because it bypasses the canonical chain resolver

Files:
- [worker/src/cron/snapshot-chain-supply.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/snapshot-chain-supply.ts#L33)
- [shared/lib/chain-circulating.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/chain-circulating.ts#L17)
- [shared/lib/chains.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/chains.ts#L166)

What is happening:
- The history writer loops raw `chainCirculating` entries and resolves chains with `CHAIN_ALIASES[rawId] ?? rawId` only.
- The live chain path uses `canonicalizeChainCirculating()` -> `resolveChainId()`, which also handles case-insensitive display-name inputs such as `Ethereum`, `BSC`, and the DefiLlama-specific aliases listed in `CHAIN_ALIASES`.

Why this matters:
- If the cached stablecoin payload uses display-name keys instead of canonical IDs, the live `/api/chains` response can still be correct while `chain_supply_history` silently drops those rows.
- That creates a permanent live-vs-history split. Once written, the bad history needs explicit backfill or repair.

Impact:
- Current frontend chain pages do not yet render history, so this does not break the visible UI today.
- It does make the historical foundation unsafe for any future chain trend chart or downstream analytics that depend on `chain_supply_history`.

Recommendation:
- Replace the raw loop in `snapshot-chain-supply` with `canonicalizeChainCirculating()`.
- Add a regression test that snapshots a cache payload with display-name chain keys.
- Plan a one-time `chain_supply_history` repair/backfill before exposing chain history publicly.

### 2. High: the chain detail page can silently show incomplete or split-brain data

Files:
- [src/hooks/use-chains.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-chains.ts#L40)
- [src/app/chains/[chain]/client.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/chains/[chain]/client.tsx#L666)

What is happening:
- The page hero and health breakdown come from `useChains()` (`/api/chains`).
- Composition, backing breakdown, and the stablecoin table come from `useChainStablecoins()` (`/api/stablecoins`).
- `useChainStablecoins()` drops `error`, `refetch`, and freshness metadata, and the page ignores its `isLoading` / `isError` state entirely.

Why this matters:
- If `/api/stablecoins` fails schema validation, returns an error, or is simply behind `/api/chains`, the page still renders the hero and health score but can show empty or mismatched composition/table sections with no error banner.
- That is a direct reliability problem: the user sees a page that looks valid while only part of its data loaded.

Impact:
- User-facing.
- Hard to notice in testing because the current page test mocks the hook rather than exercising the real query states.

Recommendation:
- Return full query state from `useChainStablecoins()` and gate the page on both queries.
- At minimum, show a dedicated error/stale state when the `/api/stablecoins` branch fails.
- Prefer a single canonical snapshot for the whole route, or explicitly reject mixed-snapshot rendering when `updatedAt` values diverge.

### 3. Medium-High: `citrea` is tracked in stablecoin metadata but missing from the chain registry, so chain analytics drop it entirely

Files:
- [shared/data/stablecoins/usd-minor.json](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json#L9527)
- [shared/lib/chains.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/chains.ts#L10)
- [shared/lib/chain-circulating.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/chain-circulating.ts#L25)
- [shared/lib/chain-aggregator.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/chain-aggregator.ts#L60)

What is happening:
- `ctusd-citrea` declares a deployment on `contracts[].chain = "citrea"`.
- `CHAIN_META` has no `citrea` entry, so `resolveChainId("citrea")` returns `null`.
- Unknown chain keys are dropped during canonicalization, which means they never reach `/api/chains`, the chain detail route set, or the chain history snapshot.

Why this matters:
- Any live Citrea supply is omitted from `globalTotalUsd`, leaderboard rankings, per-chain pages, and chain snapshots.
- The omission is silent: it looks like Citrea simply has no stablecoin activity.

Impact:
- Currently limited to one tracked asset in repo metadata.
- Still a correctness bug in the chain surface, and the same failure mode will recur for the next new chain unless the registry is updated manually.

Recommendation:
- Add `citrea` to `CHAIN_META` with explorer/logo metadata.
- Add a test that every `contracts[].chain` in tracked stablecoin metadata resolves through `CHAIN_META` or a documented alias.

### 4. Medium: `/chains` freshness signalling is internally inconsistent and can under-report stale data

Files:
- [worker/src/api/chains.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/chains.ts#L9)
- [shared/lib/api-freshness.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/api-freshness.ts#L7)
- [src/lib/api.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/api.ts#L236)
- [shared/lib/status-thresholds.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/status-thresholds.ts#L4)

What is happening:
- The worker marks `/api/chains` stale at `600s`.
- The frontend uses `API_FRESHNESS_MAX_AGE_SEC.chains = 900`.
- `apiFetchWithMeta()` classifies `X-Data-Age` with the very loose `FRESHNESS_RATIOS` thresholds (`8x` fresh, `12x` degraded) and only attaches the worker `Warning` header as text, not as a status downgrade.

Why this matters:
- `/api/chains` does not emit body `_meta`, so the page relies on this header path.
- A worker response can already be stale by server rules while the UI still treats it as `fresh`.

Impact:
- Primarily a reliability/observability problem.
- It weakens the value of the stale-data UX on the chain surface.

Recommendation:
- Align `API_FRESHNESS_MAX_AGE_SEC.chains` with the worker’s `600s`, or have `apiFetchWithMeta()` downgrade `meta.status` when `Warning` is present.
- Best option: emit `_meta` directly from `/api/chains` so the UI consumes the authoritative freshness classification.

### 5. Medium: `/api/chains` can combine fresh stablecoin totals with stale safety-score inputs

Files:
- [worker/src/api/chains.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/chains.ts#L22)
- [worker/src/lib/report-card-cache.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/report-card-cache.ts#L24)

What is happening:
- The route always reads the stablecoins cache strictly.
- It reads the report-card cache opportunistically, but without a `maxAgeMs` bound even though the loader supports one.
- The response `updatedAt` is always set from the stablecoins cache timestamp, so the returned freshness does not reflect report-card staleness at all.

Why this matters:
- Chain Health quality is a supply-weighted function of report-card scores.
- When report cards are old, `/api/chains` can present fresh-looking totals and stale health scores in the same payload.

Impact:
- User-visible, but subtler than the missing-data problems above.
- Most likely to matter after report-card methodology changes or cache lag events.

Recommendation:
- Apply a max-age policy to the report-card dependency.
- If the cache is too old, either null out quality/health explicitly or expose a partial-degraded dependency status in the response.

### 6. Low-Medium: the guardrails around the chain surface are allowing drift through

Files:
- [docs/api-reference.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md#L393)
- [shared/lib/chain-health.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/chain-health.ts#L4)
- [src/app/chains/[chain]/client.test.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/chains/[chain]/client.test.tsx#L66)
- [shared/lib/__tests__/chains.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/__tests__/chains.test.ts#L35)

What is happening:
- The public API docs still advertise `healthMethodologyVersion: "1.1"` while runtime is `1.2`.
- `npm run check:doc-sync` passed anyway.
- The main chain profile client test uses outdated fake shapes and `as unknown as ChainSummary`, including invalid `type: "L1"` and a non-existent `healthFactors.environment` field.
- The `chains` shared tests do not actually assert that tracked contract chains are covered by `CHAIN_META`.

Why this matters:
- These are the exact kinds of gaps that let the other issues survive while CI stays green.

Impact:
- Maintainer confidence.
- Future changes to the chain surface are more likely to regress silently.

Recommendation:
- Extend doc-sync to assert the live Chain Health version in `docs/api-reference.md`.
- Replace `as unknown as` chain mocks with typed builders that only allow real `ChainSummary` fields.
- Add a contract-chain coverage invariant for `CHAIN_META`.

## Maintainability Opportunities

- [src/app/chains/[chain]/client.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/chains/[chain]/client.tsx) is a 735-line client hotspot that currently owns data orchestration, hero rendering, health gauges, composition layout, tooltip state, filter state, and the table. It should be split into a route shell plus small presentational components.
- Chain normalization currently exists in multiple forms: the canonical shared helper, the snapshot cron’s hand-rolled alias logic, and the detail-page derivation path. The bug in `snapshot-chain-supply` is a direct result of that duplication. There should be one canonical normalization path.
- `getActiveChainIds()` currently returns the entire `CHAIN_META` key set. That is workable for now, but it means routing, sitemap generation, and SEO crawlability depend on a manually curated registry rather than a validated “tracked or live-active” chain set.

## Bottom Line

The chain surface is close to usable as a base, but it is not yet “reliable by construction”.

The main blockers are:
1. persisted chain history is not normalized through the same resolver as the live API,
2. the detail page can silently render partial data,
3. the chain registry is already missing at least one tracked deployment,
4. freshness and validation guardrails are weaker than they appear from green CI.

If those four issues are fixed, the remaining work is mostly decomposition and guardrail hardening rather than core correctness repair.

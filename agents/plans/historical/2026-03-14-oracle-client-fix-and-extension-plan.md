# Oracle Client Fix + Coverage Extension Plan

Date: 2026-03-14

## Goal

Restore real runtime coverage for the new Pyth and RedStone oracle sources, then expand coverage in a controlled way without weakening price-quality guarantees.

This plan assumes the current audited state:

- Pyth metadata exists for 11 assets, but the client currently returns 0 usable results because Hermes `parsed[].id` is unprefixed while repo feed IDs are stored with `0x`.
- RedStone currently returns 0 usable results because the client expects an array-shaped response while the live API returns an object per symbol. It also uppercases case-sensitive symbols and uses a batch strategy that drops some valid symbols.

## Success criteria

### Functional

- Pyth contributes real prices for all currently mapped assets whose feeds are live.
- RedStone contributes real prices for supported exact-case symbols.
- `fetchPrimaryPrices()` can successfully include both sources in consensus for supported assets.
- Source-health/status reporting no longer treats empty-or-broken oracle responses as healthy fetches.

### Coverage

- Pyth mapped coverage increases beyond the current 11 assets.
- RedStone query coverage increases from the current broken path to the live practical ceiling supported by its API.
- Special feed types are explicitly reviewed before being promoted into consensus.

### Verification

- Unit tests added/updated for both clients.
- Integration tests added/updated for `fetchPrimaryPrices()`.
- `npm run lint`
- `npm test`
- `npm run build`
- `cd worker && npx tsc --noEmit`

## Constraints and principles

- Keep the existing consensus architecture in place; this is not a redesign of the price pipeline.
- Prefer deterministic metadata over ad hoc symbol heuristics.
- Do not treat redemption-rate, NAV, deprecated, or unusual semantic feeds as equivalent to plain spot USD feeds without an explicit review.
- Respect Worker runtime limits and the documented 6-connection per-cron-trigger constraint by keeping oracle fetch internals low-concurrency and consuming response bodies before new batches.

## Phase 0: Baseline and guardrails

### Objective

Lock in the current failure modes with tests before changing behavior.

### Files

- `worker/src/lib/__tests__/pyth.test.ts`
- `worker/src/lib/__tests__/redstone.test.ts`
- `worker/src/cron/__tests__/enrich-prices.test.ts`

### Work

1. Add a Pyth test that uses a live-shaped Hermes response where `parsed[].id` is returned without `0x`.
2. Add a RedStone test that uses the current live `redstone-primary-prod` object-per-symbol response shape.
3. Add a RedStone test for mixed-case symbols such as `USDe` and `crvUSD`.
4. Add an enrich-prices integration test proving that the current bug would prevent Pyth/RedStone from contributing, then update expectations as fixes land.

### Exit gate

- Tests fail for the right reasons before the code changes.

## Phase 1: Fix the Pyth client

### Objective

Make the current 11 mapped feeds actually resolve into `fetchPrimaryPrices()`.

### Files

- `worker/src/lib/pyth.ts`
- `worker/src/lib/__tests__/pyth.test.ts`
- `worker/src/cron/__tests__/enrich-prices.test.ts`

### Work

1. Normalize feed IDs in both directions.
   - Add a small helper inside `pyth.ts` that canonicalizes feed IDs by lowercasing and stripping an optional `0x`.
   - Use that normalization when building `reverseMap`.
   - Use the same normalization when matching `feed.id` from Hermes.
2. Keep the current Hermes endpoint and parsed JSON contract.
   - No endpoint switch is needed; live responses already include `parsed`.
   - Keep the existing `price`, `confidence`, `confidenceBps`, and `publishTime` output shape.
3. Harden parsing just enough for live reality.
   - Keep `parsed` required.
   - Preserve graceful empty-result behavior on missing/invalid feeds.
4. Improve observability.
   - If `feedIds.size > 0` and `results.size === 0`, log a warning with requested count.
   - In `fetchPrimaryPrices()`, only record a successful Pyth outcome if at least one feed was returned, or if no feeds were requested.
5. Add/adjust tests.
   - Unprefixed Hermes IDs map correctly to repo feed IDs.
   - Confidence BPS calculation remains correct.
   - Empty result logs and outcome handling are covered by enrich-prices tests.

### Exit gate

- Running `fetchPythPrices()` against the 11 currently mapped feeds yields non-zero results.

## Phase 2: Fix the RedStone client

### Objective

Make RedStone produce usable prices under the current live API contract.

### Files

- `worker/src/lib/redstone.ts`
- `worker/src/cron/enrich-prices.ts`
- `worker/src/lib/__tests__/redstone.test.ts`
- `worker/src/cron/__tests__/enrich-prices.test.ts`

### Work

1. Update response parsing for the live API.
   - Accept object-per-symbol payloads from `provider=redstone-primary-prod`.
   - Optionally support the older array form as a backward-compatible fallback if trivial to keep.
   - Normalize each symbol entry into one internal `entry` object before computing venue statistics.
2. Stop reusing Coinbase symbol preparation for RedStone.
   - Split the current `coinbaseSymbols` variable in `enrich-prices.ts` into:
     - `coinbaseSymbols`: uppercase, Coinbase-compatible
     - `redstoneSymbols`: exact symbol casing from tracked metadata
   - Read RedStone results back with exact symbols, not `toUpperCase()`.
3. Replace the single giant RedStone request with resilient batching.
   - Use small sequential batches, e.g. 8-12 symbols per request.
   - Parse the response body fully before moving to the next batch.
   - Track which requested symbols were returned.
   - Retry missing symbols individually.
   - Do not use wide concurrency here.
4. Harden outcome handling.
   - If all requests succeed structurally but return zero symbol results, treat that as a failed source outcome.
   - If partial results are returned, treat as success and log coverage counts.
5. Keep the existing venue agreement calculation, but compute it from the normalized entry shape.
6. Add/adjust tests.
   - Object-per-symbol response works.
   - Exact-case symbols (`USDe`, `crvUSD`, `fxUSD`) survive end to end.
   - Missing-in-batch symbols can be recovered by single-symbol fallback.
   - One missing symbol does not erase valid results for the rest of the batch.

### Exit gate

- `fetchRedstonePrices()` returns non-empty results for known live symbols.
- `fetchPrimaryPrices()` can consume RedStone results for exact-case assets.

## Phase 3: Repair source-health semantics

### Objective

Make status and circuit-breaker outcomes reflect whether the source actually contributed usable data.

### Files

- `worker/src/cron/enrich-prices.ts`
- `src/components/status/price-source-health.tsx` (only if display assumptions need adjustment)
- `worker/src/cron/__tests__/enrich-prices.test.ts`

### Work

1. For Pyth and RedStone, separate:
   - transport success
   - parse success
   - usable price count
2. Update `recordOutcome()` usage so “empty usable result” does not count as healthy when prices were requested.
3. Add logging of:
   - requested feed/symbol count
   - returned feed/symbol count
   - fallback retry count for RedStone
4. Review whether the status UI needs copy changes or just better data.

### Exit gate

- A broken parser or zero-result oracle fetch no longer silently inflates source health.

## Phase 4: Extend Pyth coverage

### Objective

Increase mapped `pythFeedId` coverage using only feeds that are appropriate for primary price consensus.

### Files

- `shared/lib/stablecoins.ts`
- `worker/src/lib/__tests__/pyth.test.ts` (only if helper fixtures are expanded)
- `worker/src/cron/__tests__/enrich-prices.test.ts`
- `docs/data-pipeline.md`
- `docs/worker-infrastructure.md`

### Implementation rule

Only add feeds that are acceptable as direct price inputs for consensus unless a coin is explicitly reviewed and documented as using a redemption/NAV semantic feed.

### Wave 1: safe-add Pyth candidates

These are the first candidates to add after the Pyth client fix because they matched live Pyth USD feeds and do not carry the obvious “deprecated”, redemption-rate, or NAV labels in the audit:

- `audd-novatti` / `AUDD`
- `ausd-agora` / `AUSD`
- `bold-liquity` / `BOLD`
- `buck-bucket-protocol` / `BUCK`
- `cash-phantom` / `CASH`
- `eurcv-societe-generale-forge` / `EURCV`
- `feusd-felix` / `FEUSD`
- `frxusd-frax` / `FRXUSD`
- `gusd-gemini` / `GUSD`
- `jupusd-jupiter` / `JUPUSD`
- `mim-abracadabra` / `MIM`
- `msusd-main-street` / `MSUSD`
- `musd-metamask` / `MUSD`
- `paxg-paxos` / `PAXG`
- `rlusd-ripple` / `RLUSD`
- `usd0-usual` / `USD0`
- `usd1-world-liberty-financial` / `USD1`
- `usda-anzens` / `USDA`
- `usdb-blast` / `USDB`
- `usdd-tron-dao-reserve` / `USDD`
- `usdf-astherus` / `USDF`
- `usdg-paxos` / `USDG`
- `usdh-native-markets` / `USDH`
- `usdn-noble` / `USDN`
- `usdp-paxos` / `USDP`
- `usdtb-ethena` / `USDTB`
- `usdy-ondo-finance` / `USDY`
- `xaut-tether` / `XAUT`
- `xsgd-straitsx` / `XSGD`

### Wave 2: manual-review Pyth candidates

Do not wire these until their semantics are explicitly accepted:

- Redemption-rate style: `HONEY`, `USR`, `SUSD`, `USYC`
- NAV-style: `USTB`, `USX`
- Deprecated feeds: `LUSD`, `NECT`, `USDU`

### Work

1. Add `pythFeedId` entries for Wave 1 assets in `shared/lib/stablecoins.ts`.
2. Keep feed IDs exactly as validated from Hermes/registry.
3. Add one or two enrich-prices integration tests using newly added assets outside the original 11.
4. If any Wave 1 asset is a NAV token in repo metadata, verify that consensus selection still behaves correctly with NAV-aware reference logic.

### Exit gate

- Pyth mapped coverage increases by the full Wave 1 set.

## Phase 5: Extend RedStone coverage

### Objective

Use the fixed RedStone client to harvest the maximum practical exact-case coverage from live-supported tracked symbols.

### Files

- `worker/src/cron/enrich-prices.ts`
- `worker/src/lib/redstone.ts`
- `worker/src/cron/__tests__/enrich-prices.test.ts`
- `docs/data-pipeline.md`

### Coverage rule

RedStone has no metadata map today. Coverage depends on exact tracked symbols and request strategy, so the extension work is in fetching strategy, not in `shared/lib/stablecoins.ts`.

### Known practical live set from single-symbol audit

- `ALUSD`
- `CEUR`
- `DAI`
- `DOLA`
- `EURS`
- `FDUSD`
- `FRAX`
- `GHO`
- `GYEN`
- `HONEY`
- `LUSD`
- `MUSD`
- `OUSD`
- `PAXG`
- `PYUSD`
- `SUSD`
- `TUSD`
- `USD1`
- `USDC`
- `USDD`
- `USDH`
- `USDP`
- `USDT`
- `USDe`
- `USDf`
- `USR`
- `XAUT`
- `XSGD`
- `crvUSD`
- `fxUSD`

### Work

1. Deduplicate exact tracked symbols without forcing uppercase.
2. Fetch in small sequential batches.
3. Retry missing symbols individually.
4. Keep a small denylist only if repeated live failures justify it.
   - Initial bias: no denylist; let retry/fallback prove which symbols are persistently unstable.
5. Add coverage-oriented tests for:
   - exact-case assets
   - a symbol that only appears on solo retry
   - mixed alpha case such as `USDf`
6. Optionally add per-run logging of “RedStone requested / returned / recovered by retry”.

### Exit gate

- RedStone practical coverage matches or approaches the audited 30-symbol single-request ceiling.

## Phase 6: Docs update

### Objective

Bring the verified docs back in sync with the actual implementation.

### Files

- `docs/data-pipeline.md`
- `docs/worker-infrastructure.md`

### Work

1. Update the price-source section in `docs/data-pipeline.md` to reflect:
   - Pyth feed-ID normalization
   - RedStone exact-case symbol handling
   - RedStone batch + solo-retry strategy
   - more accurate source-health semantics
2. Update `docs/worker-infrastructure.md` if the operational behavior of the oracle circuits changes materially.
3. Do not update `/about` unless user-facing source copy changes; this work does not introduce new sources.

### Exit gate

- Docs describe the oracle paths that actually ship.

## Phase 7: Verification and release checklist

### Automated verification

1. `npm test -- worker/src/lib/__tests__/pyth.test.ts worker/src/lib/__tests__/redstone.test.ts worker/src/cron/__tests__/enrich-prices.test.ts`
2. `npm test`
3. `npm run lint`
4. `npm run build`
5. `cd worker && npx tsc --noEmit`

### Manual verification

1. Run a one-off local script or `tsx` check to confirm:
   - currently mapped Pyth assets now return prices
   - exact-case RedStone assets now return prices
2. Inspect `/status` locally and confirm source distribution now shows non-zero Pyth/RedStone counts when fixture or live data includes them.
3. Spot-check a few assets in the stablecoin payload:
   - `USDT`, `USDC`, `DAI`
   - `USDe`, `crvUSD`
   - one newly mapped Pyth asset such as `RLUSD` or `USD1`

## Recommended execution order

1. Add baseline failing tests.
2. Fix Pyth client.
3. Fix RedStone client and request strategy.
4. Repair source-health outcome handling.
5. Add Pyth Wave 1 feed IDs.
6. Expand RedStone practical fetch coverage.
7. Update docs.
8. Run full verification.

## Out of scope for this change

- Reweighting the consensus model.
- Replacing RedStone with a different provider.
- Introducing new UI for oracle-level provenance.
- Automatically discovering and mutating `pythFeedId` values at runtime.

## Post-ship follow-up

After the first fix-and-extend release, review production logs for one or two cron cycles and decide whether to:

- promote any manual-review Pyth feeds,
- add a tiny persistent RedStone failure denylist,
- or expose per-source returned-count metrics on `/api/status`.

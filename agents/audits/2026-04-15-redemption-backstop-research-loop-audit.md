# Redemption Backstop Research Loop Audit - 2026-04-15

Scope: `shared/lib/redemption-backstop-configs/*`, `shared/lib/redemption-backstops.ts`, `shared/lib/redemption-backstop-*`, `worker/src/cron/sync-redemption-backstops.ts`, `worker/src/lib/redemption-backstop-*`, `/api/redemption-backstops`, report-card consumption, all live reserve adapter definitions, and every worker reserve adapter.

Success criteria:

- Preserve data accuracy before expanding coverage.
- Increase or protect the share of redemption backstop rows that can safely feed Safety Score.
- Keep implementation changes surgical and aligned with existing route/config patterns.

## Current State

- Configured redemption backstop rows: 147.
- Route families: 81 `offchain-issuer`, 21 `stablecoin-redeem`, 19 `collateral-redeem`, 15 `queue-redeem`, 8 `psm-swap`, 3 `basket-redeem`.
- Live production snapshot checked through `https://pharos.watch/_site-data/redemption-backstops`: 146 resolved, 1 impaired (`usr-resolv`, severe active depeg).
- Low-confidence or heuristic live rows still worth future review: `iusd-infinifi`, `uty-xsy`, `dusd-dtrinity`, `dusd-alto`, `ussd-sonic-labs`, `zarp-zarp`, `cetes-etherfuse`, `yousd-yield-optimizer`, `yusd-aegis`, `cgo-comtech`, `dgld-gold-token-sa`, `usdp-parallel`, `usn-noon`.

## Adapter Review

Adapters already declared for scoring-grade capacity:

- Direct: `asymmetry`, `cap-vault`, `collateral-positions-api`, `gho`, `jupusd`, `liquity-v1`, `liquity-v2-branches`, `openeden-usdo`.
- Proxy: `ethena`, `falcon`, `frax-balance-sheet`, `fx`, `infinifi`, `reservoir`, `sky-makercore`, `superstate-liquidity`.

Adapters already declared fee-only:

- `evm-branch-balances`, `single-asset`.

Adapters reviewed and kept as no-capacity sources for now:

- `abracadabra`, `accountable`, `anzen-usdz`, `btcfi`, `chainlink-nav`, `chainlink-por`, `circle-transparency`, `crvusd`, `curated-validated`, `dola-inverse`, `erc4626-single-asset`, `fdusd-transparency`, `frax`, `lista`, `m0`, `mento`, `re-metrics`, `sgforge-coinvertible`, `tether`, `usd1-bundle-oracle`, `usdai-proof-of-reserves`, `usdd-data-platform`.

Important adapter conclusion: six no-capacity adapters were emitting capacity-like metadata anyway: `accountable`, `dola-inverse`, `m0`, `mento`, `re-metrics`, and `usdd-data-platform`. Because validation treats capacity fields from no-capacity adapters as fatal, this could reject otherwise useful live reserve snapshots. The unsafe fields were removed rather than promoted, because the emitted denominators or route semantics were not yet clean enough for scoring-grade redemption capacity.

## Findings

### P0: Shared config expansion leaked docs across IDs

`expandIds()` assigned the same config object to multiple IDs, and `applyTrackedReviewedDocs()` mutated that object in place. This caused unrelated assets to inherit the first asset's reviewed docs. Confirmed affected groups:

- `a7a5-old-vector`, `gusd-gate`, `usyc-hashnote`
- `zarp-zarp`, `cetes-etherfuse`

Resolution: clone configs in `expandIds()` and add regression coverage for the affected primary docs.

### P0: Unsupported adapter capacity telemetry

No-capacity adapters emitted `immediateRedeemable*` or nested `metadata.redemption.capacity*` fields. This contradicted `LIVE_RESERVE_ADAPTER_DEFINITIONS` and would fail validation before persistence.

Resolution: remove unsupported capacity fields from `accountable`, `dola-inverse`, `m0`, `mento`, `re-metrics`, and `usdd-data-platform`; add adapter-output validation assertions in their tests.

### P1: Live route status was visible but did not fail closed

Live adapters can emit `routeStatus: "paused"` or `"degraded"`. The redemption row copied the status but still retained `score` and `effectiveExitScore` unless the impairment came from a severe active depeg. Report-card Safety Score eligibility was already protected, but the standalone API/detail surface could overstate a currently paused route.

Resolution: non-open live route statuses now mark the row `impaired`, null the score/effective exit score, and drop model confidence.

### P1: Nested telemetry validation could be masked by legacy fields

Validation coalesced legacy flat fields before nested fields, while the reader preferred nested fields. A payload with valid legacy fields and malformed nested fields could pass validation and later be consumed incorrectly.

Resolution: validate legacy and nested capacity, ratio, and fee fields independently.

### P1: Non-issuer documented-bound routes carried issuer-term capacity basis

`documentedBoundSupplyFull()` forced `issuer-term-redemption`, even when reused by basket, collateral, or queue route families.

Resolution: remove the hard-coded basis so `resolveCapacityBasis()` derives the route-family-appropriate basis.

### P2: Public docs drifted from the best-path effective-exit model

The API reference and UI methodology context still mentioned the old `0.55 / 0.45` blend and Safety Score version label.

Resolution: update docs and UI context to the current best-path formula and redemption-backstop methodology version.

### P2: Registry checks missed numeric guardrails

`check:redemption-backstops` validated `supply-ratio` but not reserve-sync fallback ratios or score caps.

Resolution: add fallback-ratio and score-cap checks.

### P2: Completed-run reader trusted incomplete manifests

The reader preferred the latest completed run but did not verify manifest completeness or row count.

Resolution: reject incomplete completed runs and row-count mismatches with `RedemptionBackstopSnapshotUnavailableError`.

## Coverage Candidates Deferred

- `ussd-sonic-labs`: internal metadata and Sonic's public page describe instant redemption, and the coin uses `frax-balance-sheet` proxy telemetry. Deferred because the configured live reserve URL points at the frxUSD balance-sheet API while the USSD proof URL is contract-specific; source mapping needs a tighter contract/API review before scoring-grade capacity promotion.
- `deuro-deuro`: dEURO docs describe StablecoinBridge exits, but current live reserve params lack bridge capacity config. Adding this safely likely needs multi-bridge support and reviewed token pricing for EURC, EURS, VEUR, EUROP, and EURR bridge inventories.
- `frax-frax`: live reserve telemetry exists, but route mechanics for canonical FRAX redemption remain a methodology decision.
- `cusd-celo` / `ceur-celo`: Mento stable-reserve share is useful context, but it is not a supply-relative redemption capacity without a documented holder exit semantics decision.
- `yusd-aegis`, `usn-noon`, `uty-xsy`: Accountable stable buckets may help future coverage, but the current bucket matching is too broad for scoring-grade capacity.

External sources checked for deferred candidates:

- Sonic USSD page: https://www.soniclabs.com/ussd
- dEURO Stablecoin Bridges docs: https://docs.deuro.com/swap.html
- dEURO Reserve docs: https://www.docs.deuro.com/reserve.html

## Post-Implementation Audit

After the first implementation pass, the remaining opportunities are meaningful but not safe enough to implement without further route-specific research. No remaining issue above minor severity is known in the implemented surface. The next loop should start with `ussd-sonic-labs` contract/API mapping or dEURO multi-bridge capacity mapping if coverage expansion remains the priority.

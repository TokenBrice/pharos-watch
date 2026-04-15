# Blacklist Tracker Further Coverage Plan

Date: 2026-04-15

Research source: `agents/research/2026-04-15-blacklist-further-coverage-research.md`

## Objective

Prepare the next coverage-expansion roadmap for the blacklist tracker after first-wave support. After the plan review loop passed, the user approved implementation of the direct EVM wave in this same work session.

The plan is designed so that future implementation can proceed in discrete, reviewable waves with clear methodology boundaries:

- direct EVM freeze/blacklist events,
- EURC mirror suppression,
- non-EVM adapters,
- external compliance lists / role-based restrictions,
- seize-only events.

## Non-Goals

- Do not add new symbols to `BLACKLIST_STABLECOINS` without a dedicated implementation task.
- Do not mix allowlist/KYC revocation with freeze-ledger semantics until methodology wording and data model are explicit.
- Do not use public Solana RPC mint-signature scans as a historical strategy for USDC/USDT-scale assets.

## Success Criteria For A Future Implementation Program

- Each wave has a narrow semantic model and no cross-wave hidden dependency.
- Every newly tracked asset has:
  - verified event/source surface,
  - exact chain contracts,
  - start cursor strategy,
  - amount extraction and USD valuation strategy,
  - current-balance strategy,
  - D1 read/write and upstream request estimate,
  - docs/methodology version plan,
  - focused parser/config tests.
- Non-USD assets never fall through to native-amount-as-USD valuation unless their native unit is actually USD-denominated.
- Non-EVM work defines subject identity before data is written.

## Recommended Wave Order

### Wave 2A — Direct EVM Event Families

Status: implemented after user approval in this work session.

Purpose: add high-readiness token-level events with minimal model change.

Assets:

| Asset | Chains | Event family | Required parser work | Valuation |
| --- | --- | --- | --- | --- |
| FDUSD | Ethereum, BSC, Arbitrum | `Freeze` / `Unfreeze` | none; reuse dual-index address | USD |
| BRZ | Ethereum, Gnosis | `Blacklisted` / `UnBlacklisted` | none | BRL conversion |
| AUSD | Arbitrum, Base | `AccountFrozen` / `AccountUnfrozen` | none | USD |
| EURI | Ethereum, BSC | `Freeze` / `Unfreeze` | none; reuse dual-index address | EUR conversion |
| USDQ | Ethereum | `BlockPlaced` / `BlockReleased` / `DestroyedBlockedFunds` | none; reuse USDT0 | USD |
| USDO | Ethereum, Base | `AccountBanned` / `AccountUnbanned` | none | USD |
| USDX | Ethereum | `AddedBlacklist` / `RemovedBlacklist` | static data address | USD |
| AID | Ethereum | `AddedToDenyList(address[])` / `RemovedFromDenyList(address[])` | reuse dynamic address array | USD |
| tGBP | Ethereum, Avalanche | `Banned` / `UnBanned` | none | GBP conversion |

Implementation notes:

- Add one shared valuation helper for fiat-pegged non-USD symbols before adding BRZ/EURI/tGBP.
- Keep destroy/seize support out unless a dedicated event with amount exists and maps cleanly.
- Use exact deployment/start blocks for all configs.

Validation:

- contract metadata alignment tests,
- parser tests per new family,
- valuation tests for BRZ/EURI/tGBP,
- API enum acceptance tests,
- doc-sync.

Risk:

- Low to medium. Most work is additive; non-USD valuation is the main correctness risk.

### Wave 2B — EURC Re-Enablement

Purpose: restore material Circle EURC coverage without recreating known zero-balance mirror noise.

Design:

- Add EURC configs only with mirror classification.
- Mirror candidate if:
  - same address,
  - USDC event exists within a tight timestamp/block window,
  - EURC event balance is zero/null,
  - USDC event balance is non-zero or known active.
- Preserve event rows with a suppression marker only if schema allows it; otherwise keep EURC out of public enum until schema exists.

Required decision:

- Choose between:
  - schema flag such as `suppression_reason`,
  - separate table for suppression metadata,
  - or ingest filter that drops mirrored zero-value EURC rows.

Recommendation:

- Use schema flag / metadata. Dropping rows loses auditability.

Risk:

- Medium. This changes public semantics more than direct EVM event additions.

### Wave 3 — Solana Adapter

Purpose: cover the largest remaining supply gap.

First targets:

- USDC
- USDT
- USDG
- PYUSD
- USD1
- YLDS

Required architecture:

- source module: `worker/src/cron/blacklist/solana-source.ts`
- cursor: signature or slot cursor, likely a new table rather than overloading block-number semantics
- provider: indexed provider strongly preferred for historical coverage
- events/instructions:
  - SPL Token `FreezeAccount`
  - SPL Token `ThawAccount`
  - Token-2022 freeze/thaw
  - Token-2022 permanent-delegate burns for PYUSD/USDG when issuer delegate burns from token accounts
- identity:
  - store token-account address and owner wallet separately
  - do not squeeze both into current `address` without a schema plan

Minimum viable implementation:

- Start forward-only for selected mints if historical indexed source is unavailable.
- Write exact provenance so public UI can label Solana coverage as forward-from-date until backfilled.

Risk:

- High if attempted with public RPC only.
- Medium with a reliable indexed transaction/instruction source.

### Wave 4 — External Lists, Roles, And Permissioned-Token State

Purpose: cover high-market-cap permissioned assets whose controls are not emitted directly by the token as simple blacklist events.

Targets:

- USDY blocklist + sanctions list contracts.
- USTB allowlist + `AdminBurn`.
- OUSG KYC registry.
- mTBILL/EURAU AccessControl `BLACKLISTED_ROLE`.
- BUIDL Securitize seize events.

Required architecture:

- event-source contract separate from token contract,
- event-source provenance in storage/API,
- optional `restriction_source` or source-family key,
- topic1 filtering for AccessControl role hashes,
- state tables for allowlist/entity/fund permission systems.

Methodology decision:

- Define separate terms:
  - frozen/blacklisted,
  - permission revoked,
  - seized/clawed back,
  - allowlist removed.

Risk:

- High if collapsed into existing `blacklist`/`destroy` semantics.
- Medium if shipped as a new explicit compliance layer.

### Wave 5 — XRPL And Stellar Adapters

Purpose: cover issuer freeze/clawback primitives on chains with explicit regulated-asset models.

XRPL:

- parse trustline freeze/deep-freeze and clawback transactions,
- use issuer + currency as asset identity,
- current balance from trustline data,
- cursor by ledger index + tx hash.

Stellar:

- parse `set_trust_line_flags`, `clawback`, and `clawback_claimable_balance`,
- use asset code + issuer,
- cursor by Horizon paging token,
- current balance from trustline/account balances.

Risk:

- Medium. Semantics are strong, but chain adapters and subject identity are new.

## Cross-Cutting Prerequisites

### Valuation

Before adding non-USD fiat symbols:

- define `BlacklistStablecoin -> price_cache asset_id` or `BlacklistStablecoin -> peg FX reference`.
- prefer price-cache when available because it reflects actual token pricing.
- only use FX fallback when price-cache is unavailable and methodology explicitly allows it.

### Parser Extensions

Add only when needed by a wave:

- `amountTopicIndex?: number` for indexed uint256 amount extraction.
- `eventSourceAddress?: string` and `tokenContractAddress?: string` for external-list events.
- topic filters beyond topic0 for AccessControl roles.
- subject identity fields for non-EVM.

### D1 Read/Write Controls

Before Solana or list-heavy systems:

- decide when `/api/blacklist-summary` should stop scanning all raw rows.
- likely introduce a summary cache or incremental rollup before high-volume address-list systems.

## Review Loop

### Review 1

Severity scale: Critical, High, Medium, Minor.

- Medium: The initial roadmap put Solana first because of supply impact, but it did not explicitly forbid public RPC historical scans. That could lead to an unsafe implementation path for USDC/USDT-scale assets.
- Medium: The direct EVM wave grouped BRZ/EURI/tGBP with USD assets without making non-USD valuation a hard prerequisite.
- Minor: EURC re-enable options did not state a recommended persistence strategy for suppressed mirror rows.
- Minor: Role-based AccessControl surfaces did not call out topic1 role-hash filtering as a cross-cutting parser dependency.
- Minor: The plan did not explicitly prevent seize-only BUIDL/USTB events from being merged into `destroy` without methodology wording.

### Fixes Applied

- Added a non-goal banning public Solana RPC mint-signature scans as the historical strategy.
- Made non-USD valuation a prerequisite for BRZ/EURI/tGBP in Wave 2A.
- Recommended suppression metadata rather than dropping EURC mirror rows.
- Added topic1 role-hash filtering to cross-cutting parser prerequisites.
- Added methodology terms separating frozen/blacklisted, permission revoked, seized/clawed back, and allowlist removed.

### Review 2

Severity scale: Critical, High, Medium, Minor.

- Minor: The plan still lacks exact start blocks for Wave 2A assets. This is acceptable because the plan requires exact start blocks as part of each implementation task and does not propose coding now.

### Fixes Applied

- Strengthened Wave 2A implementation notes to require exact deployment/start blocks for all configs before coding.

### Review 3

Severity scale: Critical, High, Medium, Minor.

- No Minor-or-higher issues remain.

Result: plan is ready for future implementation work.

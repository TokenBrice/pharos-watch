# Non-EVM Blacklist Schema Design Draft

## Problem Statement

The current `blacklist_events` schema assumes EVM-style events: topic hashes, indexed params, block numbers. Solana (SPL Token freeze), Stellar (TrustLine authorize flags), and XRPL (TrustLine freeze) use fundamentally different paradigms that don't map cleanly to the existing columns.

## Option A: Add `source_type` column

Enumerate `evm_event`, `tron_event`, `solana_instruction`, `stellar_flag_change`, `xrpl_trust_freeze`. Make `event_signature`, `event_topic0`, and `block_number` nullable for non-EVM rows. Add a `source_slot` (Solana) or `source_ledger` (Stellar/XRPL) column for chain-specific cursor tracking.

**Pros:** Single table, retains sync-state cursor pattern, no reconciliation needed.
**Cons:** Nullable columns dilute schema guarantees, queries must filter by `source_type`.

## Option B: Parallel `blacklist_state_snapshots` table

Keep `blacklist_events` EVM-only. Add a sibling table for non-event paradigms that stores point-in-time freeze states rather than transition events. Reconcile with `blacklist_current_balances` via periodic snapshot diffing.

**Pros:** Clean schema separation, no migration risk to existing events.
**Cons:** Two tables to query for cross-chain aggregates, duplication of summary logic.

## Recommendation

Option A first (smaller blast radius). The additional nullable columns are minor and the D1 query impact is negligible with a `source_type` index. Fall back to Option B if Solana transfer-replay proves too expensive to fit in the events table.

## Target Coins

- USDT/USDC Solana (SPL Token freeze authority)
- PYUSD Solana, USDG Solana, USDP Solana
- EURC Solana, EURC Stellar
- RLUSD XRPL
- USDC Stellar, USDP Stellar

## Data Sources

- **Solana:** Helius/Triton for SPL Token Program instruction indexing
- **Stellar:** Horizon API `accounts?asset_issuer=...&authorized=false`
- **XRPL:** `ledger_entry` TrustLine queries for freeze flags

## Open Questions

1. Reconciliation with the EVM `active_state` machine for cross-chain entities
2. UX treatment on `/blacklist` for cross-chain freeze aggregates
3. Cron scheduling impact — Solana indexing may require higher frequency

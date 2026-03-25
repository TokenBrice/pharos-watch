# TICKET-003 - Deterministic Adapter Quarantine And Metadata Debt

Priority: P0
Status: Pending

## Goal

Stop counting known-bad deterministic adapters as healthy and close the most damaging metadata gaps.

## Scope

- Quarantine or downgrade `dusd-dtrinity`
- Quarantine or downgrade `reusd-re-protocol`
- Fill `yieldConfig`/contract metadata gaps where required for current production coverage
- Add explicit rationale in config/metadata


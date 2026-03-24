# TICKET-001 - Publish Safety And Degraded Retention

Priority: P0
Status: In progress

## Goal

Prevent the yield cron from pruning or materially mutating current yield state before the next rankings snapshot is validated and publishable.

## Scope

- Reorder write/prune/publish flow in `sync-yield-data`
- Add row-identity-aware degraded retention
- Distinguish destructive cleanup from safe current-row updates
- Add regression coverage for failed cache publication and degraded-input retention

## Acceptance Criteria

- Failed rankings publication does not leave `yield_data` newer than the published cache
- Degraded runs retain prior rows when absence cannot be positively confirmed
- Metadata distinguishes degraded retention from normal success


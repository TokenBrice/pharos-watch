# Yield History Cleanup Restore Drill

Date: 2026-04-22
Scope: local throwaway SQLite rehearsal for `worker/scripts/yield-history-cleanup.ts`
Production mutation: not executed

## Assumption

The follow-up plan's destructive cleanup phase is implemented and rehearsed here, but live production D1 mutation remains an operator-window action and was intentionally not run from this coding session.

## Rehearsal Setup

- Dataset: throwaway SQLite database with 4 rows
- Targeted parent-owned rows:
  - `usde-ethena` -> `source_key = null`
  - `usde-ethena` -> `66985a81-9c51-46ca-9977-42b4fe7bc6df`
  - `usds-sky` -> `d8c4eff5-c8a9-46fc-a888-057c4c668e72`
- Control row kept outside the cleanup target:
  - `susde-ethena` -> `onchain:susde-ethena`

Artifact saved:

- [2026-04-22-yield-history-cleanup-local-artifact.json](/home/ahirice/Documents/git/stablecoin-dashboard/agents/tasks/2026-04-22-yield-history-cleanup-local-artifact.json)

## Command Outputs

### Dry-run inventory

```json
{
  "mode": "sqlite",
  "before": {
    "totalRows": 3,
    "byStablecoin": {
      "usde-ethena": 2,
      "usds-sky": 1
    },
    "byStablecoinSource": {
      "usde-ethena:null": 1,
      "usde-ethena:66985a81-9c51-46ca-9977-42b4fe7bc6df": 1,
      "usds-sky:d8c4eff5-c8a9-46fc-a888-057c4c668e72": 1
    }
  }
}
```

### Execute

```json
{
  "mode": "sqlite",
  "before": {
    "totalRows": 3
  },
  "after": {
    "totalRows": 0
  }
}
```

### Restore

```json
{
  "restored": 3,
  "mode": "sqlite"
}
```

## Result

- Dry-run selected only the targeted parent/source rows.
- Execute removed all 3 targeted rows.
- Restore reinserted all 3 exported rows successfully.
- The non-target child-owned control row was never part of the artifact.

## API-Level Verification

API behavior for the parent/source suppression contract is covered by passing tests:

- `worker/src/api/__tests__/yield-history.test.ts`
  - parent-owned wrapper history filtered in best mode
  - explicit `mode=source&sourceKey=` suppression across all five handoff parents

## Operator Sign-Off Record

- Local rehearsal: complete
- Restore drill: complete
- Production sign-off: pending operator window

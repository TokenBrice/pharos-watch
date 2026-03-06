---
title: "Fix documentation drift and config issues"
agent: "codex"
model: "o4-mini"
reasoning_effort: "medium"
done: false
---

## Goal

Fix 5 findings: stale migration runbook paths, broken cmcs guide cross-reference, missing MAINTENANCE_MODE in env docs, invalid wrangler.toml TOML, and migration file number collision.

## Task

### Step 1: DOC-001 — Fix stale migration runbook paths

In `docs/plans/historical/ticker-issue-migration/execution-handover.md`:

The file references `docs/plans/ticker-issue-migration/...` in command blocks, but the correct path is `docs/plans/historical/ticker-issue-migration/...`.

Find and replace all occurrences:
```
docs/plans/ticker-issue-migration/ → docs/plans/historical/ticker-issue-migration/
```

Use a global find-and-replace within this file. Verify no other files reference the old path.

### Step 2: DOC-002 — Fix broken cross-reference in cmcs guide

The cmcs preparation guide may reference a non-existent path. Search for the file:
- Try `docs/process/cmcs-large-implementation-preparation.md`
- If not found, search for files containing "Reference Implementation" that link to the migration plan

Fix the link to point to `docs/plans/historical/ticker-issue-migration/` (the correct location after the move).

### Step 3: DOC-003 — Add MAINTENANCE_MODE to env table

In `docs/worker-infrastructure.md`, find the environment bindings table (around lines 37-66).

Add a new row:
```markdown
| `MAINTENANCE_MODE` | `string?` | Optional. When set to any truthy value, the worker returns 503 for all non-admin requests. Used as a kill switch. |
```

Place it alphabetically or at the end of the table. Check `worker/src/lib/env.ts` for the exact type definition to match.

### Step 4: SCHEMA-001 — Fix wrangler.toml TOML syntax

In `worker/wrangler.toml`, around line 5-7:

The routes array has a commented-out closing bracket:
```toml
routes = [
  { pattern = "api.pharos.watch", custom_domain = true }
# ]
```

Fix by uncommenting the closing bracket:
```toml
routes = [
  { pattern = "api.pharos.watch", custom_domain = true }
]
```

Verify the TOML is valid after the fix. If the routes array was intentionally commented out (perhaps because custom domains are configured elsewhere), check `wrangler.toml` for other route configuration. If there's a `[env.production]` section or similar with routes, the top-level routes may need to stay commented. In that case, delete the entire malformed block instead:
```toml
# Routes configured via Cloudflare dashboard custom domain
```

### Step 5: SCHEMA-007 — Fix migration number collision

In `worker/migrations/`, there are two files starting with `0046_`:
- `0046_mint_burn_bridge_classification.sql`
- `0046_remove_mint_burn_coin_configs_batch2.sql`

Rename one to use the next available number. Check the highest migration number:
```bash
ls worker/migrations/ | sort | tail -5
```

Then rename the second file (the one that should run after the first) to the next number. For example, if the highest is `0055`, this becomes `0056_remove_mint_burn_coin_configs_batch2.sql`.

**Important:** These migrations have likely already been applied to production. The rename is for codebase hygiene only — it won't affect the production D1 database (D1 tracks applied migrations by content hash, not filename).

## Acceptance Criteria

1. `npm run lint` passes (markdown lint if configured)
2. `cd worker && npx tsc --noEmit` passes (in case wrangler.toml affects type generation)
3. No references to `docs/plans/ticker-issue-migration/` (without `historical/`) remain: `grep -rn "plans/ticker-issue-migration/" docs/`
4. `MAINTENANCE_MODE` appears in the env bindings table in `docs/worker-infrastructure.md`
5. `worker/wrangler.toml` is valid TOML (test with: `python3 -c "import tomllib; tomllib.load(open('worker/wrangler.toml', 'rb'))"` or equivalent)
6. No duplicate migration numbers: `ls worker/migrations/ | sed 's/_.*//' | sort | uniq -d` should be empty

### Pharos-Specific cmcs Rules

- **D1 scale awareness:** For tickets that create admin/batch/retroactive endpoints, specify worst-case data volume in the ticket. Require per-ID batched SQL for tables over 100K rows. Never use UPDATE-with-JOIN across large tables — D1 CPU limits will kill it.
- **Smoke tests must be self-contained:** Any smoke test commands in tickets or execution handovers must include required auth tokens or use public endpoints. Don't assume the reviewer has env vars set.

**Post-merge checklist (Pharos):**
1. Run `npm install` if `package.json` changed
2. Run full build + type-check (`npm run build && cd worker && npx tsc --noEmit`)
3. Run tests (`npm test`)
4. Check for duplicate exports/constants from parallel worktree merges
5. Delete the worktree only after confirming all commits are reachable on main
---
title: "Disable allowLegacy and remove legacy ID support"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Remove all legacy ID acceptance after the 30-day dual-accept period has elapsed and legacy usage is confirmed at zero.

## Task

### Prerequisites (manual verification before running this ticket)
- At least 30 days have elapsed since Phase 3 deploy
- Legacy ID request volume has been at zero for 7+ consecutive days. Verify by checking `[legacy-id]` log entries via `npx wrangler tail --format=json | grep '\[legacy-id\]'` — zero hits for 7 consecutive days.
- All tests, crons, and admin tooling confirmed using canonical IDs
- D1 migration completed and validated

### Code changes

1. **`shared/lib/stablecoin-id-registry.ts`:**
   - Remove the `allowLegacy` option from `resolveStablecoinId()`. The function should only match canonical IDs:
     ```ts
     // Before:
     export function resolveStablecoinId(input: string, opts?: { allowLegacy?: boolean }): ...
     // After:
     export function resolveStablecoinId(input: string): { canonicalId: string } | null
     ```
   - Simplify: remove `REGISTRY_BY_LLAMA_ID` lookups from the resolver (keep the map itself — it's still useful for sync-stablecoins DL remap)

2. **`worker/src/lib/api-utils.ts`:**
   - Update `isValidStablecoinId()` to call resolver without `allowLegacy`
   - Remove any `{ allowLegacy: true }` calls in `parseStablecoinHistoryQuery()`
   - Remove the `[legacy-id]` console.log lines added in Phase 2 (they're no longer needed since legacy IDs are no longer accepted)

3. **`worker/src/router.ts`:**
   - Remove `{ allowLegacy: true }` from route resolution
   - Remove the `[legacy-id]` console.log lines

   **Also check individual API handler files** that may have `[legacy-id]` log lines added in Phase 2: `depeg-events.ts`, `mint-burn-events.ts`, `mint-burn-flows.ts`, `stress-signals.ts`, `feedback.ts`. Remove any `[legacy-id]` logs from these files too.

4. **All API handlers** that call `resolveStablecoinId` with `allowLegacy: true`:
   - Remove the option. Search with: `grep -rn 'allowLegacy[^A]' worker/src/ --include="*.ts"` (the `[^A]` excludes `allowLegacyArray` in `stablecoins-cache.ts` which is unrelated)
   - Also simplify or remove the `resolveOrReject()` helper in `worker/src/lib/api-utils.ts` — this wrapper passes `allowLegacy: true` and logs `[legacy-id]`. After cleanup, it should just call `resolveStablecoinId(id)` without options and remove the log branch.

5. **Frontend:**
   - `src/app/compare/client.tsx`: Remove `{ allowLegacy: true }` from the resolver call. The legacy URL normalization can remain — it will simply return null for legacy IDs, which is fine (old shared URLs will use the `_redirects` rules instead).
   - `src/hooks/use-portfolio.ts`: The `migratePortfolioIds` function uses `{ allowLegacy: true }`. **Preferred:** keep it as a safety net for very old portfolios, but replace the resolver call with a dual-lookup that checks both maps directly:
     ```ts
     const meta = REGISTRY_BY_ID.get(h.coinId) ?? REGISTRY_BY_LLAMA_ID.get(h.coinId);
     const canonicalId = meta?.id;
     ```
     This is necessary because `REGISTRY_BY_LLAMA_ID` alone would miss already-canonical IDs (they're in `REGISTRY_BY_ID`, not `REGISTRY_BY_LLAMA_ID`).

6. **Tests:**
   - Update `shared/lib/__tests__/stablecoin-id-registry.test.ts`: Remove `allowLegacy` test cases, add test that legacy IDs return null without allowLegacy
   - Update any other test files that use `allowLegacy: true` — search with: `grep -rn 'allowLegacy' worker/src/ src/ shared/ --include="*.test.ts"`
   - The Phase 3 test fixture ticket (P3-TF-001) may have introduced additional `allowLegacy` references in worker test files — the grep above will catch them

7. **D1 cleanup** (if applicable):
   - If any D1 migration tracking tables were created, add a migration SQL:
     ```sql
     -- worker/migrations/NNNN_drop_legacy_id_support.sql
     -- Only include if these tables exist
     DROP TABLE IF EXISTS stablecoin_id_map;
     DROP TABLE IF EXISTS stablecoin_id_map_applied;
     ```

8. **`public/_redirects`:**
   - Keep the redirect rules indefinitely (they're free and preserve SEO)

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -rn 'allowLegacy[^A]' worker/src/ shared/lib/ src/ --include="*.ts" --include="*.tsx" | grep -v __tests__ | grep -v node_modules` returns 0 matches (no production code references allowLegacy — the `[^A]` excludes `allowLegacyArray` in stablecoins-cache.ts which is unrelated)
- `grep -rn 'allowLegacy.*true' worker/src/ shared/lib/ src/ --include="*.test.ts" | wc -l` returns 0 (no test files use allowLegacy: true either)
- `grep -rn '\[legacy-id\]' worker/src/ --include="*.ts"` returns 0 matches (log lines removed)
- `grep -c 'allowLegacy' shared/lib/stablecoin-id-registry.ts` returns 0

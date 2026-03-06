---
title: "Fetch stablecoin-detail by llamaId instead of internal id"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Decouple the DefiLlama detail API call from the internal stablecoin ID by fetching via `meta.llamaId`.

## Task

1. **Read `worker/src/api/stablecoin-detail.ts` fully** before making any changes. Understand the existing fetch flow, error handling, `fetchWithRetry` usage, and `encodeURIComponent` patterns. Preserve all existing patterns — do NOT simplify fetch calls.

2. **Find the DefiLlama detail fetch** (looks like `fetchWithRetry(\`${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(id)}\`, ...)`).

   Change ONLY the URL to use `meta.llamaId`:
   ```ts
   const dlId = meta?.llamaId ?? id;
   // Keep existing fetchWithRetry, encodeURIComponent, and error handling intact
   fetchWithRetry(`${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(dlId)}`, ...)
   ```

   The CoinGecko and commodity flows are already handled by TICKET-001's `detailProvider` check — no additional branching needed here. Only the DL fetch URL changes.

3. **Cache key must remain the internal `id`** (not `llamaId`). Verify that cache reads (`db.prepare(...).bind(id)`) and cache writes use `id` (the parameter passed to the handler), not the DL fetch ID.

4. **`worker/src/api/backfill-supply-history.ts` (line ~233):**
   Find the DL detail fetch (uses `meta.id` in the URL). Add a `dlId` variable:
   ```ts
   const dlId = meta.llamaId ?? meta.id;
   ```
   Replace `meta.id` in the fetch URL with `dlId`. Keep existing `encodeURIComponent` and all other code unchanged. Note: this file uses plain `fetch()` (NOT `fetchWithRetry`) — preserve that as-is. All D1 writes must still use `meta.id` (internal canonical ID) — only the DL fetch URL changes.

5. **`worker/src/api/backfill-depegs.ts` (line ~314):**
   Same pattern — find the DL detail fetch and add `dlId`:
   ```ts
   const dlId = meta.llamaId ?? meta.id;
   ```
   Replace `meta.id` in the fetch URL with `dlId`. Note: this file also uses plain `fetch()` (NOT `fetchWithRetry`) — preserve that as-is. All D1 writes (`depeg_events` inserts, deletes) must still use `meta.id`.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -n 'llamaId' worker/src/api/stablecoin-detail.ts` shows the new usage
- `grep 'DEFILLAMA_BASE.*encodeURIComponent(id)' worker/src/api/stablecoin-detail.ts` returns 0 matches (DL fetch uses dlId, not raw id)
- `grep -n 'llamaId' worker/src/api/backfill-supply-history.ts` returns at least 1 match
- `grep -n 'llamaId' worker/src/api/backfill-depegs.ts` returns at least 1 match
- `grep 'DEFILLAMA_BASE.*meta\.id' worker/src/api/backfill-supply-history.ts worker/src/api/backfill-depegs.ts` returns 0 matches (DL fetches must use llamaId, not meta.id)

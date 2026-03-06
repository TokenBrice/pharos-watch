---
title: "Fix small stale ID references in dews, status-dashboard, cemetery-and-compare, scripts"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "low"
done: false
---

## Goal

Fix 4 small stale ID references (1-2 lines each) across 4 documentation files.

## Task

1. **`docs/dews.md`** (line ~176):

   **Before:**
   ```markdown
   **Single coin:** `?stablecoin=1&days=30` — Returns latest + daily history.
   ```

   **After:**
   ```markdown
   **Single coin:** `?stablecoin=usdt-tether&days=30` — Returns latest + daily history.
   ```

2. **`docs/status-dashboard.md`** (line ~166):

   **Before:**
   ```markdown
   - Parameterized routes probe `probePath` values from registry (for example `/api/mint-burn-events?stablecoin=1`) to avoid expected `400` validation responses.
   ```

   **After:**
   ```markdown
   - Parameterized routes probe `probePath` values from registry (for example `/api/mint-burn-events?stablecoin=usdt-tether`) to avoid expected `400` validation responses.
   ```

3. **`docs/cemetery-and-compare.md`** (line ~52):

   **Before:**
   ```markdown
     - numeric stablecoin IDs (primary format)
   ```

   **After:**
   ```markdown
     - canonical ticker-issuer IDs (primary format, e.g. `usdt-tether`)
   ```

4. **`docs/scripts.md`** (line ~41):

   **Before:**
   ```markdown
   - Backfills only configured gold IDs in the script (`gold-xaut`, `gold-paxg`, etc.).
   ```

   **After:**
   ```markdown
   - Backfills only configured gold IDs in the script (`xaut-tether`, `paxg-paxos`, etc.).
   ```

## Acceptance Criteria

- `npm run build` exits 0
- `grep 'stablecoin=1' docs/dews.md` returns 0 matches
- `grep 'stablecoin=1' docs/status-dashboard.md` returns 0 matches
- `grep 'numeric stablecoin IDs' docs/cemetery-and-compare.md` returns 0 matches
- `grep 'gold-xaut\|gold-paxg' docs/scripts.md` returns 0 matches
- `grep -c 'usdt-tether' docs/dews.md` returns >= 1
- `grep -c 'usdt-tether' docs/status-dashboard.md` returns >= 1
- `grep -c 'ticker-issuer' docs/cemetery-and-compare.md` returns >= 1

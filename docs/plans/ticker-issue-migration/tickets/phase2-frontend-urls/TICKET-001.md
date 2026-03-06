---
title: "Replace inline stablecoin URL construction with buildStablecoinUrl"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Prerequisites

- Phase 1 TICKET-003 must be completed first (creates `src/lib/urls.ts` with `buildStablecoinUrl()`)

## Goal

Centralize all stablecoin detail page URL construction to use `buildStablecoinUrl()` from `src/lib/urls.ts`.

## Task

Replace every occurrence of inline `/stablecoin/${...}` page URL construction with `buildStablecoinUrl(id)`. There are ~30 occurrences across ~18 files.

### Import to add in each file:
```ts
import { buildStablecoinUrl } from "@/lib/urls";
```

### Files and replacements:

**Components (10 files):**

1. `src/components/report-card-mini.tsx` (line ~38):
   - `` href={`/stablecoin/${card.id}`} `` → `href={buildStablecoinUrl(card.id)}`

2. `src/components/dews-alert-feed.tsx` (line ~104):
   - `` href={`/stablecoin/${coin.id}`} `` → `href={buildStablecoinUrl(coin.id)}`

3. `src/components/report-card.tsx` (line ~178):
   - `` href={`/stablecoin/${dep.id}`} `` → `href={buildStablecoinUrl(dep.id)}`

4. `src/components/depeg-feed.tsx` (line ~64):
   - `` href={`/stablecoin/${evt.stablecoinId}`} `` → `href={buildStablecoinUrl(evt.stablecoinId)}`

5. `src/components/command-palette.tsx` (line ~126):
   - `` router.push(`/stablecoin/${coin.id}`) `` → `router.push(buildStablecoinUrl(coin.id))`

6. `src/components/market-highlights.tsx` (lines ~87, ~180, ~208):
   - All `` href={`/stablecoin/${...id}`} `` → `href={buildStablecoinUrl(...)}`

7. `src/components/dews-summary.tsx` (line ~566):
   - `` router.push(`/stablecoin/${id}`) `` → `router.push(buildStablecoinUrl(id))`

8. `src/components/stablecoin-table.tsx` (lines ~346, ~348, ~359):
   - All `` router.push(`/stablecoin/${coin.id}`) `` and `` href={`/stablecoin/${coin.id}`} `` → use `buildStablecoinUrl(coin.id)`

9. `src/components/peg-heatmap.tsx` (line ~180):
   - `` href={`/stablecoin/${coin.id}`} `` → `href={buildStablecoinUrl(coin.id)}`

10. `src/components/flow-table.tsx` (line ~231):
    - `` router.push(`/stablecoin/${coin.stablecoinId}`) `` → `router.push(buildStablecoinUrl(coin.stablecoinId))`

**Page clients (4 files):**

11. `src/app/depeg/client.tsx` (line ~112):
    - `` router.push(`/stablecoin/${id}`) `` → `router.push(buildStablecoinUrl(id))`

12. `src/app/liquidity/client.tsx` (line ~114):
    - `` router.push(`/stablecoin/${id}`) `` → `router.push(buildStablecoinUrl(id))`

13. `src/app/yield/client.tsx` (line ~21):
    - `` router.push(`/stablecoin/${id}`) `` → `router.push(buildStablecoinUrl(id))`

14. `src/app/stability-index/client.tsx` (line ~518):
    - `` href={`/stablecoin/${r.id}`} `` → `href={buildStablecoinUrl(r.id)}`

**Pages/SEO (4 files):**

15. `src/app/stablecoin/[id]/page.tsx` (lines ~38, ~43, ~108, ~118, ~127):
    - Lines ~38, ~43, ~108, ~118 are **relative** URLs — use plain `buildStablecoinUrl(id)`:
      ```ts
      // Before: `/stablecoin/${id}/`
      // After:  buildStablecoinUrl(id)
      ```
    - Line ~127 is an **absolute** URL — use domain concatenation:
      ```ts
      // Before: `https://pharos.watch/stablecoin/${id}/`
      // After:  `https://pharos.watch${buildStablecoinUrl(id)}`
      ```
    - The absolute URL pattern applies to all files below (pages 16-18)

16. `src/app/stablecoins/[peg]/page.tsx` (lines ~83, ~103):
    - Same pattern for JSON-LD and Link href

17. `src/app/page.tsx` (line ~16):
    - JSON-LD URL construction

18. `src/app/sitemap.ts` (line ~173):
    - Sitemap URL construction: `` `https://pharos.watch/stablecoin/${coin.id}/` `` → `` `https://pharos.watch${buildStablecoinUrl(coin.id)}` ``

### Verification

After all replacements, run:
```bash
grep -rn '/stablecoin/\${' src/ --include="*.ts" --include="*.tsx" | grep -v __tests__ | grep -v node_modules | grep -v '/api/stablecoin'
```
This should return 0 matches (all inline page URL constructions replaced). The 3 API-path exceptions listed above will still match without the `/api/stablecoin` filter — that's expected.

**Exceptions (API paths — do NOT change):**
- `src/app/compare/client.tsx` line ~258: `/api/stablecoin/${...}`
- `src/hooks/use-prefetch-stablecoin.ts` line ~22: `/api/stablecoin/${encodeURIComponent(coinId)}`
- `src/hooks/use-stablecoins.ts` line ~52: `/api/stablecoin/${encodeURIComponent(id)}`

These are API endpoint paths, NOT page URLs. Do NOT change them.

## Acceptance Criteria

- `npm run build` exits 0
- `npm test` exits 0
- `grep -rn '/stablecoin/\${' src/ --include="*.ts" --include="*.tsx" | grep -v __tests__ | grep -v '/api/stablecoin'` returns 0 matches
- `grep -rn 'buildStablecoinUrl' src/ --include="*.ts" --include="*.tsx" | grep -v __tests__ | wc -l` returns at least 35

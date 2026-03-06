---
title: "Re-key worker config maps with canonical IDs"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Update all hardcoded stablecoin ID keys/values in worker configuration maps to use canonical ticker-issuer IDs.

## Task

Use the mapping table at `./DESIGN-MAPPING-TABLE.ts` (copied to the worktree root by the orchestrator) for all ID translations.

### Config maps to update:

1. **`worker/src/lib/mint-burn-contracts.ts` — `MINT_BURN_CONFIGS`:**
   - Re-key the `stablecoinId` field in each config entry
   - Example: `stablecoinId: "1"` → `stablecoinId: "usdt-tether"`

2. **`worker/src/cron/yield-config.ts` — `YIELD_POOL_MAP` (line ~173):**
   - Re-key from legacy IDs (both numeric like `"23"` and `cg-*` prefixed like `"cg-syrupusdc"`, `"cg-syrupusdt"`, `"cg-yousd"`) to canonical IDs
   - This constant is in `yield-config.ts`, NOT `sync-yield-data.ts`

3. **`worker/src/cron/yield-config.ts` (line ~346) — `AUTO_LENDING_POOL_MAP`:**
   - Same re-keying pattern (this constant is in `yield-config.ts`, NOT `yield-helpers.ts`)

4. **`worker/src/cron/compute-dews.ts` (line ~15) — `BLACKLIST_SYMBOL_TO_IDS`:**
   - Update the ID values (not keys — keys are symbols like "USDC", "USDT")
   - Example: `"USDT": ["1"]` → `"USDT": ["usdt-tether"]`
   - **BUG FIX (3 of 4 entries are wrong):**
     - `USDC: ["5"]` — ID `"5"` is DAI, not USDC (USDC is `"2"`) → fix to `USDC: ["usdc-circle"]`
     - `PAXG: ["49"]` — ID `"49"` does not exist in any stablecoin list; PAXG is `"gold-paxg"` → fix to `PAXG: ["paxg-paxos"]` (use canonical ID from mapping table)
     - `XAUT: ["87"]` — ID `"87"` does not exist in any stablecoin list; XAUT is `"gold-xaut"` → fix to `XAUT: ["xaut-tether"]` (use canonical ID from mapping table)
     - `USDT: ["1"]` — correct → `USDT: ["usdt-tether"]`

5. **`worker/src/lib/bluechip-slugs.ts` — `BLUECHIP_SLUG_MAP`:**
   - This map is `bluechipSlug → pharosId` (e.g., `usdt: "1"`). The **keys** are bluechip slugs and stay unchanged. Update the **values** (Pharos stablecoin IDs) from legacy to canonical:
   - Example: `usdt: "1"` → `usdt: "usdt-tether"`, `dai: "5"` → `dai: "dai-makerdao"` (the bluechip slug keys stay the same — only the ID values change)

6. **`src/lib/mint-burn-timeframes.ts` (line ~18, `SUMMARY_TIMEFRAME_OVERRIDES`):**
   - Re-key from numeric IDs. The USDT override is at line ~20, currently keyed by `"1"` → change to `"usdt-tether"`

7. **`shared/lib/peg-rates.ts` (line ~9, `COMMODITY_MEDIAN_EXCLUDES`):**
   - Update: `new Set(["gold-dgld"])` → `new Set(["dgld-gold-token-sa"])` (per mapping table line 131: `oldId: "gold-dgld", newId: "dgld-gold-token-sa"`)

8. **`worker/src/cron/yield-config.ts` — additional config maps (4 more maps in the same file as items 2-3):**
   - `YIELD_VARIANT_MAP` (line ~22): Record keys are stablecoin IDs (`"146"`, etc.) — re-key all ~22 entries to canonical IDs
   - `ON_CHAIN_RATE_CONFIGS` (line ~278): `stablecoinId: "146"` → canonical ID
   - `PRICE_DERIVED_FALLBACK_IDS` (line ~296): `new Set(["173"])` → canonical ID for BUIDL
   - `AUTO_LENDING_SAFETY_BYPASS_IDS` (line ~363): `new Set(["336"])` → canonical ID for U

9. **`worker/src/router.ts` (lines 64-65) — static route performance shortcuts:**
   - `["/api/stablecoin/1", ({ db, ctx }) => handleStablecoinDetail(db, "1", ctx)]` → change ONLY the handler argument `"1"` to `"usdt-tether"`. **Keep the URL path key `/api/stablecoin/1` unchanged** — this is a backward-compat performance shortcut that catches the most popular endpoint before the dynamic resolver.
   - `["/api/stablecoin-summary/1", ({ db }) => handleStablecoinSummary(db, "1")]` → same: change ONLY the handler argument `"1"` to `"usdt-tether"`, keep the URL path key as-is.
   - **CRITICAL: The `path` keys in `STATIC_ROUTE_HANDLERS` MUST match the `path` values in `ENDPOINT_DEFINITIONS` (`shared/lib/api-endpoints.ts`).** Lines 217-226 of `router.ts` enforce a bidirectional invariant at module load time — a mismatch will crash the worker. If you change the key here, you must change the `path` in api-endpoints.ts too (and vice versa). For this ticket, we keep both as `/api/stablecoin/1` for backward compat.

10. **`shared/lib/api-endpoints.ts` (5 `probePath` entries with hardcoded numeric query params):**
   - **Do NOT change the `path` values** at lines ~48 and ~56 (`"/api/stablecoin/1"` and `"/api/stablecoin-summary/1"`). These must stay as-is to match `router.ts` keys (see item 9 CRITICAL note).
   - Change only the `probePath` query parameter values (5 entries):
   - Line ~134: `"?stablecoin=1"` → `"?stablecoin=usdt-tether"`
   - Line ~143: `"?stablecoin=1"` → `"?stablecoin=usdt-tether"`
   - Line ~184: `"?stablecoin=1"` → `"?stablecoin=usdt-tether"`
   - Line ~193: `"?stablecoin=1"` → `"?stablecoin=usdt-tether"`
   - Line ~226: `"?stablecoin=1"` → `"?stablecoin=usdt-tether"`

11. **`src/components/category-stats.tsx` (line ~41):**
    - `coin.id === "1" || coin.id === "2"` → `coin.id === "usdt-tether" || coin.id === "usdc-circle"`

12. **`worker/src/api/backfill-depegs.ts` (line ~43) — `OTHER_COIN_FX`:**
    - Re-key from legacy numeric IDs to canonical IDs:
      - `"289": "SGD"` → `"xsgd-straitsx": "SGD"` (per mapping table)
      - `"122": "JPY"` → `"gyen-gyen": "JPY"` (per mapping table line 123 — issuer is "gyen", NOT "gmo-trust")
      - `"165": "AUD"` → `"audd-novatti": "AUD"` (per mapping table)

13. **`worker/src/api/backfill-depegs.ts` (line ~431) — `CG_ABOVE_PEG_EXCLUSIONS`:**
    - Update `coinId: "1"` → `coinId: "usdt-tether"`

14. **`worker/src/cron/sync-stablecoins/stages.ts` (lines ~6-9) — `ADDRESS_OVERRIDES`:**
    - Re-key from DL numeric IDs to canonical IDs:
      - `"213"` → `"m-m0"` (M by M0, per mapping table line 19)
      - `"67"` → `"bean-beanstalk"` (Bean, per mapping table line 199 — this entry has `oldId: "67"` with no `dead-` prefix)
    - These keys are DL numeric IDs used to patch missing addresses from the DL response. After Phase 2's remap step, `asset.id` is canonical, so the keys must be canonical too.

15. **`scripts/fetch-logos.ts` (lines ~10-13) — `EXTRA_GECKO_IDS`:**
    - `"tether-gold": "gold-xaut"` → `"tether-gold": "xaut-tether"` (use canonical ID from mapping table)
    - `"pax-gold": "gold-paxg"` → `"pax-gold": "paxg-paxos"` (use canonical ID from mapping table)
    - This is a local-only utility script but should use canonical IDs for consistency.

16. **`src/components/total-mcap-chart.tsx` (lines ~37-40) — `useSupplyHistory` calls:**
    - `useSupplyHistory("1")` → `useSupplyHistory("usdt-tether")`
    - `useSupplyHistory("2")` → `useSupplyHistory("usdc-circle")`
    - `useSupplyHistory("209")` → `useSupplyHistory("usds-sky")`
    - `useSupplyHistory("5")` → `useSupplyHistory("dai-makerdao")`

### Discovery

After applying all the above, run this to find any remaining hardcoded stablecoin IDs:
```bash
# Numeric IDs used as stablecoin identifiers
grep -rn '"1"\|"2"\|"5"\|"11"\|"119"\|"120"' worker/src/ src/ shared/lib/ --include="*.ts" --include="*.tsx" \
  | grep -i 'stablecoin\|coin_id\|coinId\|SLUG_MAP\|POOL_MAP\|CENTRALIZED' \
  | grep -v __tests__ | grep -v node_modules
# Prefix-based IDs
grep -rn '"cg-\|"gold-\|"silver-\|"iron-finance"' worker/src/ src/ shared/lib/ --include="*.ts" --include="*.tsx" \
  | grep -v __tests__ | grep -v node_modules | grep -v stablecoins.ts
```

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep 'stablecoinId: "1"' worker/src/lib/mint-burn-contracts.ts` returns 0 matches
- `grep '"usdt-tether"' worker/src/lib/mint-burn-contracts.ts` returns at least 1 match
- `grep -E '"[0-9]+"|"gold-|"cg-' worker/src/lib/bluechip-slugs.ts` returns 0 matches (all legacy IDs replaced with canonical)
- `grep '"gold-dgld"' shared/lib/peg-rates.ts` returns 0 matches
- `grep '"dgld-gold-token-sa"' shared/lib/peg-rates.ts` returns 1 match (DGLD canonical ID)
- `grep 'stablecoin=1' shared/lib/api-endpoints.ts` returns 0 matches (all probePath query params migrated)
- `grep -c 'stablecoin=usdt-tether' shared/lib/api-endpoints.ts` returns 5 (all probe query params migrated consistently)
- NOTE: `path: "/api/stablecoin/1"` and `path: "/api/stablecoin-summary/1"` in api-endpoints.ts are intentionally KEPT as-is (backward-compat shortcut, must match router.ts keys)
- `grep 'handleStablecoinDetail(db, "1"' worker/src/router.ts` returns 0 matches (handler arguments updated)
- `grep 'handleStablecoinDetail(db, "usdt-tether"' worker/src/router.ts` returns 1 match
- `grep '"146"\|"173"\|"336"' worker/src/cron/yield-config.ts` returns 0 matches (all yield config IDs migrated)
- `grep -cE '^\s*"[0-9]+":' worker/src/cron/yield-config.ts` returns 0 (no numeric string keys remain in any map)
- `grep -c '"cg-' worker/src/cron/yield-config.ts` returns 0 (no cg-prefix keys remain in any map)
- `grep '"1"' src/lib/mint-burn-timeframes.ts` returns 0 matches
- DEWS bug fixes verified (correct IDs, not just "old IDs removed"):
  - `grep 'USDC.*usdc-circle' worker/src/cron/compute-dews.ts` returns 1 match
  - `grep 'PAXG.*paxg-paxos' worker/src/cron/compute-dews.ts` returns 1 match
  - `grep 'XAUT.*xaut-tether' worker/src/cron/compute-dews.ts` returns 1 match
- `grep 'usdt-tether.*usdc-circle' src/components/category-stats.tsx` returns 1 match
- `grep '"289"\|"122"\|"165"' worker/src/api/backfill-depegs.ts` returns 0 matches (OTHER_COIN_FX re-keyed)
- `grep 'coinId: "1"' worker/src/api/backfill-depegs.ts` returns 0 matches (CG_ABOVE_PEG_EXCLUSIONS updated)
- `grep 'usdt-tether' worker/src/api/backfill-depegs.ts` returns at least 1 match
- `grep '"213"\|"67"' worker/src/cron/sync-stablecoins/stages.ts` returns 0 matches (ADDRESS_OVERRIDES re-keyed)
- `grep -E '"[0-9]+"' src/components/total-mcap-chart.tsx` returns 0 matches (useSupplyHistory calls migrated)
- Note: `MAJOR_CENTRALIZED_IDS` in `src/hooks/use-portfolio.ts` is re-keyed in P3-frontend-compat TICKET-001, NOT here (to avoid merge conflicts on the same file)

# Coin ID Disambiguation — Full Migration Plan

**Status:** Planned (Opus session)
**Motivation:** Custom integer IDs for non-DL/non-CG coins (e.g. XMMF = "355") can silently collide with real DefiLlama numeric IDs, causing the supply sync to pull the wrong coin's data. The current implicit "numeric id == llamaId" assumption is fragile and gets worse as we add more coins. Solve it once, forever.

---

## Proposed System

Replace all internal coin IDs with canonical `{ticker}-{issuer}` strings.

**Examples:**
```
usdt-tether
usdc-circle
dai-sky
ustb-superstate
uscc-superstate
mtbill-midas
xmmf-opentrade
usd+-dinari
ousg-ondo
```

**Edge cases to decide before coding:**
- Tickers with special characters: `USD+` → `usd-plus-{issuer}`? or `usdplus-{issuer}`?
- Issuers with spaces/dots: keep simple slugs (`makerdao`, `sky`, `circlelabs` → `circle`)
- Coins that rebrand or change issuer: keep the original canonical ID, document the change
- Commodity tokens: `xaut-tether`, `paxg-paxos`, `kau-kinesis`

---

## New Registry File: `src/lib/coin-registry.ts`

A single source of truth mapping canonical ID → all service references. Replaces the scattered `geckoId` fields in individual stablecoin entries and the implicit llamaId assumption.

```typescript
export type CoinServiceIds = {
  llamaId: string | null;   // DefiLlama numeric ID, or null if not tracked
  geckoId: string | null;   // CoinGecko ID, or null if not listed
  cmcSlug: string | null;   // CoinMarketCap slug, or null
  // extend as needed: rwaxyzId, etc.
};

export const COIN_REGISTRY: Record<string, CoinServiceIds> = {
  "usdt-tether":     { llamaId: "1",   geckoId: "tether",    cmcSlug: "tether" },
  "usdc-circle":     { llamaId: "2",   geckoId: "usd-coin",  cmcSlug: "usd-coin" },
  "ustb-superstate": { llamaId: null,  geckoId: "superstate-short-duration-us-government-securities-fund-ustb", cmcSlug: null },
  "xmmf-opentrade":  { llamaId: null,  geckoId: null,        cmcSlug: null },
  // ...
};
```

Once the registry exists, `geckoId` can be removed from individual stablecoin entries in `stablecoins.ts`.

---

## Migration Scope

### 1. Design decisions (before touching code)
- Finalize canonical ID format and edge case rules
- Decide URL strategy for old numeric routes (redirect map or slug alias)
- Audit full list of current IDs and assign canonical equivalents

### 2. `src/lib/stablecoins.ts`
- Rename all ~144 coin IDs to canonical form
- Remove `geckoId` from entries (moves to registry)

### 3. `data/logos.json`
- Re-key all entries to canonical IDs

### 4. D1 database migrations — the critical path
All tables using `coin_id` as a foreign key need an `UPDATE` migration:
- `supply_history`
- `depeg_events`
- `mint_burn_flows`
- `blacklist`
- `report_card_history`
- `dex_liquidity`
- Any others (audit schema before starting)

**Strategy:** write a migration script that generates `UPDATE {table} SET coin_id = '{new}' WHERE coin_id = '{old}'` for each renamed ID. Dry-run against a cloned DB first. Apply to production last.

### 5. Worker + API
- All worker cron code referencing coin IDs
- Admin/backfill endpoints that take `?stablecoin={id}` params
- API response `id` field changes — breaking change; consider a transition period where both old and new IDs are returned

### 6. Frontend
- Dynamic routes: `app/stablecoin/[id]` — add redirect layer so `/stablecoin/1` → `/stablecoin/usdt-tether`
- Any hardcoded coin IDs in components

---

## Known Current Collision

- **XMMF** (our ID `"355"`) collides with DefiLlama ID `355` (JPYC)
- Effect: XMMF gets JPYC's near-zero DL supply → shows $0 market cap in charts
- Fix: rename XMMF to `xmmf-opentrade` as part of this migration

---

## Execution Order

1. Design + registry file (no DB writes, safe to iterate)
2. `stablecoins.ts` + `logos.json` rename + worker/frontend updates
3. Build passes, tests pass
4. D1 migrations (dry-run → production)
5. Redirect layer for old URLs
6. Remove `geckoId` from stablecoin entries (cleanup pass)

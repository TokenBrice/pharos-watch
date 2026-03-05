# Design: Stablecoin ID Migration to `ticker-issuer` Format

**Date:** 2026-03-05
**Status:** Draft
**Author:** Claude (Orchestrator) + 4 Codex research agents

## 1. Problem

Pharos.watch inherited DefiLlama's numeric stablecoin ID system and extended it with ad-hoc prefixed IDs (`cg-*`, `gold-*`, `silver-*`, `iron-finance`). The result is a fragmented identification scheme:

- Numeric DefiLlama IDs: `"1"` (USDT), `"2"` (USDC), `"119"` (FDUSD)
- CoinGecko-sourced: `"cg-ustb"`, `"cg-jpyc"`, `"cg-eurq"`
- Commodity tokens: `"gold-xaut"`, `"gold-paxg"`, `"silver-kag"`
- Legacy edge cases: `"iron-finance"`

These IDs are meaningless to users, create fragile prefix-based branching in code (`id.startsWith("cg-")`), and cannot be used in human-readable URLs or external references.

## 2. Goal

Replace all internal stablecoin identifiers with a canonical `ticker-issuer` format:

```
usdc-circle    (was "2")
usdt-tether    (was "1")
dai-makerdao   (was "5")
xaut-tether    (was "gold-xaut")
ustb-superstate (was "cg-ustb")
```

This ID becomes the single identifier used in the database, API, URLs, cache keys, and static data.

## 3. Format Specification

### Rules

- **Format:** `{ticker}-{issuer}`, lowercase, hyphen-separated
- **Ticker:** lowercase symbol (e.g., `usdc`, `usdt`, `dai`, `xaut`)
- **Issuer:** lowercase issuer/protocol name, hyphenated for multi-word (e.g., `circle`, `tether`, `makerdao`, `ondo-finance`)
- **Uniqueness:** the `ticker-issuer` pair must be globally unique
- **Character set:** `[a-z0-9]+(-[a-z0-9]+)+` (at least one hyphen required)

### Collision Resolution

Same ticker, different issuers — already resolved:
- `usdf-falcon` (was id=246) vs `usdf-astherus` (was id=219)
- `gusd-gemini` (was id=19) vs `gusd-gate` (was id=306)
- `usdm-moneta` (was id=215) vs `usdm-mega` (was id=342) vs `usdm-mountain-protocol` (dead, was id=132)

### Issuer Attribution

- DAI was issued by MakerDAO → `dai-makerdao` (not Sky)
- USDS is issued by Sky → `usds-sky`
- Algorithmic/protocol coins use the protocol name as issuer (e.g., `gho-aave`, `lusd-liquity`, `crvusd-curve`)
- Multi-product issuers are fine (e.g., Tether: `usdt-tether`, `xaut-tether`, `usat-tether`)

## 4. Current System Architecture

### Tech Stack

- **Frontend:** Next.js 16 App Router, static export to Cloudflare Pages
- **Backend:** Cloudflare Worker with D1 (SQLite) database
- **Data layer:** Raw SQL (no ORM), Zod schemas for validation
- **External APIs:** DefiLlama, CoinGecko, CoinMarketCap, DexScreener, Alchemy, Etherscan

### Current ID Flow

```
DefiLlama API (peggedAssets[].id)
  → sync-stablecoins cron (normalize, enrich)
  → D1 cache table (JSON blob) + time-series tables (stablecoin_id TEXT)
  → Worker API endpoints (/api/stablecoin/:id, ?stablecoin=)
  → Frontend hooks (TanStack Query)
  → URL (/stablecoin/2/)
```

### Master List Location

`shared/lib/stablecoins.ts` — single source of truth for `TRACKED_STABLECOINS: StablecoinMeta[]` (148 entries). Supplemented by `shared/lib/shadow-stablecoins.ts` (2 entries) and `shared/lib/dead-stablecoins.ts` (78 entries).

## 5. Schema Changes

### 5.1 `StablecoinMeta` (shared/types/index.ts)

Add two new fields:

```ts
interface StablecoinMeta {
  id: string;              // CHANGED: now canonical ticker-issuer format
  llamaId?: string;        // NEW: DefiLlama numeric ID for API calls
  detailProvider?: "defillama" | "coingecko" | "commodity"; // NEW: replaces id-prefix heuristics
  geckoId?: string;        // existing, unchanged
  cmcSlug?: string;        // existing, unchanged
  // ...all other existing fields unchanged
}
```

**Why `llamaId`:** DefiLlama's stablecoin detail API (`stablecoins.llama.fi/stablecoin/2`) still requires numeric IDs. Decoupling internal ID from external API IDs is the entire point of this migration.

**Why `detailProvider`:** Currently the codebase uses `id.startsWith("cg-")` to determine detail fetch strategy. This should be an explicit field.

### 5.2 ID Registry (shared/lib/stablecoin-id-registry.ts) — NEW

```ts
export interface StablecoinIdAlias {
  alias: string;     // old/legacy ID accepted temporarily
  id: string;        // canonical ID target
  reason: "legacy-llama" | "manual-alias";
}

// Derived lookup maps (computed from TRACKED_STABLECOINS at import time)
export const REGISTRY_BY_LLAMA_ID: Map<string, StablecoinMeta>;
export const REGISTRY_BY_GECKO_ID: Map<string, StablecoinMeta>;

// Central resolver — single function for all ID normalization
export function resolveStablecoinId(
  input: string,
  opts?: { allowLegacy?: boolean }
): { canonicalId: string; matchedBy: "canonical" | "llama" | "alias" } | null;

export function getLlamaId(canonicalId: string): string | null;
```

### 5.3 Master List Update (shared/lib/stablecoins.ts)

Before:
```ts
usd("1", "Tether", "USDT", "rwa-backed", "centralized", { geckoId: "tether" })
```

After:
```ts
usd("usdt-tether", "Tether", "USDT", "rwa-backed", "centralized", {
  llamaId: "1", geckoId: "tether", detailProvider: "defillama"
})
```

Full mapping table with 228 entries has been drafted in `DESIGN-MAPPING-TABLE.ts` (see supporting artifacts).

## 6. Database Migration

### 6.1 Good News

All `stablecoin_id` columns are already `TEXT` type. No schema DDL changes needed — only data value remapping.

### 6.2 Tables Requiring Migration

**15 tables** with `stablecoin_id`:

| Table | PK includes stablecoin_id? | Migration strategy |
|-------|---------------------------|-------------------|
| `depeg_events` | No | In-place UPDATE |
| `mint_burn_events` | No | In-place UPDATE |
| `depeg_pending` | UNIQUE | INSERT+DELETE |
| `dex_liquidity` | PK | INSERT+DELETE |
| `dex_liquidity_history` | UNIQUE | INSERT+DELETE |
| `dex_prices` | PK | INSERT+DELETE |
| `onchain_supply` | PK (stablecoin_id, chain) | INSERT+DELETE |
| `supply_history` | PK (stablecoin_id, snapshot_date) | INSERT+DELETE |
| `mint_burn_hourly` | PK (stablecoin_id, chain_id, hour_ts) | INSERT+DELETE |
| `yield_data` | PK (stablecoin_id, source_key) | INSERT+DELETE |
| `yield_history` | PK (stablecoin_id, recorded_at) | INSERT+DELETE |
| `stress_signals` | PK (stablecoin_id, computed_at) | INSERT+DELETE |
| `stress_signal_history` | PK (stablecoin_id, snapshot_date) | INSERT+DELETE |
| `safety_grade_history` | PK (stablecoin_id, recorded_at) | INSERT+DELETE |

**Special cases:**
- `blacklist_events.stablecoin` — uses symbols (USDC/USDT/PAXG/XAUT), NOT IDs. No SQL migration needed, but the `BLACKLIST_SYMBOL_TO_IDS` map in code must be updated.
- `cache` table — JSON blobs with embedded IDs. Do NOT attempt JSON string replacement in SQL. Invalidate and let crons rebuild.
- `price_cache` — same as cache: delete and rebuild.

### 6.3 Migration Strategy

Use a staging mapping table approach:

```sql
CREATE TABLE stablecoin_id_map (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL UNIQUE
);
-- Populate with all 228 mappings
```

Then for non-PK tables: `UPDATE ... SET stablecoin_id = (SELECT new_id FROM stablecoin_id_map WHERE old_id = stablecoin_id)`

For PK tables: `INSERT ... SELECT m.new_id, ... FROM table JOIN stablecoin_id_map m ON ... ON CONFLICT DO UPDATE ...; DELETE FROM table WHERE stablecoin_id IN (SELECT old_id FROM stablecoin_id_map);`

Full SQL draft available in `DESIGN-MIGRATION-DRAFT.sql`.

### 6.4 Runbook

1. Disable all cron triggers
2. Snapshot/backup D1
3. Run migration SQL in a transaction
4. Run validation queries (verify 0 old IDs remain)
5. `DELETE FROM cache; DELETE FROM price_cache;`
6. Deploy updated code (new IDs in TRACKED_STABLECOINS, resolver, etc.)
7. Re-enable crons (first sync rebuilds caches)

### 6.5 Rollback

- Primary: D1 backup restore
- Secondary: persist `stablecoin_id_map_applied` table, generate reverse map, re-run migration templates in reverse

## 7. API Changes

### 7.1 Validation

Replace `isValidStablecoinId()` regex:

```ts
// Before
export function isValidStablecoinId(id: string): boolean {
  return /^\d+$/.test(id) || /^(?:gold|silver|cg)-/.test(id);
}

// After
export function isValidStablecoinId(id: string): boolean {
  const resolved = resolveStablecoinId(id, { allowLegacy: LEGACY_ENABLED });
  return resolved !== null;
}
```

### 7.2 Route Matching

No structural changes. `/api/stablecoin/:id` stays the same, values change.

Router resolves to canonical ID before passing to handlers:
```ts
const resolved = resolveStablecoinId(id, { allowLegacy: true });
if (!resolved) return errorResponse(404, "Unknown stablecoin");
return handleStablecoinDetail(db, resolved.canonicalId, ctx);
```

### 7.3 External API Adaptation

**DefiLlama sync (`sync-stablecoins`):** Immediately after parsing `peggedAssets`, remap `asset.id` from DefiLlama numeric to canonical using `REGISTRY_BY_LLAMA_ID`. Unmapped assets are dropped.

**DefiLlama detail (`stablecoin-detail`):** Fetch using `meta.llamaId`, cache using canonical ID:
```ts
const meta = TRACKED_META_BY_ID.get(canonicalId);
if (meta?.detailProvider === "defillama" && meta.llamaId) {
  fetch(`${DEFILLAMA_BASE}/stablecoin/${meta.llamaId}`);
}
```

**Price enrichment (`enrich-prices`):** No algorithm change. All lookups are already by `geckoId`, `cmcSlug`, address, or symbol. Just ensure canonical IDs are used as map keys (guaranteed if remap happens upstream in sync).

**Supplemental assets:** Replace `id.startsWith("cg-")` with `meta.detailProvider === "coingecko"`.

### 7.4 Endpoint Definition Updates

`shared/lib/api-endpoints.ts` probe examples change:
- `/api/stablecoin/1` → `/api/stablecoin/usdt-tether`
- `?stablecoin=1` → `?stablecoin=usdt-tether`

### 7.5 Backward Compatibility

**Recommended: dual-accept period (30 days)**

1. **Phase 1 (deploy):** Accept both canonical and legacy IDs. Resolve to canonical internally. Responses always emit canonical IDs. Add deprecation warning header when legacy ID used.
2. **Phase 2 (monitor):** Log legacy ID usage frequency in worker metrics.
3. **Phase 3 (cutoff):** Disable `allowLegacy`. Return 404 for unresolved IDs. Keep Cloudflare `_redirects` for old URL paths indefinitely.

## 8. Frontend Migration

### 8.1 URL Centralization

Create `src/lib/urls.ts`:
```ts
export function buildStablecoinUrl(id: string): string {
  return `/stablecoin/${encodeURIComponent(id)}/`;
}
```

**18 files** currently inline `/stablecoin/${id}` and should use this utility:
- 10 components: `report-card-mini`, `dews-alert-feed`, `report-card`, `depeg-feed`, `command-palette`, `market-highlights`, `dews-summary`, `stablecoin-table`, `peg-heatmap`, `flow-table`
- 4 page clients: `depeg/client`, `liquidity/client`, `yield/client`, `stability-index/client`
- 4 pages/SEO: `stablecoin/[id]/page`, `stablecoins/[peg]/page`, `page` (homepage), `sitemap`

### 8.2 Route Structure

No changes. `src/app/stablecoin/[id]/page.tsx` stays as-is. `generateStaticParams()` automatically emits new IDs from `TRACKED_STABLECOINS`.

### 8.3 SEO Transition

**Automatic:** Sitemap, canonical URLs, OpenGraph, JSON-LD all derive from `TRACKED_STABLECOINS.id` — they update automatically.

**Old URL redirects:** Generate Cloudflare Pages `_redirects` file during build:
```
/stablecoin/1/ /stablecoin/usdt-tether/ 301
/stablecoin/2/ /stablecoin/usdc-circle/ 301
...
```
This preserves SEO juice and existing bookmarks/links. Compatible with static export.

### 8.4 Cache Key Migration

TanStack Query keys (`["stablecoin-detail", id]`, etc.) — keys naturally namespace by ID value. New IDs create fresh cache entries. No explicit migration needed; old entries expire.

### 8.5 localStorage Migration

`pharos:portfolio` stores `[{ coinId: string, amount: number }]`. On first read after migration:
1. Map legacy `coinId` values to canonical IDs
2. Drop unknown IDs
3. Write back migrated payload

### 8.6 Compare & Portfolio URLs

- **Compare** (`?coins=`): Accept both old numeric IDs and new IDs during transition. Always write back canonical IDs.
- **Portfolio** (`?p=symbol:amount`): Uses symbols, NOT IDs. No URL format change needed. Only internal `coinId` storage migrates.

### 8.7 Component Update Inventory

| Priority | Count | Description |
|----------|-------|-------------|
| High | 18 | URL constructors (Link href, router.push, canonical/sitemap) |
| Medium | 11 | ID-keyed maps, overrides, cache composition, hardcoded ID checks |
| Low | 4 | Test files with hardcoded IDs |
| **Total** | **33** | frontend files |

### 8.8 Worker Config Updates

- `MINT_BURN_CONFIGS` — re-key `stablecoinId` values
- `YIELD_POOL_MAP` — re-key from numeric IDs
- `AUTO_LENDING_POOL_MAP` — re-key
- `BLACKLIST_SYMBOL_TO_IDS` — update ID values
- `BLUECHIP_SLUG_MAP` — update ID values
- `SUMMARY_TIMEFRAME_OVERRIDES` — re-key
- `MAJOR_CENTRALIZED_IDS` — update set values

## 9. Static Data Migration

- `data/logos.json` — re-key (e.g., `"1"` → `"usdt-tether"`)
- `data/ai-summaries.json` — re-key
- Logo filenames in `public/logos/` — optionally rename for consistency (e.g., `1-usdt.svg` → `usdt-tether.svg`)

## 10. Test Impact

~30 test files contain hardcoded stablecoin IDs. These span:
- Worker API handler tests (`worker/src/api/__tests__/`)
- Worker cron tests (`worker/src/cron/__tests__/`)
- Worker lib tests (`worker/src/lib/__tests__/`)
- Frontend hook and lib tests (`src/hooks/__tests__/`, `src/lib/__tests__/`)
- Test fixtures (`worker/src/api/__tests__/helpers/fixtures.ts`)

All need ID values updated to canonical format.

## 11. Implementation Phases

### Phase 1: Foundation (no user-visible changes)
1. Add `llamaId` and `detailProvider` to `StablecoinMeta`
2. Create `stablecoin-id-registry.ts` with `resolveStablecoinId()`
3. Create `src/lib/urls.ts` with `buildStablecoinUrl()`
4. Add `llamaId` to all entries in `TRACKED_STABLECOINS` (keep old IDs for now)
5. Update tests for registry

### Phase 2: Code migration (still using old IDs)
6. Replace all `id.startsWith("cg-")` / `id.startsWith("gold-")` with `detailProvider` checks
7. Replace all inline `/stablecoin/${id}` with `buildStablecoinUrl(id)`
8. Update `isValidStablecoinId()` to use resolver (with `allowLegacy: true`)
9. Update worker cron to remap DefiLlama IDs via registry
10. Update `stablecoin-detail` to fetch by `llamaId`

### Phase 3: ID switchover
11. Switch all `id` values in `TRACKED_STABLECOINS` to canonical format
12. Run D1 migration SQL
13. Re-key static data files (`logos.json`, `ai-summaries.json`)
14. Re-key worker config maps
15. Update all test fixtures
16. Deploy with `allowLegacy: true`
17. Generate `_redirects` for old URLs

### Phase 4: Cleanup (30 days later)
18. Disable `allowLegacy`
19. Remove legacy alias table
20. Remove `stablecoin_id_map` from D1

## 12. Supporting Artifacts

These files were produced by Codex agents and are available in the research worktrees:

| Artifact | Location | Description |
|----------|----------|-------------|
| `DESIGN-MAPPING-TABLE.ts` | `worktrees/stablecoin-dashboard--research-id-system/` | 228-entry mapping (tracked + shadow + dead) |
| `DESIGN-MIGRATION-DRAFT.sql` | `worktrees/stablecoin-dashboard--research-db-schema/` | Full D1 migration SQL with validation queries |
| `DESIGN-API-TRANSITION.md` | `worktrees/stablecoin-dashboard--research-api-routes/` | API route + external service transition plan |
| `DESIGN-FRONTEND-MIGRATION.md` | `worktrees/stablecoin-dashboard--research-frontend-urls/` | Frontend component inventory + SEO plan |
| 4x `RESEARCH-REPORT.md` | All worktrees | Raw codebase analysis (~3,500 lines total) |

## 13. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| DefiLlama changes numeric IDs | Broken data sync | `llamaId` field decouples; mapping table absorbs changes |
| Duplicate `newId` collision | Data corruption | Uniqueness verified at build time + DB UNIQUE constraint |
| localStorage portfolio data loss | User frustration | Migration-on-read logic preserves existing portfolios |
| SEO ranking loss for old URLs | Traffic drop | 301 redirects via `_redirects` preserve link equity |
| Missed hardcoded ID in codebase | Runtime error | Grep-based audit + `allowLegacy` transition period catches stragglers |
| D1 migration failure mid-way | Partial data state | Backup + transaction + validation queries + rollback strategy |

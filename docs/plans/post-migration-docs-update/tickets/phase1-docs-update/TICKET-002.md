---
title: "Rewrite adding-a-stablecoin.md for ticker-issuer IDs"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Rewrite the ID-related sections of `docs/process/adding-a-stablecoin.md` to reflect the canonical `ticker-issuer` ID format. The old process described choosing between numeric DefiLlama IDs, `cg-{geckoId}` IDs, and arbitrary integers. The new process uses `ticker-issuer` for all coins.

## Task

1. **Phase 1 — Determine the ID** (lines 22-35):

   Replace the entire section with:

   ```markdown
   ## Phase 1 — Determine the ID

   The `id` field uses canonical `ticker-issuer` format: lowercase ticker hyphenated with the issuer/protocol name.

   **Format:** `{ticker}-{issuer}` — e.g. `usdt-tether`, `ousg-ondo-finance`, `paxg-paxos`

   **Rules:**
   - Lowercase, hyphen-separated: `[a-z0-9]+(-[a-z0-9]+)+`
   - Multi-word issuers use hyphens: `ondo-finance`, `world-liberty-financial`
   - The `ticker-issuer` pair must be globally unique
   - Same ticker, different issuers is fine: `gusd-gemini` vs `gusd-gate`

   **Data source fields (separate from ID):**
   - If the coin is in DefiLlama's stablecoins API, set `llamaId` to its numeric DL ID (find via `GET https://stablecoins.llama.fi/stablecoins`)
   - If the coin is on CoinGecko, set `geckoId` (find via `GET https://api.coingecko.com/api/v3/search?query={symbol}`)
   - Set `detailProvider` to `"defillama"` (default), `"coingecko"` (CG-only coins), or `"commodity"` (gold/silver tokens)
   ```

2. **Phase 3 — Example entry** (lines 113-139):

   Update the example. Change:
   ```typescript
   usd("cg-example", "Acme Stablecoin", "AUSD", "rwa-backed", "centralized", {
     geckoId: "acme-usd",
   ```
   To:
   ```typescript
   usd("ausd-acme", "Acme Stablecoin", "AUSD", "rwa-backed", "centralized", {
     llamaId: "999", detailProvider: "defillama", geckoId: "acme-usd",
   ```

3. **Phase 4 — Add the logo** (starts at line ~143):

   Replace the file naming convention table:

   **Before:**
   ```markdown
   | ID type | File name convention | Example |
   |---------|----------------------|---------|
   | Numeric DL ID | `{id}-{symbol-lowercase}.{ext}` | `129-usdy.png` |
   | `cg-` prefix | `{id}.{ext}` | `cg-ousg.png` |
   | Custom string ID | `{id}.{ext}` | `gold-vro.png` |
   ```

   **After:**
   ```markdown
   | File name convention | Example |
   |----------------------|---------|
   | `{id}.{ext}` | `usdy-ondo-finance.png` |
   | `{id}.{ext}` | `ousg-ondo-finance.png` |
   ```

   Update the `logos.json` example:

   **Before:**
   ```json
   "129": "/logos/129-usdy.png",
   "cg-ousg": "/logos/cg-ousg.png",
   ```

   **After:**
   ```json
   "usdy-ondo-finance": "/logos/usdy-ondo-finance.png",
   "ousg-ondo-finance": "/logos/ousg-ondo-finance.png",
   ```

   Replace the file sorting instruction:
   - **Before:** `Keep the file sorted by key (numeric IDs first in insertion order, `cg-` and custom string IDs at the end) — this matches the existing file layout.`
   - **After:** `Keep the file sorted alphabetically by key.`

4. **Phase 7 — Backfill supply history** (starts at line ~200):

   Replace the endpoint table:

   **Before:**
   ```markdown
   | ID type | Endpoint | What it does |
   |---------|----------|-------------|
   | Numeric DL ID (e.g. `"129"`) | `POST /api/backfill-supply-history?stablecoin={id}` | Reads full DL history via `/stablecoin/{id}` |
   | `cg-` prefix (e.g. `"cg-ousg"`) | `POST /api/backfill-cg-prices?stablecoin={id}` | Reads CoinGecko `market_chart` (prices + market caps) and inserts rows |
   | Custom integer with no geckoId (e.g. `"355"`) | None — no historical data available | Chart will stay empty; document this in the coin's notes |
   ```

   **After:**
   ```markdown
   | Condition | Endpoint | What it does |
   |-----------|----------|-------------|
   | Coin has `llamaId` (DL-tracked) | `POST /api/backfill-supply-history?stablecoin={id}` | Reads full DL history via `/stablecoin/{llamaId}` |
   | Coin has `geckoId` but no `llamaId` | `POST /api/backfill-cg-prices?stablecoin={id}` | Reads CoinGecko `market_chart` (prices + market caps) and inserts rows |
   | Neither | None — no historical data available | Chart will stay empty; document this in the coin's notes |
   ```

   Update the curl examples:

   **Before:**
   ```bash
   # For a DL-tracked coin (numeric ID):
   curl -X POST "https://api.pharos.watch/api/backfill-supply-history?stablecoin=129" \
     -H "X-Admin-Key: $ADMIN_KEY"

   # For a CoinGecko-only coin (cg- prefix):
   curl -X POST "https://api.pharos.watch/api/backfill-cg-prices?stablecoin=cg-ousg" \
     -H "X-Admin-Key: $ADMIN_KEY"
   ```

   **After:**
   ```bash
   # For a DL-tracked coin:
   curl -X POST "https://api.pharos.watch/api/backfill-supply-history?stablecoin=usdy-ondo-finance" \
     -H "X-Admin-Key: $ADMIN_KEY"

   # For a CoinGecko-only coin:
   curl -X POST "https://api.pharos.watch/api/backfill-cg-prices?stablecoin=ousg-ondo-finance" \
     -H "X-Admin-Key: $ADMIN_KEY"
   ```

   Update the response example:
   - **Before:** `"coinDetails": [{ "id": "cg-ousg", "symbol": "OUSG", ...`
   - **After:** `"coinDetails": [{ "id": "ousg-ondo-finance", "symbol": "OUSG", ...`

   Update the `cg-` caveat line:
   - **Before:** `... so it is safe to run on any coin with a `geckoId` — not just `cg-` coins.`
   - **After:** `... so it is safe to run on any coin with a `geckoId`.`

5. **Quick-reference: ID decision tree** (near end of file):

   Replace:
   ```
   Does stablecoins.llama.fi/stablecoins list it?
     └─ Yes → use the numeric DefiLlama ID  (e.g. "129")
     └─ No  → Is it on CoinGecko?
               └─ Yes → use cg-{geckoId}  (e.g. "cg-ousg")
               └─ No  → use next integer after current max  (check tail of TRACKED_STABLECOINS)
   ```

   With:
   ```
   1. Choose ticker-issuer ID:  {ticker}-{issuer}  (e.g. "usdy-ondo-finance")
   2. Set data source fields:
      └─ In DefiLlama stablecoins API? → set llamaId + detailProvider: "defillama"
      └─ CoinGecko only?              → set geckoId + detailProvider: "coingecko"
      └─ Gold/silver token?            → set geckoId + detailProvider: "commodity"
   ```

## Acceptance Criteria

- `npm run build` exits 0
- `grep -c 'cg-ousg\|cg-example\|cg-{geckoId}' docs/process/adding-a-stablecoin.md` returns 0
- `grep -c '"129"\|"355"' docs/process/adding-a-stablecoin.md` returns 0
- `grep -c 'Numeric DL ID\|numeric DefiLlama ID\|numeric DL ID' docs/process/adding-a-stablecoin.md` returns 0
- `grep -c 'ticker-issuer' docs/process/adding-a-stablecoin.md` returns >= 2
- `grep -c 'ausd-acme' docs/process/adding-a-stablecoin.md` returns >= 1

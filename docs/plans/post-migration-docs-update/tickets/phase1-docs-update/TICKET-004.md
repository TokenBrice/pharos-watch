---
title: "Update classification.md + supply-snapshot.md ID descriptions"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "low"
done: false
---

## Goal

Fix stale ID-system descriptions in `docs/classification.md` and `docs/supply-snapshot.md`.

## Task

1. **`docs/classification.md`** (line ~74, "Commodity & Non-DefiLlama Stablecoins" section):

   Replace line 74:

   **Before:**
   ```markdown
   Gold, silver, and some fiat stablecoins are not in DefiLlama's stablecoin API. These are identified by their `geckoId` and/or `protocolSlug` fields in `StablecoinMeta` (in `shared/lib/stablecoins.ts`), and use synthetic IDs (e.g., `gold-xaut`, `silver-kag`, `cg-jpyc`).
   ```

   **After:**
   ```markdown
   Gold, silver, and some fiat stablecoins are not in DefiLlama's stablecoin API. These use the same canonical `ticker-issuer` ID format as all other stablecoins (e.g., `xaut-tether`, `kag-kinesis`, `jpyc-jpyc`) and are distinguished by their `detailProvider` field (`"commodity"` or `"coingecko"`) and `geckoId`/`protocolSlug` fields in `StablecoinMeta`.
   ```

2. **`docs/supply-snapshot.md`** (line ~62, schema table):

   Replace the `stablecoin_id` description:

   **Before:**
   ```markdown
   | `stablecoin_id` | TEXT | DefiLlama numeric ID (stored as string) |
   ```

   **After:**
   ```markdown
   | `stablecoin_id` | TEXT | Canonical ticker-issuer ID (e.g. `usdt-tether`) |
   ```

## Acceptance Criteria

- `npm run build` exits 0
- `grep 'gold-xaut\|silver-kag\|cg-jpyc\|synthetic IDs' docs/classification.md` returns 0 matches
- `grep 'DefiLlama numeric ID' docs/supply-snapshot.md` returns 0 matches
- `grep -c 'ticker-issuer' docs/classification.md` returns >= 1
- `grep -c 'ticker-issuer' docs/supply-snapshot.md` returns >= 1

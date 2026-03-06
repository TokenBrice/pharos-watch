---
title: "Update api-reference.md ID format section"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "low"
done: false
---

## Goal

Replace the stale stablecoin ID format table and example in `docs/api-reference.md` with canonical `ticker-issuer` format documentation.

## Task

1. **`docs/api-reference.md`** (lines 11-25, "Stablecoin IDs" section):

   Replace the current ID format table (lines 17-24):

   **Before:**
   ```markdown
   Canonical IDs currently appear in these forms:

   | Form | Example | Source |
   |------|---------|--------|
   | Numeric string | `"1"` (USDT), `"122"` (GYEN) | DefiLlama numeric ID |
   | `gold-*` prefix | `"gold-paxg"` | Commodity (gold) token |
   | `silver-*` prefix | `"silver-kag"` | Commodity (silver) token |
   | `cg-*` prefix | `"cg-xyz"` | CoinGecko-only token |
   ```

   **After:**
   ```markdown
   Canonical IDs use `ticker-issuer` format — lowercase ticker symbol hyphenated with the issuer/protocol name:

   | Example | Asset |
   |---------|-------|
   | `"usdt-tether"` | Tether (USDT) |
   | `"usdc-circle"` | USD Coin (USDC) |
   | `"paxg-paxos"` | PAX Gold (PAXG) |
   | `"ustb-superstate"` | Superstate USTB |
   | `"gyen-gyen"` | GYEN |

   The full list is in `shared/lib/stablecoins.ts`. The ID registry (`shared/lib/stablecoin-id-registry.ts`) resolves canonical IDs and legacy aliases.
   ```

   Also update lines 13-15. Replace:
   ```markdown
   Most endpoints use the Pharos stablecoin ID. IDs are resolved through the shared stablecoin-ID registry, so handlers always execute with canonical IDs even if a legacy alias is submitted.

   During migration windows, API endpoints may temporarily accept both canonical IDs and legacy aliases (`allowLegacy: true` in resolver calls). Unknown IDs return `404`.
   ```
   With:
   ```markdown
   Most endpoints use the Pharos stablecoin ID in `ticker-issuer` format (e.g. `usdt-tether`). IDs are resolved through the shared stablecoin-ID registry (`shared/lib/stablecoin-id-registry.ts`). Unknown IDs return `404`.
   ```

2. **`docs/api-reference.md`** (line ~1388, feedback endpoint example):

   Change `"pageUrl": "/stablecoin/1"` to `"pageUrl": "/stablecoin/usdt-tether"`.

## Acceptance Criteria

- `npm run build` exits 0
- `grep -c 'ticker-issuer' docs/api-reference.md` returns >= 1
- `grep -c 'usdt-tether' docs/api-reference.md` returns >= 1
- `grep '"gold-paxg"\|"silver-kag"\|"cg-xyz"\|Numeric string' docs/api-reference.md` returns 0 matches
- `grep '"/stablecoin/1"' docs/api-reference.md` returns 0 matches

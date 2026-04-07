# Sky/MakerCore Reserve Adapter v2 — Block Analitica Module-Level

**Date:** 2026-04-05
**Scope:** Rewrite `sky-makercore` adapter to use Block Analitica groups API
**Coins affected:** `usds-sky`, `dai-makerdao`

## Problem

The current adapter fetches from `api.llama.fi/protocol/makerdao` and parses `tokensInUsd` for a token-level breakdown. DefiLlama has changed how it tracks Sky Lending — the latest `tokensInUsd` entry only contains SKY governance token ($691M), not the full collateral picture. Our reserve composition shows two stale slices (73.7% USDC via PSM, 25.9% ETH/liquid staking) that don't reflect the actual ~$12.8B multi-module structure.

## Solution

Switch the primary data source to the Block Analitica API at `info-sky.blockanalitica.com`, which powers the official Sky dashboard at info.sky.money. This API provides module-level debt and collateral data for all 7 Sky allocation modules.

### API Endpoint

```
GET https://info-sky.blockanalitica.com/groups/?days_ago=1&order=-debt
```

Returns paginated results with this shape per module:

```json
{
  "group": "stablecoins",
  "group_name": "Stablecoins",
  "debt": "4848053264.736991...",
  "collateral": "4848920495.923905...",
  "collateral_ratio": "1.00017...",
  "datetime": "2026-04-05T17:33:24.053849",
  "date": "2026-04-05"
}
```

### Module-to-Slice Mapping

| `group` key | Slice name | Risk | coinId | depType | Rationale |
|-------------|-----------|------|--------|---------|-----------|
| `stablecoins` | Stablecoins (PSM) | very-low | usdc-circle | mechanism | 100% USDC backing via PSM |
| `spark` | Spark (lending) | low | — | — | Diversified lending collateral (ETH, stablecoins) |
| `grove` | Grove (RWA) | low | — | — | Tokenized RWAs (BUIDL, JTRSY, JAAA) |
| `obex` | Obex | medium | — | — | Less transparent allocation module |
| `core` | Core (crypto vaults) | medium | — | — | Traditional CDP vaults, crypto collateral |
| `staked` | Staking Engine | high | — | — | SKY token collateral, governance risk |
| `legacy-rwa` | Legacy RWA | low | — | — | Legacy real-world assets, winding down |

Slice values use each module's `debt` field — this represents how much USDS each module has minted, i.e., how much of the stablecoin supply each module backs.

### Metadata

- `totalCollateralUsd`: sum of all modules' `collateral` values
- `immediateRedeemableUsd`: the `stablecoins` module's `collateral` (PSM USDC balance)
- `snapshotDate`: parsed from `datetime` field of the first result
- Freshness: `verifiedFreshnessMetadata` (Block Analitica provides timestamps)
- `unknownExposurePct`: computed from any unrecognized `group` keys

### Unknown Module Handling

Any `group` key not in the known mapping is bucketed into an "Other modules" slice with `high` risk. Each unknown group emits an `unknown-asset` warning with the group key, so we get alerted to new Sky modules.

## Files Changed

1. **`worker/src/cron/reserve-adapters/sky-makercore.ts`** — Full rewrite: new response type, module mapping, debt-based slice computation
2. **`shared/data/stablecoins/usd-major.json`** — Update `inputs.primary.url` for both `usds-sky` and `dai-makerdao`; update static fallback `reserves` arrays to match current module proportions

## Files Unchanged

- Adapter key remains `sky-makercore`
- `shared/lib/live-reserve-adapters.ts` definition unchanged (sourceModel: dynamic-mix, evidenceClass: independent, sharedSourceMode: source-invariant)
- `shared/types/live-reserves.ts` — no new adapter key needed
- `worker/src/cron/reserve-adapters/index.ts` — registration unchanged
- Display badge stays `live`

## Risk

Block Analitica is a third-party API with no SLA. However, it powers the official Sky dashboard, making it the most reliable module-level source available. If it goes down, the adapter will fail gracefully via the existing circuit breaker, and the static fallback reserves will be served instead.

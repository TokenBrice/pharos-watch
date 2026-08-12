---
name: contract-populate
description: Populate missing `contracts` entries for a tracked stablecoin in the Pharos dashboard from CoinGecko `detail_platforms` data while preserving curated addresses and using only chain IDs already present in `shared/lib/chains/index.ts`. Use when adding a stablecoin or filling known chain gaps in `shared/data/stablecoins/coins/*.json`.
---

# Contract Populate

Populate missing contract addresses from CoinGecko without overwriting curated data. Use this only after the coin's `geckoId` is already known.

## Read First

- Read the current coin entry in `shared/data/stablecoins/coins/*.json` (or `shared/data/stablecoins/coins.generated.json`) plus `shared/lib/chains/index.ts`.
- Treat the runtime stablecoin re-export as import-only; contract metadata edits belong in the per-coin JSON registry and must match `shared/lib/stablecoins/schema.ts`.
- Load `.codex/skills/contract-populate/references/chain-mappings.md` when translating CoinGecko platform names or deciding which platforms to skip.
- If `geckoId` is missing or suspect, use `coingecko-id-verif` or `stablecoin-info-fetch` first.

## Workflow

1. Locate the stablecoin entry in the matching `shared/data/stablecoins/coins/*.json` file.
2. Record its `geckoId` and current `contracts` chains. Treat existing entries as curated data.
3. Fetch CoinGecko coin detail:

```bash
curl -s "https://api.coingecko.com/api/v3/coins/${GECKO_ID}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false"
```

4. Inspect `detail_platforms`:
- map each CoinGecko platform name to the repo's chain ID via the reference file
- if a platform key is absent from the reference file entirely, resolve it via CoinGecko `/api/v3/asset_platforms` and check `CHAIN_META` / `CHAIN_ALIASES` in `shared/lib/chains/index.ts` before treating it as a skip
- skip empty addresses, skipped platforms, and chains already present
- lowercase EVM addresses
- preserve original casing for Tron and other non-EVM chains
- require decimals (CoinGecko's `decimal_place` maps to our `decimals` field); if `decimal_place` is null and you cannot verify it from official docs or explorer data, skip and flag it

5. Verify every new address before patching:
- official docs or deployed-contract pages first
- explorer API or explorer token page second
- name, symbol, and decimals must match the stablecoin

6. If the chain ID does not exist in `CHAIN_META`, report it as an unsupported chain and skip it unless the user explicitly starts a separate chain-support task

7. Patch only `contracts` in the matching `shared/data/stablecoins/coins/*.json` entry

8. Converge the aggregate and dependent projections with `npm run prebuild -- --only stablecoin-client-registry,report-card-registry-fingerprint,legacy-stablecoin-redirects`, then run `npm run check:stablecoin-data`; for full additions, follow Phase 7 in `docs/process/adding-a-stablecoin.md`.

## Batch Mode

Process coins sequentially. CoinGecko rate limits aggressively on the free tier, so avoid parallel coin-detail requests.

After the batch, report:
- existing chains kept
- new chains added
- skipped or unmapped CoinGecko platforms
- entries skipped because decimals were unresolved
- unsupported chains skipped

## Guardrails

- Never overwrite an existing contract entry.
- Never guess decimals.
- Never invent a new chain ID if an equivalent one already exists in `shared/lib/chains/index.ts`.
- If official docs and CoinGecko disagree, prefer official docs and note the conflict.

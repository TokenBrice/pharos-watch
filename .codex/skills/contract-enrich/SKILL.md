---
name: contract-enrich
description: Discover missing stablecoin deployments in the Pharos dashboard by comparing DefiLlama chain-level supply data against entries in `shared/data/stablecoins/coins/*.json`, then populate verified contracts via CoinGecko and explorer checks. Use when auditing chain coverage, backfilling missing deployments, or batch-enriching tracked stablecoins.
---

# Contract Enrich

Use this skill for two-phase enrichment: find contract gaps from DefiLlama first, then fill them with verified addresses.

## Read First

- Load `.codex/skills/contract-enrich/references/chain-mappings.md` for thresholds, DL chain-name mapping, and CoinGecko platform mapping.
- DefiLlama's list endpoint already returns circulating values in USD. Do not multiply list values by price.
- Read tracked metadata from `shared/data/stablecoins/coins/*.json` or `shared/data/stablecoins/coins.generated.json`; the runtime stablecoin re-export is not a metadata edit target. Unknown chains are reported and skipped unless the user starts a separate chain-support task.
- Use the same verification bar as `contract-populate` before writing any address.

## Workflow

1. Choose the scope:
- one coin
- all tracked coins
- top N by circulating supply

2. Read current chain coverage from the per-coin JSON registry under `shared/data/stablecoins/coins/`.

3. Fetch DefiLlama's list endpoint:

```bash
curl -s "https://stablecoins.llama.fi/stablecoins?includePrices=true"
```

4. For each tracked coin:
- match by `llamaId`
- translate `chainCirculating` names to internal chain IDs using the reference file
- skip dead or deprecated chains
- keep only gaps whose USD supply clears the threshold
- compare those chains against the coin's existing `contracts`

5. Produce a gap list first. If the request is an audit, stop there.

6. If the request is to apply changes, fill each gap:
- fetch CoinGecko `detail_platforms`
- cross-check official docs or deployed-contract pages
- verify via explorer API or explorer token page
- patch the matching `shared/data/stablecoins/coins/*.json` entry
- report unsupported chains instead of editing `shared/lib/chains/index.ts`

7. Converge the aggregate and dependent projections with `npm run bootstrap:generated`, then run `npm run check:stablecoin-data`; for full additions, follow Phase 7 in `docs/process/adding-a-stablecoin.md`.

## Batch Rules

- Process sequentially.
- Keep notes on:
  - gaps found
  - gaps filled
  - unmapped DL chains
  - unmapped CoinGecko platforms
  - unresolved decimals or address conflicts

## Guardrails

- Do not backfill noise. Thresholds exist to filter trivial deployments.
- Do not add an address solely because DefiLlama reports supply on a chain.
- If DefiLlama reports meaningful supply but CoinGecko lacks the platform, search official docs before giving up.
- Do not overwrite curated contracts.

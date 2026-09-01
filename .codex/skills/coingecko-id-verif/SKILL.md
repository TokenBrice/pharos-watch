---
name: coingecko-id-verif
description: Verify `geckoId` values for tracked stablecoins in the Pharos stablecoin dashboard by cross-checking `shared/data/stablecoins/coins/*.json` against DefiLlama metadata and CoinGecko contract-address resolution. Use when adding a stablecoin, auditing price mismatches, or investigating missing or incorrect CoinGecko prices.
---

# CoinGecko ID Verification

Use the bundled verifier before editing `geckoId` by hand. When an Ethereum contract exists, CoinGecko's contract lookup is the ground truth.

## Workflow

1. Run from the repo root when possible. If not, pass `--repo /abs/path/to/stablecoin-dashboard`.
2. Use the verifier:

```bash
python3 .codex/skills/coingecko-id-verif/scripts/verify.py --coin usdt-tether
python3 .codex/skills/coingecko-id-verif/scripts/verify.py --scan
python3 .codex/skills/coingecko-id-verif/scripts/verify.py --all
```

3. Interpret verdicts:
- `OUR_CORRECT`: keep the current `geckoId`
- `DL_CORRECT`: update our `geckoId` to the contract-resolved slug
- `NEITHER (...)`: set `geckoId` to the slug returned by the contract lookup
- `MISSING (...)`: no `geckoId` configured yet; adopt the contract-resolved slug after an identity check
- `NOT_ON_CG`: CoinGecko does not resolve the contract; do not guess a slug
- `NO_ETH_ADDRESS`: has a `geckoId` but no Ethereum contract exists to use as ground truth
- `NO_GECKO_ID`: neither a `geckoId` nor an Ethereum contract; discover the slug manually (`stablecoin-info-fetch`)

4. If you change `geckoId`, patch the matching entry in `shared/data/stablecoins/coins/*.json`, converge the stablecoin projections with `npm run bootstrap:generated`, rerun the single-coin check, run `stablecoin-runtime-price-marketcap-gate` for active additions/promotions, and then follow the relevant validation gate.

## Notes

- The script loads `COINGECKO_API_KEY` from `worker/.dev.vars` when present. Without it, the free CoinGecko API is used.
- `--scan` iterates only coins that have a `llamaId`; coins without one are invisible to it. Check those individually with `--coin`.
- The script compares three views of the asset:
  - our configured `geckoId` from the JSON stablecoin registry
  - DefiLlama's `gecko_id`
  - CoinGecko's contract-address lookup
- Prefer the script over ad-hoc manual checks because it catches cases where our slug and DefiLlama's slug both exist but point at different contracts.

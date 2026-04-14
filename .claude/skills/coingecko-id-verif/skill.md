---
name: coingecko-id-verif
description: Verify CoinGecko IDs for tracked stablecoins by cross-referencing our geckoId config against DefiLlama's geckoId and CoinGecko's contract-address lookup. Use when adding new stablecoins, auditing price data accuracy, or investigating missing/wrong prices.
---

# CoinGecko ID Verification

Verifies that the `geckoId` in `shared/data/stablecoins/*.json` is correct by cross-referencing three sources:

1. **Our config** (`geckoId` in the stablecoin JSON registry) -> CoinGecko coin endpoint
2. **DefiLlama's geckoId** (`gecko_id` from stablecoins.llama.fi) -> CoinGecko coin endpoint
3. **Contract address** (from our `contracts` array) -> CoinGecko contract lookup (ground truth)

## When to Use

- Adding a new stablecoin to the tracked list
- Investigating missing prices or incorrect depeg detection
- Periodic audit of price data accuracy
- After discovering a geckoId mismatch between our config and DefiLlama

## How to Run

### Single coin verification

```bash
python3 .claude/skills/coingecko-id-verif/verify.py --coin usdt-tether
```

### Mismatch scan (compares our geckoIds against DefiLlama's)

```bash
python3 .claude/skills/coingecko-id-verif/verify.py --scan
```

### Full audit of all tracked coins

```bash
python3 .claude/skills/coingecko-id-verif/verify.py --all
```

## Requirements

- Optional CoinGecko Pro API key in `worker/.dev.vars` as `COINGECKO_API_KEY`; without it, the script uses the free API and rate limits more aggressively
- `curl` available on PATH
- Python 3.10+

## How It Works

For each coin, the script:

1. Fetches `/coins/{our_geckoId}` from CoinGecko and checks the Ethereum contract address
2. Fetches `/coins/{dl_geckoId}` from CoinGecko (if different from ours) and checks its address
3. Fetches `/coins/ethereum/contract/{our_eth_address}` as ground truth
4. Reports whether our geckoId, DL's geckoId, or neither matches the contract

The **contract address lookup is the ground truth** -- it tells you exactly which CoinGecko ID maps to a given on-chain token.

## Interpreting Results

- `VERDICT: Our geckoId is CORRECT` -- no action needed
- `VERDICT: DL geckoId is correct, ours is WRONG` -- update `geckoId` in the matching `shared/data/stablecoins/*.json` entry
- `VERDICT: NEITHER (contract=xxx)` -- update our geckoId to `xxx`
- `VERDICT: Token not found on CoinGecko` -- token may not be listed on CG (normal for some coins)

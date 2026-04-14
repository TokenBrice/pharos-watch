# BOLD Liquidity Pool Dedup Investigation

Date: 2026-04-14

## Scope

Investigated why `bold-liquity` showed duplicate BOLD/USDC Uniswap V4 rows with different TVL and volume, and whether the issue generalized beyond BOLD.

## Findings

- Live `/api/dex-liquidity` showed BOLD with both a DeFiLlama Uniswap V4 UUID row (`d0c42a48-...`) and a CoinGecko Onchain Uniswap V4 pool-id row (`0x5d0ed5...aff893`) for the same BOLD/USDC pool.
- DeFiLlama's yields API uses opaque UUID pool ids for these rows, while CoinGecko Onchain exposes the Uniswap V4 32-byte pool id. The staged merge only allowed exact or full derived matches, so the CoinGecko row survived when optional fee/stable metadata differed.
- Live data also showed non-Curve DeFiLlama pools inheriting Curve enrichment when their symbol pair matched a Curve pool on the same chain. That was not isolated to BOLD; examples included Uniswap, Aerodrome, and SushiSwap rows carrying Curve registry/balance metadata.

## Fix

- Scope Curve API enrichment to Curve DeFiLlama rows only.
- Normalize underscore/provider-suffixed DEX ids, such as `uniswap_v3` and `uniswap-v4-ethereum`, into canonical protocol families for identity matching.
- Treat Uniswap V4 32-byte pool ids as trustworthy native pool ids.
- Allow staged discovery to use the narrow optional-metadata wildcard only when the staged incoming bucket and known primary bucket are both unique. Ambiguous same-pair staged pools still remain separate.
- Add cron metadata for `stagedPoolsSkippedByOptionalWildcardIdentity`.
- Bump Liquidity Score methodology to v5.4 and update the verified liquidity docs.

## Verification

- Focused DEX liquidity tests cover Curve symbol-fallback scoping, the BOLD-style Uniswap V4 UUID/pool-id collapse, and ambiguous same-pair staged pools.
- Root and worker typechecks passed.
- Liquidity doc-sync passed.
- Production build passed.

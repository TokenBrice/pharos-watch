# Yield Tracking More Tokens

Date: March 3, 2026

## Objective
Expand `/yield` leaderboard coverage with tracked stablecoins that have credible, non-trivial yield sources.

## Current State (Live Snapshot)
- Total tracked stablecoins: 144
- Currently on `/yield` leaderboard: 41
- Missing from `/yield`: 103
- `yieldBearing: true` coins total: 24
- `yieldBearing: true` coins missing from `/yield`: 1 (`173` / `BUIDL`)

## Coverage Friction (Why 103 Are Missing)
- Missing coins with any single-asset stablecoin pool: 51
- Missing coins with an allowlisted single-asset stablecoin pool: 24
- Missing coins with allowlisted pool and safety score >= 60: 1 (`316` / `CASH`)
- Main blocker is safety threshold (`MIN_SAFETY_SCORE_FOR_YIELD = 60`), not pure pool availability

## Expanded Candidate Universe (Live Data)
Primary selection filter used for this expanded shortlist:
- circulating supply >= $25M
- matched single-asset stablecoin pool
- APY >= 0.5%
- pool TVL >= $5M

### Allowlisted Protocols
1. `221` `USDTB` — Aave V3 (Ethereum), APY ~0.58%, TVL ~$137.3M, score 45 (D)
2. `336` `U` — Venus Core Pool (BSC), APY ~2.46%, TVL ~$15.5M, score 58 (C)
3. `195` `USD0` — Euler V2 (Ethereum), APY ~1.10%, TVL ~$11.3M, score 49 (D)
4. `296` `CUSD` — Pendle (Ethereum), APY ~1.42%, TVL ~$9.0M, score 40 (D)
5. `256` `REUSD` — Pendle (Ethereum), APY ~8.90%, TVL ~$7.1M, score 50 (C-)

### Non-Allowlisted Protocols
1. `14` `USDD` — JustLend (Tron), APY ~5.34%, TVL ~$311.4M, score 54 (C-)
2. `263` `USDX` — stables-labs-usdx (Ethereum), APY ~1.35%, TVL ~$242.0M, score 41 (D)
3. `340` `rwaUSDi` — multipli.fi (Ethereum), APY ~3.89%, TVL ~$125.0M, score 43 (D)
4. `241` `USDO` — openeden-usdo (Ethereum), APY ~3.12%, TVL ~$61.8M, score 47 (D)
5. `335` `JUPUSD` — jupiter-lend (Solana), APY ~4.95%, TVL ~$61.0M, score 42 (D)
6. `321` `USDH` — merkl (Hyperliquid L1), APY ~0.87%, TVL ~$18.9M, score 57 (C)

## Additional Mid-TVL Candidates (Still Useful Coverage)
These have lower TVL than the strict `$5M` filter but can add breadth if we widen policy:
- `316` `CASH` — kamino-lend (Solana), APY ~2.39%, TVL ~$2.0M, score 60 (C+)
- `252` `DUSD` — pendle (Ethereum), APY ~4.35%, TVL ~$2.2M, score 52 (C-)
- `271` `avUSD` — pendle (Ethereum), APY ~8.42%, TVL ~$2.5M, score 50 (C-)
- `297` `MSUSD` — pendle (Ethereum), APY ~1.79%, TVL ~$1.3M, score 56 (C)
- `24` `cUSD` — pendle (Ethereum), APY ~1.42%, TVL ~$9.0M, score 55 (C), smaller circulating supply (~$14.5M)
- `101` `EURE` — aave-v3 (Gnosis), APY ~3.36%, TVL ~$3.8M, score 56 (C)

## Important Exception
- `173` `BUIDL` is marked `yieldBearing: true` but still missing from `/yield`.
- This needs deterministic handling (explicit mapping/path), not allowlist expansion.

## Coverage Scenarios (Using Current Matching Logic)
Potential additions beyond current 41 ranked coins:
- Safety >= 60, current allowlist: `+1` -> projected `42/144`
- Safety >= 55, current allowlist: `+5` -> projected `46/144`
- Safety >= 50, current allowlist: `+11` -> projected `52/144`
- Safety >= 50, expanded allowlist (`justlend`, `openeden-usdo`, `multipli.fi`, `jupiter-lend`, `merkl`, `stables-labs-usdx`): `+16` -> projected `57/144`

Quality-gated variant (example: APY >= 0.5% and TVL >= $1M) is more conservative and avoids low-signal additions.

## Recommended Rollout (Augmented)
1. **Phase A (Immediate, low risk):** deterministic fix for `BUIDL`; verify why `CASH` (score 60) is still absent despite fitting current gates.
2. **Phase B (Guardrails):** add explicit auto-discovery quality gates (`min APY`, `min TVL`) to prevent near-zero-yield and ultra-thin pools.
3. **Phase C (Policy):** lower safety floor incrementally (`60 -> 55 -> 50`) with explicit sign-off.
4. **Phase D (Protocol expansion):** add non-allowlisted protocols in batches, starting with `justlend`, `openeden-usdo`, `multipli.fi`, `jupiter-lend`, `stables-labs-usdx`.
5. **Phase E (Merkl decision):** only add `merkl` once pool ranking is APY-aware; otherwise highest-TVL selection can suppress better-yielding Pendle matches for some symbols.

## Code Touchpoints
- `worker/src/cron/sync-yield-data.ts`
  - Inclusion filters and auto-discovery selection path
  - `yieldType = lending-opportunity` for auto-discovered sources
- `worker/src/cron/yield-helpers.ts`
  - `findBestLendingPool()` ranking logic (currently highest TVL)
- `worker/src/cron/yield-config.ts`
  - `LENDING_PROTOCOL_ALLOWLIST`
  - `YIELD_POOL_MAP` / `YIELD_VARIANT_MAP` / `ON_CHAIN_RATE_CONFIGS`
- `worker/src/lib/constants.ts`
  - `MIN_SAFETY_SCORE_FOR_YIELD` (currently 60)
- `src/lib/stablecoins.ts`
  - `yieldBearing` and `yieldConfig`

## Data Sources Queried
- `https://api.pharos.watch/api/yield-rankings`
- `https://api.pharos.watch/api/stablecoins`
- `https://api.pharos.watch/api/report-cards`
- `https://yields.llama.fi/pools`

## Notes
- Metrics above are point-in-time and may change with market conditions and pool dynamics.
- APY and TVL should be re-checked before final production rollout.

# Live Reserve Coverage Expansion for Top-100 Tracked Assets

**Date:** 2026-03-20  
**Scope:** Current live reserve coverage vs the current top-100 tracked assets by market cap  
**Method:** Filtered `https://api.pharos.watch/api/stablecoins` down to repo-tracked IDs in `shared/lib/stablecoins/index.ts`, then compared against `liveReservesConfig` coverage in the current codebase.

## Snapshot

- Repo-tracked stablecoins: `166`
- Live reserve-enabled tracked coins: `43`
- Current top-100 tracked coverage: `30 / 100`
- Tier coverage:
  - Top 10: `7 / 10`
  - Top 20: `12 / 20`
  - Top 50: `20 / 50`
  - Top 100: `30 / 100`

Notes:

- The public API currently returns a few upstream extras that are not canonical Pharos tracked IDs. This analysis excludes them.
- Market-cap ranks below are point-in-time values from the live API on 2026-03-20.

## Core Expansion Ideas

### 1. Keep leaning on reusable adapter families, not one-off adapters

The next meaningful coverage jump does **not** require inventing many new systems. The best path is:

- `chainlink-por` for simple proof-of-reserve assets
- `evm-branch-balances` for treasury wallets holding a small reserve basket
- `http-html` parsing for issuer transparency pages that already publish structured numbers in page HTML
- `single-asset` / `erc4626-single-asset` for wrappers and structurally one-asset products

### 2. Add a small pricing override path to `evm-branch-balances`

This is the cleanest unlock for treasury-basket names like `usd0-usual`. The current blocker is not reserve discovery. It is valuation of wrapper assets that DefiLlama does not price directly. A branch-level price override or coinId-based fallback would unlock more than one coin.

### 3. Treat “attestation page with HTML numbers” as a first-class source family

`FDUSD` and `EURCV` are both good examples. Their pages already expose enough machine-readable numbers in HTML to build a stable parser without PDF extraction.

### 4. Do not spend the next cycle on opaque or semantics-broken systems

The return is poor on:

- non-EVM / custom-chain collateral systems
- monthly-PDF-only issuer disclosures
- protocols where “reserve” and “minting collateral” are still semantically unresolved

## Best Top-100 Candidates

### Immediate shortlist: reasonable effort now

| Rank | Coin | MCap | Route | Effort | Why it is reasonable |
|---|---|---:|---|---|---|
| 11 | `paxg-paxos` | `$2.36B` | `chainlink-por` config | Small | Existing adapter family; repo research already marks PAXG as an active Chainlink PoR candidate. |
| 21 | `usdtb-ethena` | `$0.89B` | `evm-branch-balances` config | Small | Structure is simple: roughly BUIDL + USDC. Main work is reserve-address discovery, not new adapter code. |
| 25 | `usd0-usual` | `$0.56B` | `evm-branch-balances` + price fallback | Small-Medium | Historical plan already drafted the config. Current blocker is missing DefiLlama pricing for `UsualM`, not source availability. |
| 29 | `fdusd-first-digital` | `$0.38B` | new `http-html` parser | Medium | First Digital’s transparency page currently exposes reserve mix directly in HTML: T-bills, cash, bank deposits, reverse repos. |
| 37 | `frax-frax` | `$0.21B` | reuse `frax` adapter or sibling config | Small-Medium | `frxusd-frax` already uses `https://api.frax.finance/combineddata/`. FRAX looks like a semantics decision more than an infra problem. |
| 64 | `eurcv-societe-generale-forge` | `$75.7M` | new `http-html` parser | Medium | SG Forge’s page currently exposes daily circulation and `100%` backing directly in HTML. |
| 99 | `usdb-blast` | `$24.6M` | `single-asset` or simple custom adapter | Small | Blast docs still describe USDB as redeemable back to DAI with yield sourced from MakerDAO’s treasury stack. Low effort, low market-cap impact. |

### Next wave: still reasonable, but not as clean

| Rank | Coin | MCap | Route | Effort | Main caveat |
|---|---|---:|---|---|---|
| 62 | `tbill-openeden` | `$79.8M` | extend/reuse `openeden-usdo` | Medium | The previously expected `prod-gw.openeden.com/tbill/sys/reserve-composition-last` endpoint now returns `404`, so source rediscovery is required. |
| 41 | `dola-inverse-finance` | `$182.4M` | transparency API or on-chain FiRM reads | Medium | Good transparency surface, but backend API still needs reverse-engineering or direct contract reads. |
| 43 | `ausd-agora` | `$163.2M` | PoR oracle config | Medium | Likely viable if the active Chaos Labs / on-chain reserve oracle address is identified cleanly. |

### High-impact but not “reasonable effort” yet

| Rank | Coin | MCap | Why not now |
|---|---|---:|---|
| 6 | `usd1-world-liberty-financial` | `$4.45B` | Biggest upside, but current repo notes say the known oracle path likely uses custom `latestBundle()` semantics, so this is not a straight `chainlink-por` config add. |
| 8 | `xaut-tether` | `$2.65B` | Attractive if a clean PoR feed is confirmed, but current source path is still less settled than PAXG. |
| 22 | `ousg-ondo-finance` | `$0.72B` | Explicitly blocked in the metadata today: the OUSG oracle is access-restricted for non-whitelisted callers. |
| 15 | `rlusd-ripple` | `$1.54B` | The current transparency page exposes circulation/reserve totals and PDF attestations, but not a clean live composition feed. |
| 7 | `pyusd-paypal` | `$4.08B` | Same issue as RLUSD/USDG/USDP: strong attestation posture, weak live machine-readable composition. |
| 18 | `usdd-tron-dao-reserve` | `$1.15B` | Main reserve system still runs through Tron/custom aggregation, which is materially outside the repo’s current adapter comfort zone. |

## Recommended Batch

### Batch A: do these first

1. `paxg-paxos`
2. `usdtb-ethena`
3. `usd0-usual`
4. `fdusd-first-digital`
5. `frax-frax`
6. `eurcv-societe-generale-forge`
7. `usdb-blast`

Impact:

- Top-100 live reserve coverage: `30 -> 37`
- Added current covered market cap: about `$4.52B`

### Batch B: only after source confirmation

1. `tbill-openeden`
2. `dola-inverse-finance`
3. `ausd-agora`

Impact if added after Batch A:

- Top-100 live reserve coverage: `37 -> 40`
- Added current covered market cap: about `$4.94B` total vs today

### Batch C: follow-up project, not config work

1. `usd1-world-liberty-financial`

Impact if solved too:

- Top-100 live reserve coverage: `40 -> 41`
- Added current covered market cap: about `$9.39B` total vs today

## Bottom Line

Yes. There are clearly foldable top-100 additions with reasonable effort.

The best next set is:

- `PAXG`
- `USDTB`
- `USD0`
- `FDUSD`
- `FRAX`
- `EURCV`
- `USDB`

That batch is the best balance of:

- current market-cap impact
- reuse of adapter code that already exists
- source quality that is good enough for the current live-reserve architecture

The main things to avoid in the next cycle are:

- PDF-only attestation names (`PYUSD`, `USDG`, `USDP`)
- access-blocked oracle names (`OUSG`)
- non-EVM / custom collateral systems (`USDD`)

## Useful References

- [docs/live-reserves.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/live-reserves.md)
- [shared/lib/stablecoins/index.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/stablecoins/index.ts)
- [shared/lib/stablecoins/usd-major.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/stablecoins/usd-major.ts)
- [shared/lib/stablecoins/usd-minor.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/stablecoins/usd-minor.ts)
- [shared/lib/stablecoins/commodity.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/stablecoins/commodity.ts)
- [worker/src/cron/reserve-adapters/chainlink-por.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/chainlink-por.ts)
- [worker/src/cron/reserve-adapters/evm-branch-balances.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/evm-branch-balances.ts)
- [agents/research/2026-03-14-live-reserve-coverage-expansion.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/research/2026-03-14-live-reserve-coverage-expansion.md)
- [agents/research/2026-03-14-live-reserve-data-source-survey.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/research/2026-03-14-live-reserve-data-source-survey.md)
- [agents/research/2026-03-14-crypto-backed-reserve-sources.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/research/2026-03-14-crypto-backed-reserve-sources.md)

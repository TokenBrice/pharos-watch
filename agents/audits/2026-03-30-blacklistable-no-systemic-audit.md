# Blacklistable `No` Systemic Audit

Date: 2026-03-30

## Scope

Investigated the active stablecoins that still resolved to `Blacklistable: No` under the shared report-card pipeline, with emphasis on the user-reported false negatives:

- `usdf-falcon`
- `usda-avalon`
- `usdu-unitas`
- `dusd-standx`
- `yzusd-yuzu`

## Baseline

Using the same topological blacklist propagation shape as `worker/src/lib/report-cards-snapshot.ts`, the local metadata set produced:

- `42` active coins resolving to `Blacklistable: No` before this change
- `12` active coins resolving to `Blacklistable: No` after this change

The post-change `No` set is now mostly the genuinely clean decentralized names plus explicit `false` exceptions:

- `satusd-river`
- `bold-liquity`
- `hyusd-hylo`
- `lusd-liquity`
- `usnd-nerite`
- `usdq-quill`
- `usdk-orki`
- `feusd-felix`
- `isc-international-stable-currency`
- `rai-reflexer`
- `silk-shade-protocol`
- `cjpy-yamato`

## Root Cause

The previous resolver only trusted:

1. explicit `canBeBlacklisted`
2. `centralized` governance
3. reserve slices already marked `blacklistable: true`
4. reserve slices whose `coinId` pointed to an already-blacklistable upstream coin

That missed three repeatable classes of false `No` outcomes:

1. Named reserve baskets that clearly contain centralized stablecoins but were not annotated.
2. Custodial wrappers and tokenized collateral whose freeze risk is obvious from the reserve label.
3. CEX / off-exchange reserve rails described in reserve or peg text, even when the reserve slice itself stayed generic.

## Systemic Fix

The shared resolver now applies the same blacklist clue detection to curated and live reserve labels:

- direct clues:
  - named centralized stablecoins and treasury wrappers such as `USDC`, `USDT`, `PYUSD`, `USTB`, `USDtb`, `BUIDL`, `OUSG`
  - explicit custody / CEX descriptors such as `Binance`, `Ceffu`, `Copper`, `custody`, `off-exchange`
- possible clues:
  - savings / wrapper / upstream-stable labels such as `sDAI`, `sUSDe`, `sUSDS`, `frxUSD`, `crvUSD`, `USDT0`
  - generic stablecoin bucket labels such as `stablecoins`, `PSM`, `GSM`
  - custodial BTC wrappers such as `FBTC`, `cbBTC`, `BTCB`

Resolution contract after the change:

1. explicit override still wins
2. `centralized` still resolves to `Yes`
3. `Inherited` still requires `>50%` direct reserve exposure
4. any sub-majority reserve-side blacklist clue or CEX reserve rail now resolves to `Possible`
5. only zero-signal coins remain `No`

## Reported Cases

- `usdf-falcon`: no longer falls through to `No`; reserve labels and rail text now surface `Possible`
- `usda-avalon`: USDT plus FBTC custody clues now push it above the inherited threshold
- `usdu-unitas`: JLP reserve name plus off-exchange rail text no longer let it resolve to `No`
- `dusd-standx`: CEX custody reserve rails now surface `Possible`
- `yzusd-yuzu`: USDT0-backed mint/redeem rail now surfaces `Possible` instead of `No`

## Residual Limitation

This change only uses metadata already present in the repo. Coins whose reserve slices are still overly generic can now be prevented from incorrectly showing `No`, but they may still resolve to `Possible` instead of `Inherited` until curated reserve labels or live reserve feeds become more specific.

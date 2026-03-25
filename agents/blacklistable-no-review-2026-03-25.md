# Blacklistable No Review

Date: 2026-03-25

## Summary

- Detail-page hero bug: `Blacklistable` badge was reading `isBlacklistable(coin)` directly, which cannot resolve inherited reserve risk without the worker-computed `blacklistableIds` set.
- Fix: hero now prefers `reportCard.rawInputs.canBeBlacklisted`, which is the same resolved value used by the safety/report-card pipeline.
- Verified example: `usde-ethena` resolves to `possible-inherited` with `76%` blacklistable reserve exposure against a `25%` inherited-risk threshold.

## Current `Blacklistable: No` Set

Threshold for inherited blacklist risk: `25%` of reserves linked to first-order blacklistable coins.

- Neutrl USD (NUSD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 20%
- Re Protocol reUSD (reUSD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 20%
- Youves uUSD (UUSD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 20%
- USDD (USDD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 17%
- Hydrated Dollar (HOLLAR) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 15%
- Lista USD (LISUSD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 15%
- PikuDAO USP (USP) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 10%
- Resolv USD (USR) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 10%
- Yuzu USD (YZUSD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 10%
- Decentralized Euro (DEURO) — governance: decentralized; explicit override: none; inherited blacklistable reserves: 7.5%
- Celo Euro (CEUR) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 3%
- Celo Dollar (cUSD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 2%
- Asymmetry USDaf (USDaf) — governance: decentralized; explicit override: none; inherited blacklistable reserves: 0%
- Bima USBD (USBD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%
- Bitcoin USD (BtcUSD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%
- Convertible JPY Token (CJPY) — governance: decentralized; explicit override: false; inherited blacklistable reserves: 0%
- crvUSD (crvUSD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%
- Dola (DOLA) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%
- dTRINITY dUSD (dUSD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%
- Ebisu ebUSD (ebUSD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%
- Felix feUSD (FEUSD) — governance: decentralized; explicit override: none; inherited blacklistable reserves: 0%
- Frankencoin (ZCHF) — governance: decentralized; explicit override: none; inherited blacklistable reserves: 0%
- Frax Price Index (FPI) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%
- fxUSD (fxUSD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%
- GHO (GHO) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%
- Hermetica USDh (USDh) — governance: centralized; explicit override: false; inherited blacklistable reserves: 0%
- Hylo HYUSD (HYUSD) — governance: decentralized; explicit override: none; inherited blacklistable reserves: 0%
- International Stable Currency (ISC) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%
- Liquity BOLD (BOLD) — governance: decentralized; explicit override: none; inherited blacklistable reserves: 0%
- Liquity USD (LUSD) — governance: decentralized; explicit override: none; inherited blacklistable reserves: 0%
- Mento British Pound (GBPm) — governance: centralized-dependent; explicit override: false; inherited blacklistable reserves: 0%
- Mezo USD (meUSD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%
- Nectar (NECT) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%
- Nerite USND (USND) — governance: decentralized; explicit override: none; inherited blacklistable reserves: 0%
- Parallel USDp (USDp) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%
- Rai Reflex Index (RAI) — governance: decentralized; explicit override: false; inherited blacklistable reserves: 0%
- Resupply USD (REUSD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%
- River Stablecoin (satUSD) — governance: decentralized; explicit override: none; inherited blacklistable reserves: 0%
- SILK (SILK) — governance: decentralized; explicit override: false; inherited blacklistable reserves: 0%
- StandX DUSD (DUSD) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%
- Unitas (USDU) — governance: centralized-dependent; explicit override: none; inherited blacklistable reserves: 0%

## Review Notes

- No other inherited-risk misses surfaced in the current logic after the UI fix. The nearest unresolved coins top out at `20%`, still below the `25%` threshold.
- BOLD and LUSD look correct as `No`: decentralized governance, no explicit blacklist override, and `0%` inherited blacklistable reserve exposure.
- The main items worth a separate metadata review are the explicit `false` overrides on `USDh`, `GBPm`, `RAI`, `SILK`, and `CJPY`, because those bypass heuristic inference by design.

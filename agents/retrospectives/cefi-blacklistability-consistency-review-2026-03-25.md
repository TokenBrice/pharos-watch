# CeFi / CeFi-dependent blacklistability consistency review

Date: 2026-03-25

## Problem

After targeted coin reviews, the remaining `Blacklistable = No` set still contained a large number of assets flagged as `centralized-dependent`.

That was not a metadata one-off. It came from the shared resolution rule in `isBlacklistable()`:

1. explicit override
2. `centralized` -> `true`
3. inherited reserve risk -> `possible-inherited`
4. otherwise `false`

Under that rule, `centralized-dependent` coins defaulted to `false` unless reserve inheritance crossed the 25% threshold.

## Decision

Treat `centralized-dependent` governance as `possible` by default.

Final resolution order is now:

1. explicit `canBeBlacklisted`
2. `centralized` -> `true`
3. inherited reserve risk -> `possible-inherited`
4. `centralized-dependent` -> `possible`
5. otherwise `false`

This preserves the more specific inherited label when reserve composition is the actual reason, while removing the inconsistent outcome where CeFi-dependent structures appeared as `No`.

## Why this is better

- It aligns blacklistability attribution with the existing governance taxonomy.
- It avoids coin-by-coin metadata overrides for what is really a methodology gap.
- It keeps curated explicit `false` exceptions authoritative.
- It leaves fully decentralized names untouched.

## Impact

- Before this change: 49 active `centralized` / `centralized-dependent` coins still resolved to `Blacklistable = No`.
- After this change: 0 active `centralized` / `centralized-dependent` coins resolve to `Blacklistable = No`.
- Remaining `Blacklistable = No` set is now 12 coins, all `decentralized`.

Remaining `No` set:

- `usdaf-asymmetry`
- `cjpy-yamato`
- `deuro-deuro`
- `feusd-felix`
- `zchf-frankencoin`
- `hyusd-hylo`
- `bold-liquity`
- `lusd-liquity`
- `usnd-nerite`
- `rai-reflexer`
- `satusd-river`
- `silk-shade-protocol`

Explicit `false` exceptions that remain in the `No` set:

- `cjpy-yamato`
- `rai-reflexer`
- `silk-shade-protocol`

## Verification

- `npm test -- shared/lib/__tests__/report-cards.test.ts shared/lib/__tests__/stablecoins.test.ts src/components/stablecoin-detail/__tests__/hero-card.test.tsx`
- `npm run lint`
- `npm run build`

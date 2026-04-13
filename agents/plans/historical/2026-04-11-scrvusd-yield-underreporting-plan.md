# scrvUSD Yield Underreporting Investigation and Remediation Plan

Date: 2026-04-11

## Investigation Summary

Pharos currently selects `onchain:crvusd-curve`, derived from a generic `convertToAssets(1e18)` exchange-rate reader in `ON_CHAIN_RATE_CONFIGS`.

The published row from `https://pharos.watch/_site-data/yield-rankings` showed:

- `currentApy`: `3.061205656001764`
- `dataSource`: `onchain`
- `sourceKey`: `onchain:crvusd-curve`
- `comparisonAnchorAgeSeconds`: about 7 days

The DeFiLlama canonical scrvUSD pool `5fd328af-4203-471b-bd16-1705c726d926` showed current APY near `4.27%`, matching the Curve UI screenshot.

Root cause: Pharos is not displaying stale frontend data. It is selecting a deterministic row whose semantics are wrong for the displayed "current APY" surface. The generic Tier 1 reader annualizes the trailing 7-day change in `convertToAssets(1e18)`. scrvUSD's UI/API current rate is instead based on the Yearn V3 profit-unlock stream currently being distributed to depositors.

On-chain probe of the scrvUSD vault (`0x0655977FEb2f289A4aB78af67BAB0d17aAb84367`) confirmed the current-rate inputs are available:

- `totalAssets()`
- `totalSupply()`
- `profitUnlockingRate()`
- `fullProfitUnlockDate()`

Using the Yearn V3 unlock rate, the current APR is:

```text
apr = profitUnlockingRate / 1e12 / totalSupply * 31_536_000
apy = ((1 + apr / 365) ^ 365 - 1) * 100
```

With the probed live values, this produced about `4.27%` APY, aligning with Curve/DeFiLlama. The existing 7-day exchange-rate APY produced about `3.06%`, which explains the dashboard underreporting.

## Review / Fix-Plan Loop

### Plan v1

Remove `crvusd-curve` from `ON_CHAIN_RATE_CONFIGS` so the canonical DeFiLlama scrvUSD pool wins arbitration.

Review findings:

- Medium: this would fix the displayed number, but it would demote scrvUSD from deterministic on-chain coverage even though the correct current-rate data is available on-chain.
- Medium: it would continue to depend on third-party pool freshness for a major native savings source.

Disposition: revise the plan.

### Plan v2

Add a scrvUSD protocol-specific on-chain reader and reuse the existing `onchain:crvusd-curve` source key.

Review findings:

- Medium: reusing `onchain:crvusd-curve` would mix two different history semantics under one source key: old trailing 7-day exchange-rate rows and new current profit-unlock rows. That would contaminate `apy7d`, `apy30d`, and source-switch diagnostics.

Disposition: revise the plan.

### Plan v3

1. Remove `crvusd-curve` from the generic `ON_CHAIN_RATE_CONFIGS` list and mark the generic adapter quarantined with a reason explaining the trailing-delta mismatch.
2. Add a dedicated scrvUSD current-rate on-chain source that reads Yearn V3 vault state and emits a distinct source key, `onchain:crvusd-curve:scrvusd-current-rate`.
3. Keep the existing curated DeFiLlama pool mapping so it remains an alternative/fallback source and a cross-check.
4. Add targeted unit coverage for the scrvUSD formula and config-registry quarantine behavior.
5. Update yield methodology docs, public methodology copy, and the yield methodology version/timeline to `v7.3`.
6. Run targeted yield tests first, then the repo validation commands required for this deploy surface.

Review findings:

- Low: the source switch will reset source-specific 7d/30d history for the new key until new rows accumulate. This is acceptable because mixing the old history would be worse, and the current APY becomes correct immediately.

Disposition: approved for implementation. No medium-or-higher issues remain.

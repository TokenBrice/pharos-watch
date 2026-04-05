# Yield Selection Regression Plan

## Problem

Live `/api/yield-rankings` currently selects `Aave v3 (ethereum)` for `dai-makerdao` at roughly `2.24%` while retaining `Dai Savings Rate (sDAI)` at roughly `4.46%` only as an alternative source.

## Root Cause

The supplemental Aave V3 lending lane writes rows as `dataSource: "onchain"`. Yield arbitration treats `onchain` rows as deterministic-tier sources, so a supplemental lending-market row can outrank a stronger native wrapper row purely because of source family.

## Fix

1. Reclassify supplemental Aave V3 supply-rate rows as curated protocol-native sources.
2. Keep their source keys and labels unchanged so source identity/history stays stable.
3. Add regression coverage proving a higher native wrapper APY beats a lower supplemental Aave APY.
4. Update Yield Intelligence methodology docs/version history to document the Tier 2.5 precedence rule.

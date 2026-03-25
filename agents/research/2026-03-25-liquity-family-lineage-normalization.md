# Liquity Family Lineage Normalization

Date: 2026-03-25

## Goal

Normalize Liquity-family identification into structured metadata so Pharos can:

- mark Liquity-family coins clearly on detail pages
- expose them as a first-class directory filter
- generate dedicated discovery hubs for the cohort

## Classification Rule Used

- `protocolFamily = "liquity"` for the full Liquity lineage
- `protocolVariant = "v1"` when the metadata explicitly signals the classic LUSD pattern
  - 110% liquidation threshold / minimum collateral ratio
  - Stability Pool
  - no ongoing borrower interest / one-time borrowing fee
- `protocolVariant = "v2"` when the metadata explicitly signals the BOLD pattern
  - user-set borrower rates
  - branch-style / per-market collateral design
  - Stability Pools plus Liquity-style redemptions
- `protocolVariant = "style"` when the lineage is clear but the current metadata does not justify a strict v1/v2 label

## Coins Normalized In This Pass

- `lusd-liquity` -> `liquity / v1`
- `bold-liquity` -> `liquity / v2`
- `satusd-river` -> `liquity / v1`
- `meusd-mezo` -> `liquity / v1`
- `btcusd-btcfi` -> `liquity / v1`
- `usdaf-asymmetry` -> `liquity / v2`
- `usnd-nerite` -> `liquity / v2`
- `ebusd-ebisu` -> `liquity / v2`
- `feusd-felix` -> `liquity / v2`
- `nect-beraborrow` -> `liquity / v2`
- `usbd-bima` -> `liquity / v1`
- `cjpy-yamato` -> `liquity / v1`

## Notes

- Existing freeform Liquity tags are removed where replaced by structured lineage fields.

# 2026-04-21 Archivist Documentation Verification — Loop 2

## Scope

Loop 2 started after `main` was pushed at `3aa67e4d`. Verification went deeper into residual claims not fully covered by loop 1:

- endpoint edge cases in `docs/api-reference.md`
- route-contract details for homepage, chains, and public status
- live-reserve adapter registry rows
- stale-data banner coverage
- digest runtime/cost notes

## Issues Corrected

- API reference now documents protected-route API-key limiter scope, stablecoin-reserve 404 variants, PSI bootstrap payload shape, optional yield-history warning, status-history clamping/ignored invalid date bounds, API-key creation `201`, and discovery-candidate clamping semantics.
- Homepage, Chains, and Status Dashboard route docs now match current component structure.
- Live reserve adapter rows for Abracadabra, BUCK.io, Lista, and USDH Native Markets now match current stablecoin configs.
- Worker/API limits no longer claims token usage is persisted to digest trigger or cron metadata.
- Data-pipeline stale-banner table now includes Chains, Chain detail, Stability Index, and Digest archive banners without breaking the table.

## Verification Commands

Passed:

- `npm run check:doc-source-paths`
- `npm run check:verified-doc-links`
- `npm run check:doc-sync`
- `npm run check:doc-counts`

## Loop Result

Loop 2 found more than 3 code-verifiable errors, so this correction pass must be committed, pushed, and followed by another verification loop.

# Yield Optional RPC And Wrapper Hardening Plan

Date: 2026-03-27
Owner: Codex
Status: In progress

## Scope

Address the two remaining yield follow-ups from the live audit:

1. Optional RPC families (`Compound V3`, `Aave V3`) still show occasional partial drift under `429` pressure.
2. Several wrapper-token DeFiLlama matches remain intentionally ambiguous and are skipped conservatively.

## Findings

- `fetchCompoundV3SupplyRates()` currently only forwards `fallbackRpcUrl` into `fetchEvmUint256AtBlock()`. When a chain has only `rpcUrl`, or when the fallback is the hot/rate-limited endpoint, Compound can silently miss rows even though another configured endpoint exists.
- Optional RPC families expose only resolved-row counts. Cron metadata does not say how many targets were attempted, missed, or why a family came up short.
- `YIELD_VARIANT_MAP` still underspecifies several wrapper entries. Some have the wrong primary chain for the live native wrapper venue, and some need a venue-level discriminator because the same wrapper token now appears in multiple single-exposure pools.
- The current ambiguity guard is correct and should stay fail-closed. The safe expansion is to make variant identity more explicit, not to guess among multiple pools.

## Remediation

1. Add stronger optional RPC endpoint handling:
   - always probe all configured endpoints, not just the fallback
   - rotate endpoint order across targets to spread load instead of hammering one URL first
   - allow a slightly deeper per-URL retry/backoff path for optional RPC reads

2. Add per-family optional RPC telemetry:
   - target count
   - attempted count
   - resolved count
   - missing count
   - missing-by-chain and missing-reason breakdown
   - budget-exhausted flag

3. Add explicit variant venue pinning support:
   - extend variant matching so config can pin a preferred DeFiLlama project in addition to symbol / chain / address
   - populate the missing or incorrect chain/address/project pins for the wrapper entries that are currently under-specified

4. Validate and document:
   - extend yield unit tests for the new telemetry and matching behavior
   - update yield methodology / ops docs and methodology version history
   - run the local validation suite before push

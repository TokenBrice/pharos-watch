# CCIP Mint/Burn Rollout Log

Date: 2026-03-04

## Preflight

- Typecheck (worker): pass
- Targeted test suite: pass
- Wrangler auth (`wrangler whoami`): pass

## Phase Outputs

1. Config + tests implemented locally.
2. Worker deployed to production.
3. Backfill executed canary-first and corrected with final deploy.
4. Final DB/API validation completed.

## Canary Metrics

Canary coin: `USDO (241)`

- Bridge burn classification present after backfill.
- Final pool-burn state: `42 bridge_burn`, `1 review_required`.

## Expansion Metrics

- `avUSD (271)` finalized at `29 bridge_burn` for pool burns.
- `USDC (2)` and `USD1 (262)` currently have no pool-burn rows to classify.

## Rollback Events

- None.

## Final Signoff

Rollout complete for CCIP Burn/Mint processing on Ethereum for configured targets.

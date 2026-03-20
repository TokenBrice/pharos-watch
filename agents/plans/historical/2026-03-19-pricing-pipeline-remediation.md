# Pricing Pipeline Remediation Plan

Date: 2026-03-19

Objective:
- eliminate false confidence in primary pricing,
- harden source admission,
- prevent stronger authoritative prices from being overwritten,
- keep DEX-source promotion honest,
- leave a clear path for the next integrity fixes.

## Initial Plan (V1)

1. Audit every live pricing source and the reference-rate side.
2. Patch the highest-severity consensus / admission bugs first.
3. Add targeted tests for each root-cause fix.
4. Update methodology/version docs in the same change.
5. Run repo verification.
6. Deploy and monitor affected crons.

Medium issues with V1:
- It did not separate safe-now fixes from deeper identity-model changes.
- It did not explicitly handle deployment prerequisites or post-deploy monitoring.

## Refined Plan (V2)

1. Safe-now fixes
   - pairwise consensus clustering,
   - explicit fixed-vs-NAV mode,
   - RedStone freshness + venue transparency,
   - authoritative override ordering,
   - direct-API sanity gating before DL suppression.
2. Verification lock
   - tests for each fix,
   - docs + methodology + versioning,
   - build / lint / test / worker type-check.
3. Deferred structural fixes
   - DEX observation identity,
   - fingerprint redesign,
   - broader challenger storage,
   - symbol disambiguation,
   - Fluid balance normalization.
4. Deployment
   - inspect workflow / credentials,
   - deploy only if local environment can authenticate cleanly,
   - observe next two affected cron runs.

Medium issues with V2:
- Deployment gate was still underspecified.

## Final Refined Plan (V3)

1. Complete and document the audit.
2. Implement only root-cause fixes that are behavior-preserving and testable in one pass.
3. Leave structural identity-model work in the written follow-up plan rather than forcing a risky partial patch.
4. Verify locally with the full gate:
   - `npm test`
   - `npm run lint`
   - `npm run build`
   - `cd worker && npx tsc --noEmit`
5. Attempt deployment only if:
   - Wrangler authentication is present,
   - required env/secret bindings are available,
   - deploy commands succeed cleanly from this workspace.
6. Post-deploy:
   - confirm worker/pages success,
   - check status endpoints,
   - monitor the next two runs of `sync-stablecoins` and `sync-dex-liquidity`,
   - rollback / hotfix only on observed regression.

Residual medium issues in V3: 0

## Implemented in This Pass

1. Pairwise maximal-clique consensus replaced anchor-based clustering.
2. Fixed pegs now stay in fixed mode even when reference prices are temporarily unavailable.
3. RedStone now requires fresh timestamped venue data.
4. Protocol overrides now remain final after GeckoTerminal probing.
5. Direct-API pools must pass shared TVL sanity gates before suppressing DL pools.
6. Tests and methodology docs were updated with the new rules.

## Next Plan After This Pass

1. Add `poolId`-style identity through DEX observations and dedupe before `dex_prices` aggregation.
2. Replace coarse pair fingerprints with a richer pool identity that preserves legitimate same-pair pools.
3. Store a larger challenger pool set for depeg confirmation than the visible top-10 list.
4. Make stablecoin token resolution chain-aware before any symbol fallback.
5. Normalize Fluid reserve balances against token decimals before balance-health use.

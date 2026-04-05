# Yield Module Remediation Plan

Date: 2026-03-26
Owner: Codex
Status: In progress

## Objectives

1. Remove live supplemental-source row loss.
2. Make supplemental cron metadata reveal hidden drops.
3. Make the monthly coverage audit reflect the real currently-supported DL surface.
4. Keep changes minimal and root-cause driven.

## Planned Changes

### Phase 1. Supplemental identity hardening

- Change Aave supplemental source keys from chain-only to asset-specific keys.
- Change supplemental dedupe to use a compound identity instead of raw `sourceKey` only.
- Preserve true duplicates while preventing cross-coin collapse.
- Add tests that fail if multiple same-family candidates on one chain collapse into one row.

Success criteria:

- local supplemental tests cover multi-coin same-chain Aave candidates
- production should show materially more than `3` Aave supplemental rows after deploy

### Phase 2. Supplemental observability

- Track raw candidate count before dedupe.
- Track deduped count after dedupe.
- Emit `rowsDropped` and dedupe breakdown in cron metadata.

Success criteria:

- `sync-yield-supplemental` cron history clearly shows whether rows were dropped
- `sourceFamilyCounts` can be reconciled against persisted counts

### Phase 3. Coverage audit noise reduction

- Expand the DL-covered pool set beyond `YIELD_POOL_MAP`
- include:
  - `AUTO_LENDING_POOL_MAP`
  - `EXPLICIT_YIELD_SOURCE_POOL_MAP`
- treat already-allowlisted protocol surfaces as supported for the unmatched high-TVL view
- update tests to lock the new behavior

Success criteria:

- audit stops flagging already-supported allowlisted pools as expansion gaps
- `coveredPoolCount` reflects the actual exact-pool coverage set better than the current `34`

### Phase 4. Docs and methodology sync

- Update yield operations/methodology docs if the source-key/publication semantics changed materially.
- Update the yield methodology timeline/version entry if the public coverage/output surface changes.

### Phase 5. Validation and rollout

- Run targeted yield tests.
- Run required repo validation for touched deploy surfaces:
  - `npm run lint`
  - `npm test`
  - `npm run build`
  - `npm run seo:check`
  - `cd worker && npx tsc --noEmit`
  - `npm run test:merge-gate`

### Phase 6. Post-push monitoring

- Push to `main`.
- Monitor deploy completion.
- Watch `sync-yield-data` for up to 8 runs.
- Watch `sync-yield-supplemental` for up to 2 runs.
- Stop early if both jobs drop below 1 medium issue.

## Live Acceptance Checks

- `yield_data` rows with `source_key LIKE 'aave-v3-onchain:%'` should increase from `3`.
- `sync-yield-supplemental` metadata should expose non-zero `rowsDropped` if any future collapse occurs.
- `yield-coverage-audit` should stop treating already-supported allowlisted exact pools as unmatched gaps.

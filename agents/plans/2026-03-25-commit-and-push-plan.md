## Goal

Commit the existing unstaged work on `main` in coherent batches, fix any validation issues, run the required local merge gate, and push the resulting commit stack to `origin/main`.

## Observed change clusters

1. Documentation and methodology shell cleanup
   - `src/app/about/page.tsx`
   - `src/app/methodology/*`
   - `shared/lib/liquidity-score-weights.ts`
   - related shared helpers used by methodology/docs shells

2. Shared data/detail cleanup
   - `src/components/stablecoin-detail/price-transparency-card.tsx`
   - `src/components/stablecoin-detail/__tests__/price-transparency-card.test.tsx`
   - `src/lib/api.ts`
   - `src/hooks/use-chains.ts`
   - `src/hooks/use-compare-data-model.ts`
   - `src/hooks/use-data-announce.ts`
   - `src/hooks/use-portfolio.ts`
   - `shared/lib/classification.ts`
   - deletion of `src/lib/blacklist-helpers.ts`

3. UI, accessibility, and layout polish across app surfaces
   - homepage, headers, sidebar, feature shells
   - chains pages and chain detail
   - blacklist, DEWS, report card, stablecoin detail hero
   - broad presentation updates across route/client components

## Execution order

1. Run lint/tests/build merge-gate flow against the current tree.
2. Fix any failures without rewriting the intent of the pending work.
3. Stage and commit the documentation/methodology batch.
4. Stage and commit the shared data/detail cleanup batch.
5. Stage and commit the remaining UI/accessibility batch.
6. Re-run `npm run test:merge-gate`.
7. Push all new commits together to `origin/main`.

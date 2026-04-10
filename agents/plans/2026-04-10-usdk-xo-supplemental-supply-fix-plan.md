# Plan: restore `usdk-kast` / `xo-exodus` supplemental cache admission

## Goal

Make `sync-stablecoins` publish the affected Solana-only supplemental assets into the canonical `stablecoins` cache reliably enough that their detail pages resolve normally on `pharos.watch`, without introducing coin-specific manual supply overrides.

## Plan v1

1. Update `worker/src/cron/sync-stablecoins/supplemental-assets.ts` so Solana total-supply fallback uses the same endpoint set as the existing shared reserve-adapter helper.
2. Add a regression test proving a supplemental fiat CoinGecko asset survives when the first two Solana RPC endpoints fail and the third succeeds.
3. Validate with worker tests and the repo validation suite.

## Review v1

### Findings

1. Medium: this plan fixes first-publish reliability for Solana assets, but it still lets `detailProvider: "coingecko"` assets without a `geckoId` disappear from later cycles because `mergeSupplementalLastKnownGood()` will not preserve them.
2. Medium: this plan restores the missing assets but leaves them mislabeled as `chains: ["Ethereum"]`, which becomes a visible data error immediately after the main fix lands.

## Plan v2

1. Replace the duplicated Solana supply probe in `worker/src/cron/sync-stablecoins/supplemental-assets.ts` with the shared on-chain supply helper already used by reserve adapters, so the stablecoin supplemental path inherits the tested Solana endpoint fallback behavior.
2. Expand the supplemental last-known-good allowlist in `worker/src/cron/sync-stablecoins/shared.ts` so all `detailProvider: "coingecko"` tracked assets are preserve-eligible, even when they do not yet have a `geckoId`.
3. Correct supplemental fiat asset chain labels in `worker/src/cron/sync-stablecoins/supplemental-assets.ts` so synthesized Solana-only assets publish `chains: ["Solana"]` instead of `["Ethereum"]`.
4. Add regression coverage in `worker/src/cron/__tests__/sync-stablecoins.test.ts` for:
   - Solana supplemental supply admission after primary RPC failures
   - last-known-good restoration for a `detailProvider: "coingecko"` asset without a `geckoId`
   - correct published chain label for a Solana-only supplemental asset
5. Update the relevant pipeline docs to match the broadened supplemental restore rule and the Solana on-chain fallback behavior.
6. Run targeted tests first, then `npm run lint`, `npm test`, `npm run build`, `cd worker && npx tsc --noEmit`, and `npm run test:merge-gate`.

## Review v2

### Findings

1. Low: the implementation should prefer reuse of the shared helper over copying its endpoint array again, otherwise the drift can recur.

### Result

- Medium-or-higher findings: `0`
- Plan status: approved for implementation

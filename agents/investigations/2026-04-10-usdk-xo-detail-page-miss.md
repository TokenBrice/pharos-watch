# Investigation: `usdk-kast` and `xo-exodus` detail pages render as untracked

## User-visible failure

- `/stablecoin/usdk-kast/` and `/stablecoin/xo-exodus/` render the client-side "This stablecoin is not part of the tracked Pharos universe." state.
- That exact UI only occurs when the route itself recognizes the ID as tracked, but `useStablecoins()` cannot find the asset in the live `/api/stablecoins` payload.

## What was ruled out

- The two assets exist in the curated repo metadata:
  - `shared/data/stablecoins/usd-minor.json`
  - `shared/data/stablecoins/canonical-order.json`
  - `data/logos.json`
  - `data/ai-summaries.json`
- The static route generation is correct:
  - `src/app/stablecoin/[id]/page.tsx` uses `TRACKED_STABLECOINS` for `generateStaticParams()`
  - `TRACKED_META_BY_ID.get(id)` resolves both IDs server-side
- The failure is not caused by URL encoding or route slugs:
  - `buildStablecoinUrl()` emits `/stablecoin/${encodeURIComponent(id)}/`
  - the server page for tracked IDs mounts normally

## Root-cause path

### 1. The stablecoin detail page only falls into this state when `/api/stablecoins` is missing the ID

- `src/lib/stablecoin-detail-view-model.ts` returns `status: "not-found"` when `listData?.peggedAssets?.find((candidate) => candidate.id === id)` fails.
- `src/app/stablecoin/[id]/client.tsx` maps that state to the exact message shown in the screenshot.

### 2. All five same-batch assets are absent from DefiLlama's stablecoin list, so they depend on the supplemental intake path

- Direct query against `https://stablecoins.llama.fi/stablecoins?includePrices=true` did not return `wm-m0`, `usdat-saturn`, `usdnr-nerona`, `usdk-kast`, or `xo-exodus`.
- That means the working assets in the batch are being recovered by `worker/src/cron/sync-stablecoins/supplemental-assets.ts`, not by the primary DefiLlama list ingest.

### 3. The two broken assets are the only same-batch assets that need Solana total-supply fallback on first publish

- `wm-m0`: can be admitted from CoinGecko market cap.
- `usdat-saturn`: needs fallback, but has an Ethereum contract.
- `usdnr-nerona`: needs fallback, but has an Ethereum contract.
- `usdk-kast`: no `geckoId`, Solana-only contract.
- `xo-exodus`: CoinGecko page exists, but admission still relies on fallback when market-cap data is absent/zero; Solana-only contract.

### 4. The Solana fallback in `supplemental-assets.ts` drifted from the already-tested helper used elsewhere

- `worker/src/cron/sync-stablecoins/supplemental-assets.ts` has its own `fetchSolanaTokenSupply()` implementation with:
  - `https://api.mainnet-beta.solana.com`
  - `https://api.mainnet.solana.com`
- `worker/src/cron/reserve-adapters/helpers.ts` has the shared, tested Solana supply probe with:
  - `https://api.mainnet-beta.solana.com`
  - `https://api.mainnet.solana.com`
  - `https://solana-rpc.publicnode.com`
- There is an explicit test for the third-endpoint fallback in:
  - `worker/src/cron/reserve-adapters/__tests__/helpers.test.ts`

### 5. Local execution confirms the supplemental path can synthesize both broken assets when Solana supply probing succeeds

- Running `fetchSupplementalTrackedTokens(...)` locally produced:
  - `usdk-kast` with `supplySource: "onchain-total-supply"`
  - `xo-exodus` with `supplySource: "onchain-total-supply"`
- That validates the asset metadata and fallback shaping logic.
- The production miss is therefore not "unsupported asset type"; it is the reliability of the Solana supply probe on the worker path.

## Additional resilience gap found during investigation

- `worker/src/cron/sync-stablecoins/shared.ts` only marks supplemental tracked assets as restore-eligible when `meta.geckoId` is present.
- `usdk-kast` is `detailProvider: "coingecko"` but has no `geckoId`.
- Result: if a cycle cannot freshly synthesize `usdk-kast`, the last-known-good supplemental cache cannot preserve it either.

## Related correctness drift

- `fetchFiatCoinGeckoTokens()` currently hardcodes `chains: ["Ethereum"]` for all supplemental fiat assets, including Solana-only ones.
- That is not the root cause of the missing-page bug, but it becomes a user-visible metadata error once the Solana-only assets are admitted again.

## Conclusion

The detail-page failures are caused by `sync-stablecoins` failing to publish the two Solana-dependent supplemental assets into the canonical stablecoins cache. The immediate code-level cause is duplicated Solana total-supply logic in `supplemental-assets.ts` that is less robust than the shared helper already used in reserve adapters. A secondary resilience bug prevents `usdk-kast` from being preserved from last-known-good cache state when fresh synthesis fails.

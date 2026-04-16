# Paid CEX depth provider Phase 3 design

Date: 2026-04-16

## Decision point

Phase 3 should only proceed if direct public orderbook telemetry proves useful but incomplete. The next step would be choosing a paid market-data provider for normalized historical exchange depth.

## Candidate providers

- Amberdata order books
- Coin Metrics market orderbooks
- Kaiko market depth snapshots

## Integration shape

Add a provider abstraction rather than hard-coding a single vendor into scoring:

```ts
interface CexDepthProviderClient {
  provider: "amberdata" | "coinmetrics" | "kaiko";
  fetchDepthSnapshots(args: {
    symbols: string[];
    depthBandPct: 1 | 2 | 5;
    signal?: AbortSignal;
  }): Promise<CexDepthSnapshot[]>;
}
```

Normalize every provider into:

- provider
- exchange
- market/pair
- symbol
- base/quote
- timestamp
- depthDownUsd by band
- depthUpUsd by band
- spread bps
- provider provenance / raw source id

## Storage

Use a new D1 table only after the provider is selected:

- `cex_orderbook_depth_current`
- `cex_orderbook_depth_history`

Keep current rows small and history daily/hourly downsampled. Do not store raw full books in D1.

## Scoring entry point

Do not feed paid CEX data into the existing DEX score directly. Add a separate `centralizedDepthScore` consumed by Report Cards:

- DEX liquidity remains DEX-first.
- CEX depth can add a bounded second-path bonus, similar to primary-market exit.
- CEX can become a stronger path only when at least two high-quality venues agree and the snapshots are fresh.

## Rollout

1. Run provider in shadow mode for USDC/USDT only.
2. Compare against direct Binance/Coinbase/Kraken canaries and CoinGecko depth rows.
3. Expand to the top 10 stablecoins by supply.
4. Add UI provenance before any score effect.
5. Only then consider a methodology version bump for CEX score integration.

## Open dependencies

- Provider commercial terms and display/license limits
- API key/secrets provisioning
- Quota and historical backfill cost
- Data retention policy


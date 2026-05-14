# Pricing Source Adapters

Typed contract for any module that fetches a single price observation from an
upstream source (DefiLlama coins, CoinGecko, DexScreener, Jupiter, CMC, Pyth,
NAV telemetry, ERC-4626, …).

Defined in [`shared/lib/pricing-source-adapter.ts`](../shared/lib/pricing-source-adapter.ts).

---

## Why this exists

Between `v5.95` and `v5.99` (3 days) the pricing pipeline shipped 10+ fix
commits, each of them touching a different source-specific pass:

- `fix: normalize defillama contract price lookups` (0f71d4b5a)
- `fix: recover addressless dexscreener price targets` (29f5f5c85)
- `fix: guard metadata dexscreener symbol matches` (84f9aa47d)
- `fix(pricing): enforce source freshness and provenance` (d4330eb55)
- `fix(pricing): add coingecko-low-volume fallback source for non-DefiLlama coins` (175119f52)
- `fix(worker): recover Jupiter and reserve breaker paths` (cfa54b357)
- `fix: refresh authoritative overrides after price enrichment` (b60bd54a0)
- `fix(pricing): resolve CoinGecko drift outliers` (d408d0859)

Each adapter has its own freshness check, its own address-shape handling, its
own provenance shape, its own failure surface, and its own fallback policy.
There is no shared contract — so every new source rediscovers the same
obligations, ships its first version without all of them, and stabilizes via
one or more follow-up `fix(pricing)` commits.

The adapter contract names what is already de-facto required of every source so
new adapters can no longer accidentally skip one of the obligations. Today's
existing passes are NOT wrapped to this contract; that migration is tracked
separately. The interface is additive: nothing in the existing pipeline
depends on it yet.

---

## Field reference

| Field | Why it exists |
|-------|---------------|
| `name: PriceSourceName` | Canonical key shared with `pricing-provider-diagnostics.ts` and the source registry. Adapter provenance, telemetry, and replay-safety policy can be cross-referenced by the same string. |
| `maxAgeMs: number` | Hard upper bound on observation age. The orchestrator MUST refuse a quote older than this; the adapter MUST also reject upstream rows older than this internally. Eliminates ad-hoc `*_MAX_AGE_SEC` constants buried in each pass. |
| `addressShape` | Declares whether the adapter consumes EVM addresses, Solana mints, multi-chain `chain:address` tuples, bare symbols, geckoIds, Pyth feedIds, or no per-asset input. Lets the orchestrator skip adapters that cannot serve a given asset without per-pass `if (!address) return []` boilerplate. |
| `fallbackPolicy` | `none` / `next-source` / `use-last-known`. Today this is implicit in pass ordering inside `enrich-prices-passes.ts`; surfacing it on the adapter prevents replay-unsafe sources from claiming `use-last-known`. |
| `isReplaySafe: boolean` | Mirrors the `isReplaySafe` flag on `PricingSourceRegistryEntry`. Search-derived and ephemeral lanes must declare `false` so cached-replay policy stays correct. |
| `stage` | `primary` / `fallback` / `depeg-confirmation`. Same vocabulary as `PricingProviderAttemptDiagnostic.stage`. |
| `PriceSourceProvenance.fetchedAt` | When the adapter completed the fetch (ms epoch). Required even on failure. |
| `PriceSourceProvenance.freshAt` | Upstream's own observation time when available, else `fetchedAt`. Source of truth for `priceObservedAt` columns on `PeggedAsset`. |
| `PriceSourceProvenance.observedAtMode` | `upstream` / `local_fetch` / `unknown`. Drives depeg-authoritative eligibility (see `pricing-source-policy.ts::isSingleSourceDepegAuthoritative`). |
| `PriceSourceProvenance.confidence` | The `PriceConfidence` the adapter would publish if its quote is selected; pass-through to `applyResolvedPrice`. |
| `PriceSourceProvenance.reliability` | Coarse `primary` / `fallback` / `low-confidence` tier so policy layers can branch without re-reading the registry. |
| `PriceSourceProvenance.upstreamConfidence` | DefiLlama coins confidence, Pyth confidence interval, etc., when the source exposes one. |
| `PriceSourceProvenance.lookupId` | Canonical identifier used to fetch the quote — useful for diagnostics dedupe. |
| `fetch(input, signal?)` returns `PriceSourceResult` | Discriminated success / failure. Failure carries a typed `PriceSourceFailureReason` and a narrowed provenance (`source` + `fetchedAt` only) so a failed call cannot pretend to have observed a quote. |

### `PriceSourceFailureReason` cases

`circuit-open`, `no-candidates`, `no-response`, `upstream-error`, `timeout`,
`rate-limited`, `malformed-json`, `invalid-shape`, `missing-quote`, `stale`,
`low-confidence`, `symbol-mismatch`, `liquidity-too-low`, `price-rejected`,
`unsupported-input`, `unknown-error`.

Distilled from the union of `errorClass` strings and
`rejectionReasonCounts` keys already populated by the existing passes
(`enrich-prices-pass-common.ts` + `pricing-provider-diagnostics.ts`). The set
is intentionally narrow so the orchestrator can branch on it; richer
diagnostic breakdowns remain on the diagnostic layer.

---

## Bugs the contract would have prevented

Three concrete recent examples:

1. **`fix: guard metadata dexscreener symbol matches` (84f9aa47d).** The
   DexScreener exact pass did not check the upstream pair's symbol against the
   tracked asset, so a stablecoin sharing a chain+address shape with an
   unrelated token could be priced from the wrong pair. A required
   `PriceSourceFailureReason = "symbol-mismatch"` rejection branch on the
   adapter would have forced the symbol-equality check at adapter-construction
   time rather than after the bug surfaced in production.

2. **`fix: normalize defillama contract price lookups` (0f71d4b5a).** The DL
   contract pass mis-normalized EVM addresses for some chain prefixes (e.g.
   `avalanche` vs. `avax`), silently dropping matches. An explicit
   `addressShape: "multi-chain"` declaration on the adapter, with a typed
   `{ chain, address }` input, would have made the contract require
   chain-id normalization rather than letting each pass roll its own.

3. **`fix(pricing): add coingecko-low-volume fallback source` (175119f52).**
   Low-volume CoinGecko-only coins were silently dropped because their
   upstream `last_updated_at` sat outside the strict 15-minute trust window,
   but the freshness logic lived inside the fetcher and was not declared on
   the source. A required `maxAgeMs` + `reliability: "low-confidence"` on
   the adapter would have forced authors to pick a window deliberately and
   declare the lane's tier instead of letting one source's freshness rules
   leak into the global gate.

Two more that the contract would have caught:

4. **`fix: recover addressless dexscreener price targets` (29f5f5c85).** The
   DexScreener pass returned `[]` early when the asset had no top-level
   `address`, ignoring tracked deployments. An `addressShape: "multi-chain"`
   adapter with a typed input would have forced explicit handling of the
   multi-deployment shape at the adapter boundary, not as a follow-up fix
   discovered by missing-price audits.

5. **`fix(pricing): enforce source freshness and provenance` (d4330eb55).**
   Multiple passes had to be retrofitted with `observedAt` + `observedAtMode`
   handling and stricter freshness gates after the depeg-authority rules
   discovered they relied on values the adapters were not promising. A required
   `provenance.freshAt` + `provenance.observedAtMode` on every successful
   response, declared at the type level, makes that promise mechanical instead
   of audit-driven.

---

## Migration note

Existing adapters (DefiLlama list/contract, CoinGecko, CoinGecko ticker, CMC,
DexScreener, Jupiter, Pyth, CEX tickers, RedStone, Curve on-chain/oracle, NAV
telemetry, ERC-4626 NAV, address-price providers) are **not** yet wrapped to
this contract. The interface is additive only; nothing imports it from the
runtime pipeline yet.

**New adapters must implement `PriceSourceAdapter`.** Migration of the existing
adapters is tracked separately; bumping `pricing-pipeline-version.ts` is not
required for the contract itself — only for behavior changes once migration
begins.

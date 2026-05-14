import type { PriceConfidence, PriceObservedAtMode } from "../types/core";

/**
 * Typed contract for any module that fetches a single observation of a price from
 * an upstream source (DefiLlama coins, CoinGecko, DexScreener, Jupiter, CMC,
 * Pyth/Hermes, RedStone, Curve on-chain/oracle, NAV telemetry, ERC-4626, …).
 *
 * The point of this file is to NAME what every existing adapter is already doing
 * implicitly: declare its freshness window, declare what kind of identifier it
 * accepts, return provenance (source name + when the upstream observed the
 * quote vs. when we fetched it), and return a discriminated failure when it
 * cannot produce a usable quote. Today each adapter rediscovers these
 * obligations on its own, which is why every new source has shipped a follow-up
 * fix commit (see docs/pricing-source-adapters.md for examples).
 *
 * NOTE: existing adapters are intentionally NOT wrapped to this contract yet.
 * Migration is tracked as a separate follow-up. New adapters must implement
 * this contract.
 */

/**
 * Canonical name set for a pricing source. Aligned with the existing diagnostic
 * source domain in `worker/src/lib/pricing-provider-diagnostics.ts` so adapter
 * provenance, registry policy, and diagnostics can be cross-referenced by the
 * same string key.
 */
export type PriceSourceName =
  | "binance"
  | "kraken"
  | "bitstamp"
  | "coinbase"
  | "coingecko"
  | "coingecko-low-volume"
  | "cg-ticker"
  | "defillama-list"
  | "defillama-contract"
  | "coinmarketcap"
  | "jupiter"
  | "dexscreener-exact"
  | "dexscreener-address"
  | "dexscreener-search"
  | "dexpaprika-address"
  | "alchemy-address"
  | "moralis-address"
  | "birdeye-address"
  | "geckoterminal-address"
  | "geckoterminal"
  | "pyth"
  | "redstone"
  | "curve-onchain"
  | "curve-oracle"
  | "dex-promoted"
  | "protocol-dex"
  | "native-peg"
  | "chainlink-nav"
  | "superstate-liquidity"
  | "erc4626-nav"
  | "protocol-redeem"
  | "cached";

/**
 * What kind of identifier the adapter accepts. Adapters that take a raw EVM or
 * Solana address need callers to pass normalized chain+address tuples;
 * symbol-only adapters (CEX tickers, CoinGecko ticker) consume bare symbols;
 * `none` is for global single-asset feeds that take no per-asset input
 * (e.g. crvUSD oracle).
 */
export type PriceSourceAddressShape = "evm" | "solana" | "multi-chain" | "symbol" | "geckoId" | "feedId" | "none";

/**
 * What the adapter is expected to do when it has no usable observation.
 *  - `none`            — caller must not substitute anything; missing-price is the answer.
 *  - `next-source`     — caller may try the next configured adapter.
 *  - `use-last-known`  — caller may republish a replay-safe cached observation
 *                       within `maxAgeMs`. Adapters that are not replay-safe
 *                       (see `isReplaySafe`) must declare `next-source` or
 *                       `none`, never `use-last-known`.
 */
export type PriceSourceFallbackPolicy = "none" | "next-source" | "use-last-known";

/**
 * The role the adapter's output plays inside the pricing pipeline. Matches the
 * `stage` field already populated on diagnostics so adapter metadata, telemetry,
 * and source-policy classification all share the same vocabulary.
 */
export type PriceSourceStage = "primary" | "fallback" | "depeg-confirmation";

/**
 * Reasons an adapter could not produce a usable quote. Distilled from the
 * `errorClass` + `rejectionReasonCounts` shapes already used by the existing
 * passes (`enrich-prices-*-pass.ts` + `pricing-provider-diagnostics.ts`).
 *
 * Adapters MUST return one of these reasons on failure. Diagnostics layers can
 * keep their own richer breakdown; the adapter-level enum stays narrow so the
 * orchestrator can branch on it without coupling to provider-specific text.
 */
export type PriceSourceFailureReason =
  | "circuit-open"        // local circuit breaker tripped; no fetch attempted
  | "no-candidates"       // adapter had no eligible inputs for this run
  | "no-response"         // upstream returned no response (network / abort)
  | "upstream-error"      // upstream returned non-OK status
  | "timeout"             // request exceeded the adapter's timeout budget
  | "rate-limited"        // upstream signalled 429 or local quota refused the call
  | "malformed-json"      // body could not be parsed as JSON
  | "invalid-shape"       // payload parsed but failed schema validation
  | "missing-quote"       // payload had no row for the requested input
  | "stale"               // upstream timestamp older than `maxAgeMs`
  | "low-confidence"      // upstream-reported confidence below adapter's threshold
  | "symbol-mismatch"     // upstream row's symbol disagrees with the tracked asset
  | "liquidity-too-low"   // DEX/market-derived quote failed the liquidity floor
  | "price-rejected"      // quote failed the reasonable-range / peg validation
  | "unsupported-input"   // adapter cannot serve this address-shape / asset
  | "unknown-error";      // catch-all; adapters should prefer a specific reason

/**
 * Provenance attached to every successful adapter response. These fields are
 * what downstream consensus, replay safety, depeg authority, and the
 * `priceObservedAt*` columns on `PeggedAsset` already need today.
 */
export interface PriceSourceProvenance {
  /** Canonical source name; must match `PriceSourceName`. */
  source: PriceSourceName;
  /**
   * When the adapter completed the fetch, in ms since epoch. Always populated
   * even on failure (see `Pick<PriceSourceProvenance, "source" | "fetchedAt">`
   * on the failure branch).
   */
  fetchedAt: number;
  /**
   * Upstream's own observation timestamp in ms since epoch when available,
   * else `fetchedAt`. Mirrors `priceObservedAt` semantics already serialized
   * on every asset.
   */
  freshAt: number;
  /**
   * How `freshAt` was obtained. `upstream` means the value came from the
   * provider; `local_fetch` means it was clock-stamped at fetch time;
   * `unknown` is permitted only for sources that never expose a timestamp.
   */
  observedAtMode: PriceObservedAtMode;
  /**
   * Adapter's role in the pipeline. Lets the orchestrator decide whether the
   * observation enters consensus, fallback enrichment, or depeg confirmation
   * without re-asking the adapter.
   */
  stage: PriceSourceStage;
  /**
   * Confidence class the adapter would publish if its quote is used. Maps 1:1
   * onto the existing `PriceConfidence` enum so it can be passed straight to
   * `applyResolvedPrice`.
   */
  confidence: PriceConfidence;
  /**
   * Coarse reliability tier — `primary` for hard oracle / market feeds,
   * `fallback` for soft / single-source enrichment, `low-confidence` for
   * relaxed-freshness lanes (e.g. `coingecko-low-volume`). Lets policy layers
   * branch without re-reading the registry.
   */
  reliability: "primary" | "fallback" | "low-confidence";
  /**
   * Upstream-reported confidence (DefiLlama coins, Pyth confidence interval,
   * etc.) when the source exposes one. Absent on sources that do not.
   */
  upstreamConfidence?: number;
  /**
   * Optional: the canonical identifier the adapter used to look up this quote
   * (e.g. `ethereum:0xabc…`, geckoId, Pyth feedId, Solana mint). Useful for
   * diagnostics and dedupe.
   */
  lookupId?: string;
}

/**
 * The single observation an adapter returns. Keep this minimal — adapter-specific
 * extras belong on the `TOutput` slot of the adapter generic, not here.
 */
export interface PriceSourceObservation {
  /** USD price for the tracked asset (already FX-converted by the adapter). */
  priceUsd: number;
  /**
   * Optional native-currency quote when the source publishes one. Adapters
   * that already FX-convert before returning should leave this undefined.
   */
  priceNative?: number;
  /** Upstream-reported liquidity in USD for DEX-style sources, when known. */
  liquidityUsd?: number;
}

/**
 * Successful adapter response.
 */
export interface PriceSourceSuccess<TOutput = PriceSourceObservation> {
  ok: true;
  output: TOutput;
  provenance: PriceSourceProvenance;
}

/**
 * Failed adapter response. `provenance` is intentionally narrowed: a failure
 * still knows which source it is and when it gave up, but cannot pretend to
 * have observed a quote.
 */
export interface PriceSourceFailure {
  ok: false;
  reason: PriceSourceFailureReason;
  provenance: Pick<PriceSourceProvenance, "source" | "fetchedAt">;
  /** Optional human-readable detail; not load-bearing for policy. */
  detail?: string;
}

export type PriceSourceResult<TOutput = PriceSourceObservation> =
  | PriceSourceSuccess<TOutput>
  | PriceSourceFailure;

/**
 * The contract every new price source must satisfy.
 *
 * Static fields (`name`, `maxAgeMs`, `addressShape`, `fallbackPolicy`,
 * `isReplaySafe`, `stage`) are declared up-front so the orchestrator can wire
 * the adapter into consensus, replay, and circuit policy without reading its
 * source. The dynamic `fetch` returns a single discriminated result.
 *
 * `TInput` is whatever the adapter accepts (e.g. `{ chain: string; address: string }`
 * for `dexscreener-exact`, `{ geckoId: string }` for `coingecko`, `{ mint: string }`
 * for `jupiter`). `TOutput` defaults to a plain `PriceSourceObservation` but can
 * be widened where an adapter needs to carry source-specific extras (Pyth's
 * confidence band, DexScreener's per-pair liquidity, NAV per-token + FX rate).
 */
export interface PriceSourceAdapter<TInput, TOutput = PriceSourceObservation> {
  /** Canonical name. Used for provenance, telemetry, registry lookup. */
  readonly name: PriceSourceName;
  /**
   * Maximum age, in milliseconds, beyond which the orchestrator MUST treat
   * the observation as `stale` and refuse to publish it. Adapters must reject
   * upstream observations older than this themselves before returning `ok`.
   */
  readonly maxAgeMs: number;
  /** What kind of per-asset input this adapter accepts. */
  readonly addressShape: PriceSourceAddressShape;
  /** What the caller may substitute when the adapter fails. */
  readonly fallbackPolicy: PriceSourceFallbackPolicy;
  /**
   * Whether a previously cached observation from this source can be
   * re-published on a later run within `maxAgeMs`. Mirrors
   * `isReplaySafe` in `pricing-source-policy.ts`. Search-derived and ephemeral
   * lanes must declare `false`.
   */
  readonly isReplaySafe: boolean;
  /** Adapter's pipeline role. */
  readonly stage: PriceSourceStage;
  /**
   * Perform one fetch. Implementations MUST:
   *   - check their own circuit before issuing a network call,
   *   - stamp `fetchedAt` even on failure,
   *   - reject upstream timestamps older than `maxAgeMs` as `stale`,
   *   - return `ok: false` with a typed `reason` instead of throwing for any
   *     expected failure mode.
   * Unexpected exceptions may still propagate.
   */
  fetch(input: TInput, signal?: AbortSignal): Promise<PriceSourceResult<TOutput>>;
}

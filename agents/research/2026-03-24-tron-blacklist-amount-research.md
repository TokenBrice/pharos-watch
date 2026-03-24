# Tron Blacklist Amount Attribution Research

Date: 2026-03-24

## Scope

Research how Pharos could attribute amounts for Tron blacklist and unblacklist events in the blacklist tracker, including whether adding a new Tron provider would solve the gap.

Current local implementation context:

- Tron blacklist events are ingested from TronGrid event APIs in `worker/src/cron/blacklist/tron-source.ts`.
- For Tron, `sync-blacklist.ts` intentionally does **not** backfill blacklist/unblacklist amounts because the current TronGrid account endpoint is current-state only and would create false precision.
- Destroy events already get an amount when the event payload includes it.

## Bottom Line

There does **not** appear to be a clean "add archive RPC and call `balanceOf(address)` at block N" solution on Tron.

The main reason is protocol/API support:

- TRON's JSON-RPC `eth_call` only supports `"latest"`, not historical block tags.
- `wallet/triggerconstantcontract` also does not take a block parameter.
- Hosted "archive" endpoints from providers like QuickNode do not change that method-level limitation.

That means a new generic Tron RPC provider alone will **not** solve blacklist/unblacklist amount attribution.

The best practical path is:

1. short term: reconstruct balances from **TRC20 transfer history for the blacklisted address**
2. long term: build or buy a **Tron transfer index / stream** so future attribution is cheap and deterministic

## Primary Findings

### 1. Historical contract reads are not available for TRC20 balance reconstruction

Official TRON docs for JSON-RPC `eth_call` state that the second parameter supports only `"latest"`:

- https://developers.tron.network/reference/eth_call

QuickNode's Tron `eth_call` docs say the same:

- https://www.quicknode.com/docs/tron/eth_call

Official `triggerconstantcontract` examples also show no block selector:

- https://developers.tron.network/v4.4.2/docs/smart-contract-deployment-and-invocation

Implication:

- Adding QuickNode, Alchemy, GetBlock, dRPC, or another archive-style provider will not give Pharos historical TRC20 `balanceOf()` at a target block, because the underlying Tron method surface does not support it.

### 2. TRON does have historical **account** balance APIs, but they are for TRX, not token balance snapshots

Official docs expose:

- `GetAccountBalance` / historical balance lookup
- `GetBlockBalance` / balance-changing operations in a block

Sources:

- https://developers.tron.network/reference/getaccountbalance
- https://developers.tron.network/reference/getblockbalance
- https://tronprotocol.github.io/documentation-en/api/rpc/
- https://www.alchemy.com/docs/chains/tron/tron-http-api-endpoints/tron-http-api-endpoints/get-account-balance-at-a-specific-block

But the documented response for `getaccountbalance` is `TRX` currency balance, not TRC20 token state.

Implication:

- These endpoints are useful for TRX history, not directly for USDT TRC20 blacklist attribution.

### 3. Official TRON guidance for historical token records is block parsing or indexed transaction history

TRON's wallet/exchange integration docs explicitly say:

- historical transaction records can be obtained by parsing historical blocks on your own node
- TronGrid v1 supports querying historical transaction records of an address
- TRC20 balances are queried through `triggerconstantcontract`

Source:

- https://developers.tron.network/v4.5.1/docs/exchangewallet-integrate-with-the-tron-network

Official TRON docs also expose address-level TRC20 transaction history:

- `GET /v1/accounts/{address}/transactions/trc20`
- docs note the same time window can return up to 1000 records, with fingerprint-based pagination

Sources:

- https://developers.tron.network/docs/get-trc20-transaction-history
- https://developers.tron.network/v4.4.2/reference/get-trc20-transaction-info-by-account-address

Implication:

- The viable way to recover blacklist amounts on Tron is not historical contract state.
- It is **transfer-history reconstruction**.

## Viable Solution Paths

### Option A: Reconstruct from address TRC20 transaction history

Use:

- latest token balance from `triggerconstantcontract(balanceOf)`
- account TRC20 transaction history from `/v1/accounts/{address}/transactions/trc20?contract_address=<USDT>`

Algorithm:

1. Fetch the address's current USDT balance.
2. Fetch TRC20 transfers involving that address, walking backward from now until the blacklist event timestamp.
3. Reverse-apply post-event transfers:
   - incoming after event: subtract from current balance
   - outgoing after event: add to current balance
4. Result is the balance immediately before blacklist/unblacklist.

Why this is attractive:

- It avoids replaying from genesis.
- For blacklisted addresses, post-blacklist transfer activity is often likely to be sparse.
- It can be implemented with existing TronGrid-style indexed history rather than self-hosting immediately.

Main caveats:

- You need reliable pagination/windowing around the event timestamp.
- Addresses with very heavy transfer activity may exceed practical query budgets.
- You must define a cutoff behavior when history is incomplete or paginated limits are hit.

Recommended amount status additions if implemented:

- `resolved` when reconstruction reaches the event timestamp cleanly
- `ambiguous` when pagination/history truncation prevents a trustworthy answer
- `provider_failed` on transport/indexer failure

### Option B: Build an internal Tron transfer index

Use either:

- your own TRON full node plus block parsing / event indexing
- a managed backfill/stream product to populate a transfer index you control

Official support for block parsing:

- https://developers.tron.network/v4.5.1/docs/exchangewallet-integrate-with-the-tron-network

Managed provider direction worth considering:

- QuickNode Tron archive/HTTP/gRPC support: https://www.quicknode.com/docs/tron
- QuickNode Streams / backfills for Tron: https://www.quicknode.com/streams/backfills/tron

Why this is stronger:

- Once indexed, balance-at-time reconstruction becomes deterministic and cheap.
- It removes dependence on extension-API quirks and time-window limits.
- It scales to future Tron blacklist coverage beyond USDT if ever needed.

Why this is heavier:

- Operational complexity
- storage/indexing work
- historical backfill effort

### Option C: Add a new RPC provider only

Not recommended as the primary fix.

Why:

- QuickNode advertises Tron archive support, but its `eth_call` docs still only allow `"latest"`.
- Alchemy exposes historical TRX account balance, but not historical TRC20 contract balance reads.

Sources:

- https://www.quicknode.com/docs/tron
- https://www.quicknode.com/docs/tron/eth_call
- https://www.alchemy.com/docs/chains/tron/tron-http-api-endpoints/tron-http-api-endpoints/get-account-balance-at-a-specific-block

Conclusion:

- A new RPC provider can improve reliability for event fetching or future indexing infrastructure.
- It does **not** by itself unlock Tron blacklist amount attribution.

## Recommended Path For Pharos

### Preferred near-term implementation

Implement **Option A** now:

1. add a Tron balance reconstruction helper for USDT blacklist/unblacklist events
2. use latest `balanceOf` + reverse replay of TRC20 transfer history
3. cap the search budget and mark unresolved rows `ambiguous` when history is incomplete
4. cache reconstruction results per `(address, eventTimestamp)` or at least per address checkpoint

Why this is the best effort/return ratio:

- materially improves Tron attribution without full infra build-out
- does not require unsupported historical contract-state features
- fits the existing `amount_status` model cleanly

### Preferred longer-term platform direction

If Tron attribution becomes important enough operationally, move to **Option B**:

- maintain an internal Tron transfer index, ideally from a managed stream/backfill or self-hosted node parsing
- use that index for deterministic historical balance reconstruction

## Suggested Implementation Design

### New helper

Add something like:

- `fetchTronTokenBalanceFromHistory(config, address, eventTimestampMs, currentBalance?)`

Inputs:

- contract address
- affected address
- target timestamp
- optional already-fetched latest balance

Output:

- `{ amountNative, status, transfersScanned, complete }`

### Query strategy

1. Get current balance with `triggerconstantcontract(balanceOf)`.
2. Query TRC20 transfer history for the address and USDT contract.
3. Continue paginating until all returned transfers are older than the blacklist timestamp.
4. Reverse-replay transfers newer than the event.
5. If pagination or provider limits stop early, return `ambiguous`.

### Guardrails

- max pages per row
- max transfers replayed per row
- short-circuit if current balance is zero and no post-event transfers are found
- persist provenance so reconstructed Tron amounts are marked as `amount_source = historical_balance` only when fully replayed

## Open Questions

1. How often do blacklisted Tron addresses have meaningful post-blacklist transfer activity?
2. Does TronGrid's account TRC20 history endpoint give stable reverse pagination under production load for old addresses?
3. Are there provider-side time-window filters available in practice that are not clearly surfaced in the public docs?

Those questions do not block a prototype, but they do affect whether the result should be considered production-grade immediately.

## Recommendation

Proceed with a prototype using **TRC20 history reconstruction**, not a new RPC-only integration.

If you want a provider addition, add one only to support a broader **indexed-data** strategy:

- QuickNode if you want managed Tron infrastructure plus Streams/backfills
- self-hosted TRON full node if you want maximum control

Do **not** spend time integrating a new Tron archive RPC expecting historical `balanceOf()` to work; the official method surface does not support the necessary block parameter for TRC20 reads.

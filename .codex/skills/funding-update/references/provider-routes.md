# Funding Provider Routes

Dated observations, not a contract: re-probe each run and let current provider behaviour win. Update this file when a route changes.

## Credentials In Requests

Alchemy accepts its key as an `Authorization: Bearer` header. Etherscan V2 accepts `apikey` in a form-encoded POST body while the URL carries only `chainid`. Neither key ever appears in a URL or process argument.

## Routes Observed 2026-11-15

- ERC-20: Alchemy `alchemy_getAssetTransfers`, cross-checked against `eth_getLogs` Transfer logs to the Safe from the cursor block to a pinned finalized block.
- Internal transfers: Etherscan V2 `txlistinternal` answered for chains 1, 42161 and 137 on the free tier and refused Base, Optimism and Gnosis. Alchemy offered no `internal` category on Optimism, Arbitrum or Gnosis.

## When No Internal-Transfer Index Answers

Read the Safe's `SafeReceived` events from the cursor block (or the Safe's deployment block) to a pinned block. Require the native balance change between those blocks to equal their total while the Safe executed nothing: nonce unchanged and no `ExecutionFromModuleSuccess` event. A mismatch, or any Safe execution in the window, is a coverage gap, not a clean result.

# Chain Resolution

Live registries win over this reference:

- `shared/lib/chains/index.ts` owns `CHAIN_META`, DefiLlama display-name/alias resolution through `resolveChainId`, EVM chain identifiers, and provider maps including `CG_CHAIN_MAP`.
- `worker/src/lib/chain-registry.ts` consumes and re-exports the provider chain maps used by runtime CoinGecko resolution.
- CoinGecko `/api/v3/asset_platforms` is the live resolver for `detail_platforms` keys; for EVM platforms, join its `chain_identifier` to `CHAIN_META.evmChainId` rather than maintaining a platform-name snapshot.

Only the following judgment rules are not derivable from those sources:

- In `discover` mode, treat a missing chain as material at at least $10 million for USDT/USDC and $1 million for other coins. These are audit filters, not supply or listing policy.
- A `detail_platforms` key is not necessarily the CoinGecko onchain-network slug stored under `providers.coingecko`; resolve it through `/asset_platforms`.
- Null or duplicated EVM identifiers and non-EVM platforms require official deployment evidence plus the appropriate explorer. If identity remains ambiguous, report and skip.
- Existing contract rows are curated. Official issuer evidence beats CoinGecko on conflict, but a conflict must be reported rather than silently overwritten.
- Deprecated, dead, or unsupported external chains are findings, not permission to alter the chain registry. Chain support is a separate owner-approved task.

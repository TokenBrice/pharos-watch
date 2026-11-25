---
name: stablecoin-identity-contracts
description: Verify CoinGecko and DefiLlama IDs, find chain coverage gaps, or populate verified contracts on request. Use for geckoId, llamaId and deployment audits. Not for runtime admission or chain support.
---

# Stablecoin Identity And Contracts

Choose one mode: `verify`, `populate`, or `discover`. Read the coin’s base file in `shared/data/stablecoins/coins/`, `shared/types/chain-identity.ts`, and [chain-resolution.md](references/chain-resolution.md). The base file owns scalar identity and `contracts`; generated projections are read-only. `verify` writes nothing. `populate` may patch only independently verified `contracts[]` entries and never overwrites curated rows or other base-file fields. `discover` writes only a candidates list under `agents/`.

Not for the price and supply admission proof ([stablecoin-runtime-price-marketcap-gate](../stablecoin-runtime-price-marketcap-gate/SKILL.md)), the listing class ([Listing Classes](../../../docs/listing-policy.md#listing-classes)), Mint Authority or Bridge Risk authoring, or adding chain support.

For pinned RPC reads and provenance, follow [Pinned On-Chain Evidence](../../../docs/process/agent-artifacts.md#pinned-on-chain-evidence).

## Order In An Addition

For a proposed asset, identity comes from primary deployment evidence under the shared rules, before the runtime gate and before any registry edit. The `verify` CLI knows only catalogued IDs, so it is a confirmation run after the approved entry is authored, never a pre-edit step.

## Shared Rules

- Source order is official issuer deployment material, CoinGecko structured metadata, then the relevant explorer. DefiLlama chain supply is a gap signal, never address proof.
- Issuer material is a claim until the chain agrees. Before admitting a deployment, read the token itself (explorer or pinned RPC): name, symbol and decimals, or the mint’s metadata on non-EVM chains. Confirm it is the live token and not an implementation behind a proxy, a program, a vault, an LP or a retired contract; bind the proxy, per [Editing Rules](../../../docs/stablecoin-data.md#editing-rules). An issuer page that disagrees with the on-chain identity is an unresolved conflict to report, never a row to write.
- Verify fixed decimals for ordinary token contracts; `ContractDeploymentSchema` in `shared/types/stablecoin-meta-primitives.ts` also permits explicit native bank-denom identities with unknown (`null`) decimals and requires `null` decimals for `xrpl-issued-currency` encoding. Never invent a scale or overwrite a curated deployment.
- Use only chain IDs accepted by `shared/types/chain-identity.ts`; report unsupported chains instead of adding chain support. Lowercase EVM addresses and preserve native non-EVM casing.
- `contracts[]` holds canonical supply deployments; market-traded wrappers belong in `tradedContracts[]`. One chain and address has one catalog owner across both lists, and `npm run check:stablecoin-data` rejects cross-coin collisions.
- DefiLlama list `circulating` is already USD-denominated; never multiply it by price.
- Research can stop with findings. Apply changes only when requested and patch only the permitted fields. Adding a deployment to an active asset is coupled, so resolve each before applying or return verified candidates instead of an invalid contracts-only change:
  - Bridge-route rows and, where required, Mint Authority deployment references (`shared/lib/stablecoins/schema.ts`, `shared/lib/stablecoins/mint-bridge-ownership.ts`), authored by their separately authorized owners.
  - On-chain supply: if the coin has a plan in `REVIEWED_ONCHAIN_SUPPLY_PLANS` (`shared/lib/onchain-supply-probe.ts`), every contract must be covered by the plan or an explicit exclusion. Do not add a deployment the plan cannot read.
  - DefiLlama-listed coins: a chain DefiLlama omits interacts with the aggregate gap-fill in [Supply Snapshot](../../../docs/supply-snapshot.md#coingecko-aggregate-gap-fill-limits-dec-01).
- For addition handoffs, return identity/deployment evidence, observation times, native/representation/unknown issuance, coupled sidecar owners, reviewed gaps, and proposed versus changed paths in the [addition/evidence packet](../../../docs/process/adding-a-stablecoin.md#additionevidence-handoff-packet). Do not infer issuance ownership merely from an address or chain listing.
- Generation and check ownership follows the [packet contract](../../../docs/process/adding-a-stablecoin.md#additionevidence-handoff-packet) and its [Phase 7 pass](../../../docs/process/adding-a-stablecoin.md#phase-7---validate): the coordinator in an addition, the author for a standalone approved edit. Research-only `verify` and `discover` regenerate nothing.

## `verify`

Run the fail-closed repository tool; it reads `COINGECKO_API_KEY` from the environment, the ignored root `.env.local`, or the ignored `.dev.vars` in `worker/` when present:

```bash
npm run verify:coingecko-ids -- --coin usdt-tether
npm run verify:coingecko-ids -- --scan
npm run verify:coingecko-ids -- --all
```

The tool verifies only already-catalogued IDs against their Ethereum contract. Without one, even a resolving slug is `UNAVAILABLE`; use primary deployment evidence for proposed or non-Ethereum identities. `--scan` selects only DefiLlama/config slug disagreements, not a full identity audit. `MATCH` proves the configured slug matches that contract. `MISMATCH` reports a differing contract-resolved slug or a configured slug that does not resolve. Aggregate exit status is 1 if any mismatch exists, otherwise 2 if any verification is unavailable, otherwise 0. Do not infer a slug from `UNAVAILABLE`.

`llamaId` has no tool. Fetch `https://stablecoins.llama.fi/stablecoin/<id>`, reconcile its chains and contract addresses with `contracts[]`, and check the row’s history for a retired deployment or a recycled identity. Bind only a row that reads this asset’s current deployments; otherwise report it as unbound with the reason; [Reviewed DefiLlama bindings](../../../docs/supply-snapshot.md#reviewed-defillama-bindings) holds the precedents and records a binding decision.

## `populate`

Use when the target coin and `geckoId` are known. Fetch CoinGecko coin detail and inspect `detail_platforms`; resolve every platform through the live registries/reference, skip existing chains and empty addresses, and independently verify the on-chain identity and the schema-appropriate amount encoding/decimals. Native bank-denom deployments need official rail evidence, not a guessed CoinGecko contract mapping. Present additions and conflicts before writing. Write only the `contracts[]` entries that passed verification; never overwrite curated contract rows or any other base-file field.

## `discover`

Use when chain coverage may be incomplete. Match the coin by `llamaId`, resolve `chainCirculating` labels through the live registry, apply the materiality rules in the reference, and produce a gap list first. For each requested gap, use the `populate` verification bar. Record gaps found, filled, unsupported, and unresolved in a candidates list under `agents/`; do not modify tracked base data in this mode. Process external requests sequentially to respect rate limits.

## Completion Evidence

Report the mode; each ID or deployment with its verdict, source and observation time (pinned block for on-chain reads); issuer-versus-chain conflicts and unsupported chains; the coupled owners still unresolved; proposed versus actually changed paths; and for an applied edit, `npm run check:stablecoin-data` plus the `verify` run, as observed or unexercised.

---
name: stablecoin-identity-contracts
description: Verify CoinGecko identity, discover missing stablecoin chain coverage, or populate independently verified deployments only when requested. Use for `geckoId` audits and `contracts[]` work in the Pharos stablecoin registry.
---

# Stablecoin Identity And Contracts

Choose one mode: `verify`, `populate`, or `discover`. Read the coin’s base file in `shared/data/stablecoins/coins/`, `shared/types/chain-identity.ts`, and [chain-resolution.md](references/chain-resolution.md). The base file owns scalar identity and `contracts`; generated projections are read-only. `verify` writes nothing. `populate` may patch only independently verified `contracts[]` entries and never overwrites curated rows or other base-file fields. `discover` writes only a candidates list under `agents/`.

Use `npm run research:dwellir-rpc --` for supplemental pinned on-chain evidence reads; see `docs/process/agent-artifacts.md#pinned-on-chain-evidence`.
Cite its provenance record (keyless URL, block, timestamp); never cite `latest` reads as evidence.

## Shared Rules

- Source order is official issuer deployment material, CoinGecko structured metadata, then the relevant explorer. DefiLlama chain supply is a gap signal, never address proof.
- Validate name, symbol, chain, deployment identity, and amount encoding before writing. Verify fixed decimals for ordinary token contracts; `ContractDeploymentSchema` in `shared/types/stablecoin-meta-schemas.ts` also permits explicit native bank-denom identities with unknown (`null`) decimals and requires `null` decimals for `xrpl-issued-currency` encoding. Never invent a scale or overwrite a curated deployment.
- Use only chain IDs accepted by `shared/types/chain-identity.ts`; report unsupported chains instead of adding chain support. Lowercase EVM addresses and preserve native non-EVM casing.
- DefiLlama list `circulating` is already USD-denominated; never multiply it by price.
- Research can stop with findings. Apply changes only when requested and patch only the permitted fields. Adding a second deployment to an active asset also requires bridge-route rows and may require Mint Authority deployment references (`shared/lib/stablecoins/schema.ts`, `shared/lib/stablecoins/mint-bridge-ownership.ts`); coordinate the separately authorized sidecar edits before applying. If that work is outside scope, return verified candidates instead of leaving an invalid contracts-only change.
- For addition handoffs, return identity/deployment evidence, observation times, native/representation/unknown issuance, coupled sidecar owners, reviewed gaps, and proposed versus changed paths in the [addition/evidence packet](../../../docs/process/adding-a-stablecoin.md#additionevidence-handoff-packet). Do not infer issuance ownership merely from an address or chain listing.
- In coordinated work, leave shared generation and catalog checks to the orchestrator after all specialists land; required identity evidence checks still apply. For a standalone approved edit, own the applicable [Phase 7 generation/check pass](../../../docs/process/adding-a-stablecoin.md#phase-7---validate) after all coupled source edits land. Research-only `verify`/`discover` work does not regenerate or apply data.

## `verify`

Run the fail-closed repository tool:

```bash
npm run verify:coingecko-ids -- --coin usdt-tether
npm run verify:coingecko-ids -- --scan
npm run verify:coingecko-ids -- --all
```

The tool verifies only already-catalogued IDs against their Ethereum contract. Without one, even a resolving slug is `UNAVAILABLE`; use primary deployment evidence for proposed or non-Ethereum identities. `--scan` selects only DefiLlama/config slug disagreements, not a full identity audit. `MATCH` proves the configured slug matches that contract. `MISMATCH` reports a differing contract-resolved slug or a configured slug that does not resolve. Aggregate exit status is 1 if any mismatch exists, otherwise 2 if any verification is unavailable, otherwise 0. Do not infer a slug from `UNAVAILABLE`. For active additions or promotions, follow with `stablecoin-runtime-price-marketcap-gate`.

## `populate`

Use when the target coin and `geckoId` are known. Fetch CoinGecko coin detail and inspect `detail_platforms`; resolve every platform through the live registries/reference, skip existing chains and empty addresses, and independently verify the schema-appropriate amount encoding/decimals. Native bank-denom deployments need official rail evidence, not a guessed CoinGecko contract mapping. Present additions and conflicts before writing. Write only the `contracts[]` entries that passed verification; never overwrite curated contract rows or any other base-file field.

## `discover`

Use when chain coverage may be incomplete. Match the coin by `llamaId`, resolve `chainCirculating` labels through the live registry, apply the materiality rules in the reference, and produce a gap list first. For each requested gap, use the `populate` verification bar. Record gaps found, filled, unsupported, and unresolved in a candidates list under `agents/`; do not modify tracked base data in this mode. Process external requests sequentially to respect rate limits.

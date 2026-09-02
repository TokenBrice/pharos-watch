---
name: stablecoin-identity-contracts
description: Verify CoinGecko identity, populate known stablecoin deployments, or discover missing chain coverage. Use for `geckoId` audits and `contracts[]` work in the Pharos stablecoin registry.
---

# Stablecoin Identity And Contracts

Choose one mode: `verify`, `populate`, or `discover`. Read the coin’s base file in `shared/data/stablecoins/coins/`, `shared/lib/chains/index.ts`, and [chain-resolution.md](references/chain-resolution.md). The base file owns scalar identity and `contracts`; generated projections are read-only. `verify` writes nothing. `populate` may patch only independently verified `contracts[]` entries and never overwrites curated rows or other base-file fields. `discover` writes only a candidates list under `agents/`.

## Shared Rules

- Source order is official issuer deployment material, CoinGecko structured metadata, then the relevant explorer. DefiLlama chain supply is a gap signal, never address proof.
- Validate name, symbol, chain, address, and decimals before writing. Never guess decimals or overwrite a curated contract.
- Use only chain IDs accepted by `shared/lib/chains/index.ts`; report unsupported chains instead of adding chain support. Lowercase EVM addresses and preserve native non-EVM casing.
- DefiLlama list `circulating` is already USD-denominated; never multiply it by price.
- Research can stop with findings. Apply changes only when requested, patch the smallest permitted fields for the selected mode, then run `npm run bootstrap:generated` and `npm run check:stablecoin-data`.

## `verify`

Run the fail-closed repository tool:

```bash
npm run verify:coingecko-ids -- --coin usdt-tether
npm run verify:coingecko-ids -- --scan
npm run verify:coingecko-ids -- --all
```

`MATCH` is verified. `MISMATCH` exits 1 and identifies the contract-resolved slug; edit only after confirming the token identity. `UNAVAILABLE` exits 2 and means the tool could not prove identity—do not infer a slug. For active additions or promotions, follow with `stablecoin-runtime-price-marketcap-gate`.

## `populate`

Use when the target coin and `geckoId` are known. Fetch CoinGecko coin detail and inspect `detail_platforms`; resolve every platform through the live registries/reference, skip existing chains and empty addresses, and require independently confirmed decimals. Present additions and conflicts before writing. Write only the `contracts[]` entries that passed verification; never overwrite curated contract rows or any other base-file field.

## `discover`

Use when chain coverage may be incomplete. Match the coin by `llamaId`, resolve `chainCirculating` labels through the live registry, apply the materiality rules in the reference, and produce a gap list first. For each requested gap, use the `populate` verification bar. Record gaps found, filled, unsupported, and unresolved in a candidates list under `agents/`; do not modify tracked base data in this mode. Process external requests sequentially to respect rate limits.

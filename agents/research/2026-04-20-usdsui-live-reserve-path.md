# USDsui Live Reserve Path Research - 2026-04-20

## Question

What is the actionable implementation path for enabling live reserve coverage for `usdsui-sui`?

## Current State

`usdsui-sui` is active and runtime-backed by DefiLlama:

- Pharos ID: `usdsui-sui`
- DefiLlama stablecoin id: `373`
- CoinGecko id: `usdsui`
- Pyth feed: `0xd510fcdb3a63f35d3bb118d5db3afc5815a3f13bc55d48abb893b63f0315902a`
- Chain: Sui
- Coin type: `0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI`

The current registry has curated reserve metadata but no `liveReservesConfig`, so `GET /api/stablecoin-reserves/usdsui-sui` returns `404`.

## Bridge Source Findings

Bridge’s Open Issuance docs are directly relevant and expose the right conceptual data model:

- Open Issuance says Bridge handles reserve management, compliance, and infrastructure, and that Bridge mints custom stablecoins backed 1:1 by cash and U.S. Treasuries.
- Bridge Reserve Management documents reserve allocation between liquid assets and Treasuries, including cash/stablecoin liquidity versus Treasury allocations.
- Bridge Reporting and Transparency documents real-time API endpoints for:
  - circulating stablecoin supply
  - reserve assets backing the stablecoin
  - stablecoin inventory available for swaps/orchestration

Relevant documented endpoints:

```text
GET https://api.bridge.xyz/v0/transparency/:symbol/supply
GET https://api.bridge.xyz/v0/transparency/:symbol/reserves
GET https://api.bridge.xyz/v0/transparency/:symbol/inventory
```

Bridge examples require an `Api-Key` header for all three transparency endpoints. Unauthenticated probes against likely symbols (`USDsui`, `USDSUI`, `usdsui`, `sui-dollar`, `SUIUSD`, `xUSD`) all returned:

```json
{"code":"not_allowed","message":"Invalid credentials. Please double check your API key"}
```

No Bridge API key is currently present in `.env.local` or `worker/.dev.vars`.

## Sui Source Findings

The Sui coin metadata endpoint works:

```text
suix_getCoinMetadata(USDsui coin type)
```

It returns name `Sui Dollar`, symbol `USDSUI`, decimals `6`, and metadata id `0x535e...4731`.

The generic total supply endpoint does not work for this coin:

```text
suix_getTotalSupply(USDsui coin type)
```

It returns a TreasuryCap lookup error:

```text
Cannot find object with type [0x2::coin::TreasuryCap<...::usdsui::USDSUI>] from [package] package created objects.
```

This matches known Sui behavior for some coin types where the TreasuryCap is not discoverable through the standard total-supply endpoint. Sui GraphQL may expose richer coin data, but the Mysten-hosted GraphQL endpoint was not reachable from this environment during probing, and even a working Sui supply query would only validate token supply, not reserves.

## Implementation Options

### Option A - Bridge Transparency Adapter

Add a new live reserve adapter, likely `bridge-transparency`, with `http-json` input and a required Bridge API key.

Expected behavior:

- Fetch `/transparency/:symbol/reserves`.
- Convert `accounts[]` into reserve slices:
  - `asset_class: cash` -> `Cash / bank deposits`, `very-low`
  - `managed_money_market` -> `Government money-market funds`, `very-low`
  - Treasury-like classes -> `Short-dated Treasuries / repos`, `very-low`
  - unknown classes -> explicit unknown slice or fatal/degraded depending on amount
- Fetch `/transparency/:symbol/supply` if available.
- Fetch `/transparency/:symbol/inventory` if we want redemption capacity telemetry.
- Emit:
  - `totalReserveUsd`
  - `supplyUsd`
  - `collateralizationRatio`
  - optional `metadata.redemption.capacityUsd` / `capacityRatioOfSupply` from inventory when semantics are clear
  - freshness metadata if the payload exposes a timestamp; otherwise `freshnessMode: "unverified"`

Required repo changes:

- Add `BRIDGE_API_KEY?: string` to `worker/src/lib/env.ts`.
- Add env docs/checks for the new optional key.
- Extend `AdapterContext` or scheduled runtime context to pass `bridgeApiKey`.
- Add `bridge-transparency` to:
  - `shared/types/live-reserves.ts`
  - `shared/lib/live-reserve-adapters-definitions.ts`
  - `shared/lib/live-reserve-adapters-schemas.ts`
  - `worker/src/cron/reserve-adapters/index.ts`
  - new adapter and tests
- Add `liveReservesConfig` to `usdsui-sui`, probably with:

```json
{
  "adapter": "bridge-transparency",
  "version": 1,
  "semantics": "attestation-mix",
  "breakerScope": "bridge-open-issuance-usdsui",
  "display": {
    "url": "https://apidocs.bridge.xyz/platform/issuance/reporting-and-transparency",
    "label": "Bridge Transparency API"
  },
  "inputs": {
    "primary": {
      "kind": "http-json",
      "url": "https://api.bridge.xyz/v0/transparency/USDsui/reserves"
    }
  },
  "params": {
    "symbol": "USDsui",
    "supplyUrl": "https://api.bridge.xyz/v0/transparency/USDsui/supply",
    "inventoryUrl": "https://api.bridge.xyz/v0/transparency/USDsui/inventory"
  }
}
```

Exact symbol casing must be confirmed with a real Bridge API key.

Pros:

- Only path that can be actual reserve evidence.
- Can become detail-visible immediately.
- Can be scoring-eligible if Bridge exposes trustworthy timestamps or current same-run API evidence and payloads are clean.
- Can later support other Bridge-issued assets such as CASH or potentially MUSD-like issuer rails if their transparency endpoints are accessible.

Cons:

- Requires a Bridge API key.
- Requires confirmation that USDsui is accessible to the key and which `:symbol` Bridge expects.
- If the endpoint lacks timestamps, this should start as `unverified` freshness and likely not score-grade.

### Option B - Generic Sui Supply Probe / Curated-Validated

Add `onchain-sui` input support and let `curated-validated` return the static `reserves[]` after a non-zero Sui supply check.

Pros:

- Does not require Bridge API access if a robust Sui supply source is found.
- Gives `/api/stablecoin-reserves/usdsui-sui` a `curated-validated` response.

Cons:

- The standard JSON-RPC supply method failed for USDsui.
- Even if a GraphQL/indexer supply query works, it proves only token supply, not reserve backing.
- This would be weaker than the current curated metadata in terms of reserve evidence; it mainly removes the 404.
- It adds non-EVM adapter surface for a low-evidence result.

This is not the best path unless the product goal is simply to avoid a reserve 404 and clearly label the result as curated-validated/static.

### Option C - DefiLlama-Based Reserve Probe

Use DefiLlama stablecoin supply as a liveness/supply source, then return static curated reserve slices.

Pros:

- Already accessible and works for USDsui id `373`.
- No new external credential.

Cons:

- DefiLlama is not reserve evidence.
- Existing `single-asset` JSON-path adapter cannot search the DefiLlama list payload by id.
- A bespoke DefiLlama reserve adapter would be semantically misleading unless clearly named as supply-liveness validation.

This is not recommended for live reserves.

## Recommendation

Best implementation path: **Option A, a Bridge Transparency API adapter**, gated on obtaining a Bridge API key and confirming the USDsui symbol/endpoint shape.

Do not implement `onchain-sui` first unless the goal is only a weak, curated-validated detail card. It cannot produce reserve composition, and the obvious Sui JSON-RPC total-supply method already fails for USDsui.

## Suggested Next Steps

1. Obtain or configure `BRIDGE_API_KEY` in local `.env.local`, worker secrets, and GitHub deploy secrets if production sync should use it.
2. Manually test:

```bash
curl -H "Api-Key: $BRIDGE_API_KEY" \
  "https://api.bridge.xyz/v0/transparency/USDsui/reserves"

curl -H "Api-Key: $BRIDGE_API_KEY" \
  "https://api.bridge.xyz/v0/transparency/USDsui/supply"

curl -H "Api-Key: $BRIDGE_API_KEY" \
  "https://api.bridge.xyz/v0/transparency/USDsui/inventory"
```

3. If those return USDsui data, implement `bridge-transparency`.
4. If the API key returns 404 for `USDsui`, try Bridge’s exact symbol variants only with the key: `USDSUI`, `usdsui`, and any internal symbol shown in the dashboard.
5. If Bridge cannot expose USDsui transparency data, keep the current static reserve coverage and do not enable live reserves.

## Sources

- Bridge Open Issuance overview: https://apidocs.bridge.xyz/platform/issuance/overview
- Bridge Reserve Management: https://apidocs.bridge.xyz/platform/issuance/reserve-management
- Bridge Reporting and Transparency: https://apidocs.bridge.xyz/platform/issuance/reporting-and-transparency
- Bridge stablecoins FAQ: https://apidocs.bridge.xyz/platform/issuance/faq
- Current USDsui registry row: `shared/data/stablecoins/usd-minor.json`

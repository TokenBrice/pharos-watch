# evaUSDC/evaUSDT Detail Page Root Cause And Remediation Plan

Date: 2026-04-11

## Evidence

- `evausdc-eva` and `evausdt-eva` are present in `shared/data/stablecoins/usd-minor.json`, `shared/data/stablecoins/canonical-order.json`, `data/logos.json`, and `data/ai-summaries.json`.
- `npm run check:stablecoin-data` currently passes, so the existing data validation does not catch the broken state.
- Live `https://pharos.watch/_site-data/stablecoins` returns `200` but neither Eva ID is present in `peggedAssets`.
- Live `https://api.pharos.watch/api/og/stablecoin/evausdc-eva` and `.../evausdt-eva` return `404` with a 29-byte body, matching `Stablecoin not found in cache` from the Worker OG handler.
- DefiLlama stablecoins search for `eva` returns no rows, and CoinGecko search for `evausdc` / `evausdt` returns no rows as of this investigation.
- Ethereum `totalSupply()` probes for the curated contracts return non-zero supplies:
  - `evausdc-eva`: `2,482,931.592169`
  - `evausdt-eva`: `2,394,333.229845`

## Root Cause

The static Pages route uses `TRACKED_STABLECOINS`, so the Eva detail pages exist once the registry JSON is deployed. The Worker `/api/stablecoins` cache is populated by DefiLlama rows remapped through `llamaId`, plus supplemental rows selected by the sync pipeline:

- commodities with a `geckoId`
- fiat assets marked `detailProvider === "coingecko"`

Eva has no `llamaId`, no `geckoId`, and no `detailProvider`, so it is tracked statically but invisible to the runtime stablecoins cache. The client detail view model then treats the absent list row as a not-found state, and the OG handler returns `Stablecoin not found in cache`.

This is a process/guardrail gap, not a rendering bug.

## Implementation Plan V1

1. Add `detailProvider: "coingecko"` to `evausdc-eva` and `evausdt-eva`.
   - This uses the existing supplemental on-chain total-supply fallback for active fiat assets with contracts and no CoinGecko row.
   - Do not add manual supply overrides.

2. Strengthen `scripts/check-stablecoin-data.ts`.
   - Fail active assets that lack a runtime `/api/stablecoins` cache admission path.
   - Accept these paths:
     - `llamaId`
     - `detailProvider: "coingecko"` with either `geckoId` or a supported on-chain supply contract
     - `GOLD` / `SILVER` assets with `geckoId`
   - Emit stablecoin ID-specific error messages.

3. Update process/docs.
   - Update `agents/process/adding-a-stablecoin.md` to require explicit runtime-admission evaluation for every active asset.
   - Update `docs/scripts.md` so the `check-stablecoin-data` inventory reflects the new guard.

4. Validate.
   - `npm run check:stablecoin-data`
   - targeted stablecoin metadata tests
   - `npm run lint`
   - `npm test`
   - `npm run build`
   - `cd worker && npx tsc --noEmit`

## Review Loop

### Review 1

Issues found:

- Medium: V1 fixes Eva, but the validation wording must distinguish static tracking from runtime cache admission. Otherwise a future reviewer may think `canonical-order.json` alone is enough.
- Low: V1 does not mention that `detailProvider: "coingecko"` without `geckoId` is intentionally allowed only when an on-chain fallback contract exists.

Fixes applied in V2:

- Make validation error messages explicitly refer to `/api/stablecoins` cache admission.
- Document the `detailProvider: "coingecko"` plus supported-contract fallback in the process doc.

### Review 2

Issues found:

- Low: The plan could accidentally broaden the Worker supplemental selector if implemented in runtime code instead of metadata validation.

Fixes applied in V3:

- Keep the Worker sync selector unchanged.
- Implement the recurrence fix as data metadata plus CI/process validation only.

### Review 3

Open issues: none.

## Final Plan V3

1. Add `detailProvider: "coingecko"` to the two Eva metadata entries.
2. Add a stablecoin-data validation rule that active assets must have a `/api/stablecoins` cache admission path: `llamaId`, `detailProvider: "coingecko"` with `geckoId` or a supported on-chain supply contract, or commodity `geckoId`.
3. Update `agents/process/adding-a-stablecoin.md` with an explicit active-asset runtime-admission checklist.
4. Update `docs/scripts.md` to describe the stronger `check-stablecoin-data` guard.
5. Run targeted validation, then broader lint/test/build/worker typecheck as time allows.

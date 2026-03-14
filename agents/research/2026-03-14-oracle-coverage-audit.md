# Oracle Coverage Audit: Pyth + RedStone

Date: 2026-03-14

## Scope

Audit current code-path coverage and live oracle availability for the recently added Pyth Network and RedStone price sources in the primary pricing pipeline.

## Current implementation findings

### Pyth

- Metadata coverage in repo: `11` tracked assets carry `pythFeedId` in `shared/lib/stablecoins.ts`.
- Runtime coverage today appears to be `0`.
- Root cause: `worker/src/lib/pyth.ts` stores reverse-map keys with the `0x` prefix, but Hermes `parsed[].id` values are returned without `0x`, so no returned feed maps back to a tracked asset.
- Live verification:
  - `fetchPythPrices()` with all 11 mapped IDs returned `0` results.
  - Direct Hermes response includes both `binary` and `parsed`; `parsed[0].id` is unprefixed.

### RedStone

- Intended query scope in repo: all unique tracked symbols with `geckoId`, currently uppercased in `worker/src/cron/enrich-prices.ts`.
- Runtime coverage today appears to be `0`.
- Root causes:
  - `worker/src/lib/redstone.ts` expects each symbol value to be an array, but the live API returns a single object per symbol for `provider=redstone-primary-prod`.
  - The function catches the resulting `TypeError` and returns an empty map, so the caller records the fetch as successful even though no prices were produced.
  - The cron uppercases symbols for RedStone, but live RedStone symbol matching is case-sensitive for assets like `USDe`, `crvUSD`, and `fxUSD`.
  - Multi-symbol batch requests are lossy for some symbols: `TUSD` resolves alone, but disappears when batched with `USDT`.

## Live coverage potential

### Pyth

- Current mapped assets: `11`
- Live symbol search matches across tracked symbols: `48`
- Additional tracked symbols with matching Pyth USD feeds beyond current mapping: `38`
- Of those `38`, about `30` are straightforward `Crypto` feeds; `8` are special-semantics feeds (`Crypto Redemption Rate`, `Crypto NAV`, deprecated feeds, or collateralization-oriented descriptions).

High-confidence extension candidates include:

- `RLUSD`
- `USD1`
- `USD0`
- `USDD`
- `USDP`
- `GUSD`
- `USDH`
- `PAXG`
- `XAUT`
- `EURCV`
- `MIM`
- `AUSD`
- `AUDD`
- `XSGD`
- `USDB`
- `USDN`
- `USDTB`
- `USTB`
- `USDY`

Lower-confidence / special-semantics candidates that need manual review before promotion into the main consensus:

- Deprecated feeds: `LUSD`, `NECT`, `USDU`
- Redemption-rate style feeds: `HONEY`, `USR`, `SUSD`, `USYC`
- Non-price semantics: `USX` (collateralization-oriented feed description)

### RedStone

- Exact-case batch sweep found `19` tracked symbols returning prices.
- Single-symbol probing found `30` tracked symbols returning prices.
- Conclusion: the live oracle covers materially more names than the current batch integration reveals, but request strategy matters. Large mixed batches drop valid symbols such as `TUSD`.

Tracked symbols observed via single-symbol RedStone responses:

- `USDT`
- `USDC`
- `USDe`
- `USD1`
- `DAI`
- `PYUSD`
- `USDf`
- `USDD`
- `GHO`
- `FDUSD`
- `USR`
- `crvUSD`
- `FRAX`
- `DOLA`
- `USDH`
- `USDP`
- `MUSD`
- `SUSD`
- `TUSD`
- `LUSD`
- `fxUSD`
- `HONEY`
- `ALUSD`
- `OUSD`
- `XSGD`
- `GYEN`
- `EURS`
- `XAUT`
- `PAXG`
- `CEUR`

Symbols confirmed missing from current RedStone responses despite being interesting candidates:

- `USDS`
- `EURC`
- `RLUSD`

Observed API behavior to account for in implementation:

- `TUSD` returns in a single-symbol request but is dropped from `USDT,TUSD`.
- The current `provider=redstone-primary-prod` response shape is object-per-symbol, not array-per-symbol.
- One single-symbol probe for `GUSD` returned HTTP `500`, suggesting spotty edge reliability for some assets.

## Recommended next steps

1. Fix current runtime bugs before extending coverage.
2. Pyth:
   - Normalize feed IDs by stripping `0x` on both request bookkeeping and response matching.
   - After the bug fix, add high-confidence feed IDs from the candidate set.
3. RedStone:
   - Update the client to accept the live object response shape.
   - Stop uppercasing RedStone symbols.
   - Use smaller batches or single-symbol fallback for symbols that disappear in mixed requests.
4. Treat source-health reporting carefully:
   - both oracle clients can currently fail to contribute prices while still being recorded as successful at the cron layer.

# CCIP Mint/Burn Final Audit

Date: 2026-03-04
Scope: Ethereum mint-burn CCIP bridge classification rollout for Burn/Mint pool tokens.

## Discovery Baseline

Primary source: https://docs.chain.link/ccip/directory/mainnet

Eligible Burn/Mint tokens (Ethereum, address-matched):

- `2` `USDC` (`0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`) pool `0x03d19033ada17750d5bc2d8e325337d0748f9fef`
- `241` `USDO` (`0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe`) pool `0x500d4882938020e939a5666c1b4200873da7efd3`
- `262` `USD1` (`0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d`) pool `0x36a72ed0096b414521c45e3ddc9ed657d1d9c141`
- `271` `avUSD` (`0xf4c13d631450de6b12a19829e37c8e2826891dc4`) pool `0x81b72171642fab457aa815c0b8412a22b63a6af8`

Excluded Lock/Release tokens on Ethereum:

- `1` `USDT`, `118` `GHO`, `195` `USD0`, `246` `USDf`, `269` `BOLD`, `cg-syrupusdc`, `cg-syrupusdt`

## Deployment

Worker deploys completed:

1. `f2902492-6f53-471b-a66b-f96206db48c8`
2. `239234f0-4cac-4494-b452-b67709b94254` (final corrective deploy)

Final deploy includes CCIP bridgeDetection config for `USDC`, `USDO`, `USD1`, `avUSD` plus baseline `ZCHF`.

## Historical Reclassification Backfill

### USDO (`241`)

- Full backfill completed from `21900000` to chain head.
- Final reclassification pass summary:
  - `bridge`: `42`
  - `review`: `1`
  - `effective`: `640`
  - `rowsReclassified`: `683`

### avUSD (`271`)

- Full backfill completed from `21900000` to chain head.
- Final reclassification pass summary:
  - `bridge`: `29`
  - `review`: `0`
  - `effective`: `0`
  - `rowsReclassified`: `29`

### USDC (`2`) and USD1 (`262`)

- Validation query result: no pool-address burn rows currently present.
- `USDC`: `pool_burns=0`
- `USD1`: `pool_burns=0`

No historical bridge-burn rows existed to reclassify for these two assets at execution time.

## Post-Rollout Validation

### DB validation (pool-address burn types)

- `USDO (241)`: `42 bridge_burn`, `1 review_required`
- `avUSD (271)`: `29 bridge_burn`
- `USDC (2)`: `0 pool burns`
- `USD1 (262)`: `0 pool burns`

### API validation

- `GET /api/mint-burn-events?stablecoin=241&burnType=bridge_burn` -> `total=42`
- `GET /api/mint-burn-events?stablecoin=271&burnType=bridge_burn` -> `total=29`
- `GET /api/mint-burn-events?stablecoin=2&burnType=bridge_burn` -> `total=0`
- `GET /api/mint-burn-events?stablecoin=262&burnType=bridge_burn` -> `total=0`

### Sample corrected bridge-burn tx

- `avUSD`: `0xd6c4281ce4f053511e86004257ab11c33d0601cb9165196f8a59a7988506d690`
- Event now classified as `bridge_burn` after final deploy and corrective backfill.

## Residual Risk / Notes

- `USDO` has `1` `review_required` pool burn remaining, indicating missing/ambiguous bridge signal for that tx context.
- No Lock/Release tokens were configured for bridge-burn processing.
- Future additions must follow Chainlink directory filter (`Burn/Mint` on Ethereum only).

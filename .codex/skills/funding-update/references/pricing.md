# Receipt-Time Pricing

Every row is priced once, at the transfer's block date, and records its provenance in `price_note`. Pricing is not spam approval.

| Asset | Rule |
| --- | --- |
| Qualifying USD-pegged stablecoin | 1:1, only after the `(chain, token_address)` match. |
| Qualifying coin pegged to another fiat currency | Receipt-date ECB reference rate, below. Never 1:1 and never a current rate. |
| Qualifying coin pegged to anything else | Needs a reviewed pricing rule added here before it is admitted. |
| ETH, MATIC/POL, WBTC | CoinGecko history for the UTC receipt date. |
| Any other token | User-supplied USD value and source. Never auto-resolve an unknown contract through CoinGecko. |

## Non-USD Fiat Coins

The non-USD set is every entry of `DONOR_KEY_QUALIFYING_STABLECOINS` (`shared/lib/funding/donor-eligibility.ts`) whose catalog `flags.pegCurrency` in `shared/data/stablecoins/coins/<stablecoinId>.json` is not USD (absent means USD). Derive it from those files each run; do not keep a ticker list.

1. `GET https://api.frankfurter.dev/v1/{date}?base={CCY}&symbols=USD` for the UTC receipt date.
2. `usd_at_receipt = round(amount_decimal × rates.USD, 6)`.
3. `price_note = "ecb-{ccy}usd-{response.date}@{rate}"`, lowercase currency (for example `ecb-eurusd-…`), using the rate date actually served, which can precede a weekend or holiday receipt.

Hold the row when the lookup fails.

## Unpriced Receipts

A user-approved receipt that cannot be priced is recorded with `usd_at_receipt: 0` and exactly `price_note: "manual-token-not-priced"` (`isUnpricedDonation` in `shared/lib/funding/helpers.ts`), so the donor wall shows "—" rather than $0. Never use that note on a priced row.

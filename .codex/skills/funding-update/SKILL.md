---
name: funding-update
description: Update Pharos funding donations by reconciling inbound transfers, rejecting wallet self-activity and spam, pricing receipt-time value, and appending user-approved rows.
user_invocable: true
---

Read `docs/editorial-style.md` before writing; its `technical-evidence` register governs prose.

# Funding Donations Update

Maintain `shared/data/funding/donations.json` for the `pharos-watch.eth` Safe at `0x5d698362edb8aea1c2b2483096bdee3265d860db` on Ethereum, Base, Optimism, Arbitrum, Polygon, and Gnosis. Never edit `shared/data/funding/costs.json` or historical donation rows without explicit approval. When an approved correction leaves an address with less than `$10` in qualifying stablecoin donations, the operator must also deactivate the `donor` API key issued to that address (`docs/api-reference-admin.md`); eligibility is checked only at claim time, so the ledger edit revokes nothing by itself. Preserve its claim row to prevent reissuance. Later Safety Score changes alone do not revoke already-issued keys.

## Safety And Inputs

- Check `ALCHEMY_API_KEY`, `ETHERSCAN_API_KEY`, and `COINGECKO_API_KEY` by name in the process environment, ignored root `.env.local`, and documented provider source. Never print, copy, execute, or place secrets in URLs/process arguments; use request headers or stdin.
- Use web fetch, RPC/API requests, and browser inspection by capability; see `docs/process/agent-artifacts.md#harness-configuration`.
- Every candidate requires transaction/receipt reconciliation and user approval. A clean-looking inbound transfer can be the Safe swapping or bridging its own funds.

## Reconciliation

1. Read donations and derive the highest `block_timestamp` per chain. Read costs only to report current funding context. If source coverage widened since the prior run, also scan the affected chain below its cursor and report candidates; cursors otherwise hide missed history.
2. Query currently supported provider APIs for inbound native, internal, and ERC-20 transfers on all six chains. Determine supported categories at run time, record every coverage gap, consume error bodies, and honor status/rate-limit retry guidance. A failed or partial query is unavailable, never an empty result.
3. Keep rows newer than each chain cursor and normalize chain, lowercase transaction hash and sender, timestamp, decimal amount, and symbol. Record the token contract as `token_address` on every appended row — lowercase `0x` plus 40 hex for ERC-20 transfers, `null` for native assets (ETH on any chain, POL/MATIC, xDAI) — immediately after `asset_symbol`. Record `from_address` as the asset-transfer sender: the ERC-20 `Transfer.from` or the internal call's `from`, never the transaction signer, relayer, or bundler. Payout, router, bridge, and splitter contract senders are `kind: "pool"`; wallet senders stay `community`.
4. For every candidate, fetch the transaction and receipt. Reject Safe `execTransaction` calls to the wallet and any transaction with an outbound native or ERC-20 leg from the wallet. Report these as self-activity, not donations or spam.
5. Compare full sender addresses and token contracts to detect address-poisoning and ticker spoofing. Present survivors to the user; discard rows they identify as spam. Never auto-approve.
6. Resolve stablecoin identity by `(chain, token_address)` with `resolveDonorKeyQualifyingStablecoin` in `shared/lib/funding/donor-eligibility.ts`, and write the qualifying ledger symbol only on a match. Any other contract keeps its uppercased on-chain ticker; if that ticker equals a qualifying symbol, suffix it with the first 4 hex characters of the contract (for example `USDP-0x1456`) so it can never be mistaken for the qualifying coin. Never infer identity from token name, ticker, peg, or price.
7. Price qualifying USD-pegged stablecoins at 1:1 only after the contract match. Price EURC at the ECB EUR/USD reference rate for the UTC receipt date: `GET https://api.frankfurter.dev/v1/{date}?base=EUR&symbols=USD`, then `usd_at_receipt = round(amount_decimal × rates.USD, 6)` and `price_note = "ecb-eurusd-{response.date}@{rate}"` using the rate date actually served, which can precede a weekend or holiday receipt. Never price EURC at 1:1 or a current rate; hold the row when the lookup fails. Price ETH/MATIC/WBTC from CoinGecko history on the UTC receipt date. For any other token, require user-supplied USD value and source; never auto-resolve an unknown contract through CoinGecko.
8. Reuse an existing donor label. Otherwise reverse-resolve ENS and forward-resolve it back to the exact address; if either step fails, store the address. Founder and pool labels require prior ledger evidence or user confirmation.

## Approval And Write

Show each proposed row with chain, transaction, asset/amount, receipt-time USD value/source, donor display/kind, plus rejected self-activity and incomplete coverage. After explicit approval, append rows in ascending timestamp order and update `last_updated_at`. If no approved rows remain, make no edits.

Also list the addresses whose approved rows bring their qualifying lifetime total to `$10` or more in `usd_at_receipt`, summed per lowercase address over stablecoin donations only, excluding `pool` rows. The threshold is inclusive, so exactly `$10` qualifies; ETH and other non-stablecoin assets do not, and founder stablecoin rows count. Only externally-owned wallets can claim; smart-contract wallets cannot claim yet. Eligibility is contract-keyed over the reviewed list in `DONOR_KEY_QUALIFYING_STABLECOINS` in `shared/lib/funding/donor-eligibility.ts` (the source file wins over any summary of it): resolve `(chain, token_address)` with `resolveDonorKeyQualifyingStablecoin` there and reuse its threshold calculation. The five coins grandfathered from symbol-keyed eligibility keep every catalog contract on the six funding chains; coins added with contract keying count only on issuer-documented deployments, so bridged or same-ticker tokens never qualify. Adding a coin or deployment needs curation review plus the drift-test update in the `shared/lib/funding` suite. Only stablecoins graded A+, A, A-, B+, B, or B- in the current non-held canonical accepted V9 Safety Score publication at claim time count. C/D/F/NR or missing grades do not count; an unavailable, missing, or held publication pauses claims with `503`. Values remain USD at receipt, not claim-time prices. Later grade changes do not revoke or alter an issued key. Report these externally-owned wallets as potential beneficiaries, not guaranteed eligible wallets: the ledger must ship in a release and grades are checked at claim time. The Worker reads donations from the committed file and grades from the current accepted publication. Report that release requirement with the list.

Validate the actual edited file through the same schema used by the funding page, then run the focused funding suite (it includes the committed-ledger consistency test):

```bash
node --import tsx --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { DonationsFileSchema } from "./shared/lib/funding/schema.ts";
DonationsFileSchema.parse(JSON.parse(readFileSync("shared/data/funding/donations.json", "utf8")));
NODE
npx vitest run shared/lib/funding
```

Run `npm run build` when page rendering changes or an explicit production-build rehearsal is requested. Schema validation does not replace transaction reconciliation or approval of each proposed row.

Report approved additions, rejected/self/spam rows, pricing/ENS uncertainty, coverage gaps, and check results. Publishing is a separate `pharos-release-runner` task.

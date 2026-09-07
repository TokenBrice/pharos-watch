---
name: funding-update
description: Update Pharos funding donations by reconciling inbound transfers, rejecting wallet self-activity and spam, pricing receipt-time value, and appending user-approved rows.
user_invocable: true
---

Read `docs/editorial-style.md` before writing; its `technical-evidence` register governs prose.

# Funding Donations Update

Maintain `shared/data/funding/donations.json` for the `pharos-watch.eth` Safe at `0x5d698362edb8aea1c2b2483096bdee3265d860db` on Ethereum, Base, Optimism, Arbitrum, Polygon, and Gnosis. Never edit `shared/data/funding/costs.json` or historical donation rows without explicit approval. When an approved correction leaves an address with `$10` or less in qualifying stablecoin donations, the operator must also deactivate the `donor` API key issued to that address (`docs/api-reference-admin.md`); eligibility is checked only at claim time, so the ledger edit revokes nothing by itself. Preserve its claim row to prevent reissuance. Later Safety Score changes alone do not revoke already-issued keys.

## Safety And Inputs

- Check `ALCHEMY_API_KEY`, `ETHERSCAN_API_KEY`, and `COINGECKO_API_KEY` by name in the process environment, ignored root `.env.local`, and documented provider source. Never print, copy, execute, or place secrets in URLs/process arguments; use request headers or stdin.
- Use web fetch, RPC/API requests, and browser inspection by capability; see `docs/process/agent-artifacts.md#harness-configuration`.
- Every candidate requires transaction/receipt reconciliation and user approval. A clean-looking inbound transfer can be the Safe swapping or bridging its own funds.

## Reconciliation

1. Read donations and derive the highest `block_timestamp` per chain. Read costs only to report current funding context. If source coverage widened since the prior run, also scan the affected chain below its cursor and report candidates; cursors otherwise hide missed history.
2. Query currently supported provider APIs for inbound native, internal, and ERC-20 transfers on all six chains. Determine supported categories at run time, record every coverage gap, consume error bodies, and honor status/rate-limit retry guidance. A failed or partial query is unavailable, never an empty result.
3. Keep rows newer than each chain cursor and normalize chain, lowercase transaction hash/sender/token address, timestamp, symbol, decimal amount, and nullable token address. Preserve the native token address as null.
4. For every candidate, fetch the transaction and receipt. Reject Safe `execTransaction` calls to the wallet and any transaction with an outbound native or ERC-20 leg from the wallet. Report these as self-activity, not donations or spam.
5. Compare full sender addresses and token contracts to detect address-poisoning and ticker spoofing. Present survivors to the user; discard rows they identify as spam. Never auto-approve.
6. Before stablecoin 1:1 pricing, match the captured token contract to the canonical contract for that chain. Price ETH/MATIC/WBTC from CoinGecko history on the UTC receipt date. For any other token, require user-supplied USD value and source; never auto-resolve an unknown contract through CoinGecko.
7. Reuse an existing donor label. Otherwise reverse-resolve ENS and forward-resolve it back to the exact address; if either step fails, store the address. Founder and pool labels require prior ledger evidence or user confirmation.

## Approval And Write

Show each proposed row with chain, transaction, asset/amount, receipt-time USD value/source, donor display/kind, plus rejected self-activity and incomplete coverage. After explicit approval, append rows in ascending timestamp order and update `last_updated_at`. If no approved rows remain, make no edits.

Also list the addresses whose approved rows push their qualifying lifetime total strictly above `$10` in `usd_at_receipt`, summed per lowercase address over stablecoin donations only, excluding `pool` rows. Exactly `$10`, ETH, and other non-stablecoin assets do not qualify; founder stablecoin rows count. Reuse `shared/lib/funding/donor-eligibility.ts` for the reviewed stablecoin symbol-to-canonical-ID mapping and threshold calculation. Only stablecoins graded A+, A, A-, B+, B, or B- in the current non-held canonical accepted V9 Safety Score publication at claim time count. C/D/F/NR or missing grades do not count; an unavailable, missing, or held publication pauses claims with `503`. Values remain USD at receipt, not claim-time prices. Later grade changes do not revoke or alter an issued key. Verify token contracts during curation; require a reviewed helper allowlist update for a newly supported stablecoin. Report these externally-owned wallets as potential beneficiaries, not guaranteed eligible wallets: the ledger must ship in a release and grades are checked at claim time. The Worker reads donations from the committed file and grades from the current accepted publication. Report that release requirement with the list.

Validate the actual edited file through the same schema used by the funding page, then run the focused calculations:

```bash
node --import tsx --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { DonationsFileSchema } from "./shared/lib/funding/schema.ts";
DonationsFileSchema.parse(JSON.parse(readFileSync("shared/data/funding/donations.json", "utf8")));
NODE
npx vitest run shared/lib/funding/__tests__/helpers.test.ts
```

Run `npm run build` when page rendering changes or an explicit production-build rehearsal is requested. Schema validation does not replace transaction reconciliation or approval of each proposed row.

Report approved additions, rejected/self/spam rows, pricing/ENS uncertainty, coverage gaps, and check results. Publishing is a separate `pharos-release-runner` task.

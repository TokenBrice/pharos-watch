---
name: funding-update
description: Reconcile inbound funding transfers, reject self-activity and spam, price receipts, and append approved donation rows. Use for the weekly funding ledger update. Not for costs.json edits or publishing.
---

Read `docs/editorial-style.md` before writing; its `technical-evidence` register governs prose.

# Funding Donations Update

Maintain `shared/data/funding/donations.json` for the `pharos-watch.eth` Safe at `0x5d698362edb8aea1c2b2483096bdee3265d860db` on the chains admitted by `DonationSchema` in `shared/lib/funding/schema.ts` (the source file wins). The run is weekly, on Sunday: public copy promises that a donation becomes claimable once that reconciliation ships ([Funding](../../../docs/funding-page.md#supporter-key)).

Never edit `shared/data/funding/costs.json` or historical donation rows without explicit approval. When an approved correction leaves an address below `DONOR_API_KEY_MIN_USD` in counted donations, the operator must also deactivate the `donor` API key issued to that address (`POST /api/api-keys/:id/deactivate`, `docs/api-reference-admin.md`): eligibility is checked only at claim time, so the ledger edit revokes nothing by itself. Preserve its claim row to prevent reissuance. Later Safety Score changes alone do not revoke issued keys.

For pinned RPC reads and provenance, follow [Pinned On-Chain Evidence](../../../docs/process/agent-artifacts.md#pinned-on-chain-evidence).

## Safety And Inputs

- Check `ALCHEMY_API_KEY`, `ETHERSCAN_API_KEY`, and `COINGECKO_API_KEY` by name in the process environment, ignored root `.env.local`, the ignored Worker `.dev.vars`, and the documented provider source. Never print, copy, execute, or place secrets in URLs or process arguments; use request headers, request bodies or stdin.
- The run needs web fetch, JSON-RPC and provider API requests, and a browser or explorer view for transaction inspection; use whatever the session provides for each.
- Every candidate requires transaction and receipt reconciliation and user approval. A clean-looking inbound transfer can be the Safe swapping or bridging its own funds.

## Reconciliation

1. Read donations and derive the highest `block_timestamp` per chain. Read costs only to report current funding context. If source coverage widened since the prior run, also scan the affected chain below its cursor and report candidates; cursors otherwise hide missed history.
2. Query provider APIs for inbound native, internal, and ERC-20 transfers on every admitted funding chain, following [provider-routes.md](references/provider-routes.md). Determine supported categories at run time, record every coverage gap, consume error bodies, and honor status and rate-limit retry guidance. A failed or partial query is unavailable, never an empty result.
3. Keep rows newer than each chain cursor and normalize chain, lowercase transaction hash and sender, timestamp, decimal amount, and symbol. Record the token contract as `token_address` on every appended row, immediately after `asset_symbol`: lowercase `0x` plus 40 hex for ERC-20 transfers, `null` for native assets (ETH on any chain, POL/MATIC, xDAI). Record `from_address` as the asset-transfer sender (the ERC-20 `Transfer.from` or the internal call's `from`), never the transaction signer, relayer, or bundler.
4. Set `kind`. Payout, router, bridge, and splitter contract senders are `pool`; wallet senders stay `community`. A payment for a partner API key is `revenue`: never `community`, never auto-approved, and excluded from donation totals, donor counts and supporter-key eligibility. The commercial and institutional price constants in `shared/lib/public-api-contract.ts` help recognize one, but the amount need not equal a list price; ask the user when unsure.
5. For every candidate, fetch the transaction and receipt. Reject Safe `execTransaction` calls to the wallet and any transaction with an outbound native or ERC-20 leg from the wallet. Report these as self-activity, not donations or spam.
6. Compare full sender addresses and token contracts to detect address-poisoning and ticker spoofing. Present survivors to the user; discard rows they identify as spam. Never auto-approve.
7. Resolve stablecoin identity by `(chain, token_address)` with `resolveDonorKeyQualifyingStablecoin` in `shared/lib/funding/donor-eligibility.ts`, and write the qualifying ledger symbol only on a match. Any other contract keeps its uppercased on-chain ticker; if that ticker equals a qualifying symbol, suffix it with the first 4 hex characters of the contract (for example `USDP-0x1456`). Never infer identity from token name, ticker, peg, or price.
8. Price at receipt time per [pricing.md](references/pricing.md): a qualifying USD-pegged stablecoin is 1:1 only after the contract match; every other asset follows that file's rule or is held.
9. Label the row. A `revenue` row always uses `"display": "API partner"`: never an ENS name, an address label or the partner's name. Otherwise reuse an existing donor label, or reverse-resolve ENS and forward-resolve it back to the exact address; if either step fails, store the address. Founder and pool labels require prior ledger evidence or user confirmation.

## Approval And Write

Show each proposed row with chain, transaction, asset and amount, receipt-time USD value and source, donor display and kind, plus rejected self-activity and incomplete coverage. After explicit approval, append rows in ascending timestamp order and update `last_updated_at`. If no approved rows remain, make no edits.

A typed transfer (`transfer_discriminator`) that replaces a published transaction-keyed donation must carry `legacy_credit: true` with the original sender, token, block timestamp and amount; the PR gate enforces this with `scripts/ci/check-donation-ledger-transition.ts` against the base revision.

Also list potential supporter-key beneficiaries: wallets whose approved rows first reach the inclusive `DONOR_API_KEY_MIN_USD` (`shared/lib/ops-limits.ts`), and already-eligible wallets whose new counted rows buy further days under `creditDonorKey`. Compute with `summarizeDonorKeyEligibility` or `sumEligibleDonationsByAddress` and current accepted grades; both value at receipt-time USD and exclude `pool` and `revenue` rows. The [claim contract](../../../docs/api-page.md#supporter-key-claim-contract) and [API auth](../../../docs/api-reference.md#public-api-auth) own counting, grade bands, claim pauses and expiry. Call them potential beneficiaries: the ledger must ship first and grades are checked at claim time. A new qualifying coin or deployment needs curation review plus the drift-test update in the focused funding suite.

Validate with the focused funding suite, which parses the committed ledger with `TransferDonationsFileSchema` (the schema the funding page and the claims Worker use) and runs the consistency test:

```bash
npx vitest run shared/lib/funding
git show origin/main:shared/data/funding/donations.json | node --import tsx scripts/ci/check-donation-ledger-transition.ts
```

Run `npm run build` when page rendering changes or a production-build rehearsal is requested. Schema validation does not replace transaction reconciliation or approval of each proposed row.

Report approved additions, rejected, self and spam rows, pricing and ENS uncertainty, coverage gaps, potential beneficiaries, and check results. Publishing is a separate `pharos-release-runner` task; a donations edit deploys both Pages and the Worker, which embeds the committed ledger.

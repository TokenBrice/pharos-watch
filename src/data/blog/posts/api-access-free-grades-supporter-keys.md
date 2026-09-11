This release changes Pharos's API access model: free Safety Score grades without a key, closed self-serve issuance, and supporter keys for eligible stablecoin donors. Here is what each change means and why the model is shaped this way.

## Free grades, no key

`GET https://api.pharos.watch/api/safety-grades` needs no API key. It returns the Safety Score and grade for each stablecoin in the same accepted V9 publication that powers the report cards, plus the methodology version, timestamps, and publication status. Coin IDs use the `ticker-issuer` form, so USDC is `usdc-circle`. When a publication is held, the response says so and is served uncached. If no usable publication is available, it returns `503` instead of inventing or falling back to older-model scores.

It is meant for servers, scripts, bots, and spreadsheets. Browser widgets on other sites are not supported yet, because the endpoint does not send CORS headers to third-party origins.

## Self-serve keys are closed

Anyone could request a key by verifying an email address: 30 requests per minute, valid for 60 days. That lane is closed. Keys already issued keep working until they expire, and already-sent verification links can still complete while valid.

Keyed access to the full API is now by request through the [feedback form](/feedback/), reviewed by hand. Projects that deliver a freely available, non-profit service on Pharos data get a standard key at no cost; FrankenCoin and Octav are the current examples. The test is the service, not the entity: it has to be free to its users.

## The supporter key

An externally-owned EVM wallet that has donated at least $10 in stablecoins to Pharos, valued at receipt and recorded on the public [funding ledger](/funding/), can claim one API key by signing a message on [/api/](/api/). Only stablecoins graded A or B, including plus and minus grades, at the time you claim count toward the total. The threshold is inclusive, so exactly $10 qualifies; ETH and other non-stablecoin donations, lower or missing grades, and pooled payouts do not. No email, no account, no payment processor. The key runs at 10 requests per minute and has no scheduled expiry.

How it works, in practice:

- The wallet signs a Sign-In-With-Ethereum message for pharos.watch. Sign it only on pharos.watch; if the wallet warns that the site does not match, reject it.
- The key is shown once. One key per wallet; a lost key is rotated by hand through the feedback form, never by signing again.
- Only wallets that can sign qualify. Donations sent from an exchange or a contract wallet cannot claim.
- The ledger is reconciled weekly and read at release time, so a new donation becomes claimable after the next reconciliation and release. Values use receipt-time USD, while grades are checked at claim time, not donation time. Later grade changes do not affect an issued key. Claims pause if the current accepted Safety Score publication is unavailable or held.
- Pharos stores the wallet address, the key prefix, the claim time, and the usage timestamps every key carries. Signatures and plaintext tokens are never persistently stored or logged; a keyed hash verifies the token. The unsaved token stays in browser memory so internal navigation does not lose it. Deactivation stops access but does not delete the records; the [privacy page](/privacy/) explains removal requests and the retained one-claim record.

It is a thank-you perk, and the terms match: revocable, no SLA, no refunds. This release enables claims. The [API page](/api/) shows whether claims are currently open.

## What the keyed API covers

The full API is the data the site runs on, read-only: the stablecoin catalogue and per-coin detail, supply history and chain aggregates, peg summary and depeg incidents, stress signals and the stability index, DEX liquidity, reserves and redemption backstops, mint and burn flows, the blacklist tracker, Safety Score report cards and history, yield rankings, and the daily digest with dated snapshots. The [API reference](/about/api/) lists every endpoint.

Typical uses: a bot that polls active depeg events, a risk dashboard that joins liquidity, reserves, and the report card for a treasury's holdings, or a notebook that pulls a year of supply and score history.

This restriction applies to the integration API, not to viewing the public website. Health checks, share images, feedback, and separately authenticated utility endpoints retain their documented access rules.

## Why this shape

Pharos is independent and [donation-funded](/funding/). Grades are a small, cacheable response with a wide audience, so they are free with no key requirement. Supporters get a durable key for having paid part of the bill. Heavier integrations go through a hand review so their usage can be matched to available capacity. A paid tier for high-volume or commercial use may come later; no pricing or date is promised.

For a manually reviewed key, use the feedback form. Eligible stablecoin donors can use [/api/](/api/) to claim a supporter key. See you at the lighthouse. 🗼

	/- TokenBrice

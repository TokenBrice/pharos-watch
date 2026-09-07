Pharos's API access model changed. Safety Score grades are now free to read without a key. Self-serve key issuance is closed. And a supporter key for anyone who has donated to Pharos is built and ships with the next release. Here is what each change means and why the model is shaped this way.

## Free grades, no key

`GET https://api.pharos.watch/api/safety-grades` needs no API key. It returns one Safety Score and grade per tracked stablecoin from the same V9 publication that powers the report cards, plus the methodology version, timestamps, and publication status. Coin IDs use the `ticker-issuer` form, so USDC is `usdc-circle`. When a publication is held, the response says so and is served uncached.

It is meant for servers, scripts, bots, and spreadsheets. Browser widgets on other sites are not supported yet, because the endpoint does not send CORS headers to third-party origins.

## Self-serve keys are closed

Anyone could request a key by verifying an email address: 30 requests per minute, valid for 60 days. That lane is closed. Keys already issued keep working until they expire.

Keyed access to the full API is now by request through the [feedback form](/feedback/), reviewed by hand. Projects that deliver a freely available, non-profit service on Pharos data get a standard key at no cost; FrankenCoin and Octav are the current examples. The test is the service, not the entity: it has to be free to its users.

## Next release: the supporter key

Any wallet that has donated at least $10 in total to Pharos, as recorded on the public [funding ledger](/funding/), can claim one API key by signing a message on [/api/](/api/). No email, no account, no payment processor. The key runs at 10 requests per minute and has no scheduled expiry.

How it works, in practice:

- The wallet signs a Sign-In-With-Ethereum message for pharos.watch. Sign it only on pharos.watch; if the wallet warns that the site does not match, reject it.
- The key is shown once. One key per wallet; a lost key is rotated by hand through the feedback form, never by signing again.
- Only wallets that can sign qualify. Donations sent from an exchange or a contract wallet cannot claim.
- The ledger is reconciled weekly and read at release time, so a new donation becomes claimable after the next reconciliation and release. Donations made today already count toward the threshold.
- Pharos stores the wallet address, the key prefix, the claim time, and the usage timestamps every key carries. Signatures and tokens are never stored or logged.

It is a thank-you perk, and the terms match: revocable, no SLA, no refunds. The feature is deployed switched off and opens once I have claimed a key with my own wallet on the live site.

## What the keyed API covers

The full API is the data the site runs on, read-only: the stablecoin catalogue and per-coin detail, supply history and chain aggregates, peg summary and depeg incidents, stress signals and the stability index, DEX liquidity, reserves and redemption backstops, mint and burn flows, the blacklist tracker, Safety Score report cards and history, yield rankings, and the daily digest with dated snapshots. The [API reference](/about/api/) lists every endpoint.

Typical uses: a bot that polls active depeg events, a risk dashboard that joins liquidity, reserves, and the report card for a treasury's holdings, or a notebook that pulls a year of supply and score history.

## Why this shape

Pharos is independent and [donation-funded](/funding/). Grades have the widest audience and the smallest per-request cost, so they are free with no gate. Supporters get a durable key for having paid part of the bill. Heavier integrations go through a hand review, because one busy consumer of the full API costs more than the whole free lane. A paid tier for high-volume or commercial use may come later; no pricing or date is promised.

If you want a key today, the feedback form is the path. If you have donated, watch [/api/](/api/) for the claim with the next release. See you at the lighthouse. 🗼

	/- TokenBrice

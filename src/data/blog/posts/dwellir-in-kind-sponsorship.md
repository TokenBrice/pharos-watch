Pharos has a public [funding page](/funding/). It lists what the site costs each month and records every donation, wallet by wallet. A ledger like that only shows money that moves on-chain, though, and some of our most valuable support never does. This post is about one such source: Dwellir, which has provided Pharos's multi-chain RPC access at no cost since September. It is also an open invitation to other providers who might want to do the same.

## What Pharos asks of an RPC provider

Much of what Pharos publishes starts with reading a blockchain directly. A token's total supply. A reserve vault's balance. A freeze event on a blacklist contract. A mint or a burn that moves a stablecoin's circulating figure. Those reads go through RPC endpoints, the nodes that answer questions about a chain's state and history, and our needs are more demanding than a typical dapp's:

- **Archive state.** Supply reconstruction and reserve checks ask "what was this balance at block N", often months or years back. That needs archive nodes, which are expensive to run and which most free public endpoints do not offer.
- **Wide event-log windows.** The blacklist tracker and the mint and burn flows scan `eth_getLogs` across thousands of blocks at a time. A provider that caps a request at a few hundred blocks turns one call into dozens.
- **A fresh head.** A freeze or a large mint matters most in the hour it happens. An endpoint that serves a stale "latest" block returns an old answer as if it were current, and nothing in the response says so.
- **Breadth.** Pharos tracks stablecoin supply on more than a hundred chains. The big EVM networks are easy to find a node for. Tempo, Plasma, Stable, MegaETH, Arc or Etherlink are not.
- **Volume.** Scheduled jobs re-read much of this several times an hour, so the bill scales with coverage rather than with traffic to the site.

Until September, those reads went through Alchemy on a pay-as-you-go plan, dRPC, and a scatter of public endpoints that rate-limit, lag behind the chain, or vanish without warning. Every new chain or reserve check came with the same question: is this worth its RPC bill?

## How Dwellir fills that gap

In September, Dwellir offered Pharos a year of RPC access in kind. The trial started in late September on their Developer plan, with 29 EVM endpoints placed last in line, behind every provider we already used. We added eight more chains in early October. On October 11, with the integration holding up, Dwellir moved us to their Growth plan, which is what the funding page shows today as a $0 line: "Multi-chain RPC; Growth plan sponsored in kind."

Pharos now reads 37 EVM chains through Dwellir. Thirty-four serve archive state. Thirty serve full event-log history, 29 of them accepting 10,000-block spans in a single request. On 17 of the 37, Dwellir is the only keyed provider we have; when the trial started, 20 of the first 29 chains had no keyed access at all. Dwellir also serves five non-EVM networks for us: Aptos, Movement, Tron, Starknet and Sui.

Getting there took some back-and-forth. Dwellir's team answered our questions about node types, log limits and backend behavior quickly and candidly, and when our first Ethereum host capped log requests at 1,000 blocks, they pointed us to one that takes 10,000.

The sponsorship is not a discount, and it came with no request to promote anything. Dwellir told us they back Pharos because they share its goals: independent, open data on stablecoin risk, published freely and built in the open. Pharos's code is [MIT-licensed on GitHub](https://github.com/TokenBrice/pharos-watch), and the site is free to read without an account.

## Indirect funding

We call this indirect funding. No money reaches the treasury, but a cost that would otherwise fall on donors goes away, and a constraint that shaped what we could build goes with it.

When we [wrote about Pharos at six months](/blog/pharos-at-six-months/), the stated mission was to reach break-even by the end of the year while keeping the data free to all. In-kind support is one of the cleanest ways to get there. A provider who already runs the infrastructure can cover Pharos at a marginal cost far below the cash price, and the money donors send goes further as a result. Every read Dwellir serves is one that no longer lands on our Alchemy bill or on a rate-limited public endpoint.

## From last in line to first

A sponsor's endpoint gets the same scrutiny as any other data source. Pharos publishes risk signals that people act on, so a provider that is fast but occasionally wrong would be worse than none. Dwellir started at the back of the queue and moved forward on evidence:

- **An hourly parity monitor.** Since the first day of the trial, a scheduled job has asked Dwellir and an independent reference provider the same questions and compared the answers: the current block, a token's state at a pinned block, a window of event logs, and whether Dwellir's "latest" block is really the latest. It runs every hour and covers all 37 chains every three hours. The pass mark is in the open-source code: at least 24 runs on record, zero state or log mismatches, 99.5% availability per method, a head within a few blocks of the reference, and latency within half a second of it.
- **Promotion one chain at a time.** From October 11, as each chain's record built up, Dwellir moved ahead of the incumbents: Mantle, Sonic and Gnosis first, then Tempo and Plasma, then Arbitrum, Optimism, Avalanche, Base and Polygon, then Ethereum on October 15. On October 19 we made it the default. Dwellir is now the first provider Pharos tries for scheduled reads on all 37 chains wherever its endpoint supports the exact request, and for supported reads on Aptos, Movement, Tron and Starknet. A request that needs history an endpoint does not keep still goes to a provider that has it.
- **Failures fall back.** If a Dwellir call times out or errors, the request moves to the next provider in the previous order. One setting takes any of the 37 EVM chains, or Aptos, Movement, Tron and Starknet, off Dwellir without a code change. The exception is Sui, where a diagnostic DEX reader that never feeds scores calls Dwellir directly, with no fallback. Pharos also meters Dwellir traffic against its own monthly credit budget, so sponsored capacity is never treated as unlimited.

The monitor keeps running after promotion. In the week to October 19, 32 of the 37 chains passed every check. Ethereum, Polygon and HyperEVM each returned a stale "latest" block at least once, 11 of Polygon's 146 log calls failed, Flow lagged the chain head, and XDC does not yet have enough freshness checks on record to judge. Those flags do not reroute traffic by themselves. They tell us where to look, and taking a chain off Dwellir is one setting away.

Working with Dwellir also improved our own tooling. Chasing small discrepancies turned up three bugs on our side. The parity monitor blamed the provider for timeouts that our own run deadline had caused. The store meant to hold a week of gate evidence was pruning itself to about two and a half days. And a price-quote path that ran out of gas on a batched call replayed the same batch, unchanged, on the next provider, doubling the work on Alchemy. All three were fixed on October 15.

## What it means

From October 1 to October 19, Pharos's own meter counted about 1.08 million Dwellir credits, roughly 59,000 a day. The Growth plan allows 150 million a month. Making Dwellir the default will raise our usage, and it still leaves room to add chains and reserve checks on their merits, without first pricing out the RPC calls they need. That question used to slow us down.

In-kind support like this does not show up as a bar on the donations chart, so we wanted to say it plainly: thank you, Dwellir. If you are building on stablecoin data and need reliable multi-chain RPC, [they are worth a look](https://www.dwellir.com/).

## We would like more of this

Dwellir is the first service provider to sponsor Pharos in kind. We would like it not to be the last. The [cost breakdown](/funding/) names the services Pharos still pays for in cash, among them market data from CoinGecko, the rest of our RPC traffic on Alchemy, model inference for the daily digest, and the Cloudflare Workers plan that runs our API. Each is a candidate for the same arrangement, and so is anything we do not use yet because the price does not fit a donation-funded budget: block explorer APIs, indexers, proof-of-reserve feeds.

If you run such a service and Pharos's mission matches yours, here is the deal:

- **What you get.** A named line on the funding page, credit on the [about page](/about/) wherever your service feeds a data source, and a post like this one when the integration has earned it. Because Pharos is open source, anyone can read exactly how your service is used and how we test it.
- **What you do not get.** Any say in what Pharos publishes, how a stablecoin is scored, or which risks get flagged. A sponsored service is held to the same checks as a paid one, and a sponsored data source is set aside just as fast when it is wrong.
- **What we ask.** Reliable service, honest answers about limits, and a term long enough to build on. Nothing else.

Reach us on [X](https://x.com/PharosWatch) or in the [Telegram group](https://t.me/pharoswatchers).

Pharos still depends on donations for its team and for the services no one sponsors; the [funding page](/funding/) shows what those cost. See you at the lighthouse. 🗼

	/- TokenBrice

Welcome to the very first post on the Pharos blog. Six months in felt like the right moment to start telling this story properly — because what a six months it has been. Where Pharos came from, what it has become, and where it's headed next: buckle up, this is the adventure so far.

## From twenty dashboards to one

Pharos began as a purely personal itch. I wanted a single place for all the stablecoin information I either couldn't find anywhere or had to stitch together from twenty different dashboards. Nobody was building it. So I did.

It didn't stay a side project for long. The turning point — one of *the* defining moments of Pharos so far — was bringing Ike on board: someone who turned out to be at least as bullish on Pharos as I am, possibly more. Everything accelerated at once. Our public presence expanded, integrations and ecosystem connections multiplied, and development shifted gears — from "whatever I felt like shipping that week" to structured, purposeful, prioritized progress. Two people, one lighthouse, and suddenly the beam reached a lot further.

## Watching the chain, deeply

Here's what makes Pharos different: we don't skim the surface, we monitor the chain itself, at a depth that unlocks features that simply didn't exist before. Live reserve composition — watch a stablecoin's backing move in real time. Redemption backstop analysis — know what actually stands behind your exit. Mint authority tracking — know who holds the keys to the printer. Nobody was doing this. Now it's just... on Pharos, free, refreshing around the clock.

And then there's the depeg arsenal — the beating heart of Pharos. When a depeg hits, Pharos alerts you as it's unfolding. Since we shipped the Depeg Duration Resolver (DDR), Pharos goes further and forecasts how long a depeg will last and how critical it will get. The Safety Score, meanwhile, has quietly proven itself as an early detection system: the stablecoins it scored low kept turning out to be exactly the ones that later broke. And the Depeg Early Warning System (DEWS) closes the loop, watching raw on-chain signals — minting volume, swap flows, and more — to catch trouble hours before it becomes a headline.

Detection, alert, forecast: the full loop, running in the open, for everyone.

The DeFi crowd noticed — fast. Several, if not most, of the major depeg events of the past six months were first reported on Pharos, sometimes anticipated outright, and consistently best covered here. pmUSD. USDX. EURR. apxUSD. Each time, when the water got rough, people came to the lighthouse. There is no better feeling than watching the tool do exactly the job it was built for, exactly when it matters.

## A new coat of paint, and a seat at the table

Two more milestones to celebrate. In June, Pharos got a complete redesign with the help of a professional designer, Kajmak Studio — the depth was always there; now the surface finally does it justice.

And just last weekend, we took our biggest swing yet: Pharos has [applied to become a service provider for the Curve Finance DAO](https://gov.curve.finance/t/pharos-watch-proposal-for-scope-1-crvusd-mint-markets-risk/11117), covering crvUSD mint markets risk. A six-month-old project standing up in front of one of DeFi's most storied DAOs and saying "we can carry this" — that's how far this ship has sailed already.

## The next six months

Now for the part that gets us out of bed in the morning: what's next.

The mission, agreed with Ike, is for Pharos to reach break-even by the end of the year — so that Pharos is sustainable and can keep delivering its infrastructure, and the immense amount of data it computes, for free to all, under a full open-source license, forever. Thanks to roughly $4,000 in donations received since inception, we're already well on the way — and genuinely moved that people put their money behind this before we ever asked twice.

The path from here runs through revenue that fits the mission rather than fighting it: risk service-providing for DAOs, built on Pharos infrastructure; high-frequency API keys for those who need the firehose; customized integrations of Pharos data for DeFi projects. Every step on that path brings the next one closer: more revenue means more hands on deck, a bigger team, and a brighter beam.

On the product side, the next major release is the one we're most excited about: **Safety Score V9**. This isn't a tweak — it's a complete redesign that accounts for a whole dimension of risk the current score can't see, with review flows tailored to each stablecoin's actual mechanism. CDP-type stablecoins will have their oracle setup analyzed and scored, and Pharos will model how they'd hold up under a liquidation shock if one of their collateral assets took a serious price hit. A centralized stablecoin faces entirely different risks — so it gets dedicated sub-scores for compliance and transparency instead, the factors that actually decide its fate. The scope is massive, and we're taking all the time it needs, because this one has to be right.

## What we stand for

Through all of it, two convictions anchor everything we do.

First: **risk data for stablecoins must be freely accessible to all.** Not gated. Not behind a paywall, as is far too often the case. The people with the most to lose from a depeg are rarely the ones who can afford a terminal subscription.

Second, and just as fiercely held: **everything stays open source** — the analysis, the worker, the entire infrastructure — so that anyone who wishes can trace exactly how Pharos computes a Safety Score or any sub-score, line by line. Scoring must be performed in the open. Privately funded, paid, black-box scoring is a recipe for disaster, and we will not tolerate it.

In six months, Pharos broke into the stablecoin space and made a bang. We're staying in our lane, comfy, and quite assured about where we're going — and about the necessity of what we're doing. The next six months are going to be even better, and you're invited.

If you like and use Pharos, you know how to support us: spread the word, make sure everybody knows about Pharos — and if you feel like it and can afford it, [Pharos accepts donations](/funding/). See you at the lighthouse. 🗼

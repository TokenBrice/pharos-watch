Welcome to the very first post on the Pharos blog. Six months in felt like the right moment to start telling this story properly, because what a six months it has been. Where Pharos came from, what it has become, and where it's headed next: buckle up, this is the adventure so far.

## From twenty dashboards to one

Pharos began as a purely personal itch. I wanted a single place for all the stablecoin information I either couldn't find anywhere or had to stitch together from twenty different dashboards. Nobody was building it. So I did.

It didn't stay a side project for long. The turning point, one of *the* defining moments of Pharos so far, was bringing Ike on board: someone who turned out to be at least as bullish on Pharos as I am, possibly more. Everything accelerated at once. Our public presence expanded, integrations and ecosystem connections multiplied, and development shifted gears, from "whatever I felt like shipping that week" to structured, purposeful, prioritized progress. Two people, one lighthouse, and suddenly the beam reached a lot further.

## Watching the chain, deeply

Here's what makes Pharos different: we monitor the chain itself, at a depth that unlocks features that simply didn't exist before. I don't think people realize the breadth of what Pharos ingests yet. Here are some numbers that will help you grasp the scope:
- ~110 different data sources consumed, including protocol APIs, DEX APIs, proofs of reserve, benchmarks, FX rates, yield data, compliance attestations, on-chain explorers, RPCs, etc.
- Around 150 data points per stablecoin (average), split between ~115 stored fields (static, curated data) and ~35 fetched or computed, derived metrics like the Safety Scores.
- Covering 261 core stablecoins, with 47 variants, tracking 26 different pegs across 110 chains.
- With 25 stablecoins dying under Pharos's watch, out of 106 total in the [cemetery](/cemetery/).

Our extensive dataset along with the paired worker infrastructure maintaining it and dynamically fetching more items on top enables Pharos to deliver things like:

- **Live reserve composition**, to watch a stablecoin's backing evolve in real time.
- **Redemption backstop analysis**, to know what actually stands behind your exit.
- **Mint authority tracking**, to know who holds the keys to the printer.
- **Blacklist assessment and tracking**, to know which stable can be seized, and which cannot.

And then there's **the depeg arsenal**: the beating heart of Pharos. When a depeg hits, Pharos alerts you as it's unfolding. Since we shipped the **Depeg Duration Resolver (DDR)**, Pharos goes further and forecasts how long a depeg will last and how critical it will get. The **Safety Score**, meanwhile, has quietly proven itself as an early detection system: the stablecoins it scored low kept turning out to be exactly the ones that later broke. And the **Depeg Early Warning System (DEWS)** closes the loop, watching raw on-chain signals such as minting volume, swap flows, and more, to catch trouble hours before it becomes a headline.


![The Depeg Duration Resolver showing ten live depeg forecasts alongside a track record of 89.1% recovery-call accuracy across 46 scored events.](/blog/ddr-track-record.png "The DDR in action: live duration and recovery forecasts, backed by a running 89.1% recovery-call accuracy.")

Detection, alert, forecast: the full loop is covered, and Pharos is a pioneer in each of these lanes. Where else have you found an engine able to anticipate the duration and the criticality of a stablecoin depeg, with almost 90% accuracy?

The DeFi crowd noticed, fast. Several, if not most, of the major depeg events of the past six months were first reported on Pharos, sometimes anticipated outright, and consistently best covered here. pmUSD. USDX. EURR. apxUSD. Each time, when the water got rough, people came to the lighthouse. There is no better feeling than watching the tool do exactly the job it was built for, exactly when it matters.

## A new coat of paint, and a seat at the table

Recently, we celebrated two more milestones. In June, Pharos got a complete redesign with the help of a professional designer, [Kajmak Studio](https://www.kajmak.studio/). The depth was always there, but now the form matches the matter.

And just last weekend, we took our biggest swing yet: Pharos has [applied to become a service provider for the Curve Finance DAO](https://gov.curve.finance/t/pharos-watch-proposal-for-scope-1-crvusd-mint-markets-risk/11117), covering crvUSD mint markets risk. A six-month-old project standing up in front of one of DeFi's most storied DAOs, with a solid case and a competitive offer: that's how far this ship has sailed already.

## The next six months

So far, I am happily covering Pharos's modest expenses. The mission, agreed with Ike, is for Pharos to reach break-even by the end of the year, so that Pharos is sustainable and can keep delivering its infrastructure, and the immense amount of data it computes, for free to all, under a full open-source license, forever. Thanks to roughly [$4,000 in donations](/funding/) received since inception, we're already well on the way, and genuinely moved that people put their money behind this before we ever asked twice.

We are exploring various revenue paths that fit our vision: risk service-providing for DAOs, built on Pharos infrastructure; high-frequency API keys for those who need the firehose; customized integrations of Pharos data for DeFi projects. Every step on that path brings the next one closer: more revenue means more hands on deck, a bigger team, and a brighter beam.

### Safety Score V9: one version to rule them all

On the product side, the next major release is the one we're most excited about: **Safety Score V9**. This isn't a tweak; it's a complete redesign that accounts for a whole dimension of risk the current score can't see, with review flows tailored to each stablecoin's actual mechanism. CDP-type stablecoins will have their oracle setup analyzed and scored, and Pharos will model how they'd hold up under a liquidation shock if one of their collateral assets took a serious price hit. A centralized stablecoin faces entirely different risks, so it gets dedicated sub-scores for compliance and transparency instead, the factors that actually decide its fate. The scope is massive, and we're taking all the time it needs, because this one has to be right.

Safety Score V9 also flips the scoring logic, with criticality assessed by sub-dimension and penalized accordingly. A stablecoin with an extremely unsafe collateral will no longer be able to reach a B, even if everything else is excellent. This logic better matches reality, as a stable is only as strong as its weakest link.

So far, about 15,000 additional data points have been curated in preparation for V9, and many additional sidecars and workers implemented, enabling feats such as the full supply reconstruction of each stablecoin (aggregate circulating). We are beyond stoked about this V9, and believe you will be too.

## What we stand for

Through our work, we have converged with Ike on two core commitments we are ready to disclose:

First: **risk data for stablecoins must be freely accessible to all.** Not gated. Not behind a paywall, as is far too often the case. The people with the most to lose from a depeg are rarely the ones who can afford a terminal subscription. The Pharos website will always remain fully accessible for free, or die trying.

Second, and just as fiercely held: **everything stays open source, under the MIT license** (the analysis, the worker, the entire infrastructure), so that anyone who wishes can trace exactly how Pharos computes a Safety Score or any sub-score, line by line. Scoring must be performed in the open. Privately funded, paid, black-box scoring is a recipe for disaster, and we will not tolerate it.

In six months, Pharos broke into the stablecoin space and made a splash. We're staying in our lane, comfy, and quite assured about where we're going, and about the necessity of what we're doing. The next six months are going to be even better, and you're invited.

If you like and use Pharos, you know how to support us: spread the word, make sure everybody knows about Pharos, and if you feel like it and can afford it, [Pharos accepts donations](/funding/). See you at the lighthouse. 🗼

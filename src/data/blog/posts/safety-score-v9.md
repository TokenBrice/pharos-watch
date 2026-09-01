Safety Score V9 is now fully released and functional on Pharos, covering every stablecoin we track. It is a ground-up rebuild of how Pharos thinks about stablecoin risk. The release reshuffles the results: USDT (Tether) and USDC (Circle) now sit at the top of the board, while wrapped stablecoins can no longer outscore the assets they wrap. Every score now tells you exactly which evidence it stands on and who owes whatever is missing. If that first item just raised your eyebrow: good. The full story is below, and it starts with an admission about our old score. This is the release I teased in [our six-months post](/blog/pharos-at-six-months/) as "one version to rule them all," and it was worth the wait.

The next sections explain the changes and what they mean for how you read a Pharos score.

## Three questions, three pillars

The previous Safety Score evaluated five dimensions: Peg Stability, Liquidity, Resilience, Decentralization, and Dependency Risk. Each of them measured something real. But they were *our* categories, analyst categories, and mapping them back to the question you actually care about ("is my money safe in this thing?") took some translation.

V9 throws out the analyst categories and starts from the holder's side of the table. When you hold a stablecoin, your risk boils down to three questions, asked in order:

**Backing (40%): does this thing have value to begin with?** What is actually in the box? Cash in a bank account, T-bills at a custodian, crypto collateral in a vault, a hedged derivatives book, or a promise and a prayer? Terra's UST was the last kind, and forty billion dollars learned the difference the hard way. The Backing pillar measures the quality, transparency, and structure of what stands behind the token.

**Control (25%): even if the box is full, can something destroy it anyway?** A stablecoin can be fully backed on paper and still die in an afternoon. A compromised mint function printing tokens out of thin air (Cashio's "infinite glitch" turned a fully backed stablecoin into confetti in hours), an admin key in the wrong hands, a governance capture (a flash-loaned vote drained Beanstalk of $182M in a single transaction), an oracle feeding poisoned prices: the industry has collected reminders of every one of these. The Economic Control pillar, Control for short, maps who holds power over the token and its economics, and how much damage that power could do.

**Exit (35%): fine, but can I actually leave?** Backing can be sound and control can be clean, and you can still be trapped. The Exit pillar measures your real capacity to convert the token back into value without eating heavy losses: redemption rights and how they work in practice, and the depth of the market routes available when you need out. Not theoretical liquidity, measured liquidity: V9 demands economically material exit capacity, actual executable routes with real depth, before it gives credit for them. An issuer's redemption promise and a DEX pool's TVL are not interchangeable, and V9 never infers one from the other.

Together, the three pillars read like the due-diligence a careful holder would run, in the order they would run it. Is there value in the box? Can anyone break the box? Can I get my value out of the box? That's the whole story of stablecoin risk, and now it's the whole structure of the score. Comprehensive, but also *fast to read*: three numbers you can interpret without a manual. And the weights follow consequence rather than sequence: Backing weighs heaviest because nothing else matters if the box is empty, and Exit outweighs Control because whatever goes wrong, your loss is realized at the exit.

![The top of the Pharos Safety Scores board: nine A-tier stablecoins, each card showing a Backing/Exit/Control triangle, led by USDC at A+ (89) and Tether at A+ (87).](/blog/v9-safety-board.png "The V9 board: every card carries all three pillars, so a lopsided stablecoin shows up as a lopsided triangle.")

## A score that speaks each stablecoin's language

The second foundational change: V9 is **mechanism-aware**. A fiat-backed stablecoin and a crypto-collateralized CDP don't fail the same way, so scoring them against the same checklist was always a compromise. Under V8 we patched around this with special cases. Under V9, it's the architecture.

Every stablecoin is scored through the review that matches its actual mechanism, across six archetypes: fiat-cash reserves, T-bill backed, RWA credit funds, CDPs, synthetic delta-neutral designs, and algorithmic designs. Each archetype gets asked the questions that actually decide its fate:

- A **CDP stablecoin** is judged on its collateral quality, its oracle setup, its liquidation machinery, and its track record: how did it actually behave through the drawdowns and depegs it has lived through?
- A **centralized fiat-backed stablecoin** faces an entirely different battery: regulatory standing, attestation and audit quality, reserve transparency, custody arrangements, redemption terms.
- A **synthetic delta-neutral design** is examined on its hedging venues, its counterparty surface, and what happens to the book when funding turns against it.

Same three pillars for everyone, but the evidence feeding those pillars is tailored to what can actually kill each design. The result is that a V9 score means the same thing across radically different stablecoins: under the published methodology, it measures the evidence-based risk of each design, given its mechanism.

## Ceilings, not averages

The third change is the scoring logic itself. Weighted averages have a flaw that has bothered me for a long time: they let strength in one area paper over a fatal weakness in another. A stablecoin with pristine reserves but a mint function one leaked key away from disaster should not be able to average its way to a good grade.

V9 keeps the pillar weights but strips them of that power, through a logic of **ceilings and penalties**. The 40/35/25 blend only operates within a bounded band above the weakest material pillar, at most twenty points: strength elsewhere buys a stablecoin limited headroom above its weakest link, never absolution for it. This is also why the exact weights matter less in V9 than they would in an ordinary average, and why no weighting tweak could buy back a failure; the band and every constant are laid out on the methodology page. On top of that, structural ceilings cap the score wherever a structural fact caps the real-world safety: peg behavior, evidence sufficiency, track record, and dependency risk can each impose a binding cap, and when they do, the score shows *which cap is binding*. A stablecoin is only as strong as its weakest link, and the score now behaves that way.

The logic is live on the board. Bucket Protocol's BUCK, a CDP stablecoin on Sui, posts a respectable Exit pillar, and an F: its oracle control topology is opaque, and that single critical signal caps the entire score at 39, whatever the other pillars say. The report card names the cap and the reason, in plain text, on the page.

![BUCK's V9 report card: an F at 39/100 with Backing 40, Exit 68, and Economic Control 45, and a binding cap reading "Oracle control topology is opaque-or-unknown. Limit 39 / 100."](/blog/v9-binding-cap.png "BUCK's report card: a B- Exit pillar cannot lift the score past the cap its opaque oracle topology imposes.")

This logic also fixes a long-standing blind spot: **wrapped and dependent stablecoins**. A yield-bearing wrapper around another stablecoin, or a stablecoin substantially collateralized by another one, inherits the risk of what it's built on. Under V9, the dependency graph is explicit: a wrapper's score is anchored to its parent, adjusted for the wrapper's own local risks, and a stablecoin leaning on a weak parent will feel that weakness as a ceiling. No more wrappers quietly outscoring the asset they wrap. sUSDD, the staked wrapper of Tron's USDD, is the live illustration: its own Exit pillar measures near-perfect, but a child cannot rate above the parent it depends on, so USDD's D grade pins sUSDD to an F.

## Why USDT and USDC now top the board

This is the change that will raise the most eyebrows, so let me give it the honest, full-history treatment.

Pharos's Safety Score launched with an explicit **Decentralization dimension**. That was a deliberate value statement, and it had a mechanical consequence: a centralized stablecoin could simply never reach the top of the scale, whatever its other merits, because of its very nature. Over successive versions we softened this: the weight came down, the dimension got more nuanced. But the cap remained, and it wasn't the only one. Even outside the Decentralization dimension, centralization carried implicit penalties: blacklistability, for instance, was factored as a straight negative, which meant a centralized stablecoin implementing the blacklist controls its regulators require, in other words, a *compliant* centralized stablecoin, was scored down for it.

Sit with that for a second: we were penalizing centralized stablecoins for being what they are, twice, on top of measuring their actual risks. That is an ideological posture, and it made the top of our leaderboard say more about our preferences than about safety.

V9 removes the ideology and keeps the measurement. Decentralization no longer exists as a standalone scored dimension. What it was trying to protect you from hasn't gone anywhere; it has moved to where it belongs, inside **Control**, measured concretely and for every stablecoin equally: who can mint, who can freeze, who can upgrade, who can change the rules, and what is the blast radius if that power is abused or compromised. A blacklist function is no longer a penalty in itself, but it has not left the score either: the power to freeze your tokens is a live, concrete risk to you as a holder, addresses do get frozen, and Control scores that exposure for every stablecoin that carries it. What changed is that it is now weighed as what it is, a measured control surface priced alongside every other key and permission, not doubled as a purity test. The risk of centralization is scored where it is real, not where it is philosophical.

The result: with backing measured on evidence, control measured on facts, and exit measured on executable capacity, **USDT and USDC now sit at the top of the board**: both A+, at 87 and 89 as I write this. Not as twins, and not without nuance: USDC's reserves are covered by audited financial statements on top of monthly attestations, while USDT's stand on quarterly attestations, and an attestation is not an audit. V9 knows the difference: disclosure quality is scored inside Backing, where USDT's pillar visibly trails USDC's audited stack. The ceilings bite even up here: USDT's 87 is a binding cap rather than a weighted-average result. A mint-control signal imposes it: minting is economically unbounded even though supply is reconciled against reserves. The top of the board is earned, not exempted. What the two share is what carries them to the top: enormous, overwhelmingly liquid reserve books and the most scrutinized issuers in the industry. The score finally reflects that. And to be crystal clear about what didn't change: my personal convictions about decentralization are intact, and Pharos will keep surfacing decentralization data prominently, in Control, in the Mint Authority tracker, in the blacklist assessment. But a *safety* score's job is to measure safety. V9 does exactly that, for everyone, with the same yardstick.

## Honest about what we don't know

One more V9 principle worth your attention, because it's the one that makes all the others trustworthy: **V9 distinguishes "this is bad" from "we don't know yet," and it says which one it means.**

Every score decomposes into individual facts, and every missing fact carries a named responsibility: the issuer hasn't disclosed it, or Pharos hasn't integrated the source yet, or a pipeline failed to produce it. An F is reserved for measured, attributed danger, never for missing paperwork. A stablecoin with too many unbounded unknowns doesn't get a guessed grade; it gets NR, not rated, as 17 of the 335 coins on the board do today, and the report card tells you exactly which evidence is missing and who owes it. And before anyone tries the obvious trick: opacity is not a refuge. The less an issuer discloses, the lower the evidence-sufficiency ceiling pushes its score, until there is too little to rate at all and the coin lands on NR, which on Pharos is a warning label, not a blank slate. Refusing to show the box is itself a finding. And when our own infrastructure hiccups, V9 fails closed: it holds the last accepted score and shows it as held, rather than publishing phantom score movements that reflect our pipeline instead of the stablecoin.

Which brings me to the honest caveat: **V9 is a major milestone, and it is still a work in progress.** The model is live and the architecture is final, but the evidence base is still filling in. Over 15,000 data points were curated to get here, on the order of fifty newly curated facts per tracked stablecoin, and the gathering continues daily: mechanism reviews deepening, exit routes being measured, reserve evidence landing. Expect scores to keep moving in the coming weeks, not because the methodology is shifting under you, but because the machine is doing exactly what it was built to do: replacing "unknown" with "measured," one fact at a time.

## Go read your stablecoin's report card

Everything above is live now. The [Safety Scores board](/safety-scores/) shows all three pillars for every tracked stablecoin, every coin page carries its full V9 report card with the evidence behind each pillar, and the complete formula, weights, ceilings, and archetype reviews are documented on the [methodology page](/methodology/) and, as always, [fully open source](https://github.com/TokenBrice/pharos-watch), line by line. Scoring must be performed in the open; that commitment predates V9 and it will outlive it.

Go look up the stablecoins you hold. Ask the three questions. And if you find a score you disagree with, the entire reasoning is laid out for you to challenge: that's the point.

See you at the lighthouse. 🗼

	/- TokenBrice

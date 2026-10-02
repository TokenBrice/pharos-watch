Safety Score V10 is now live on Pharos. If you read [the V9 post](/blog/safety-score-v9/), the frame will look familiar: the same three pillars, Backing, Control and Exit, the same 40/35/25 weights, and the same ceilings that stop a strong pillar from covering for a weak one. V9 was the structural rebuild. V10 is the refinement that structure made possible. All 331 stablecoins on the board were reviewed again, producing more than 5,000 individual findings, about 3,500 of which changed the underlying data.

The result is a ranking with more nuance in it. Scores now separate an issuer that sets its own price from an independent oracle. They judge minting by its least-protected route. They treat a family of currencies backed by one shared reserve as exactly that. And for the first time, they follow a gold token from the vault to dollars in a bank account.

Measured against the live V9 scores on October 2, 110 of the 331 scores move: 18 rise, 87 fall, four become Not Rated and one returns from it. Most moves are small; 55 of the 105 numeric changes are two points or less, and 54 grades change. The A tier holds the same eleven coins. The sections below name the causes of the large moves, coin by coin.

## Same three questions, sharper answers

The frame did not change. Backing still asks what is in the box, Control who can break it, and Exit whether you can get your value out. What changed is the resolution of each answer.

V9 often had to work with coarse facts: one custody label for a reserve book only partly verified, the main minting route when a coin had several, a generic oracle tier when the issuer was actually choosing the price. V10 replaces many of those with exact, dated, sourced facts. Where a fact could not be found after documented research, the report card says so and the charge stays. Three principles run through the release:

- **The weakest material path counts.** A coin is as exposed as its least-protected minting key or unresolved deployment, not its best-documented one.
- **Evidence must match the holder's claim.** A fund share, a pooled reserve or a protocol position is scored as what it is, instead of borrowing the label of cash or Treasury bills.
- **Unknown is not zero.** A missing fact never becomes measured danger, and it never becomes credit either. Documented non-disclosure stays charged.

## From a gold bar to dollars

The most visible new capability sits in Exit. It answers a question V9 could not: what is a gold token worth to a holder who needs dollars when on-chain markets are thin?

Tokenized gold usually comes with a redemption right, but for metal rather than cash. PAXG's terms let a verified Paxos customer deliver 430 PAXG plus a fee and receive a London Good Delivery bar. V9 had no way to value that bar in dollars, so the redemption earned no Exit credit. Delivery on its own still earns none. V10 adds the rest of the journey, modelled step by step:

1. **Redeem.** The holder exchanges tokens for whole bars. Good Delivery gold bars weigh between 350 and 430 fine ounces, so Pharos assumes the full 430-token deposit but counts only 350 ounces delivered, with the excess refunded.
2. **Sell.** The bar goes to a dealer at a fixed policy spread set by bar type and location: 100 basis points for Good Delivery gold in London or Zurich, 400 for small gold bars and coins, 800 for small silver, and another 100 for any other vault. These spreads sit deliberately above published primary-market tariffs.
3. **Get paid.** Issuer fees, logistics, insurance, assay, tax and currency conversion are deducted once. Published fees win; unpublished ones use conservative policy estimates and lower the model's confidence.

The composed route then faces the same tests as every other exit. All-in costs must not exceed 500 basis points (other routes keep 200). Timing must be stated somewhere: where an issuer gives only a typical time, Pharos assumes three times that, between 10 and 30 business days, then adds up to 10 business days for the dealer sale. Capacity is limited to what is documented, so with no published throughput the model credits one minimum lot per settlement window. Reviewed terms expire after 90 days, and the metal price behind the valuation must be less than 24 hours old.

Run PAXG through it and the answer is modest. One bar, counted at 350 ounces, is worth about $1.47 million at the captured gold price; after roughly 201 basis points of modelled costs it returns about $1.44 million, within at most 45 days. Against Exit's $25 million stress request, that is 6% coverage, at low confidence, because Paxos publishes neither its redemption fee nor a settlement deadline. The Ethereum pool that serves as PAXG's primary route keeps that role. The redemption adds a backup credit of 1.5 points, lifting the Exit pillar from 82.4 to 83.9.

XAUT's bars are delivered within Switzerland. Tether publishes a 25-basis-point fee; delivery, insurance and assay are modelled, and Pharos does not assume a Zurich vault from a Swiss address. The total comes to about 403 basis points, inside the ceiling, and earns the same 1.5 points. XAUT's score holds at 79 (B+).

KAG shows the other side. Kinesis redeems silver in 200-ounce increments for 0.45% plus $100 plus a delivery fee it does not publish, shipped anywhere in the world. Unpriced cross-border delivery means the route cannot be costed, so it earns no credit. Under V9, KAG's Exit was zero: the only measured route was an Ethereum pool that could fill $18.50 of a $25 million request. V10 now sees a documented redemption with an unknown dollar outcome, which differs from a proven-closed exit. Exit moves from 0 to the 35-point floor Pharos assigns when an exit cannot be measured, and KAG from 18 (F) to 46 (D). No route was credited. Published delivery costs and a release deadline would let the route be measured. KAU, Kinesis's gold token, moved the other way, from 42 to 40, because its binding terms deny holders direct title to bullion and make redemption discretionary.

## The weakest door counts

Minting is the most direct way to dilute holders, and many coins mint on several chains under different keys. V9 tended to price the preferred route. V10 prices the least-protected durable minting route across all deployments, because new native tokens on any chain dilute every holder. A control proven local to one deployment counts in proportion to its share.

The rule is the main cause of about half of the 87 falls, more than any other change. crvUSD dropped from 73 (B) to 44 (D). A read-only simulation of the full chain from the Curve DAO to the minting factory showed a privileged path that can mint crvUSD to an arbitrary recipient without collateral or repayment. No one alleges the power has been abused, but the old record described the factory as only pre-minting lending inventory. Its savings token scrvUSD fell with it, from 71 to 42. DOLA dropped from 57 to 45: verified operator powers allow lasting, uncapped issuance without the governance approval and delay the old record assumed.

The same rule produces small, precise moves near the top of the board. PAXG has a Solana minting path that needs one of four signers; its Control pillar fell from 84 to 72 and its score from 83 (A) to 80 (A-). XSGD's XRPL issuer account still has its master key enabled, so a single key can sign on its own. Its mint authority slips from 83 to 81, and the score holds at 82. USDC lost one point, 90 to 89, for a single-key minter whose custody arrangements Circle does not disclose. That point is a non-disclosure charge, not a finding that the key is unmanaged.

## Who sets the price

An independent price feed and an issuer choosing the price are different risks, and V10 names which one each coin has. Where an issuer or administrator sets the mint, redemption or conversion price, Control scores that pricing at 45 out of 100. V10 also removed the extra whole-score ceiling that used to come with it, so the risk is priced once, in the pillar that owns it.

Among coins with more than $1 billion in circulation, USDe fell furthest, from 77 (B+) to 62 (C+). Ethena's terms grant it valuation discretion and its request-for-quote rules keep a last look for the issuer; external feeds check Ethena's price rather than set it. Control fell from 70 to 45. Backing slipped too, from 78.6 to 74.1, after Pharos removed one-day liquidity assumptions on reserve positions that no source supports under stress.

sUSDS fell from 55 (C) to 44 (D). Governance sets its conversion rate, and the savings yield is funded by creating system debt that becomes new USDS without new collateral, under no numeric cap. USDS itself is unchanged at 80 (A-). sGHO went from 67 to 62 because an administrator sets its target rate. GHO stays at 71 (B). V10 checked each of its issuance paths separately, found that allocations which do not depend on a price carry no oracle charge, and treated Horizon's Chainlink-relayed NAV as a standard external feed. The score now rests on every path instead of one, and it did not move.

## One reserve, many currencies

Mento issues a family of reserve-backed currencies, among them USDm, EURm, GHSm and XOFm, against a single shared reserve. V9 scored each of them as a fiat-cash stablecoin, as if each held a cash reserve of its own. V10 adds a [shared-reserve model](/learn/mechanisms/shared-reserve/) that asks what matters for a pooled claim: what a holder can actually claim, whether the pool covers every currency's liabilities together, where the reserve sits, whether its assets are encumbered or allocated elsewhere, and what happens in a default. Whatever Mento does not publish stays charged. The reserve-backed tokens now carry essentially the same Backing score, about 56, down from between 59 and 72 under V9.

Pricing was checked too. Each affected Mento feed has one authorized relayer and one live rate, and an emergency cached value does not count as a second feed. Control now sits at 45 across these tokens. EURm went from 57 to 50, GHSm from 64 to 59 and XOFm from 60 to 58. GBPm, a CDP-backed Mento currency, fell from 64 to 59 on the same pricing finding plus lower Backing inherited through its parent. USDm held at 59: lower Backing and Control brought its computed score down to the level where a minting ceiling used to hold it.

Two other new models follow the same logic. Spiko's EURSAFO is a UCITS fund that combines securities with total-return swaps; scored as a fund share instead of a Treasury bill, it moved from 65 to 54. USDB, a bridged claim on a DAI savings position, moved from 45 to 37 once it stopped borrowing a cash label.

## Vaults: the parent, plus what they add

V9 established that a wrapper cannot outscore what it wraps. V10 makes both halves of that rule more exact. Parent declines pass straight through: scrvUSD follows crvUSD, sDOLA follows DOLA from 55 to 43, and savUSD drops from 53 to 38 behind avUSD, which fell from 60 to 45. Verified local evidence now replaces generic deductions. Gauntlet's gtUSDC and gtUSDCp rose from 80 to 82 once reviewed lending allocations and custody replaced a generic ten-point deduction for an unknown vault. Yearn's yvUSDC-1 and Steakhouse's bbqUSDC jumped from 55 (C) to 79 (B+) after verified deposit-backed issuance removed a bridge ceiling. USDC, less each vault's own risks, now sets their limit.

## Where a coin lives

Stablecoins live on many chains, and Pharos cannot always resolve who controls every deployment. V10 prices that uncertainty on a smooth band instead of a single cut-off. Below 5% of supply, the charge is proportional. Between 5% and 15%, the whole-coin ceiling blends in gradually. At 15% or more, or when the share is unknown, the full ceiling applies. FRAX sits in the band, at 55.

Known circulation now sizes Exit's stress test even when Pharos cannot split it chain by chain. Sizing grants no route credit on its own. OSL's USDGO rose from 49 (D) to 64 (C+) as better deployment coverage cleared its unknown-control treatment and a properly sized request improved its Exit. Frax's sfrxUSD rose from 41 to 44 on the same change.

## Evidence has a date

V10 is stricter about when a fact was true. A reserve report without a separate publication date can now use its printed signing date, marked as such on the card. That restored credit for SoFi's SOFID (48 to 51, D to C-), Fidelity's FIDD (83 to 84) and Ripio's wMXN and wCOP (34 to 37). In the other direction, xDAI fell from 62 to 58, because an on-chain snapshot of assets is not an independent reserve examination.

Measured collateralization now caps Backing when the measurement is current. LeverUp's LVUSD was measured at about 64% collateralized, and its score went from 39 to 35. An expired or undated measurement grants neither a haircut nor credit. Custody labels such as "institutional" now need evidence covering the whole reserve book.

## Unknown is not zero, and Not Rated is not F

The rule behind KAG works in both directions. V10 never turns a missing fact into measured danger, and never into credit. Where Pharos searched exhaustively and an issuer still does not disclose something material, the charge stays. Report cards file it under "The issuer has not disclosed this," separate from measured risk. Of the 87 falls, 34 trace mainly to a verified risk, 36 to facts still unknown after documented research, and 17 to approved rule changes applied to facts already known. None comes from evidence nobody looked for.

When too much is unknown to rate honestly, the answer is NR. Not Rated rose from 14 to 17 coins. eMXN is the clearest example: its candidate score fell into F territory, but an F requires at least one measured, attributable danger, and none exists, so it is Not Rated instead. THBILL, FUSD and USDR join it for insufficient evidence after research.

## Go read your stablecoin's report card

Everything above is live now. The [Safety Scores board](/safety-scores/) shows all three pillars for every tracked stablecoin, and each coin page carries its full report card: the routes, controls and reserve facts behind each pillar, and the reason behind every cap. The formula, weights, ceilings and policy values are on the [methodology page](/methodology/), every change is listed in the [scoring changelog](/methodology/scoring-changelog/), and the code remains [fully open source](https://github.com/TokenBrice/pharos-watch).

V9 promised that scores would keep moving as "unknown" was replaced by "measured." V10 is a large batch of that work, written into the method. If a score looks wrong to you, the reasoning is on the card to challenge.

See you at the lighthouse. 🗼

	/- TokenBrice

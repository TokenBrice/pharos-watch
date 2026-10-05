Safety Score V10 is now live on Pharos. If you read [the V9 post](/blog/safety-score-v9/), the frame will look familiar: the same three pillars, Backing, Exit and Control, the same 40/35/25 weights, and the same ceilings that stop a strong pillar from covering for a weak one. V9 was the structural rebuild. V10 is the refinement that structure made possible. All 331 stablecoins on the board were reviewed again, producing more than 5,000 individual findings, more than 2,000 of which changed the underlying data.

The result is a ranking with more nuance in it. Scores now separate an issuer that sets its own price from an independent oracle. They judge minting by its least-protected route. They treat a family of currencies backed by one shared reserve as exactly that. And for the first time, they follow a gold token from the vault to dollars in a bank account.

Measured against the live V9 scores on October 2, 142 of the 331 scores move: 50 rise, 81 fall, ten become Not Rated and one gains a rating. Many moves are small; 55 of the 131 numeric changes are two points or less, and 81 grades change. The A tier holds the same eleven coins. The sections below name the causes of the large moves.

Those are launch figures, from version 10.0. Eight point releases have followed, and some coins named below have moved again. [What changed since launch](#what-changed-since-launch) summarizes them as of the v10.08 release.

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

Run PAXG through it and the answer is modest. One bar, counted at 350 ounces, is worth about $1.45 million at the captured gold price; after roughly 201 basis points of modelled costs it returns about $1.42 million, within at most 45 days. Against Exit's $25 million stress request, that is 6% coverage, at low confidence, because Paxos publishes neither its redemption fee nor a settlement deadline. The Ethereum pool that serves as PAXG's primary route keeps that role. The redemption adds a backup credit of 1.5 points, lifting the Exit pillar from 83.67 to 85.17.

XAUT's bars are delivered within Switzerland. Tether publishes a 25-basis-point fee; delivery, insurance and assay are modelled, and Pharos does not assume a Zurich vault from a Swiss address. The total comes to about 403 basis points, inside the ceiling, and earns the same 1.5 points. XAUT's score holds at 79 (B+).

KAG shows the other side. Kinesis redeems silver in 200-ounce increments for 0.45% plus $100 plus a delivery fee it does not publish, shipped anywhere in the world. Unpriced cross-border delivery means the route cannot be costed, so it still earns no credit. The binding terms of the Ethereum token weigh more. Its reserve is a stock of native Kinesis tokens issued by another company, not allocated silver. Holders have "no legal, equitable or beneficial right, title or interest in or to the Reserves," and redemption is at the issuer's discretion, with no promised timeframe. Backing falls from 69.7 to 41.6. Exit moves the other way. Under V9 it was zero: the only measured route was an Ethereum pool that could fill $18.40 of a $25 million request. V10 does not read one shallow pool as proof that every way out is closed, so Exit takes the 35-point floor Pharos assigns when an exit cannot be measured, with no route credited. At launch KAG rose from 18 to 38 and remained an F. Since v10.01 it is Not Rated, because that F rests on no measured adverse fact. KAU, Kinesis's gold token, sits under the same terms and slipped from 42 to 40.

## The weakest door counts

Minting is the most direct way to dilute holders, and many coins mint on several chains under different keys. V9 tended to price the preferred route. V10 prices the least-protected durable minting route across all deployments, because new native tokens on any chain dilute every holder. A control proven local to one deployment counts in proportion to its share.

The rule plays a part in more than half of the 81 falls, more than any other change. crvUSD dropped from 72 (B) to 44 (D). A read-only simulation of the full chain from the Curve DAO to the minting factory showed a privileged path that can mint crvUSD to an arbitrary recipient without collateral or repayment. No one alleges the power has been abused, but the old record described the factory as only pre-minting lending inventory. Its savings token scrvUSD fell with it, from 70 to 42. Both have moved since on governance findings, covered in the last section. DOLA dropped from 57 to 45: verified operator powers allow lasting, uncapped issuance without the governance approval and delay the old record assumed.

The same rule produces small, precise moves near the top of the board. PAXG has a Solana minting path that needs one of four signers; its Control pillar fell from 84 to 72 and its score from 83 (A) to 80 (A-). XSGD's XRPL issuer account still has its master key enabled, so a single key can sign on its own. Its mint authority slips from 83 to 81, and its score from 83 (A) to 82 (A-). USDC lost one point, 90 to 89, for a single-key minter whose custody arrangements Circle does not disclose. That point is a non-disclosure charge, not a finding that the key is unmanaged.

## Who sets the price

An independent price feed and an issuer choosing the price are different risks, and V10 names which one each coin has. Where an issuer or administrator sets the mint, redemption or conversion price, Control scores that pricing at 45 out of 100. V10 also removed the extra whole-score ceiling that used to come with it, so the risk is priced once, in the pillar that owns it.

Among coins with more than $1 billion in circulation, USDe fell furthest, from 79 (B+) to 63 (C+). Ethena's terms grant it valuation discretion and its request-for-quote rules keep a last look for the issuer; external feeds check Ethena's price rather than set it. Control fell from 70 to 45. Backing slipped too, from 78.6 to 74.1, after Pharos removed one-day liquidity assumptions on reserve positions that no source supports under stress.

sUSDS fell from 55 (C) to 44 (D). Governance sets its conversion rate, and the savings yield is funded by creating system debt that becomes new USDS without new collateral, under no numeric cap. USDS itself held at 80 (A-) at launch. sGHO went from 67 to 62 because an administrator sets its target rate. GHO held at 71 (B). V10 checked each of its issuance paths separately, found that allocations which do not depend on a price carry no oracle charge, and treated Horizon's Chainlink-relayed NAV as a standard external feed. The score rested on every path instead of one, and at launch it did not move. Later governance releases moved all four coins; the last section covers why.

The third case is an oracle whose setup the issuer does not disclose at all. V9 treated that as measured danger, with a ceiling at 39 that could make a coin F on its own. V10 treats it as non-disclosure: the charge stays in Control, but it no longer counts as proof of danger. Aster's USDF rises from 39 (F) to 47 (D), and its staked asUSDF follows from 33 to 41. Freedom Dollar's fUSD goes from 39 to 44 and Unity's UTY from 39 to 45, both now D. Hermetica's USDh, rated F at 18 under V9, becomes Not Rated, because its Backing and Exit also rest on limited evidence.

## One reserve, many currencies

Mento issues a family of reserve-backed currencies, among them USDm, EURm, GHSm and XOFm, against a single shared reserve. V9 scored each of them as a fiat-cash stablecoin, as if each held a cash reserve of its own. V10 adds a [shared-reserve model](/learn/mechanisms/shared-reserve/) that asks what matters for a pooled claim: what a holder can actually claim, whether the pool covers every currency's liabilities together, where the reserve sits, whether its assets are encumbered or allocated elsewhere, and what happens in a default. Whatever Mento does not publish stays charged. The reserve-backed tokens now carry essentially the same Backing score, about 56, down from between 59 and 72 under V9.

Pricing was checked too. Each affected Mento feed has one authorized relayer and one live rate, and an emergency cached value does not count as a second feed. Control now sits at 45 across these tokens. EURm went from 57 to 50, GHSm from 64 to 59 and XOFm from 60 to 58. GBPm, a CDP-backed Mento currency, fell from 64 to 59 on the same pricing finding plus lower Backing inherited through its parent. USDm held at 59: lower Backing and Control brought its computed score down to the level where a minting ceiling used to hold it.

Two other new models follow the same logic. Spiko's EURSAFO is a UCITS fund that combines securities with total-return swaps; scored as a fund share instead of a Treasury bill, it moved from 65 to 54. USDB, a bridged claim on a DAI savings position, moved from 45 to 37 once it stopped borrowing a cash label.

## Vaults: the parent, plus what they add

V9 established that a wrapper cannot outscore what it wraps. Parent declines now pass straight through: scrvUSD follows crvUSD, sDOLA follows DOLA from 55 to 43, and savUSD drops from 53 to 42 behind avUSD, which fell from 60 to 45. Verified local evidence replaces generic deductions. Gauntlet's gtUSDC and gtUSDCp rose from 80 (A-) to 84 (A) once reviewed lending allocations and custody replaced a generic ten-point deduction for an unknown vault. Yearn's yvUSDC-1 and Steakhouse's bbqUSDC jumped from 55 (C) to 79 (B+) after verified deposit-backed issuance removed a bridge ceiling; USDC now sets their limit.

## Where a coin lives

Stablecoins live on many chains, and Pharos cannot always resolve who controls every deployment. V10 prices that uncertainty on a smooth band instead of a single cut-off. Below 5% of supply, the charge is proportional. Between 5% and 15%, the whole-coin ceiling blends in gradually. At 15% or more, or when the share is unknown, the full ceiling applies. Exact shares matter: FRAX's unresolved deployment turned out to be a Fraxtal balance already migrated to frxUSD, a different token. With that balance excluded, FRAX carries no unresolved-deployment charge and holds at 56.

Known circulation now sizes Exit's stress test even when Pharos cannot split it chain by chain. Sizing grants no route credit on its own. OSL's USDGO rose from 49 (D) to 64 (C+) as better deployment coverage cleared its unknown-control treatment and a properly sized request improved its Exit. Frax's sfrxUSD rose from 41 to 44 on the same sizing change.

## Evidence has a date

V10 is stricter about when a fact was true. A reserve report without a separate publication date can now use its printed signing date, marked as such on the card. That restored credit for SoFi's SOFID (48 to 51, D to C-), Fidelity's FIDD (83 to 84) and Ripio's wMXN and wCOP (34 to 37). In the other direction, xDAI fell from 61 to 58, because an on-chain snapshot of assets is not an independent reserve examination.

Measured collateralization now caps Backing when the measurement is current. LeverUp's LVUSD was measured at about 64% collateralized, and its score went from 39 to 35. An expired or undated measurement grants neither a haircut nor credit. Custody labels such as "institutional" now need evidence covering the whole reserve book.

## Unknown is not zero, and Not Rated is not F

The rule behind KAG works in both directions. V10 never turns a missing fact into measured danger, and never into credit. Where Pharos searched exhaustively and an issuer still does not disclose something material, the charge stays. Report cards file it under "The issuer has not disclosed this," separate from measured risk. Before release, every coin rated D or F was checked again against primary sources: each charge pulling its score down had to be true, current and attributable to that coin, and none could stand only because nobody had looked for the evidence.

The same discipline now applies to exits. V9 sometimes read a partial measurement, such as one shallow pool or a lower bound on what a route can pay, as proof that a coin's exit was closed, and scored Exit below the 35-point floor, often at zero. V10 accepts only a complete measurement as that proof. A partial one, a documented term or a model can still earn credit, but it can no longer push Exit below the floor. That lifted several coins out of F: Reservoir's rUSD rose from 19 to 47 and Mento's CADm from 19 to 45, both now D. It can also leave a coin Not Rated: once its exit no longer counts as measured, a coin whose Backing evidence is thin as well has too little measured to rate honestly.

When too much is unknown to rate honestly, the answer is NR. At launch, Not Rated rose from 13 to 22 coins. FinChain's FUSD is the clearest example: its candidate score fell into F territory, but an F requires at least one measured, attributable danger, and none exists, so it is Not Rated instead. eMXN, thBILL, USDR, QCAD and Monetrix's USDM join it for insufficient evidence after research, the exit change adds USDY, GBPe and Indigo's iUSD, and the oracle change adds USDh. One coin moves the other way: Midas's mTBILL is now rated C- (50).

Before release, every Not Rated coin received its own research pass. Coins stay Not Rated where the facts needed to rate them, such as a current reserve breakdown, the holder's legal claim or a costed way out, are not public.

## What changed since launch

*Updated October 5, 2026, for the v10.08 release.*

The pillars, the 40/35/25 weights and the three principles above are unchanged. The point releases since October 2 make "unknown is not zero" more exact, and the board has grown from 331 to 396 cards. Each release is itemized in the [scoring changelog](/methodology/scoring-changelog/).

**Every gap names its cause (v10.01).** A missing fact on a report card now says why it is missing: a Pharos pipeline failure, public data Pharos has not yet curated, issuer non-disclosure found by research, a question not yet researched, or a measured adverse fact. Pharos's own gaps stay visible but cost the coin nothing, and the whole-score ceilings for missing data are gone. Non-disclosure and unresearched questions keep bounded charges, and only they still earn the 35-point Exit floor. On the October 3 capture 126 scores rose and two fell. Not Rated fell from 23 to 17, with KAG among the coins that moved to NR: a computed F without a measured adverse fact is withheld.

**Who mints, and through what process (v10.02 to v10.06).** Whether issuance has an economic limit and how the issuer decides to use it are now graded separately. Delayed, flash-resistant on-chain token governance earns a better rung than unbounded issuance without it, and an unavoidable public minority veto earns more; ZCHF rose from 44 (D) to 81 (A-) on that test. v10.05 added operationally governed issuance: discretionary expansion needs public token governance, while formula interest may run immediately inside reviewed limits. It also applies one voting-control test everywhere, asking whether a single party can pass those votes alone or replace whoever casts them. DAI and USDS first fell when their governance could not be certified, then rose to 74 (B) and 71 (B) under the new rung. crvUSD qualified as governed at 69 (B-), then returned to 44 (D) because Convex's 3-of-5 Safe can replace the caster of 54.1% of veCRV; scrvUSD followed. GHO fell from 72 (B) to 42 (D) once a Risk Council 2-of-3 Safe direct mint path was verified.

v10.06 removed a 55-point grant that unbounded mint authority received whenever reserve reconciliation was unknown. Known power is now priced from its evidenced actor and process, and the missing reconciliation is disclosed as an open question. On the October 4 captures 71 scores fell by 1 to 18 points, none rose, and F grew from 58 to 96 coins. These are not new adverse findings: the scores lost credit that absent evidence had been granting.

**Labels that mean what they say (v10.04, v10.07).** v10.04 stopped publishing 599 facts as "Not yet researched" that no research could close, such as maturity on cash reserves and floating-point remainders, with no score change. v10.07 binds exit-route research to the route rather than the four-hourly data run, so 138 researched route facts no longer revert to "Not yet researched." Seven scores rose by 1 to 5 points, lifting IDRT and USDA out of F.

**v10.08.** This release widens what Pharos can see. In Control, weighted multisig quorums count as known topology, and executors that can make arbitrary calls are scored, once reviewed, at their full worst-case reach. In Backing, perpetual and open-ended instruments take the longest maturity band instead of N/A or an invented maximum, and business-day settlement terms are walked through reviewed jurisdiction calendars at their worst case, failing closed. In Exit and supply, synchronous ERC-4626 vaults get exact, complete unwind measurements; authenticated pending-message readers for CCIP, LayerZero OFT and the OP-stack and Arbitrum canonical bridges make exhaustive supply attribution possible; balances on halted chains are admitted as frozen liabilities at their final head; and native inventories gain a full census with a 1e-5 dust tolerance. Same-chain HyperCore system transport gets its own route family, Uniswap V3 and V4 pools gain exact identity recovery, and Sui CLMM, Meteora DLMM and Solidly V2 quotes are collected in shadow, not yet scored. New intake lanes accept independent wrapper accounting and adverse withdrawal entitlements. Where Exit routes are known to share a failure domain, that correlation is published as a known fact, not as an unresearched one.

One change runs the other way. Open questions that reviewers had scoped on a coin's controls were silently ignored; v10.08 publishes them, typed by subject: custody and independence, authority, or execution scope. Some cards will therefore show more "Not yet researched" items than before, although nothing about those coins got worse. The unknowns were always there. Unknown is still not zero: these questions are published as unknowns, never as measured danger, and close only with evidence.

## Go read your stablecoin's report card

V10 is live. The [Safety Scores board](/safety-scores/) shows all three pillars for every tracked stablecoin, and each coin page carries its full report card: the routes, controls and reserve facts behind each pillar, and the reason behind every cap. The formula, weights, ceilings and policy values are on the [methodology page](/methodology/), every change is listed in the [scoring changelog](/methodology/scoring-changelog/), and the code remains [fully open source](https://github.com/TokenBrice/pharos-watch).

V9 promised that scores would keep moving as "unknown" was replaced by "measured." V10 is a large batch of that work, written into the method. If a score looks wrong to you, the reasoning is on the card to challenge.

See you at the lighthouse. 🗼

	/- TokenBrice

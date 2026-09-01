import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "busd-paxos-2023",
  eyebrow: "Regulatory shutdown",
  title: "BUSD: the regulator's off-switch",
  subtitle:
    "The third-largest stablecoin did not depeg; it was lawfully wound down. A fully-reserved, solvent coin can still die by order.",
  lead: [
    "Binance USD never broke its dollar peg. At its November 2022 all-time high it was the third-largest stablecoin in circulation, with a market value around $23.5 billion; by the February 2023 regulatory action, Paxos's reserve report put BUSD near $16 billion, fully backed one-for-one by US Treasuries and overnight reverse repo held in bankruptcy-remote accounts. By the conventional test of a stablecoin (can holders redeem at par) BUSD passed throughout its decline and beyond. It died anyway.",
    "On February 3, 2023 the SEC sent Paxos a Wells notice arguing that BUSD was an unregistered security. Ten days later, on February 13, the New York Department of Financial Services ordered Paxos to stop minting new BUSD, effective February 21, citing unresolved failures in Paxos's oversight of its relationship with Binance. Minting was the only lever that mattered: a fiat-backed token whose issuance is switched off can only shrink. Redemptions stayed open and the peg held, but the supply could now move in one direction.",
    "What followed was not a run but a managed wind-down. Paxos guaranteed redemption through at least February 2024, for US dollars or conversion to its other regulated stablecoin, Pax Dollar (USDP), and the peg never wavered. Binance, the demand engine behind BUSD, ended support on its platform in December 2023 and auto-converted remaining user balances to First Digital USD (FDUSD). Circulating BUSD decayed monotonically toward zero. This is the archive's reference case for a failure mode that has nothing to do with backing: regulatory mortality. Redeemability is not survival.",
  ],
  takeaways: [
    "BUSD never depegged and was never undercollateralized: it was fully reserved 1:1 in Treasuries and reverse repo, and stayed redeemable at par the entire time it shrank.",
    "It died by order, not by market: an SEC Wells notice (Feb 3, 2023) and an NYDFS minting halt (Feb 13, effective Feb 21) switched off issuance, and a no-mint fiat token can only decline.",
    "The wind-down was orderly: redemptions for USD or USDP were guaranteed through at least February 2024, and the peg held throughout.",
    "Demand was rented from one venue: Binance ended BUSD support in December 2023 and auto-converted balances to FDUSD, collapsing the float.",
  ],
  relatedCoins: [
    {
      coinId: "usdp-paxos",
      note: "Pax Dollar, Paxos's other NYDFS-regulated stablecoin and the in-house redemption alternative offered to BUSD holders. The NYDFS order and SEC Wells notice were scoped to BUSD only; USDP and Paxos's broader business were explicitly unaffected.",
    },
    {
      coinId: "fdusd-first-digital",
      note: "First Digital USD, the successor Binance steered users toward. When Binance ended BUSD support, it auto-converted remaining balances to FDUSD at 1:1, transferring the exchange's stablecoin float to a new issuer outside the NYDFS perimeter.",
    },
  ],
  archetype: "fiat-cash",
  outcome: "died",
  eventDateLabel: "February 2023",
  eventWindow: {
    startISO: "2023-02-03",
    endISO: "2023-12-31",
  },
  cemeteryId: "busd-binance-usd-2023-02",
  timeline: [
    {
      dateISO: "2023-02-03",
      headline: "SEC issues a Wells notice over BUSD",
      body: "The Securities and Exchange Commission sent Paxos a Wells notice stating that staff may recommend enforcement because BUSD is, in the SEC's view, an unregistered security. Paxos disclosed the notice publicly on February 13 and said it categorically disagreed, prepared to litigate if necessary. The notice was scoped to BUSD only.",
      severity: "med",
    },
    {
      dateISO: "2023-02-13",
      headline: "NYDFS orders Paxos to stop minting BUSD",
      body: "The New York Department of Financial Services directed Paxos to cease minting new BUSD, citing several unresolved issues in Paxos's oversight of its relationship with Binance. The regulator said it would monitor Paxos to ensure redemptions proceeded in an orderly fashion. Paxos announced it would end its BUSD relationship with Binance the same day.",
      severity: "high",
      href: "https://www.dfs.ny.gov/consumers/alerts/Paxos_and_Binance",
    },
    {
      dateISO: "2023-02-21",
      headline: "Minting halt takes effect; supply can only fall",
      body: "Paxos stopped issuing new BUSD as directed. With minting switched off and redemptions kept open, the only available direction for circulating supply was downward. Reserves remained intact (Paxos reported roughly $16 billion in Treasuries and reverse repo as of January 31), but a fiat-backed coin that cannot be minted is on a one-way path to retirement.",
      severity: "high",
    },
    {
      dateISO: "2023-08-31",
      headline: "Binance signals a gradual exit",
      body: "Over the months that followed, Binance, the exchange whose trading pairs and incentives had created most BUSD demand, telegraphed that it would gradually phase out support for the token. With issuance frozen and its primary demand venue retreating, BUSD's float drained steadily through 2023.",
      severity: "low",
    },
    {
      dateISO: "2023-12-15",
      headline: "Binance ends BUSD support on its platform",
      body: "Binance ceased support for BUSD products, delisting spot pairs and urging users to withdraw or convert their balances. It offered conversion to First Digital USD (FDUSD) at 1:1 with no fee, completing the migration of its stablecoin float to a different issuer.",
      severity: "med",
      href: "https://www.binance.com/en/support/announcement/notice-regarding-the-removal-of-busd-and-conversion-of-busd-to-fdusd-1c98ce7bb464422dbbaeda7066ae445b",
    },
    {
      dateISO: "2023-12-31",
      headline: "Remaining Binance balances auto-converted to FDUSD",
      body: "From 03:00 UTC on December 31, BUSD withdrawals on Binance were disabled and remaining user balances (outside a handful of jurisdictions) were automatically converted to FDUSD at 1:1. On-platform demand effectively went to zero, even as Paxos kept honoring redemptions at par for holders who still held the token.",
      severity: "med",
    },
    {
      dateISO: "2024-02-29",
      headline: "Paxos redemption guarantee runs to its committed horizon",
      body: "Paxos had committed to support BUSD and honor redemptions (in USD or via conversion to USDP) through at least February 2024. The peg held the entire way. BUSD's death was a scheduled wind-down to a near-zero float, not a collapse: the coin was solvent and redeemable at par the day it effectively ceased to matter.",
      severity: "low",
    },
  ],
  sections: [
    {
      heading: "What happened",
      paragraphs: [
        "BUSD was a plain fiat-backed stablecoin issued by Paxos Trust Company, a New York limited-purpose trust company under NYDFS supervision. Each token was redeemable one-for-one against a reserve of short-dated US Treasuries and overnight reverse repo, segregated and held in bankruptcy-remote accounts. As of January 31, 2023, that reserve stood at roughly $16 billion. There was no structural fragility in the backing: no algorithmic stabilizer, no volatile collateral, no thin liquidity base.",
        "On February 3, 2023 the SEC delivered a Wells notice asserting that BUSD was an unregistered security. On February 13, the NYDFS ordered Paxos to stop minting, effective February 21, on the grounds that Paxos had not adequately overseen its Binance relationship, not on any claim that the reserves were short. The two actions came from different angles, securities law and prudential supervision, but converged on the same outcome: new BUSD could no longer be created.",
        "From there the coin simply ran down. Redemptions stayed open, the dollar peg held, and Binance migrated its users to FDUSD over the course of 2023, auto-converting the last balances at year-end. The late-2022 high of about $23.5 billion bled toward zero with no panic and no loss to holders. BUSD is recorded in the Pharos cemetery with cause of death 'regulatory', the cleanest example in the archive of a stablecoin that was killed rather than one that failed.",
      ],
    },
    {
      heading: "Why a solvent coin still died",
      paragraphs: [
        "Every other failure in this archive is a market failure: a peg that could not hold because the mechanism, the collateral, or the liquidity gave way under stress. BUSD inverts the pattern. The mechanism was sound, the collateral was cash and Treasuries, and the peg never broke. What ended the coin was an exercise of authority: a securities regulator and a state banking regulator acting on supervisory and legal grounds unrelated to whether the token was money-good.",
        "The decisive lever was the mint function. A fiat-backed stablecoin grows only when an authorized issuer creates new tokens against incoming dollars; freeze that, and the asset can do nothing but shrink as redemptions retire supply. There is no reflexive defense, no community vote, no reserve operation that can reverse a minting ban; the legal off-switch sits upstream of every market mechanism. Solvency buys an orderly exit, but it does not buy a future.",
        "This is regulatory mortality, and it is a distinct risk axis from the credit, liquidity, and reflexivity risks that dominate the rest of the cemetery. It depends on the issuer's jurisdiction, charter, and counterparties far more than on its balance sheet. A perfectly reserved coin domiciled under a regulator willing to use its powers carries a tail risk that no amount of over-collateralization can offset.",
      ],
    },
    {
      heading: "The orderly wind-down",
      paragraphs: [
        "Because the backing was real, the death looked nothing like a depeg. Paxos publicly committed to keep BUSD fully supported and redeemable through at least February 2024, with holders able to take US dollars or convert into Pax Dollar (USDP), Paxos's other regulated stablecoin. The NYDFS framed its own role as ensuring redemptions proceeded in an orderly fashion under enhanced compliance protocols. No holder who wanted out at par was prevented from getting out at par.",
        "The peg held throughout the wind-down precisely because the reserve was intact and redemption stayed open. There was no secondary-market discount of the kind that hit USDC during the Silicon Valley Bank weekend, where the question was whether the cash leg was reachable. With BUSD the cash was always reachable; only issuance was forbidden. The price stayed at a dollar while the supply curve slid toward the floor.",
        "This is the line the case study is built to draw: redeemability is not survival. A stablecoin can clear every solvency and liquidity test, honor every redemption, and still cease to exist because the entity allowed to mint it has been ordered to stop. Monitoring that watches only price and reserves will score BUSD as healthy right up to the moment it disappears.",
      ],
    },
    {
      heading: "The successor shuffle",
      paragraphs: [
        "BUSD's demand was never broadly organic; it was concentrated on Binance, where the exchange's trading pairs, fee structure, and promotion had made it the house stablecoin. Once issuance was frozen, that concentration determined how the float would disperse. Binance announced a gradual exit, ended BUSD support on December 15, 2023, and from December 31 auto-converted remaining balances to First Digital USD (FDUSD) at 1:1.",
        "The migration is instructive on its own terms. The same demand that had inflated BUSD to third place did not evaporate. It relocated, almost intact, to a different stablecoin issued by a different company outside the NYDFS perimeter. FDUSD inherited much of the exchange-driven float that BUSD lost. Regulating one issuer's token did not reduce the underlying demand for an exchange-native dollar; it changed which logo sat on top of it.",
        "Holders who stayed with Paxos rather than following Binance's conversion had the USDP off-ramp, keeping their balance with the original, NYDFS-supervised issuer. The episode thus split into two paths: an in-house redemption to USDP for those who valued the regulated issuer, and a platform-driven conversion to FDUSD for the much larger pool whose only attachment to BUSD was that Binance listed it.",
      ],
    },
    {
      heading: "Lessons",
      paragraphs: [
        "Redeemability is not survival. A stablecoin can be fully reserved, perfectly solvent, and redeemable at par and still be retired by an order it cannot appeal at the protocol level. Risk frameworks that grade only backing quality and peg stability will miss this entirely; issuer jurisdiction, charter, and the regulator's demonstrated willingness to act are first-order inputs, not footnotes.",
        "The mint function is the single point of legal failure for a fiat-backed coin. Whoever can lawfully compel the issuer to stop minting can guarantee the asset's slow death regardless of its balance sheet. Concentration of issuance authority under one supervisor is a structural exposure that no reserve can hedge.",
        "Rented demand disperses; it does not disappear. BUSD's float was a function of one exchange's promotion, so when the token was switched off the demand simply migrated to FDUSD. A stablecoin whose circulation depends on a single venue is one policy decision away from handing its market to a successor, useful context when reading the supply growth of any exchange-native stablecoin.",
      ],
    },
  ],
  watchpoints: [
    "Issuer jurisdiction and charter: a coin supervised by a regulator empowered to halt minting carries a legal tail risk that full reserves cannot offset.",
    "Concentration of issuance authority: when one supervisor or one entity controls the mint function, that is the single point at which the asset can be lawfully terminated.",
    "Demand concentrated on a single venue or exchange, where a platform's delisting or auto-conversion can collapse the float independent of backing or peg.",
    "Open securities-law or enforcement actions (Wells notices, cease-and-desist orders) against an issuer, which can end a token without any solvency or liquidity trigger.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/fiat-cash/", label: "Mechanism: fiat-cash stablecoins" },
    { href: "/cemetery/", label: "Stablecoin cemetery" },
    { href: "/stablecoin/usdp-paxos/", label: "USDP: Pax Dollar (redemption alternative)" },
    { href: "/stablecoin/fdusd-first-digital/", label: "FDUSD: First Digital USD (Binance successor)" },
  ],
  sources: [
    {
      label: "Paxos: Paxos Will Halt Minting New BUSD Tokens",
      href: "https://www.paxos.com/newsroom/paxos-will-halt-minting-new-busd-tokens",
    },
    {
      label: "NYDFS: Notice Regarding Paxos-Issued BUSD (consumer alert)",
      href: "https://www.dfs.ny.gov/consumers/alerts/Paxos_and_Binance",
    },
    {
      label: "CoinDesk: Paxos to Stop Minting Stablecoin BUSD Following Regulatory Action (Feb 13, 2023)",
      href: "https://www.coindesk.com/business/2023/02/13/paxos-to-stop-minting-stablecoin-busd-following-regulatory-action",
    },
    {
      label: "Binance: Notice Regarding the Removal of BUSD and Conversion of BUSD to FDUSD",
      href: "https://www.binance.com/en/support/announcement/notice-regarding-the-removal-of-busd-and-conversion-of-busd-to-fdusd-1c98ce7bb464422dbbaeda7066ae445b",
    },
  ],
  metaDescription:
    "BUSD never depegged. The third-largest stablecoin was lawfully wound down in 2023 after the SEC and NYDFS acted: proof that redeemability is not survival.",
  datePublished: "2026-06-15",
};

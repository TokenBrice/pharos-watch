import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "usr-resolv-2026",
  eyebrow: "Operational-security failure",
  title: "Resolv USD: when one key minted eighty million",
  subtitle:
    "USR was a delta-neutral synthetic dollar with an insurance tranche and real-time reserve attestations. None of it mattered once a single privileged key could mint unbacked supply with no cap.",
  lead: [
    "Resolv USD (USR) was a delta-neutral synthetic dollar: long spot ETH and BTC on-chain, balanced by equal-and-opposite short perpetual futures on centralized venues, with a junior RLP tranche meant to absorb negative funding and liquidation risk. On paper the collateral always netted to roughly a dollar, and an Apostro feed published reserve figures in real time. That design answered the question most synthetic-dollar critiques ask first: is the hedge sound?",
    "On 22 March 2026 a different question got answered. Beginning around 02:21 UTC, the privileged role that finalizes mint requests in USR's issuance contract was driven to mint roughly 80M USR against the order of $100K-$200K of deposited stablecoins. The role sat behind a single externally owned account with no oracle check, no amount validation, and no maximum-mint guard, so a 100K USDC deposit could return about 50M USR, iterated until tens of millions of unbacked tokens existed. USR fell below $0.80 within minutes and printed as low as roughly $0.025 on Curve; Pharos recorded a low near $0.098, a peak deviation around -9025 bps.",
  ],
  takeaways: [
    "Minting authority, not hedge design, was the failure point: a single EOA could complete mints with no oracle check, no per-transaction amount limit, and no supply cap.",
    "On 22 March 2026 ~80M unbacked USR were minted against six figures of real collateral and sold for ~$25M of ETH; USR fell below $0.80 within minutes and printed as low as ~$0.025.",
    "A sound delta-neutral book and real-time reserve attestation protect the value of issued supply; they say nothing about whether tokens can be issued without assets behind them.",
    "Burns and an allowlist trimmed the net loss toward ~$34M, but the arithmetic was fixed once the supply existed; USR was left ~55% collateralized and frozen on 27 April 2026.",
  ],
  primaryCoinId: "usr-resolv",
  depegEventSlug: "usr-2026-03-22",
  archetype: "synthetic-delta-neutral",
  outcome: "died",
  eventDateLabel: "March 2026",
  eventWindow: {
    startISO: "2026-03-22",
    endISO: "2026-04-27",
    peakDeviationBps: -9025,
    lowPrice: 0.098,
  },
  cemeteryId: "usr-resolv",
  timeline: [
    {
      dateISO: "2026-03-22",
      headline: "Unbacked minting begins",
      body: "Around 02:21 UTC the privileged mint-completion role is used to issue USR far in excess of deposited value, roughly 50M USR for a 100K USDC deposit, repeated until about 80M unbacked tokens exist. USR drops below $0.80 within minutes and bottoms near $0.025 on Curve as the proceeds are sold into DEX liquidity.",
      severity: "high",
      href: "https://www.coindesk.com/markets/2026/03/23/resolv-stablecoin-drops-70-after-usd80-million-exploit-after-attacker-mints-usr",
    },
    {
      dateISO: "2026-03-22",
      headline: "Issuance paused; collateral reported intact",
      body: "Resolv pauses the contracts and states the underlying collateral pool is intact and that the issue is isolated to USR issuance mechanics. Roughly $0.5M of redemptions clear before the pause. The cash-out leaves the attacker holding on the order of $25M, largely in ETH.",
      severity: "high",
      href: "https://cointelegraph.com/news/resolv-says-no-assets-lost-as-defi-partners-respond-to-usr-depeg",
    },
    {
      dateISO: "2026-03-26",
      headline: "First burn of counterfeit supply",
      body: "Resolv neutralizes about 46M of the unbacked USR, roughly 57% of the minted supply, through direct burns and blacklisting of attacker-held wrapped tokens. Pre-exploit holders are routed through an allowlist to redeem 1:1, while open-market trading stays suspended.",
      severity: "med",
    },
    {
      dateISO: "2026-04-06",
      headline: "Second burn, but no recovery",
      body: "A contract upgrade destroys a further ~36.7M attacker-held tokens, trimming the net loss to roughly $34M. USR does not return to peg; reporting puts the protocol at about $95M of assets against roughly $173M of liabilities, near 55% collateralization.",
      severity: "med",
      href: "https://cryptonews.net/news/security/32662430/",
    },
    {
      dateISO: "2026-04-27",
      headline: "USR frozen",
      body: "With liabilities exceeding assets and no path back to par, USR is frozen. Pharos records the asset as deceased under counterparty failure; public market-cap context was closer to the low hundreds of millions, while broader protocol asset/TVL figures were higher.",
      severity: "high",
    },
  ],
  sections: [
    {
      id: "what-happened",
      heading: "What happened",
      paragraphs: [
        "USR's issuance flow used a two-step swap: a request to mint, then a privileged completion that released the minted tokens. The role that completed those requests was held by a single externally owned account rather than a multisig or guarded module, and the path it executed had no oracle to value the deposit, no per-transaction amount check, and no maximum-mint ceiling. Whatever ratio the completion was instructed to honor, it honored.",
        "Starting near 02:21 UTC on 22 March 2026, that completion path was used to mint roughly 50M USR against a 100K USDC deposit and repeated until about 80M unbacked USR existed against six figures of real collateral. The minted supply was sold through decentralized exchanges into USDC and USDT, converted to ETH, and moved to a separate wallet holding on the order of $25M. USR fell below $0.80 within minutes and printed as low as roughly $0.025 on Curve; Pharos's archived series for the asset shows a low near $0.098, a deviation around -9025 bps.",
        "Resolv described the event as a compromised private key and a targeted infrastructure compromise. Independent analysts and an auditor instead stressed the structural shape of the mint path, the single-key role and absent guards, as what made any such compromise catastrophic. The verifiable common ground is narrow and sufficient: one privileged key could mint unbacked supply with no cap. Whether the trigger was an external key theft or an insider action is not something the public record settles, and Pharos does not assert a motive here.",
      ],
    },
    {
      id: "why-delta-neutral-backing-did-not-matter",
      heading: "Why delta-neutral backing did not matter",
      paragraphs: [
        "A synthetic-delta-neutral dollar earns trust by making its collateral predictable: long spot, short perp, net exposure near zero, with a junior tranche to absorb funding and liquidation noise. Resolv had all of that, plus a real-time reserve attestation. Those properties govern whether the assets behind each legitimately issued token hold their value. They say nothing about whether tokens can be issued without assets behind them.",
        "The exploit attacked issuance, not collateral. Every freshly minted USR diluted the same fixed reserve pool, so the question stopped being how well the hedge tracked the dollar and became how many claims now pointed at it. With roughly 80M unbacked tokens added, the reserve that was sound for the legitimate float was suddenly fractional against the total. The RLP insurance tranche, designed for market risk such as adverse funding, was not sized for an unbacked-supply event and was wiped out; the shortfall propagated to a downstream lender holding a multi-million-dollar USR position.",
        "This is the structural lesson for the archetype: a defensible hedge and a transparent reserve are necessary but not sufficient. They protect the value of issued supply; they do not protect the integrity of issuance. A reserve attestation that reports the assets cannot, on its own, catch a supply side that has been corrupted by a privileged mint.",
      ],
    },
    {
      id: "single-key-attack-surface",
      heading: "The single-key attack surface",
      paragraphs: [
        "The decisive weakness was governance plumbing, not financial engineering. A role with authority to release minted tokens was held by one externally owned account, and the code path it drove lacked the checks that would have made the authority survivable: an oracle to sanity-check deposit value against tokens issued, a per-call amount limit, and a hard cap on supply growth per interval. Any one of those would have bounded the damage; together their absence turned a single credential into an unlimited mint.",
        "Privileged minting is exactly the control surface Pharos treats as a first-class risk. FreezeWatch tracks whether an issuer holds freeze, blacklist, and supply controls precisely because those powers cut both ways: Resolv used its freeze and burn authority to destroy roughly 46M, then a further ~36.7M, of counterfeit tokens, which is the same class of privileged control that, on the issuance side, allowed the unbacked mint in the first place. The asset's flags already marked it centralized-dependent on governance; the incident is what that dependency looks like when the key fails.",
        "Containment also showed the limits of after-the-fact control. Burns reduced the net loss from the headline ~$80M minted toward roughly $34M, and an allowlist let pre-exploit holders redeem first, but the burns could not reach tokens already swapped into ETH and the redemption queue could only pay out the reserve that remained. The arithmetic was fixed once the supply was created.",
      ],
    },
    {
      id: "lessons",
      heading: "Lessons",
      paragraphs: [
        "Treat minting authority as the primary attack surface. For any issuer, the question is not only what backs the token but who, or what, can create it, under what limits, and behind how many independent approvals. A single-EOA mint role with no oracle, amount check, or supply cap is a maximum-severity finding regardless of how strong the reserve looks.",
        "Bound issuance with code, not trust. Per-transaction caps, rate limits on supply growth, and an oracle relating deposited value to tokens issued convert a key compromise from terminal to merely costly. Insurance tranches sized for market risk should not be mistaken for protection against unbacked-supply events; those are different threat models.",
        "Read reserve attestations for what they cover. A real-time feed on the asset side is genuine assurance about collateral and no assurance about issuance integrity. When assessing a synthetic-delta-neutral dollar, weigh the custody of privileged keys, the guardrails on the mint path, and the issuer's freeze and blacklist powers alongside the hedge, not after it.",
      ],
    },
  ],
  dataWidgets: [
    {
      kind: "peg-deviation",
      coinId: "usr-resolv",
      caption:
        "Archived Pharos peg-deviation series for USR through the March 2026 unbacked-mint crater, with the low near $0.098 (about -9025 bps).",
    },
  ],
  watchpoints: [
    "Who controls the mint role on a synthetic-delta-neutral dollar, single key versus multisig versus guarded module, and whether the mint path enforces an oracle check, a per-transaction amount limit, and a supply-growth cap.",
    "Whether an insurance or junior tranche is sized only for market risk such as funding and liquidation, leaving unbacked-supply events uncovered.",
    "FreezeWatch status: freeze, blacklist, and supply controls aid recovery after a compromise but are themselves privileged surfaces that can be turned against holders.",
    "Downstream exposure: lending markets and integrators that price the asset at a hardcoded $1 can convert one issuer's failure into systemic bad debt before the depeg is reflected on-chain.",
  ],
  crossLinks: [
    {
      href: "/learn/mechanisms/synthetic-delta-neutral/",
      label: "Mechanism: synthetic delta-neutral dollars",
    },
    {
      href: "/stablecoin/usr-resolv/",
      label: "USR on Pharos",
    },
    {
      href: "/cemetery/",
      label: "Stablecoin cemetery",
    },
    {
      href: "/dependency-map/",
      label: "Dependency map",
    },
    {
      href: "/learn/case-studies/usde-oracle-2025/",
      label: "Case study: USDe, a delta-neutral dollar that held",
    },
  ],
  sources: [
    {
      label: "The Block: USR depegs after attacker mints 80M unbacked tokens",
      href: "https://www.theblock.co/post/394582/resolvs-usr-stablecoin-depegs-after-attacker-mints-80-million-unbacked-tokens-extracts-roughly-25-million",
    },
    {
      label: "CoinDesk: Resolv stablecoin drops 70% after attacker extracts $25M in ETH",
      href: "https://www.coindesk.com/markets/2026/03/23/resolv-stablecoin-drops-70-after-usd80-million-exploit-after-attacker-mints-usr",
    },
    {
      label: "Cointelegraph: Resolv says no assets lost as DeFi partners respond to USR depeg",
      href: "https://cointelegraph.com/news/resolv-says-no-assets-lost-as-defi-partners-respond-to-usr-depeg",
    },
    {
      label: "Blockaid: How a compromised key minted $80M in USR",
      href: "https://blockaid.io/blog/how-a-compromised-key-minted-80m-in-resolvs-usr-stablecoin-and-triggered-a-depeg",
    },
    {
      label: "Cryptonews: Resolv Labs burns hacked USR as exploit losses hit $34M",
      href: "https://cryptonews.net/news/security/32662430/",
    },
  ],
  metaDescription:
    "USR collapsed in March 2026 when one privileged key minted ~80M unbacked tokens, cratering it to ~$0.098: a minting-authority failure, not a hedge failure.",
  datePublished: "2026-05-23",
};

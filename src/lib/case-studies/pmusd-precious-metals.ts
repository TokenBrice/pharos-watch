import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "pmusd-precious-metals",
  eyebrow: "Chronic fragility",
  title: "pmUSD and the in-situ gold collateral chain",
  subtitle:
    "RAAC's gold-RWA dollar token has never settled at par (hundreds of recorded sub-peg events, then an ~88% crater to its May 4, 2026 all-time low), yet it is still live. The story is structural, not a single blowup.",
  lead: [
    "pmUSD is a live dollar stablecoin issued by RAAC, built as a fork of f(x) Protocol 1.0 that the project labels RWf(x). Where the original f(x) splits ETH collateral into a stable token and a leveraged companion, RAAC applies the same volatility-splitting to gold: pmUSD is the stable fToken and xPM (the gold-volatility companion) absorbs the swings. What sits underneath is unusual. pmUSD is minted against a base token RAAC calls TokenBlender, which is itself minted against ION.au, a digital security issued by I-ON Digital Corp that represents a claim on in-situ (that is, un-mined, in-the-ground) gold reserves rather than vaulted bullion.",
    "Pharos has recorded 354 distinct deviation events on pmUSD across its February-to-May 2026 drift: 337 below par and 17 above. The overwhelming majority of the below-peg readings are shallow but persistent, clustered between roughly 100 and 356 basis points under par, with a median around 174 bps and most readings in the 100-to-200 bps band. Rather than occasionally wobbling and snapping back, the token has spent most of its tracked life trading at a visible discount, with only 17 brief excursions above par.",
    "In early May 2026, the drift became a crater. pmUSD fell from near par into a deep selloff that reached a CoinGecko all-time low near $0.116 on May 4, a peak deviation around 8,840 bps, roughly 88% below the reference peg. It later recovered partway, trading around the low-to-mid $0.70s by mid-June, but it did not snap back to par. The token remains live, so Pharos classifies the outcome as wounded rather than collapsed. This study treats pmUSD as a case of chronic structural fragility: a layered, opaque collateral stack, manager-only minting, and a one-directional peg-defense module that together explain both the persistent discount and how a single week could erase most of the price.",
  ],
  takeaways: [
    "pmUSD has never reliably held par: 337 below-peg readings clustered mostly at 100-200 bps under $1, then an ~88% crater to a May 4, 2026 all-time low: chronic fragility, not a single blowup.",
    "Its backing is a multi-layer chain (pmUSD → TokenBlender → ION.au → in-situ, un-mined gold) that puts assertion, not redeemable metal, between the holder and the collateral.",
    "The peg defense is a reserve-gated, one-directional PSM plus manager-only minting, so there is no symmetric arbitrage to pin par; once the module pauses, a thin Curve market sets the price.",
    "Sustained sub-peg drift is itself the signal: a token living at a standing discount for months is telling you its backing is doubted or its floor is finite.",
  ],
  primaryCoinId: "pmusd-precious-metals",
  archetype: "cdp",
  outcome: "wounded",
  eventDateLabel: "2026 (ongoing)",
  eventWindow: {
    startISO: "2026-02-15",
    endISO: "2026-05-04",
    peakDeviationBps: -8840,
    lowPrice: 0.1162,
  },
  timeline: [
    {
      dateISO: "2025-10-02",
      headline: "RAAC and I-ON Digital announce a $200M tokenized-gold tranche",
      body: "RAAC, an RWA lending protocol, and I-ON Digital Corp (OTCQB: IONI) announced an initial $200 million tranche of in-situ gold to be digitized as ION.au and onboarded into RAAC's ecosystem, with pmUSD slated to launch as a stablecoin partially collateralized by that asset. The arrangement leaned on third-party trust signals: a Chainlink Build designation, Chainlink Proof of Reserve, Instruxi attestation, and Curve founder Michael Egorov listed as an advisor.",
      severity: "low",
      href: "https://www.prnewswire.com/news-releases/raac-adds-200m-of-gold-to-defi-with-listed-tokenizer-i-on-302573746.html",
    },
    {
      dateISO: "2026-01-11",
      headline: "pmUSD reaches its recorded high near $1.01",
      body: "pmUSD's all-time high of roughly $1.01 was printed on January 11, 2026, against a thin float of under ten million tokens concentrated in a small set of Curve pools. It is the last point at which the token traded clearly at or above par before the persistent discount set in.",
      severity: "low",
    },
    {
      dateISO: "2026-02-15",
      headline: "Start of the persistent sub-peg drift",
      body: "From February 15, 2026, Pharos begins recording near-continuous below-peg excursions. Over the following months the deviations cluster between about 100 and 356 bps under par (median near 174 bps), interrupted only by 17 brief above-peg ticks. The pattern is chronic discount, not episodic stress.",
      severity: "med",
    },
    {
      dateISO: "2026-03-31",
      headline: "I-ON files a late annual-report notice",
      body: "I-ON Digital filed an NT 10-K notice around the same period the market was digesting the gold-token and DeFi-liquidity model. The filing is a cleaner public-market signal than the previously cited equity move: the same issuer disclosures that traditional investors were reading sat beneath the collateral story DeFi was already discounting.",
      severity: "med",
    },
    {
      dateISO: "2026-05-04",
      headline: "Selloff reaches an all-time low near $0.116",
      body: "After the early-May break began, pmUSD reached a CoinGecko all-time low around $0.116 on May 4, a peak deviation near 8,840 bps, roughly 88% below the reference peg. It later recovered into the low-to-mid $0.70s by mid-June, but that partial recovery still left the token at a steep, unresolved discount rather than back at par.",
      severity: "high",
    },
  ],
  sections: [
    {
      heading: "An exotic collateral stack",
      paragraphs: [
        "pmUSD's backing runs through three layers, each abstracting away from the asset below it. At the top, pmUSD is the stable fToken in an f(x)-style design; xPM is the paired token that is meant to soak up gold-price volatility so pmUSD can hold a stable net asset value. Below pmUSD sits TokenBlender (TB), a base token held in RAAC's RWf(x) treasury. TB in turn is minted against ION.au, the gold-linked digital security held in the TokenBlender contract. Only at the bottom of this chain does one reach gold, and even there it is not vaulted metal.",
        "ION.au represents what I-ON Digital describes as a senior-secured claim on proven in-situ gold reserves, structured as a tokenized asset-backed security rather than a claim on bullion in a vault. The issuer's framework cites a roughly 5:1 over-collateralization ratio and an approximately 80% haircut to spot when valuing the underlying gold, intended as a buffer against price moves and recovery costs. In-situ gold is un-mined ore in the ground; its value rests on geological reserve classifications and the legal enforceability of mineral-rights claims, not on metal that can be weighed and delivered on demand.",
        "Each layer adds distance between a pmUSD holder and anything liquid. A discount or solvency question at the gold layer propagates up through ION.au to TB to pmUSD, and the holder's recourse runs through smart-contract logic and off-chain legal instruments rather than a redemption window for physical gold. That layering is the defining structural feature of this case.",
      ],
    },
    {
      heading: "Why it persistently trades below $1",
      paragraphs: [
        "A stablecoin holds par when arbitrage is cheap and symmetric in both directions: when the token is below $1, someone can profitably acquire it and redeem or swap for a dollar of value; when it is above $1, someone can mint and sell. pmUSD's design weakens both legs of that loop. Minting is manager-only (system operations run through authorized silo multisigs rather than open, permissionless minting), so ordinary market participants cannot freely create supply to arbitrage a premium, and the supply side of the peg is governed by a small number of controllers.",
        "On the discount side, the primary defense is a Peg Stability Module (PSM) that lets holders swap pmUSD into sUSDS at $1 of face value when pmUSD trades below par on-chain. But that swap is one-directional and reserve-gated: it draws down a finite sUSDS reserve and is configured to pause when that reserve falls below 20% of PSM assets. A reserve-capped, one-way module can absorb a steady trickle of sellers, but it does not arbitrage the token back to a hard par. Once the PSM is depleted or paused, the only remaining buyer of last resort is the open market, and pmUSD's open market is a thin set of Curve pools.",
        "The result is exactly what the record shows: a token that can clear sellers most days but only at a standing discount, because the mechanism that defends the floor is finite and cannot be replenished by permissionless arbitrage the way an over-collateralized, freely redeemable design can. The persistent 100-to-200 bps drift is the price of that asymmetry in normal conditions.",
      ],
    },
    {
      heading: "The May 2026 crater",
      paragraphs: [
        "In early May 2026, the same asymmetry produced a much larger move. pmUSD fell from near par into a selloff that reached roughly $0.116 on May 4. In a deep, freely arbitraged market, an 88% gap in a dollar token would invite overwhelming buy-side pressure; here it only partially closed, recovering into the low-to-mid $0.70s by mid-June rather than snapping back to par. The crater is best read as the chronic fragility expressed under stress rather than as a new, separate failure mode.",
        "Two structural facts make a move of this size mechanically possible. First, the reserve-gated PSM has a hard limit: once its sUSDS reserve crosses the pause threshold, the engineered floor simply switches off, and price discovery reverts to a thin secondary market that can gap far below par on modest flow. Second, the collateral chain offers no fast, public redemption path to gold; a holder cannot convert pmUSD into deliverable metal to enforce a price, so confidence, not arbitrage, sets the level. When confidence in the layered backing wavers, there is little to catch the price until it finds whatever bid the Curve pools will support.",
        "Pharos does not assert a cause for the specific trigger on that day, and the public record does not establish one. What the crater revealed is structural: the depth of the peg defense, the thinness of the market beneath it, and the absence of a redemption backstop that could enforce par independently of sentiment.",
      ],
    },
    {
      heading: "What is and isn't verifiable",
      paragraphs: [
        "Several elements of pmUSD's stack are genuinely checkable on-chain or in public filings. The pmUSD contract, its supply, and its trading history are observable; the f(x)-fork mechanism, the manager-controlled operations pattern, and the PSM's reserve-gated behavior are documented in RAAC's materials and visible in contract logic. I-ON Digital is a reporting public company, and its disclosures, audit opinion, and reserve-classification references can be examined directly. The price record (including the chronic discount, the May 4 all-time low, and the partial recovery visible on aggregators) is the firmest fact in this study.",
        "Other elements rest on issuer assertion and cannot be independently confirmed from on-chain data. The specific in-situ reserve quantities, the exact title and lien documentation over the underlying mineral rights, and the controls that are said to prevent over-issuance are described by the issuer rather than provable by inspecting the chain. The headline coverage figures, the 5:1 ratio and the 80% spot haircut, describe how ION.au's gold layer is valued, not pmUSD's live on-chain solvency, and a conservative reader should treat them as a model of the deepest layer rather than a guarantee at the token a holder actually owns.",
        "The Chainlink Proof of Reserve feed and the Instruxi attestation are real components, but a proof-of-reserve feed verifies that an attested quantity exists at its named source; it does not transform an in-situ gold claim into deliverable bullion, nor does it close the gap between the gold layer and the pmUSD layer. Pharos flags this asset's custody as institutional-unregulated and its reserve as high-risk for exactly these reasons: the structure is partly verifiable and partly asserted, and the unverifiable parts sit closest to the actual collateral. None of this implies fraud or bad faith; it is a statement about what an outside observer can and cannot confirm.",
      ],
    },
    {
      heading: "Lessons",
      paragraphs: [
        "Persistent sub-peg drift is itself a signal, not noise. A token that lives at a 100-to-200 bps discount for months is telling the market that its peg defense is finite or its backing is doubted; PegScore and DEWS treat sustained drift as a standing condition rather than waiting for a single dramatic print. The 337 recorded sub-peg events here are not 337 surprises; they are one continuous structural fact.",
        "Layered collateral concentrates opacity at the layer hardest to verify. The more steps between a stablecoin and a liquid, deliverable asset (pmUSD to TB to ION.au to in-situ gold), the more the holder depends on assertions rather than on an enforceable redemption. A reserve-gated, one-directional PSM can hold a soft floor in calm conditions but cannot manufacture par, and manager-only minting removes the symmetric arbitrage that normally pins a healthy peg. When confidence in the deepest layer slips and the floor mechanism hits its limit, a thin secondary market can gap far below par. pmUSD remains live, but its record is a clear illustration of how exotic backing and asymmetric peg defense produce chronic fragility long before, and during, any single crater.",
      ],
    },
  ],
  dataWidgets: [
    {
      kind: "peg-deviation",
      coinId: "pmusd-precious-metals",
      caption:
        "Hundreds of recorded sub-peg events (mostly 100-200 bps below par) and the early-May 2026 crater to a CoinGecko all-time low near $0.116 (~8,840 bps).",
    },
  ],
  watchpoints: [
    "PSM reserve level: how much sUSDS backs the module and how close it sits to the 20% pause threshold that switches off the engineered floor.",
    "Concentration of control: manager-only minting through authorized silo multisigs means a small set of controllers governs supply and system operations.",
    "Verifiability gap at the gold layer: in-situ reserve quantities, mineral-rights title and lien documentation, and over-issuance controls are issuer-asserted rather than on-chain provable.",
    "Secondary-market depth: pmUSD trades in a thin set of Curve pools, so once the PSM is paused or depleted, modest flow can move the price far from par.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/cdp/", label: "Mechanism: CDP stablecoins" },
    { href: "/stablecoin/pmusd-precious-metals/", label: "pmUSD overview" },
    { href: "/learn/case-studies/usd0pp-usual-2025/", label: "Case study: USD0++ and redemption-terms risk" },
    { href: "/methodology/", label: "Pharos methodology" },
  ],
  sources: [
    {
      label: "RAAC: Technical documentation (RWf(x), PSM, vaults)",
      href: "https://docs.raac.io/",
    },
    {
      label: "pmUSD: Project site",
      href: "https://pmusd.raac.io/",
    },
    {
      label: "PR Newswire: RAAC adds $200M of gold to DeFi with listed tokenizer I-ON (Oct 2, 2025)",
      href: "https://www.prnewswire.com/news-releases/raac-adds-200m-of-gold-to-defi-with-listed-tokenizer-i-on-302573746.html",
    },
    {
      label: "I-ON Digital: ION.au collateral framework for pmUSD",
      href: "https://iondigitalcorp.com/ionau-collateral-framework-for-pmusd-ionau/",
    },
    {
      label: "Chainlink: ION Proof of Reserve feed (Ethereum mainnet)",
      href: "https://data.chain.link/feeds/ethereum/mainnet/ion-por",
    },
    {
      label: "CoinGecko: Precious Metals USD (PMUSD) price and all-time low",
      href: "https://www.coingecko.com/en/coins/precious-metals-usd",
    },
    {
      label: "CryptoRank: Precious Metals USD price statistics",
      href: "https://cryptorank.io/price/precious-metals-usd",
    },
  ],
  metaDescription:
    "pmUSD, RAAC's gold-RWA dollar token, logged chronic sub-peg events and an ~88% crash to a May 4, 2026 all-time low, but remains live.",
  datePublished: "2026-05-23",
};

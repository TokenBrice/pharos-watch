import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "eurt-mica-exit-2024",
  eyebrow: "Regulatory exit",
  title: "Euro Tether: the stablecoin that died by jurisdiction",
  subtitle:
    "EURT never broke its euro peg. In November 2024 Tether simply withdrew it rather than pursue MiCA authorization — the first wave of EU rules retired a non-dollar stablecoin instead of cracking it.",
  lead: [
    "Euro Tether tracked the euro, not the dollar. EURT was a fiat-backed token meant to redeem one-for-one against a euro reserve, and for most of its life it did exactly that — its deviation, where it mattered, was measured against one EUR, not one USD. The coin reached low-hundreds-of-millions circulation on Pharos and secondary summaries put its peak above $500M, but it had been shrinking for years: Tether stopped accepting new issuance requests after 2022, and by late 2024 only about $27M remained outstanding against larger euro rivals.",
    "What ended EURT was not a run, a reserve gap, or a liquidity crisis. It was a jurisdiction. The EU's Markets in Crypto-Assets regulation (MiCA) brought its rules for e-money tokens into application on 30 June 2024, and under those rules a euro-pegged stablecoin can only be issued by an EU-authorized credit or electronic-money institution. Tether held no such authorization for EURT and chose not to seek one. On 27 November 2024 it announced it would discontinue support for EUR₮ on every chain, stop minting, and give holders a one-year window to redeem.",
    "This is a different shape of death from the depeg cases in this archive. The peg held to the end; the coin was simply withdrawn from the market. EURT is the cleanest example of a structurally sound stablecoin retired by regulation rather than by price — and a reminder that for a non-dollar peg, the terminal risk is often which regulator claims the currency, not whether the reserve is real. The MiCA-compliant euro lane it vacated passed to Circle's EURC and Monerium's EURe.",
  ],
  takeaways: [
    "EURT is a euro-pegged stablecoin — its peg is one EUR, and that peg never broke. It died by discontinuation, not by a price crash.",
    "MiCA's e-money-token rules (in force 30 June 2024) require an EU credit/e-money-institution license to issue a euro stablecoin; Tether declined to seek one and withdrew EURT instead.",
    "Tether announced the wind-down on 27 November 2024 with a one-year redemption window; new issuance had already stopped after 2022 and only ~$27M was left outstanding.",
    "For non-dollar pegs, jurisdiction is a terminal risk independent of solvency — the compliant euro lane passed to EURC (Circle) and EURe (Monerium).",
  ],
  relatedCoins: [
    {
      coinId: "eurc-circle",
      note: "Circle's euro stablecoin, issued by Circle Mint Europe SAS as a MiCA e-money token under an electronic-money-institution authorization from France's ACPR. Circle announced MiCA compliance on 1 July 2024 — a day after the EMT rules applied — positioning EURC to absorb the euro float EURT vacated.",
    },
    {
      coinId: "eure-monerium",
      note: "Monerium's regulated euro e-money token. Monerium was authorized as a blockchain e-money issuer in 2019 and launched EURe in 2022, operating under EU e-money law and MiCA as a licensed EMI — the kind of authorization EURT never carried.",
    },
  ],
  archetype: "fiat-cash",
  outcome: "died",
  eventDateLabel: "November 2024",
  eventWindow: {
    startISO: "2024-06-30",
    endISO: "2024-11-27",
  },
  cemeteryId: "eurt-euro-tether-2024-11",
  timeline: [
    {
      dateISO: "2022-07-01",
      headline: "EURT circulates as the leading euro stablecoin",
      body: "Tether's euro token had been live since 2016 and, after a 2021 expansion onto additional chains, led the small euro-stablecoin segment through 2022. Pharos records low-hundreds-of-millions circulation and secondary market summaries put the peak above $500M. It was a conventional fiat-backed design: redeem one EURT for one euro from reserves.",
      severity: "low",
    },
    {
      dateISO: "2022-12-31",
      headline: "New issuance quietly stops",
      body: "Tether stopped processing new EURT acquisition requests; the last issuance was handled in 2022. Circulation began a long, undramatic decline as redemptions ran ahead of any new demand, leaving the token shrinking well before regulation forced the question.",
      severity: "low",
    },
    {
      dateISO: "2024-06-30",
      headline: "MiCA's e-money-token rules apply across the EU",
      body: "Titles III and IV of MiCA — the regimes for asset-referenced tokens and e-money tokens — became applicable on 30 June 2024 with no transitional grace for issuers. A euro-pegged EMT may now only be offered in the EU by an authorized credit or electronic-money institution that has filed a white paper with its supervisor.",
      severity: "med",
      href: "https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica",
    },
    {
      dateISO: "2024-07-01",
      headline: "A compliant successor steps into the lane",
      body: "The day after the EMT rules applied, Circle announced it had become the first global stablecoin issuer to achieve MiCA compliance, issuing EURC (and USDC) through an electronic-money-institution authorization in France. The regulated euro lane EURT had not entered now had an occupant.",
      severity: "low",
      href: "https://www.circle.com/pressroom/circle-is-first-global-stablecoin-issuer-to-comply-with-mica-eus-landmark-crypto-law",
    },
    {
      dateISO: "2024-11-27",
      headline: "Tether discontinues EUR₮",
      body: "Tether announced it would discontinue support for EUR₮ on all blockchains and cease minting, stating: \"After careful consideration, we have made the decision to discontinue support for EUR₮.\" Holders were given a one-year window to redeem. Roughly $27M remained outstanding at the time; the peg was intact throughout.",
      severity: "high",
      href: "https://www.coindesk.com/business/2024/11/27/tether-to-shutter-euro-stablecoin-as-key-mi-ca-deadline-looms",
    },
    {
      dateISO: "2024-12-30",
      headline: "MiCA's service-provider rules complete the regime",
      body: "The rules for crypto-asset service providers (Title V) applied from 30 December 2024, requiring exchanges and custodians to be MiCA-authorized to passport across the EU. Several venues had already delisted EURT ahead of the deadline, accelerating its drift out of European order books.",
      severity: "med",
    },
    {
      dateISO: "2025-11-25",
      headline: "Redemptions close",
      body: "About one year after the announcement, Tether ended EURT redemptions, completing the wind-down. The token was retired without ever losing its euro peg — a discontinuation, not a collapse.",
      severity: "low",
    },
  ],
  sections: [
    {
      heading: "What happened",
      paragraphs: [
        "EURT was Tether's euro-denominated stablecoin, structurally a sibling of USDT: a fiat-backed token redeemable one-for-one against a reserve, with its peg referenced to one euro rather than one dollar. It launched in 2016, expanded across more chains in 2021, and at its high point carried circulation in the low hundreds of millions on Pharos, with secondary market summaries placing the broader peak above $500M — modest by USDT standards but enough to lead the thin euro-stablecoin segment for a stretch.",
        "By the time regulation forced a decision, EURT was already a legacy product. Tether had stopped accepting new issuance requests after 2022, so the float only ever shrank from there, falling to roughly $27M outstanding by late 2024 — well behind Circle's EURC and other euro rivals. The coin was not in distress; it was simply small and getting smaller.",
        "On 27 November 2024 Tether announced it would discontinue support for EUR₮ on every supported chain, stop minting, and let holders redeem over the following year. Crucially, the euro peg held the entire time. There was no deviation event to record, no reserve shortfall, no run. EURT left the market the way a discontinued product line does — by being withdrawn — and its redemptions closed about a year later.",
      ],
    },
    {
      heading: "MiCA's e-money-token regime and what authorization requires",
      paragraphs: [
        "The EU's Markets in Crypto-Assets regulation (Regulation (EU) 2023/1114) entered into force in 2023 but phased in its substance. The provisions governing stablecoins — Title III for asset-referenced tokens and Title IV for e-money tokens — became applicable on 30 June 2024, ahead of the broader service-provider rules that followed on 30 December 2024.",
        "A euro stablecoin is, in MiCA's taxonomy, an e-money token: a crypto-asset that references a single official currency. The regime is deliberately narrow about who may issue one. Only an authorized credit institution or electronic-money institution established in the EU may offer an EMT to the public, and it must publish a crypto-asset white paper to its competent authority. There is no light-touch path and no transitional carve-out for an existing token that does not meet the bar.",
        "Those obligations are not cosmetic. Issuers must hold fully backed, segregated reserves with a substantial share kept as deposits in EU credit institutions, honor redemption at par, and submit to ongoing supervision — for euro EMTs, ultimately the EBA's orbit. For an issuer unwilling to restructure its reserve and custody arrangements to fit, the rational move on a small, declining token is not to comply but to exit. That is the choice Tether made.",
      ],
    },
    {
      heading: "Retirement, not a depeg",
      paragraphs: [
        "It is worth being precise about how EURT died, because it is unlike every price-driven case in this archive. The token did not trade away from one euro and fail to recover. Its reserve was not impaired, its redemption was not gated by a banking shock, and no reflexive mechanism unwound. The peg was healthy at the moment the coin was discontinued.",
        "What changed was the legal right to offer the token in its home market. Once MiCA's EMT rules applied, continuing to circulate an unauthorized euro stablecoin across EU venues became untenable, and exchanges began delisting EURT to protect their own compliance ahead of the December 2024 service-provider deadline. The token's market access eroded by rule, not by sentiment. Tether's withdrawal formalized an outcome the regulation had already set in motion.",
        "This is why Pharos files EURT under a regulatory cause of death rather than a depeg event. For monitoring purposes, the lesson is that a clean price chart can mask a terminal condition: a stablecoin can be fully solvent and on-peg and still be days from being pulled, if its issuer has no authorization in the jurisdiction that governs its peg currency.",
      ],
    },
    {
      heading: "The compliant successors",
      paragraphs: [
        "The euro float EURT gave up did not vanish — it migrated to issuers that did the regulatory work. Circle announced MiCA compliance on 1 July 2024, one day after the EMT rules applied, issuing EURC as an e-money token through Circle Mint Europe SAS under an electronic-money-institution authorization from France's ACPR. EURC went on to become the largest MiCA-compliant euro stablecoin, capturing much of the segment as non-compliant tokens left.",
        "Monerium occupied the same lane from a different angle. It had been authorized as a blockchain-based e-money issuer since 2019 and launched EURe in 2022, operating under EU e-money law and MiCA as a licensed EMI supervised in the EEA. Where EURT carried no EU authorization, EURe was built inside the regime from the start, with deep SEPA banking integration as its distinguishing feature.",
        "Tether itself did not abandon Europe so much as outsource compliance: it backed Quantoz Payments' MiCA-compliant EURQ and USDQ, built on Tether's Hadron technology, letting a separately licensed entity carry the regulatory responsibility. The pattern across all three successors is the same — the path back into the EU euro market runs through an EU credit or e-money license, which is exactly what EURT lacked.",
      ],
    },
    {
      heading: "Lessons",
      paragraphs: [
        "Jurisdiction is a terminal risk for a non-dollar peg, independent of solvency. A euro, sterling, or other non-USD stablecoin lives or dies by whether its issuer is authorized in the jurisdiction that owns the currency. EURT was fully backed and on-peg and still could not survive its home market once MiCA defined who may issue a euro token. Reserve quality answers a different question from market access.",
        "Death by discontinuation looks nothing like death by depeg, and monitoring has to account for both. There is no deviation spike to catch, no run to model — only an issuer decision triggered by a rule change. Watching reserves and price would have told you EURT was healthy right up to the announcement. The signal that mattered was regulatory: an unauthorized issuer in a newly regulated jurisdiction.",
        "Regulation reallocates a market more than it shrinks one. MiCA did not destroy euro-stablecoin demand; it transferred it from issuers that would not comply to those that did. The durable read on a regulatory exit is not the size of the coin that left but the credibility of the licensed successors that inherited its lane — here, EURC and EURe.",
      ],
    },
  ],
  watchpoints: [
    "Non-USD stablecoins whose issuer holds no authorization in the jurisdiction that governs the peg currency — a fully-backed, on-peg coin can still be withdrawn by rule.",
    "Issuer signals of disengagement before a regulatory deadline: minting halted, no new issuance for years, and a steadily shrinking float well ahead of any formal wind-down.",
    "Exchange delistings driven by the issuer's own compliance posture (e.g. ahead of MiCA's service-provider deadline), which erode market access independently of the token's price.",
    "A clean peg masking a terminal condition: monitor authorization status and jurisdiction, not only reserve quality and deviation, for coins exposed to a binding new regime.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/fiat-cash/", label: "Mechanism: fiat-cash stablecoins" },
    { href: "/compliance/", label: "MiCA compliance tracker" },
    { href: "/cemetery/", label: "Stablecoin cemetery" },
    { href: "/stablecoin/eurc-circle/", label: "EURC — Circle's MiCA-compliant euro stablecoin" },
    { href: "/stablecoin/eure-monerium/", label: "EURe — Monerium's regulated euro e-money token" },
  ],
  sources: [
    {
      label: "CoinDesk — Tether to Shutter Euro Stablecoin (EURT) as Key MiCA Deadline Looms",
      href: "https://www.coindesk.com/business/2024/11/27/tether-to-shutter-euro-stablecoin-as-key-mi-ca-deadline-looms",
    },
    {
      label: "CoinMarketCap Academy — Tether to phase out EURT amid regulatory challenges",
      href: "https://coinmarketcap.com/academy/article/tether-to-phase-out-euro-backed-stablecoin-eurt-amid-regulatory-challenges",
    },
    {
      label: "ESMA — Markets in Crypto-Assets Regulation (MiCA)",
      href: "https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica",
    },
    {
      label: "EUR-Lex — Regulation (EU) 2023/1114 (MiCA), full text",
      href: "https://eur-lex.europa.eu/eli/reg/2023/1114/oj/eng",
    },
    {
      label: "Circle — First global stablecoin issuer to comply with MiCA (EURC/USDC)",
      href: "https://www.circle.com/pressroom/circle-is-first-global-stablecoin-issuer-to-comply-with-mica-eus-landmark-crypto-law",
    },
    {
      label: "Monerium — MiCA explained: choosing a compliant euro stablecoin (EURe)",
      href: "https://monerium.com/blog/2025/mica-explained-how-to-choose-a-compliant-euro-stablecoin-in-europe/",
    },
  ],
  metaDescription:
    "Euro Tether (EURT) never broke its euro peg. Tether discontinued it in Nov 2024 rather than seek MiCA authorization — a stablecoin that died by jurisdiction.",
  datePublished: "2026-06-15",
};

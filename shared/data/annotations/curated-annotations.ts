import type { ChartAnnotation } from "@shared/types/chart-annotation";

/**
 * Editorially curated chart annotations for historical events that are NOT
 * automatically surfaced by the tape (regulatory bans, market-wide shocks,
 * coin launches, methodology pivots, etc.).
 *
 * Keyed by stablecoin id — must match the filename in
 * `shared/data/stablecoins/coins/<id>.json`.
 *
 * Curation rules (USDC and USDT below are the reference examples):
 *
 *   1. **One pin per incident.** Bundle the cluster (regulator action → depeg
 *      → backstop) into a single annotation placed at the price/supply-impact
 *      moment. The chart shape already conveys the recovery; redundant pins
 *      crowd the legend without adding information.
 *
 *   2. **Plot causes that moved the line, or that materially changed the
 *      issuer.** A press cycle is not an event. A regulatory action only earns
 *      a pin if it (a) coincides with a visible chart move, or (b) imposed an
 *      ongoing constraint on the issuer (forced attestations, EMI license,
 *      reserve composition rules).
 *
 *   3. **Drop indictments, keep settlements.** The settlement is the moment
 *      that changed behavior. Announcement of charges is usually press-cycle
 *      noise unless it caused a price move.
 *
 *   4. **Prefer distinct `kind`s within a coin's list.** Same-kind clusters
 *      defeat the color-coded legend; mixed `depeg` / `regulatory` / `governance`
 *      pins are immediately decodable.
 *
 *   5. **Aim for 0–5 pins per coin.** Coins with no notable events should
 *      remain absent (`getCuratedAnnotations` returns `[]`).
 *
 *   6. **Use the price-bottom / supply-pivot timestamp.** Not the press cycle,
 *      not the post-mortem publication date.
 *
 *   7. **Severity vocabulary matches the tape**: `high` for grade-impacting,
 *      `med` for non-fatal stress, `low` for context. Most pins will be `high`
 *      or `med` — `low` is rare.
 *
 *   8. **Labels ≤80 chars** (SR-only legend reads them verbatim) and should
 *      lead with the cause, not the consequence. "SVB exposure — USDC depeg
 *      low ~$0.87" beats "USDC depegs to $0.87".
 *
 *   9. **`href` should resolve to a primary source** (issuer post-mortem,
 *      regulator filing, methodology changelog) — not secondary press.
 */
// Shared macro-regulatory event referenced by multiple BRL stablecoins.
const BCB_RES_519: ChartAnnotation = {
  ts: Date.UTC(2025, 10, 1),
  kind: "regulatory",
  label: "BCB Res. 519/520/521 — BRL stablecoins enter FX/VASP regime",
  severity: "med",
};

export const CURATED_ANNOTATIONS: Record<string, readonly ChartAnnotation[]> = {
  "usdc-circle": [
    {
      ts: Date.UTC(2020, 2, 12), // 2020-03-12 — Black Thursday crypto-wide crash; USDC briefly to ~$0.97
      kind: "depeg",
      label: "Black Thursday market shock — USDC dip ~$0.97",
      severity: "med",
    },
    {
      // 2023-03-11 — Single pin for the SVB cluster (closure 03-10 → depeg low
      // 03-11 → federal backstop 03-13). The chart already shows the recovery.
      ts: Date.UTC(2023, 2, 11),
      kind: "depeg",
      label: "SVB reserve exposure — USDC depeg low ~$0.87",
      severity: "high",
      href: "https://www.circle.com/blog/an-update-on-usdc-and-silicon-valley-bank",
    },
    {
      // 2024-06-30 — MiCA stablecoin (ART/EMT) provisions take effect; Circle
      // became the first global issuer with an EU EMI license a day later.
      // Marks the start of regulated EU issuance for USDC.
      ts: Date.UTC(2024, 5, 30),
      kind: "regulatory",
      label: "MiCA stablecoin regime in force — Circle EMI-authorized in EU",
      severity: "med",
    },
  ],
  "usdt-tether": [
    {
      ts: Date.UTC(2018, 9, 15), // 2018-10-15 — Bitfinex/Noble Bank banking stress; USDT to ~$0.85
      kind: "depeg",
      label: "Bitfinex banking stress — USDT depeg low ~$0.85",
      severity: "high",
    },
    {
      // 2021-02-23 — NY AG settlement (resolution of the 2019 iFinex order).
      // Imposed quarterly reserve attestations on Tether — first ongoing
      // reserve-disclosure mandate on the issuer.
      ts: Date.UTC(2021, 1, 23),
      kind: "regulatory",
      label: "NY AG settlement — forced reserve disclosures ($18.5M)",
      severity: "med",
    },
    {
      // 2021-10-15 — CFTC order over reserve misrepresentations 2016–2018.
      // $41M penalty plus ongoing reporting requirements.
      ts: Date.UTC(2021, 9, 15),
      kind: "regulatory",
      label: "CFTC order — reserve misrepresentation ($41M penalty)",
      severity: "med",
      href: "https://www.cftc.gov/PressRoom/PressReleases/8450-21",
    },
    {
      // 2022-05-12 — UST/LUNA collapse contagion; USDT briefly traded ~$0.95
      // on Kraken as redemptions spiked. Largest USDT depeg since 2018.
      ts: Date.UTC(2022, 4, 12),
      kind: "depeg",
      label: "Terra/UST collapse contagion — USDT depeg ~$0.95",
      severity: "high",
    },
  ],
  "dai-makerdao": [
    {
      ts: Date.UTC(2020, 2, 12), // 2020-03-12 — Black Thursday: ETH crash, $0-bid collateral auctions, system shortfall
      kind: "governance",
      label: "Black Thursday — collateral auctions fail, MKR backstop",
      severity: "high",
    },
    {
      ts: Date.UTC(2023, 2, 11), // 2023-03-11 — Dai depegs alongside USDC due to PSM collateral exposure
      kind: "depeg",
      label: "USDC contagion via PSM — Dai depeg low",
      severity: "high",
    },
  ],
  "usde-ethena": [
    {
      ts: Date.UTC(2024, 1, 19), // 2024-02-19 — USDe public mainnet launch
      kind: "governance",
      label: "USDe public mainnet launch",
      severity: "med",
    },
    {
      // 2025-10-10 — Binance perp oracle glitch during broader crypto crash;
      // USDe printed ~$0.65 on Binance spot before recovering. Largest USDe
      // peg stress to date.
      ts: Date.UTC(2025, 9, 10),
      kind: "depeg",
      label: "Binance oracle glitch flash crash — USDe printed ~$0.65",
      severity: "high",
    },
  ],
  "usds-sky": [
    {
      ts: Date.UTC(2024, 7, 27), // 2024-08-27 — MakerDAO announces Sky rebrand and USDS launch schedule
      kind: "governance",
      label: "MakerDAO rebrands to Sky; USDS launch announced",
      severity: "med",
      href: "https://www.coindesk.com/business/2024/08/27/makerdao-is-now-sky-as-7b-crypto-lender-rolls-out-new-stablecoin-governance-token",
    },
    {
      ts: Date.UTC(2024, 8, 18), // 2024-09-18 — USDS and SKY tokens go live; DAI upgradable 1:1 to USDS
      kind: "governance",
      label: "USDS mainnet launch — DAI upgradable 1:1",
      severity: "high",
      href: "https://sky.money/",
    },
  ],
  "usd1-world-liberty-financial": [
    {
      ts: Date.UTC(2025, 2, 25), // 2025-03-25 — WLFI announces USD1 stablecoin with BitGo custody
      kind: "governance",
      label: "USD1 announced — Trump-linked WLFI, BitGo custodian",
      severity: "med",
      href: "https://www.businesswire.com/news/home/20250325773694/en/World-Liberty-Financial-Plans-to-Launch-USD1-the-Institutional-Ready-Stablecoin",
    },
  ],
  "pyusd-paypal": [
    {
      ts: Date.UTC(2023, 7, 7), // 2023-08-07 — PayPal launches PYUSD via Paxos on Ethereum
      kind: "governance",
      label: "PYUSD launch — first major US fintech stablecoin",
      severity: "med",
      href: "https://newsroom.paypal-corp.com/2023-08-07-PayPal-Launches-U-S-Dollar-Stablecoin",
    },
    {
      ts: Date.UTC(2023, 10, 1), // 2023-11-01 — SEC Division of Enforcement subpoenas PayPal over PYUSD
      kind: "regulatory",
      label: "SEC Enforcement subpoenas PayPal over PYUSD",
      severity: "med",
      href: "https://www.theblock.co/post/260641/paypal-sec-subpoena-pyusd-stablecoin",
    },
    {
      ts: Date.UTC(2024, 4, 29), // 2024-05-29 — PYUSD expands to Solana; supply ramps 3x in three months
      kind: "governance",
      label: "PYUSD launches on Solana — supply ramps 3x",
      severity: "low",
      href: "https://newsroom.paypal-corp.com/2024-05-29-PayPal-USD-Stablecoin-Now-Available-on-Solana-Blockchain,-Providing-Faster,-Cheaper-Transactions-for-Consumers",
    },
    {
      ts: Date.UTC(2025, 1, 1), // 2025-02 — SEC closes PYUSD inquiry without enforcement action
      kind: "regulatory",
      label: "SEC closes PYUSD probe — no enforcement",
      severity: "low",
      href: "https://www.coindesk.com/business/2025/05/01/sec-ditches-paypal-usd-probe-helping-its-stablecoin-offering-grow-further",
    },
  ],
  "buidl-blackrock": [
    {
      ts: Date.UTC(2024, 2, 20), // 2024-03-20 — BlackRock USD Institutional Digital Liquidity Fund (BUIDL) launches on Ethereum via Securitize
      kind: "governance",
      label: "BUIDL launch — BlackRock's first tokenized fund onchain",
      severity: "high",
      href: "https://www.prnewswire.com/news-releases/blackrock-usd-institutional-digital-liquidity-fund-buidl-tokenized-by-securitize-surpasses-1b-in-aum-302401480.html",
    },
    {
      ts: Date.UTC(2025, 2, 13), // 2025-03-13 — BUIDL crosses $1B AUM, becomes largest tokenized treasury fund
      kind: "governance",
      label: "BUIDL crosses $1B AUM — largest tokenized T-bill fund",
      severity: "low",
    },
  ],
  "usyc-hashnote": [
    {
      ts: Date.UTC(2025, 0, 21), // 2025-01-21 — Circle acquires Hashnote/USYC at Davos; plans USDC-USYC convertibility
      kind: "governance",
      label: "Circle acquires Hashnote (USYC issuer)",
      severity: "high",
      href: "https://www.circle.com/pressroom/circle-announces-acquisition-of-hashnote-and-usyc-tokenized-money-market-fund-alongside-strategic-partnership-with-global-trading-firm-drw",
    },
  ],
  "usdg-paxos": [
    {
      ts: Date.UTC(2024, 10, 1), // 2024-11-01 — Paxos Singapore launches USDG under MAS framework
      kind: "governance",
      label: "USDG launch — Paxos Singapore under MAS framework",
      severity: "med",
      href: "https://www.paxos.com/newsroom/paxos-introduces-global-dollar-usdg",
    },
    {
      ts: Date.UTC(2024, 10, 4), // 2024-11-04 — Global Dollar Network unveiled with Robinhood, Kraken, Galaxy, et al.
      kind: "governance",
      label: "Global Dollar Network launched — yield-sharing model",
      severity: "low",
      href: "https://globaldollar.com/",
    },
    {
      ts: Date.UTC(2025, 6, 1), // 2025-07-01 — USDG launches in EU under MiCA via Finnish FIN-FSA
      kind: "regulatory",
      label: "USDG EU launch under MiCA (FIN-FSA)",
      severity: "low",
      href: "https://www.paxos.com/newsroom/global-dollar-(usdg)-launches-in-the-eu",
    },
  ],
  "usdy-ondo-finance": [
    {
      ts: Date.UTC(2023, 7, 3), // 2023-08-03 — Ondo launches USDY for non-US investors; senior secured note structure
      kind: "governance",
      label: "USDY launch — Ondo tokenized T-bill note (non-US)",
      severity: "med",
      href: "https://ondo.finance/blog/introducing-ondo-usd-yield-usdy",
    },
    {
      ts: Date.UTC(2025, 2, 3), // 2025-03-03 — USDY crosses $1B TVL
      kind: "governance",
      label: "USDY crosses $1B TVL",
      severity: "low",
    },
  ],
  "usdf-falcon": [
    {
      ts: Date.UTC(2025, 3, 1), // 2025-04 — Falcon Finance / DWF Labs publicly launches USDf synthetic dollar
      kind: "governance",
      label: "USDf launch — DWF Labs synthetic dollar",
      severity: "med",
    },
    {
      ts: Date.UTC(2025, 6, 8), // 2025-07-08 — USDf depegs to ~$0.887 amid collateral / yield-sustainability concerns
      kind: "depeg",
      label: "USDf depeg low ~$0.89 — collateral concerns",
      severity: "high",
      href: "https://thedefiant.io/news/tokens/dwf-labs-usdf-stablecoin-briefly-depegs-amid-doubts-over-collateral-and-yield",
    },
    {
      ts: Date.UTC(2025, 9, 1), // 2025-10-01 — First independent audit confirms 103.87% backing
      kind: "governance",
      label: "First independent audit — 103.87% backing confirmed",
      severity: "low",
    },
  ],
  "rlusd-ripple": [
    {
      ts: Date.UTC(2024, 11, 10), // 2024-12-10 — NYDFS approves Ripple to issue RLUSD under trust charter
      kind: "regulatory",
      label: "NYDFS approves RLUSD under trust charter",
      severity: "med",
      href: "https://www.finextra.com/newsarticle/45210/ripple-wins-nydfs-approval-for-stablecoin-launch",
    },
    {
      ts: Date.UTC(2024, 11, 17), // 2024-12-17 — RLUSD goes live on XRP Ledger and Ethereum
      kind: "governance",
      label: "RLUSD launch on XRP Ledger and Ethereum",
      severity: "med",
      href: "https://www.businesswire.com/news/home/20241216911945/en/Raising-the-Standard-for-Stablecoins-Ripple-USD-Launches-Globally-with-Unmatched-Utility-Experience-and-Compliance",
    },
  ],
  "usdd-tron-dao-reserve": [
    {
      ts: Date.UTC(2022, 4, 5), // 2022-05-05 — USDD launches three weeks after Terra/UST collapse; 40% staking APY
      kind: "governance",
      label: "USDD launch — algorithmic design post-UST collapse",
      severity: "med",
    },
    {
      ts: Date.UTC(2022, 10, 9), // 2022-11-09 — Alameda-linked sell pressure pushes USDD to ~$0.96 during FTX collapse
      kind: "depeg",
      label: "FTX/Alameda contagion — USDD depeg low ~$0.96",
      severity: "high",
    },
    {
      ts: Date.UTC(2024, 7, 1), // 2024-08 — Tron DAO Reserve removes ~$750M BTC backing; reserves shift to TRX-heavy
      kind: "governance",
      label: "TDR removes ~$750M BTC backing — TRX-heavy mix",
      severity: "high",
    },
    {
      ts: Date.UTC(2025, 0, 16), // 2025-01-16 — USDD 2.0 announced: overcollateralized CDP model, 20% staking yield
      kind: "governance",
      label: "USDD 2.0 — pivots from algorithmic to CDP backing",
      severity: "high",
    },
  ],
  "usdtb-ethena": [
    {
      ts: Date.UTC(2024, 11, 16), // 2024-12-16 — Ethena launches USDtb with 90% BUIDL backing as USDe safe-haven asset
      kind: "governance",
      label: "USDtb launch — 90% BUIDL-backed, USDe backstop",
      severity: "med",
      href: "https://www.theblock.co/post/331013/ethenas-much-anticipated-usdtb-stablecoin-backed-by-blackrocks-buidl-token-goes-live",
    },
  ],
  "u-united-stables": [
    {
      ts: Date.UTC(2025, 11, 18), // 2025-12-18 — United Stables launches $U on BNB Chain and Ethereum; multi-stablecoin reserves
      kind: "governance",
      label: "U launch — multi-stablecoin reserve wrapper on BNB",
      severity: "med",
      href: "https://www.bnbchain.org/en/blog/united-stables-launches-u-as-a-native-stablecoin-on-bnb-chain",
    },
  ],
  "gho-aave": [
    {
      ts: Date.UTC(2023, 6, 15), // 2023-07-15 — GHO launches on Ethereum mainnet after near-unanimous DAO vote
      kind: "governance",
      label: "GHO launch — Aave overcollateralized stablecoin",
      severity: "med",
      href: "https://cointelegraph.com/news/aave-protocol-launch-stablecoin-gho-ethereum-mainnet",
    },
    {
      ts: Date.UTC(2023, 6, 31), // 2023-07-31 — GHO drops to $0.96 during Curve reentrancy exploit window
      kind: "depeg",
      label: "Curve reentrancy contagion — GHO depeg low ~$0.96",
      severity: "high",
      href: "https://beincrypto.com/aave-stablecoin-gho-recovers-depeg-curve-hack/",
    },
    {
      ts: Date.UTC(2023, 9, 1), // 2023-10 — GHO Liquidity Committee (GLC) formed to manage peg
      kind: "governance",
      label: "GHO Liquidity Committee formed to manage peg",
      severity: "low",
    },
    {
      ts: Date.UTC(2024, 3, 1), // 2024-04 — GHO Stewards entity created for flexible parameter management
      kind: "governance",
      label: "GHO Stewards — flexible parameter governance",
      severity: "low",
    },
  ],
  "a7a5-old-vector": [
    {
      ts: Date.UTC(2025, 4, 1), // 2025-05 — UK sanctions A7A5 network
      kind: "regulatory",
      label: "UK sanctions A7A5 issuer network",
      severity: "high",
    },
    {
      ts: Date.UTC(2025, 6, 1), // 2025-07 — EU sanctions A7A5
      kind: "regulatory",
      label: "EU sanctions A7A5 — direct token-level restriction",
      severity: "high",
    },
    {
      ts: Date.UTC(2025, 7, 14), // 2025-08-14 — OFAC designates A7 LLC and Old Vector for sanctions-evasion infrastructure
      kind: "regulatory",
      label: "OFAC sanctions A7A5 issuer Old Vector",
      severity: "high",
      href: "https://home.treasury.gov/news/press-releases",
    },
  ],
  "usd0-usual": [
    {
      ts: Date.UTC(2024, 6, 10), // 2024-07-10 — USD0 enters public phase; USD0++ liquid-staked variant goes live
      kind: "governance",
      label: "USD0 / USD0++ public launch",
      severity: "med",
    },
    {
      ts: Date.UTC(2025, 0, 10), // 2025-01-10 — Usual unilaterally introduces $0.87 floor exit for USD0++
      kind: "governance",
      label: "Usual sets $0.87 floor exit for USD0++",
      severity: "high",
      href: "https://blockworks.co/news/usual-depeg-spurs-defi-instability",
    },
    {
      ts: Date.UTC(2025, 0, 13), // 2025-01-13 — USD0++ tumbles to ~$0.89; Morpho cascade liquidations; revenue switch activated
      kind: "depeg",
      label: "USD0++ depeg low ~$0.89 — Morpho cascade",
      severity: "high",
    },
  ],
  "ylds-figure": [
    {
      ts: Date.UTC(2025, 1, 20), // 2025-02-20 — Figure Markets launches YLDS, first SEC-registered yield-bearing stablecoin
      kind: "regulatory",
      label: "YLDS launch — first SEC-registered yield stablecoin",
      severity: "high",
      href: "https://www.figuremarkets.com/resources/figure-markets-announces-ylds-first-yield-bearing-stablecoin/",
    },
  ],
  "tusd-trueusd": [
    {
      ts: Date.UTC(2018, 2, 5), // 2018-03-05 — TrustToken launches TUSD on Ethereum, listed on Bittrex
      kind: "governance",
      label: "TUSD launch on Ethereum",
      severity: "low",
    },
    {
      ts: Date.UTC(2020, 11, 18), // 2020-12-18 — TrueCoin sells TUSD operations to Techteryx (BVI consortium)
      kind: "governance",
      label: "TUSD ownership transferred from TrueCoin to Techteryx",
      severity: "med",
    },
    {
      ts: Date.UTC(2023, 5, 10), // 2023-06-10 — Prime Trust mint pause; TUSD briefly depegs to ~$0.993
      kind: "regulatory",
      label: "Prime Trust mint pause — TUSD attestation ripcord triggered",
      severity: "med",
    },
    {
      ts: Date.UTC(2023, 6, 13), // 2023-07-13 — Techteryx takes full operational control from Archblock
      kind: "governance",
      label: "Techteryx assumes full operational control of TUSD",
      severity: "low",
    },
    {
      ts: Date.UTC(2024, 8, 24), // 2024-09-24 — SEC settles charges vs. TrueCoin/TrustToken for misleading TUSD backing
      kind: "regulatory",
      label: "SEC settlement vs. TrueCoin/TrustToken over TUSD reserves",
      severity: "high",
      href: "https://www.sec.gov/newsroom/press-releases/2024-145",
    },
  ],
  "eurc-circle": [
    {
      ts: Date.UTC(2022, 5, 30), // 2022-06-30 — Circle launches EURC (then EUROC) on Ethereum
      kind: "governance",
      label: "EURC launch on Ethereum",
      severity: "low",
    },
    {
      ts: Date.UTC(2024, 6, 1), // 2024-07-01 — Circle France obtains ACPR EMI license; EURC becomes MiCA-compliant
      kind: "regulatory",
      label: "Circle France EMI license — EURC MiCA-compliant",
      severity: "med",
      href: "https://www.circle.com/pressroom/circle-is-first-global-stablecoin-issuer-to-comply-with-mica-eus-landmark-crypto-law",
    },
  ],
  "usdgo-osl": [
    {
      ts: Date.UTC(2026, 1, 10), // 2026-02-10 — OSL/Anchorage launch USDGO on Solana with $50M initial mint
      kind: "governance",
      label: "USDGO launch on Solana — Anchorage issuance under OCC oversight",
      severity: "low",
      href: "https://www.osl.com/hk-en/press-release/osl-group-officially-launches-regulated-enterprise-stablecoin-usdgo",
    },
  ],
  "fdusd-first-digital": [
    {
      ts: Date.UTC(2023, 5, 1), // 2023-06-01 — FDUSD launched by FD121 Limited (BVI); FDT custodian
      kind: "governance",
      label: "FDUSD launch by First Digital Labs",
      severity: "low",
    },
    {
      ts: Date.UTC(2023, 6, 26), // 2023-07-26 — Binance lists FDUSD with zero-fee promo as BUSD winds down
      kind: "governance",
      label: "Binance lists FDUSD with zero-fee promo (BUSD replacement)",
      severity: "low",
    },
    {
      ts: Date.UTC(2025, 3, 2), // 2025-04-02 — Justin Sun alleges FDT insolvency; FDUSD depegs to ~$0.87
      kind: "depeg",
      label: "Sun insolvency claim vs. FDT — FDUSD depeg low ~$0.87",
      severity: "high",
      href: "https://www.theblock.co/post/349289/tron-justin-sun-trueusd-fiduciary-insolvent-techteryx-tusd-first-digital-aria",
    },
    {
      ts: Date.UTC(2025, 7, 1), // 2025-08-01 — Hong Kong Stablecoins Ordinance in force; FDUSD enters licensing regime
      kind: "regulatory",
      label: "HK Stablecoins Ordinance in force — FDUSD enters licensing regime",
      severity: "med",
      href: "https://www.hkma.gov.hk/eng/key-functions/international-financial-centre/stablecoin-issuers/",
    },
  ],
  "usx-solstice": [
    {
      ts: Date.UTC(2025, 8, 30), // 2025-09-30 — Solstice launches USX on Solana with ~$160M day-one TVL
      kind: "governance",
      label: "USX launch on Solana — $160M day-one TVL",
      severity: "low",
    },
    {
      ts: Date.UTC(2025, 11, 26), // 2025-12-26 — Thin Solana DEX liquidity drives USX briefly to ~$0.10
      kind: "depeg",
      label: "USX depeg low ~$0.10 — thin Solana DEX liquidity",
      severity: "high",
    },
  ],
  "brz-transfero": [
    {
      ts: Date.UTC(2019, 6, 19), // 2019-07-19 — BRZ launches on Ethereum (Transfero, BRL-pegged)
      kind: "governance",
      label: "BRZ launch on Ethereum",
      severity: "low",
    },
  ],
  "m-m0": [
    {
      ts: Date.UTC(2024, 5, 15), // 2024-06 — M0 protocol deployed on Ethereum mainnet alongside $35M Series A
      kind: "governance",
      label: "M0 mainnet deployment — limited availability phase",
      severity: "low",
      href: "https://research.m0.org/research/m-0-project-completes-system-launch-enters-limited-availability-phase",
    },
  ],
  "usdm-moneta": [
    {
      ts: Date.UTC(2024, 2, 16), // 2024-03-16 — USDM launches as Cardano's first fiat-backed stablecoin
      kind: "governance",
      label: "USDM launch — first fiat-backed stablecoin on Cardano",
      severity: "low",
    },
    {
      ts: Date.UTC(2024, 9, 15), // 2024-10 — NBX co-issuance unveiled at Cardano Summit; MiCA EMT compliance
      kind: "regulatory",
      label: "NBX MiCA EMT co-issuance — EU compliance achieved",
      severity: "med",
    },
  ],
  "usdm-mega": [
    {
      ts: Date.UTC(2025, 8, 8), // 2025-09-08 — MegaETH unveils USDm with Ethena rails for sequencer subsidy
      kind: "governance",
      label: "USDm announced — Ethena partnership for sequencer subsidy",
      severity: "low",
    },
    {
      ts: Date.UTC(2025, 10, 25), // 2025-11-25 — Pre-deposit launch botched by 4-of-4 multisig misconfig; full refund
      kind: "governance",
      label: "USDm pre-deposit botched — multisig misconfig, full refund",
      severity: "med",
    },
  ],
  "usda-avalon": [
    {
      ts: Date.UTC(2024, 10, 11), // 2024-11-11 — Avalon Labs launches BTC-backed USDa CDP
      kind: "governance",
      label: "USDa launch — first BTC-backed CDP stablecoin",
      severity: "low",
    },
  ],
  "crvusd-curve": [
    {
      ts: Date.UTC(2023, 4, 3), // 2023-05-03 — crvUSD contracts first deployed on Ethereum mainnet
      kind: "governance",
      label: "crvUSD mainnet deployment (test-in-prod)",
      severity: "low",
    },
    {
      ts: Date.UTC(2023, 4, 17), // 2023-05-17 — Public crvUSD UI launch; LLAMMA soft-liquidation mechanism live
      kind: "governance",
      label: "crvUSD public launch — LLAMMA mechanism live",
      severity: "low",
    },
    {
      ts: Date.UTC(2023, 7, 3), // 2023-08-03 — Curve Vyper exploit fallout; crvUSD briefly depegs ~0.35%
      kind: "depeg",
      label: "Vyper exploit fallout — crvUSD brief 0.35% depeg",
      severity: "med",
    },
    {
      ts: Date.UTC(2024, 5, 12), // 2024-06-12 — UwU Lend exploit cascades; crvUSD upward depeg, Egorov $100M liquidation
      kind: "depeg",
      label: "UwU Lend exploit — crvUSD upward depeg, Egorov liquidated",
      severity: "high",
      href: "https://research.llamarisk.com/research/crvusd-incident-report-20240612",
    },
    {
      // 2025-06-26 — Resupply (Curve-affiliated lending) exploited via
      // empty-market donation attack on cvcrvUSD vault; crvUSD depegged ~3.2%.
      ts: Date.UTC(2025, 5, 26),
      kind: "depeg",
      label: "Resupply exploit — crvUSD ~3.2% depeg via Llamalend dependency",
      severity: "med",
    },
  ],
  "frax-frax": [
    {
      ts: Date.UTC(2020, 11, 20), // 2020-12-20 — FRAX launches as first fractional-algorithmic stablecoin
      kind: "governance",
      label: "FRAX launch — first fractional-algorithmic stablecoin",
      severity: "low",
    },
    {
      ts: Date.UTC(2022, 8, 7), // 2022-09-07 — Fraxlend launches; permissionless lending markets for FRAX
      kind: "governance",
      label: "Fraxlend launch — permissionless lending markets",
      severity: "low",
    },
    {
      ts: Date.UTC(2023, 1, 23), // 2023-02-23 — FIP-188 passes; FRAX moves to 100% collateral, ends algo backing
      kind: "governance",
      label: "FIP-188 — FRAX votes to fully collateralize (end algo backing)",
      severity: "med",
    },
    {
      ts: Date.UTC(2023, 2, 11), // 2023-03-11 — FRAX depegs to ~$0.88 via USDC-collateral contagion (SVB)
      kind: "depeg",
      label: "USDC contagion via collateral — FRAX depeg low ~$0.88",
      severity: "high",
    },
    {
      ts: Date.UTC(2025, 0, 7), // 2025-01-07 — frxUSD rebrand; BlackRock BUIDL becomes enshrined custodian asset
      kind: "governance",
      label: "frxUSD rebrand — BlackRock BUIDL as enshrined custodian",
      severity: "med",
    },
  ],
  "reusd-re-protocol": [
    {
      ts: Date.UTC(2025, 7, 12), // 2025-08-12 — Re Protocol launches reUSD on Avalanche (Insurance Capital Layer)
      kind: "governance",
      label: "reUSD launch on Avalanche — Insurance Capital Layer live",
      severity: "low",
    },
  ],
  "gusd-gate": [
    {
      ts: Date.UTC(2025, 7, 29), // 2025-08-29 — Gate launches GUSD as RWA-backed yield-bearing dollar
      kind: "governance",
      label: "Gate GUSD launch — RWA-backed yield-bearing dollar",
      severity: "med",
      href: "https://www.gate.com/gusd",
    },
  ],
  "satusd-river": [
    {
      ts: Date.UTC(2025, 1, 11), // 2025-02-11 — Satoshi Protocol V2 launches first Omni-CDP with LayerZero
      kind: "governance",
      label: "Satoshi Protocol V2 launch — first Omni-CDP via LayerZero",
      severity: "med",
      href: "https://blog.river.inc/introducing-satoshi-v2/",
    },
    {
      ts: Date.UTC(2025, 4, 1), // 2025-05 — Satoshi Protocol rebrands to River
      kind: "governance",
      label: "Satoshi Protocol rebrands to River",
      severity: "low",
      href: "https://blog.river.inc/river-layerzero/",
    },
  ],
  "usat-tether": [
    {
      ts: Date.UTC(2025, 8, 12), // 2025-09-12 — Tether unveils USAT with Bo Hines as CEO, Anchorage as issuer
      kind: "governance",
      label: "Tether unveils USAT — Anchorage-issued, GENIUS Act compliant",
      severity: "med",
      href: "https://tether.io/news/tether-unveils-usat-its-planned-u-s-regulated-dollar-backed-stablecoin-and-will-appoint-bo-hines-as-ceo-of-tether-usat/",
    },
    {
      ts: Date.UTC(2026, 0, 27), // 2026-01-27 — USAT goes live on Ethereum via Anchorage Digital Bank
      kind: "governance",
      label: "USAT mainnet launch on Ethereum via Anchorage",
      severity: "med",
      href: "https://tether.io/news/tether-announces-the-launch-of-usat-the-federally-regulated-dollar-backed-stablecoin-made-in-america/",
    },
  ],
  "ausd-agora": [
    {
      ts: Date.UTC(2024, 8, 5), // 2024-09-05 — AUSD native launch on Sui, first institutional USD on Sui
      kind: "governance",
      label: "AUSD native launch on Sui — first institutional USD stablecoin",
      severity: "med",
    },
    {
      ts: Date.UTC(2024, 9, 31), // 2024-10-31 — Injective launches Agora's AUSD as its first native stablecoin
      kind: "governance",
      label: "AUSD launches as Injective's first native stablecoin",
      severity: "low",
      href: "https://www.prnewswire.com/news-releases/injective-launches-agoras-ausd-as-its-first-native-stablecoin-302293133.html",
    },
  ],
  "nusd-nexus": [
    {
      ts: Date.UTC(2021, 7, 29), // 2021-08-29 — Synapse mainnet launches with nUSD cross-chain stable bridging
      kind: "governance",
      label: "Synapse mainnet launch — nUSD basket-backed bridge stable",
      severity: "med",
    },
    {
      ts: Date.UTC(2021, 10, 6), // 2021-11-06 — Metapool virtual-price exploit drains ~$8M nUSD
      kind: "exploit",
      label: "Synapse Metapool exploit — ~$8M nUSD drained, LPs refunded",
      severity: "high",
    },
  ],
  "nusd-neutrl": [
    {
      ts: Date.UTC(2025, 9, 15), // 2025-10-15 — Pre-deposit vaults open for public; NUSD private beta TVL ~$52M
      kind: "governance",
      label: "Neutrl NUSD pre-deposit vaults open",
      severity: "low",
    },
    {
      ts: Date.UTC(2025, 10, 11), // 2025-11-11 — NUSD/sNUSD adopt LayerZero OFT for omni-chain transfer
      kind: "governance",
      label: "Neutrl NUSD public launch — LayerZero OFT live",
      severity: "med",
      href: "https://blockchainreporter.net/neutrl-partners-with-layerzero-for-oft-standard-unlocks-nusd-snusd-stablecoins-defi-cross-chain-interoperability/",
    },
  ],
  "frxusd-frax": [
    {
      ts: Date.UTC(2025, 0, 6), // 2025-01-06 — FIP-419 passes; frxUSD and sfrxUSD launch as FRAX upgrade path
      kind: "governance",
      label: "FIP-419 passes — frxUSD launches as FRAX upgrade path",
      severity: "high",
      href: "https://gov.frax.finance/",
    },
  ],
  "cusd-cap": [
    {
      ts: Date.UTC(2025, 7, 19), // 2025-08-19 — Cap protocol launches on Ethereum mainnet with cUSD and stcUSD
      kind: "governance",
      label: "Cap cUSD launch on Ethereum mainnet — covered-credit issuance",
      severity: "med",
    },
  ],
  "tbill-openeden": [
    {
      ts: Date.UTC(2023, 2, 24), // 2023-03-24 — OpenEden TBILL vault inception; first 24/7 tokenized T-bill
      kind: "governance",
      label: "OpenEden TBILL vault inception — tokenized US T-bills",
      severity: "med",
      href: "https://openeden.com/news/introducing-tokenized-us-treasuries-from-openeden/",
    },
  ],
  "cash-phantom": [
    {
      ts: Date.UTC(2025, 8, 30), // 2025-09-30 — Phantom CASH launches on Solana via Bridge/Stripe Open Issuance
      kind: "governance",
      label: "Phantom CASH launch on Solana via Bridge/Stripe Open Issuance",
      severity: "med",
    },
  ],
  "moveusd-cfx": [
    {
      ts: Date.UTC(2024, 8, 4), // 2024-09-04 — MoveUSD initial activity on Solana; CFX Labs issuer
      kind: "governance",
      label: "CFX MoveUSD launch on Solana — retail-accessible USD",
      severity: "low",
    },
  ],
  "usdf-astherus": [
    {
      ts: Date.UTC(2024, 3, 30), // 2024-04-30 — Astherus launches USDF on BSC; Ethena-style delta-neutral via Ceffu/Binance
      kind: "governance",
      label: "Astherus USDF launch on BSC — delta-neutral synthetic dollar",
      severity: "med",
    },
    {
      ts: Date.UTC(2025, 2, 31), // 2025-03-31 — Astherus + APX Finance merge and rebrand as Aster
      kind: "governance",
      label: "Astherus + APX merge — protocol rebrands to Aster",
      severity: "low",
    },
  ],
  "dusd-standx": [
    {
      ts: Date.UTC(2025, 3, 8), // 2025-04-08 — StandX DUSD token launches with delta-neutral hedged collateral
      kind: "governance",
      label: "StandX DUSD launch — delta-neutral synthetic dollar",
      severity: "med",
    },
    {
      ts: Date.UTC(2025, 10, 24), // 2025-11-24 — StandX mainnet opens to public; DUSD TVL >$176M next day
      kind: "governance",
      label: "StandX mainnet launch — perp DEX with DUSD-margin yield",
      severity: "med",
    },
  ],
  "dusd-fluid": [
    {
      ts: Date.UTC(2022, 5, 11), // 2022-06-11 — Fluid Finance goes live; DUSD mintable on Arbitrum via Swiss bank IBAN
      kind: "governance",
      label: "Fluid Finance DUSD launch on Arbitrum — Swiss bank-linked",
      severity: "med",
    },
  ],
  "fpi-frax": [
    {
      ts: Date.UTC(2022, 3, 9), // 2022-04-09 — FPI/FPIS launch as CPI-pegged stablecoin tracking US inflation
      kind: "governance",
      label: "FPI launch — CPI-pegged stablecoin via Chainlink BLS oracle",
      severity: "med",
      href: "https://docs.frax.finance/frax-price-index/overview-cpi-peg-and-mechanics",
    },
  ],
  "cadd-cad-digital": [
    {
      ts: Date.UTC(2026, 4, 4), // 2026-05-04 — Tetra Digital Group launches CADD as Canada's first regulated CAD-backed stablecoin
      kind: "governance",
      label: "CADD launch — Canada's first regulated CAD-backed stablecoin",
      severity: "med",
      href: "https://www.businesswire.com/news/home/20260504197679/en/Tetra-Digital-Group-Launches-CADD-Canadas-First-CAD-Backed-Stablecoin-Issued-by-a-Financial-Institution",
    },
  ],

  // ───── Comprehensive curation pass (2026-05): tier-1 historical events
  //       and materially novel launches across the tracked universe.
  "aeur-anchored-coins": [
    {
      // 2023-12-05 — Binance halted AEUR after a ~200% pump to ~$3.25 just
      // hours after listing. Only material event in AEUR's history.
      ts: Date.UTC(2023, 11, 5),
      kind: "depeg",
      label: "Binance halts AEUR after ~200% pump (~$3.25) day after listing",
      severity: "high",
      href: "https://www.coindesk.com/markets/2023/12/05/tiny-euro-pegged-stablecoin-surges-200-on-binance-before-exchange-halts-trading-due-to-abnormal-volatility",
    },
  ],
  "alusd-alchemix": [
    {
      // 2023-03-11 — USDC contagion via DAI-backed Transmuter. Note: the
      // 2023-07-30 Curve reentrancy exploit hit alETH, not alUSD directly.
      ts: Date.UTC(2023, 2, 11),
      kind: "depeg",
      label: "USDC/DAI contagion — alUSD depeg via Transmuter backing",
      severity: "high",
    },
  ],
  "bnusd-balanced": [
    {
      // 2023-01-21 — OMM Finance exploit dumped stolen bnUSD on Balanced,
      // dragging the peg.
      ts: Date.UTC(2023, 0, 21),
      kind: "depeg",
      label: "OMM exploit — stolen bnUSD dumped on Balanced, peg break",
      severity: "high",
    },
  ],
  "bold-liquity": [
    {
      // 2025-01-23 — Liquity V2 (BOLD) mainnet launch on Ethereum.
      // User-set interest rates; successor to LUSD.
      ts: Date.UTC(2025, 0, 23),
      kind: "governance",
      label: "BOLD launch — Liquity V2 with user-set interest rates",
      severity: "med",
    },
  ],
  "brl1-brl1": [
    {
      ts: Date.UTC(2024, 9, 7),
      kind: "governance",
      label: "BRL1 consortium announced — Bitso, Foxbit, Mercado Bitcoin, Cainvest",
      severity: "med",
      href: "https://brl1.io/en/projects/brl1-debuts-on-the-market-and-increases-cryptoasset-liquidity",
    },
    {
      // 2025-11 — Brazilian central bank publishes Resolutions 519/520/521
      // bringing BRL stablecoins under FX/VASP regime.
      ...BCB_RES_519,
    },
  ],
  "brla-brla-digital": [BCB_RES_519],
  "btcusd-btcfi": [
    {
      ts: Date.UTC(2024, 3, 17),
      kind: "governance",
      label: "BTCFi launch — Bitcoin-collateralized BtcUSD via Bifrost",
      severity: "med",
    },
  ],
  "buck-bucket-protocol": [
    {
      ts: Date.UTC(2023, 5, 1),
      kind: "governance",
      label: "Bucket Protocol launch on Sui — first decentralized stablecoin on Sui",
      severity: "med",
    },
  ],
  "busd0-usual": [
    {
      // 2026-01-14 — USD0++ rebrand as bUSD0 under Usual Zero Rate (UZR)
      // framework, repositioned as zero-coupon bond primitive.
      ts: Date.UTC(2026, 0, 14),
      kind: "governance",
      label: "USD0++ rebrands to bUSD0 under Usual Zero Rate (UZR)",
      severity: "med",
      href: "https://usual.money/blog/usual-zero-rate-a-native-credit-primitive-for-usd0",
    },
  ],
  "cadc-cad-coin": [
    {
      ts: Date.UTC(2021, 0, 1),
      kind: "governance",
      label: "CADC launch — PayTrie FINTRAC-licensed CAD stablecoin",
      severity: "low",
    },
  ],
  "cdp-enosys": [
    {
      ts: Date.UTC(2025, 11, 11),
      kind: "governance",
      label: "Enosys Loans launch on Flare — first XRP-backed CDP stablecoin",
      severity: "med",
      href: "https://flare.network/news/enosys-loans-xrp-backed-stablecoin-flare",
    },
  ],
  "cetes-etherfuse": [
    {
      ts: Date.UTC(2023, 9, 31),
      kind: "governance",
      label: "Etherfuse CETES launch — tokenized Mexican treasury bills",
      severity: "med",
      href: "https://www.coindesk.com/markets/2023/10/31/blockchain-startup-etherfuse-rolls-out-tokenized-bonds-in-mexico-targeting-retail-investors",
    },
  ],
  "chfau-allunity": [
    {
      ts: Date.UTC(2026, 1, 26),
      kind: "governance",
      label: "CHFAU launch — first MiCAR-compliant Swiss Franc stablecoin",
      severity: "med",
      href: "https://allunity.com/news/allunity-launches-the-first-fully-reserved-micar-compliant-swiss-franc-stablecoin-chfau/",
    },
  ],
  "cjpy-yamato": [
    {
      ts: Date.UTC(2023, 6, 1),
      kind: "governance",
      label: "Yamato Protocol v1 launch — ETH-collateralized JPY stablecoin",
      severity: "low",
    },
  ],
  "cngn-compliant-naira": [
    {
      ts: Date.UTC(2025, 1, 3),
      kind: "regulatory",
      label: "cNGN launch — Africa's first regulated stablecoin (SEC Nigeria RI)",
      severity: "med",
      href: "https://cngn.co/",
    },
  ],
  "ctusd-citrea": [
    {
      ts: Date.UTC(2026, 0, 27),
      kind: "governance",
      label: "Citrea mainnet launch — ctUSD issued by MoonPay, powered by M0",
      severity: "med",
      href: "https://www.blog.citrea.xyz/introducing-citrea-usd-ctusd-the-native-stablecoin-for-bitcoin-issued-by-moonpay-and-powered-by-m0/",
    },
  ],
  "cusdo-openeden": [
    {
      ts: Date.UTC(2025, 7, 13),
      kind: "governance",
      label: "BNY Mellon custody for OpenEden TBILL — Moody's A-rated backing",
      severity: "med",
    },
  ],
  "deuro-deuro": [
    {
      ts: Date.UTC(2025, 5, 12),
      kind: "governance",
      label: "dEURO public launch — oracle-free decentralized Euro stablecoin",
      severity: "low",
    },
  ],
  "dgld-gold-token-sa": [
    {
      // 2025-11-20 — MKS PAMP acquired full ownership and relaunched DGLD;
      // the relaunch is the material event for the active asset.
      ts: Date.UTC(2025, 10, 20),
      kind: "governance",
      label: "MKS PAMP acquires full ownership — DGLD relaunch",
      severity: "med",
      href: "https://www.mkspamp.com/mks-pamp-acquires-full-ownership-gold-token-sa-relaunch-leading-real-world-asset-backed-tokenized",
    },
  ],
  "djed-coti": [
    {
      ts: Date.UTC(2023, 0, 31),
      kind: "governance",
      label: "DJED mainnet launch — Cardano overcollateralized stablecoin",
      severity: "med",
    },
  ],
  "dllr-sovryn": [
    {
      ts: Date.UTC(2023, 2, 18),
      kind: "governance",
      label: "Sovryn Dollar launch — BTC-backed aggregator on Rootstock",
      severity: "low",
      href: "https://sovryn.com/all-things-sovryn/launching-the-sovryn-dollar",
    },
  ],
  "doc-money-on-chain": [
    {
      ts: Date.UTC(2019, 11, 12),
      kind: "governance",
      label: "DOC launch — first BTC-collateralized stablecoin on Rootstock",
      severity: "low",
    },
  ],
  "dola-inverse-finance": [
    {
      // 2022-04-02 — Frontier oracle exploit (~$15.6M); INV price manipulation
      // via TWAP attack. Larger of the two 2022 issuer-damaging events.
      ts: Date.UTC(2022, 3, 2),
      kind: "exploit",
      label: "Frontier oracle exploit — $15.6M, INV price manipulation",
      severity: "high",
    },
    {
      // 2022-06-16 — Second flash-loan oracle exploit on Frontier (~$5.8M).
      ts: Date.UTC(2022, 5, 16),
      kind: "exploit",
      label: "Frontier flash-loan oracle exploit — ~$5.8M DOLA borrowed",
      severity: "med",
      href: "https://cointelegraph.com/news/inverse-finance-exploited-again-for-1-2m-in-flashloan-oracle-attack",
    },
  ],
  "dusd-dtrinity": [
    {
      ts: Date.UTC(2024, 11, 18),
      kind: "governance",
      label: "dTRINITY dUSD launch on Fraxtal — subsidized stablecoin lending",
      severity: "low",
      href: "https://decrypt.co/297381/dtrinity-launches-subsidized-stablecoin-lending-protocol-on-fraxtal-l2",
    },
    {
      // 2026-03-17 — dTRINITY dLEND exploit created ~$257K dUSD bad debt.
      ts: Date.UTC(2026, 2, 17),
      kind: "exploit",
      label: "dLEND exploit — ~$257K dUSD bad debt",
      severity: "high",
      href: "https://blocksec.com/blog/weekly-web3-security-incident-roundup-mar-16-mar-22-2026",
    },
  ],
  "sdusd-dtrinity": [
    {
      // 2026-03-17 — sdUSD is the tracked dUSD savings wrapper and inherits
      // the dTRINITY dLEND exploit risk through its parent collateral.
      ts: Date.UTC(2026, 2, 17),
      kind: "exploit",
      label: "dLEND exploit — sdUSD inherits dUSD bad-debt risk",
      severity: "high",
      href: "https://nomoslabs.io/archive/dtrinity-2026",
    },
  ],
  "eurau-allunity": [
    {
      ts: Date.UTC(2025, 6, 31),
      kind: "regulatory",
      label: "EURAU launch — first BaFin EMI-licensed MiCA euro stablecoin",
      severity: "med",
      href: "https://allunity.com/news/allunity-launches-eurau-germanys-first-fully-reserved-micar-compliant-euro-stablecoin/",
    },
  ],
  "eurcv-societe-generale-forge": [
    {
      ts: Date.UTC(2023, 3, 20),
      kind: "governance",
      label: "EURCV launch on Ethereum — whitelisted institutional use",
      severity: "low",
    },
    {
      // 2024-07 — EURCV MiCA relaunch; whitelisting removed under SG-Forge's
      // ACPR EMI license, becoming a free-transfer MiCA EMT.
      ts: Date.UTC(2024, 6, 1),
      kind: "regulatory",
      label: "EURCV MiCA relaunch — free transferability under ACPR EMI",
      severity: "med",
      href: "https://www.sgforge.com/stablecoin-elevation/",
    },
  ],
  "eure-monerium": [
    {
      ts: Date.UTC(2024, 5, 30),
      kind: "regulatory",
      label: "MiCA EMT regime in force — EURe among first compliant euro stables",
      severity: "med",
    },
  ],
  "euri-banking-circle": [
    {
      ts: Date.UTC(2024, 7, 26),
      kind: "regulatory",
      label: "EURI launch — first bank-backed MiCA-compliant euro stablecoin",
      severity: "med",
      href: "https://www.bankingcircle.com/banking-circle-launches-the-first-bank-backed-mica-compliant-stablecoin-euri/",
    },
  ],
  "euroe-membrane": [
    {
      ts: Date.UTC(2023, 1, 1),
      kind: "regulatory",
      label: "EUROe launch — first FIN-FSA EMI-regulated euro stablecoin",
      severity: "med",
    },
  ],
  "europ-schuman": [
    {
      ts: Date.UTC(2024, 10, 1),
      kind: "regulatory",
      label: "EURØP launch — first French ACPR MiCA-compliant euro stablecoin",
      severity: "med",
      href: "https://www.theblock.co/post/328075/schuman-financial-debuts-europ-a-mica-compliant-euro-stablecoin",
    },
  ],
  "eurq-quantoz": [
    {
      ts: Date.UTC(2024, 10, 18),
      kind: "regulatory",
      label: "EURQ launch — DNB-licensed MiCA-compliant euro stablecoin",
      severity: "med",
      href: "https://cointelegraph.com/news/quantoz-eurq-usdq-micar-stablecoins-launch",
    },
  ],
  "eurr-stablr": [
    {
      ts: Date.UTC(2025, 0, 16),
      kind: "regulatory",
      label: "EURR public launch via Bitfinex — Malta MFSA EMI, MiCA-compliant",
      severity: "low",
      href: "https://www.stablr.com/insights/stablr-usdr-and-eurr-now-listed-on-bitfinex",
    },
    {
      // 2026-05-24 — Attacker compromised one key on StablR's 1-of-3 minting
      // multisig, minted ~$13.5M unbacked USDR/EURR and dumped on DEXs. StablR
      // froze mint/redeem 05-26, acknowledged supply not 1:1-backed under MiCA.
      // EURR remained deeply depegged/frozen; bottom unsettled, lead with cause.
      ts: Date.UTC(2026, 4, 24),
      kind: "depeg",
      label: "StablR multisig key compromise — unbacked mint, EURR depeg",
      severity: "high",
      href: "https://www.coindesk.com/markets/2026/05/26/stablr-freezes-usdr-and-eurr-after-attacker-mints-usd13-5-million-in-unbacked-tokens",
    },
  ],
  "eurs-stasis": [
    {
      ts: Date.UTC(2018, 6, 4),
      kind: "governance",
      label: "EURS launch — first euro-pegged stablecoin (STASIS, Malta)",
      severity: "med",
      href: "https://www.globenewswire.com/news-release/2018/07/04/1533269/0/en/STASIS-launches-EURS-a-stablecoin-backed-by-the-Euro.html",
    },
  ],
  "eusd-telcoin": [
    {
      ts: Date.UTC(2025, 11, 26),
      kind: "regulatory",
      label: "eUSD launch — first US-chartered bank stablecoin (Telcoin/Nebraska)",
      severity: "high",
      href: "https://www.businesswire.com/news/home/20251226357792/en/Telcoin-Begins-Digital-Asset-Banking-Operations-with-Launch-of-eUSD-Stablecoin",
    },
  ],
  "eutbl-spiko": [
    {
      ts: Date.UTC(2024, 4, 15),
      kind: "governance",
      label: "Spiko EU T-Bills MMF inception — UCITS-tokenized euro T-bill fund",
      severity: "med",
    },
  ],
  "feusd-felix": [
    {
      ts: Date.UTC(2024, 5, 1),
      kind: "governance",
      label: "Felix feUSD launch — Liquity-V2 CDP on Hyperliquid",
      severity: "low",
    },
  ],
  "fidd-fidelity": [
    {
      ts: Date.UTC(2026, 1, 4),
      kind: "governance",
      label: "FIDD launch — Fidelity Digital Assets, first GENIUS-Act TradFi stable",
      severity: "med",
      href: "https://newsroom.fidelity.com/pressreleases/fidelity-investments--expands-digital-asset-investment-lineup-with-stablecoin-launch--fidelity-digit/s/3b55e2d1-1dba-4120-9528-1e07e632f3f4",
    },
  ],
  "fiusd-fiserv": [
    {
      ts: Date.UTC(2025, 5, 23),
      kind: "governance",
      label: "FIUSD announced — Fiserv bank-friendly stablecoin via Paxos/Circle",
      severity: "med",
      href: "https://investors.fiserv.com/newsroom/detail/2848/fiserv-launches-new-fiusd-stablecoin-for-financial-institutions",
    },
  ],
  "ftusd-flying-tulip": [
    {
      ts: Date.UTC(2026, 1, 23),
      kind: "governance",
      label: "ftUSD launch — Andre Cronje's Flying Tulip yield-bearing stablecoin",
      severity: "med",
    },
  ],
  "fusd-freedom-dollar": [
    {
      ts: Date.UTC(2025, 0, 5),
      kind: "governance",
      label: "fUSD launch on Zano — first protocol-level-private USD stablecoin",
      severity: "low",
    },
  ],
  "fxusd-f-x-protocol": [
    {
      ts: Date.UTC(2024, 1, 23),
      kind: "governance",
      label: "fxUSD launch — f(x) Protocol stablecoin backed by LSD pairs",
      severity: "med",
    },
  ],
  "gusd-gemini": [
    {
      ts: Date.UTC(2018, 8, 9),
      kind: "regulatory",
      label: "GUSD launch — first NYDFS-approved fiat-backed stablecoin",
      severity: "med",
    },
    {
      // 2023-06-27 — MakerDAO PSM cap for GUSD slashed from $500M to $110M
      // amid Gemini Earn/Genesis fallout; major shift in DeFi backing demand.
      ts: Date.UTC(2023, 5, 27),
      kind: "governance",
      label: "MakerDAO cuts GUSD PSM ceiling from $500M to $110M",
      severity: "high",
    },
  ],
  "gyen-gyen": [
    {
      // 2021-11-19 — Coinbase listing liquidity shock; GYEN traded thousands
      // of dollars before trading was suspended.
      ts: Date.UTC(2021, 10, 19),
      kind: "depeg",
      label: "Coinbase listing liquidity shock — GYEN upward depeg, trading halted",
      severity: "high",
    },
    {
      // 2026-07-07 — Secondary price collapse (~-64%) after GMO Trust's
      // 2026-05-15 wind-down (purchases disabled, redemption-only through
      // 2026-11-11). Single pin at the price pivot; GYEN frozen 2026-07-08.
      ts: Date.UTC(2026, 6, 7),
      kind: "depeg",
      label: "GMO wind-down — redemption-only GYEN, secondary price collapse",
      severity: "high",
      href: "https://stablecoin.z.com/press/",
    },
  ],
  "hkdap-anchorpoint": [
    {
      ts: Date.UTC(2026, 3, 10),
      kind: "regulatory",
      label: "HKMA grants Anchorpoint stablecoin licence — first batch (HK Ordinance)",
      severity: "high",
      href: "https://www.sc.com/en/press-release/standard-chartered-backed-anchorpoint-granted-stablecoin-issuer-licence-by-the-hong-kong-monetary-authority/",
    },
  ],
  "hkd-hsbc": [
    {
      ts: Date.UTC(2026, 3, 10),
      kind: "regulatory",
      label: "HKMA grants HSBC stablecoin licence — first batch (HK Ordinance)",
      severity: "high",
      href: "https://www.about.hsbc.com.hk/news-and-media/hsbc-welcomes-hkmas-grant-of-a-hong-kong-stablecoin-issuer-licence",
    },
  ],
  "hkdr-rd-technologies": [
    {
      ts: Date.UTC(2024, 6, 18),
      kind: "regulatory",
      label: "RD InnoTech admitted to HKMA stablecoin sandbox — first-batch entrant",
      severity: "med",
    },
  ],
  "hlscope-hamilton-lane": [
    {
      ts: Date.UTC(2023, 4, 1),
      kind: "governance",
      label: "SCOPE feeder fund tokenized on Polygon via Securitize",
      severity: "med",
      href: "https://www.hamiltonlane.com/en-us/news/scope-available-via-securitize",
    },
  ],
  "honey-berachain": [
    {
      // 2025-05 — HONEY redemptions halted ~50 hours after USDC.e collateral
      // leg depleted; mechanism stress event.
      ts: Date.UTC(2025, 4, 1),
      kind: "depeg",
      label: "USDC.e reserve exhaustion — HONEY redemptions halted ~50hrs",
      severity: "med",
      href: "https://www.ainvest.com/news/honey-redemption-halted-berachain-usdc-reserves-depleted-2505/",
    },
  ],
  "ist-agoric": [
    {
      // 2025-06-30 — Inter Protocol sunset; IST redemption grace period ends.
      ts: Date.UTC(2025, 5, 30),
      kind: "governance",
      label: "Inter Protocol sunset — IST redemption grace period ends",
      severity: "high",
      href: "https://agoric.com/blog/getting-started/ist/",
    },
  ],
  "iusd-indigo-protocol": [
    {
      // 2023-11 — Oversupply-driven depeg; DAO raised MCR 120%→150% to
      // defend the peg.
      ts: Date.UTC(2023, 10, 1),
      kind: "depeg",
      label: "Oversupply depeg — DAO raised MCR 120%→150% to defend peg",
      severity: "high",
      href: "https://indigoprotocol1.medium.com/advancing-stablecoins-part-1-3-iusds-triple-peg-architecture-bolsters-defi-resilience-on-80d7f8318d56",
    },
  ],
  "jaaa-janus-henderson-anemoy": [
    {
      ts: Date.UTC(2025, 5, 24),
      kind: "governance",
      label: "JAAA launch — first onchain AAA CLO fund, $1B Grove allocation",
      severity: "med",
      href: "https://centrifuge.io/blog/centrifuge-janus-henderson-grove-tokenized-aaa-clo-fund",
    },
  ],
  "jpyc-jpyc": [
    {
      ts: Date.UTC(2025, 9, 27),
      kind: "regulatory",
      label: "Japan's first FSA-licensed yen stablecoin — PSA Type II issuer",
      severity: "high",
      href: "https://www.elliptic.co/media-center/elliptic-enables-jpyc-to-become-japans-first-fsa-approved-yen-stablecoin",
    },
  ],
  "jupusd-jupiter": [
    {
      ts: Date.UTC(2025, 9, 8),
      kind: "governance",
      label: "JupUSD launch — Jupiter native stablecoin via Ethena, $750M JLP migration",
      severity: "med",
      href: "https://www.coindesk.com/web3/2025/10/08/solana-s-jupiter-to-develop-jupusd-stablecoin-with-backing-from-ethena-labs",
    },
  ],
  "kgst-kyrgyz-som": [
    {
      ts: Date.UTC(2025, 9, 25),
      kind: "regulatory",
      label: "KGST launch — first CIS nation-backed stablecoin, listed on Binance",
      severity: "med",
      href: "https://www.blockhead.co/2025/10/27/kyrgyzstan-launches-som-pegged-stablecoin-establishes-national-crypto-reserve/",
    },
  ],
  "klarnausd-klarna": [
    {
      ts: Date.UTC(2025, 10, 25),
      kind: "governance",
      label: "KlarnaUSD announced — first bank stablecoin on Tempo (Stripe/Bridge)",
      severity: "med",
      href: "https://www.klarna.com/international/press/klarna-launches-klarnausd-as-stablecoin-transactions-hit-usd27-trillion/",
    },
  ],
  "krw1-bdacs": [
    {
      ts: Date.UTC(2025, 8, 1),
      kind: "governance",
      label: "KRW1 launch — first Korean won-backed stablecoin (BDACS, Woori-reserved)",
      severity: "med",
      href: "https://coinmarketcap.com/academy/article/krw1-stablecoin-debuts-on-avalanche-network",
    },
  ],
  "lisusd-lista": [
    {
      ts: Date.UTC(2023, 11, 6),
      kind: "governance",
      label: "LISUSD launch — Lista DAO rebrand of Helio HAY (destablecoin model)",
      severity: "med",
    },
  ],
  "lusd-liquity": [
    {
      ts: Date.UTC(2021, 3, 5),
      kind: "governance",
      label: "Liquity LUSD launch — immutable 110% MCR decentralized USD CDP",
      severity: "med",
      href: "https://www.liquity.org/blog/announcing-liquity",
    },
    {
      // 2023-03-11 — flight-to-safety premium during the SVB weekend; LUSD's
      // ETH-only, fiat-free design inverted the contagion that broke USDC/Dai/FRAX.
      ts: Date.UTC(2023, 2, 11),
      kind: "depeg",
      label: "Flight to safety: LUSD trades to a premium as SVB breaks USDC/Dai/FRAX",
      severity: "med",
      href: "https://www.liquity.org/blog/liquity-q1-report",
    },
  ],
  "mai-qidao": [
    {
      // Mid-2023 — MAI's sustained depeg below $0.90; never recovered. Single
      // pin marks the structural break vs flagging the ongoing drift.
      ts: Date.UTC(2023, 5, 1),
      kind: "depeg",
      label: "MAI sustained depeg below $0.90 — recovery never achieved",
      severity: "high",
    },
  ],
  "meusd-mezo": [
    {
      ts: Date.UTC(2025, 2, 12),
      kind: "governance",
      label: "Mezo MUSD launch — BTC-collateralized CDP on Mezo mainnet",
      severity: "low",
    },
  ],
  "mim-abracadabra": [
    {
      // 2022-01-27 — Wonderland TIME treasury 0xSifu scandal exposed
      // Abracadabra co-founder; major reputational hit on MIM issuer.
      ts: Date.UTC(2022, 0, 27),
      kind: "governance",
      label: "Wonderland 0xSifu scandal — Abracadabra co-founder reputational hit",
      severity: "high",
    },
    {
      // 2022-05-12 — Terra/UST collapse contagion; MIM depeg low ~$0.93.
      ts: Date.UTC(2022, 4, 12),
      kind: "depeg",
      label: "Terra/UST contagion — MIM depeg low ~$0.93",
      severity: "high",
    },
    {
      // 2025-03-25 — GMX cauldron exploit drained ~$13M MIM from Arbitrum
      // markets.
      ts: Date.UTC(2025, 2, 25),
      kind: "exploit",
      label: "GMX cauldron exploit — ~$13M MIM drained from Arbitrum",
      severity: "high",
    },
  ],
  "musd-metamask": [
    {
      ts: Date.UTC(2025, 6, 30),
      kind: "governance",
      label: "MetaMask mUSD launch — first major wallet-native stablecoin",
      severity: "med",
      href: "https://consensys.io/blog/metamask-introduces-musd",
    },
  ],
  "mxnb-juno": [
    {
      ts: Date.UTC(2024, 4, 28),
      kind: "governance",
      label: "MXNB launch — Bitso/Juno regulated MXN stablecoin on Arbitrum",
      severity: "med",
    },
  ],
  "nect-beraborrow": [
    {
      ts: Date.UTC(2025, 1, 6),
      kind: "governance",
      label: "NECT launch — Beraborrow Liquity-fork CDP on Berachain mainnet",
      severity: "low",
    },
  ],
  "ousd-origin-protocol": [
    {
      // 2020-11-17 — Reentrancy exploit drained ~$7M (~33% of supply);
      // OUSD briefly broke peg before Origin compensation plan.
      ts: Date.UTC(2020, 10, 17),
      kind: "depeg",
      label: "Reentrancy exploit — $7M drained (~33% supply), peg break",
      severity: "high",
      href: "https://blog.originprotocol.com/origin-dollar-ousd-hack-detailed-analysis-of-the-flash-loan-attack-on-nov-17-58939bef9c11",
    },
  ],
  "ousg-ondo-finance": [
    {
      ts: Date.UTC(2023, 0, 31),
      kind: "governance",
      label: "OUSG launch — Ondo's first tokenized US Treasury product",
      severity: "med",
      href: "https://blog.ondo.finance/introducing-ondo-finance/",
    },
  ],
  "paxg-paxos": [
    {
      ts: Date.UTC(2019, 8, 5),
      kind: "regulatory",
      label: "PAXG launch — first NYDFS-approved tokenized gold",
      severity: "med",
    },
  ],
  "pusd-polaris": [
    {
      // 2023-03-22 — Polaris Finance flash-loan exploit drained ~$26M across
      // stables including pUSD; protocol-defining depeg event.
      ts: Date.UTC(2023, 2, 22),
      kind: "depeg",
      label: "Polaris Finance flash-loan exploit — ~$26M drained, pUSD depeg",
      severity: "high",
      href: "https://rekt.news/polaris-rekt/",
    },
  ],
  "reusd-resupply": [
    {
      // 2025-06-26 — Empty-market donation attack on cvcrvUSD vault drained
      // ~$10M; reUSD lost ~3.2% peg briefly. Companion to crvUSD pin.
      ts: Date.UTC(2025, 5, 26),
      kind: "depeg",
      label: "Resupply exploit — ~$10M drained, reUSD depeg ~3.2%",
      severity: "high",
      href: "https://resupply.fi/",
    },
  ],
  "susd-synthetix": [
    {
      // 2025-04-18 — SIP-420 lowered C-ratio to 200%, causing sUSD
      // oversupply and the first stage of the 2025 depeg saga.
      ts: Date.UTC(2025, 3, 18),
      kind: "governance",
      label: "SIP-420 lowers C-ratio to 200% — sUSD oversupply, depeg ~$0.68",
      severity: "high",
      href: "https://sips.synthetix.io/sips/sip-420/",
    },
    {
      // 2025-08-01 — sUSD all-time low ~$0.21 as protocol-owned debt
      // mechanics played out post-SIP-420.
      ts: Date.UTC(2025, 7, 1),
      kind: "depeg",
      label: "sUSD ATL ~$0.21 — protocol-owned debt pool fallout",
      severity: "high",
    },
  ],
  "usdb-blast": [
    {
      ts: Date.UTC(2024, 1, 29),
      kind: "governance",
      label: "Blast mainnet launch — auto-rebasing USDB with MakerDAO T-bill yield",
      severity: "med",
      href: "https://www.dlnews.com/articles/defi/blast-unlocks-23bn-of-ether-and-stablecoins-with-launch/",
    },
  ],
  "usdcv-societe-generale-forge": [
    {
      ts: Date.UTC(2025, 5, 25),
      kind: "regulatory",
      label: "USDCV launch — first major bank USD stablecoin under MiCA (BNY custodian)",
      severity: "med",
      href: "https://www.sgforge.com/usd-stablecoin-bny-custodian/",
    },
  ],
  "usdh-native-markets": [
    {
      // 2025-09-14 — Hyperliquid validator vote awarded USDH ticker to
      // Native Markets; contested governance moment for the chain.
      ts: Date.UTC(2025, 8, 14),
      kind: "governance",
      label: "Hyperliquid validator vote awards USDH ticker to Native Markets",
      severity: "high",
      href: "https://www.coindesk.com/markets/2025/09/15/asia-morning-briefing-native-markets-wins-right-to-issue-usdh",
    },
  ],
  "usdn-noble": [
    {
      ts: Date.UTC(2025, 2, 5),
      kind: "governance",
      label: "USDN launch — composable yield-bearing stablecoin via M0",
      severity: "med",
      href: "https://noble.xyz/blog/introducing-usdn",
    },
  ],
  "usdp-paxos": [
    {
      // 2023-02-13 — NYDFS halted Paxos's BUSD minting; USDP demand and
      // supply contracted from ~$480M toward ~$40M over the following years.
      ts: Date.UTC(2023, 1, 13),
      kind: "regulatory",
      label: "NYDFS halts Paxos BUSD minting — USDP demand fades",
      severity: "high",
      href: "https://www.dfs.ny.gov/consumers/alerts/Paxos_and_Binance",
    },
  ],
  "usdpt-western-union": [
    {
      ts: Date.UTC(2026, 4, 4),
      kind: "governance",
      label: "USDPT launch — Western Union stablecoin via Anchorage on Solana",
      severity: "med",
      href: "https://ir.westernunion.com/news/archived-press-releases/press-release-details/2026/Western-Union-Launches-USDPT-on-Solana-Advancing-Regulated-Digital-Infrastructure-for-Global-Payments/default.aspx",
    },
  ],
  "usdq-quantoz": [
    {
      ts: Date.UTC(2024, 10, 18),
      kind: "regulatory",
      label: "USDQ launch — DNB-licensed MiCA-compliant USD stablecoin",
      severity: "med",
      href: "https://www.prnewswire.com/news-releases/quantoz-payments-issues-euro-and-us-dollar-stablecoins-receives-backing-from-major-crypto-asset-firms-302307631.html",
    },
  ],
  "usdr-stablr": [
    {
      ts: Date.UTC(2024, 6, 1),
      kind: "regulatory",
      label: "StablR USDR launch — MFSA EMI license, MiCA-compliant via Hadron",
      severity: "med",
    },
    {
      // 2026-05-24 — Same StablR 1-of-3 minting multisig key compromise; attacker
      // minted ~8.35M unbacked USDR. USDR fell to ~$0.64, repegged to ~$0.994 by
      // 05-26 after StablR froze mint/redeem and asked exchanges to halt trading.
      ts: Date.UTC(2026, 4, 24),
      kind: "depeg",
      label: "StablR multisig key compromise — unbacked mint, USDR depeg low ~$0.64",
      severity: "high",
      href: "https://www.coindesk.com/markets/2026/05/26/stablr-freezes-usdr-and-eurr-after-attacker-mints-usd13-5-million-in-unbacked-tokens",
    },
  ],
  "usdsui-sui": [
    {
      ts: Date.UTC(2026, 2, 4),
      kind: "governance",
      label: "USDsui mainnet — Bridge/Stripe issuance, yield recycled to ecosystem",
      severity: "med",
      href: "https://blog.sui.io/sui-unveils-usdsui-native-stablecoin/",
    },
  ],
  "usdx-kava": [
    {
      // Mid-2022 — USDX-Kava sustained depeg as DeFi credit unwind hit
      // collateral and demand simultaneously; never durably recovered.
      ts: Date.UTC(2022, 5, 15),
      kind: "depeg",
      label: "Kava USDX sustained depeg — collateral and demand collapse",
      severity: "high",
    },
  ],
  "ustb-superstate": [
    {
      ts: Date.UTC(2024, 1, 27),
      kind: "governance",
      label: "USTB launch — first SEC-registered tokenized US T-bill fund",
      severity: "med",
      href: "https://superstate.co/",
    },
  ],
  "usx-dforce": [
    {
      // 2020-04-19 — Lendf.Me imBTC reentrancy exploit drained ~$25M from
      // dForce's lending market, impairing the protocol backing USX.
      // Funds were eventually largely returned.
      ts: Date.UTC(2020, 3, 19),
      kind: "exploit",
      label: "Lendf.Me imBTC reentrancy — $25M drained, dForce lending impaired",
      severity: "high",
      href: "https://medium.com/dforcenet/dforce-lendf-me-incident-summary-and-recovery-plan-7e2d2b3e2c66",
    },
    {
      // 2026-04-04 — CoinGecko daily data first shows dForce USX below $0.50
      // in its current prolonged deep-depeg period.
      ts: Date.UTC(2026, 3, 4),
      kind: "depeg",
      label: "dForce USX deep depeg — price breaks below $0.50",
      severity: "high",
      href: "https://www.coingecko.com/en/coins/dforce-usd",
    },
  ],
  "wemix-dollar-wemix": [
    {
      // 2023-12-04 — WEMIX$ lost peg alongside WEMIX token crash and
      // reserve confidence loss.
      ts: Date.UTC(2023, 11, 4),
      kind: "depeg",
      label: "WEMIX$ depeg — WEMIX token crash and reserve confidence loss",
      severity: "high",
    },
  ],
  "wusd-worldwide": [
    {
      // 2024-09-15 — WUSD depeg low ~$0.97; liquidity stress event.
      ts: Date.UTC(2024, 8, 15),
      kind: "depeg",
      label: "WUSD depeg low ~$0.97 — liquidity stress",
      severity: "med",
    },
  ],
  "xdai-gnosis": [
    {
      // 2023-03-11 — USDC/SVB contagion via the xDAI bridge collateral.
      ts: Date.UTC(2023, 2, 11),
      kind: "depeg",
      label: "USDC/SVB contagion via bridge — xDAI depeg",
      severity: "high",
    },
  ],
  "xusd-babelfish": [
    {
      // 2023-03-11 — USDC/SVB contagion; Babelfish XUSD is USDC-backed.
      ts: Date.UTC(2023, 2, 11),
      kind: "depeg",
      label: "USDC/SVB contagion — XUSD collateral depeg",
      severity: "high",
    },
  ],
  "yousd-yield-optimizer": [
    {
      // 2026-03-22 — Resolv exploit impaired yoUSD's Resolv-linked strategy
      // exposure; the issuer performance view reported a ~2.95% drawdown.
      ts: Date.UTC(2026, 2, 22),
      kind: "depeg",
      label: "Resolv exploit exposure — yoUSD NAV drawdown ~2.95%",
      severity: "high",
      href: "https://resolv.xyz/blog/resolv-postmortem-march-22-2026-incident",
    },
  ],
  "apxusd-apyx": [
    {
      // 2026-06-02 — STRC (Strategy preferred equity, ~62% of reserve) traded
      // below par as Bitcoin fell, dragging apxUSD's reserve value; the
      // incident opened on June 2 at ~$0.99 and drove a recorded low of
      // ~$0.89 (−1,059 bps). It did not mean-revert: still active as of
      // mid-June 2026 (~$0.96). CoinDesk reported it on June 4, with Apyx
      // framing it as expected behavior for a preferred-equity-backed dollar.
      ts: Date.UTC(2026, 5, 2),
      kind: "depeg",
      label: "STRC drawdown — apxUSD depeg low ~$0.89 (−1,059 bps), unresolved",
      severity: "high",
      href: "https://www.coindesk.com/markets/2026/06/04/apyx-s-stablecoin-suffers-a-brief-depeg-protocol-says-its-a-feature-not-bug",
    },
  ],
  "cusd-celo": [
    {
      // 2020-06-28 — Governance activated the Celo stability protocol and
      // enabled Celo Dollar transfers.
      ts: Date.UTC(2020, 5, 28),
      kind: "governance",
      label: "Stability protocol activated — cUSD transfers enabled",
      severity: "med",
      href: "https://forum.celo.org/t/governance-proposal-to-activate-celo-stability-protocol-and-enable-cusd-transfers/547",
    },
    {
      // 2025-12-17 — Mento rebrands Celo Dollar (cUSD) as Mento Dollar (USDm).
      ts: Date.UTC(2025, 11, 17),
      kind: "governance",
      label: "Mento rebrand — cUSD becomes USDm, V3 multichain FX",
      severity: "med",
      href: "https://www.mento.org/blog/a-new-chapter-in-multichain-fx-the-evolution-of-mento-stablecoins",
    },
  ],
  "jtrsy-anemoy": [
    {
      // 2026-03-20 — S&P upgraded JTRSY fund credit quality to AAAf and
      // affirmed S1+ volatility rating.
      ts: Date.UTC(2026, 2, 20),
      kind: "governance",
      label: "S&P upgrade — JTRSY reaches AAAf/S1+ ratings",
      severity: "low",
      href: "https://www.spglobal.com/ratings/en/regulatory/article/-/view/type/HTML/id/3534006",
    },
  ],
  "kag-kinesis": [
    {
      // 2026-05-18 — ERC-20 KAG lists on Mercado Bitcoin.
      ts: Date.UTC(2026, 4, 18),
      kind: "governance",
      label: "KAG ERC-20 lists on Mercado Bitcoin",
      severity: "low",
      href: "https://kinesis.money/company-news/kau-kag-listed-on-mercado-bitcoin/",
    },
  ],
  "kau-kinesis": [
    {
      // 2026-05-18 — ERC-20 KAU lists on Mercado Bitcoin.
      ts: Date.UTC(2026, 4, 18),
      kind: "governance",
      label: "KAU ERC-20 lists on Mercado Bitcoin",
      severity: "low",
      href: "https://kinesis.money/company-news/kau-kag-listed-on-mercado-bitcoin/",
    },
  ],
  "safo-spiko-usd": [
    {
      // 2026-03-19 — Spiko and Amundi launch SAFO.
      ts: Date.UTC(2026, 2, 19),
      kind: "governance",
      label: "SAFO launch — Amundi/Spiko tokenized overnight fund",
      severity: "med",
      href: "https://int.media.amundi.com/files/nuxeo/dl/be27cca1-ad67-4fc4-87a9-7ec68766e2d4?inline=",
    },
  ],
  "silk-shade-protocol": [
    {
      // 2023-10-08 — DefiLlama daily data bottoms near $0.956 during the
      // underpeg window Shade attributed to LP imbalance.
      ts: Date.UTC(2023, 9, 8),
      kind: "depeg",
      label: "LP imbalance — SILK trades below basket peg",
      severity: "med",
      href: "https://forum.shadeprotocol.io/t/silk-stability-restoration-for-underpeg-scenarios/370",
    },
  ],
  "sofid-sofi": [
    {
      // 2025-12-18 — SoFi launches SoFiUSD through SoFi Bank, N.A.
      ts: Date.UTC(2025, 11, 18),
      kind: "governance",
      label: "SoFiUSD launch — first national-bank public-chain stablecoin",
      severity: "med",
      href: "https://investors.sofi.com/news/news-details/2025/SoFi-Launches-Fully-Reserved-Stablecoin-to-Power-Financial-Infrastructure-for-Banks-Fintechs-and-Enterprise-Partners/default.aspx",
    },
  ],
  "spkcc-spiko": [
    {
      // 2025-07-24 — Spiko Cash & Carry official launch date.
      ts: Date.UTC(2025, 6, 24),
      kind: "governance",
      label: "SPKCC launch — Spiko cash-and-carry fund",
      severity: "low",
      href: "https://www.spiko.io/spiko-cash-and-carry",
    },
  ],
  "trusd-tori": [
    {
      // 2026-07-26 — trUSD reached live price coverage after its pre-deposit phase.
      ts: Date.UTC(2026, 6, 26),
      kind: "governance",
      label: "trUSD mainnet launch — live supply and price coverage begins",
      severity: "med",
      href: "https://app.tori.finance/transparency",
    },
  ],
  "bd-basedollar": [
    {
      // 2026-08-01 — BaseDollar production contracts deployed to Base mainnet.
      ts: Date.UTC(2026, 7, 1),
      kind: "governance",
      label: "BaseDollar production contracts deploy to Base mainnet",
      severity: "med",
      href: "https://github.com/basedollar/basedollar/pull/160",
    },
  ],
  "kusd-kerne": [
    {
      // 2026-08-06 — kUSD and PSM administration completed its timelock handoff.
      ts: Date.UTC(2026, 7, 6),
      kind: "governance",
      label: "kUSD administration completes 48-hour timelock handoff",
      severity: "med",
      href: "https://basescan.org/tx/0xed24d495789540dae543793a5d8c9d884d8abfc386c0e726084da9183933d9b8",
    },
  ],
  "usr-resolv": [
    {
      // 2026-03-22 — Attacker compromised a Resolv signing key (AWS KMS) and
      // exploited a missing max-mint check to print 80M unbacked USR from
      // ~$100K USDC, dumping on Curve. USR crashed ~70% (lows near $0.02),
      // recovered only to ~$0.80; ~$25M extracted, protocol paused.
      ts: Date.UTC(2026, 2, 22),
      kind: "depeg",
      label: "Resolv signing-key exploit — 80M unbacked USR minted, ~70% crash",
      severity: "high",
      href: "https://resolv.xyz/blog/resolv-postmortem-march-22-2026-incident",
    },
  ],
  "zeusd-zoth": [
    {
      // 2025-03-01 — Zoth collateral-accounting bug enabled unbacked ZeUSD.
      ts: Date.UTC(2025, 2, 1),
      kind: "exploit",
      label: "Zoth exploit — $285K unbacked ZeUSD mint",
      severity: "high",
      href: "https://blog.verichains.io/p/anatomy-of-a-hack-how-a-simple-logic",
    },
    {
      // 2025-03-21 — Compromised admin key enabled a malicious Zoth upgrade.
      ts: Date.UTC(2025, 2, 21),
      kind: "exploit",
      label: "Zoth key exploit — ~$8.4M USD0++ drained",
      severity: "high",
      href: "https://www.halborn.com/blog/post/explained-the-zoth-hack-march-2025",
    },
  ],
};

const EMPTY: readonly ChartAnnotation[] = [];

export function getCuratedAnnotations(stablecoinId: string): readonly ChartAnnotation[] {
  if (!Object.prototype.hasOwnProperty.call(CURATED_ANNOTATIONS, stablecoinId)) {
    return EMPTY;
  }

  return CURATED_ANNOTATIONS[stablecoinId] ?? EMPTY;
}

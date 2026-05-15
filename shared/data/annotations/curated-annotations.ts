import type { ChartAnnotation } from "@shared/types/chart-annotation";

/**
 * Editorially curated chart annotations for historical events that are NOT
 * automatically surfaced by the tape (regulatory bans, market-wide shocks,
 * coin launches, methodology pivots, etc.).
 *
 * Keyed by stablecoin id — must match the filename in
 * `shared/data/stablecoins/coins/<id>.json`.
 *
 * Curation rules:
 *   - One annotation per discrete event (don't collapse multi-day depegs).
 *   - Prefer the price-bottom / supply-pivot timestamp, not the press cycle.
 *   - Severity matches the tape vocabulary: `high` for grade-impacting events,
 *     `med` for non-fatal stress, `low` for context.
 *   - `href` should resolve to a primary source (issuer post-mortem, regulator
 *     filing, methodology changelog) rather than secondary press.
 *   - Keep the labels ≤80 chars; the SR-only legend lists them verbatim.
 *
 * Coverage policy: top-50 coins by market-cap target ≥1 annotation each where
 * a meaningful historical event exists. Coins without notable events stay
 * uncurated (empty / absent key is the correct state).
 */
export const CURATED_ANNOTATIONS: Record<string, readonly ChartAnnotation[]> = {
  "usdc-circle": [
    {
      ts: Date.UTC(2023, 2, 10), // 2023-03-10 — SVB closed by California DFPI / FDIC receivership
      kind: "regulatory",
      label: "Silicon Valley Bank closed by regulators",
      severity: "high",
    },
    {
      ts: Date.UTC(2023, 2, 11), // 2023-03-11 — USDC price-bottom ~$0.87 after SVB exposure disclosed
      kind: "depeg",
      label: "SVB collapse — USDC depeg low ~$0.87",
      severity: "high",
      href: "https://www.circle.com/blog/an-update-on-usdc-and-silicon-valley-bank",
    },
    {
      ts: Date.UTC(2023, 2, 13), // 2023-03-13 — Joint Treasury/Fed/FDIC depositor backstop; USDC repegs
      kind: "regulatory",
      label: "Federal depositor backstop announced — USDC repegs",
      severity: "med",
    },
  ],
  "usdt-tether": [
    {
      ts: Date.UTC(2018, 9, 15), // 2018-10-15 — USDT to ~$0.85 amid Bitfinex banking concerns (Noble Bank)
      kind: "depeg",
      label: "Bitfinex banking stress — USDT depeg low ~$0.85",
      severity: "high",
    },
    {
      ts: Date.UTC(2019, 3, 25), // 2019-04-25 — NY AG announces court order against Bitfinex/Tether (iFinex)
      kind: "regulatory",
      label: "NY AG court order vs. Bitfinex/Tether (commingling)",
      severity: "med",
    },
    {
      ts: Date.UTC(2021, 1, 23), // 2021-02-23 — NY AG settlement with Bitfinex/Tether ($18.5M)
      kind: "regulatory",
      label: "NY AG settlement with Bitfinex/Tether ($18.5M)",
      severity: "med",
    },
    {
      ts: Date.UTC(2021, 9, 15), // 2021-10-15 — CFTC order against Tether ($41M penalty)
      kind: "regulatory",
      label: "CFTC settlement order vs. Tether ($41M penalty)",
      severity: "med",
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
      kind: "methodology-change",
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
      kind: "methodology-change",
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
      kind: "governance",
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
  "mnee-mnee": [
    {
      ts: Date.UTC(2024, 6, 18), // 2024-07-18 — MNEE launches USD-backed stablecoin on Ethereum ERC-20
      kind: "governance",
      label: "MNEE launch — Antigua FSRC-licensed USD stablecoin",
      severity: "med",
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
};

const EMPTY: readonly ChartAnnotation[] = [];

export function getCuratedAnnotations(stablecoinId: string): readonly ChartAnnotation[] {
  return CURATED_ANNOTATIONS[stablecoinId] ?? EMPTY;
}

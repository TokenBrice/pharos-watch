import type { StablecoinMeta } from "../../types";
import { other } from "./factory";

/** Gold, silver, and commodity-backed tokens. */
export const COMMODITY_COINS: StablecoinMeta[] = [

  // ── Gold-Pegged (not in DefiLlama stablecoins API — data via DefiLlama coins/protocol APIs) ──
  // commodityOunces: troy ounces per token (used for peg deviation normalization)
  other("xaut-tether", "Tether Gold", "XAUT", "rwa-backed", "centralized", "GOLD", {
    detailProvider: "commodity",
    rwa: true, commodityOunces: 1, geckoId: "tether-gold", pythFeedId: "0x44465e17d2e9d390e70c999d5a11fda4f092847fcd2e3e5aa089d96c98a30e67", protocolSlug: "tether-gold",
    collateral: "LBMA Good Delivery gold bars held in Swiss vaults by an undisclosed Swiss custodian; each token represents one fine troy ounce",
    pegMechanism: "Direct 1:1 redemption for physical gold through TG Commodities, S.A. de C.V.; minimum 430 XAUt for a full bar; physical delivery to Switzerland only. Supply figures include XAUt0 (omnichain variant via LayerZero lock-and-mint) deployed on TON, Solana, Arbitrum, and other chains",
    proofOfReserves: { type: "independent-audit", url: "https://gold.tether.to/reports", provider: "BDO Italia" },
    links: [
      { label: "Website", url: "https://gold.tether.to/" },
      { label: "Docs", url: "https://gold.tether.to/faq" },
      { label: "Twitter", url: "https://x.com/tethergold" },
      { label: "XAUt0", url: "https://usdt0.to/" },
    ],
    jurisdiction: { country: "El Salvador", regulator: "CNAD", license: "Stablecoin Issuer & DASP" },
    contracts: [
      { chain: "ethereum", address: "0x68749665ff8d2d112fa859aa293f07a622782f38", decimals: 6 },
    ],
    reserves: [
      { name: "Physical gold bars (LBMA Good Delivery, Swiss vaults)", pct: 100, risk: "very-low" },
    ],
  }),
  other("paxg-paxos", "PAX Gold", "PAXG", "rwa-backed", "centralized", "GOLD", {
    detailProvider: "commodity",
    rwa: true, commodityOunces: 1, geckoId: "pax-gold", pythFeedId: "0x273717b49430906f4b0c230e99aa1007f83758e3199edbc887c0d06c3e332494", protocolSlug: "paxos-gold",
    collateral: "LBMA Good Delivery physical gold bars allocated in Brink's London vaults; each token represents one fine troy ounce; insured against theft and loss; bankruptcy-remote custody under Paxos Trust Company",
    pegMechanism: "Direct 1:1 redemption through Paxos Trust Company for physical gold bars or cash equivalent; monthly independent attestation by KPMG LLP under AICPA standards confirms full backing",
    proofOfReserves: { type: "independent-audit", url: "https://www.paxos.com/paxg-transparency", provider: "KPMG" },
    links: [
      { label: "Website", url: "https://www.paxos.com/pax-gold" },
      { label: "Docs", url: "https://docs.paxos.com/guides/dashboard/paxg" },
      { label: "GitHub", url: "https://github.com/paxosglobal/paxos-gold-contract" },
      { label: "Twitter", url: "https://x.com/paxos" },
    ],
    jurisdiction: { country: "United States", regulator: "OCC", license: "National Trust Charter" },
    contracts: [
      { chain: "ethereum", address: "0x45804880de22913dafe09f4980848ece6ecbaf78", decimals: 18 },
    ],
    liveReservesConfig: {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      breakerScope: "paxg-paxos",
      display: { url: "https://www.paxos.com/paxg-transparency", label: "Paxos Transparency" },
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        label: "Physical gold bars (LBMA Good Delivery, Brink's London vaults)",
        risk: "very-low",
      },
    },
    reserves: [
      { name: "Physical gold bars (LBMA Good Delivery, Brink's London vaults)", pct: 100, risk: "very-low" },
    ],
  }),
  other("kau-kinesis", "Kinesis Gold", "KAU", "rwa-backed", "centralized", "GOLD", {
    detailProvider: "commodity",
    rwa: true, commodityOunces: 1 / 31.1035, geckoId: "kinesis-gold",
    collateral: "LBMA-approved physical gold bullion (1 KAU = 1 gram, 999.9 fineness), held in fully allocated, insured vaults globally via ABX (Allocated Bullion Exchange)",
    pegMechanism: "Direct redemption for physical gold through Kinesis; yield via transaction fee sharing",
    proofOfReserves: { type: "independent-audit", url: "https://kinesis.money/audits/", provider: "Bureau Veritas (Inspectorate International)" },
    links: [
      { label: "Website", url: "https://kinesis.money/gold/" },
      { label: "Twitter", url: "https://x.com/KinesisMonetary" },
    ],
    jurisdiction: { country: "Cayman Islands", regulator: "CIMA", license: "VASP Registration" },
    reserves: [
      { name: "Physical gold bullion (LBMA-approved, ABX/Brink's/Loomis vaults)", pct: 100, risk: "very-low" },
    ],
  }),
  other("xaum-matrixdock", "Matrixdock Gold", "XAUm", "rwa-backed", "centralized", "GOLD", {
    detailProvider: "commodity",
    rwa: true, commodityOunces: 1, geckoId: "matrixdock-gold",
    collateral: "LBMA-certified 99.99% pure gold bars stored in Brink's and Malca-Amit vaults in Singapore and Hong Kong",
    pegMechanism: "Direct redemption for physical gold through Matrixdock; minimum 32.148 XAUm (1 kg bar) for physical delivery; available to KYC-verified accredited investors in Singapore and Hong Kong",
    proofOfReserves: { type: "independent-audit", url: "https://www.matrixdock.com/blog/announcements/matrixdock-publishes-its-second-independent-audit-report-on-xaum-gold", provider: "Bureau Veritas" },
    links: [
      { label: "Website", url: "https://www.matrixdock.com/xaum" },
      { label: "Docs", url: "https://matrixdock.gitbook.io/matrixdock-docs/english/gold-token-xaum" },
      { label: "Twitter", url: "https://x.com/matrixdock" },
    ],
    jurisdiction: { country: "Singapore" },
    contracts: [
      { chain: "ethereum", address: "0x2103e845c5e135493bb6c2a4f0b8651956ea8682", decimals: 18 },
      { chain: "bsc", address: "0x23ae4fd8e7844cdbc97775496ebd0e8248656028", decimals: 18 },
    ],
    reserves: [
      { name: "Physical gold bars (LBMA-certified 99.99%, Brink's & Malca-Amit, Singapore & Hong Kong)", pct: 100, risk: "very-low" },
    ],
  }),
  // gold-vro (VeraOne VRO) removed — too small, unreliable supply data
  other("cgo-comtech", "Comtech Gold", "CGO", "rwa-backed", "centralized", "GOLD", {
    detailProvider: "commodity",
    rwa: true, commodityOunces: 1 / 31.1035, geckoId: "comtech-gold",
    collateral: "Physical gold (999.9 fineness, 24-carat) stored in insured, segregated vaults with Transguard (Emirates Group) in the UAE; each bar registered on DMCC Tradeflow with unique ID and refiner certificates; 1 CGO = 1 gram of gold",
    pegMechanism: "Direct redemption for physical gold coins via the ComTech Gold app; minimum physical delivery is 10 grams (in 1-gram multiples); gold movements endorsed and approved by DMCC",
    proofOfReserves: { type: "independent-audit", url: "https://comtechgold.com/Routine", provider: "unnamed" },
    links: [
      { label: "Website", url: "https://www.comtechgold.com/" },
      { label: "Twitter", url: "https://x.com/ComTechOfficial" },
    ],
    jurisdiction: { country: "United Arab Emirates", regulator: "DAFZA", license: "DAFZA; endorsed by DMCC" },
    reserves: [
      { name: "Physical gold (24K 999.9, Transguard vaults UAE)", pct: 100, risk: "very-low" },
    ],
  }),
  other("dgld-gold-token-sa", "DGLD Tokenized Gold", "DGLD", "rwa-backed", "centralized", "GOLD", {
    detailProvider: "commodity",
    rwa: true, commodityOunces: 1, geckoId: "gold-token-sa-dgld-tokenized-gold",
    collateral: "LBMA Good Delivery PAMP® gold bars allocated in insured Swiss vaults operated by MKS PAMP SA (1 DGLD = 1 troy ounce)",
    pegMechanism: "Direct 1:1 redemption for physical PAMP® gold through Gold Token SA; minimum 1 gram, no custody or transfer fees",
    proofOfReserves: { type: "real-time", url: "https://explorer.dgld.ch/", provider: "MKS PAMP (bar serial numbers + independent physical audits)" },
    links: [
      { label: "Website", url: "https://dgld.ch/" },
      { label: "Twitter", url: "https://x.com/DGLD_Official" },
    ],
    jurisdiction: { country: "Switzerland", regulator: "VQF (FINMA SRO)" },
    contracts: [
      { chain: "ethereum", address: "0xa9299c296d7830a99414d1e5546f5171fa01e9c8", decimals: 18 },
      { chain: "base", address: "0xd02f50e1017f493ffffa70c8fcf09e349e11d6c9", decimals: 18 },
    ],
    reserves: [
      { name: "Allocated LBMA Good Delivery PAMP gold (Swiss vaults)", pct: 100, risk: "very-low" },
    ],
  }),
  other("pgold-pleasing", "Pleasing Gold", "PGOLD", "rwa-backed", "centralized", "GOLD", {
    detailProvider: "commodity",
    rwa: true, commodityOunces: 1, geckoId: "pleasing-gold", protocolSlug: "pleasing-gold",
    deploymentModel: "native-multichain",
    collateral: "LBMA-standard 99.99% physical gold with 1 PGOLD representing 1 fine troy ounce; issuer materials describe fully gold-backed reserves and physical redemption support",
    pegMechanism: "Issuer-managed gold-backed token with off-chain custody and redemption workflow; documentation describes physical redemption and delivery through the Pleasing platform subject to KYC and size requirements",
    links: [
      { label: "Website", url: "https://www.pleasinggold.com/" },
      { label: "Docs", url: "https://pleasing.gitbook.io/docs/pleasing-gold-pgold/token-features" },
      { label: "Twitter", url: "https://x.com/PleasingGolden" },
    ],
    contracts: [
      { chain: "arbitrum", address: "0x3e76bb02286bfeaa89dd35f11253f2cbce634f91", decimals: 18 },
      { chain: "apechain", address: "0x64ae250e044688ddd04262f17daca23c28d241c2", decimals: 18 },
    ],
    reserves: [
      { name: "Physical gold bullion (LBMA-standard, 99.99% purity)", pct: 100, risk: "very-low" },
    ],
  }),
  other("ggbr-goldfish-gold", "Goldfish Gold", "GGBR", "rwa-backed", "centralized", "GOLD", {
    detailProvider: "commodity",
    rwa: true, commodityOunces: 0.001, geckoId: "goldfish-gold",
    collateral: "Issuer materials and CoinGecko describe GGBR as 1/1000th of a troy ounce of gold per token, backed through issuer-managed gold exposure on the balance sheet of I-On Digital",
    pegMechanism: "Issuer-managed gold reference rather than on-chain redemption logic; GGBR is marketed as tracking fractional tokenized gold exposure off-chain",
    links: [
      { label: "Website", url: "https://goldfishgold.com/" },
      { label: "Twitter", url: "https://x.com/goldfishggbr" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x7e2ac793f3e692f388e66c7dc28f739d13b0b71a", decimals: 18 },
    ],
    reserves: [
      { name: "Issuer-managed gold backing / balance-sheet gold exposure", pct: 100, risk: "high" },
    ],
  }),

  // ── Silver-Pegged (data via DefiLlama coins API) ──────────────────────
  other("kag-kinesis", "Kinesis Silver", "KAG", "rwa-backed", "centralized", "SILVER", {
    detailProvider: "commodity",
    rwa: true, commodityOunces: 1, geckoId: "kinesis-silver", // 1 troy ounce per token
    collateral: "Investment-grade physical silver bullion (1 KAG = 1 troy ounce)",
    pegMechanism: "Direct redemption for physical silver through Kinesis; yield via transaction fee sharing",
    proofOfReserves: { type: "independent-audit", url: "https://kinesis.money/trust-security/", provider: "Bureau Veritas (Inspectorate International)" },
    links: [
      { label: "Website", url: "https://kinesis.money/silver/" },
      { label: "Docs", url: "https://kinesis.money/trust-security/" },
      { label: "Twitter", url: "https://x.com/KinesisMonetary" },
    ],
    jurisdiction: { country: "Cayman Islands", regulator: "CIMA", license: "VASP License (conditional)" },
    contracts: [
      { chain: "ethereum", address: "0xf94d9b6dc4eacd89fe3235d9a3c2465fea405157", decimals: 9 },
    ],
    reserves: [
      { name: "Physical silver bullion (999 fine, ABX global vaults)", pct: 100, risk: "very-low" },
    ],
  }),

  // ── Pre-Launch ──────────────────────────────────────────────────────
  other("pgold-polaris", "Polaris Gold", "pGOLD", "crypto-backed", "decentralized", "GOLD", {
    status: "pre-launch",
    announcedDate: "2026-01",
    expectedLaunchDate: "2026-Q4",
    launchPhase: "testnet",
    launchPhaseDetail: "Private testnet live (shared infrastructure with pUSD)",
    links: [
      { label: "Website", url: "https://polarisfinance.io" },
      { label: "Twitter", url: "https://x.com/polarisfinance_" },
    ],
    featuredContent: [
      {
        type: "blog",
        url: "https://polarisfinance.io/blog/pGOLD-finishing-what-digixdao-started/",
        title: "pGOLD: Finishing what DigixDAO started",
        description: "A decentralized alternative to centralized gold stablecoins, offering trustless gold exposure backed by pETH collateral via CDP infrastructure.",
        image: "/featured/polaris-pgold-cover.png",
        source: "Polaris Finance Blog",
      },
      {
        type: "blog",
        url: "https://polarisfinance.io/blog/polaris-mints-anything/",
        title: "CDPs Mint Dollars. Polaris Mints Anything",
        description: "Polaris advances the CDP model with pETH collateral, autonomous interest rate mechanisms, and a multi-stablecoin factory framework.",
        image: "/featured/polaris-mints-anything.png",
        source: "Polaris Finance Blog",
      },
    ],
  }),
];

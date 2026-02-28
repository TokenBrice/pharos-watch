import type { StablecoinMeta } from "./types";

// Helper to reduce boilerplate
interface StablecoinOpts {
  yieldBearing?: boolean;
  rwa?: boolean;
  navToken?: boolean;
  collateral?: string;
  pegMechanism?: string;
  commodityOunces?: number;
  geckoId?: string;
  cmcSlug?: string;
  protocolSlug?: string;
  proofOfReserves?: import("./types").ProofOfReserves;
  links?: import("./types").StablecoinLink[];
  jurisdiction?: import("./types").Jurisdiction;
  contracts?: import("./types").ContractDeployment[];
  supplyMethod?: import("./types").SupplyMethodConfig;
  dependencies?: import("./types").DependencyWeight[];
  canBeBlacklisted?: boolean | "possible";
  chainTier?: import("./types").ChainTier;
  deploymentModel?: import("./types").DeploymentModel;
  collateralQuality?: import("./types").CollateralQuality;
  custodyModel?: import("./types").CustodyModel;
  governanceQuality?: import("./types").GovernanceQuality;
  reserves?: import("./types").ReserveSlice[];
  notices?: import("./types").CoinNotice[];
  tags?: string[];
}

function coin(id: string, name: string, symbol: string, backing: StablecoinMeta["flags"]["backing"], governance: StablecoinMeta["flags"]["governance"], pegCurrency: StablecoinMeta["flags"]["pegCurrency"], opts?: StablecoinOpts): StablecoinMeta {
  return { id, name, symbol, flags: { backing, pegCurrency, governance, yieldBearing: opts?.yieldBearing ?? false, rwa: opts?.rwa ?? false, navToken: opts?.navToken ?? false }, collateral: opts?.collateral, pegMechanism: opts?.pegMechanism, commodityOunces: opts?.commodityOunces, geckoId: opts?.geckoId, cmcSlug: opts?.cmcSlug, protocolSlug: opts?.protocolSlug, proofOfReserves: opts?.proofOfReserves, links: opts?.links, jurisdiction: opts?.jurisdiction, contracts: opts?.contracts, supplyMethod: opts?.supplyMethod, dependencies: opts?.dependencies, canBeBlacklisted: opts?.canBeBlacklisted, chainTier: opts?.chainTier, deploymentModel: opts?.deploymentModel, collateralQuality: opts?.collateralQuality, custodyModel: opts?.custodyModel, governanceQuality: opts?.governanceQuality, reserves: opts?.reserves, notices: opts?.notices, tags: opts?.tags };
}
const usd   = (id: string, name: string, symbol: string, backing: StablecoinMeta["flags"]["backing"], governance: StablecoinMeta["flags"]["governance"], opts?: StablecoinOpts) => coin(id, name, symbol, backing, governance, "USD", opts);
const eur   = (id: string, name: string, symbol: string, backing: StablecoinMeta["flags"]["backing"], governance: StablecoinMeta["flags"]["governance"], opts?: StablecoinOpts) => coin(id, name, symbol, backing, governance, "EUR", opts);
const other = (id: string, name: string, symbol: string, backing: StablecoinMeta["flags"]["backing"], governance: StablecoinMeta["flags"]["governance"], pegCurrency: StablecoinMeta["flags"]["pegCurrency"], opts?: StablecoinOpts) => coin(id, name, symbol, backing, governance, pegCurrency, opts);

/**
 * Tracked stablecoins by market cap (DefiLlama + CoinGecko).
 * IDs are DefiLlama numeric IDs (string).
 *
 * Classification flags:
 *   backing:      rwa-backed | crypto-backed | algorithmic
 *   pegCurrency:  USD | EUR | GBP | CHF | BRL | RUB | JPY | IDR | SGD | TRY | AUD | ZAR | CAD | CNY | PHP | MXN | UAH | ARS | GOLD | SILVER | VAR | OTHER
 *   governance:   centralized | centralized-dependent | decentralized
 *   yieldBearing: token itself accrues yield
 *   rwa:          backed by real-world assets (treasuries, bonds, etc.)
 */
export const TRACKED_STABLECOINS: StablecoinMeta[] = [
  // ── Rank 1-10 ────────────────────────────────────────────────────────
  usd("1", "Tether", "USDT", "rwa-backed", "centralized", {
    geckoId: "tether",
    deploymentModel: "native-multichain",
    collateral: "U.S. Treasury bills and repurchase agreements (~92%), secured loans, gold, Bitcoin, and other investments; quarterly attestations by BDO Italia",
    pegMechanism: "Direct 1:1 redemption through Tether. Supply figures include USDT0 (omnichain variant via LayerZero lock-and-mint) deployed on 20+ additional chains",
    proofOfReserves: { type: "independent-audit", url: "https://tether.to/en/transparency", provider: "BDO Italia" },
    links: [
      { label: "Website", url: "https://tether.to/" },
      { label: "Twitter", url: "https://x.com/Tether_to" },
      { label: "Transparency", url: "https://tether.to/en/transparency" },
      { label: "USDT0", url: "https://usdt0.to/" },
    ],
    jurisdiction: { country: "El Salvador", regulator: "CNAD", license: "Digital Asset Issuance / DASP" },
    contracts: [
      { chain: "ethereum", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
      { chain: "tron", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 },
      { chain: "arbitrum", address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6 },
      { chain: "optimism", address: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", decimals: 6 },
      { chain: "polygon", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
      { chain: "avalanche", address: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", decimals: 6 },
      { chain: "bsc", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18 },
      { chain: "celo", address: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", decimals: 6 },
      { chain: "solana", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
      { chain: "ton", address: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", decimals: 6 },
      { chain: "near", address: "usdt.tether-token.near", decimals: 6 },
      { chain: "aptos", address: "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b", decimals: 6 },
      { chain: "klaytn", address: "0xd077a400968890eacc75cdc901f0356c943e4fdb", decimals: 6 },
      { chain: "kava", address: "0x919c1c267bc06a7039e03fcc2ef738525769109c", decimals: 6 },
    ],
    supplyMethod: {
      type: "totalSupply-minus-addresses",
      subtractAddresses: [
        { chain: "ethereum", address: "0x5754284f345afc66a98fbB0a0Afe71e0f007b949" }, // Tether Treasury
      ],
    },
    reserves: [
      { name: "U.S. Treasury Bills", pct: 80, risk: "very-low" },
      { name: "Reverse Repos", pct: 12, risk: "very-low" },
      { name: "Secured Loans", pct: 4, risk: "medium" },
      { name: "Gold & Bitcoin", pct: 3, risk: "high" },
      { name: "Other Investments", pct: 1, risk: "medium" },
    ],
  }),
  usd("2", "USD Coin", "USDC", "rwa-backed", "centralized", {
    geckoId: "usd-coin",
    deploymentModel: "native-multichain",
    collateral: "Cash and cash equivalents held in the Circle Reserve Fund (SEC-registered 2a-7 government money market fund), managed by BlackRock and custodied at BNY Mellon; assets include short-dated U.S. Treasuries, overnight Treasury repos, and cash",
    pegMechanism: "Direct 1:1 redemption through Circle",
    proofOfReserves: { type: "independent-audit", url: "https://www.circle.com/transparency", provider: "Deloitte" },
    links: [
      { label: "Website", url: "https://www.circle.com/usdc" },
      { label: "Twitter", url: "https://x.com/circle" },
      { label: "Docs", url: "https://developers.circle.com/stablecoins/what-is-usdc" },
    ],
    jurisdiction: { country: "United States", regulator: "NYDFS / 50-state MTL", license: "Virtual Currency License (BitLicense)" },
    contracts: [
      { chain: "ethereum", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
      { chain: "arbitrum", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 },
      { chain: "base", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
      { chain: "optimism", address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6 },
      { chain: "polygon", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6 },
      { chain: "avalanche", address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6 },
      { chain: "celo", address: "0xceba9300f2b948710d2653dd7b07f33a8b32118c", decimals: 6 },
      { chain: "gnosis", address: "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83", decimals: 6 },
      { chain: "solana", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
      { chain: "sui", address: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", decimals: 6 },
      { chain: "aptos", address: "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b", decimals: 6 },
      { chain: "tron", address: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8", decimals: 6 },
      { chain: "zksync", address: "0x1d17cbcf0d6d143135ae902365d2e5e2a16538d4", decimals: 6 },
      { chain: "sonic", address: "0x29219dd400f2bf60e5a23d13be72b486d4038894", decimals: 6 },
      { chain: "starknet", address: "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb", decimals: 6 },
      { chain: "near", address: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6 },
      { chain: "algorand", address: "31566704", decimals: 5 },
      { chain: "hedera", address: "0.0.456858", decimals: 6 },
      { chain: "sei", address: "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392", decimals: 6 },
      { chain: "worldchain", address: "0x79a02482a880bce3f13e09da970dc34db4cd24d1", decimals: 6 },
      { chain: "unichain", address: "0x078d782b760474a361dda0af3839290b0ef57ad6", decimals: 6 },
      { chain: "ink", address: "0x2d270e6886d130d724215a266106e6832161eaed", decimals: 6 },
      { chain: "polkadot", address: "1337", decimals: 6 },
      { chain: "xrpl", address: "5553444300000000000000000000000000000000.rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE", decimals: 6 },
      { chain: "moonriver", address: "0xffffffff7d2b0b761af01ca8e25242976ac0ad7d", decimals: 6 },
      { chain: "plume", address: "0x222365ef19f7947e5484218551b56bb3965aa7af", decimals: 6 },
      { chain: "hyperevm", address: "0xb88339cb7199b77e23db6e890353e22632ba630f", decimals: 6 },
      { chain: "monad", address: "0x754704bc059f8c67012fed69bc8a327a5aafb603", decimals: 6 },
      { chain: "xdc", address: "0xfa2958cb79b0491cc627c1557f441ef849ca8eb1", decimals: 6 },
    ],
    supplyMethod: {
      type: "totalSupply-minus-addresses",
      subtractAddresses: [
        { chain: "ethereum", address: "0x55FE002aEFF02F77364de339a1292923A15844B8" }, // Circle Reserve
      ],
    },
    reserves: [
      { name: "U.S. Treasuries", pct: 75, risk: "very-low" },
      { name: "Overnight Repos", pct: 18, risk: "very-low" },
      { name: "Cash Deposits", pct: 7, risk: "very-low" },
    ],
  }),
  usd("146", "Ethena USDe", "USDe", "crypto-backed", "centralized-dependent", {
    yieldBearing: true,
    geckoId: "ethena-usde",
    dependencies: [{ id: "1", weight: 0.15 }, { id: "2", weight: 0.15 }],
    collateral: "ETH (including stETH), BTC, and SOL in delta-neutral positions (spot long + short perpetual futures), plus liquid stablecoins (USDC, USDT, USDtb) as non-hedged backing",
    pegMechanism: "Delta-neutral hedging: spot collateral custodied off-exchange (Copper, Ceffu, Coinbase) with equal short perpetual positions on CEXes (Binance, Bybit, OKX)",
    proofOfReserves: { type: "real-time", url: "https://app.ethena.fi/dashboards/transparency", provider: "Chaos Labs / Chainlink / Harris & Trotter / LlamaRisk" },
    links: [
      { label: "Website", url: "https://ethena.fi/" },
      { label: "Twitter", url: "https://x.com/ethena_labs" },
      { label: "Docs", url: "https://docs.ethena.fi/" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
    contracts: [
      { chain: "ethereum", address: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", decimals: 18 },
      { chain: "arbitrum", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "base", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "optimism", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "bsc", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "polygon", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "avalanche", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "zksync", address: "0x39fe7a0dacce31bd90418e3e659fb0b5f0b3db0d", decimals: 18 },
      { chain: "mantle", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "linea", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "scroll", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "blast", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "mode", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "manta", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "berachain", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "kava", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "hyperevm", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "ton", address: "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f", decimals: 6 },
      { chain: "aptos", address: "0xf37a8864fe737eb8ec2c2931047047cbaed1beed3fb0e5b7c5526dafd3b9c2e9", decimals: 6 },
      { chain: "solana", address: "DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT", decimals: 9 },
      { chain: "plasma", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "zircuit", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "metis", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "morph-l2", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "swellchain", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "xlayer", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
      { chain: "fraxtal", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
    ],
    deploymentModel: "third-party-bridge",
    collateralQuality: "exotic",
    custodyModel: "cex",
    reserves: [
      { name: "ETH / stETH", pct: 45, risk: "low" },
      { name: "BTC", pct: 25, risk: "very-low" },
      { name: "SOL", pct: 10, risk: "high" },
      { name: "Stablecoins (USDC/USDT)", pct: 20, risk: "low" },
    ],
  }),
  usd("209", "Sky Dollar", "USDS", "crypto-backed", "centralized-dependent", {
    geckoId: "usds",
    governanceQuality: "dao-governance",
    dependencies: [{ id: "2", weight: 0.30, type: "mechanism" }],
    canBeBlacklisted: "possible",
    deploymentModel: "third-party-bridge",
    collateralQuality: "rwa",
    custodyModel: "institutional",
    collateral: "RWA (U.S. Treasuries ~40%), USDC via PSM (~30%), crypto (ETH/wstETH ~20%), other vaults; USDS is the upgraded DAI (1:1 swap), same vault system",
    pegMechanism: "Peg Stability Modules enabling 1:1 swaps with USDC and DAI",
    links: [
      { label: "Website", url: "https://sky.money/" },
      { label: "Twitter", url: "https://x.com/SkyEcosystem" },
      { label: "Docs", url: "https://docs.sky.money/" },
    ],
    jurisdiction: { country: "Cayman Islands" },
    contracts: [
      { chain: "ethereum", address: "0xdc035d45d973e3ec169d2276ddab16f1e407384f", decimals: 18 },
      { chain: "arbitrum", address: "0x6491c05a82219b8d1479057361ff1654749b876b", decimals: 18 },
      { chain: "base", address: "0x820c137fa70c8691f0e44dc420a5e53c168921dc", decimals: 18 },
      { chain: "solana", address: "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", decimals: 6 },
    ],
    reserves: [
      { name: "RWA (U.S. Treasuries)", pct: 40, risk: "low" },
      { name: "USDC via PSM", pct: 30, risk: "low" },
      { name: "ETH / wstETH", pct: 20, risk: "low" },
      { name: "Other Vaults", pct: 10, risk: "high" },
    ],
  }),
  usd("262", "World Liberty Financial USD", "USD1", "rwa-backed", "centralized", {
    geckoId: "usd1-wlfi",
    deploymentModel: "third-party-bridge",
    collateral: "Short-term U.S. government Treasury bills, U.S. dollar deposits, and other cash equivalents held by BitGo Trust Company",
    pegMechanism: "Direct 1:1 mint and redemption through BitGo Trust Company (issuer); arbitrage incentivizes peg maintenance",
    proofOfReserves: { type: "independent-audit", url: "https://www.bitgo.com/usd1/attestations/", provider: "BitGo" },
    links: [
      { label: "Website", url: "https://worldlibertyfinancial.com/usd1" },
      { label: "Twitter", url: "https://x.com/worldlibertyfi" },
    ],
    jurisdiction: { country: "United States", regulator: "South Dakota Division of Banking", license: "South Dakota Trust Charter" },
    contracts: [
      { chain: "ethereum", address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", decimals: 18 },
      { chain: "bsc", address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", decimals: 18 },
      { chain: "tron", address: "TPFqcBAaaUMCSVRCqPaQ9QnzKhmuoLR6Rc", decimals: 18 },
      { chain: "solana", address: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", decimals: 6 },
      { chain: "plume", address: "0x111111d2bf19e43c34263401e0cad979ed1cdb61", decimals: 18 },
      { chain: "monad", address: "0x111111d2bf19e43c34263401e0cad979ed1cdb61", decimals: 6 },
      { chain: "mantle", address: "0x111111d2bf19e43c34263401e0cad979ed1cdb61", decimals: 18 },
      { chain: "aptos", address: "0x05fabd1b12e39967a3c24e91b7b8f67719a6dacee74f3c8b9fb7d93e855437d2", decimals: 6 },
    ],
    reserves: [
      // Source: BitGo monthly attestation reports (AICPA criteria). Exact % not published; estimated from collateral description.
      { name: "U.S. Treasury Bills", pct: 60, risk: "very-low" },
      { name: "U.S. Government Money Market Funds", pct: 25, risk: "very-low" },
      { name: "Cash Deposits", pct: 15, risk: "very-low" },
    ],
  }),
  usd("5", "Dai", "DAI", "crypto-backed", "centralized-dependent", {
    geckoId: "dai",
    governanceQuality: "dao-governance",
    dependencies: [{ id: "2", weight: 0.35, type: "mechanism" }],
    deploymentModel: "canonical-bridge",
    collateralQuality: "rwa",
    custodyModel: "institutional",
    collateral: "Multi-collateral: RWA (U.S. Treasuries via Spark/BlockTower ~40%), USDC via LitePSM (~33%), ETH/wstETH (~20%), WBTC (~5%), other vaults; managed by Sky/MakerDAO governance",
    pegMechanism: "Overcollateralized CDP vaults (auto-liquidated if ratio drops below minimum); LitePSM enabling 1:1 USDC↔DAI swaps; MKR acts as backstop (minted and sold to cover bad debt)",
    links: [
      { label: "Website", url: "https://makerdao.com/" },
      { label: "Twitter", url: "https://x.com/MakerDAO" },
      { label: "Docs", url: "https://docs.makerdao.com/" },
    ],
    jurisdiction: { country: "Denmark" },
    contracts: [
      { chain: "ethereum", address: "0x6b175474e89094c44da98b954eedeac495271d0f", decimals: 18 },
      { chain: "polygon", address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
      { chain: "arbitrum", address: "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", decimals: 18 },
      { chain: "optimism", address: "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", decimals: 18 },
      { chain: "bsc", address: "0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3", decimals: 18 },
      { chain: "avalanche", address: "0xd586e7f844cea2f87f50152665bcbc2c279d8d70", decimals: 18 },
      { chain: "fantom", address: "0x8d11ec38a3eb5e956b052f67da8bdc9bef8abf3e", decimals: 18 },
      { chain: "base", address: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", decimals: 18 },
    ],
    reserves: [
      { name: "RWA (U.S. Treasuries)", pct: 40, risk: "low" },
      { name: "USDC via PSM", pct: 33, risk: "low" },
      { name: "ETH / wstETH", pct: 20, risk: "low" },
      { name: "WBTC", pct: 5, risk: "medium" },
      { name: "Other Vaults", pct: 2, risk: "high" },
    ],
  }),
  usd("120", "PayPal USD", "PYUSD", "rwa-backed", "centralized", {
    geckoId: "paypal-usd",
    deploymentModel: "third-party-bridge",
    collateral: "U.S. dollar deposits, U.S. Treasury securities, and reverse repurchase agreements",
    pegMechanism: "Direct 1:1 redemption through PayPal/Paxos",
    proofOfReserves: { type: "independent-audit", url: "https://www.paxos.com/pyusd-transparency", provider: "KPMG" },
    links: [
      { label: "Website", url: "https://www.paypal.com/us/digital-wallet/manage-money/crypto/pyusd" },
      { label: "Twitter", url: "https://x.com/paypal" },
      { label: "Docs", url: "https://developer.paypal.com/dev-center/pyusd/" },
    ],
    jurisdiction: { country: "United States", regulator: "OCC", license: "National Trust Charter" },
    contracts: [
      { chain: "ethereum", address: "0x6c3ea9036406852006290770bedfcaba0e23a0e8", decimals: 6 },
      { chain: "arbitrum", address: "0x46850ad61c2b7d64d08c9c754f45254596696984", decimals: 6 },
      { chain: "solana", address: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", decimals: 6 },
      { chain: "stellar", address: "PYUSD-GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5", decimals: 7 },
    ],
    supplyMethod: { type: "exclude" }, // Significant Solana supply not coverable on-chain — use DefiLlama
    reserves: [
      // Source: Paxos KPMG Feb 2025 attestation ($744.6M repos, $25.6M cash of $770.1M total)
      { name: "U.S. Treasury Reverse Repos", pct: 97, risk: "very-low" },
      { name: "Cash Deposits", pct: 3, risk: "very-low" },
    ],
  }),
  usd("246", "Falcon USD", "USDf", "crypto-backed", "centralized-dependent", {
    geckoId: "falcon-finance",
    deploymentModel: "third-party-bridge",
    dependencies: [{ id: "1", weight: 0.4 }, { id: "2", weight: 0.4 }],
    collateral: "Overcollateralized: stablecoins (USDC, USDT, USD1, FDUSD) minted 1:1; volatile assets (BTC, ETH, SOL, select altcoins) with dynamic overcollateralization ratios based on volatility and liquidity",
    pegMechanism: "Overcollateralized synthetic dollar; liquidation mechanisms and arbitrage maintain the $1 peg; delta-neutral strategies power sUSDf yield",
    proofOfReserves: { type: "real-time", url: "https://app.falcon.finance/transparency", provider: "ht.digital" },
    links: [
      { label: "Website", url: "https://falcon.finance/" },
      { label: "Twitter", url: "https://x.com/FalconStable" },
      { label: "Docs", url: "https://docs.falcon.finance" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
    contracts: [
      { chain: "ethereum", address: "0xfa2b947eec368f42195f24f36d2af29f7c24cec2", decimals: 18 },
      { chain: "bsc", address: "0xb3b02e4a9fb2bd28cc2ff97b0ab3f6b3ec1ee9d2", decimals: 18 },
      { chain: "base", address: "0x8210c0634ab8f273806e4b7866e9db353773c44b", decimals: 18 },
      { chain: "xdc", address: "0x8210c0634ab8f273806e4b7866e9db353773c44b", decimals: 18 },
    ],
    collateralQuality: "exotic",
    reserves: [
      // Source: Falcon Finance transparency dashboard + DWF Labs research (Sep 2025). Approximate from published $ amounts.
      { name: "BTC (delta-neutral)", pct: 45, risk: "medium" },
      { name: "Stablecoins (USDC/USDT)", pct: 30, risk: "low" },
      { name: "Altcoins (DOGE, FET, TRX, TON)", pct: 15, risk: "high" },
      { name: "ETH (delta-neutral)", pct: 5, risk: "medium" },
      { name: "Tokenized Treasuries (USTB)", pct: 5, risk: "low" },
    ],
  }),
  usd("237", "Hashnote USYC", "USYC", "rwa-backed", "centralized", {
    yieldBearing: true, rwa: true, navToken: true,
    geckoId: "hashnote-usyc",
    deploymentModel: "third-party-bridge",
    collateral: "Short-term U.S. Treasury bills and reverse repo agreements held in segregated prime brokerage accounts",
    pegMechanism: "Same-day subscription and redemption via USDC at NAV-based token price",
    links: [
      { label: "Website", url: "https://usyc.hashnote.com/" },
      { label: "Twitter", url: "https://x.com/Hashnote_Labs" },
      { label: "Docs", url: "https://usyc.docs.hashnote.com/" },
    ],
    jurisdiction: { country: "Bermuda", regulator: "BMA", license: "DABA License" },
    contracts: [
      { chain: "ethereum", address: "0x136471a34f6ef19fe571effc1ca711fdb8e49f2b", decimals: 6 },
      { chain: "bsc", address: "0x8D0fA28f221eB5735BC71d3a0Da67EE5bC821311", decimals: 6 },
    ],
    reserves: [
      // Source: Hashnote/Circle SDYF docs + Nansen analysis. Fund invests exclusively in T-bills and reverse repos.
      { name: "U.S. Treasury Bills", pct: 80, risk: "very-low" },
      { name: "Reverse Repo Agreements", pct: 20, risk: "very-low" },
    ],
  }),
  usd("286", "Global Dollar", "USDG", "rwa-backed", "centralized", {
    geckoId: "global-dollar",
    deploymentModel: "native-multichain",
    collateral: "U.S. dollar deposits, short-duration U.S. government securities, and other high-quality liquid assets held in segregated custodial accounts at DBS Bank and Standard Chartered",
    pegMechanism: "Direct 1:1 redemption for U.S. dollars through Paxos Digital Singapore for KYC-verified users; reserves fully segregated and held at custodian banks; EU issuance by Paxos Issuance Europe OY under MiCA",
    proofOfReserves: { type: "independent-audit", url: "https://www.paxos.com/usdg-transparency", provider: "Enrome LLP" },
    links: [
      { label: "Website", url: "https://globaldollar.com/" },
      { label: "Twitter", url: "https://x.com/global_dollar" },
    ],
    jurisdiction: { country: "Singapore", regulator: "MAS", license: "Major Payment Institution" },
    contracts: [
      { chain: "ethereum", address: "0xe343167631d89b6ffc58b88d6b7fb0228795491d", decimals: 6 },
      { chain: "solana", address: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", decimals: 6 },
      { chain: "ink", address: "0xe343167631d89b6ffc58b88d6b7fb0228795491d", decimals: 6 },
      { chain: "xlayer", address: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", decimals: 6 },
    ],
    reserves: [
      // Source: Paxos/Enrome LLP monthly attestation (ISCA standards). Exact % not published; estimated from collateral description.
      { name: "U.S. Government Securities", pct: 50, risk: "very-low" },
      { name: "Cash Deposits (DBS/StanChart)", pct: 35, risk: "very-low" },
      { name: "Cash Equivalents", pct: 15, risk: "very-low" },
    ],
  }),

  // ── Rank 11-20 ───────────────────────────────────────────────────────
  usd("250", "Ripple USD", "RLUSD", "rwa-backed", "centralized", {
    geckoId: "ripple-usd",
    collateral: "U.S. dollar deposits, cash equivalents, and short-term U.S. government Treasuries held in segregated accounts",
    pegMechanism: "Direct 1:1 redemption through Ripple",
    proofOfReserves: { type: "independent-audit", url: "https://ripple.com/solutions/stablecoin/transparency/", provider: "BPM LLP" },
    links: [
      { label: "Website", url: "https://ripple.com/solutions/stablecoin/" },
      { label: "Twitter", url: "https://x.com/Ripple" },
    ],
    jurisdiction: { country: "United States", regulator: "NYDFS", license: "Trust Charter" },
    contracts: [
      { chain: "ethereum", address: "0x8292bb45bf1ee4d140127049757c2e0ff06317ed", decimals: 18 },
    ],
    reserves: [
      // Source: BPM LLP / Deloitte attestation (Dec 2024 breakdown: ~36% T-bills, ~36% MMF, ~28% cash). NYDFS-regulated.
      { name: "U.S. Treasury Bills", pct: 36, risk: "very-low" },
      { name: "Government Money Market Funds", pct: 36, risk: "very-low" },
      { name: "Cash Deposits", pct: 28, risk: "very-low" },
    ],
  }),
  usd("129", "Ondo US Dollar Yield", "USDY", "rwa-backed", "centralized", {
    geckoId: "ondo-us-dollar-yield",
    deploymentModel: "third-party-bridge",
    yieldBearing: true, rwa: true, navToken: true,
    collateral: "Short-term U.S. Treasuries, iShares Short Treasury Bond ETF shares, and bank demand deposits",
    pegMechanism: "Bank wire redemption at NAV-based price with independent verification and collateral agent oversight",
    proofOfReserves: { type: "real-time", url: "https://ondo.finance/usdy", provider: "Ankura Trust" },
    links: [
      { label: "Website", url: "https://ondo.finance/usdy" },
      { label: "Twitter", url: "https://x.com/OndoFinance" },
      { label: "Docs", url: "https://docs.ondo.finance/" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
    contracts: [
      { chain: "ethereum", address: "0x96f6ef951840721adbf46ac996b59e0235cb985c", decimals: 18 },
      { chain: "arbitrum", address: "0x35e050d3c0ec2d29d269a8ecea763a183bdf9a9d", decimals: 18 },
      { chain: "mantle", address: "0x5be26527e817998a7206475496fde1e68957c5a6", decimals: 18 },
      { chain: "plume", address: "0xd2b65e851be3d80d3c2ce795eb2e78f16cb088b2", decimals: 18 },
      { chain: "sei", address: "0x54cd901491aef397084453f4372b93c33260e2a6", decimals: 18 },
      { chain: "sui", address: "0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY", decimals: 6 },
      { chain: "solana", address: "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6", decimals: 6 },
      { chain: "aptos", address: "0xcfea864b32833f157f042618bd845145256b1bf4c0da34a7013b76e42daa53cc", decimals: 6 },
      { chain: "stellar", address: "USDY-GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6", decimals: 7 },
      { chain: "noble", address: "ausdy", decimals: 18 },
      { chain: "osmosis", address: "ibc/23104D411A6EB6031FA92FB75F227422B84989969E91DCAD56A535DD7FF0A373", decimals: 18 },
      { chain: "mantra", address: "ibc/6749D16BC09F419C090C330FC751FFF1C96143DB7A4D2FCAEC2F348A3E17618A", decimals: 6 },
    ],
    reserves: [
      // Source: Ondo Finance docs + Ankura Trust daily reports. Ondo targets 99%+ Treasuries; 104% overcollateralized.
      { name: "Short-Term U.S. Treasuries", pct: 80, risk: "very-low" },
      { name: "iShares Short Treasury Bond ETF", pct: 15, risk: "very-low" },
      { name: "Bank Demand Deposits", pct: 5, risk: "very-low" },
    ],
  }),
  usd("173", "BlackRock USD", "BUIDL", "rwa-backed", "centralized", {
    yieldBearing: true, rwa: true,
    geckoId: "blackrock-usd-institutional-digital-liquidity-fund",
    deploymentModel: "third-party-bridge",
    collateral: "Cash, U.S. Treasury bills, and repurchase agreements held by Bank of New York Mellon as custodian; tokenized and administered by Securitize",
    pegMechanism: "NAV-based pricing with institutional redemption through BlackRock/Securitize",
    links: [
      { label: "Website", url: "https://securitize.io/blackrock/buidl" },
      { label: "Twitter", url: "https://x.com/BlackRock" },
    ],
    jurisdiction: { country: "British Virgin Islands", regulator: "SEC (Reg D)", license: "Regulation D Exemption" },
    proofOfReserves: { type: "self-reported", url: "https://securitize.io/blackrock/buidl", provider: "Bank of New York Mellon" },
    contracts: [
      { chain: "ethereum",  address: "0x7712c34205737192402172409a8f7ccef8aa2aec", decimals: 6 },
      { chain: "bsc",       address: "0x2d5bdc96d9c8aabbdb38c9a27398513e7e5ef84f", decimals: 6 },
      { chain: "optimism",  address: "0xa1cdab15bba75a80df4089cafba013e376957cf5", decimals: 6 },
      { chain: "arbitrum",  address: "0xa6525ae43edcd03dc08e775774dcabd3bb925872", decimals: 6 },
      { chain: "avalanche", address: "0x53fc82f14f009009b440a706e31c9021e1196a2f", decimals: 6 },
      { chain: "polygon",   address: "0x2893ef551b6dd69f661ac00f11d93e5dc5dc0e99", decimals: 6 },
      { chain: "solana", address: "GyWgeqpy5GueU2YbkE8xqUeVEokCMMCEeUrfbtMw6phr", decimals: 6 },
      { chain: "aptos", address: "0x50038be55be5b964cfa32cf128b5cf05f123959f286b4cc02b86cafd48945f89", decimals: 6 },
    ],
    reserves: [
      // Source: BlackRock/Securitize prospectus. 100% in cash, T-bills, and repos. Exact % not disclosed; estimated for money market fund.
      { name: "U.S. Treasury Bills", pct: 60, risk: "very-low" },
      { name: "Overnight Repos", pct: 30, risk: "very-low" },
      { name: "Cash", pct: 10, risk: "very-low" },
    ],
  }),
  usd("14", "USDD", "USDD", "crypto-backed", "centralized-dependent", {
    geckoId: "usdd",
    deploymentModel: "native-multichain",
    dependencies: [{ id: "1", weight: 0.3 }, { id: "2", weight: 0.1 }],
    collateral: "Over-collateralized by TRX, sTRX, and USDT locked in CDP vaults; Bitcoin removed from reserves in August 2024",
    pegMechanism: "CDP model with minimum 130% collateral ratio; Peg Stability Module enables 1:1 minting/redemption against USDT and USDC",
    proofOfReserves: { type: "self-reported", url: "https://usdd.io/" },
    links: [
      { label: "Website", url: "https://usdd.io/" },
      { label: "Docs", url: "https://docs.usdd.io" },
      { label: "Twitter", url: "https://x.com/usddio" },
    ],
    jurisdiction: { country: "Dominica" },
    contracts: [
      { chain: "tron", address: "TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz", decimals: 18 },
      { chain: "ethereum", address: "0x4f8e5de400de08b164e7421b3ee387f461becd1a", decimals: 18 },
      { chain: "bsc", address: "0x45e51bc23d592eb2dba86da3985299f7895d66ba", decimals: 18 },
      { chain: "near", address: "0c10bf8fcb7bf5412187a595ab97a3609160b5c6.factory.bridge.near", decimals: 18 },
      { chain: "avalanche", address: "0xb514cabd09ef5b169ed3fe0fa8dbd590741e81c2", decimals: 18 },
      { chain: "arbitrum", address: "0x680447595e8b7b3aa1b43beb9f6098c79ac2ab3f", decimals: 18 },
      { chain: "bittorrent", address: "0x392004bee213f1ff580c867359c246924f21e6ad", decimals: 18 },
    ],
    chainTier: "established-alt-l1",
    collateralQuality: "alt-lst-bridged-or-mixed",
    reserves: [
      // Source: Messari Jan 2026, Stablewatch late 2025. Confidence: Medium
      { name: "Smart Allocator (stablecoin DeFi via Aave/JustLend)", pct: 75, risk: "medium" },
      { name: "USDT (PSM vaults)", pct: 16, risk: "low" },
      { name: "TRX", pct: 7, risk: "high" },
      { name: "sTRX / USDT (direct vaults)", pct: 2, risk: "high" },
    ],
  }),
  usd("221", "Ethena USDtb", "USDTB", "rwa-backed", "centralized", {
    rwa: true,
    geckoId: "usdtb",
    deploymentModel: "third-party-bridge",
    collateral: "~90% BlackRock USD Institutional Digital Liquidity Fund (BUIDL), investing in cash, U.S. Treasury Bills/Notes, and repurchase agreements; remainder in USDC stablecoin reserve for rapid redemptions; issued by Anchorage Digital Bank N.A.; U.S. Bank acts as reserve custodian",
    pegMechanism: "Direct 1:1 mint and redemption; BUIDL shares redeemable 24/7 via atomic swap with Securitize; LayerZero OFT cross-chain transfers",
    proofOfReserves: { type: "independent-audit", url: "https://www.anchorage.com/platform/usdtb-reserve-attestations", provider: "Big Four accounting firm via Anchorage Digital Bank" },
    links: [
      { label: "Website", url: "https://usdtb.money/" },
      { label: "Twitter", url: "https://x.com/ethena_labs" },
      { label: "Docs", url: "https://docs.usdtb.money/" },
    ],
    jurisdiction: { country: "United States", regulator: "OCC", license: "Federal Bank Charter" },
    contracts: [
      { chain: "ethereum", address: "0xc139190f447e929f090edeb554d95abb8b18ac1c", decimals: 18 },
      { chain: "arbitrum", address: "0xc708b6887db46005da033501f8aebee72d191a5d", decimals: 18 },
      { chain: "base",     address: "0xc708b6887db46005da033501f8aebee72d191a5d", decimals: 18 },
    ],
    reserves: [
      // Source: Ethena docs, The Block, CoinDesk Mar 2025. Confidence: High
      { name: "BlackRock BUIDL (U.S. T-Bills, cash, repos)", pct: 90, risk: "low", coinId: "173" },
      { name: "USDC (redemption reserve)", pct: 10, risk: "low", coinId: "2" },
    ],
  }),
  usd("213", "M by M0", "M", "rwa-backed", "centralized", {
    rwa: true,
    geckoId: "m",
    deploymentModel: "third-party-bridge",
    dependencies: [],
    collateral: "Short-term U.S. Treasury bills (30–90 day) held in bankruptcy-remote SPVs by permissioned Minters; Validators independently attest collateral sufficiency on-chain before minting",
    pegMechanism: "Permissioned Minters lock eligible T-bill collateral in bankruptcy-remote SPVs; Validators cryptographically attest off-chain collateral sufficiency, enabling on-chain minting of M 1:1 against attested reserves; POWER token holders govern eligible collateral and Minter/Validator permissions",
    proofOfReserves: { type: "self-reported", url: "https://dashboard.m0.org/", provider: "M0 Protocol (on-chain Validator attestations)" },
    links: [
      { label: "Website", url: "https://www.m0.org/" },
      { label: "Twitter", url: "https://x.com/m0" },
      { label: "Docs", url: "https://docs.m0.org/" },
      { label: "GitHub", url: "https://github.com/m0-foundation" },
    ],
    jurisdiction: { country: "Switzerland" },
    contracts: [
      { chain: "ethereum", address: "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b", decimals: 6 },
      { chain: "optimism", address: "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b", decimals: 6 },
      { chain: "arbitrum", address: "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b", decimals: 6 },
      { chain: "base", address: "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b", decimals: 6 },
    ],
    reserves: [
      // Source: m0.org FAQ, Chainlink integration Jan 2026. Confidence: High
      { name: "Short-term U.S. Treasury Bills (30-90 day)", pct: 100, risk: "very-low" },
    ],
  }),
  usd("336", "United Stables", "U", "rwa-backed", "centralized", {
    geckoId: "united-stables",
    deploymentModel: "native-multichain",
    collateral: "Fiat USD, USDC, USDT, and USD1 held in segregated custody via Wallets Trust Limited (Bermuda trustee); fiat reserves with accredited banking institutions, digital assets with licensed custodians",
    pegMechanism: "Smart contracts mint U 1:1 only upon receipt of USD or whitelisted stablecoins (USDC, USDT, USD1); redemption burns U and returns USD or stablecoins; on-chain oracles enforce total supply never exceeds collateral",
    links: [
      { label: "Website", url: "https://u.tech/" },
      { label: "Twitter", url: "https://x.com/UTechStables" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
    contracts: [
      { chain: "bsc",      address: "0xce24439f2d9c6a2289f741120fe202248b666666", decimals: 18 },
      { chain: "ethereum", address: "0xce24439f2d9c6a2289f741120fe202248b666666", decimals: 18 },
    ],
    reserves: [
      // Source: GlobeNewsWire Dec 2025 launch announcement. Confidence: Low
      { name: "USDC", pct: 35, risk: "low" },
      { name: "USDT", pct: 35, risk: "low" },
      { name: "USD1 (WLFI stablecoin)", pct: 15, risk: "medium" },
      { name: "Fiat USD / U.S. Treasury Bills", pct: 15, risk: "very-low" },
    ],
  }),
  usd("309", "USD.AI", "USDai", "rwa-backed", "centralized-dependent", {
    geckoId: "usdai",
    deploymentModel: "third-party-bridge",
    dependencies: [{ id: "1", weight: 0.3 }, { id: "2", weight: 0.3 }],
    collateral: "GPU-backed infrastructure loans (NVIDIA hardware tokenized as on-chain warehouse receipts under UCC law via the CALIBER framework); base USDai is backed 1:1 by wM (M0 Protocol T-bills) while sUSDai earns yield from hardware-collateralized credit to AI compute operators",
    pegMechanism: "Minted 1:1 by depositing USDC/USDT converted to wM (M0 T-bill tokens); redeemable 1:1 in fixed 30-day processing windows; sUSDai is an ERC-4626 vault accruing yield from GPU-backed loans; QEV auction mechanism manages redemptions against illiquid collateral",
    jurisdiction: { country: "United States" },
    links: [
      { label: "Website", url: "https://usd.ai/" },
      { label: "Twitter", url: "https://x.com/USDai_Official" },
      { label: "Docs", url: "https://docs.usd.ai" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", decimals: 18 },
      { chain: "arbitrum", address: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", decimals: 18 },
      { chain: "base",     address: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", decimals: 18 },
      { chain: "plasma",   address: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", decimals: 18 },
    ],
    reserves: [
      // Source: USD.AI blog Feb 2026, Stablewatch, CoinDesk Oct 2025. Confidence: Medium
      { name: "wM / U.S. Treasury Bills (via M0 Protocol)", pct: 99, risk: "low" },
      { name: "GPU-collateralized loans (NVIDIA hardware)", pct: 1, risk: "high" },
    ],
  }),
  usd("195", "Usual USD", "USD0", "rwa-backed", "centralized-dependent", {
    rwa: true,
    geckoId: "usual-usd",
    deploymentModel: "third-party-bridge",
    collateral: "Tokenized short-term U.S. Treasury bills and reverse repos, primarily via Hashnote USYC; also M by M0, USDtb by Ethena, OUSG by Ondo, and BUIDL by BlackRock",
    pegMechanism: "1:1 minting by depositing approved RWA tokens (e.g. USYC) directly, or depositing USDC via a gateway; redeemable 1:1 for underlying RWA assets via the DaoCollateral contract at any time; arbitrageurs enforce the peg",
    links: [
      { label: "Website", url: "https://usual.money/" },
      { label: "Twitter", url: "https://x.com/usualmoney" },
      { label: "Docs", url: "https://docs.usual.money/" },
    ],
    jurisdiction: { country: "France" },
    contracts: [
      { chain: "ethereum", address: "0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5", decimals: 18 },
      { chain: "arbitrum", address: "0x35f1c5cb7fb977e669fd244c567da99d8a3a6850", decimals: 18 },
      { chain: "base", address: "0x758a3e0b1f842c9306b783f8a4078c6c8c03a270", decimals: 18 },
      { chain: "bsc", address: "0x758a3e0b1f842c9306b783f8a4078c6c8c03a270", decimals: 18 },
    ],
    reserves: [
      // Source: Usual docs, RWA.xyz, ChainArgos Feb 2026. Confidence: Medium
      { name: "Hashnote USYC (tokenized T-bills/reverse repos)", pct: 65, risk: "low", coinId: "237" },
      { name: "M by M^0 (tokenized T-bills)", pct: 15, risk: "low", coinId: "213" },
      { name: "USDtb by Ethena (BUIDL + USDC)", pct: 10, risk: "low", coinId: "221" },
      { name: "BlackRock BUIDL", pct: 5, risk: "low", coinId: "173" },
      { name: "OUSG by Ondo (tokenized T-bills)", pct: 3, risk: "low" },
      { name: "USDC (Circle)", pct: 2, risk: "low", coinId: "2" },
    ],
  }),
  usd("118", "GHO", "GHO", "crypto-backed", "centralized-dependent", {
    geckoId: "gho",
    deploymentModel: "third-party-bridge",
    governanceQuality: "dao-governance",
    dependencies: [{ id: "1", weight: 0.20 }, { id: "2", weight: 0.20 }],
    collateralQuality: "alt-lst-bridged-or-mixed",
    collateral: "Any Aave V3 Ethereum market collateral asset (ETH, wBTC, USDC, USDT, and others), overcollateralized per Aave's risk parameters",
    pegMechanism: "Overcollateralized minting via Aave V3 facilitator model; GHO Stability Module (GSM) enables 1:1 conversions with USDC and USDT; dynamic borrow rate adjustments by GHO Stewards reinforce the peg",
    links: [
      { label: "Website", url: "https://aave.com/gho" },
      { label: "Twitter", url: "https://x.com/GHOAave" },
      { label: "Docs", url: "https://aave.com/docs/ecosystem/gho" },
      { label: "GitHub", url: "https://github.com/aave/gho-core" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f", decimals: 18 },
      { chain: "arbitrum", address: "0x7dff72693f6a4149b17e7c6314655f6a9f7c8b33", decimals: 18 },
      { chain: "base", address: "0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee", decimals: 18 },
      { chain: "gnosis", address: "0xfc421ad3c883bf9e7c4f42de845c4e4405799e73", decimals: 18 },
      { chain: "ink", address: "0xfc421ad3c883bf9e7c4f42de845c4e4405799e73", decimals: 18 },
      { chain: "avalanche", address: "0xfc421ad3c883bf9e7c4f42de845c4e4405799e73", decimals: 18 },
    ],
    proofOfReserves: { type: "independent-audit", url: "https://github.com/aave/gho-core/tree/main/audits", provider: "OpenZeppelin, ABDK, Sigma Prime, Certora" },
    reserves: [
      // Source: Aave V3 Ethereum market data, Eco.com GHO guide, Chaos Labs risk dashboard
      { name: "wstETH", pct: 34, risk: "low" },
      { name: "sDAI", pct: 18, risk: "low" },
      { name: "WETH", pct: 16, risk: "medium" },
      { name: "WBTC", pct: 14, risk: "medium" },
      { name: "USDC / USDT (GSM)", pct: 13, risk: "low" },
      { name: "Other Aave V3 Collateral", pct: 5, risk: "high" },
    ],
  }),

  // ── Rank 21-30 ───────────────────────────────────────────────────────
  other("258", "A7A5", "A7A5", "rwa-backed", "centralized", "RUB", {
    geckoId: "a7a5",
    collateral: "Russian ruble (RUB) deposits held 1:1 at Promsvyazbank (PSB), a Russian state-owned bank; reserves audited quarterly by an independent Kyrgyz auditing firm",
    pegMechanism: "Fiat-backed 1:1 peg to the Russian ruble; mint via KYC-verified authorized partners depositing RUB; redeem by returning A7A5 for equivalent RUB; issuer (Old Vector LLC) distributes 50% of reserve interest to holders as additional A7A5",
    links: [
      { label: "Website", url: "https://www.a7a5.io/" },
      { label: "Twitter", url: "https://x.com/A7A5official" },
      { label: "Docs", url: "https://docs.a7a5.io" },
    ],
    jurisdiction: { country: "Kyrgyzstan", regulator: "Finnadzor", license: "VASP license (Law on Virtual Assets No. 12, 2022); issuer: Old Vector LLC" },
    contracts: [
      { chain: "ethereum", address: "0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9", decimals: 6 },
      { chain: "tron", address: "TLeVfrdym8RoJreJ23dAGyfJDygRtiWKBZ", decimals: 6 },
    ],
    reserves: [
      // Source: Elliptic blog, Crystal Intelligence 2025-2026. Confidence: Medium
      { name: "Russian ruble deposits at Promsvyazbank (sanctioned)", pct: 100, risk: "very-high" },
    ],
  }),
  usd("7", "TrueUSD", "TUSD", "rwa-backed", "centralized", {
    geckoId: "true-usd",
    deploymentModel: "native-multichain",
    collateral: "U.S. dollars held in segregated accounts at regulated financial institutions, attested daily by Moore Hong Kong",
    pegMechanism: "Direct 1:1 redemption through Techteryx; minting controlled by Chainlink Proof of Reserve feed preventing supply from exceeding attested reserves",
    proofOfReserves: { type: "real-time", url: "https://tusd.io/transparency", provider: "Moore Hong Kong / Chainlink" },
    links: [
      { label: "Website", url: "https://tusd.io/" },
      { label: "Twitter", url: "https://x.com/tusdio" },
    ],
    jurisdiction: { country: "Dominica" },
    contracts: [
      { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
      { chain: "tron", address: "TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4", decimals: 18 },
      { chain: "avalanche", address: "0x1c20e891bab6b1727d14da358fae2984ed9b59eb", decimals: 18 },
      { chain: "polygon", address: "0x2e1ad108ff1d8c782fcbbb89aad783ac49586756", decimals: 18 },
      { chain: "arbitrum", address: "0x4d15a3a2286d883af0aa1b3f21367843fac63e07", decimals: 18 },
      { chain: "optimism", address: "0xcb59a0a753fdb7491d5f3d794316f1ade197b21e", decimals: 18 },
      { chain: "bsc", address: "0x40af3827f39d0eacbf4a168f8d4ee67c121d11c9", decimals: 18 },
    ],
    reserves: [
      // Source: Protos investigation, SEC settlement, Moore HK attestation. Confidence: Medium
      { name: "First Digital Trust fund investments (at cost, opaque)", pct: 99, risk: "very-high" },
      { name: "Cash at depository institutions", pct: 1, risk: "very-low" },
    ],
  }),
  usd("119", "First Digital USD", "FDUSD", "rwa-backed", "centralized", {
    geckoId: "first-digital-usd",
    deploymentModel: "native-multichain",
    collateral: "Cash, U.S. Treasury bills, bank deposits, and overnight reverse repos held in fully segregated custodial accounts",
    pegMechanism: "Direct 1:1 redemption through FD121 (BVI) Limited; reserves custodied by First Digital Trust Limited",
    proofOfReserves: { type: "independent-audit", url: "https://www.firstdigitallabs.com/transparency", provider: "IAPA International / Prism" },
    links: [
      { label: "Website", url: "https://www.firstdigitallabs.com/fdusd" },
      { label: "Twitter", url: "https://x.com/FDLabsHQ" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
    contracts: [
      { chain: "ethereum", address: "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409", decimals: 18 },
      { chain: "bsc", address: "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409", decimals: 18 },
      { chain: "arbitrum", address: "0x93c9932e4afa59201f0b5e63f7d816516f1669fe", decimals: 18 },
      { chain: "sui", address: "0xf16e6b723f242ec745dfd7634ad072c42d5c1d9ac9d62a39c381303eaa57693a::fdusd::FDUSD", decimals: 6 },
      { chain: "ton", address: "EQD0Evpk4timFOHmy4Sv3l_KEUXlM-dN1_KhroTCfB2wkO89", decimals: 6 },
      { chain: "solana", address: "9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u", decimals: 6 },
    ],
    reserves: [
      // Source: First Digital Labs transparency, Prescient Jan 31, 2026. Confidence: High
      { name: "U.S. Treasury Bills", pct: 74, risk: "very-low" },
      { name: "Cash", pct: 18, risk: "very-low" },
      { name: "Bank Deposits", pct: 6, risk: "very-low" },
      { name: "Overnight Reverse Repos", pct: 2, risk: "very-low" },
    ],
  }),
  usd("296", "Cap cUSD", "CUSD", "rwa-backed", "centralized-dependent", {
    geckoId: "cap-usd",
    governanceQuality: "wrapper",
    collateral: "Basket of regulated stablecoins: USDC, USDT, pyUSD, BUIDL, and BENJI (max 40% each)",
    pegMechanism: "Dynamic-fee vault: users deposit whitelisted reserve assets to mint cUSD at oracle-determined value; redemptions return a proportional basket of all underlying assets, socializing any reserve depeg across redeemers; dynamic interest rates prevent full utilization so redemptions remain atomic; secured by EigenLayer AVS",
    proofOfReserves: { type: "real-time", url: "https://cap.app/vault/reserves/cUSD" },
    links: [
      { label: "Website", url: "https://www.cap.app/" },
      { label: "Twitter", url: "https://x.com/capmoney_" },
      { label: "Docs", url: "https://docs.cap.app/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc", decimals: 18 },
    ],
    reserves: [
      // Source: Cap docs, Aave blog, blocmates Jan 2026. Confidence: Low
      { name: "USDC (Circle)", pct: 35, risk: "low", coinId: "2" },
      { name: "USDT (Tether)", pct: 25, risk: "low", coinId: "1" },
      { name: "BUIDL (BlackRock tokenized MMF)", pct: 20, risk: "low", coinId: "173" },
      { name: "BENJI (Franklin Templeton fund)", pct: 10, risk: "low" },
      { name: "pyUSD (PayPal)", pct: 10, risk: "low", coinId: "120" },
    ],
  }),
  // USDN (id 12) removed — algorithmic death spiral Apr 2022 (see cemetery)
  eur("50", "EURC", "EURC", "rwa-backed", "centralized", {
    geckoId: "euro-coin",
    deploymentModel: "native-multichain",
    collateral: "Euro-denominated cash and short-term euro government securities held in segregated, bankruptcy-remote accounts at regulated financial institutions in the EEA",
    pegMechanism: "Direct 1:1 redemption through Circle Internet Financial Europe SAS (licensed EMI under MiCA); Circle Mint enables institutional mint/redeem at zero fees with near-instant settlement",
    proofOfReserves: { type: "independent-audit", url: "https://www.circle.com/transparency", provider: "Deloitte" },
    links: [
      { label: "Website", url: "https://www.circle.com/eurc" },
      { label: "Twitter", url: "https://x.com/circle" },
      { label: "Docs", url: "https://developers.circle.com/stablecoins/what-is-eurc" },
    ],
    jurisdiction: { country: "France", regulator: "ACPR", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c", decimals: 6 },
      { chain: "base", address: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", decimals: 6 },
      { chain: "avalanche", address: "0xc891eb4cbdeff6e073e859e987815ed1505c2acd", decimals: 6 },
      { chain: "worldchain", address: "0x1c60ba0a0ed1019e8eb035e6daf4155a5ce2380b", decimals: 6 },
      { chain: "stellar", address: "EURC-GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2", decimals: 7 },
      { chain: "solana", address: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr", decimals: 6 },
    ],
    reserves: [
      // Source: Circle transparency page Feb 23, 2026. Confidence: High
      { name: "Deposits at Systemically Important Institutions (EUR)", pct: 99, risk: "very-low" },
      { name: "Other Bank Deposits (EUR)", pct: 1, risk: "very-low" },
    ],
  }),
  usd("197", "Resolv USD", "USR", "crypto-backed", "centralized-dependent", {
    geckoId: "resolv-usr",
    deploymentModel: "third-party-bridge",
    dependencies: [{ id: "1", weight: 0.05 }, { id: "2", weight: 0.05 }],
    collateral: "ETH, wstETH (Lido), LBTC, and weETH held on-chain via Fireblocks; yield from liquid staking rewards and perpetual futures funding rates",
    pegMechanism: "Delta-neutral portfolio: long spot ETH/BTC on-chain balanced by equal short perpetual futures on CEXs (Binance, Hyperliquid, Deribit) via Fireblocks Off-Exchange; USR redeemable 1:1 at any time; RLP (Resolv Liquidity Pool) absorbs negative funding-rate and liquidation risk",
    proofOfReserves: { type: "real-time", url: "https://info.apostro.xyz/resolv-reserves", provider: "Apostro" },
    links: [
      { label: "Website", url: "https://resolv.xyz/" },
      { label: "Twitter", url: "https://x.com/ResolvLabs" },
      { label: "Docs", url: "https://docs.resolv.xyz/" },
      { label: "GitHub", url: "https://github.com/resolv-im/resolv-contracts-public" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
    contracts: [
      { chain: "ethereum", address: "0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110", decimals: 18 },
      { chain: "base", address: "0x35e5db674d8e93a03d814fa0ada70731efe8a4b9", decimals: 18 },
      { chain: "bsc", address: "0x2492d0006411af6c8bbb1c8afc1b0197350a79e9", decimals: 18 },
      { chain: "berachain", address: "0x2492d0006411af6c8bbb1c8afc1b0197350a79e9", decimals: 18 },
      { chain: "hyperevm", address: "0x0ad339d66bf4aed5ce31c64bc37b3244b6394a77", decimals: 18 },
      { chain: "arbitrum", address: "0x2492d0006411af6c8bbb1c8afc1b0197350a79e9", decimals: 18 },
      { chain: "soneium", address: "0xb1b385542b6e80f77b94393ba8342c3af699f15c", decimals: 18 },
    ],
    collateralQuality: "exotic",
    custodyModel: "institutional",
    reserves: [
      // Source: Resolv docs, Coin Bureau, Binance Academy Q4 2025. Confidence: Medium
      { name: "ETH + wstETH (delta-neutral via short perps)", pct: 55, risk: "medium" },
      { name: "BTC (delta-neutral via short perps)", pct: 20, risk: "medium" },
      { name: "RLP insurance layer (surplus ETH + BTC)", pct: 15, risk: "medium" },
      { name: "USD stablecoins (USDC/USDT)", pct: 10, risk: "low" },
    ],
  }),
  usd("272", "YLDS", "YLDS", "rwa-backed", "centralized", {
    yieldBearing: true, rwa: true, navToken: true,
    geckoId: "ylds",
    collateral: "Short-dated U.S. Treasury securities and overnight Treasury repo agreements held by Figure Certificate Company (FCC), an SEC-registered face-amount certificate company; custodian UMB Bank NA, audited by KPMG LLP; reserves maintained at 100% with 0.5% excess buffer",
    pegMechanism: "Fixed $1.00 face-amount certificate; daily interest accrual at SOFR minus 50bps (minimum 0%), paid monthly in USD or YLDS; 1:1 mint and redemption through Figure Certificate Company with mandatory KYC; registered under the Securities Act of 1933 and Investment Company Act of 1940",
    proofOfReserves: { type: "independent-audit", url: "https://cdn.figure.com/docs/markets/fcc-prospectus.pdf", provider: "KPMG LLP" },
    links: [
      { label: "Website", url: "https://www.ylds.com/" },
      { label: "Twitter", url: "https://x.com/FigureMarkets" },
      { label: "Docs", url: "https://docs.provenance.io/learn/the-ylds-stablecoin" },
    ],
    jurisdiction: { country: "United States", regulator: "SEC", license: "SEC-Registered Security" },
    reserves: [
      // Source: Figure Certificate Co. prospectus (SEC), KPMG Q1 2025. Confidence: High
      { name: "Overnight Treasury repo agreements (UMB Bank)", pct: 86, risk: "very-low" },
      { name: "Money market funds", pct: 13, risk: "very-low" },
      { name: "Digital assets (USDC + USDT, operational)", pct: 1, risk: "low" },
    ],
  }),
  usd("110", "crvUSD", "crvUSD", "crypto-backed", "decentralized", {
    geckoId: "crvusd",
    deploymentModel: "third-party-bridge",
    dependencies: [{ id: "1", weight: 0.10 }, { id: "2", weight: 0.10 }, { id: "120", weight: 0.10 }, { id: "235", weight: 0.10 }],
    collateral: "WETH, wBTC, wstETH, sfrxETH, and tBTC deposited as collateral; LLAMMA (Lending-Liquidating AMM) performs soft liquidations by gradually converting collateral to crvUSD as prices fall",
    pegMechanism: "Peg Stability Reserve (PegKeeper) contracts deposit or withdraw pre-minted crvUSD into Curve pools paired with USDC, USDT, PYUSD, and frxUSD to restore the peg; borrow rate adjusts dynamically — rising when crvUSD trades below $1 to incentivize repayments",
    links: [
      { label: "Website", url: "https://www.curve.finance/" },
      { label: "Twitter", url: "https://x.com/CurveFinance" },
      { label: "Docs", url: "https://resources.curve.finance/" },
      { label: "GitHub", url: "https://github.com/curvefi/curve-stablecoin" },
    ],
    jurisdiction: { country: "Switzerland" },
    contracts: [
      { chain: "ethereum", address: "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e", decimals: 18 },
      { chain: "arbitrum", address: "0x498bf2b1e120fed3ad3d42ea2165e9b73f99c1e5", decimals: 18 },
      { chain: "base", address: "0x417ac0e078398c154edfadd9ef675d30be60af93", decimals: 18 },
      { chain: "gnosis", address: "0xabef652195f98a91e490f047a5006b71c85f058d", decimals: 18 },
      { chain: "polygon", address: "0xc4ce1d6f5d98d65ee25cf85e9f2e9dcfee6cb5d6", decimals: 18 },
      { chain: "bsc", address: "0xe2fb3f127f5450dee44afe054385d74c392bdef4", decimals: 18 },
      { chain: "optimism", address: "0xc52d7f23a2e460248db6ee192cb23dd12bddcbf6", decimals: 18 },
      { chain: "taiko", address: "0xc8f4518ed4bab9a972808a493107926ce8237068", decimals: 18 },
      { chain: "fraxtal", address: "0xb102f7efa0d5de071a8d37b3548e1c7cb148caf3", decimals: 18 },
    ],
    supplyMethod: {
      type: "exclude", // totalSupply() includes pre-minted lending capacity; DefiLlama aggregates debt across all factories
    },
    reserves: [
      // Source: Curve Finance crvUSD Mint Markets UI (Feb 2026). Based on Mint Markets TVL breakdown.
      { name: "WBTC / cbBTC", pct: 69, risk: "medium" },
      { name: "tBTC", pct: 11, risk: "medium" },
      { name: "wstETH / sfrxETH / weETH", pct: 12, risk: "low" },
      { name: "ETH", pct: 8, risk: "very-low" },
    ],
  }),
  usd("310", "Solstice USX", "USX", "crypto-backed", "centralized-dependent", {
    geckoId: "usx",
    governanceQuality: "wrapper",
    dependencies: [{ id: "1", weight: 0.5, type: "wrapper" }, { id: "2", weight: 0.5, type: "wrapper" }],
    collateral: "USDC and USDT deposited 1:1; plans to expand to SOL, ETH, and BTC collateral",
    pegMechanism: "1:1 collateralization with multi-oracle pricing via Chainlink and Pyth; Chainlink Proof of Reserve provides real-time on-chain verification of reserves; institutional minting ($500K minimum, KYC-gated); permissionless access via Solana DEXs",
    links: [
      { label: "Website", url: "https://solstice.finance/usx" },
      { label: "Twitter", url: "https://x.com/solsticefi" },
      { label: "Docs", url: "https://docs.solstice.finance" },
    ],
    jurisdiction: { country: "Switzerland" },
    contracts: [
      { chain: "solana", address: "6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG", decimals: 6 },
    ],
    chainTier: "established-alt-l1",
    collateralQuality: "alt-lst-bridged-or-mixed",
    reserves: [
      // Source: Solstice docs, StablecoinInsider Sep-Dec 2025. Confidence: Medium
      { name: "USDC", pct: 55, risk: "low" },
      { name: "USDT", pct: 45, risk: "low" },
    ],
  }),

  // ── Rank 31-40 ───────────────────────────────────────────────────────
  usd("220", "Avalon USDa", "USDA", "crypto-backed", "centralized-dependent", {
    geckoId: "usda-2",
    deploymentModel: "third-party-bridge",
    dependencies: [{ id: "1", weight: 0.4 }],
    collateralQuality: "alt-lst-bridged-or-mixed",
    collateral: "BTC and BTC LSTs (e.g. FBTC) deposited as overcollateralized CDP; USDT can also be deposited 1:1; $2B institutional credit lines via Cobo, Ceffu, and Coinbase Prime",
    pegMechanism: "1:1 USDT convertibility; dynamic supply scaling against BTC collateral; liquidation via proprietary HFT algorithm through Ceffu/Coinbase Prime custody; cross-chain via LayerZero OFT",
    links: [
      { label: "Website", url: "https://www.avalonfinance.xyz/" },
      { label: "Twitter", url: "https://x.com/avalonfinance_" },
      { label: "Docs", url: "https://docs.avalonfinance.xyz" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x8a60e489004ca22d775c5f2c657598278d17d9c2", decimals: 18 },
      { chain: "bsc",      address: "0x9356086146be5158e98ad827e21b5cf944699894", decimals: 18 },
      { chain: "mantle",   address: "0x075df695b8e7f4361fa7f8c1426c63f11b06e326", decimals: 18 },
    ],
    reserves: [
      // Source: Avalon docs, Decrypt, Wu Blockchain late 2024-2025. Confidence: Low
      { name: "FBTC (tokenized BTC via Cobo custody)", pct: 45, risk: "medium" },
      { name: "USDT (1:1 minted deposits)", pct: 40, risk: "low" },
      { name: "BTC LSTs (SolvBTC, LBTC, pumpBTC, etc.)", pct: 15, risk: "high" },
    ],
  }),
  // Binance Peg BUSD (id 153) removed — BUSD discontinued (see cemetery)
  usd("6", "Frax", "FRAX", "rwa-backed", "centralized-dependent", {
    geckoId: "frax",
    deploymentModel: "third-party-bridge",
    governanceQuality: "dao-governance",
    collateral: "Short-dated U.S. Treasury bills, Federal Reserve overnight repurchase agreements, FDIC-insured deposits, and USDC held off-chain by FinresPBC (a Delaware public benefit corporation) on behalf of the Frax DAO; fully collateralized since FIP-188 (2023)",
    pegMechanism: "AMO smart contracts maintain ≥100% collateral ratio; peg tracked via Chainlink oracles and governance-approved USD reference rates; defended by recollateralization through RWA purchases and on-chain AMO rebalancing",
    links: [
      { label: "Website", url: "https://frax.com/" },
      { label: "Twitter", url: "https://x.com/fraxfinance" },
      { label: "Docs", url: "https://docs.frax.finance" },
    ],
    jurisdiction: { country: "United States" },
    contracts: [
      { chain: "ethereum", address: "0x853d955acef822db058eb8505911ed77f175b99e", decimals: 18 },
      { chain: "arbitrum", address: "0x17fc002b466eec40dae837fc4be5c67993ddbd6f", decimals: 18 },
      { chain: "optimism", address: "0x2e3d870790dc77a83dd1d18184acc7439a53f475", decimals: 18 },
      { chain: "polygon", address: "0x45c32fa6df82ead1e2ef74d17b76547eddfaff89", decimals: 18 },
      { chain: "avalanche", address: "0xd24c2ad096400b6fbcd2ad8b24e7acbc21a1da64", decimals: 18 },
      { chain: "bsc", address: "0x90c97f71e18723b0cf0dfa30ee176ab653e89f40", decimals: 18 },
      { chain: "fantom", address: "0xdc301622e621166bd8e82f2ca0a26c13ad0be355", decimals: 18 },
      { chain: "moonriver", address: "0x1a93b23281cc1cde4c4741353f3064709a16197d", decimals: 18 },
      { chain: "polygon-zkevm", address: "0xff8544fed5379d9ffa8d47a74ce6b91e632ac44d", decimals: 18 },
      { chain: "moonbeam", address: "0x322e86852e492a7ee17f28a78c663da38fb33bfb", decimals: 18 },
      { chain: "boba", address: "0x7562f525106f5d54e891e005867bf489b5988cd9", decimals: 18 },
      { chain: "aurora", address: "0xe4b9e004389d91e4134a28f19bd833cba1d994b6", decimals: 18 },
    ],
    reserves: [
      // Source: LlamaRisk Jul 2025, Chaos Labs, Frax docs. Confidence: Medium
      { name: "USTB (Superstate tokenized T-bills)", pct: 50, risk: "low" },
      { name: "BUIDL (BlackRock tokenized T-bills/cash/repos)", pct: 42, risk: "low", coinId: "173" },
      { name: "USCC (Superstate crypto arbitrage)", pct: 3, risk: "medium" },
      { name: "Other tokenized assets (WTGXX, AUSD, JTRSY)", pct: 5, risk: "low" },
    ],
  }),
  usd("15", "Dola", "DOLA", "crypto-backed", "centralized-dependent", {
    geckoId: "dola-usd",
    deploymentModel: "third-party-bridge",
    dependencies: [{ id: "209", weight: 0.08, type: "mechanism" }],
    governanceQuality: "dao-governance",
    collateral: "Over-collateralized crypto assets (wstETH, WETH, INV, WBTC, LP tokens, and others) deposited in Inverse Finance's FiRM fixed-rate lending markets; USDS in the PSM as a peg backstop",
    pegMechanism: "Fed contracts govern DOLA supply: FiRM Fed mints/burns DOLA in overcollateralized lending markets (~98% of supply); PSM Fed enables 1:1 swaps with USDS as a peg floor; DEX Liquidity Feds adjust supply in AMM pools",
    proofOfReserves: { type: "self-reported", url: "https://www.inverse.finance/transparency" },
    links: [
      { label: "Website", url: "https://www.inverse.finance/" },
      { label: "Docs", url: "https://docs.inverse.finance/" },
      { label: "GitHub", url: "https://github.com/InverseFinance" },
      { label: "Twitter", url: "https://x.com/InverseFinance" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x865377367054516e17014ccded1e7d814edc9ce4", decimals: 18 },
      { chain: "arbitrum", address: "0x6a7661795c374c0bfc635934efaddff3a7ee23b6", decimals: 18 },
      { chain: "base", address: "0x4621b7a9c75199271f773ebd9a499dbd165c3191", decimals: 18 },
      { chain: "optimism", address: "0x8ae125e8653821e851f12a49f7765db9a9ce7384", decimals: 18 },
      { chain: "fantom", address: "0x3129662808bec728a27ab6a6b9afd3cbaca8a43c", decimals: 18 },
      { chain: "bsc", address: "0x2f29bc0ffaf9bff337b31cbe6cb5fb3bf12e5840", decimals: 18 },
    ],
    reserves: [
      // Source: Inverse Finance transparency, DefiLlama Feb 2026. Confidence: Medium
      { name: "wstETH (Lido)", pct: 35, risk: "low" },
      { name: "sUSDe / PT-sUSDe (Ethena)", pct: 15, risk: "medium" },
      { name: "cbBTC (Coinbase wrapped Bitcoin)", pct: 12, risk: "medium" },
      { name: "WETH", pct: 10, risk: "medium" },
      { name: "USDS in PSM (peg backstop)", pct: 8, risk: "low" },
      { name: "LP tokens (Curve, cvxCRV, st-yCRV)", pct: 8, risk: "high" },
      { name: "Other (sFRAX, INV, st-yETH)", pct: 12, risk: "very-high" },
    ],
  }),
  usd("205", "Agora Dollar", "AUSD", "rwa-backed", "centralized", {
    geckoId: "agora-dollar",
    deploymentModel: "third-party-bridge",
    collateral: "Cash (USD deposits), short-dated U.S. Treasury bills, and overnight reverse repurchase agreements; managed by VanEck in a bankruptcy-remote Delaware Statutory Trust custodied by State Street",
    pegMechanism: "Fiat-backed 1:1; users deposit USD and mint AUSD at par; direct redemption for USD through Agora; reserves held in bankruptcy-remote Delaware Statutory Trust administered by State Street",
    proofOfReserves: { type: "real-time", url: "https://oracles.chaoslabs.xyz/por-feeds/agora", provider: "Chaos Labs" },
    links: [
      { label: "Website", url: "https://www.agora.finance/" },
      { label: "Twitter", url: "https://x.com/withAUSD" },
      { label: "Docs", url: "https://docs.agora.finance/" },
      { label: "GitHub", url: "https://github.com/agora-finance" },
    ],
    jurisdiction: { country: "Bermuda", regulator: "Bermuda Monetary Authority (SAC Act)" },
    contracts: [
      { chain: "ethereum", address: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", decimals: 6 },
      { chain: "arbitrum", address: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", decimals: 6 },
      { chain: "base", address: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", decimals: 6 },
      { chain: "avalanche", address: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", decimals: 6 },
      { chain: "bsc", address: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", decimals: 6 },
      { chain: "polygon", address: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", decimals: 6 },
    ],
    reserves: [
      // Source: Agora product page, RWA.xyz, PwC attestation. Confidence: Medium
      { name: "Short-dated U.S. Treasury Bills", pct: 60, risk: "very-low" },
      { name: "Overnight Reverse Repurchase Agreements", pct: 25, risk: "low" },
      { name: "Cash (USD deposits at State Street)", pct: 15, risk: "very-low" },
    ],
  }),
  usd("298", "infiniFi USD", "IUSD", "crypto-backed", "centralized-dependent", {
    geckoId: "infinifi-usd",
    dependencies: [{ id: "2", weight: 1.0, type: "wrapper" }],
    collateralQuality: "exotic",
    collateral: "USDC; deployed across liquid DeFi yield strategies (Aave, Fluid, Euler) and illiquid strategies (Pendle PTs, Ethena/sUSDe), duration-matched to user lock-up periods",
    pegMechanism: "1:1 mint/redeem against USDC with no fees; on-chain fractional reserve — liquid portion held for instant redemptions, remainder deployed to higher-yielding DeFi farms; redemptions queue when liquid reserves are insufficient",
    links: [
      { label: "Website", url: "https://infinifi.xyz/" },
      { label: "Twitter", url: "https://x.com/infiniFi" },
      { label: "Docs", url: "https://docs.infinifi.xyz/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x48f9e38f3070ad8945dfeae3fa70987722e3d89c", decimals: 18 },
    ],
    reserves: [
      // Source: Nansen, Blockworks, 0xmedia Jun-Dec 2025. Confidence: Medium
      { name: "Ethena sUSDe (yield-bearing staked USDe)", pct: 30, risk: "medium" },
      { name: "Pendle PT-sUSDe (fixed-term Ethena yield)", pct: 25, risk: "medium" },
      { name: "Aave USDC (liquid money market)", pct: 20, risk: "low" },
      { name: "USDC reserve buffer (liquid)", pct: 15, risk: "low" },
      { name: "Fluid / Euler USDC (money markets)", pct: 10, risk: "low" },
    ],
  }),
  usd("219", "Astherus", "USDF", "crypto-backed", "centralized-dependent", {
    geckoId: "astherus-usdf",
    dependencies: [{ id: "1", weight: 1.0, type: "wrapper" }],
    collateral: "USDT held by custodian Ceffu; deployed in delta-neutral strategies (long spot + short perpetuals) executed via Ceffu MirrorX on Binance",
    pegMechanism: "1:1 USDT mint/redeem; yield from funding rate arbitrage via delta-neutral positions on Binance through Ceffu MirrorX",
    links: [
      { label: "Website", url: "https://www.asterdex.com/en/usdf" },
      { label: "Twitter", url: "https://x.com/Aster_DEX" },
      { label: "Docs", url: "https://docs.asterdex.com/" },
    ],
    contracts: [
      { chain: "bsc", address: "0x5a110fc00474038f6c02e89c707d638602ea44b5", decimals: 18 },
    ],
    collateralQuality: "exotic",
    custodyModel: "cex",
    reserves: [
      // Source: Aster docs, Coin Bureau, IQ.wiki 2025. Confidence: High
      { name: "USDT (held in Ceffu custody)", pct: 50, risk: "low" },
      { name: "Spot crypto (BTC/ETH, delta-hedged via perp shorts)", pct: 25, risk: "high" },
      { name: "Perpetual short positions margin (Binance via MirrorX)", pct: 25, risk: "high" },
    ],
  }),
  // FLEXUSD (id 21) removed — CoinFLEX exchange bankruptcy June 2022 (see cemetery)
  usd("252", "StandX DUSD", "DUSD", "crypto-backed", "centralized-dependent", {
    geckoId: "standx-dusd",
    deploymentModel: "native-multichain",
    dependencies: [{ id: "1", weight: 0.5 }, { id: "2", weight: 0.5 }],
    collateral: "USDT/USDC deposits converted to hedged crypto positions (BTC, ETH, SOL) via Ceffu",
    pegMechanism: "Delta-neutral hedging on centralized exchanges; 1:1 USDT/USDC redemption",
    links: [
      { label: "Website", url: "https://standx.com/" },
      { label: "Twitter", url: "https://x.com/StandX_Official" },
      { label: "Docs", url: "https://docs.standx.com/" },
    ],
    contracts: [
      { chain: "bsc", address: "0xaf44a1e76f56ee12adbb7ba8acd3cbd474888122", decimals: 18 },
      { chain: "solana", address: "DUSDt4AeLZHWYmcXnVGYdgAzjtzU5mXUVnTMdnSzAttM", decimals: 6 },
    ],
    collateralQuality: "exotic",
    custodyModel: "cex",
    reserves: [
      { name: "Spot crypto (BTC/ETH/SOL/BNB, delta-hedged via perp shorts)", pct: 50, risk: "high" },
      { name: "Perpetual short futures positions (CEX via Ceffu custody)", pct: 45, risk: "high" },
      { name: "Stability reserve fund (stablecoins, multisig)", pct: 5, risk: "medium" },
    ],
  }),
  usd("218", "River Stablecoin", "satUSD", "crypto-backed", "decentralized", {
    geckoId: "satoshi-stablecoin",
    tags: ["Liquity v1 fork"],
    dependencies: [],
    chainTier: "unproven",
    deploymentModel: "third-party-bridge",
    collateralQuality: "alt-lst-bridged-or-mixed",
    collateral: "BTC, ETH, BNB, and liquid staking tokens; no centralized stablecoin collateral accepted",
    pegMechanism: "Omni-CDP overcollateralized by BTC, ETH, BNB, or LSTs; collateral stays on its source chain and satUSD is minted natively on the destination chain via LayerZero OFT messaging; peg maintained through stability pools, on-chain liquidations, and $1-of-collateral redemption arbitrage",
    links: [
      { label: "Website", url: "https://river.inc/" },
      { label: "Twitter", url: "https://x.com/RiverdotInc" },
      { label: "Docs", url: "https://docs.river.inc" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x1958853a8be062dc4f401750eb233f5850f0d0d2", decimals: 18 },
      { chain: "arbitrum", address: "0xb4818bb69478730ef4e33cc068dd94278e2766cb", decimals: 18 },
      { chain: "base",     address: "0x70654aad8b7734dc319d0c3608ec7b32e03fa162", decimals: 18 },
      { chain: "bsc",      address: "0xb4818bb69478730ef4e33cc068dd94278e2766cb", decimals: 18 },
      { chain: "sonic",    address: "0xb4818bb69478730ef4e33cc068dd94278e2766cb", decimals: 18 },
      { chain: "bob",      address: "0xecf21b335b41f9d5a89f6186a99c19a3c467871f", decimals: 18 },
      { chain: "bitlayer", address: "0xba50ddac6b2f5482ca064efac621e0c7c0f6a783", decimals: 18 },
    ],
    reserves: [
      { name: "BTC (overcollateralized CDP)", pct: 40, risk: "medium" },
      { name: "ETH (overcollateralized CDP)", pct: 30, risk: "medium" },
      { name: "BNB (overcollateralized CDP)", pct: 15, risk: "medium" },
      { name: "Liquid staking tokens (solvBTC, stETH, etc.)", pct: 15, risk: "medium" },
    ],
  }),

  // ── Rank 41-50 ───────────────────────────────────────────────────────
  other("249", "Brazilian Digital", "BRZ", "rwa-backed", "centralized", "BRL", {
    geckoId: "brz",
    collateral: "Brazilian real (BRL) cash reserves held at a financial institution authorized by the Central Bank of Brazil",
    pegMechanism: "1:1 mint and redemption at Transfero for BRL; KYC verification required; redemption incurs a 1% fee in Brazil",
    links: [
      { label: "Website", url: "https://transfero.com/stablecoins/brz/" },
      { label: "Twitter", url: "https://x.com/BrzToken" },
      { label: "Docs", url: "https://docs.transfero.com/" },
    ],
    jurisdiction: { country: "Switzerland", regulator: "FINMA", license: "VQF" },
    proofOfReserves: { type: "self-reported", url: "https://transfero.com/wp-content/uploads/2024/12/daily-report.pdf", provider: "Transfero" },
    contracts: [
      { chain: "ethereum", address: "0x01d33fd36ec67c6ada32cf36b31e88ee190b1839", decimals: 18 },
      { chain: "polygon",  address: "0x4ed141110f6eeeaba9a1df36d8c26f684d2475dc", decimals: 18 },
      { chain: "bsc",      address: "0x71be881e9c5d4465b3fff61e89c6f3651e69b5bb", decimals: 4 },
      { chain: "gnosis",   address: "0x0a06c8354a6cc1a07549a38701eac205942e3ac6", decimals: 18 },
      { chain: "base",     address: "0xe9185ee218cae427af7b9764a011bb89fea761b4", decimals: 18 },
      { chain: "arbitrum", address: "0xa8940698fda5a07abaef4a5ccdf2f1bb525b47a2", decimals: 18 },
    ],
  }),
  usd("306", "Gate USD", "GUSD", "rwa-backed", "centralized", {
    geckoId: "gusd",
    collateralQuality: "exotic",
    custodyModel: "cex",
    collateral: "Short-term U.S. Treasury bonds and stablecoin-backed yield instruments held by Gate; users mint GUSD 1:1 by staking USDT or USDC",
    pegMechanism: "1:1 mint by staking USDT or USDC on Gate; upon redemption, users receive USDC equal to principal plus accrued interest; GUSD is yield-bearing — appreciation is baked in at redemption",
    proofOfReserves: { type: "self-reported", url: "https://www.gate.com/gusd", provider: "Gate" },
    links: [
      { label: "Website", url: "https://www.gate.com/gusd" },
      { label: "Twitter", url: "https://x.com/Gate" },
    ],
    jurisdiction: { country: "Cayman Islands" },
    contracts: [
      { chain: "ethereum", address: "0xaf6186b3521b60e27396b5d23b48abc34bf585c5", decimals: 6 },
    ],
    reserves: [
      { name: "Short-term U.S. Treasury bonds", pct: 70, risk: "very-low" },
      { name: "USDT/USDC deposits (minting collateral)", pct: 25, risk: "low" },
      { name: "Yield instruments (unspecified)", pct: 5, risk: "high" },
    ],
  }),
  usd("235", "Frax USD", "FRXUSD", "rwa-backed", "centralized-dependent", {
    geckoId: "frax-usd",
    deploymentModel: "third-party-bridge",
    governanceQuality: "dao-governance",
    collateral: "Tokenized cash-equivalent reserves held by governance-approved enshrined custodians: BlackRock BUIDL (U.S. Treasuries/repos via Securitize), Superstate USTB (T-bills) and USCC (U.S. government securities), Centrifuge JTRSY (T-bills), WisdomTree WTGXX (U.S. government money market), Agora AUSD, and Circle USDC; each custodian mints and redeems frxUSD 1:1 against reserves they hold on-chain",
    pegMechanism: "1:1 mint and redemption through governance-approved enshrined custodians; each custodian holds provable on-chain reserves and can mint or burn frxUSD 1:1; redeemable from any custodian with available collateral",
    jurisdiction: { country: "United States" },
    proofOfReserves: { type: "real-time", url: "https://frax.com/transparency", provider: "Chaos Labs" },
    links: [
      { label: "Website", url: "https://frax.com/" },
      { label: "Twitter", url: "https://x.com/fraxfinance" },
      { label: "Docs", url: "https://docs.frax.com/protocol/assets/frxusd/frxusd" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xcacd6fd266af91b8aed52accc382b4e165586e29", decimals: 18 },
      { chain: "arbitrum", address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
      { chain: "base",     address: "0xe5020a6d073a794b6e7f05678707de47986fb0b6", decimals: 18 },
      { chain: "optimism", address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
      { chain: "polygon",  address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
      { chain: "avalanche", address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
      { chain: "bsc",      address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
      { chain: "solana",   address: "GzX1ireZDU865FiMaKrdVB1H6AE8LAqWYCg6chrMrfBw", decimals: 9 },
      { chain: "aptos",    address: "0xe067037681385b86d8344e6b7746023604c6ac90ddc997ba3c58396c258ad17b", decimals: 6 },
      { chain: "sonic",    address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
      { chain: "linea",    address: "0xc7346783f5e645aa998b106ef9e7f499528673d8", decimals: 18 },
      { chain: "scroll",   address: "0x397f939c3b91a74c321ea7129396492ba9cdce82", decimals: 18 },
      { chain: "blast",    address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
      { chain: "mode",     address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
      { chain: "zksync",   address: "0xea77c590bb36c43ef7139ce649cfbcfd6163170d", decimals: 18 },
      { chain: "plume",    address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
      { chain: "unichain", address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
      { chain: "ink",      address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
      { chain: "sei",      address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
      { chain: "berachain", address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
      { chain: "fraxtal",       address: "0xfc00000000000000000000000000000000000001", decimals: 18 },
      { chain: "aurora",        address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
      { chain: "polygon-zkevm", address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
      { chain: "xlayer",        address: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18 },
    ],
    reserves: [
      { name: "BlackRock BUIDL (U.S. Treasuries/repos via Securitize)", pct: 55, risk: "low", coinId: "173" },
      { name: "Superstate USTB (tokenized T-bills)", pct: 20, risk: "low" },
      { name: "Circle USDC", pct: 10, risk: "low", coinId: "2" },
      { name: "Superstate USCC (U.S. government securities + crypto carry)", pct: 5, risk: "medium" },
      { name: "Other custodians (AUSD, JTRSY, WTGXX, USDB)", pct: 10, risk: "low" },
    ],
  }),
  usd("340", "rwaUSDi", "rwaUSDi", "crypto-backed", "centralized-dependent", {
    deploymentModel: "native-multichain",
    rwa: true,
    collateralQuality: "rwa",
    collateral: "Basket of 100+ Treasury-backed stablecoins and tokenized gold assets aggregated by Multipli; peg stability backed by Lloyd's insurance covering de-pegging risk",
    pegMechanism: "NAV-based valuation of underlying RWA basket; KYB-gated 1:1 minting and redemption restricted to verified institutional counterparties",
    jurisdiction: { country: "UAE" },
    proofOfReserves: { type: "independent-audit", url: "https://verification.afiprotocol.xyz/multipli", provider: "AFI" },
    links: [
      { label: "Website", url: "https://multipli.fi/" },
      { label: "Twitter", url: "https://x.com/multiplifi" },
      { label: "Docs", url: "https://docs.multipli.fi/" },
      { label: "Proof of Reserve", url: "https://verification.afiprotocol.xyz/multipli" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xA39986F96B80d04e8d7AeAaF47175F47C23FD0f4", decimals: 6 },
    ],
    reserves: [
      { name: "Tokenized U.S. Treasury products (BUIDL, USDY, OUSG, etc.)", pct: 50, risk: "low", coinId: "173" },
      { name: "Treasury-backed stablecoins (100+ aggregated)", pct: 25, risk: "medium" },
      { name: "Tokenized gold assets (10+ aggregated)", pct: 15, risk: "medium" },
      { name: "Market-neutral fund units (Nomura, Fasanara, Edge Capital)", pct: 10, risk: "high" },
    ],
  }),
  usd("271", "Avant USD", "avUSD", "rwa-backed", "centralized", {
    geckoId: "avant-usd",
    deploymentModel: "third-party-bridge",
    collateral: "USDC reserves held in protocol smart contracts",
    pegMechanism: "1:1 redemption for USDC via Avant Protocol with a 0.05% redemption fee and 1–7 day settlement window",
    links: [
      { label: "Website", url: "https://www.avantprotocol.com/" },
      { label: "Twitter", url: "https://x.com/avantprotocol" },
      { label: "Docs", url: "https://docs.avantprotocol.com/" },
      { label: "GitHub", url: "https://github.com/Avant-Protocol" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
    contracts: [
      { chain: "avalanche", address: "0x24de8771bc5ddb3362db529fc3358f2df3a0e346", decimals: 18 },
      { chain: "ethereum", address: "0xf4c13d631450de6b12a19829e37c8e2826891dc4", decimals: 18 },
    ],
    reserves: [
      { name: "USDC (1:1 backing, deployed into delta-neutral strategies via 0xPartners)", pct: 95, risk: "medium" },
      { name: "Reserve fund (loss absorption buffer)", pct: 5, risk: "medium" },
    ],
  }),
  usd("341", "Pleasing USD", "PUSD", "rwa-backed", "centralized-dependent", {
    geckoId: "pleasing-usd",
    dependencies: [{ id: "1", weight: 1.0, type: "wrapper" }],
    collateral: "USDT deposits held by Pleasing International; ecosystem interoperability with tokenized gold (PGOLD)",
    pegMechanism: "1:1 mint and redemption against USDT through the Pleasing Golden platform",
    jurisdiction: { country: "Hong Kong" },
    links: [
      { label: "Website", url: "https://www.pleasinggold.com/" },
      { label: "Twitter", url: "https://x.com/PleasingGolden" },
      { label: "Docs", url: "https://pleasing.gitbook.io/docs" },
    ],
    contracts: [
      { chain: "arbitrum", address: "0xc8fb643d18f1e53698cfda5c8fdf0cdc03c1dbec", decimals: 18 },
      { chain: "apechain", address: "0x764387ae46fc504b0682bc1ad31963250007e58e", decimals: 18 },
    ],
    reserves: [
      { name: "USDT deposits (1:1 minting collateral)", pct: 90, risk: "low" },
      { name: "Tokenized gold exposure (PGOLD interoperability)", pct: 10, risk: "medium" },
    ],
  }),
  usd("339", "Re Protocol reUSD", "reUSD", "crypto-backed", "centralized-dependent", {
    yieldBearing: true, navToken: true,
    geckoId: "re-protocol-reusd",
    deploymentModel: "native-multichain",
    dependencies: [{ id: "2", weight: 0.5 }],
    collateral: "USDC, USDe, and sUSDe deployed into delta-neutral ETH basis trades or short-duration U.S. Treasury bills via the Re Protocol Insurance Capital Layer",
    pegMechanism: "NAV-based token price recalculated daily at UTC 00:00 via Chainlink price feed; yield accrues from delta-neutral ETH basis trade or T-bill returns plus 250 bps protocol spread; atomic redemptions when instant liquidity available, otherwise queue mode",
    jurisdiction: { country: "British Virgin Islands", regulator: "FSC", license: "BVI Securities and Investment Business Act" },
    proofOfReserves: { type: "real-time", url: "https://app.re.xyz/transparency", provider: "The Network Firm / Chainlink" },
    links: [
      { label: "Website", url: "https://re.xyz/" },
      { label: "Twitter", url: "https://x.com/re" },
      { label: "Docs", url: "https://docs.re.xyz" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x5086bf358635b81d8c47c66d1c8b9e567db70c72", decimals: 18 },
      { chain: "avalanche", address: "0x180af87b47bf272b2df59dccf2d76a6eafa625bf", decimals: 18 },
      { chain: "arbitrum", address: "0x76ce01f0ef25aa66cc5f1e546a005e4a63b25609", decimals: 18 },
      { chain: "base", address: "0x7d214438d0f27afccc23b3d1e1a53906ace5cfea", decimals: 18 },
      { chain: "bsc", address: "0xba9425ec55ee0e72216d18e0ad8bbba2553bfb60", decimals: 18 },
      { chain: "ink", address: "0x5bcf6b008bf80b9296238546bace1797657b05d6", decimals: 18 },
    ],
    collateralQuality: "exotic",
    reserves: [
      { name: "Delta-neutral ETH basis trade positions (via sUSDe/USDe)", pct: 50, risk: "high" },
      { name: "Short-duration U.S. Treasury bills", pct: 30, risk: "very-low" },
      { name: "USDC reserves (instant redemption buffer)", pct: 20, risk: "low" },
    ],
  }),
  usd("332", "pmUSD", "pmUSD", "rwa-backed", "centralized", {
    geckoId: "precious-metals-usd",
    dependencies: [],
    collateral: "ION.au tokenized gold (issued by I-ON Digital Corp) deposited as collateral into RAAC's RWf(x) overcollateralized lending protocol",
    pegMechanism: "Overcollateralized CDP: users deposit ION.au (tokenized gold) as collateral and mint pmUSD; Chainlink proof-of-reserves feeds attest to gold holdings in real time; Instruxi provides third-party reserve attestation",
    proofOfReserves: { type: "real-time", url: "https://pmusd.raac.io/", provider: "Chainlink / Instruxi" },
    links: [
      { label: "Website", url: "https://pmusd.raac.io/" },
      { label: "Twitter", url: "https://x.com/Raacfi" },
      { label: "Docs", url: "https://docs.raac.io/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xc0c17dd08263c16f6b64e772fb9b723bf1344ddf", decimals: 18 },
    ],
    reserves: [
      { name: "ION.au tokenized gold (I-ON Digital, Chainlink PoR attested)", pct: 100, risk: "medium" },
    ],
  }),
  usd("202", "Anzen USDz", "USDz", "rwa-backed", "centralized", {
    rwa: true,
    geckoId: "anzen-usdz",
    deploymentModel: "third-party-bridge",
    collateral: "Diversified U.S. private credit assets (SMB merchant receivables, factored invoices, PO financing, auto lease financing, consumer installment lending) tokenized as Secured Private Credit Tokens (SPCT), underwritten by Percent (U.S.-licensed broker-dealer)",
    pegMechanism: "Each USDz backed 1:1 by SPCT locked in the smart contract; peg maintained by arbitrage — if below $1, traders buy at discount; if above $1, Qualified Market Makers mint at 1:1 USDz/USDC and sell",
    proofOfReserves: { type: "real-time", url: "https://rwa.anzen.finance/transparency", provider: "on-chain SPCT collateralization" },
    links: [
      { label: "Website", url: "https://anzen.finance/" },
      { label: "Twitter", url: "https://x.com/AnzenFinance" },
      { label: "Docs", url: "https://docs.anzen.finance/" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
    contracts: [
      { chain: "ethereum", address: "0xa469b7ee9ee773642b3e93e842e5d9b5baa10067", decimals: 18 },
      { chain: "base", address: "0x04d5ddf5f3a8939889f11e97f8c4bb48317f1938", decimals: 18 },
      { chain: "arbitrum", address: "0x5018609ab477cc502e170a5accf5312b86a4b94f", decimals: 18 },
    ],
    reserves: [
      { name: "U.S. private credit ABS (SMB receivables, auto leases, consumer lending, litigation finance via Percent)", pct: 80, risk: "high" },
      { name: "Superstate USTB/USCC (tokenized T-bills and crypto carry)", pct: 15, risk: "medium" },
      { name: "Cash and cash equivalents", pct: 5, risk: "very-low" },
    ],
  }),
  usd("316", "CASH", "CASH", "rwa-backed", "centralized", {
    geckoId: "cash-4",
    collateral: "U.S. Treasury bills (≤3 months maturity), reverse repurchase agreements backed by U.S. Treasuries, U.S. government money-market funds, deposit accounts, and tokenized equivalents held in segregated bankruptcy-remote accounts",
    pegMechanism: "Direct 1:1 redemption via Bridge Building Inc. (BBI) with reserves held in bankruptcy-remote custodial accounts",
    links: [
      { label: "Website", url: "https://www.usecash.xyz/" },
      { label: "Twitter", url: "https://x.com/usecash" },
    ],
    jurisdiction: { country: "United States", regulator: "FinCEN / state MTL authorities", license: "Money Services Business (NMLS #2450917)" },
    contracts: [
      { chain: "solana", address: "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH", decimals: 6 },
    ],
    reserves: [
      { name: "U.S. Treasury bills (<=3mo maturity)", pct: 50, risk: "very-low" },
      { name: "Reverse repos (overnight, UST-collateralized)", pct: 15, risk: "very-low" },
      { name: "U.S. government money-market funds", pct: 15, risk: "very-low" },
      { name: "Bank deposit accounts", pct: 10, risk: "very-low" },
      { name: "Tokenized treasuries (BUIDL, USTB)", pct: 10, risk: "low", coinId: "173" },
    ],
  }),

  // ── Rank 51-60 ───────────────────────────────────────────────────────
  usd("284", "MNEE USD", "MNEE", "rwa-backed", "centralized", {
    geckoId: "mnee-usd-stablecoin",
    collateral: "U.S. Treasury bills (≤90-day duration) and USD cash held by a qualified custodian, invested in accordance with NYDFS permissible investment rules",
    pegMechanism: "Fiat-backed 1:1 with USD; tokens minted upon deposit of USD and burned upon redemption; reserves held at qualified custodian compliant with NYDFS permissible investment standards",
    proofOfReserves: { type: "independent-audit", url: "https://www.mnee.io/transparency", provider: "Wolf and Company, P.C." },
    links: [
      { label: "Website", url: "https://www.mnee.io/" },
      { label: "Twitter", url: "https://x.com/MNEE_cash" },
      { label: "Docs", url: "https://docs.mnee.io" },
    ],
    jurisdiction: { country: "Antigua and Barbuda", regulator: "FSRC", license: "Class A Digital Asset Business License" },
    contracts: [
      { chain: "ethereum", address: "0x8ccedbae4916b79da7f3f612efb2eb93a2bfd6cf", decimals: 18 },
    ],
    reserves: [
      { name: "U.S. Treasury bills (<=90-day duration)", pct: 85, risk: "very-low" },
      { name: "USD cash at qualified custodian", pct: 15, risk: "very-low" },
    ],
  }),
  usd("257", "OpenEden TBILL", "TBILL", "rwa-backed", "centralized", {
    yieldBearing: true, rwa: true, navToken: true,
    geckoId: "openeden-tbill",
    deploymentModel: "native-multichain",
    collateral: "Short-term U.S. Treasury bills (weighted-average maturity <3 months) managed by BNY Investment Management, custodied by BNY; small USD cash buffer",
    pegMechanism: "NAV-based pricing; institutional mint/redeem through regulated BVI fund structure",
    proofOfReserves: { type: "independent-audit", url: "https://openeden.com/tbill/transparency" },
    links: [
      { label: "Website", url: "https://openeden.com/tbill" },
      { label: "Twitter", url: "https://x.com/OpenEden_X" },
      { label: "Docs", url: "https://docs.openeden.com/" },
    ],
    jurisdiction: { country: "British Virgin Islands", regulator: "BVI FSC", license: "Registered Professional Fund" },
    contracts: [
      { chain: "ethereum", address: "0xdd50c053c096cb04a3e3362e2b622529ec5f2e8a", decimals: 6 },
      { chain: "arbitrum", address: "0xf84d28a8d28292842dd73d1c5f99476a80b6666a", decimals: 6 },
      { chain: "solana", address: "4MmJVdwYN8LwvbGeCowYjSx7KoEi6BJWg8XXnW4fDDp6", decimals: 6 },
    ],
    reserves: [
      { name: "Short-dated U.S. Treasury bills (WAM <3mo)", pct: 95, risk: "very-low" },
      { name: "USD cash buffer", pct: 5, risk: "very-low" },
    ],
  }),
  other("66", "Frax Price Index", "FPI", "algorithmic", "centralized-dependent", "VAR", {
    geckoId: "frax-price-index",
    navToken: true,
    governanceQuality: "wrapper",
    dependencies: [{ id: "6", weight: 1.0, type: "wrapper" }],
    collateralQuality: "rwa",
    collateral: "FRAX stablecoins held at 100% collateral ratio, with AMOs generating yield; FPIS tokens sold via TWAMM when AMO yield falls below CPI inflation rate",
    pegMechanism: "Redemption price grows on-chain per second at the 12-month US CPI-U rate (BLS data); updated monthly via Chainlink oracle; 100% collateral ratio maintained via AMOs",
    links: [
      { label: "Website", url: "https://frax.com/" },
      { label: "Twitter", url: "https://x.com/fraxfinance" },
      { label: "Docs", url: "https://docs.frax.finance/frax-price-index/overview-cpi-peg-and-mechanics" },
    ],
    jurisdiction: { country: "United States" },
    contracts: [
      { chain: "ethereum", address: "0x5ca135cb8527d76e932f34b5145575f9d8cbe08e", decimals: 18 },
    ],
  }),
  usd("283", "Unitas", "USDU", "crypto-backed", "centralized-dependent", {
    geckoId: "usdu",
    deploymentModel: "native-multichain",
    dependencies: [{ id: "2", weight: 0.8 }],
    collateralQuality: "exotic",
    custodyModel: "institutional",
    collateral: "USDC deposits: 80% converted to JLP (a basket of BTC, ETH, SOL, and USDC earning Jupiter Perps trading fees); 20% held at Copper/Ceffu as margin for delta-neutral short perp positions; ~10% of protocol fees route to an Insurance Fund",
    pegMechanism: "Overcollateralized, delta-neutral: long JLP + short perpetuals rebalanced hourly via Copper/Ceffu off-exchange settlement; whitelisted KYC/KYB participants mint/redeem 1:1 with USDC via API; most users acquire USDu on secondary markets",
    proofOfReserves: { type: "real-time", url: "https://accountable.unitas.so/", provider: "Accountable" },
    jurisdiction: { country: "Singapore" },
    links: [
      { label: "Website", url: "https://unitas.so/" },
      { label: "Twitter", url: "https://x.com/UnitasLabs" },
      { label: "Docs", url: "https://docs.unitas.so/" },
    ],
    contracts: [
      { chain: "bsc", address: "0xea953ea6634d55dac6697c436b1e81a679db5882", decimals: 18 },
      { chain: "solana", address: "9ckR7pPPvyPadACDTzLwK2ZAEeUJ3qGSnzPs8bVaHrSy", decimals: 6 },
    ],
    reserves: [
      { name: "JLP (Jupiter Perps LP: BTC, ETH, SOL, USDC basket)", pct: 80, risk: "high" },
      { name: "Short perp margin (Copper/Ceffu off-exchange)", pct: 20, risk: "high" },
    ],
  }),
  // DEUSD removed — collapsed Nov 2025 when Stream Finance failed
  usd("321", "USDH Stablecoin", "USDH", "rwa-backed", "centralized", {
    geckoId: "usdh-2",
    contracts: [
      { chain: "hyperevm", address: "0x111111a1a0667d36bd57c0a9f569b98057111111", decimals: 6 },
    ],
    collateral: "Cash, short-term U.S. Treasuries, repo agreements, treasury-focused funds (e.g., BlackRock TTTXX), and tokenized treasury products (e.g., BlackRock BUIDL, Superstate USTB); cash custodied at US-regulated banks, TradFi assets custodied at JP Morgan Chase; on-chain reserves managed by Superstate and custodied in Bridge's MPC infrastructure via Fireblocks; designed by Native Markets, issued by Bridge Building Inc (a Stripe company)",
    pegMechanism: "Direct 1:1 redemption through Bridge (a Stripe company); high-quality liquid reserves (cash, U.S. Treasuries) maintain the peg; monthly third-party reserve attestations beginning November 2025",
    proofOfReserves: { type: "independent-audit", url: "https://www.usdh.com/transparency", provider: "BPM LLP" },
    links: [
      { label: "Website", url: "https://usdh.com/" },
      { label: "Twitter", url: "https://x.com/nativemarkets" },
      { label: "Docs", url: "https://docs.usdh.com" },
      { label: "Github", url: "https://github.com/native-markets" },
    ],
    jurisdiction: { country: "United States", regulator: "FinCEN", license: "Money Services Business (Bridge Building, Inc.)" },
    reserves: [
      { name: "Short-term U.S. Treasuries (BlackRock-managed, JP Morgan custody)", pct: 40, risk: "very-low" },
      { name: "Cash deposits (JP Morgan, Lead Bank)", pct: 20, risk: "very-low" },
      { name: "Repo agreements (UST-collateralized)", pct: 10, risk: "very-low" },
      { name: "Treasury-focused funds (BlackRock TTTXX)", pct: 10, risk: "very-low" },
      { name: "Tokenized treasuries (BUIDL, USTB)", pct: 20, risk: "low", coinId: "173" },
    ],
  }),
  usd("79", "Lista USD", "LISUSD", "crypto-backed", "centralized-dependent", {
    geckoId: "helio-protocol-hay",
    dependencies: [{ id: "1", weight: 0.25 }, { id: "2", weight: 0.25 }],
    chainTier: "established-alt-l1",
    collateralQuality: "alt-lst-bridged-or-mixed",
    collateral: "BNB, ETH, and LSTs via CDPs; USDT/USDC/FDUSD via Peg Stability Module",
    pegMechanism: "PSM enabling 1:1 swaps with centralized stablecoins; CDP overcollateralization and liquidation",
    links: [
      { label: "Website", url: "https://lista.org/" },
      { label: "Twitter", url: "https://x.com/lista_dao" },
      { label: "Docs", url: "https://docs.bsc.lista.org" },
      { label: "GitHub", url: "https://github.com/lista-dao" },
    ],
    contracts: [
      { chain: "bsc", address: "0x0782b6d8c4551b9760e74c0545a9bcd90bdc41e5", decimals: 18 },
    ],
    reserves: [
      { name: "BNB (native)", pct: 35, risk: "high" },
      { name: "slisBNB (Lista BNB LST)", pct: 25, risk: "high" },
      { name: "ETH / wBETH (Binance ETH LST)", pct: 15, risk: "medium" },
      { name: "BTCB (Binance-wrapped BTC)", pct: 10, risk: "medium" },
      { name: "USDT / USDC / FDUSD (via PSM)", pct: 15, risk: "low" },
    ],
  }),
  usd("241", "OpenDollar USDO", "USDO", "rwa-backed", "centralized", {
    geckoId: "openeden-open-dollar",
    deploymentModel: "third-party-bridge",
    collateral: "U.S. Treasury bills via tokenized TBILL and BUIDL tokens held in a bankruptcy-remote segregated account; 100% collateralization ratio maintained",
    pegMechanism: "Rebasing stablecoin fixed at $1; supply rebases daily to distribute yield; mint/redemption at 1:1 with USDC via OpenEden platform",
    proofOfReserves: { type: "real-time", url: "https://openeden.com/usdo/transparency", provider: "Chainlink PoR" },
    links: [
      { label: "Website", url: "https://openeden.com/" },
      { label: "Twitter", url: "https://x.com/OpenEden_X" },
      { label: "Docs", url: "https://docs.openeden.com/usdo/introduction" },
    ],
    jurisdiction: { country: "Bermuda", regulator: "BMA", license: "DABA License" },
    contracts: [
      { chain: "ethereum", address: "0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe", decimals: 18 },
      { chain: "base", address: "0xad55aebc9b8c03fc43cd9f62260391c13c23e7c0", decimals: 18 },
      { chain: "bsc", address: "0x302e52aff9815b9d1682473dbfb9c74f9b750aa8", decimals: 18 },
    ],
    reserves: [
      { name: "OpenEden TBILL tokens (tokenized U.S. T-bills)", pct: 70, risk: "low" },
      { name: "BlackRock BUIDL (tokenized money market fund)", pct: 15, risk: "low", coinId: "173" },
      { name: "Franklin Templeton BENJI (tokenized govt money fund)", pct: 5, risk: "low" },
      { name: "USDC cash buffer", pct: 10, risk: "low", coinId: "2" },
    ],
  }),
  usd("166", "Cygnus Finance Global USD", "cgUSD", "rwa-backed", "centralized", {
    geckoId: "cygnus-finance-global-usd",
    collateral: "Short-term U.S. Treasury bills held off-chain, supplemented by on-chain stablecoins (USDC/USDT); supply rebases daily on New York banking days to match portfolio net asset value including accrued interest",
    pegMechanism: "Daily rebase on NYC banking days aligning total supply with portfolio NAV; 1:1 USDC redemption via two-step withdrawal (request + claim, 5–7 day settlement); Transmuter enables instant 1:1 conversion between cgUSD and USDC; Elixir AMO manages on-chain liquidity",
    links: [
      { label: "Website", url: "https://www.cygnus.finance/" },
      { label: "Twitter", url: "https://x.com/CygnusFi" },
      { label: "Docs", url: "https://wiki.cygnus.finance/whitepaper/" },
    ],
    contracts: [
      { chain: "base", address: "0xca72827a3d211cfd8f6b00ac98824872b72cab49", decimals: 6 },
    ],
    reserves: [
      { name: "Short-term U.S. Treasury bills (off-chain)", pct: 80, risk: "very-low" },
      { name: "On-chain stablecoins (USDC/USDT)", pct: 15, risk: "low" },
      { name: "Accrued interest", pct: 5, risk: "very-low" },
    ],
  }),

  // ── Rank 61-70 ───────────────────────────────────────────────────────
  eur("254", "EUR CoinVertible", "EURCV", "rwa-backed", "centralized", {
    geckoId: "societe-generale-forge-eurcv",
    deploymentModel: "native-multichain",
    collateral: "Euro-denominated cash deposits and high-quality securities held in a segregated fiduciary estate at Societe Generale, with daily public disclosure of reserve composition",
    pegMechanism: "Direct 1:1 redemption through SG-FORGE",
    proofOfReserves: { type: "self-reported", url: "https://www.sgforge.com/product/coinvertible/", provider: "SG-FORGE" },
    links: [
      { label: "Website", url: "https://www.sgforge.com/product/coinvertible/" },
      { label: "Twitter", url: "https://x.com/SG_Forge" },
    ],
    jurisdiction: { country: "France", regulator: "ACPR", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x5f7827fdeb7c20b443265fc2f40845b715385ff2", decimals: 18 },
      { chain: "xrpl", address: "4555524356000000000000000000000000000000.rUNaS5sqRuxZz6V7rBGhoSaZiVYA3ut4UL", decimals: 0 },
      { chain: "stellar", address: "GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G", decimals: 7 },
      { chain: "solana", address: "DghpMkatCiUsofbTmid3M3kAbDTPqDwKiYHnudXeGG52", decimals: 2 },
    ],
    reserves: [
      { name: "Euro cash deposits at Societe Generale", pct: 100, risk: "very-low" },
    ],
  }),
  // USP (id 97) removed — Platypus exploited in 2023, protocol defunct (see cemetery)
  eur("147", "Anchored Coins AEUR", "AEUR", "rwa-backed", "centralized", {
    geckoId: "anchored-coins-eur",
    deploymentModel: "native-multichain",
    collateral: "Euro reserves held 1:1 at Swissquote Bank SA (FINMA-licensed Swiss bank)",
    pegMechanism: "Direct 1:1 redemption through Anchored Coins",
    links: [
      { label: "Website", url: "https://www.anchoredcoins.com/en/landing/aeur" }, // TODO: verify — domain may have been repurposed
      { label: "Twitter", url: "https://x.com/AnchoredCoins" },
    ],
    jurisdiction: { country: "Switzerland", regulator: "VQF (FINMA-recognized SRO)", license: "SRO Member" },
    contracts: [
      { chain: "ethereum", address: "0xa40640458fbc27b6eefedea1e9c9e17d4cee7a21", decimals: 18 },
      { chain: "bsc", address: "0xa40640458fbc27b6eefedea1e9c9e17d4cee7a21", decimals: 18 },
    ],
    notices: [
      { type: "danger", title: "Winding down", message: "FlowBank SA (reserve partner) declared bankruptcy in June 2024. A portion of AEUR collateral is locked in bankruptcy proceedings. Anchored Coins has ceased new issuance and was delisted from Binance EEA in March 2025." },
    ],
    reserves: [
      { name: "Euro deposits at Swissquote Bank SA", pct: 85, risk: "very-low" },
      { name: "Euro deposits at FlowBank SA (bankruptcy recovery)", pct: 15, risk: "high" },
    ],
  }),
  // BUSD (id 4) removed — regulatory shutdown Feb 2023 (see cemetery)
  usd("275", "Quantoz USDQ", "USDQ", "rwa-backed", "centralized", {
    geckoId: "quantoz-usdq",
    deploymentModel: "third-party-bridge",
    collateral: "U.S. dollar deposits and government bonds (Netherlands, Germany, US) held in segregated, bankruptcy-remote accounts at Tier 1 European banks by Stichting Quantoz, supervised by DNB; reserves maintained at ≥102% of circulating supply per MiCAR requirements",
    pegMechanism: "Direct 1:1 redemption through Quantoz Payments for onboarded customers; reserves held at ≥102% overcollateralization per MiCAR",
    proofOfReserves: { type: "self-reported", url: "https://www.quantoz.com/transparency" },
    links: [
      { label: "Website", url: "https://www.quantoz.com/products/eurq-usdq" },
      { label: "Twitter", url: "https://x.com/Quantoz" },
      { label: "Docs", url: "https://www.quantoz.com/resources" },
      { label: "Proof of Reserve", url: "https://www.quantoz.com/transparency" },
    ],
    jurisdiction: { country: "Netherlands", regulator: "DNB", license: "EMI (MiCAR)" },
    contracts: [
      { chain: "ethereum", address: "0xc83e27f270cce0a3a3a29521173a83f402c1768b", decimals: 6 },
      { chain: "polygon", address: "0xb291996477504506bf5f583102b5b5ea5d1e40e0", decimals: 6 },
      { chain: "xrpl", address: "USDQ.rDk1xiArDMjDqnrR2yWypwQAKg4mKnQYvs", decimals: 0 },
      { chain: "algorand", address: "2768603795", decimals: 6 },
    ],
    reserves: [
      { name: "Government bonds (NL, DE, US)", pct: 69, risk: "very-low" },
      { name: "Cash deposits at Tier 1 European banks", pct: 31, risk: "very-low" },
    ],
  }),
  usd("256", "Resupply USD", "REUSD", "crypto-backed", "centralized-dependent", {
    geckoId: "resupply-usd",
    dependencies: [{ id: "1", weight: 0.2 }, { id: "2", weight: 0.2 }],
    collateralQuality: "exotic",
    collateral: "crvUSD and frxUSD lending vault tokens from Curve Lend and Fraxlend",
    pegMechanism: "Communal redemption model with 1% fee establishing a price floor; borrow rate is the higher of half the lending rate, half the sfrxUSD rate, or 2%; underlying collateral depends on crvUSD/frxUSD ecosystems which rely on centralized stablecoin peg keepers",
    links: [
      { label: "Website", url: "https://resupply.fi/" },
      { label: "Twitter", url: "https://x.com/ResupplyFi" },
      { label: "Docs", url: "https://docs.resupply.fi/" },
      { label: "GitHub", url: "https://github.com/resupplyfi/resupply" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x57ab1e0003f623289cd798b1824be09a793e4bec", decimals: 18 },
    ],
    reserves: [
      { name: "Curve Lend vault shares (crvUSD lending positions)", pct: 60, risk: "high" },
      { name: "Fraxlend vault shares (frxUSD lending positions)", pct: 40, risk: "high" },
    ],
  }),
  eur("325", "Eurite", "EURI", "rwa-backed", "centralized", {
    geckoId: "eurite",
    deploymentModel: "native-multichain",
    collateral: "Euro cash and low-risk liquid assets held in segregated fiduciary accounts, bankruptcy-remote from Banking Circle S.A.",
    pegMechanism: "Direct 1:1 redemption at par (fee-free) by Banking Circle S.A.",
    proofOfReserves: { type: "independent-audit", url: "https://www.eurite.com/", provider: "Ernst & Young" },
    links: [
      { label: "Website", url: "https://www.eurite.com/" },
      { label: "Twitter", url: "https://x.com/Eurite_BC" },
    ],
    jurisdiction: { country: "Luxembourg", regulator: "CSSF", license: "Credit Institution (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x9d1a7a3191102e9f900faa10540837ba84dcbae7", decimals: 18 },
      { chain: "bsc", address: "0x9d1a7a3191102e9f900faa10540837ba84dcbae7", decimals: 18 },
    ],
    reserves: [
      { name: "Euro cash in segregated fiduciary accounts", pct: 70, risk: "very-low" },
      { name: "Low-risk liquid assets (EU government securities)", pct: 30, risk: "very-low" },
    ],
  }),
  usd("19", "Gemini Dollar", "GUSD", "rwa-backed", "centralized", {
    geckoId: "gemini-dollar",
    collateral: "Cash deposits at State Street and Western Alliance Bank, U.S. Treasury bills (maturities ≤3 months), and government money market funds, held in segregated accounts for the benefit of GUSD holders",
    pegMechanism: "Direct 1:1 redemption through Gemini",
    proofOfReserves: { type: "independent-audit", url: "https://www.gemini.com/dollar", provider: "BPM LLP" },
    links: [
      { label: "Website", url: "https://www.gemini.com/dollar" },
      { label: "GitHub", url: "https://github.com/gemini/dollar" },
      { label: "Twitter", url: "https://x.com/gemini" },
    ],
    jurisdiction: { country: "United States", regulator: "NYDFS", license: "Trust Charter" },
    contracts: [
      { chain: "ethereum", address: "0x056fd409e1d7a124bd7017459dfea2f387b6d5cd", decimals: 2 },
      { chain: "near", address: "056fd409e1d7a124bd7017459dfea2f387b6d5cd.factory.bridge.near", decimals: 2 },
    ],
    reserves: [
      { name: "U.S. Treasury bills (<=3 month maturity)", pct: 62, risk: "very-low" },
      { name: "Cash deposits (State Street, Western Alliance Bank)", pct: 38, risk: "very-low" },
    ],
  }),
  usd("11", "Pax Dollar", "USDP", "rwa-backed", "centralized", {
    geckoId: "paxos-standard",
    deploymentModel: "native-multichain",
    collateral: "Cash in FDIC-insured bank accounts and U.S. Treasury bills (including overnight reverse repos and T-bill money market funds) held in segregated, bankruptcy-remote accounts",
    pegMechanism: "Direct 1:1 redemption through Paxos",
    proofOfReserves: { type: "independent-audit", url: "https://www.paxos.com/usdp-transparency", provider: "KPMG" },
    links: [
      { label: "Website", url: "https://www.paxos.com/usdp" },
      { label: "Docs", url: "https://docs.paxos.com/guides/stablecoin/usdp" },
      { label: "Twitter", url: "https://x.com/paxos" },
    ],
    jurisdiction: { country: "United States", regulator: "OCC", license: "National Trust Charter" },
    contracts: [
      { chain: "ethereum", address: "0x8e870d67f660d95d5be530380d0ec0bd388289e1", decimals: 18 },
      { chain: "solana", address: "HVbpJAQGNpkgBaYBZQBR1t7yFdvaYVp2vCQQfKKEN4tM", decimals: 6 },
    ],
    reserves: [
      { name: "U.S. Treasury bills (<90 day maturity)", pct: 60, risk: "very-low" },
      { name: "Overnight reverse repos (secured by Treasuries)", pct: 20, risk: "very-low" },
      { name: "Cash in FDIC-insured bank accounts", pct: 20, risk: "very-low" },
    ],
  }),
  usd("263", "Hex Trust USDX", "USDX", "rwa-backed", "centralized", {
    geckoId: "hex-trust-usdx",
    collateral: "Cash and cash equivalents, primarily 1–3 month U.S. Treasury bills held at global tier-1 financial institutions",
    pegMechanism: "Direct 1:1 redemption through Hex Trust",
    links: [
      { label: "Website", url: "https://www.htdigitalassets.com/" },
      { label: "Twitter", url: "https://x.com/_HTDA" },
    ],
    jurisdiction: { country: "Hong Kong", regulator: "Companies Registry", license: "TCSP License" },
    contracts: [
      { chain: "ethereum", address: "0xf8750b54d86be7ae9e32b4a0c826811198d63313", decimals: 18 },
    ],
    reserves: [
      { name: "U.S. Treasury bills (1-3 month maturity)", pct: 80, risk: "very-low" },
      { name: "Cash and cash equivalents", pct: 20, risk: "very-low" },
    ],
  }),

  // ── Rank 71-80 ───────────────────────────────────────────────────────
  usd("290", "StraitsX XUSD", "XUSD", "rwa-backed", "centralized", {
    geckoId: "straitsx-xusd",
    deploymentModel: "native-multichain",
    collateral: "Cash, cash equivalents, and short-term U.S. government securities held at regulated financial institutions (DBS, Standard Chartered, UOB), segregated from corporate assets in custody accounts maintained with MAS-licensed custodians",
    pegMechanism: "Fiat-backed 1:1 mint and redeem: users deposit USD to a StraitsX-designated bank account to mint XUSD; redemption returns USD to a whitelisted beneficiary bank account within 5 business days; reserve assets held at 100%+ of circulating supply at all times per MAS SCS framework",
    proofOfReserves: { type: "independent-audit", url: "https://www.straitsx.com/xusd", provider: "KK Yap & Associates" },
    links: [
      { label: "Website", url: "https://www.straitsx.com/xusd" },
      { label: "Twitter", url: "https://x.com/straitsx" },
    ],
    jurisdiction: { country: "Singapore", regulator: "MAS", license: "Major Payment Institution" },
    contracts: [
      { chain: "ethereum", address: "0xc08e7e23c235073c6807c2efe7021304cb7c2815", decimals: 6 },
      { chain: "bsc", address: "0xf81ac2e1a0373dde1bce01e2fe694a9b7e3bfcb9", decimals: 6 },
    ],
    reserves: [
      { name: "Cash deposits at Tier 1 banks (DBS, Standard Chartered, UOB)", pct: 50, risk: "very-low" },
      { name: "Short-term U.S. / MAS government securities", pct: 50, risk: "very-low" },
    ],
  }),
  usd("313", "Metamask USD", "MUSD", "rwa-backed", "centralized", {
    geckoId: "metamask-usd",
    deploymentModel: "third-party-bridge",
    collateral: "Cash and short-term U.S. Treasury securities held in bankruptcy-remote custody, issued by Bridge (a Stripe company) using the M0 protocol",
    pegMechanism: "1:1 mint and redemption via Bridge using M0 protocol infrastructure; reserves continuously validated on-chain by independent validators; arbitrage corrects price drift; monthly public attestations",
    links: [
      { label: "Website", url: "https://metamask.io/" },
      { label: "Twitter", url: "https://x.com/MetaMask" },
      { label: "Audit", url: "https://diligence.security/audits/2025/08/metamask-usd-token/" },
    ],
    jurisdiction: { country: "United States" },
    proofOfReserves: { type: "real-time", url: "https://dashboard.m0.org", provider: "M0 Protocol" },
    contracts: [
      { chain: "ethereum", address: "0xaca92e438df0b2401ff60da7e4337b687a2435da", decimals: 6 },
      { chain: "linea", address: "0xaca92e438df0b2401ff60da7e4337b687a2435da", decimals: 6 },
    ],
    reserves: [
      { name: "U.S. Treasury bills (0-180 day maturity)", pct: 85, risk: "very-low" },
      { name: "Cash in bankruptcy-remote custody", pct: 15, risk: "very-low" },
    ],
  }),
  usd("255", "Aegis YUSD", "YUSD", "crypto-backed", "centralized", {
    geckoId: "aegis-yusd",
    deploymentModel: "third-party-bridge",
    yieldBearing: true,
    collateral: "Bitcoin held in institutional custody (Fireblocks, Copper, CEFFU); delta-neutral hedge via COIN-M perpetual futures; funded by user deposits of USDT, USDC, or DAI converted to BTC",
    pegMechanism: "Delta-neutral hedging: BTC spot long + COIN-M perpetual short; 1:1 redemption via Aegis Mint contract; funding rate yield distributed to registered YUSD holders; insurance fund backstop for extreme events",
    proofOfReserves: { type: "real-time", url: "https://aegis.accountable.capital/", provider: "Accountable" },
    links: [
      { label: "Website", url: "https://aegis.im/" },
      { label: "Twitter", url: "https://x.com/aegis_im" },
      { label: "Docs", url: "https://docs.aegis.im/" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
    contracts: [
      { chain: "ethereum", address: "0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a", decimals: 18 },
      { chain: "bsc", address: "0xab3dbcd9b096c3ff76275038bf58eac10d22c61f", decimals: 18 },
      { chain: "avalanche", address: "0xca2671dcd031a72359f456c212f62a9bda737cd7", decimals: 18 },
    ],
    collateralQuality: "exotic",
    custodyModel: "cex",
    reserves: [
      { name: "BTC spot (held at Fireblocks, Copper, CEFFU)", pct: 50, risk: "medium" },
      { name: "BTC-margined perpetual futures (short positions)", pct: 50, risk: "high" },
    ],
  }),
  usd("22", "sUSD", "SUSD", "crypto-backed", "centralized-dependent", {
    geckoId: "nusd",
    deploymentModel: "third-party-bridge",
    dependencies: [{ id: "2", weight: 0.3 }],
    collateral: "SNX, ETH, and USDC/stataUSDC via Synthetix V3; direct SNX minting deprecated in 2025; sUSD now backed primarily by delta-neutral basis-trade vaults and protocol treasury activity",
    pegMechanism: "Overcollateralization via C-ratio (200%+); V3 expanded collateral to SNX, ETH, USDC/stataUSDC; sUSD minting against SNX deprecated in 2025; peg sustained via SLP Vault basis-trade strategy and protocol fee buybacks",
    links: [
      { label: "Website", url: "https://www.synthetix.io/" },
      { label: "Twitter", url: "https://x.com/synthetix_io" },
      { label: "Docs", url: "https://docs.synthetix.io/" },
    ],
    jurisdiction: { country: "Australia" },
    contracts: [
      { chain: "ethereum", address: "0x57ab1ec28d129707052df4df418d58a2d46d5f51", decimals: 18 },
      { chain: "optimism", address: "0x8c6f28f2f1a3c87f0f938b96d27520d9751ec8d9", decimals: 18 },
      { chain: "fantom", address: "0x0e1694483ebb3b74d3054e383840c6cf011e518e", decimals: 18 },
      { chain: "arbitrum", address: "0xa970af1a584579b618be4d69ad6f73459d112f95", decimals: 18 },
    ],
    collateralQuality: "exotic",
    reserves: [
      { name: "SNX (via legacy V2 420 pool, 200% C-ratio)", pct: 50, risk: "very-high" },
      { name: "USDC / stataUSDC (V3 Base pool collateral)", pct: 25, risk: "low" },
      { name: "ETH and LSTs (V3 multi-collateral)", pct: 15, risk: "low" },
      { name: "Protocol treasury buybacks / SLP vault activity", pct: 10, risk: "high" },
    ],
    notices: [
      { type: "warning", title: "Prolonged depeg", message: "sUSD has been trading at ~$0.83-0.85 since the SIP-420 C-ratio reduction in late 2024. Peg restoration is targeted for mid-2026 via the V3 transition and SLP vault strategy." },
    ],
  }),
  usd("269", "Liquity BOLD", "BOLD", "crypto-backed", "decentralized", {
    deploymentModel: "third-party-bridge",
    geckoId: "liquity-bold-2",
    collateral: "WETH, wstETH, and rETH only; immutable contracts with no governance over collateral selection",
    pegMechanism: "Overcollateralized CDPs with direct on-chain redemption for $1 of collateral; user-set interest rates adapt to peg conditions, with 75% of interest revenue flowing to Stability Pools",
    links: [
      { label: "Website", url: "https://www.liquity.org/bold" },
      { label: "Twitter", url: "https://x.com/LiquityProtocol" },
      { label: "Docs", url: "https://docs.liquity.org/" },
      { label: "GitHub", url: "https://github.com/liquity/bold" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x6440f144b7e50d6a8439336510312d2f54beb01d", decimals: 18 },
      { chain: "arbitrum", address: "0x03569cc076654f82679c4ba2124d64774781b01d", decimals: 18 },
      { chain: "base", address: "0x03569cc076654f82679c4ba2124d64774781b01d", decimals: 18 },
      { chain: "optimism", address: "0x03569cc076654f82679c4ba2124d64774781b01d", decimals: 18 },
      { chain: "avalanche", address: "0x03569cc076654f82679c4ba2124d64774781b01d", decimals: 18 },
    ],
    reserves: [
      { name: "wstETH (Lido)", pct: 50, risk: "low" },
      { name: "WETH", pct: 30, risk: "medium" },
      { name: "rETH (Rocket Pool)", pct: 20, risk: "low" },
    ],
  }),
  usd("302", "Hylo HYUSD", "HYUSD", "crypto-backed", "decentralized", {
    geckoId: "hylo-usd",
    dependencies: [],
    collateral: "Diversified basket of Solana LSTs (mSOL, jitoSOL, bSOL, JupSOL)",
    pegMechanism: "Overcollateralization (150%+) with companion leveraged token (xSOL) absorbing SOL volatility; operates on Solana (not Ethereum or a Stage 1 L2)",
    links: [
      { label: "Website", url: "https://hylo.so/" },
      { label: "Twitter", url: "https://x.com/hylo_so" },
      { label: "Docs", url: "https://docs.hylo.so/protocol-overview/hyUSD-&-xSOL" },
    ],
    chainTier: "established-alt-l1",
    collateralQuality: "alt-lst-bridged-or-mixed",
    reserves: [
      { name: "JitoSOL", pct: 90, risk: "high" },
      { name: "Other Solana LSTs (mSOL, bSOL, JupSOL)", pct: 10, risk: "high" },
    ],
  }),
  usd("8", "Liquity USD", "LUSD", "crypto-backed", "decentralized", {
    geckoId: "liquity-usd",
    deploymentModel: "canonical-bridge",
    collateral: "ETH only; 110% minimum collateralization ratio per Trove (CDP), with a one-time borrowing fee instead of ongoing interest",
    pegMechanism: "Overcollateralized ETH CDPs (Troves) with three peg mechanisms: (1) hard floor at $1 via direct on-chain redemption of LUSD for $1 of ETH from the riskiest Trove; (2) Stability Pool absorbs liquidations at 110% collateral ratio; (3) algorithmically adjusted borrowing and redemption fees throttle arbitrage volume",
    links: [
      { label: "Website", url: "https://www.liquity.org/" },
      { label: "Twitter", url: "https://x.com/LiquityProtocol" },
      { label: "Docs", url: "https://docs.liquity.org/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x5f98805a4e8be255a32880fdec7f6728c6568ba0", decimals: 18 },
      { chain: "optimism", address: "0xc40f949f8a4e094d1b49a23ea9241d289b7b2819", decimals: 18 },
      { chain: "arbitrum", address: "0x93b346b6bc2548da6a1e7d98e9a421b42541425b", decimals: 18 },
      { chain: "zksync", address: "0x503234f203fc7eb888eec8513210612a43cf6115", decimals: 18 },
      { chain: "base", address: "0x368181499736d0c0cc614dbb145e2ec1ac86b8c6", decimals: 18 },
      { chain: "polygon", address: "0x23001f892c0c82b79303edc9b9033cd190bb21c7", decimals: 18 },
    ],
    reserves: [
      { name: "ETH", pct: 100, risk: "very-low" },
    ],
  }),
  usd("168", "fxUSD", "fxUSD", "crypto-backed", "decentralized", {
    geckoId: "f-x-protocol-fxusd",
    collateral: "wstETH and WBTC deposited as collateral into f(x) Protocol CDP vaults; xPOSITIONs represent looped leveraged positions as NFTs; fully overcollateralized",
    pegMechanism: "CDP-style with overcollateralization and liquidations; USDC/fxUSD Stability Pool Gauge on Curve acts as peg keeper (buys fxUSD below peg); fxUSD redeemable at oracle price for underlying collateral when below peg; automatic rebalancing and liquidation of under-collateralized positions",
    proofOfReserves: { type: "independent-audit", url: "https://www.openzeppelin.com/news/fx-v2-audit", provider: "OpenZeppelin" },
    links: [
      { label: "Website", url: "https://fx.aladdin.club" },
      { label: "Twitter", url: "https://x.com/protocol_fx" },
      { label: "Docs", url: "https://fxprotocol.gitbook.io/fx-docs" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x085780639cc2cacd35e474e71f4d000e2405d8f6", decimals: 18 },
    ],
    reserves: [
      { name: "wstETH (Lido)", pct: 75, risk: "low" },
      { name: "WBTC", pct: 25, risk: "medium" },
    ],
  }),
  usd("282", "Noble Dollar", "USDN", "rwa-backed", "centralized", {
    geckoId: "noble-dollar-usdn",
    collateral: "Short-term U.S. Treasury Bills held in bankruptcy-remote SPVs via M0 Protocol; over 100% collateral coverage maintained by M0 Minters (including Superstate and MXON); collateral verified daily on-chain",
    pegMechanism: "Rebasing yield-bearing stablecoin; USDN is collateralized by M0's $M token on Ethereum via M0's Portal bridge (Wormhole NTT); the Noble chain module tracks each holder's principal against the latest rebasing multiplier from M0 on Ethereum, accruing T-bill yield directly to USDN balances; users mint/redeem via USDC through the Noble Express app",
    jurisdiction: { country: "United States" },
    proofOfReserves: { type: "real-time", url: "https://dashboard.m0.org/", provider: "M0 Protocol" },
    links: [
      { label: "Website", url: "https://noble.xyz/usdn" },
      { label: "Twitter", url: "https://x.com/noble_xyz" },
      { label: "Docs", url: "https://docs.noble.xyz/" },
    ],
    reserves: [
      { name: "Short-term U.S. Treasury Bills (via M0 SPVs)", pct: 100, risk: "very-low" },
    ],
  }),

  // ── Rank 81-90 ───────────────────────────────────────────────────────
  usd("10", "Magic Internet Money", "MIM", "crypto-backed", "centralized-dependent", {
    geckoId: "magic-internet-money",
    deploymentModel: "third-party-bridge",
    dependencies: [{ id: "1", weight: 0.2 }, { id: "2", weight: 0.2 }, { id: "5", weight: 0.2 }],
    collateral: "Interest-bearing tokens (yvWETH, yvUSDC, yvDAI, yvUSDT, xSUSHI, stETH, WBTC, WETH) deposited as collateral into Abracadabra cauldrons (isolated lending markets)",
    pegMechanism: "CDP-style cauldrons with overcollateralization and automatic liquidations (4% liquidation fee); borrowers are incentivized to buy MIM below $1 to repay debt; 0.5% borrow/interest fees accrue to sSPELL stakers and governance treasury",
    links: [
      { label: "Website", url: "https://abracadabra.money/" },
      { label: "Twitter", url: "https://x.com/MIM_Spell" },
      { label: "Docs", url: "https://docs.abracadabra.money/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x99d8a9c45b2eca8864373a26d1459e3dff1e17f3", decimals: 18 },
      { chain: "arbitrum", address: "0xfea7a6a0b346362bf88a9e4a88416b77a57d6c2a", decimals: 18 },
      { chain: "avalanche", address: "0x130966628846bfd36ff31a822705796e8cb8c18d", decimals: 18 },
      { chain: "fantom", address: "0x82f0b8b456c1a451378467398982d4834b6829c1", decimals: 18 },
      { chain: "bsc", address: "0xfe19f0b51438fd612f6fd59c1dbb3ea319f433ba", decimals: 18 },
      { chain: "optimism", address: "0xb153fb3d196a8eb25522705560ac152eeec57901", decimals: 18 },
      { chain: "polygon", address: "0x49a0400587a7f65072c87c4910449fdcc5c47242", decimals: 18 },
    ],
    supplyMethod: {
      type: "exclude", // totalSupply() includes unborrowed MIM across 45+ Cauldron contracts; DefiLlama tracks actual debt
    },
    collateralQuality: "exotic",
    reserves: [
      { name: "Yield-bearing tokens (yvWETH, yvUSDC, yvUSDT, yvDAI)", pct: 35, risk: "high" },
      { name: "wstETH / stETH", pct: 20, risk: "low" },
      { name: "WBTC / WETH", pct: 15, risk: "medium" },
      { name: "GM tokens (GMX V2 LP)", pct: 15, risk: "very-high" },
      { name: "Other exotic collateral (xSUSHI, Super OETH, etc.)", pct: 15, risk: "very-high" },
    ],
  }),
  usd("307", "USD CoinVertible", "USDCV", "rwa-backed", "centralized", {
    geckoId: "usd-coinvertible",
    deploymentModel: "native-multichain",
    collateral: "U.S. dollar cash deposits and high-quality liquid assets held 1:1 in segregated accounts at Bank of New York Mellon (BNY), managed by independent fiduciaries and bankruptcy-remote from SG-FORGE; daily public disclosure of reserve composition",
    pegMechanism: "Direct 1:1 redemption through SG-FORGE",
    proofOfReserves: { type: "self-reported", url: "https://www.sgforge.com/product/coinvertible/", provider: "SG-FORGE" },
    links: [
      { label: "Website", url: "https://www.sgforge.com/product/coinvertible/" },
      { label: "Twitter", url: "https://x.com/SG_Forge" },
      { label: "Docs", url: "https://www.sgforge.com/wp-content/uploads/2025/08/SG-Forge-USDCV-White-Paper_V2.0_Ethereum_Solana_11082025.pdf" },
    ],
    jurisdiction: { country: "France", regulator: "ACPR", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x5422374b27757da72d5265cc745ea906e0446634", decimals: 18 },
      { chain: "solana", address: "8smindLdDuySY6i2bStQX9o8DVhALCXCMbNxD98unx35", decimals: 2 },
    ],
    reserves: [
      { name: "USD cash deposits at BNY Mellon (segregated)", pct: 100, risk: "very-low" },
    ],
  }),
  usd("231", "Honey", "HONEY", "crypto-backed", "centralized-dependent", {
    geckoId: "honey-3",
    dependencies: [{ id: "1", weight: 0.25 }, { id: "2", weight: 0.25 }],
    collateralQuality: "alt-lst-bridged-or-mixed",
    collateral: "1:1 basket of USDC, USDT0, pyUSD, and USDe on Berachain",
    pegMechanism: "Direct 1:1 mint/redeem against centralized stablecoin collateral with Basket Mode safety",
    links: [
      { label: "Website", url: "https://honey.berachain.com/" },
      { label: "Twitter", url: "https://x.com/berachain" },
      { label: "Docs", url: "https://docs.berachain.com/learn/pol/tokens/honey" },
      { label: "Discord", url: "https://discord.gg/berachain" },
    ],
    chainTier: "unproven",
    contracts: [
      { chain: "berachain", address: "0xfcbd14dc51f0a4d49d5e53c2e0950e0bc26d0dce", decimals: 18 },
    ],
    reserves: [
      { name: "USDC (Circle)", pct: 40, risk: "low" },
      { name: "USDT0 (Tether via LayerZero)", pct: 25, risk: "low" },
      { name: "pyUSD / BYUSD (PayPal)", pct: 20, risk: "low" },
      { name: "USDe (Ethena)", pct: 15, risk: "high" },
    ],
  }),
  other("226", "Frankencoin", "ZCHF", "crypto-backed", "decentralized", "CHF", {
    geckoId: "frankencoin",
    collateral: "ETH, BTC derivatives (WBTC, cbBTC), ETH LSTs (wstETH, LsETH), gold tokens (PAXG, XAUt), tokenized RWAs (SPYon, LENDS, REALU), and governance tokens (CRV, GNO) in oracle-free overcollateralized positions; any collateral can be whitelisted by governance",
    pegMechanism: "Auction-based collateral valuation with veto governance; no price oracle dependency",
    collateralQuality: "alt-lst-bridged-or-mixed",
    links: [
      { label: "Website", url: "https://www.frankencoin.com/" },
      { label: "Twitter", url: "https://x.com/frankencoinzchf" },
      { label: "Docs", url: "https://docs.frankencoin.com/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xb58e61c3098d85632df34eecfb899a1ed80921cb", decimals: 18 },
      { chain: "optimism", address: "0x4f8a84c442f9675610c680990eddb2ccddb8ab6f", decimals: 18 },
      { chain: "gnosis", address: "0xd4dd9e2f021bb459d5a5f6c24c12fe09c5d45553", decimals: 18 },
    ],
    reserves: [
      { name: "Wrapped Bitcoin (WBTC, cbBTC)", pct: 45, risk: "medium" },
      { name: "ETH / wstETH / LsETH", pct: 30, risk: "low" },
      { name: "Gold tokens (PAXG, XAUt)", pct: 10, risk: "medium" },
      { name: "Tokenized RWAs (SPYon, LENDS, REALU)", pct: 10, risk: "high" },
      { name: "Other (CRV, GNO, governance tokens)", pct: 5, risk: "very-high" },
    ],
  }),
  usd("172", "USDB Blast", "USDB", "crypto-backed", "centralized-dependent", {
    yieldBearing: true,
    geckoId: "usdb",
    dependencies: [{ id: "1", weight: 0.3 }, { id: "2", weight: 0.3 }, { id: "5", weight: 0.3 }],
    collateralQuality: "alt-lst-bridged-or-mixed",
    collateral: "USDC and USDT bridged to Blast L2; yield from Maker DSR and T-bills",
    pegMechanism: "Automatic rebasing with yield from underlying centralized stablecoin strategies",
    links: [
      { label: "Website", url: "https://blast.io/" },
      { label: "Twitter", url: "https://x.com/Blast_L2" },
      { label: "Docs", url: "https://docs.blast.io/" },
    ],
    chainTier: "stage1-l2",
    contracts: [
      { chain: "blast", address: "0x4300000000000000000000000000000000000003", decimals: 18 },
    ],
    reserves: [
      { name: "DAI / sDAI (via MakerDAO DSR)", pct: 60, risk: "low" },
      { name: "USDC (bridged)", pct: 25, risk: "low" },
      { name: "USDT (bridged)", pct: 15, risk: "low" },
    ],
  }),
  usd("225", "Zoth ZeUSD", "ZeUSD", "rwa-backed", "centralized", {
    rwa: true,
    geckoId: "zeusd",
    collateral: "U.S. Treasury bills, ETFs, money market funds, and reverse repos (off-chain), and tokenized on-chain RWAs (e.g., Hashnote USYC, Matrixdock STBT, OpenEden TBILL); held in smart contract escrow vaults or traditional/omnibus escrow accounts",
    pegMechanism: "CDP: users deposit eligible RWA collateral to mint ZeUSD; peg maintained through LTV ratios and collateral redemption (repay ZeUSD to reclaim collateral)",
    links: [
      { label: "Website", url: "https://zoth.io/" },
      { label: "Twitter", url: "https://x.com/zothdotio" },
      { label: "Docs", url: "https://docs.zoth.io/zoth/products/zeusd-an-omni-chain-and-composable-stable-token" },
      { label: "Discord", url: "https://discord.com/invite/s9WC5nHeAZ" },
      { label: "Telegram", url: "https://t.me/zothio" },
    ],
    jurisdiction: { country: "Cayman Islands" },
    contracts: [
      { chain: "ethereum", address: "0x7dc9748da8e762e569f9269f48f69a1a9f8ea761", decimals: 6 },
    ],
    reserves: [
      { name: "Tokenized U.S. T-Bills & MMFs (USYC, STBT, TBILL, ZTLN-P)", pct: 70, risk: "low" },
      { name: "Other tokenized RWAs (USD0++, Wrapped M)", pct: 30, risk: "medium" },
    ],
  }),
  eur("101", "Monerium EUR emoney", "EURE", "rwa-backed", "centralized", {
    geckoId: "monerium-eur-money-2",
    deploymentModel: "native-multichain",
    collateral: "Euro deposits held in segregated accounts with credit institutions and high-quality liquid assets (HQLA) denominated in EUR, separated from Monerium's own funds; over 100% backing maintained as required under MiCA",
    pegMechanism: "Mint-and-burn: EURe is minted when users deposit EUR via SEPA bank transfer after KYC/AML verification, and burned upon redemption back to EUR; peg maintained by licensed EMI with 1:1 backing",
    proofOfReserves: { type: "self-reported", url: "https://monerium.com/financial-information/" },
    links: [
      { label: "Website", url: "https://monerium.com/" },
      { label: "Twitter", url: "https://x.com/monerium" },
      { label: "Docs", url: "https://monerium.dev/docs/welcome" },
    ],
    jurisdiction: { country: "Iceland", regulator: "Financial Supervisory Authority of the Central Bank of Iceland", license: "Electronic Money Institution (EMI)" },
    contracts: [
      { chain: "ethereum", address: "0x39b8b6385416f4ca36a20319f70d28621895279d", decimals: 18 },
      { chain: "gnosis", address: "0x420ca0f9b9b604ce0fd9c18ef134c705e5fa3430", decimals: 18 },
      { chain: "linea", address: "0x3ff47c5bf409c86533fe1f4907524d304062428d", decimals: 18 },
      { chain: "scroll", address: "0xd7bb130a48595fcdf9480e36c1ae97ff2938ac21", decimals: 18 },
      { chain: "arbitrum", address: "0x0c06ccf38114ddfc35e07427b9424adcca9f44f8", decimals: 18 },
      { chain: "polygon", address: "0xe0aea583266584dafbb3f9c3211d5588c73fea8d", decimals: 18 },
      { chain: "osmosis", address: "ibc/92AE2F53284505223A1BB80D132F859A00E190C6A738772F0B3EF65E20BA484F", decimals: 6 },
    ],
    reserves: [
      { name: "State Street EUR Liquidity LVNAV Fund (AAA-rated)", pct: 70, risk: "very-low" },
      { name: "EUR bank deposits (Arion Bank, LHV Bank)", pct: 30, risk: "very-low" },
    ],
  }),
  usd("230", "Noon USN", "USN", "crypto-backed", "centralized-dependent", {
    geckoId: "noon-usn",
    dependencies: [{ id: "1", weight: 0.4 }, { id: "2", weight: 0.4 }],
    collateralQuality: "exotic",
    custodyModel: "institutional",
    collateral: "USDC/USDT deposits and short-term U.S. Treasury bills via custodians (Ceffu, Alpaca)",
    pegMechanism: "1:1 mint/redeem against USDC/USDT; delta-neutral yield strategies on centralized exchanges",
    jurisdiction: { country: "British Virgin Islands" },
    links: [
      { label: "Website", url: "https://noon.capital" },
      { label: "Twitter", url: "https://x.com/noon_capital" },
      { label: "Docs", url: "https://docs.noon.capital" },
    ],
    proofOfReserves: { type: "real-time", url: "https://noon.accountable.capital/", provider: "Accountable" },
    contracts: [
      { chain: "ethereum", address: "0xda67b4284609d2d48e5d10cfac411572727dc1ed", decimals: 18 },
    ],
    reserves: [
      { name: "USDC/USDT (1:1 backing)", pct: 40, risk: "low" },
      { name: "U.S. Treasury Bills", pct: 30, risk: "very-low" },
      { name: "Delta-neutral funding rate arbitrage positions", pct: 20, risk: "high" },
      { name: "CLOs & Private Credit Funds", pct: 10, risk: "high" },
    ],
  }),
  usd("185", "Gyroscope GYD", "GYD", "crypto-backed", "centralized-dependent", {
    geckoId: "gyroscope-gyd",
    deploymentModel: "canonical-bridge",
    dependencies: [{ id: "2", weight: 0.35 }, { id: "5", weight: 0.35 }],
    collateral: "Diversified reserve of sDAI, USDC, LUSD, and crvUSD in yield-generating vaults",
    pegMechanism: "Primary-market AMM (PAMM) adjusts redemption prices based on reserve ratio",
    links: [
      { label: "Website", url: "https://www.gyro.finance/" },
      { label: "Twitter", url: "https://x.com/GyroStable" },
      { label: "Docs", url: "https://docs.gyro.finance/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xe07f9d810a48ab5c3c914ba3ca53af14e4491e8a", decimals: 18 },
      { chain: "polygon",  address: "0xca5d8f8a8d49439357d3cf46ca2e720702f132b8", decimals: 18 },
    ],
    collateralQuality: "alt-lst-bridged-or-mixed",
    reserves: [
      { name: "sDAI (DAI Savings Rate)", pct: 40, risk: "low" },
      { name: "USDC (via Aave/Flux)", pct: 30, risk: "low" },
      { name: "LUSD (AMM strategies)", pct: 15, risk: "medium" },
      { name: "crvUSD (AMM strategies)", pct: 15, risk: "medium" },
    ],
  }),
  usd("329", "Nectar", "NECT", "crypto-backed", "centralized-dependent", {
    geckoId: "nectar",
    dependencies: [{ id: "1", weight: 0.05 }, { id: "2", weight: 0.05 }],
    collateral: "Berachain-native assets: WBERA, iBGT, pumpBTC, solvBTC, uniBTC, beraETH, Stakestone ETH, WETH, ylstETH, rsETH, and Kodiak Island LP pairs (WBTC-HONEY, WETH-HONEY, WETH-WBTC)",
    pegMechanism: "Overcollateralized CDP with redemption for collateral at $1 face value (Liquity-style); operates on Berachain (not Ethereum or a Stage 1 L2)",
    links: [
      { label: "Website", url: "https://www.beraborrow.com/" },
      { label: "Twitter", url: "https://x.com/beraborrow" },
      { label: "Docs", url: "https://beraborrow.gitbook.io/docs" },
    ],
    jurisdiction: { country: "Croatia" },
    chainTier: "unproven",
    collateralQuality: "exotic",
    contracts: [
      { chain: "berachain", address: "0x1ce0a25d13ce4d52071ae7e02cf1f6606f4c79d3", decimals: 18 },
    ],
    reserves: [
      { name: "iBGT (Infrared liquid staked BGT)", pct: 40, risk: "high" },
      { name: "iBERA / WBERA (Berachain native)", pct: 25, risk: "high" },
      { name: "Wrapped BTC variants (pumpBTC, solvBTC, uniBTC)", pct: 15, risk: "high" },
      { name: "ETH variants (beraETH, WETH, ylstETH, rsETH)", pct: 10, risk: "high" },
      { name: "Kodiak LP positions (WBTC-HONEY, WETH-HONEY, WETH-WBTC)", pct: 10, risk: "high" },
    ],
  }),

  // ── Rank 91-100 ──────────────────────────────────────────────────────
  usd("106", "Electronic USD", "EUSD", "crypto-backed", "centralized-dependent", {
    geckoId: "electronic-usd",
    deploymentModel: "native-multichain",
    dependencies: [{ id: "1", weight: 0.33 }, { id: "2", weight: 0.67 }],
    collateral: "Diversified basket of yield-bearing stablecoin derivatives: Aave V3 USDC, Compound V3 USDC, and Compound V3 USDT; RSR stakers provide first-loss overcollateralization",
    pegMechanism: "Permissionless 1:1 mint and redemption against underlying collateral basket; RSR stakers absorb first losses in case of collateral default; basket rebalances via Dutch/batch auctions",
    links: [
      { label: "Website", url: "https://reserve.org/" },
      { label: "Twitter", url: "https://x.com/reserveprotocol" },
      { label: "Docs", url: "https://docs.reserve.org/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xa0d69e286b938e21cbf7e51d71f6a4c8918f482f", decimals: 18 },
      { chain: "base", address: "0xcfa3ef56d303ae4faaba0592388f19d7c3399fb4", decimals: 18 },
      { chain: "arbitrum", address: "0x12275dcb9048680c4be40942ea4d92c74c63b844", decimals: 18 },
    ],
    proofOfReserves: { type: "real-time", url: "https://app.reserve.org/ethereum/token/0xa0d69e286b938e21cbf7e51d71f6a4c8918f482f/overview" },
    collateralQuality: "exotic",
    reserves: [
      { name: "Compound V3 USDC (cUSDCv3)", pct: 33, risk: "low" },
      { name: "Aave V3 USDC (aUSDCv3)", pct: 33, risk: "low" },
      { name: "Compound V3 USDT (cUSDTv3)", pct: 34, risk: "low" },
    ],
  }),
  usd("154", "Bucket Protocol BUCK", "BUCK", "crypto-backed", "centralized-dependent", {
    geckoId: "bucket-protocol-buck-stablecoin",
    dependencies: [{ id: "1", weight: 0.2 }, { id: "2", weight: 0.2 }],
    collateral: "SUI, BTC, ETH, and LSTs via CDPs; USDC/USDT via Peg Stability Module",
    pegMechanism: "Overcollateralized CDPs with per-asset minimum collateral ratios (e.g. 110% for SUI); hard peg via direct BUCK redemption for collateral with dynamic redemption fee; soft peg via PSM enabling 1:1 swaps with USDC/USDT; liquidations via Tank module",
    links: [
      { label: "Website", url: "https://www.bucketprotocol.io/" },
      { label: "Twitter", url: "https://x.com/bucket_protocol" },
      { label: "Docs", url: "https://docs.bucketprotocol.io/" },
    ],
    contracts: [
      { chain: "sui", address: "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK", decimals: 9 },
    ],
    chainTier: "established-alt-l1",
    collateralQuality: "alt-lst-bridged-or-mixed",
    reserves: [
      { name: "SUI (native token CDPs)", pct: 45, risk: "high" },
      { name: "USDC/USDT (via PSM)", pct: 25, risk: "low" },
      { name: "BTC (wrapped, via CDPs)", pct: 15, risk: "medium" },
      { name: "ETH & LSTs (via CDPs)", pct: 15, risk: "low" },
    ],
  }),
  eur("55", "EURA", "EURA", "crypto-backed", "centralized-dependent", {
    geckoId: "ageur",
    deploymentModel: "third-party-bridge",
    dependencies: [{ id: "2", weight: 0.30 }],
    collateral: "Overcollateralized basket of Euro-denominated RWAs (tokenized T-bills and government/corporate bonds via Backed Finance: bC3M, bERNX, bIB01), EURC, and crypto assets (wETH, wBTC) managed via the Transmuter module",
    pegMechanism: "Transmuter module enables 1:1 slippage-free swaps between EURA and whitelisted Euro collateral assets; dynamic fees and circuit breakers rebalance reserves; over-collateralization from Borrowing Module CDPs provides additional buffer",
    proofOfReserves: { type: "self-reported", url: "https://analytics.angle.money/", provider: "Angle Protocol" },
    links: [
      { label: "Website", url: "https://www.angle.money/eura" },
      { label: "Twitter", url: "https://x.com/AngleProtocol" },
      { label: "Docs", url: "https://docs.angle.money/" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
    contracts: [
      { chain: "ethereum", address: "0x1a7e4e63778b4f12a199c062f3efdd288afcbce8", decimals: 18 },
      { chain: "arbitrum", address: "0xfa5ed56a203466cbbc2430a43c66b9d8723528e7", decimals: 18 },
      { chain: "polygon", address: "0xe0b52e49357fd4daf2c15e02058dce6bc0057db4", decimals: 18 },
      { chain: "gnosis", address: "0x4b1e2c2762667331bc91648052f646d1b0d35984", decimals: 18 },
      { chain: "bsc", address: "0x12f31b73d812c6bb0d735a218c086d44d5fe5f89", decimals: 18 },
      { chain: "base", address: "0xa61beb4a3d02decb01039e378237032b351125b4", decimals: 18 },
      { chain: "celo", address: "0xc16b81af351ba9e64c1a069e3ab18c244a1e3049", decimals: 18 },
    ],
    collateralQuality: "alt-lst-bridged-or-mixed",
    reserves: [
      { name: "bC3M (Amundi Euro Govt Bills 0-6M ETF, tokenized by Backed)", pct: 40, risk: "medium" },
      { name: "bERNX (BlackRock Euro Corp Bonds ETF, tokenized by Backed)", pct: 20, risk: "medium" },
      { name: "EURC (Circle Euro stablecoin)", pct: 20, risk: "low" },
      { name: "wETH, wBTC (crypto collateral from Borrowing Module)", pct: 15, risk: "medium" },
      { name: "bHIGH (BlackRock Euro High Yield Corp Bonds ETF, tokenized)", pct: 5, risk: "medium" },
    ],
  }),
  usd("303", "Mezo USD", "meUSD", "crypto-backed", "decentralized", {
    geckoId: "mezo-usd",
    tags: ["Liquity v1 fork"],
    dependencies: [],
    collateral: "Bitcoin only; minimum 110% collateral ratio",
    pegMechanism: "BTC-only overcollateralized CDP with direct $1 BTC redemption; operates on Mezo (Bitcoin L2, not Ethereum or a Stage 1 L2)",
    links: [
      { label: "Website", url: "https://mezo.org/" },
      { label: "Twitter", url: "https://x.com/MezoNetwork" },
      { label: "Docs", url: "https://mezo.org/docs/users/musd" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xdd468a1ddc392dcdbef6db6e34e89aa338f9f186", decimals: 18 },
    ],
    chainTier: "unproven",
    collateralQuality: "alt-lst-bridged-or-mixed",
    reserves: [
      { name: "Bitcoin (BTC) — native and wrapped variants (tBTC, WBTC, SolvBTC, cbBTC)", pct: 100, risk: "medium" },
    ],
  }),
  usd("305", "XSY UTY", "UTY", "crypto-backed", "centralized-dependent", {
    geckoId: "unity-2",
    dependencies: [{ id: "2", weight: 1.0, type: "wrapper" }],
    collateral: "USDC deposits hedged via delta-neutral pairing of long AVAX spot positions with short perpetual futures; yield generated from perpetual contract funding rates; custody via Ceffu & Copper Clearloop",
    pegMechanism: "Users deposit USDC to mint UTY at 1:1; XSY maintains peg by delta-neutral hedging with long AVAX spot and short perpetual futures positions; users redeem UTY back to USDC after a 7-day unbonding period",
    links: [
      { label: "Website", url: "https://xsy.fi/" },
      { label: "Twitter", url: "https://x.com/xsy_fi" },
      { label: "Docs", url: "https://xsy-1.gitbook.io/xsy-main" },
    ],
    contracts: [
      { chain: "avalanche", address: "0xdbc5192a6b6ffee7451301bb4ec312f844f02b4a", decimals: 18 },
    ],
    chainTier: "established-alt-l1",
    collateralQuality: "exotic",
    custodyModel: "cex",
    reserves: [
      { name: "USDC deposits (initial user deposits)", pct: 30, risk: "low" },
      { name: "Long AVAX spot positions", pct: 35, risk: "high" },
      { name: "Short AVAX perpetual futures (delta-neutral hedge)", pct: 35, risk: "high" },
    ],
  }),
  eur("51", "Stasis Euro", "EURS", "rwa-backed", "centralized", {
    geckoId: "stasis-eurs",
    deploymentModel: "native-multichain",
    collateral: "100% liquid euro balances held at licensed European financial institutions (EXT LTD, XNT LTD, UAB NexPay), including Central Bank accounts",
    pegMechanism: "Direct 1:1 redemption through STSS (Malta) Limited; users send EURS to the treasury wallet, euros are transferred from a segregated bank account, and redeemed tokens are frozen or burned",
    proofOfReserves: { type: "independent-audit", url: "https://stasis.net/transparency", provider: "BDO Malta" },
    links: [
      { label: "Website", url: "https://stasis.net/" },
      { label: "Twitter", url: "https://x.com/stasisnet" },
      { label: "GitHub", url: "https://github.com/STASISNET/STASIS-EURS-token-smart-contract" },
    ],
    jurisdiction: { country: "Malta", regulator: "MFSA", license: "MiCA" },
    contracts: [
      { chain: "ethereum", address: "0xdb25f211ab05b1c97d595516f45794528a807ad8", decimals: 2 },
      { chain: "polygon", address: "0xe111178a87a3bff0c8d18decba5798827539ae99", decimals: 2 },
    ],
  }),
  // USD+ (id 46) removed — protocol abandoned 2025 (see cemetery)
  // FUSD removed — Fantom USD de-pegged 2022, zombie stablecoin (see cemetery)
  usd("326", "Metronome Synth USD", "MSUSD", "crypto-backed", "centralized-dependent", {
    geckoId: "metronome-synth-usd",
    deploymentModel: "third-party-bridge",
    dependencies: [{ id: "2", weight: 0.3 }, { id: "5", weight: 0.25 }, { id: "6", weight: 0.15 }],
    collateral: "USDC, DAI, ETH, WBTC, sfrxETH, and Vesper Finance yield-bearing tokens (vaUSDC, vaETH, vaSTETH, vaRETH, vaCBETH); FRAX and vaFRAX accepted but currently inactive; collateral factors range 75–85%",
    pegMechanism: "Overcollateralized CDP: users deposit crypto collateral (CF 75–85%) to mint msUSD at a fixed 1% annual fee; no direct redemption — only debt repayment to reclaim collateral. Peg maintained by zero-slippage intra-protocol synth swaps (Synth Marketplace) that arbitrageurs exploit when msUSD trades below par, plus collateral-provider buybacks of discounted msUSD",
    links: [
      { label: "Website", url: "https://metronome.io/" },
      { label: "Twitter", url: "https://x.com/MetronomeDAO" },
      { label: "Docs", url: "https://docs.metronome.io/metronome-synth/metronome-synth-protocol" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xab5eb14c09d416f0ac63661e57edb7aecdb9befa", decimals: 18 },
      { chain: "optimism", address: "0x9dabae7274d28a45f0b65bf8ed201a5731492ca0", decimals: 18 },
      { chain: "base",     address: "0x526728dbc96689597f85ae4cd716d4f7fccbae9d", decimals: 18 },
      { chain: "plasma",   address: "0x29ad7fe4516909b9e498b5a65339e54791293234", decimals: 18 },
    ],
    collateralQuality: "alt-lst-bridged-or-mixed",
    reserves: [
      { name: "USDC", pct: 30, risk: "low" },
      { name: "DAI", pct: 20, risk: "low" },
      { name: "Vesper yield tokens (vaUSDC, vaETH, vaSTETH, vaRETH, vaCBETH)", pct: 25, risk: "high" },
      { name: "ETH / WBTC / sfrxETH", pct: 20, risk: "medium" },
      { name: "FRAX / vaFRAX (inactive)", pct: 5, risk: "high" },
    ],
  }),
  // ── Additional tracked ─────────────────────────────────────────────
  usd("346", "Neutrl USD", "NUSD", "crypto-backed", "centralized-dependent", {
    geckoId: "nusd-2",
    dependencies: [{ id: "1", weight: 0.2 }, { id: "2", weight: 0.2 }],
    collateralQuality: "exotic",
    custodyModel: "institutional",
    collateral: "OTC-discounted locked token allocations sourced via STIX with delta-neutral perpetual futures hedges, plus liquid stablecoin reserves (USDC, USDT, USDS, USDe) held at institutional custodians (Fireblocks, Copper, Ceffu)",
    pegMechanism: "1:1 mint and redeem via permissionless router using USDC, USDT, or USDe; peg maintained by arbitrage incentives, delta hedging of derivatives positions, and rapid reserve deployment from liquid stablecoin buffer",
    links: [
      { label: "Website", url: "https://www.neutrl.fi/" },
      { label: "Twitter", url: "https://x.com/Neutrl" },
      { label: "Docs", url: "https://docs.neutrl.fi/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xe556aba6fe6036275ec1f87eda296be72c811bce", decimals: 18 },
    ],
    proofOfReserves: { type: "real-time", url: "https://accountable.neutrl.fi/", provider: "Accountable" },
    reserves: [
      { name: "Delta-neutral basis/funding trades (perp futures)", pct: 60, risk: "high" },
      { name: "Liquid stablecoin reserves (USDC, USDT, USDS, USDe)", pct: 20, risk: "low" },
      { name: "Hedged OTC locked-token positions (via STIX)", pct: 20, risk: "high" },
    ],
  }),
  usd("344", "Yuzu USD", "YZUSD", "crypto-backed", "centralized-dependent", {
    geckoId: "yuzu-usd",
    dependencies: [{ id: "1", weight: 0.7, type: "wrapper" }],
    collateral: "Overcollateralized by diversified on-chain DeFi yield strategies (leveraged loops, Pendle liquidity, Euler lending markets) deployed on Plasma chain; backed by >$1 in on-chain assets per yzUSD",
    pegMechanism: "Eligible investors (accredited/institutional, KYC/AML required) mint/redeem at 1:1 with USDT0; peg maintained by overcollateralization and risk tranching via yzPP junior tranche absorbing first losses",
    links: [
      { label: "Website", url: "https://yuzu.money/" },
      { label: "Twitter", url: "https://x.com/YuzuMoneyX" },
      { label: "Docs", url: "https://yuzu-money.gitbook.io/yuzu-money" },
      { label: "Proof of Reserve", url: "https://yuzu.accountable.capital/" },
    ],
    proofOfReserves: { type: "real-time", url: "https://yuzu.accountable.capital/", provider: "Accountable" },
    contracts: [
      { chain: "plasma", address: "0x6695c0f8706c5ace3bdf8995073179cca47926dc", decimals: 18 },
    ],
    chainTier: "unproven",
    collateralQuality: "exotic",
    reserves: [
      { name: "Pendle PT/LP positions (leveraged DeFi yield)", pct: 50, risk: "high" },
      { name: "Euler/Morpho lending positions", pct: 20, risk: "high" },
      { name: "Other DeFi strategies (Equilibria, Penpie, AutoFinance, TermFinance)", pct: 20, risk: "high" },
      { name: "USDT0 / stablecoin liquidity buffer", pct: 10, risk: "low" },
    ],
  }),
  usd("335", "JupUSD", "JUPUSD", "rwa-backed", "centralized-dependent", {
    rwa: true,
    geckoId: "jupusd",
    cmcSlug: "jupusd",
    collateral: "90% USDtb (BlackRock BUIDL tokenized U.S. Treasuries issued by Ethena under GENIUS-compliant framework, custodied by Porto/Anchorage Digital) and 10% USDC liquidity buffer",
    pegMechanism: "Reserve-backed 1:1 mint and redeem on Solana against USDC; Ethena manages day-to-day reserve operations (custody, bridging, rebalancing between USDtb and USDC)",
    links: [
      { label: "Website", url: "https://jupusd.money/" },
      { label: "Twitter", url: "https://x.com/JupiterExchange" },
    ],
    chainTier: "established-alt-l1",
    custodyModel: "institutional",
    contracts: [
      { chain: "solana", address: "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD", decimals: 6 },
    ],
    reserves: [
      { name: "USDtb (BlackRock BUIDL tokenized U.S. Treasuries)", pct: 90, risk: "low", coinId: "221" },
      { name: "USDC liquidity buffer", pct: 10, risk: "low", coinId: "2" },
    ],
  }),
  usd("342", "MegaUSD", "USDM", "rwa-backed", "centralized-dependent", {
    rwa: true, geckoId: "megausd",
    collateral: "~90% USDtb (BlackRock BUIDL tokenized Treasuries via Securitize) with liquid stablecoins for redemptions",
    pegMechanism: "Issued on Ethena's USDtb rails; reserve yield funds MegaETH sequencer costs",
    links: [
      { label: "Website", url: "https://www.megaeth.com/" },
      { label: "Twitter", url: "https://x.com/megaeth" },
      { label: "Docs", url: "https://docs.megaeth.com" },
    ],
    custodyModel: "institutional",
    contracts: [
      { chain: "megaeth", address: "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7", decimals: 18 },
    ],
    reserves: [
      { name: "USDtb (BlackRock BUIDL tokenized U.S. Treasuries via Securitize)", pct: 90, risk: "low", coinId: "221" },
      { name: "Liquid stablecoins (USDC/USDT) for redemptions", pct: 10, risk: "low", coinId: "2" },
    ],
  }),
  usd("343", "Tether USA-T", "USAT", "rwa-backed", "centralized", {
    geckoId: "usa",
    collateral: "U.S. Treasury bills and cash deposits held by Cantor Fitzgerald as reserve custodian; issued 1:1 by Anchorage Digital Bank, N.A. under GENIUS Act federal regulation",
    pegMechanism: "Direct 1:1 redemption through Tether/Anchorage Digital Bank",
    links: [
      { label: "Website", url: "https://usat.io/" },
      { label: "Twitter", url: "https://x.com/usat" },
    ],
    jurisdiction: { country: "United States", regulator: "OCC", license: "Federal Bank Charter" },
    contracts: [
      { chain: "ethereum", address: "0x07041776f5007aca2a54844f50503a18a72a8b68", decimals: 6 },
    ],
    reserves: [
      { name: "U.S. Treasury bills", pct: 80, risk: "very-low" },
      { name: "Cash deposits", pct: 20, risk: "very-low" },
    ],
  }),
  usd("24", "Celo Dollar", "cUSD", "algorithmic", "centralized-dependent", {
    geckoId: "celo-dollar",
    deploymentModel: "third-party-bridge",
    dependencies: [{ id: "1", weight: 0.05 }, { id: "2", weight: 0.05 }],
    collateral: "Mento reserve holding sUSDS (~57%), EURC (~23%), CELO (~11%), and smaller positions in USDGLO, stETH, USDT, USDC, and ETH; overcollateralized at ~1.36×",
    pegMechanism: "Mento AMM: users mint cUSD by sending $1 of reserve collateral, burn to receive equivalent value; oracle-driven arbitrage restores peg; circuit breakers enforce safety bounds",
    links: [
      { label: "Website", url: "https://celo.org/" },
      { label: "Twitter", url: "https://x.com/celoorg" },
      { label: "Docs", url: "https://docs.mento.org/mento/overview/core-concepts/the-reserve" },
    ],
    jurisdiction: { country: "Germany" },
    contracts: [
      { chain: "celo", address: "0x765de816845861e75a25fca122bb6898b8b1282a", decimals: 18 },
      { chain: "near", address: "cusd.token.a11bd.near", decimals: 24 },
    ],
    proofOfReserves: { type: "self-reported", url: "https://reserve.mento.org/" },
    chainTier: "established-alt-l1",
    collateralQuality: "alt-lst-bridged-or-mixed",
    reserves: [
      { name: "sUSDS (Sky/Maker yield-bearing stablecoin)", pct: 56, risk: "low" },
      { name: "EURC (Circle euro stablecoin)", pct: 22, risk: "low" },
      { name: "CELO (native token)", pct: 12, risk: "high" },
      { name: "USDGLO (Glo Dollar)", pct: 4, risk: "low" },
      { name: "stETH (Lido staked ETH)", pct: 2, risk: "low" },
      { name: "USDC", pct: 1, risk: "low" },
      { name: "USDT", pct: 1, risk: "low" },
      { name: "ETH", pct: 1, risk: "very-low" },
    ],
  }),
  usd("20", "Alchemix USD", "ALUSD", "crypto-backed", "decentralized", {
    geckoId: "alchemix-usd",
    deploymentModel: "third-party-bridge",
    dependencies: [{ id: "1", weight: 0.33 }, { id: "2", weight: 0.33 }, { id: "5", weight: 0.33 }],
    collateral: "DAI, USDC, and USDT deposited into yield strategies (Yearn, Aave) via Alchemix CDPs; yield automatically repays debt",
    pegMechanism: "Self-repaying loans: yield from deposited stablecoin collateral automatically repays debt; Transmuter guarantees 1:1 redemption",
    links: [
      { label: "Website", url: "https://alchemix.fi/" },
      { label: "Docs", url: "https://v2-docs.alchemix.fi/" },
      { label: "GitHub", url: "https://github.com/alchemix-finance" },
      { label: "Twitter", url: "https://x.com/alchemixfi" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xbc6da0fe9ad5f3b0d58160288917aa56653660e9", decimals: 18 },
      { chain: "arbitrum", address: "0xcb8fa9a76b8e203d8c3797bf438d8fb81ea3326a", decimals: 18 },
      { chain: "optimism", address: "0xcb8fa9a76b8e203d8c3797bf438d8fb81ea3326a", decimals: 18 },
      { chain: "fantom", address: "0xb67fa6defce4042070eb1ae1511dcd6dcc6a532e", decimals: 18 },
      { chain: "metis",   address: "0x303241e2b3b4aed0bb0f8623e7442368fed8faf3", decimals: 18 },
    ],
    collateralQuality: "exotic",
    reserves: [
      { name: "DAI (in Yearn/Aave yield strategies)", pct: 35, risk: "medium" },
      { name: "USDC (in Yearn/Aave yield strategies)", pct: 35, risk: "medium" },
      { name: "USDT (in Yearn/Aave yield strategies)", pct: 30, risk: "medium" },
    ],
  }),
  usd("251", "Felix feUSD", "FEUSD", "crypto-backed", "decentralized", {
    geckoId: "felix-feusd",
    tags: ["Liquity v2 fork"],
    dependencies: [],
    collateral: "HYPE, kHYPE, wstHYPE, UBTC (feUBTC), ETH, and SOL via overcollateralized CDPs on Hyperliquid (Liquity V2 fork)",
    pegMechanism: "Overcollateralized CDP (Liquity V2 fork) with direct redemption for $1 of collateral; interest-rate-sorted redemption queue (lower-rate positions redeemed first); stability pools absorb liquidations",
    links: [
      { label: "Website", url: "https://usefelix.xyz/" },
      { label: "Twitter", url: "https://x.com/felixprotocol" },
      { label: "Docs", url: "https://usefelix.gitbook.io/docs" },
    ],
    contracts: [
      { chain: "hyperevm", address: "0x02c6a2fa58cc01a18b8d9e00ea48d65e4df26c70", decimals: 18 },
    ],
    chainTier: "unproven",
    collateralQuality: "alt-lst-bridged-or-mixed",
    reserves: [
      { name: "HYPE / kHYPE / wstHYPE (Hyperliquid native + LSTs)", pct: 60, risk: "very-high" },
      { name: "BTC (bridged UBTC)", pct: 15, risk: "medium" },
      { name: "ETH (bridged)", pct: 15, risk: "medium" },
      { name: "SOL (bridged)", pct: 10, risk: "high" },
    ],
  }),
  usd("348", "Fidelity Digital Dollar", "FIDD", "rwa-backed", "centralized", {
    geckoId: "fidelity-digital-dollar",
    collateral: "Cash, U.S. Treasury securities, and cash equivalents held at The Bank of New York Mellon",
    pegMechanism: "Direct 1:1 redemption through Fidelity Digital Assets platforms",
    proofOfReserves: { type: "independent-audit", url: "https://www.fidelitydigitalassets.com/stablecoin", provider: "PricewaterhouseCoopers" },
    links: [
      { label: "Website", url: "https://www.fidelitydigitalassets.com/stablecoin" },
      { label: "Twitter", url: "https://x.com/DigitalAssets" },
      { label: "Docs", url: "https://www.fidelitydigitalassets.com/stablecoin-developer-resources" },
    ],
    jurisdiction: { country: "United States", regulator: "OCC", license: "National Trust Bank Charter" },
    contracts: [
      { chain: "ethereum", address: "0x7c135549504245b5eae64fc0e99fa5ebabb8e35d", decimals: 18 },
    ],
    reserves: [
      { name: "U.S. Treasury securities (short-term)", pct: 80, risk: "very-low" },
      { name: "Cash and cash equivalents", pct: 20, risk: "very-low" },
    ],
  }),
  usd("347", "USDGO", "USDGO", "rwa-backed", "centralized", {
    geckoId: "usdgo",
    collateral: "U.S. Treasuries and high-quality liquid assets held by Anchorage Digital Bank",
    pegMechanism: "1:1 USD redemption through Anchorage Digital Bank under U.S. federal oversight",
    links: [
      { label: "Website", url: "https://www.usdgo.com/" },
      { label: "Twitter", url: "https://x.com/osldotcom" },
    ],
    jurisdiction: { country: "United States", regulator: "OCC", license: "Federal Bank Charter" },
    contracts: [
      { chain: "solana", address: "72puLt71H93Z9CzHuBRTwFpL4TG3WZUhnoCC7p8gxigu", decimals: 6 },
    ],
    reserves: [
      { name: "U.S. Treasury bills", pct: 80, risk: "very-low" },
      { name: "Cash and cash equivalents", pct: 20, risk: "very-low" },
    ],
  }),
  usd("297", "Main Street USD", "MSUSD", "crypto-backed", "centralized-dependent", {
    geckoId: "main-street-usd",
    dependencies: [{ id: "2", weight: 1.0, type: "wrapper" }],
    collateral: "USDC held 1:1 as reserve; yield generated by deploying USDC into delta-neutral options volatility arbitrage strategies (options box spreads) on centralized exchanges via msY staking",
    pegMechanism: "Direct 1:1 redemption for USDC; peg maintained by full USDC reserve backing; yield accrues to stakers (msY) not to msUSD holders",
    links: [
      { label: "Website", url: "https://mainstreet.finance/" },
      { label: "Twitter", url: "https://x.com/Main_St_Finance" },
      { label: "Docs", url: "https://mainstreet-finance.gitbook.io/mainstreet.finance/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x4ba01f22827018b4772cd326c7627fb4956a7c00", decimals: 18 },
    ],
    collateralQuality: "exotic",
    custodyModel: "cex",
    reserves: [
      { name: "USDC (1:1 backing)", pct: 100, risk: "low" },
    ],
  }),
  usd("215", "Moneta", "USDM", "rwa-backed", "centralized", {
    geckoId: "usdm-2",
    collateral: "USD bank deposits and money market funds managed by Fidelity and Western Asset Management (Moneta/USA issuance) and Sparebanken Norge / Amundi USD MM fund (NBX/EEA issuance), held in segregated reserve accounts",
    pegMechanism: "Direct 1:1 redemption through Moneta (USA) or NBX (EEA); KYC required; Charli3 oracle verifies reserve backing on-chain before each mint on Cardano",
    proofOfReserves: { type: "real-time", url: "https://portal.charli3.io/dev/feeds/usdm-reserves?network=Mainnet", provider: "Charli3" },
    links: [
      { label: "Website", url: "https://moneta.global/" },
      { label: "Twitter", url: "https://x.com/USDMOfficial" },
    ],
    jurisdiction: { country: "Norway", regulator: "Finanstilsynet", license: "MiCA E-Money Token (EMT)" },
    chainTier: "established-alt-l1",
    reserves: [
      { name: "USD bank deposits", pct: 40, risk: "very-low" },
      { name: "Money market funds (Fidelity / Amundi)", pct: 60, risk: "very-low" },
    ],
  }),
  usd("312", "Hydrated Dollar", "HOLLAR", "crypto-backed", "centralized-dependent", {
    geckoId: "hydrated-dollar",
    dependencies: [{ id: "1", weight: 0.15 }, { id: "2", weight: 0.15 }],
    collateral: "Overcollateralized by DOT, ETH, vDOT, WBTC, tBTC, USDT, USDC, and giga-token variants (GIGADOT, GIGAETH) on the Hydration appchain; built on Aave v3-forked code",
    pegMechanism: "Overcollateralized CDP with automated partial liquidations per block; peg stabilized by the HOLLAR Stability Module (HSM), which enables direct stablecoin swaps near $1 and deploys received stablecoins into yield strategies",
    links: [
      { label: "Website", url: "https://hydration.net/" },
      { label: "Twitter", url: "https://x.com/hydration_net" },
      { label: "Docs", url: "https://docs.hydration.net/quick_start/hollar/" },
      { label: "GitHub", url: "https://github.com/galacticcouncil" },
    ],
    contracts: [
      { chain: "hydration", address: "0x531a654d1696ed52e7275a8cede955e82620f99a", decimals: 18 },
    ],
    chainTier: "unproven",
    collateralQuality: "alt-lst-bridged-or-mixed",
    reserves: [
      { name: "DOT", pct: 40, risk: "high" },
      { name: "ETH", pct: 15, risk: "very-low" },
      { name: "vDOT (liquid staked DOT)", pct: 15, risk: "high" },
      { name: "WBTC / tBTC", pct: 10, risk: "medium" },
      { name: "USDT / USDC (stablecoins)", pct: 15, risk: "low" },
      { name: "GIGADOT / GIGAETH", pct: 5, risk: "very-high" },
    ],
  }),
  usd("245", "Anzens USDA", "USDA", "rwa-backed", "centralized", {
    geckoId: "anzens-usda",
    collateral: "USD and dollar-equivalent reserves including U.S. Treasuries, held in segregated accounts custodied by BitGo Trust (Qualified Custodian)",
    pegMechanism: "Direct 1:1 USD redemption through Anzens via KYC-verified bank transfers; minting and burning available to retail and institutional users in eligible U.S. states",
    links: [
      { label: "Website", url: "https://www.anzens.com/" },
      { label: "Twitter", url: "https://x.com/AnzensOfficial" },
    ],
    jurisdiction: { country: "United States", regulator: "FinCEN", license: "Money Service Business (MSB)" },
    reserves: [
      { name: "USD cash deposits", pct: 60, risk: "very-low" },
      { name: "U.S. Treasury securities", pct: 40, risk: "very-low" },
    ],
  }),
  usd("75", "Youves uUSD", "UUSD", "crypto-backed", "centralized-dependent", {
    geckoId: "youves-uusd",
    dependencies: [{ id: "1", weight: 0.2 }],
    collateral: "Overcollateralized by XTZ, tzBTC, USDt, or SIRS (tez/tzBTC LP); target ratios vary by collateral (200% for XTZ, 115% for stablecoins); 300% applied only to legacy v1/v2 vaults",
    pegMechanism: "Overcollateralized CDP on Tezos with variable collateral ratios; liquidations triggered at emergency ratio with 12.5% reward; savings pool provides additional peg stability",
    links: [
      { label: "Website", url: "https://youves.com" },
      { label: "Docs", url: "https://docs.youves.com" },
      { label: "GitHub", url: "https://github.com/youves-com" },
    ],
    contracts: [
      { chain: "tezos", address: "KT1XRPEPXbZK25r3Htzp2o1x7xdMMmfocKNW", decimals: 12 },
    ],
    chainTier: "established-alt-l1",
    collateralQuality: "alt-lst-bridged-or-mixed",
    reserves: [
      { name: "XTZ (Tezos)", pct: 60, risk: "high" },
      { name: "USDt (Tether on Tezos)", pct: 20, risk: "low" },
      { name: "tzBTC (wrapped Bitcoin)", pct: 10, risk: "medium" },
      { name: "SIRS (XTZ/tzBTC LP tokens)", pct: 10, risk: "high" },
    ],
  }),
  usd("327", "Mu Digital AZND", "AZND", "rwa-backed", "centralized", {
    yieldBearing: true, rwa: true, navToken: true,
    geckoId: "mu-digital-aznd",
    collateral: "USD-denominated Asia Pacific RWAs managed by Golden Hill Asset Management (Singapore-regulated): sovereign debt (BBB+ min), investment-grade Asian corporate and bank bonds (BBB- min), speculative-grade industrial bonds (BB min), and direct lending/private credit; muBOND junior tranche overcollateralizes AZND at ~118%",
    pegMechanism: "KYC-gated 1:1 mint using USDC, USDT, or AUSD; redemptions processed weekly (~7 calendar days) per Singapore fund liquidity calendar; muBOND junior tranche absorbs NAV losses first; insurance fund provides additional backstop; permissionless secondary swaps via DEX partners on Monad",
    jurisdiction: { country: "Singapore", license: "Portfolio managed by Golden Hill Asset Management (GHAM), a Singapore-regulated fund manager; assets held in a regulated fund vehicle" },
    links: [
      { label: "Website", url: "https://mudigital.net/" },
      { label: "Twitter", url: "https://x.com/MuDigitalHQ" },
      { label: "Docs", url: "https://docs.mudigital.net" },
      { label: "Proof of Reserve", url: "https://mu.accountable.capital/" },
    ],
    proofOfReserves: { type: "real-time", url: "https://mu.accountable.capital/", provider: "Accountable" },
    contracts: [
      { chain: "monad", address: "0x4917a5ec9fcb5e10f47cbb197abe6ab63be81fe8", decimals: 18 },
    ],
    reserves: [
      { name: "Asian sovereign bonds (BBB+ min)", pct: 30, risk: "high" },
      { name: "Investment-grade Asian corporate/bank bonds (BBB- min)", pct: 35, risk: "high" },
      { name: "High-yield industrial bonds (BB min)", pct: 15, risk: "high" },
      { name: "Private credit / direct lending", pct: 20, risk: "high" },
    ],
  }),
  usd("266", "Plume USD", "pUSD", "rwa-backed", "centralized", {
    geckoId: "plume-usd",
    deploymentModel: "native-multichain",
    collateral: "1:1 backed by USDC and USDT deposited into a Nucleus BoringVault; USD1 and AUSD also approved as collateral",
    pegMechanism: "Zero-fee mint/redeem at 1:1 for USDC on Ethereum or Plume Chain; reserves managed by Nucleus BoringVault contracts with OFAC compliance checks",
    links: [
      { label: "Website", url: "https://plume.org/pusd" },
      { label: "Twitter", url: "https://x.com/plumenetwork" },
      { label: "Docs", url: "https://docs.plume.org/plume/tokens/plume-usd" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xdddd73f5df1f0dc31373357beac77545dc5a6f3f", decimals: 6 },
      { chain: "plume", address: "0xdddd73f5df1f0dc31373357beac77545dc5a6f3f", decimals: 6 },
    ],
    custodyModel: "onchain",
    reserves: [
      { name: "USDC (via Nucleus BoringVault)", pct: 100, risk: "medium" },
    ],
  }),
  usd("234", "Worldwide USD", "WUSD", "rwa-backed", "centralized", {
    geckoId: "worldwide-usd",
    deploymentModel: "native-multichain",
    collateral: "Cash, cash equivalents, and short-term U.S. Treasury bills held in segregated accounts; Basel III-inspired 6% liquidity buffer maintained on non-cash reserves",
    pegMechanism: "Direct 1:1 redemption through WSPN; fiat minted/burned on deposit/withdrawal with reserves verified by independent third-party audits",
    jurisdiction: { country: "British Virgin Islands", regulator: "FinCEN (USA)", license: "MSB registration (USA); VASP license application (BVI)" },
    links: [
      { label: "Website", url: "https://wspn.io/" },
      { label: "Twitter", url: "https://x.com/wspnpayment" },
      { label: "Whitepaper", url: "https://www.wspn.io/Documents/Whitepaper%20for%20WSPN.pdf" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x7cd017ca5ddb86861fa983a34b5f495c6f898c41", decimals: 18 },
      { chain: "polygon", address: "0x7cd017ca5ddb86861fa983a34b5f495c6f898c41", decimals: 18 },
      { chain: "viction", address: "0xba73e59f11597c1c13b0d9114688efb6a6d430f6", decimals: 18 },
    ],
    reserves: [
      { name: "Cash and cash equivalents", pct: 40, risk: "very-low" },
      { name: "Short-term U.S. Treasury bills", pct: 55, risk: "very-low" },
      { name: "Basel III liquidity buffer (6% of non-cash)", pct: 5, risk: "low" },
    ],
  }),
  usd("324", "Brale SBC", "SBC", "rwa-backed", "centralized", {
    deploymentModel: "third-party-bridge",
    collateral: "Cash, cash equivalents, and short-duration U.S. Treasuries held in segregated accounts at regulated financial institutions",
    pegMechanism: "Direct 1:1 redemption through Brale (registered MSB and licensed U.S. money transmitter)",
    jurisdiction: { country: "United States", regulator: "FinCEN", license: "Money Services Business / Money Transmitter" },
    geckoId: "stable-coin-2",
    links: [
      { label: "Website", url: "https://stablecoin.xyz" },
      { label: "Twitter", url: "https://x.com/stablecoin_xyz" },
      { label: "Github", url: "https://github.com/stablecoinxyz" },
      { label: "Proof of Reserve", url: "https://brale.xyz/stablecoins/SBC" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xf9fb20b8e097904f0ab7d12e9dbee88f2dcd0f16", decimals: 18 },
      { chain: "arbitrum", address: "0xfdcc3dd6671eab0709a4c0f3f53de9a333d80798", decimals: 18 },
      { chain: "optimism", address: "0xf9fb20b8e097904f0ab7d12e9dbee88f2dcd0f16", decimals: 18 },
      { chain: "base",     address: "0xfdcc3dd6671eab0709a4c0f3f53de9a333d80798", decimals: 18 },
      { chain: "polygon",  address: "0xfdcc3dd6671eab0709a4c0f3f53de9a333d80798", decimals: 18 },
      { chain: "avalanche", address: "0xf9fb20b8e097904f0ab7d12e9dbee88f2dcd0f16", decimals: 18 },
      { chain: "celo",     address: "0xde093684c796204224bc081f937aa059d903c52a", decimals: 18 },
      { chain: "solana",   address: "DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA", decimals: 9 },
    ],
    proofOfReserves: { type: "independent-audit", url: "https://brale.xyz/stablecoins/SBC", provider: "Abdo" },
    reserves: [
      { name: "Cash and cash equivalents", pct: 50, risk: "very-low" },
      { name: "Short-duration U.S. Treasury securities", pct: 50, risk: "very-low" },
    ],
  }),
  usd("23", "Origin Dollar", "OUSD", "crypto-backed", "centralized-dependent", {
    yieldBearing: true,
    geckoId: "origin-dollar",
    governanceQuality: "wrapper",
    dependencies: [{ id: "2", weight: 1.0, type: "wrapper" }],
    collateral: "USDC deployed into DeFi strategies (Morpho, Curve)",
    pegMechanism: "1:1 minting/redemption backed by stablecoins; yield distributed via rebasing",
    links: [
      { label: "Website", url: "https://www.ousd.com/" },
      { label: "Twitter", url: "https://x.com/OriginProtocol" },
      { label: "GitHub", url: "https://github.com/OriginProtocol/origin-dollar" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x2a8e1e676ec238d8a992307b495b45b3feaa5e86", decimals: 18 },
      { chain: "astar",    address: "0x29f6e49c6e3397c3a84f715885f9f233a441165c", decimals: 18 },
    ],
    collateralQuality: "exotic",
    reserves: [
      { name: "USDC (via Morpho/Yearn vault)", pct: 65, risk: "medium" },
      { name: "USDC (via Curve AMO LP)", pct: 35, risk: "medium" },
    ],
  }),
  usd("183", "Bitcoin USD", "BtcUSD", "crypto-backed", "decentralized", {
    geckoId: "bitcoin-usd-btcfi",
    tags: ["Liquity v1 fork"],
    dependencies: [],
    collateral: "Overcollateralized Bitcoin (WBTC, BTCB, cbBTC, native BTC) via CDP vaults",
    pegMechanism: "Overcollateralized CDP with liquidation mechanisms",
    links: [
      { label: "Website", url: "https://www.btcfi.one/" },
      { label: "Twitter", url: "https://x.com/Bifrost_Network" },
      { label: "Docs", url: "https://docs.bifrostnetwork.com/eng.btcfi.one" },
    ],
    contracts: [
      { chain: "base", address: "0xe4b20925d9e9a62f1e492e15a81dc0de62804dd4", decimals: 18 },
    ],
    chainTier: "unproven",
    collateralQuality: "alt-lst-bridged-or-mixed",
    reserves: [
      { name: "BTC / WBTC / BTCB / cbBTC (overcollateralized CDP vaults)", pct: 100, risk: "medium" },
    ],
  }),
  usd("253", "Bima USBD", "USBD", "crypto-backed", "centralized-dependent", {
    geckoId: "usbd",
    deploymentModel: "native-multichain",
    tags: ["Liquity v1 fork"],
    dependencies: [],
    collateral: "Overcollateralized Bitcoin LSTs/LRTs via CDP vaults at 150% MCR (160% CCR triggers recovery mode)",
    pegMechanism: "Overcollateralized CDP (Liquity-style TroveManager) with automated liquidation",
    links: [
      { label: "Website", url: "https://bima.money/" },
      { label: "Twitter", url: "https://x.com/BimaBTC" },
      { label: "Docs", url: "https://docs.bima.money/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x6bede1c6009a78c222d9bdb7974bb67847fdb68c", decimals: 18 },
      { chain: "bsc", address: "0x6bede1c6009a78c222d9bdb7974bb67847fdb68c", decimals: 18 },
    ],
    collateralQuality: "alt-lst-bridged-or-mixed",
    reserves: [
      { name: "Bitcoin LSTs/LRTs (Lorenzo, Lombard, pStake, Bedrock, etc.)", pct: 100, risk: "high" },
    ],
  }),
  usd("331", "PikuDAO USP", "USP", "crypto-backed", "centralized-dependent", {
    yieldBearing: true, navToken: true,
    geckoId: "usp-yield-optimized-stablecoin",
    dependencies: [{ id: "1", weight: 0.2 }, { id: "2", weight: 0.2 }],
    collateral: "Diversified basket of off-chain and on-chain yield strategies: BMMF Turkey FX arbitrage (delta-neutral), DeFi protocol allocations (Ethena, Aave, Cap, Giza, Almanak, USD.AI), and cash stablecoins (USDC/USDT) as a buffer; allocation governed by PikuDAO",
    pegMechanism: "NAV-appreciating: starts at $1.00 backing; 90% of strategy yield flows back into backing pool, increasing token value over time; redemptions processed via FIFO smart-contract queue (0.2% fee, settled within 24 hours) with KYC/KYB required for minting and redeeming",
    links: [
      { label: "Website", url: "https://piku.co/" },
      { label: "Twitter", url: "https://x.com/piku_dao" },
      { label: "Docs", url: "https://docs.piku.co/piku" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x098697ba3fee4ea76294c5d6a466a4e3b3e95fe6", decimals: 18 },
    ],
    collateralQuality: "exotic",
    custodyModel: "institutional",
    reserves: [
      { name: "BMMF Turkey FX arbitrage (Balsa Technologies, delta-neutral TRY/USD)", pct: 50, risk: "very-high" },
      { name: "DeFi protocols (Giza, Almanak, USD.AI, Ethena, Aave, Cap)", pct: 40, risk: "high" },
      { name: "Cash stablecoins (USDC/USDT buffer)", pct: 10, risk: "low" },
    ],
  }),
  usd("240", "StablR USD", "USDR", "rwa-backed", "centralized", {
    geckoId: "stablr-usd",
    collateral: "Cash and short-term government bonds held with regulated European financial institutions",
    pegMechanism: "Direct 1:1 redemption through StablR (MFSA-supervised EMI)",
    proofOfReserves: { type: "independent-audit", url: "https://www.stablr.com/proof-of-reserve", provider: "Grant Thornton" },
    links: [
      { label: "Website", url: "https://www.stablr.com/usdr" },
      { label: "Twitter", url: "https://x.com/stablrusd" },
    ],
    jurisdiction: { country: "Malta", regulator: "MFSA", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x7b43e3875440b44613dc3bc08e7763e6da63c8f8", decimals: 6 },
    ],
    reserves: [
      { name: "Cash and short-term government bonds (EU financial institutions)", pct: 100, risk: "very-low" },
    ],
  }),
  usd("304", "USDU Finance", "USDU", "crypto-backed", "centralized-dependent", {
    dependencies: [{ id: "2", weight: 0.7, type: "mechanism" }],
    collateral: "Modular adapter system: Curve, Morpho, and TermMax vault assets as on-chain backing",
    pegMechanism: "Protocol-minted via DAO-approved adapters; convertible to USDC via Curve pools",
    links: [
      { label: "Website", url: "https://usdu.finance/" },
      { label: "Twitter", url: "https://x.com/USDUfinance" },
      { label: "Docs", url: "https://usdu.gitbook.io/docs/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xdde3ec717f220fc6a29d6a4be73f91da5b718e55", decimals: 18 },
    ],
    collateralQuality: "exotic",
    reserves: [
      { name: "Curve USDC/USDU LP tokens", pct: 35, risk: "medium" },
      { name: "TermMax fixed-rate lending vault shares", pct: 35, risk: "high" },
      { name: "Morpho USDU Core vault shares", pct: 30, risk: "medium" },
    ],
    notices: [
      { type: "danger", title: "Undercollateralized by design", message: "USDU Finance's transparency page shows a ~43% collateralization ratio. The protocol is minted through DAO-approved adapters and is intentionally undercollateralized for professional market participants." },
    ],
  }),

  // ── Additional non-USD pegs ────────────────────────────────────────
  other("289", "StraitsX XSGD", "XSGD", "rwa-backed", "centralized", "SGD", {
    geckoId: "xsgd",
    collateral: "Singapore dollar cash reserves held at Tier-1 banking institutions DBS and Standard Chartered, fully backed 1:1",
    pegMechanism: "Direct 1:1 redemption for SGD through StraitsX (MAS-licensed Major Payment Institution); independent attestation reports issued twice monthly",
    proofOfReserves: { type: "independent-audit", url: "https://www.straitsx.com/xsgd", provider: "Independent public accountants (ISCA standards)" },
    links: [
      { label: "Website", url: "https://www.straitsx.com/xsgd" },
      { label: "Twitter", url: "https://x.com/straitsx" },
    ],
    jurisdiction: { country: "Singapore", regulator: "MAS", license: "Major Payment Institution" },
    contracts: [
      { chain: "ethereum", address: "0x70e8de73ce538da2beed35d14187f6959a8eca96", decimals: 6 },
      { chain: "polygon",  address: "0xdc3326e71d45186f113a2f448984ca0e8d201995", decimals: 6 },
      { chain: "arbitrum", address: "0xe333e7754a2dc1e020a162ecab019254b9dab653", decimals: 6 },
      { chain: "avalanche", address: "0xb2f85b7ab3c2b6f62df06de6ae7d09c010a5096e", decimals: 6 },
      { chain: "base",     address: "0x0a4c9cb2778ab3302996a34befcf9a8bc288c33b", decimals: 6 },
    ],
  }),
  other("122", "GYEN", "GYEN", "rwa-backed", "centralized", "JPY", {
    geckoId: "gyen",
    collateral: "Japanese yen reserves held in FDIC-insured financial institutions, government money-market funds, or U.S. Treasury bills (≤3 months to maturity) per NYDFS guidelines",
    pegMechanism: "Direct 1:1 redemption for JPY through GMO Trust (NYDFS-chartered trust company)",
    proofOfReserves: { type: "independent-audit", url: "https://stablecoin.z.com/attestation/", provider: "The Network Firm" },
    links: [
      { label: "Website", url: "https://stablecoin.z.com/" },
      { label: "Twitter", url: "https://x.com/GMOTrust" },
      { label: "Docs", url: "https://stablecoin.z.com/what-are-gyen-and-zusd/" },
    ],
    jurisdiction: { country: "United States", regulator: "NYDFS", license: "Trust Charter" },
    contracts: [
      { chain: "ethereum", address: "0xc08512927d12348f6620a698105e1baac6ecd911", decimals: 6 },
      { chain: "arbitrum", address: "0x589d35656641d6ab57a545f08cf473ecd9b6d5f7", decimals: 6 },
    ],
  }),
  other("300", "BiLira", "TRYB", "rwa-backed", "centralized", "TRY", {
    geckoId: "bilira",
    collateral: "Turkish lira cash reserves held in Turkish bank accounts; independently audited with reports published regularly",
    pegMechanism: "Direct 1:1 redemption for TRY through BiLira",
    proofOfReserves: { type: "independent-audit", url: "https://www.bilira.co/en/audit-reports" },
    links: [
      { label: "Website", url: "https://www.bilira.co/en/product/tryb-stablecoin" },
      { label: "Twitter", url: "https://x.com/BiLira_Official" },
      { label: "Audit Reports", url: "https://www.bilira.co/en/audit-reports" },
      { label: "Proof of Reserve", url: "https://dune.com/biliraofficial/bilira-official" },
    ],
    jurisdiction: { country: "Turkey", regulator: "SPK/CMB" },
    contracts: [
      { chain: "ethereum", address: "0x2c537e5624e4af88a7ae4060c022609376c8d0eb", decimals: 6 },
      { chain: "bsc",      address: "0xc1fdbed7dac39cae2ccc0748f7a80dc446f6a594", decimals: 6 },
      { chain: "avalanche", address: "0x564a341df6c126f90cf3ecb92120fd7190acb401", decimals: 6 },
      { chain: "polygon",  address: "0x4fb71290ac171e1d144f7221d882becac7196eb5", decimals: 6 },
      { chain: "base",     address: "0xfb8718a69aed7726afb3f04d2bd4bfde1bdcb294", decimals: 6 },
    ],
  }),
  other("165", "AUDD", "AUDD", "rwa-backed", "centralized", "AUD", {
    geckoId: "novatti-australian-digital-dollar",
    collateral: "Australian dollar cash and cash equivalents, including Treasury bills and notes, held in segregated accounts at Australian Authorised Deposit-taking Institutions by AUDC Pty Ltd",
    pegMechanism: "Direct 1:1 redemption for AUD through AUDC Pty Ltd (AFSL No. 700123, Novatti subsidiary), with monthly independent reserve attestations by William Buck",
    proofOfReserves: { type: "independent-audit", url: "https://www.audd.digital/transparency/", provider: "William Buck" },
    links: [
      { label: "Website", url: "https://www.audd.digital/" },
      { label: "Twitter", url: "https://x.com/AUDD_digital" },
      { label: "Docs", url: "https://www.audd.digital/wp-content/uploads/2024/05/AUDD-Whitepaper_MAY2024.pdf" },
      { label: "Proof of Reserve", url: "https://www.audd.digital/transparency/" },
    ],
    jurisdiction: { country: "Australia", regulator: "ASIC", license: "AFSL No. 700123" },
    contracts: [
      { chain: "ethereum", address: "0x4cce605ed955295432958d8951d0b176c10720d5", decimals: 6 },
      { chain: "base",     address: "0x449b3317a6d1efb1bc3ba0700c9eaa4ffff4ae65", decimals: 6 },
    ],
  }),
  other("cg-jpyc", "JPY Coin", "JPYC", "rwa-backed", "centralized", "JPY", {
    geckoId: "jpycoin",
    collateral: "Japanese yen deposits and Japanese government bonds (100% backed)",
    pegMechanism: "Direct 1:1 redemption for JPY through JPYC Inc. via the JPYC EX platform; issuance and redemption via bank transfer after KYC; JPYC Inc. holds a Type II Funds Transfer Service Provider license under Japan's Payment Services Act",
    links: [
      { label: "Website", url: "https://jpyc.co.jp/" },
      { label: "Twitter", url: "https://x.com/jpyc_official" },
      { label: "GitHub", url: "https://github.com/jpycoin" },
    ],
    jurisdiction: { country: "Japan", regulator: "FSA", license: "Type II Funds Transfer Service Provider (Payment Services Act)" },
    contracts: [
      { chain: "ethereum", address: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29", decimals: 18 },
      { chain: "polygon",  address: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29", decimals: 18 },
      { chain: "avalanche", address: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29", decimals: 18 },
    ],
  }),

  // ── Gold-Pegged (not in DefiLlama stablecoins API — data via DefiLlama coins/protocol APIs) ──
  // commodityOunces: troy ounces per token (used for peg deviation normalization)
  other("gold-xaut", "Tether Gold", "XAUT", "rwa-backed", "centralized", "GOLD", {
    rwa: true, commodityOunces: 1, geckoId: "tether-gold", protocolSlug: "tether-gold",
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
  other("gold-paxg", "PAX Gold", "PAXG", "rwa-backed", "centralized", "GOLD", {
    rwa: true, commodityOunces: 1, geckoId: "pax-gold", protocolSlug: "paxos-gold",
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
    reserves: [
      { name: "Physical gold bars (LBMA Good Delivery, Brink's London vaults)", pct: 100, risk: "very-low" },
    ],
  }),
  other("gold-kau", "Kinesis Gold", "KAU", "rwa-backed", "centralized", "GOLD", {
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
  other("gold-xaum", "Matrixdock Gold", "XAUm", "rwa-backed", "centralized", "GOLD", {
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
  other("gold-vro", "VeraOne", "VRO", "rwa-backed", "centralized", "GOLD", {
    rwa: true, commodityOunces: 1 / 31.1035, geckoId: "veraone",
    collateral: "LBMA-certified physical gold (999.9‰ fine) held in the Free Ports of Geneva, Switzerland (1 VRO = 1 gram)",
    pegMechanism: "Direct 1:1 redemption for physical gold or fiat currency through VeraOne (LinGOLD Ltd); smaller amounts redeemable via partnered gold retailers worldwide",
    proofOfReserves: { type: "independent-audit", url: "https://veraone.io/en/audit-processes-and-proof-of-reserves/", provider: "ALS Global" },
    links: [
      { label: "Website", url: "https://veraone.io/en/home/" },
      { label: "Twitter", url: "https://x.com/VROtoken" },
    ],
    jurisdiction: { country: "United Kingdom" },
    contracts: [
      { chain: "ethereum", address: "0x10bc518c32fbae5e38ecb50a612160571bd81e44", decimals: 8 },
    ],
    reserves: [
      { name: "Physical gold (LBMA 999.9, Geneva Free Ports)", pct: 100, risk: "very-low" },
    ],
  }),
  other("gold-cgo", "Comtech Gold", "CGO", "rwa-backed", "centralized", "GOLD", {
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
  other("gold-dgld", "DGLD Tokenized Gold", "DGLD", "rwa-backed", "centralized", "GOLD", {
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

  // ── Silver-Pegged (data via DefiLlama coins API) ──────────────────────
  other("silver-kag", "Kinesis Silver", "KAG", "rwa-backed", "centralized", "SILVER", {
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

  // ── Additional EUR-pegged ────────────────────────────────────────────
  // EURT removed — discontinued by Tether
  eur("52", "Celo Euro", "CEUR", "algorithmic", "centralized-dependent", {
    geckoId: "celo-euro",
    dependencies: [{ id: "1", weight: 0.05 }, { id: "2", weight: 0.05 }],
    collateral: "Mento Reserve holding sUSDS, EURC, CELO, stETH, USDT, USDC, and ETH; overcollateralized at 136%+ with 100% stable-asset backing mandate",
    pegMechanism: "Virtual AMM (BiPoolManager) pools on Celo enable arbitrageurs to mint/burn EURm against reserve assets at oracle-enforced EUR rates; trading limits enforced by on-chain circuit breaker",
    proofOfReserves: { type: "real-time", url: "https://reserve.mento.org/", provider: "Mento Reserve (on-chain, publicly verifiable)" },
    links: [
      { label: "Website", url: "https://www.mento.org/" },
      { label: "Twitter", url: "https://x.com/MentoLabs" },
      { label: "Docs", url: "https://docs.mento.org/mento" },
      { label: "GitHub", url: "https://github.com/mento-protocol" },
    ],
    contracts: [
      { chain: "celo", address: "0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73", decimals: 18 },
    ],
    chainTier: "established-alt-l1",
    collateralQuality: "alt-lst-bridged-or-mixed",
    reserves: [
      { name: "sUSDS (Sky savings USDS)", pct: 56, risk: "low" },
      { name: "EURC (Circle euro stablecoin)", pct: 22, risk: "low" },
      { name: "CELO", pct: 12, risk: "high" },
      { name: "USDGLO (Glo Dollar)", pct: 4, risk: "low" },
      { name: "stETH (Lido staked ETH)", pct: 2, risk: "low" },
      { name: "USDC", pct: 2, risk: "low" },
      { name: "USDT", pct: 1, risk: "low" },
      { name: "ETH", pct: 1, risk: "very-low" },
    ],
  }),
  // PAR (id 56) removed — abandoned by Mimo Protocol, pivoted to KUMA (see cemetery)
  // IBEUR removed — liquidity drain Dec 2023 (see cemetery)
  // EUROe (id 98) removed — acquired by Paxos, wound down May 2025 (see cemetery)
  eur("158", "VNX EURO", "VEUR", "rwa-backed", "centralized", {
    geckoId: "vnx-euro",
    deploymentModel: "native-multichain",
    collateral: "Fiat reserves (euro-denominated cash and cash equivalents) held in bank/custody accounts of VNX Commodities AG",
    pegMechanism: "Direct 1:1 redemption through VNX Commodities AG (registered KYC/AML customers only)",
    proofOfReserves: { type: "independent-audit", url: "https://vnx.li/transparency/", provider: "AREVA General Auditing and Trust Company Limited" },
    links: [
      { label: "Website", url: "https://vnx.li/" },
      { label: "Twitter", url: "https://x.com/VNX_Platform" },
    ],
    jurisdiction: { country: "Liechtenstein", regulator: "FMA", license: "Blockchain Act" },
    contracts: [
      { chain: "ethereum", address: "0x6ba75d640bebfe5da1197bb5a2aff3327789b5d3", decimals: 18 },
      { chain: "avalanche", address: "0x7678e162f38ec9ef2bfd1d0aaf9fd93355e5fa0b", decimals: 18 },
      { chain: "arbitrum",  address: "0x4883c8f0529f37e40ebea870f3c13cdfad5d01f8", decimals: 18 },
      { chain: "base",      address: "0x4ed9df25d38795a47f52614126e47f564d37f347", decimals: 18 },
      { chain: "polygon",   address: "0xe4095d9372e68d108225c306a4491cacfb33b097", decimals: 18 },
      { chain: "celo",      address: "0x9346f43c1588b6df1d52bdd6bf846064f92d9cba", decimals: 18 },
      { chain: "solana", address: "C4Kkr9NZU3VbyedcgutU6LKmi6MKz81sx6gRmk5pX519", decimals: 9 },
      { chain: "xrpl", address: "VEUR-rLPtwF4FZi8bNVmbQ8JgoDUooozhwMNXr3", decimals: 6 },
      { chain: "tezos",  address: "KT1FenS7BCUjn1otfFyfrfxguiGnL4UTF3aG", decimals: 13 },
      { chain: "fraxtal", address: "0x4c0bd74da8237c08840984fdb33a84b4586aaee6", decimals: 18 },
      { chain: "icp",     address: "wu6g4-6qaaa-aaaan-qmrza-cai", decimals: 8 },
    ],
    reserves: [
      { name: "Euro cash and cash equivalents (bank/custody accounts)", pct: 100, risk: "very-low" },
    ],
  }),
  eur("239", "StablR Euro", "EURR", "rwa-backed", "centralized", {
    geckoId: "stablr-euro",
    collateral: "Cash and cash equivalents held in segregated accounts at European financial institutions",
    pegMechanism: "Direct 1:1 redemption through StablR",
    proofOfReserves: { type: "independent-audit", url: "https://www.stablr.com/proof-of-reserve", provider: "Grant Thornton" },
    links: [
      { label: "Website", url: "https://www.stablr.com/eurr" },
      { label: "Twitter", url: "https://x.com/StablREuro" },
    ],
    jurisdiction: { country: "Malta", regulator: "MFSA", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x50753cfaf86c094925bf976f218d043f8791e408", decimals: 6 },
    ],
    reserves: [
      { name: "Fiat reserves (euro cash at regulated financial institutions)", pct: 100, risk: "very-low" },
    ],
  }),
  eur("247", "Schuman EUROP", "EUROP", "rwa-backed", "centralized", {
    geckoId: "schuman-europ",
    deploymentModel: "native-multichain",
    collateral: "Euro cash and cash equivalents held at EU banks including Société Générale, with an additional 2% reserve fund",
    pegMechanism: "Direct 1:1 redemption through Schuman Financial",
    proofOfReserves: { type: "independent-audit", url: "https://schuman.io/reserve-audits/", provider: "KPMG" },
    links: [
      { label: "Website", url: "https://schuman.io/europ/" },
      { label: "Twitter", url: "https://x.com/Schuman_io" },
      { label: "Whitepaper", url: "https://schuman.io/wp-content/uploads/2025/02/EUROP-White-Paper_1.3.pdf" },
    ],
    jurisdiction: { country: "France", regulator: "ACPR", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51", decimals: 6 },
      { chain: "polygon", address: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51", decimals: 6 },
      { chain: "avalanche", address: "0x8835a2f66a7aaccb297cb985831a616b75e2e16c", decimals: 6 },
      { chain: "xrpl", address: "rMkEuRii9w9uBMQDnWV5AA43gvYZR9JxVK", decimals: 6 },
    ],
    reserves: [
      { name: "Euro cash and cash equivalents (EU banks incl. Societe Generale)", pct: 98, risk: "very-low" },
      { name: "Additional reserve fund", pct: 2, risk: "low" },
    ],
  }),
  eur("cg-eurq", "Quantoz EURQ", "EURQ", "rwa-backed", "centralized", {
    geckoId: "quantoz-eurq",
    collateral: "Euro-denominated reserves in bank accounts and liquid euro bonds (102% reserve ratio)",
    pegMechanism: "Direct 1:1 redemption through Quantoz Payments",
    links: [
      { label: "Website", url: "https://www.quantoz.com/products/eurq-usdq" },
      { label: "Twitter", url: "https://x.com/Quantoz" },
    ],
    jurisdiction: { country: "Netherlands", regulator: "DNB", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x8df723295214ea6f21026eeeb4382d475f146f9f", decimals: 6 },
    ],
    proofOfReserves: { type: "self-reported", url: "https://quantoz.com/transparency" },
    reserves: [
      { name: "Government bonds (NL, DE, US)", pct: 68, risk: "very-low" },
      { name: "Cash deposits (Tier 1 European banks)", pct: 32, risk: "very-low" },
    ],
  }),
  eur("319", "AllUnity EUR", "EURAU", "rwa-backed", "centralized", {
    geckoId: "allunity-eur",
    deploymentModel: "third-party-bridge",
    collateral: "Euro-denominated reserves held at CRR credit institutions within the EU, under a multi-bank full reserve model; not used for lending or investment",
    pegMechanism: "Direct 1:1 redemption through AllUnity",
    links: [
      { label: "Website", url: "https://allunity.com/eurau/" },
      { label: "Twitter", url: "https://x.com/AllUnityStable" },
      { label: "Whitepaper", url: "https://allunity.com/whitepaper/" },
    ],
    jurisdiction: { country: "Germany", regulator: "BaFin", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x4933a85b5b5466fbaf179f72d3de273c287ec2c2", decimals: 6 },
      { chain: "arbitrum", address: "0x4933a85b5b5466fbaf179f72d3de273c287ec2c2", decimals: 6 },
      { chain: "optimism", address: "0x4933a85b5b5466fbaf179f72d3de273c287ec2c2", decimals: 6 },
      { chain: "base", address: "0x4933a85b5b5466fbaf179f72d3de273c287ec2c2", decimals: 6 },
      { chain: "polygon", address: "0x4933a85b5b5466fbaf179f72d3de273c287ec2c2", decimals: 6 },
    ],
    proofOfReserves: { type: "self-reported", url: "https://allunity.com/trust-center/" },
    reserves: [
      { name: "Euro bank deposits (CRR credit institutions, EU)", pct: 100, risk: "very-low" },
    ],
  }),
  eur("cg-deuro", "Decentralized Euro", "DEURO", "crypto-backed", "decentralized", {
    geckoId: "decentralized-euro",
    deploymentModel: "canonical-bridge",
    collateral: "BTC, ETH, and other crypto assets in oracle-free overcollateralized positions",
    pegMechanism: "Overcollateralized CDP with automated liquidation; no oracle dependency (same architecture as Frankencoin ZCHF)",
    links: [
      { label: "Website", url: "https://www.deuro.com/" },
      { label: "Twitter", url: "https://x.com/dEURO_com" },
      { label: "Docs", url: "https://docs.deuro.com/" },
      { label: "GitHub", url: "https://github.com/d-EURO" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea", decimals: 18 },
      { chain: "polygon", address: "0xc2ff25dd99e467d2589b2c26edd270f220f14e47", decimals: 18 },
      { chain: "arbitrum", address: "0x5e85faf503621830ca857a5f38b982e0cc57d537", decimals: 18 },
      { chain: "optimism", address: "0x1b5f7fa46ed0f487f049c42f374ca4827d65a264", decimals: 18 },
      { chain: "base", address: "0x1b5f7fa46ed0f487f049c42f374ca4827d65a264", decimals: 18 },
    ],
    reserves: [
      { name: "WBTC / cbBTC / kBTC (wrapped Bitcoin variants)", pct: 40, risk: "medium" },
      { name: "WETH (wrapped Ether)", pct: 25, risk: "medium" },
      { name: "USDC / DAI (stablecoins)", pct: 15, risk: "low" },
      { name: "XAUT (tokenized gold)", pct: 10, risk: "medium" },
      { name: "UNI / ZCHF (governance / other)", pct: 10, risk: "very-high" },
    ],
  }),

  // ── Additional CHF-pegged ────────────────────────────────────────────
  other("157", "VNX Swiss Franc", "VCHF", "rwa-backed", "centralized", "CHF", {
    geckoId: "vnx-swiss-franc",
    collateral: "CHF held 1:1 in bank and custody accounts of VNX Commodities AG in Switzerland and Liechtenstein, independently audited by Areva General Auditing and Trust Company Limited",
    pegMechanism: "Direct 1:1 redemption through VNX Commodities AG; tokens minted on demand for verified customers depositing equivalent CHF value",
    links: [
      { label: "Website", url: "https://vnx.li/" },
      { label: "Twitter", url: "https://x.com/VNX_Platform" },
      { label: "Docs", url: "https://vnx.gitbook.io/vnx-platform/" },
    ],
    jurisdiction: { country: "Liechtenstein", regulator: "FMA", license: "TVTG (Blockchain Act)" },
    contracts: [
      { chain: "ethereum", address: "0x79d4f0232a66c4c91b89c76362016a1707cfbf4f", decimals: 18 },
      { chain: "base",     address: "0x1fca74d9ef54a6ac80ffe7d3b14e76c4330fd5d8", decimals: 18 },
      { chain: "arbitrum", address: "0x02cea97794d2cfb5f560e1ff4e9c59d1bec75969", decimals: 18 },
      { chain: "avalanche", address: "0x228a48df6819ccc2eca01e2192ebafffdad56c19", decimals: 18 },
    ],
  }),

  // ── GBP-pegged ───────────────────────────────────────────────────────
  other("292", "VNX British Pound", "VGBP", "rwa-backed", "centralized", "GBP", {
    geckoId: "vnx-british-pound",
    collateral: "GBP deposits held in bank accounts in Switzerland and Liechtenstein, confirmed 1:1 by Areva General Auditing and Trust Company Limited (December 2024)",
    pegMechanism: "Direct 1:1 redemption through VNX Commodities AG; tokens minted on demand for verified customers depositing equivalent GBP value",
    links: [
      { label: "Website", url: "https://vnx.li/" },
      { label: "Twitter", url: "https://x.com/VNX_Platform" },
      { label: "Docs", url: "https://vnx.gitbook.io/vnx-platform/" },
    ],
    jurisdiction: { country: "Liechtenstein", regulator: "FMA", license: "TVTG (Blockchain Act)" },
    contracts: [
      { chain: "base",     address: "0xaeb4bb7debd1e5e82266f7c3b5cff56b3a7bf411", decimals: 18 },
      { chain: "celo",     address: "0x7ae4265ecfc1f31bc0e112dfcfe3d78e01f4bb7f", decimals: 18 },
    ],
  }),
  other("317", "Tokenised GBP", "tGBP", "rwa-backed", "centralized", "GBP", {
    geckoId: "tokenised-gbp",
    collateral: "Cash and short-term UK government bonds (zero-coupon gilts) held in a segregated account at a UK-regulated financial institution, custodied by Enumis Limited",
    pegMechanism: "Direct 1:1 redemption through BCP Technologies Ltd; clients deposit GBP off-chain and receive minted tGBP on-chain; redemption burns tokens and triggers fiat withdrawal",
    links: [
      { label: "Website", url: "https://www.tokenisedgbp.com/" },
      { label: "Twitter", url: "https://x.com/tokenGBP" },
      { label: "Audit", url: "https://www.openzeppelin.com/news/tgbp-audit" },
    ],
    jurisdiction: { country: "United Kingdom", regulator: "FCA", license: "Cryptoasset AML Registration (FRN: 928840)" },
    contracts: [
      { chain: "ethereum", address: "0x27f6c8289550fce67f6b50bed1f519966afe5287", decimals: 18 },
      { chain: "base",     address: "0x27f6c8289550fce67f6b50bed1f519966afe5287", decimals: 18 },
      { chain: "bsc",      address: "0x27f6c8289550fce67f6b50bed1f519966afe5287", decimals: 18 },
      { chain: "polygon",  address: "0x27f6c8289550fce67f6b50bed1f519966afe5287", decimals: 18 },
      { chain: "avalanche", address: "0x27f6c8289550fce67f6b50bed1f519966afe5287", decimals: 18 },
    ],
  }),

  // ── Additional non-USD/non-EUR pegs ──────────────────────────────────
  other("cg-zarp", "ZARP Stablecoin", "ZARP", "rwa-backed", "centralized", "ZAR", {
    geckoId: "zarp-stablecoin",
    collateral: "South African rand cash reserves held 1:1 in a treasury managed by Old Mutual Wealth, independently audited by Kempen Audit",
    pegMechanism: "Mint/burn 1:1 with ZAR through ZARP Stablecoin (Pty) Ltd issuing partners; reserves may not be used for any purpose other than redemption",
    proofOfReserves: { type: "independent-audit", url: "https://kempengroup.co.za/wp-content/uploads/2025/09/ZARP-Stablecoin-Pty-Ltd-Agreed-upon-procedures-report-2025-09-04-1757061801998.pdf", provider: "Kempen Audit" },
    links: [
      { label: "Website", url: "https://www.zarpstablecoin.com/" },
      { label: "Twitter", url: "https://x.com/ZARP_Stablecoin" },
      { label: "Docs", url: "https://docs.zarpstablecoin.com/zarp-stablecoin" },
      { label: "GitHub", url: "https://github.com/venox-digital-assets/zarp.contract" },
    ],
    jurisdiction: { country: "South Africa", regulator: "FSCA", license: "CASP license pending" },
    contracts: [
      { chain: "ethereum", address: "0xb755506531786c8ac63b756bab1ac387bacb0c04", decimals: 18 },
      { chain: "base",     address: "0xb755506531786c8ac63b756bab1ac387bacb0c04", decimals: 18 },
      { chain: "polygon",  address: "0xb755506531786c8ac63b756bab1ac387bacb0c04", decimals: 18 },
    ],
  }),
  other("186", "International Stable Currency", "ISC", "rwa-backed", "centralized-dependent", "VAR", {
    geckoId: "international-stable-currency",
    navToken: true,
    dependencies: [{ id: "2", weight: 0.20 }],
    collateral: "Basket of real-world assets (gold, bonds, T-bills, equity, cash)",
    pegMechanism: "RWA-indexed basket tracking purchasing power; price appreciates over time",
    links: [
      { label: "Website", url: "https://www.isc.money/" },
      { label: "Twitter", url: "https://x.com/ISC_money" },
      { label: "Docs",    url: "https://wp.isc.money/" },
    ],
    chainTier: "established-alt-l1",
  }), // no EVM contract — Solana-only

  // ── CAD / CNY / PHP / MXN / UAH / ARS pegs ───────────────────────────
  other("145", "CAD Coin", "CADC", "rwa-backed", "centralized", "CAD", {
    geckoId: "cad-coin",
    collateral: "Canadian dollars and cash equivalents (liquid securities with original maturity ≤ 90 days) held 1:1 in a segregated account at a Canadian financial institution, in trust for CADC holders",
    pegMechanism: "Direct 1:1 redemption for CAD through Loon (FINTRAC-registered MSB, formerly issued by PayTrie); CADC is burned on redemption and minted on deposit",
    proofOfReserves: { type: "self-reported", url: "https://dune.com/cadc/stablecoin", provider: "Loon (on-chain Dune dashboard)" },
    links: [
      { label: "Website", url: "https://loon.finance/" },
      { label: "Twitter", url: "https://x.com/LoonFinance" },
      { label: "Docs", url: "https://faq.paytrie.com/col/cadc-faqs" },
    ],
    jurisdiction: { country: "Canada", regulator: "FINTRAC", license: "C10001420" },
    contracts: [
      { chain: "ethereum", address: "0xcadc0acd4b445166f12d2c07eac6e2544fbe2eef", decimals: 18 },
      { chain: "polygon",  address: "0x9de41aff9f55219d5bf4359f167d1d0c772a396d", decimals: 18 },
      { chain: "arbitrum", address: "0x2b28e826b55e399f4d4699b85f68666ac51e6f70", decimals: 18 },
      { chain: "base",     address: "0x043eb4b75d0805c43d7c834902e335621983cf03", decimals: 18 },
    ],
  }),
  other("299", "PHT Stablecoin", "PHT", "crypto-backed", "centralized-dependent", "PHP", {
    geckoId: "pht-stablecoin",
    dependencies: [{ id: "1", weight: 0.9, type: "wrapper" }],
    collateral: "apcxUSDT (1:1 USDT-backed custodial token) in overcollateralized CDP vaults; future phases to add USDC, USDT, and other approved stablecoins as collateral types",
    pegMechanism: "Overcollateralized CDP vaults (MakerDAO MCD fork): users deposit apcxUSDT as collateral to mint PHT; undercollateralized vaults liquidated via Dutch auction; Chainlink PHP/USD oracle; LayerZero OFT for cross-chain bridging",
    links: [
      { label: "Website", url: "https://www.apacx.io/PHT" },
      { label: "Twitter", url: "https://x.com/apacx_io" },
      { label: "Docs", url: "https://docs.apacx.io/" },
      { label: "Audit", url: "https://docs.apacx.io/technical-references/smart-contract-audits" },
    ],
    jurisdiction: { country: "Singapore" },
    contracts: [
      { chain: "ethereum", address: "0xbe370ad45d44eb45174c4ec60b88839fef32c077", decimals: 18 },
    ],
    collateralQuality: "exotic",
    custodyModel: "institutional",
    reserves: [
      { name: "apcxUSDT (custodial 1:1 USDT wrapper)", pct: 100, risk: "high" },
    ],
  }),
  usd("cg-syrupusdc", "Maple syrupUSDC", "syrupUSDC", "rwa-backed", "centralized-dependent", {
    geckoId: "syrupusdc",
    deploymentModel: "third-party-bridge",
    governanceQuality: "wrapper",
    yieldBearing: true, navToken: true,
    collateral: "USDC deposits lent to institutional borrowers via overcollateralized, fixed-rate loans on Maple Finance",
    pegMechanism: "ERC-4626 vault; USDC deposited into Maple lending pools, NAV appreciates with accrued interest; near-instant redemptions via dynamic liquidity buffer",
    links: [
      { label: "Website", url: "https://maple.finance/" },
      { label: "Twitter", url: "https://x.com/maplefinance" },
    ],
    dependencies: [{ id: "2", weight: 1.0, type: "wrapper" }],
    contracts: [
      { chain: "ethereum", address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", decimals: 6 },
      { chain: "base", address: "0x660975730059246a68521a3e2fbd4740173100f5", decimals: 6 },
      { chain: "arbitrum", address: "0x41ca7586cc1311807b4605fbb748a3b8862b42b5", decimals: 6 },
    ],
    collateralQuality: "rwa",
    custodyModel: "onchain",
    reserves: [
      { name: "Overcollateralized institutional loans (BTC/ETH collateral, Blue Chip pool)", pct: 55, risk: "medium" },
      { name: "Overcollateralized institutional loans (SOL/XRP/altcoin collateral, High Yield pool)", pct: 35, risk: "high" },
      { name: "Liquidity buffer (USDC idle)", pct: 10, risk: "low" },
    ],
  }),
  usd("cg-syrupusdt", "Maple syrupUSDT", "syrupUSDT", "rwa-backed", "centralized-dependent", {
    geckoId: "syrupusdt",
    governanceQuality: "wrapper",
    yieldBearing: true, navToken: true,
    collateral: "USDT deposits lent to institutional borrowers via overcollateralized, fixed-rate loans on Maple Finance",
    pegMechanism: "ERC-4626 vault; USDT deposited into Maple lending pools, NAV appreciates with accrued interest; near-instant redemptions via dynamic liquidity buffer",
    links: [
      { label: "Website", url: "https://maple.finance/" },
      { label: "Twitter", url: "https://x.com/maplefinance" },
    ],
    dependencies: [{ id: "1", weight: 1.0, type: "wrapper" }],
    contracts: [
      { chain: "ethereum", address: "0x356b8d89c1e1239cbbb9de4815c39a1474d5ba7d", decimals: 6 },
    ],
    collateralQuality: "rwa",
    custodyModel: "onchain",
    reserves: [
      { name: "Overcollateralized institutional loans (BTC/ETH collateral, Blue Chip pool)", pct: 55, risk: "medium" },
      { name: "Overcollateralized institutional loans (SOL/XRP/altcoin collateral, High Yield pool)", pct: 35, risk: "high" },
      { name: "Liquidity buffer (USDT idle)", pct: 10, risk: "low" },
    ],
  }),
  usd("353", "GAIB AID", "AID", "rwa-backed", "centralized", {
    geckoId: "gaib-aid",
    rwa: true,
    collateral: "U.S. Treasury bills and accepted stablecoins (USDC, USDT); the companion sAID token accrues yield from GPU/AI infrastructure financing agreements",
    pegMechanism: "1:1 mint and burn against accepted stablecoins; AID itself is non-yield-bearing",
    jurisdiction: { country: "Singapore" },
    links: [
      { label: "Website", url: "https://gaib.ai" },
      { label: "Twitter", url: "https://x.com/gaib_ai" },
      { label: "Docs", url: "https://docs.gaib.ai" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x18f52b3fb465118731d9e0d276d4eb3599d57596", decimals: 18 },
      { chain: "arbitrum", address: "0x18f52b3fb465118731d9e0d276d4eb3599d57596", decimals: 18 },
      { chain: "base", address: "0x18f52b3fb465118731d9e0d276d4eb3599d57596", decimals: 18 },
    ],
    collateralQuality: "rwa",
    custodyModel: "institutional",
    governanceQuality: "single-entity",
  }),
];

// --- Pre-computed lookups (static data, computed once at module level) ---

/** Map of stablecoin ID → metadata. Use instead of constructing in components. */
export const TRACKED_META_BY_ID = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));

/** Set of all tracked stablecoin IDs. */
export const TRACKED_IDS = new Set(TRACKED_STABLECOINS.map((s) => s.id));

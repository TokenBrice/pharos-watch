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
}

function coin(id: string, name: string, symbol: string, backing: StablecoinMeta["flags"]["backing"], governance: StablecoinMeta["flags"]["governance"], pegCurrency: StablecoinMeta["flags"]["pegCurrency"], opts?: StablecoinOpts): StablecoinMeta {
  return { id, name, symbol, flags: { backing, pegCurrency, governance, yieldBearing: opts?.yieldBearing ?? false, rwa: opts?.rwa ?? false, navToken: opts?.navToken ?? false }, collateral: opts?.collateral, pegMechanism: opts?.pegMechanism, commodityOunces: opts?.commodityOunces, geckoId: opts?.geckoId, cmcSlug: opts?.cmcSlug, protocolSlug: opts?.protocolSlug, proofOfReserves: opts?.proofOfReserves, links: opts?.links, jurisdiction: opts?.jurisdiction, contracts: opts?.contracts, supplyMethod: opts?.supplyMethod };
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
    collateral: "Cash, cash equivalents, U.S. Treasury bills, and secured loans",
    pegMechanism: "Direct 1:1 redemption through Tether",
    proofOfReserves: { type: "independent-audit", url: "https://tether.to/en/transparency", provider: "BDO Italia" },
    links: [
      { label: "Website", url: "https://tether.to/" },
      { label: "Twitter", url: "https://x.com/Tether_to" },
    ],
    jurisdiction: { country: "El Salvador" },
    contracts: [
      { chain: "ethereum", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
      { chain: "tron", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 },
      { chain: "arbitrum", address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6 },
      { chain: "optimism", address: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", decimals: 6 },
      { chain: "polygon", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
      { chain: "avalanche", address: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", decimals: 6 },
      { chain: "bsc", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18 },
    ],
    supplyMethod: {
      type: "totalSupply-minus-addresses",
      subtractAddresses: [
        { chain: "ethereum", address: "0x5754284f345afc66a98fbB0a0Afe71e0f007b949" }, // Tether Treasury
      ],
    },
  }),
  usd("2", "USD Coin", "USDC", "rwa-backed", "centralized", {
    collateral: "Cash and short-term U.S. Treasury securities in segregated accounts",
    pegMechanism: "Direct 1:1 redemption through Circle",
    proofOfReserves: { type: "independent-audit", url: "https://www.circle.com/transparency", provider: "Deloitte" },
    links: [
      { label: "Website", url: "https://www.circle.com/usdc" },
      { label: "Twitter", url: "https://x.com/circle" },
      { label: "Docs", url: "https://developers.circle.com/stablecoins/what-is-usdc" },
    ],
    jurisdiction: { country: "United States", regulator: "NYDFS", license: "BitLicense" },
    contracts: [
      { chain: "ethereum", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
      { chain: "arbitrum", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 },
      { chain: "base", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
      { chain: "optimism", address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6 },
      { chain: "polygon", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6 },
      { chain: "avalanche", address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6 },
    ],
    supplyMethod: {
      type: "totalSupply-minus-addresses",
      subtractAddresses: [
        { chain: "ethereum", address: "0x55FE002aEFF02F77364de339a1292923A15844B8" }, // Circle Reserve
      ],
    },
  }),
  usd("146", "Ethena USDe", "USDe", "crypto-backed", "centralized-dependent", {
    yieldBearing: true,
    collateral: "ETH, BTC, and SOL in delta-neutral positions (spot long + short perpetual futures)",
    pegMechanism: "Delta-neutral hedging on centralized exchanges (Binance, Bybit, OKX) via custodians",
    proofOfReserves: { type: "real-time", url: "https://app.ethena.fi/dashboards/transparency", provider: "Chaos Labs / Chainlink" },
    links: [
      { label: "Website", url: "https://ethena.fi/" },
      { label: "Twitter", url: "https://x.com/ethena_labs" },
      { label: "Docs", url: "https://docs.ethena.fi/" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
    contracts: [
      { chain: "ethereum", address: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", decimals: 18 },
    ],
  }),
  usd("209", "Sky Dollar", "USDS", "crypto-backed", "centralized-dependent", {
    collateral: "Mix of crypto (ETH), RWA (U.S. Treasuries), and centralized stablecoins (USDC) via Sky vaults",
    pegMechanism: "Peg Stability Modules enabling 1:1 swaps with USDC and DAI",
    links: [
      { label: "Website", url: "https://sky.money/" },
      { label: "Twitter", url: "https://x.com/SkyEcosystem" },
    ],
    jurisdiction: { country: "Denmark" },
    contracts: [
      { chain: "ethereum", address: "0xdc035d45d973e3ec169d2276ddab16f1e407384f", decimals: 18 },
    ],
  }),
  usd("262", "World Liberty Financial USD", "USD1", "rwa-backed", "centralized", {
    collateral: "Short-term U.S. Treasury bills and cash equivalents",
    pegMechanism: "Direct 1:1 redemption through World Liberty Financial",
    proofOfReserves: { type: "independent-audit", url: "https://www.bitgo.com/usd1/attestations/", provider: "BitGo" },
    links: [
      { label: "Website", url: "https://worldlibertyfinancial.com/usd1" },
      { label: "Twitter", url: "https://x.com/worldlibertyfi" },
    ],
    jurisdiction: { country: "United States", regulator: "OCC", license: "South Dakota Trust Charter" },
    contracts: [
      { chain: "ethereum", address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", decimals: 18 },
    ],
  }),
  usd("5", "Dai", "DAI", "crypto-backed", "centralized-dependent", {
    collateral: "Mix of crypto (ETH, wBTC), RWA (U.S. Treasuries), and centralized stablecoins (USDC) via Maker vaults",
    pegMechanism: "Peg Stability Module enabling 1:1 swaps with USDC; overcollateralized CDP liquidations",
    links: [
      { label: "Website", url: "https://makerdao.com/" },
      { label: "Twitter", url: "https://x.com/MakerDAO" },
      { label: "Docs", url: "https://docs.makerdao.com/" },
    ],
    jurisdiction: { country: "Denmark" },
    contracts: [
      { chain: "ethereum", address: "0x6b175474e89094c44da98b954eedeac495271d0f", decimals: 18 },
    ],
  }),
  usd("120", "PayPal USD", "PYUSD", "rwa-backed", "centralized", {
    collateral: "U.S. dollar deposits, U.S. Treasury securities, and reverse repurchase agreements",
    pegMechanism: "Direct 1:1 redemption through PayPal/Paxos",
    proofOfReserves: { type: "independent-audit", url: "https://www.paxos.com/pyusd-transparency", provider: "KPMG" },
    links: [
      { label: "Website", url: "https://www.paypal.com/us/digital-wallet/manage-money/crypto/pyusd" },
      { label: "Docs", url: "https://developer.paypal.com/dev-center/pyusd/" },
    ],
    jurisdiction: { country: "United States", regulator: "NYDFS", license: "Limited Purpose Trust Company" },
    contracts: [
      { chain: "ethereum", address: "0x6c3ea9036406852006290770bedfcaba0e23a0e8", decimals: 6 },
    ],
    supplyMethod: { type: "exclude" }, // Significant Solana/Arbitrum supply not coverable on-chain — use DefiLlama
  }),
  usd("246", "Falcon USD", "USDf", "crypto-backed", "centralized-dependent", {
    collateral: "Delta-neutral positions using BTC, ETH, and stablecoins via institutional custody",
    pegMechanism: "Delta-neutral hedging on centralized exchanges with institutional-grade custodians",
    proofOfReserves: { type: "real-time", url: "https://app.falcon.finance/transparency", provider: "HT.Digital" },
    links: [
      { label: "Website", url: "https://falcon.finance/" },
      { label: "Twitter", url: "https://x.com/FalconStable" },
    ],
    jurisdiction: { country: "United Arab Emirates" },
    contracts: [
      { chain: "ethereum", address: "0xfa2b947eec368f42195f24f36d2af29f7c24cec2", decimals: 18 },
    ],
  }),
  usd("237", "Hashnote USYC", "USYC", "rwa-backed", "centralized", {
    yieldBearing: true, rwa: true, navToken: true,
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
    ],
  }),
  usd("286", "Global Dollar", "USDG", "rwa-backed", "centralized", {
    collateral: "Cash and short-term U.S. Treasury securities",
    pegMechanism: "Direct 1:1 redemption through Paxos",
    proofOfReserves: { type: "independent-audit", url: "https://www.paxos.com/usdg-transparency", provider: "Enrome LLP" },
    links: [
      { label: "Website", url: "https://globaldollar.com/" },
      { label: "Twitter", url: "https://x.com/paxos" },
    ],
    jurisdiction: { country: "Singapore", regulator: "MAS", license: "Major Payment Institution" },
    contracts: [
      { chain: "ethereum", address: "0xe343167631d89b6ffc58b88d6b7fb0228795491d", decimals: 6 },
    ],
  }),

  // ── Rank 11-20 ───────────────────────────────────────────────────────
  usd("250", "Ripple USD", "RLUSD", "rwa-backed", "centralized", {
    collateral: "U.S. dollar deposits and short-term U.S. government Treasuries",
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
  }),
  usd("129", "Ondo US Dollar Yield", "USDY", "rwa-backed", "centralized", {
    yieldBearing: true, rwa: true, navToken: true,
    collateral: "Short-term U.S. Treasuries, iShares Short Treasury Bond ETF shares, and bank demand deposits",
    pegMechanism: "Bank wire redemption at NAV-based price with independent verification and collateral agent oversight",
    proofOfReserves: { type: "self-reported", url: "https://ondo.finance/usdy", provider: "Ankura Trust" },
    links: [
      { label: "Website", url: "https://ondo.finance/usdy" },
      { label: "Twitter", url: "https://x.com/OndoFinance" },
      { label: "Docs", url: "https://docs.ondo.finance/" },
    ],
    jurisdiction: { country: "United States", regulator: "FinCEN", license: "Money Services Business" },
    contracts: [
      { chain: "ethereum", address: "0x96f6ef951840721adbf46ac996b59e0235cb985c", decimals: 18 },
    ],
  }),
  usd("173", "BlackRock USD", "BUIDL", "rwa-backed", "centralized", {
    yieldBearing: true, rwa: true,
    collateral: "Tokenized U.S. Treasury securities managed by BlackRock",
    pegMechanism: "NAV-based pricing with institutional redemption through BlackRock/Securitize",
    links: [
      { label: "Website", url: "https://securitize.io/blackrock/buidl" },
    ],
    jurisdiction: { country: "British Virgin Islands", regulator: "SEC (Reg D)", license: "Regulation D Exemption" },
    contracts: [
      { chain: "ethereum", address: "0x7712c34205737192402172409a8f7ccef8aa2aec", decimals: 6 },
    ],
  }),
  usd("14", "USDD", "USDD", "crypto-backed", "centralized-dependent", {
    collateral: "Over-collateralized by BTC, USDT, and TRX held in TRON DAO Reserve",
    pegMechanism: "Peg Stability Module with USDT; overcollateralization ratio maintained above 120%",
    proofOfReserves: { type: "self-reported", url: "https://usdd.io/" },
    links: [
      { label: "Website", url: "https://usdd.io/" },
      { label: "Twitter", url: "https://x.com/usddio" },
    ],
    jurisdiction: { country: "Dominica" },
    contracts: [
      { chain: "tron", address: "TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz", decimals: 18 },
    ],
  }),
  usd("221", "Ethena USDtb", "USDTB", "rwa-backed", "centralized", {
    rwa: true,
    collateral: "Tokenized U.S. Treasury bills via Securitize/BlackRock BUIDL fund",
    pegMechanism: "NAV-based pricing backed by underlying Treasury securities",
    proofOfReserves: { type: "self-reported", url: "https://usdtb.money/" },
    links: [
      { label: "Website", url: "https://usdtb.money/" },
      { label: "Twitter", url: "https://x.com/ethena_labs" },
      { label: "Docs", url: "https://docs.ethena.fi/usdtb" },
    ],
    jurisdiction: { country: "United States", regulator: "OCC", license: "Federal Bank Charter" },
    contracts: [
      { chain: "ethereum", address: "0xc139190f447e929f090edeb554d95abb8b18ac1c", decimals: 18 },
    ],
  }),
  usd("213", "M by M0", "M", "rwa-backed", "centralized-dependent", {
    rwa: true,
    collateral: "U.S. Treasury bills held by approved Minters with on-chain verification",
    pegMechanism: "Authorized minters earn yield; independent validators verify reserves on-chain",
    links: [
      { label: "Website", url: "https://www.m0.org/" },
      { label: "Twitter", url: "https://x.com/m0foundation" },
    ],
    jurisdiction: { country: "Switzerland" },
    contracts: [
      { chain: "ethereum", address: "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b", decimals: 6 },
      { chain: "optimism", address: "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b", decimals: 6 },
      { chain: "arbitrum", address: "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b", decimals: 6 },
    ],
  }),
  usd("336", "United Stables", "U", "rwa-backed", "centralized", {
    collateral: "Cash, USDC, USDT, and USD1 held in segregated custodial accounts (BVI entity)",
    pegMechanism: "Direct 1:1 redemption for reserve assets through United Stables",
    links: [
      { label: "Website", url: "https://u.tech/" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
    contracts: [
      { chain: "ethereum", address: "0xce24439f2d9c6a2289f741120fe202248b666666", decimals: 18 },
    ],
  }),
  usd("309", "USD.AI", "USDai", "rwa-backed", "centralized-dependent", {
    collateral: "U.S. Treasuries via M0 platform; minted by depositing USDC or USDT",
    pegMechanism: "1:1 mint/redeem against USDC/USDT with underlying T-bill backing via M0",
    links: [
      { label: "Website", url: "https://usd.ai/" },
      { label: "Twitter", url: "https://x.com/USDai_Official" },
      { label: "Docs", url: "https://docs.usd.ai" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", decimals: 18 },
    ],
  }),
  usd("195", "Usual USD", "USD0", "rwa-backed", "centralized-dependent", {
    rwa: true,
    collateral: "Short-term U.S. Treasury bills and money market instruments",
    pegMechanism: "1:1 minting against approved RWA collateral with on-chain verification",
    links: [
      { label: "Website", url: "https://usual.money/" },
      { label: "Twitter", url: "https://x.com/usualmoney" },
      { label: "Docs", url: "https://docs.usual.money/" },
    ],
    jurisdiction: { country: "France" },
    contracts: [
      { chain: "ethereum", address: "0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5", decimals: 18 },
    ],
  }),
  usd("118", "GHO", "GHO", "crypto-backed", "centralized-dependent", {
    collateral: "Multiple crypto assets (ETH, wBTC, LINK) deposited in Aave V3 as collateral",
    pegMechanism: "Overcollateralized minting via Aave; GHO Stability Module enables direct USDC/USDT swaps",
    links: [
      { label: "Website", url: "https://aave.com/gho" },
      { label: "Twitter", url: "https://x.com/aaveaave" },
      { label: "Docs", url: "https://docs.aave.com/faq/gho-stablecoin" },
    ],
    jurisdiction: { country: "Ireland", regulator: "Central Bank of Ireland", license: "MiCA Authorization" },
    contracts: [
      { chain: "ethereum", address: "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f", decimals: 18 },
    ],
  }),

  // ── Rank 21-30 ───────────────────────────────────────────────────────
  other("258", "A7A5", "A7A5", "rwa-backed", "centralized", "RUB", {
    geckoId: "a7a5",
    collateral: "Russian ruble-denominated reserves",
    pegMechanism: "Direct redemption for RUB through issuer",
    links: [
      { label: "Website", url: "https://www.a7a5.io/" },
    ],
    jurisdiction: { country: "Kyrgyzstan" },
    contracts: [
      { chain: "ethereum", address: "0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9", decimals: 6 },
      { chain: "tron", address: "TLeVfrdym8RoJreJ23dAGyfJDygRtiWKBZ", decimals: 6 },
    ],
  }),
  usd("7", "TrueUSD", "TUSD", "rwa-backed", "centralized", {
    collateral: "U.S. dollars held in escrow accounts with independent attestation",
    pegMechanism: "Direct 1:1 redemption through TrueToken/Archblock",
    proofOfReserves: { type: "real-time", url: "https://tusd.io/transparency", provider: "Chainlink / Moore Hong Kong" },
    links: [
      { label: "Website", url: "https://tusd.io/" },
      { label: "Twitter", url: "https://x.com/tusdio" },
    ],
    jurisdiction: { country: "Dominica" },
    contracts: [
      { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
    ],
  }),
  usd("119", "First Digital USD", "FDUSD", "rwa-backed", "centralized", {
    collateral: "Cash and cash equivalents (U.S. Treasury bills) held in custodial accounts",
    pegMechanism: "Direct 1:1 redemption through First Digital Trust",
    proofOfReserves: { type: "independent-audit", url: "https://www.firstdigitallabs.com/transparency", provider: "Prescient Assurance" },
    links: [
      { label: "Website", url: "https://www.firstdigitallabs.com/fdusd" },
      { label: "Twitter", url: "https://x.com/FDLabsHQ" },
    ],
    jurisdiction: { country: "Hong Kong", regulator: "HKMA", license: "Trust Company" },
    contracts: [
      { chain: "ethereum", address: "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409", decimals: 18 },
    ],
  }),
  usd("296", "Cap cUSD", "CUSD", "rwa-backed", "centralized-dependent", {
    collateral: "Basket of regulated stablecoins: USDC, USDT, pyUSD, BUIDL, and BENJI (max 40% each)",
    pegMechanism: "Peg Stability Module enabling 1:1 minting/redemption against underlying stablecoin basket",
    links: [
      { label: "Website", url: "https://www.cap.app/" },
      { label: "Twitter", url: "https://x.com/capmoney_" },
      { label: "Docs", url: "https://docs.cap.app/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc", decimals: 18 },
    ],
  }),
  // USDN (id 12) removed — algorithmic death spiral Apr 2022 (see cemetery)
  eur("50", "EURC", "EURC", "rwa-backed", "centralized", {
    geckoId: "euro-coin",
    collateral: "Euro-denominated reserves held in regulated financial institutions",
    pegMechanism: "Direct 1:1 redemption through Circle",
    proofOfReserves: { type: "independent-audit", url: "https://www.circle.com/transparency", provider: "Deloitte" },
    links: [
      { label: "Website", url: "https://www.circle.com/eurc" },
      { label: "Twitter", url: "https://x.com/circle" },
    ],
    jurisdiction: { country: "France", regulator: "ACPR", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c", decimals: 6 },
    ],
  }),
  usd("197", "Resolv USD", "USR", "crypto-backed", "centralized-dependent", {
    collateral: "ETH, stETH, and BTC hedged with short perpetual futures",
    pegMechanism: "Delta-neutral hedging on centralized exchanges (Binance, Hyperliquid, Deribit) via Fireblocks/Ceffu",
    proofOfReserves: { type: "self-reported", url: "https://info.apostro.xyz/resolv-reserves", provider: "Apostro" },
    links: [
      { label: "Website", url: "https://resolv.xyz/" },
      { label: "Twitter", url: "https://x.com/ResolvLabs" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110", decimals: 18 },
    ],
  }),
  usd("272", "YLDS", "YLDS", "rwa-backed", "centralized", {
    yieldBearing: true, rwa: true, navToken: true,
    collateral: "U.S. Treasury securities generating yield",
    pegMechanism: "NAV-based institutional redemption with regulatory oversight",
    links: [
      { label: "Website", url: "https://www.ylds.com/" },
      { label: "Twitter", url: "https://x.com/FigureMarkets" },
    ],
    jurisdiction: { country: "United States", regulator: "SEC", license: "SEC-Registered Security" },
  }),
  usd("110", "crvUSD", "crvUSD", "crypto-backed", "centralized-dependent", {
    collateral: "ETH, wBTC, wstETH, and other crypto assets via LLAMMA (Lending-Liquidating AMM)",
    pegMechanism: "Peg keepers use centralized stablecoins (USDC, USDT, USDP) to stabilize price via Curve pools",
    links: [
      { label: "Website", url: "https://www.curve.finance/" },
      { label: "Twitter", url: "https://x.com/CurveFinance" },
      { label: "Docs", url: "https://resources.curve.finance/" },
    ],
    jurisdiction: { country: "Switzerland" },
    contracts: [
      { chain: "ethereum", address: "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e", decimals: 18 },
    ],
    supplyMethod: {
      type: "exclude", // totalSupply() includes pre-minted lending capacity; DefiLlama aggregates debt across all factories
    },
  }),
  usd("310", "Solstice USX", "USX", "crypto-backed", "centralized-dependent", {
    collateral: "Delta-neutral positions in BTC, ETH, SOL plus USDC/USDT and tokenized treasuries",
    pegMechanism: "Delta-neutral hedging on centralized exchanges via Ceffu custody with Chainlink Proof of Reserve",
    links: [
      { label: "Website", url: "https://solstice.finance/usx" },
      { label: "Twitter", url: "https://x.com/solsticefi" },
    ],
    jurisdiction: { country: "Switzerland" },
    contracts: [
      { chain: "ethereum", address: "0x0a5e677a6a24b2f1a2bf4f3bffc443231d2fdec8", decimals: 18 },
    ],
  }),

  // ── Rank 31-40 ───────────────────────────────────────────────────────
  usd("220", "Avalon USDa", "USDA", "crypto-backed", "centralized-dependent", {
    collateral: "BTC and BTC LSTs via CDP; pegged to USDT with $2B institutional credit lines",
    pegMechanism: "1:1 USDT convertibility; CEX liquidation via HFT algorithms through Ceffu/Coinbase Prime custody",
    links: [
      { label: "Website", url: "https://www.avalonfinance.xyz/" },
      { label: "Twitter", url: "https://x.com/avalonfinance_" },
      { label: "Docs", url: "https://docs.avalonfinance.xyz" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x0000206329b97db379d5e1bf586bbdb969c63274", decimals: 18 },
    ],
  }),
  // Binance Peg BUSD (id 153) removed — BUSD discontinued (see cemetery)
  usd("6", "Frax", "FRAX", "algorithmic", "centralized-dependent", {
    collateral: "Mix of USDC reserves and algorithmic expansion/contraction (now 100% USDC-collateralized)",
    pegMechanism: "Fractional-algorithmic: fully collateralized by USDC with algorithmic supply adjustment",
    links: [
      { label: "Website", url: "https://frax.com/" },
      { label: "Twitter", url: "https://x.com/fraxfinance" },
      { label: "Docs", url: "https://docs.frax.finance" },
    ],
    jurisdiction: { country: "United States" },
    contracts: [
      { chain: "ethereum", address: "0x853d955acef822db058eb8505911ed77f175b99e", decimals: 18 },
    ],
  }),
  usd("15", "Dola", "DOLA", "crypto-backed", "centralized-dependent", {
    collateral: "Various crypto assets in Inverse Finance lending markets, including USDC",
    pegMechanism: "Fed contracts manage supply via lending markets; relies on USDC for stability mechanisms",
    links: [
      { label: "Website", url: "https://www.inverse.finance/" },
      { label: "Twitter", url: "https://x.com/InverseFinance" },
      { label: "Docs", url: "https://docs.inverse.finance/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x865377367054516e17014ccded1e7d814edc9ce4", decimals: 18 },
    ],
  }),
  usd("205", "Agora Dollar", "AUSD", "rwa-backed", "centralized", {
    collateral: "U.S. dollar deposits, U.S. Treasury bills, and overnight reverse repos",
    pegMechanism: "Direct 1:1 redemption through Agora",
    proofOfReserves: { type: "real-time", url: "https://developer.agora.finance/attestations", provider: "Chaos Labs" },
    links: [
      { label: "Website", url: "https://www.agora.finance/" },
      { label: "Twitter", url: "https://x.com/withAUSD" },
    ],
    jurisdiction: { country: "Cayman Islands" },
    contracts: [
      { chain: "ethereum", address: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", decimals: 6 },
    ],
  }),
  usd("298", "infiniFi USD", "IUSD", "crypto-backed", "centralized-dependent", {
    collateral: "USDC deposits allocated across Aave, Pendle, and Ethena yield strategies",
    pegMechanism: "1:1 mint/redeem against USDC; fractional reserve model with yield optimization",
    links: [
      { label: "Website", url: "https://infinifi.xyz/" },
      { label: "Twitter", url: "https://x.com/infiniFi" },
    ],
    jurisdiction: { country: "United States" },
    contracts: [
      { chain: "ethereum", address: "0x48f9e38f3070ad8945dfeae3fa70987722e3d89c", decimals: 18 },
    ],
  }),
  usd("219", "Astherus", "USDF", "crypto-backed", "centralized-dependent", {
    collateral: "USDT deposits deployed in delta-neutral strategies exclusively on Binance",
    pegMechanism: "1:1 USDT convertibility; yield from delta-neutral trading on Binance",
    links: [
      { label: "Website", url: "https://www.asterdex.com/en/usdf" },
      { label: "Twitter", url: "https://x.com/Aster_DEX" },
      { label: "Docs", url: "https://docs.asterdex.com/" },
    ],
    contracts: [
      { chain: "bsc", address: "0x5a110fc00474038f6c02e89c707d638602ea44b5", decimals: 18 },
    ],
  }),
  // FLEXUSD (id 21) removed — CoinFLEX exchange bankruptcy June 2022 (see cemetery)
  usd("252", "StandX DUSD", "DUSD", "crypto-backed", "centralized-dependent", {
    collateral: "USDT/USDC deposits converted to hedged crypto positions (BTC, ETH, SOL) via Ceffu",
    pegMechanism: "Delta-neutral hedging on centralized exchanges; 1:1 USDT/USDC redemption",
    links: [
      { label: "Website", url: "https://standx.com/" },
      { label: "Twitter", url: "https://x.com/StandX_Official" },
      { label: "Docs", url: "https://docs.standx.com/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xa48f322f8b3edff967629af79e027628b9dd1298", decimals: 18 },
    ],
  }),
  usd("218", "River Stablecoin", "satUSD", "crypto-backed", "centralized-dependent", {
    collateral: "BTC, ETH, BNB, and liquid staking tokens; no centralized stablecoin collateral accepted",
    pegMechanism: "Overcollateralized CDP with on-chain liquidation and redemption for $1 of collateral; operates on BNB Chain (not Ethereum or a Stage 1 L2)",
    links: [
      { label: "Website", url: "https://river.inc/" },
      { label: "Docs", url: "https://docs.river.inc" },
    ],
  }),

  // ── Rank 41-50 ───────────────────────────────────────────────────────
  other("249", "Brazilian Digital", "BRZ", "rwa-backed", "centralized", "BRL", {
    geckoId: "brz",
    collateral: "Brazilian real-denominated reserves",
    pegMechanism: "Direct redemption for BRL through Transfero",
    links: [
      { label: "Website", url: "https://transfero.com/stablecoins/brz/" },
      { label: "Twitter", url: "https://x.com/BrzToken" },
    ],
    jurisdiction: { country: "Brazil", regulator: "Central Bank of Brazil" },
    contracts: [
      { chain: "ethereum", address: "0x420412e765bfa6d85aaac94b4f7b708c89be2e2b", decimals: 4 },
    ],
  }),
  usd("306", "Gate USD", "GUSD", "rwa-backed", "centralized", {
    collateral: "U.S. dollar reserves held by Gate.io",
    pegMechanism: "Direct 1:1 redemption through Gate.io",
    links: [
      { label: "Website", url: "https://www.gate.com/" },
    ],
  }),
  usd("235", "Frax USD", "FRXUSD", "rwa-backed", "centralized-dependent", {
    collateral: "U.S. dollar deposits and T-bills managed by Frax Finance",
    pegMechanism: "Direct redemption backed by fiat reserves; depends on centralized banking partners",
    links: [
      { label: "Website", url: "https://frax.com/" },
      { label: "Twitter", url: "https://x.com/fraxfinance" },
      { label: "Docs", url: "https://docs.frax.com/protocol/assets/frxusd/frxusd" },
    ],
    jurisdiction: { country: "United States" },
    contracts: [
      { chain: "ethereum", address: "0xcacd6fd266af91b8aed52accc382b4e165586e29", decimals: 18 },
    ],
  }),
  usd("340", "rwaUSDi", "rwaUSDi", "crypto-backed", "centralized-dependent", {
    rwa: true,
    collateral: "Tokenized real-world assets (treasuries and fixed-income instruments)",
    pegMechanism: "NAV-based pricing with centralized RWA custodian backing",
    links: [
      { label: "Website", url: "https://multipli.fi/" },
      { label: "Dashboard", url: "https://app.multipli.fi/dashboard" },
      { label: "PoR", url: "https://verification.afiprotocol.xyz/multipli" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xA39986F96B80d04e8d7AeAaF47175F47C23FD0f4", decimals: 18 },
      { chain: "base", address: "0xd74FB32112b1eF5b4C428Fead8dA8d85A0019009", decimals: 18 },
    ],
  }),
  usd("271", "Avant USD", "avUSD", "rwa-backed", "centralized", {
    collateral: "Cash and cash equivalents",
    pegMechanism: "Direct 1:1 redemption through Avant",
    links: [
      { label: "Website", url: "https://www.avantprotocol.com/" },
      { label: "Twitter", url: "https://x.com/avantprotocol" },
      { label: "Docs", url: "https://docs.avantprotocol.com/" },
    ],
    jurisdiction: { country: "United States" },
    contracts: [
      { chain: "avalanche", address: "0x24de8771bc5ddb3362db529fc3358f2df3a0e346", decimals: 18 },
    ],
  }),
  usd("341", "Pleasing USD", "PUSD", "rwa-backed", "centralized-dependent", {
    collateral: "USDT reserves and tokenized gold (PGOLD) exposure",
    pegMechanism: "1:1 redeemability into USDT",
    links: [
      { label: "Twitter", url: "https://x.com/PleasingGolden" },
    ],
    contracts: [
      { chain: "arbitrum", address: "0xc8fb643d18f1e53698cfda5c8fdf0cdc03c1dbec", decimals: 18 },
    ],
  }),
  usd("339", "Re Protocol reUSD", "reUSD", "crypto-backed", "centralized-dependent", {
    yieldBearing: true, navToken: true,
    collateral: "USDC, USDe, and sUSDe deployed into fully collateralized quota-share reinsurance contracts and delta-neutral ETH basis / short-duration T-bill strategies",
    pegMechanism: "NAV-based pricing recalculated daily at UTC 00:00; yield accrues from reinsurance underwriting spread and basis trade; guardrails limit max single-day price moves",
    proofOfReserves: { type: "real-time", url: "https://app.re.xyz/transparency", provider: "The Network Firm / Chainlink" },
    links: [
      { label: "Website", url: "https://re.xyz/" },
      { label: "Twitter", url: "https://x.com/re_protocol" },
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
  }),
  usd("332", "pmUSD", "pmUSD", "rwa-backed", "centralized-dependent", {
    collateral: "Tokenized precious metals (gold) via RAAC protocol with Chainlink proof-of-reserves",
    pegMechanism: "Overcollateralized CDP backed by tokenized gold held by centralized custodian (I-ON Digital)",
    links: [
      { label: "Website", url: "https://pmusd.raac.io/" },
      { label: "Twitter", url: "https://x.com/Raacfi" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xc0c17dd08263c16f6b64e772fb9b723bf1344ddf", decimals: 18 },
    ],
  }),
  usd("202", "Anzen USDz", "USDz", "rwa-backed", "centralized", {
    rwa: true,
    collateral: "Tokenized private credit and real-world asset portfolio",
    pegMechanism: "NAV-based pricing with RWA portfolio backing",
    links: [
      { label: "Website", url: "https://anzen.finance/" },
      { label: "Twitter", url: "https://x.com/AnzenFinance" },
      { label: "Docs", url: "https://docs.anzen.finance/" },
    ],
    jurisdiction: { country: "United States" },
    contracts: [
      { chain: "ethereum", address: "0xa469b7ee9ee773642b3e93e842e5d9b5baa10067", decimals: 18 },
    ],
  }),
  usd("316", "CASH", "CASH", "rwa-backed", "centralized", {
    collateral: "Cash and cash equivalents",
    pegMechanism: "Direct 1:1 redemption through issuer",
    links: [
      { label: "Website", url: "https://stabl.fi/" },
      { label: "Twitter", url: "https://x.com/Stabl_Fi" },
    ],
    jurisdiction: { country: "United States" },
    contracts: [
      { chain: "polygon", address: "0x5d066d022ede10efa2717ed3d79f22f949f8c175", decimals: 18 },
    ],
  }),

  // ── Rank 51-60 ───────────────────────────────────────────────────────
  usd("284", "MNEE USD", "MNEE", "rwa-backed", "centralized", {
    collateral: "U.S. dollar reserves held in regulated accounts",
    pegMechanism: "Direct 1:1 redemption through MNEE",
    links: [
      { label: "Website", url: "https://www.mnee.io/" },
      { label: "Twitter", url: "https://x.com/MNEE_cash" },
    ],
    jurisdiction: { country: "Antigua and Barbuda", regulator: "FSRC", license: "Digital Asset Issuer" },
    contracts: [
      { chain: "ethereum", address: "0x8ccedbae4916b79da7f3f612efb2eb93a2bfd6cf", decimals: 18 },
    ],
  }),
  usd("257", "OpenEden TBILL", "TBILL", "rwa-backed", "centralized", {
    yieldBearing: true, rwa: true, navToken: true,
    collateral: "Short-term U.S. Treasury bills managed by BNY Investments, custodied by BNY",
    pegMechanism: "NAV-based pricing; institutional mint/redeem through regulated BVI fund structure",
    proofOfReserves: { type: "real-time", url: "https://openeden.com/tbill", provider: "Chainlink PoR" },
    links: [
      { label: "Website", url: "https://openeden.com/tbill" },
      { label: "Twitter", url: "https://x.com/OpenEden_X" },
      { label: "Docs", url: "https://docs.openeden.com/" },
    ],
    jurisdiction: { country: "British Virgin Islands", regulator: "BVI FSC", license: "Registered Professional Fund" },
    contracts: [
      { chain: "ethereum", address: "0xdd50c053c096cb04a3e3362e2b622529ec5f2e8a", decimals: 6 },
    ],
  }),
  other("66", "Frax Price Index", "FPI", "algorithmic", "centralized-dependent", "VAR", {
    geckoId: "frax-price-index",
    navToken: true,
    collateral: "FRAX and algorithmic mechanisms via Frax Finance",
    pegMechanism: "Algorithmic adjustment tied to CPI; depends on FRAX which depends on USDC",
    links: [
      { label: "Website", url: "https://frax.com/" },
      { label: "Twitter", url: "https://x.com/fraxfinance" },
    ],
    jurisdiction: { country: "United States" },
    contracts: [
      { chain: "ethereum", address: "0x5ca135cb8527d76e932f34b5145575f9d8cbe08e", decimals: 18 },
    ],
  }),
  usd("283", "Unitas", "USDU", "crypto-backed", "centralized-dependent", {
    collateral: "USDC deposits routed into Jupiter LP tokens (JLP) and hedged via CEX perpetual shorts",
    pegMechanism: "Delta-neutral hedging on Binance via Ceffu/Copper custody; USDC mint/redeem",
    links: [
      { label: "Website", url: "https://unitas.so/" },
      { label: "Twitter", url: "https://x.com/UnitasLabs" },
      { label: "Docs", url: "https://docs.unitas.so/" },
    ],
    contracts: [
      { chain: "bsc", address: "0xea953ea6634d55dac6697c436b1e81a679db5882", decimals: 18 },
    ],
  }),
  // DEUSD removed — collapsed Nov 2025 when Stream Finance failed
  usd("321", "USDH Stablecoin", "USDH", "rwa-backed", "centralized", {
    collateral: "U.S. dollar reserves",
    pegMechanism: "Direct 1:1 redemption through issuer",
    links: [
      { label: "Website", url: "https://nativemarkets.com/" },
      { label: "Twitter", url: "https://x.com/nativemarkets" },
    ],
    jurisdiction: { country: "United States" },
  }),
  usd("79", "Lista USD", "LISUSD", "crypto-backed", "centralized-dependent", {
    collateral: "BNB, ETH, and LSTs via CDPs; USDT/USDC/FDUSD via Peg Stability Module",
    pegMechanism: "PSM enabling 1:1 swaps with centralized stablecoins; CDP overcollateralization and liquidation",
    links: [
      { label: "Website", url: "https://lista.org/" },
      { label: "Twitter", url: "https://x.com/lista_dao" },
      { label: "Docs", url: "https://docs.bsc.lista.org" },
    ],
    contracts: [
      { chain: "bsc", address: "0x0782b6d8c4551b9760e74c0545a9bcd90bdc41e5", decimals: 18 },
    ],
  }),
  usd("241", "OpenDollar USDO", "USDO", "rwa-backed", "centralized", {
    collateral: "RWA-backed reserves",
    pegMechanism: "Direct redemption through issuer",
    proofOfReserves: { type: "real-time", url: "https://openeden.com/tbill", provider: "Chainlink PoR" },
    links: [
      { label: "Website", url: "https://openeden.com/" },
      { label: "Twitter", url: "https://x.com/OpenEden_X" },
      { label: "Docs", url: "https://docs.openeden.com/usdo/introduction" },
    ],
    jurisdiction: { country: "Bermuda", regulator: "BMA", license: "DABA License" },
    contracts: [
      { chain: "ethereum", address: "0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe", decimals: 18 },
    ],
  }),
  usd("166", "Cygnus Finance Global USD", "cgUSD", "rwa-backed", "centralized", {
    collateral: "U.S. dollar reserves via Cygnus Finance",
    pegMechanism: "Direct 1:1 redemption through Cygnus",
    links: [
      { label: "Website", url: "https://www.cygnus.finance/" },
      { label: "Twitter", url: "https://x.com/CygnusFi" },
    ],
    contracts: [
      { chain: "base", address: "0xca72827a3d211cfd8f6b00ac98824872b72cab49", decimals: 6 },
    ],
  }),

  // ── Rank 61-70 ───────────────────────────────────────────────────────
  eur("254", "EUR CoinVertible", "EURCV", "rwa-backed", "centralized", {
    geckoId: "societe-generale-forge-eurcv",
    collateral: "Euro-denominated bank deposits at Societe Generale",
    pegMechanism: "Direct 1:1 redemption through SG-FORGE",
    proofOfReserves: { type: "self-reported", url: "https://www.sgforge.com/product/coinvertible/", provider: "SG-FORGE" },
    links: [
      { label: "Website", url: "https://www.sgforge.com/product/coinvertible/" },
      { label: "Twitter", url: "https://x.com/sgforge" },
    ],
    jurisdiction: { country: "France", regulator: "ACPR", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x5f7827fdeb7c20b443265fc2f40845b715385ff2", decimals: 18 },
    ],
  }),
  // USP (id 97) removed — Platypus exploited in 2023, protocol defunct (see cemetery)
  eur("147", "Anchored Coins AEUR", "AEUR", "rwa-backed", "centralized", {
    geckoId: "anchored-coins-eur",
    collateral: "Euro-denominated reserves held in Swiss bank accounts",
    pegMechanism: "Direct 1:1 redemption through Anchored Coins",
    links: [
      { label: "Website", url: "https://www.anchoredcoins.com/en/landing/aeur" },
      { label: "Twitter", url: "https://x.com/AnchoredCoins" },
    ],
    jurisdiction: { country: "Switzerland", regulator: "FINMA (VQF)", license: "SRO Member" },
    contracts: [
      { chain: "ethereum", address: "0xa40640458fbc27b6eefedea1e9c9e17d4cee7a21", decimals: 18 },
    ],
  }),
  // BUSD (id 4) removed — regulatory shutdown Feb 2023 (see cemetery)
  usd("275", "Quantoz USDQ", "USDQ", "rwa-backed", "centralized", {
    geckoId: "quantoz-usdq",
    collateral: "Euro/USD reserves held in regulated accounts",
    pegMechanism: "Direct 1:1 redemption through Quantoz",
    links: [
      { label: "Website", url: "https://www.quantoz.com/products/eurq-usdq" },
    ],
    jurisdiction: { country: "Netherlands", regulator: "DNB", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0xc83e27f270cce0a3a3a29521173a83f402c1768b", decimals: 6 },
    ],
  }),
  usd("256", "Resupply USD", "REUSD", "crypto-backed", "centralized-dependent", {
    collateral: "crvUSD lending positions and Curve LP tokens",
    pegMechanism: "Depends on crvUSD ecosystem which relies on centralized stablecoin peg keepers",
    links: [
      { label: "Website", url: "https://resupply.fi/" },
      { label: "Twitter", url: "https://x.com/ResupplyFi" },
      { label: "Docs", url: "https://docs.resupply.fi/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x57ab1e0003f623289cd798b1824be09a793e4bec", decimals: 18 },
    ],
  }),
  eur("325", "Eurite", "EURI", "rwa-backed", "centralized", {
    geckoId: "eurite",
    collateral: "Euro-denominated reserves",
    pegMechanism: "Direct 1:1 redemption through Eurite (Binance)",
    proofOfReserves: { type: "independent-audit", url: "https://www.eurite.com/" },
    links: [
      { label: "Website", url: "https://www.eurite.com/" },
    ],
    jurisdiction: { country: "Luxembourg", regulator: "CSSF", license: "Credit Institution (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x9d1a7a3191102e9f900faa10540837ba84dcbae7", decimals: 18 },
    ],
  }),
  usd("19", "Gemini Dollar", "GUSD", "rwa-backed", "centralized", {
    collateral: "U.S. dollar deposits held at State Street Bank",
    pegMechanism: "Direct 1:1 redemption through Gemini",
    proofOfReserves: { type: "independent-audit", url: "https://www.gemini.com/dollar", provider: "BPM LLP" },
    links: [
      { label: "Website", url: "https://www.gemini.com/dollar" },
      { label: "Twitter", url: "https://x.com/gemini" },
    ],
    jurisdiction: { country: "United States", regulator: "NYDFS", license: "Trust Charter" },
    contracts: [
      { chain: "ethereum", address: "0x056fd409e1d7a124bd7017459dfea2f387b6d5cd", decimals: 2 },
    ],
  }),
  usd("11", "Pax Dollar", "USDP", "rwa-backed", "centralized", {
    collateral: "U.S. dollar deposits and T-bills held in bankruptcy-remote accounts",
    pegMechanism: "Direct 1:1 redemption through Paxos",
    proofOfReserves: { type: "independent-audit", url: "https://www.paxos.com/usdp-transparency", provider: "KPMG" },
    links: [
      { label: "Website", url: "https://www.paxos.com/usdp" },
      { label: "Twitter", url: "https://x.com/paxos" },
    ],
    jurisdiction: { country: "United States", regulator: "NYDFS", license: "Trust Charter" },
    contracts: [
      { chain: "ethereum", address: "0x8e870d67f660d95d5be530380d0ec0bd388289e1", decimals: 18 },
    ],
  }),
  usd("263", "Hex Trust USDX", "USDX", "rwa-backed", "centralized", {
    collateral: "U.S. dollar reserves",
    pegMechanism: "Direct 1:1 redemption through Hex Trust",
    links: [
      { label: "Website", url: "https://www.htdigitalassets.com/" },
      { label: "Twitter", url: "https://x.com/Hex_Trust" },
    ],
    jurisdiction: { country: "Hong Kong", license: "TCSP License" },
    contracts: [
      { chain: "ethereum", address: "0xf8750b54d86be7ae9e32b4a0c826811198d63313", decimals: 18 },
    ],
  }),

  // ── Rank 71-80 ───────────────────────────────────────────────────────
  usd("290", "StraitsX XUSD", "XUSD", "rwa-backed", "centralized", {
    collateral: "U.S. dollar reserves held in regulated accounts",
    pegMechanism: "Direct 1:1 redemption through StraitsX",
    proofOfReserves: { type: "independent-audit", url: "https://www.straitsx.com/xusd" },
    links: [
      { label: "Website", url: "https://www.straitsx.com/xusd" },
      { label: "Twitter", url: "https://x.com/straitsx" },
    ],
    jurisdiction: { country: "Singapore", regulator: "MAS", license: "Major Payment Institution" },
    contracts: [
      { chain: "ethereum", address: "0xc08e7e23c235073c6807c2efe7021304cb7c2815", decimals: 6 },
    ],
  }),
  usd("313", "Metamask USD", "MUSD", "rwa-backed", "centralized", {
    collateral: "U.S. Treasury bills in bankruptcy-remote accounts via Bridge (Stripe) and Blackstone",
    pegMechanism: "Direct fiat on/off-ramp redemption through Bridge/Stripe",
    links: [
      { label: "Website", url: "https://metamask.io/news/introducing-metamask-usd-your-dollar-your-wallet" },
    ],
    jurisdiction: { country: "United States" },
    contracts: [
      { chain: "ethereum", address: "0xaca92e438df0b2401ff60da7e4337b687a2435da", decimals: 6 },
    ],
  }),
  usd("255", "Aegis YUSD", "YUSD", "rwa-backed", "centralized", {
    geckoId: "aegis-yusd",
    collateral: "U.S. dollar reserves",
    pegMechanism: "Direct 1:1 redemption through Aegis",
    proofOfReserves: { type: "real-time", url: "https://aegis.accountable.capital/", provider: "Accountable" },
    links: [
      { label: "Website", url: "https://aegis.im/" },
      { label: "Twitter", url: "https://x.com/aegis_im" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
    contracts: [
      { chain: "ethereum", address: "0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a", decimals: 18 },
    ],
  }),
  usd("22", "sUSD", "SUSD", "crypto-backed", "centralized-dependent", {
    collateral: "SNX, ETH, and USDC/stataUSDC via Synthetix V3; V2 was SNX-only",
    pegMechanism: "Overcollateralization via C-ratio (200%+); V3 added USDC as core collateral on Base",
    links: [
      { label: "Website", url: "https://www.synthetix.io/" },
      { label: "Twitter", url: "https://x.com/synthetix_io" },
    ],
    jurisdiction: { country: "Australia" },
    contracts: [
      { chain: "ethereum", address: "0x57ab1ec28d129707052df4df418d58a2d46d5f51", decimals: 18 },
    ],
  }),
  usd("269", "Liquity BOLD", "BOLD", "crypto-backed", "decentralized", {
    geckoId: "liquity-bold-2",
    collateral: "ETH and ETH liquid staking tokens (wstETH, rETH) only",
    pegMechanism: "Overcollateralized CDPs with on-chain redemption for $1 of ETH collateral",
    links: [
      { label: "Website", url: "https://www.liquity.org/bold" },
      { label: "Twitter", url: "https://x.com/LiquityProtocol" },
      { label: "Docs", url: "https://docs.liquity.org/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x6440f144b7e50d6a8439336510312d2f54beb01d", decimals: 18 },
    ],
  }),
  usd("302", "Hylo HYUSD", "HYUSD", "crypto-backed", "centralized-dependent", {
    geckoId: "hylo-usd",
    collateral: "Diversified basket of Solana LSTs (mSOL, jitoSOL, bSOL, JupSOL)",
    pegMechanism: "Overcollateralization (160%+) with companion leveraged token (xSOL) absorbing SOL volatility; operates on Solana (not Ethereum or a Stage 1 L2)",
    links: [
      { label: "Website", url: "https://hylo.so/" },
      { label: "Twitter", url: "https://x.com/hylo_so" },
    ],
  }),
  usd("8", "Liquity USD", "LUSD", "crypto-backed", "decentralized", {
    collateral: "ETH only; minimum 110% collateralization ratio",
    pegMechanism: "Overcollateralized CDP with direct ETH redemption at $1 face value",
    links: [
      { label: "Website", url: "https://www.liquity.org/" },
      { label: "Twitter", url: "https://x.com/LiquityProtocol" },
      { label: "Docs", url: "https://docs.liquity.org/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x5f98805a4e8be255a32880fdec7f6728c6568ba0", decimals: 18 },
    ],
  }),
  usd("168", "fxUSD", "fxUSD", "crypto-backed", "centralized-dependent", {
    collateral: "wstETH and WBTC split into stable (fxUSD) and leveraged components",
    pegMechanism: "Stability Pool uses USDC to buy fxUSD below peg and sell above; ETH collateral redemption",
    links: [
      { label: "Website", url: "https://fx.aladdin.club" },
      { label: "Twitter", url: "https://x.com/protocol_fx" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x085780639cc2cacd35e474e71f4d000e2405d8f6", decimals: 18 },
    ],
  }),
  usd("282", "Noble Dollar", "USDN", "rwa-backed", "centralized", {
    collateral: "U.S. Treasury securities via M0 protocol",
    pegMechanism: "Direct redemption backed by T-bills through Noble/M0",
    links: [
      { label: "Website", url: "https://noble.xyz/usdn" },
      { label: "Twitter", url: "https://x.com/noble_xyz" },
    ],
  }),

  // ── Rank 81-90 ───────────────────────────────────────────────────────
  usd("10", "Magic Internet Money", "MIM", "crypto-backed", "centralized-dependent", {
    collateral: "Interest-bearing tokens (yvDAI, xSUSHI, yvUSDT) via Abracadabra CDPs",
    pegMechanism: "Overcollateralized lending with yield-bearing collateral; depends on underlying stablecoin positions",
    contracts: [
      { chain: "ethereum", address: "0x99d8a9c45b2eca8864373a26d1459e3dff1e17f3", decimals: 18 },
    ],
    supplyMethod: {
      type: "exclude", // totalSupply() includes unborrowed MIM across 45+ Cauldron contracts; DefiLlama tracks actual debt
    },
  }),
  usd("307", "USD CoinVertible", "USDCV", "rwa-backed", "centralized", {
    collateral: "U.S. dollar reserves via Societe Generale FORGE",
    pegMechanism: "Direct 1:1 redemption through SG-FORGE",
    proofOfReserves: { type: "self-reported", url: "https://www.sgforge.com/product/coinvertible/", provider: "SG-FORGE" },
    links: [
      { label: "Website", url: "https://www.sgforge.com/product/coinvertible/" },
      { label: "Twitter", url: "https://x.com/sgforge" },
    ],
    jurisdiction: { country: "France", regulator: "ACPR", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x5422374b27757da72d5265cc745ea906e0446634", decimals: 18 },
    ],
  }),
  usd("231", "Honey", "HONEY", "crypto-backed", "centralized-dependent", {
    collateral: "1:1 basket of USDC, USDT0, pyUSD, and USDe on Berachain",
    pegMechanism: "Direct 1:1 mint/redeem against centralized stablecoin collateral with Basket Mode safety",
    links: [
      { label: "Website", url: "https://honey.berachain.com/" },
      { label: "Twitter", url: "https://x.com/berachain" },
      { label: "Docs", url: "https://docs.berachain.com/learn/pol/tokens/honey" },
    ],
  }),
  other("226", "Frankencoin", "ZCHF", "crypto-backed", "decentralized", "CHF", {
    geckoId: "frankencoin",
    collateral: "WBTC and ETH in oracle-free overcollateralized positions (~230%)",
    pegMechanism: "Auction-based collateral valuation with veto governance; no price oracle dependency",
    links: [
      { label: "Website", url: "https://www.frankencoin.com/" },
      { label: "Twitter", url: "https://x.com/frankencoinzchf" },
      { label: "Docs", url: "https://docs.frankencoin.com/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xb58e61c3098d85632df34eecfb899a1ed26985bc", decimals: 18 },
    ],
  }),
  usd("172", "USDB Blast", "USDB", "crypto-backed", "centralized-dependent", {
    yieldBearing: true,
    collateral: "USDC and USDT bridged to Blast L2; yield from Maker DSR and T-bills",
    pegMechanism: "Automatic rebasing with yield from underlying centralized stablecoin strategies",
    links: [
      { label: "Website", url: "https://blast.io/" },
      { label: "Twitter", url: "https://x.com/Blast_L2" },
      { label: "Docs", url: "https://docs.blast.io/" },
    ],
  }),
  usd("225", "Zoth ZeUSD", "ZeUSD", "rwa-backed", "centralized", {
    rwa: true,
    collateral: "Tokenized RWA (treasuries and fixed-income instruments)",
    pegMechanism: "NAV-based pricing with RWA backing",
    links: [
      { label: "Website", url: "https://zoth.io/" },
      { label: "Twitter", url: "https://x.com/zothdotio" },
    ],
    jurisdiction: { country: "Cayman Islands" },
  }),
  eur("101", "Monerium EUR emoney", "EURE", "rwa-backed", "centralized", {
    geckoId: "monerium-eur-money",
    collateral: "Euro-denominated bank deposits in licensed European institutions",
    pegMechanism: "Direct 1:1 redemption through Monerium",
    links: [
      { label: "Website", url: "https://monerium.com/" },
      { label: "Twitter", url: "https://x.com/monerium" },
    ],
    jurisdiction: { country: "Iceland", regulator: "Central Bank of Iceland", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x3231cb76718cdef2155fc47b5286d82e6eda273f", decimals: 18 },
      { chain: "gnosis", address: "0xcb444e90d8198415266c6a2724b7900fb12fc56e", decimals: 18 },
    ],
  }),
  usd("230", "Noon USN", "USN", "crypto-backed", "centralized-dependent", {
    collateral: "USDC/USDT deposits and short-term U.S. Treasury bills via custodians (Ceffu, Alpaca)",
    pegMechanism: "1:1 mint/redeem against USDC/USDT; delta-neutral yield strategies on centralized exchanges",
    contracts: [
      { chain: "ethereum", address: "0xda67b4284609d2d48e5d10cfac411572727dc1ed", decimals: 18 },
    ],
  }),
  usd("185", "Gyroscope GYD", "GYD", "crypto-backed", "centralized-dependent", {
    geckoId: "gyroscope-gyd",
    collateral: "Diversified reserve of sDAI, USDC, LUSD, and crvUSD in yield-generating vaults",
    pegMechanism: "Primary-market AMM (PAMM) adjusts redemption prices based on reserve ratio",
    links: [
      { label: "Website", url: "https://www.gyro.finance/" },
      { label: "Twitter", url: "https://x.com/GyroStable" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xe07f9d810a48ab5c3c914ba3ca53af14e4491e8a", decimals: 18 },
    ],
  }),
  usd("329", "Nectar", "NECT", "crypto-backed", "centralized-dependent", {
    collateral: "Berachain-native assets: pumpBTC, uniBTC, beraETH, iBGT, iBERA, and LP positions",
    pegMechanism: "Overcollateralized CDP with redemption for collateral at $1 face value (Liquity-style); operates on Berachain (not Ethereum or a Stage 1 L2)",
    links: [
      { label: "Website", url: "https://www.beraborrow.com/" },
      { label: "Twitter", url: "https://x.com/beraborrow" },
    ],
    jurisdiction: { country: "Croatia" },
  }),

  // ── Rank 91-100 ──────────────────────────────────────────────────────
  usd("106", "Electronic USD", "EUSD", "crypto-backed", "centralized-dependent", {
    collateral: "ETH LSTs (stETH, rETH, WBETH, swETH) with 150% minimum collateral ratio",
    pegMechanism: "Overcollateralized CDP with Curve eUSD/3CRV pool and USDC premium suppression mechanism",
    links: [
      { label: "Website", url: "https://lybra.finance/" },
      { label: "Twitter", url: "https://x.com/LybraFinance" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xdf3ac4f479375802a821f7b7b46cd7eb5e4262cc", decimals: 18 },
    ],
  }),
  usd("154", "Bucket Protocol BUCK", "BUCK", "crypto-backed", "centralized-dependent", {
    collateral: "SUI, BTC, ETH, and LSTs via CDPs; USDC/USDT via Peg Stability Module",
    pegMechanism: "Overcollateralized CDPs plus PSM enabling 1:1 swaps with USDC/USDT",
    links: [
      { label: "Website", url: "https://www.bucketprotocol.io/" },
      { label: "Twitter", url: "https://x.com/bucket_protocol" },
    ],
  }),
  eur("55", "EURA", "EURA", "crypto-backed", "centralized-dependent", {
    geckoId: "ageur",
    collateral: "Crypto assets and over-collateralized positions via Angle Protocol",
    pegMechanism: "Hedging agents and standard LPs maintain EUR peg; depends on USDC/DAI liquidity",
    links: [
      { label: "Website", url: "https://www.angle.money/eura" },
      { label: "Twitter", url: "https://x.com/AngleProtocol" },
      { label: "Docs", url: "https://docs.angle.money/" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
    contracts: [
      { chain: "ethereum", address: "0x1a7e4e63778b4f12a199c062f3efdd288afcbce8", decimals: 18 },
    ],
  }),
  usd("303", "Mezo USD", "meUSD", "crypto-backed", "centralized-dependent", {
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
  }),
  usd("305", "XSY UTY", "UTY", "crypto-backed", "centralized-dependent", {
    collateral: "Delta-neutral positions pairing long AVAX spot with short perpetual futures",
    pegMechanism: "Automated delta-neutral rebalancing of AVAX spot vs perpetual futures positions",
    links: [
      { label: "Website", url: "https://xsy.fi/" },
      { label: "Twitter", url: "https://x.com/xsy_fi" },
    ],
    jurisdiction: { country: "United States" },
    contracts: [
      { chain: "avalanche", address: "0xdbc5192a6b6ffee7451301bb4ec312f844f02b4a", decimals: 18 },
    ],
  }),
  eur("51", "Stasis Euro", "EURS", "rwa-backed", "centralized", {
    geckoId: "stasis-eurs",
    collateral: "Euro-denominated reserves verified by independent auditors",
    pegMechanism: "Direct 1:1 redemption through Stasis",
    proofOfReserves: { type: "independent-audit", url: "https://stasis.net/transparency", provider: "BDO Malta" },
    links: [
      { label: "Website", url: "https://stasis.net/" },
      { label: "Twitter", url: "https://x.com/stasisnet" },
    ],
    jurisdiction: { country: "Malta", regulator: "MFSA", license: "MiCA" },
    contracts: [
      { chain: "ethereum", address: "0xdb25f211ab05b1c97d595516f45794528a807ad8", decimals: 2 },
    ],
  }),
  // USD+ (id 46) removed — protocol abandoned 2025 (see cemetery)
  // FUSD removed — Fantom USD de-pegged 2022, zombie stablecoin (see cemetery)
  usd("326", "Metronome Synth USD", "MSUSD", "crypto-backed", "centralized-dependent", {
    collateral: "USDC, FRAX, DAI, ETH, WBTC, and yield-bearing versions (vaUSDC, vaFRAX)",
    pegMechanism: "Inter-synth arbitrage swaps with mintage caps tied to stablecoin deposit limits",
    links: [
      { label: "Website", url: "https://metronome.io/" },
      { label: "Twitter", url: "https://x.com/MetronomeDAO" },
    ],
  }),
  // ── Additional tracked ─────────────────────────────────────────────
  usd("346", "Neutrl USD", "NUSD", "crypto-backed", "centralized-dependent", {
    collateral: "Delta-neutral positions combining OTC-discounted crypto tokens with perpetual futures hedges, plus liquid stablecoin reserves on institutional custodians",
    pegMechanism: "1:1 minting and redemption against USDC/USDT/USDe with arbitrage incentives",
    links: [
      { label: "Website", url: "https://www.neutrl.fi/" },
      { label: "Twitter", url: "https://x.com/neutral_project" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xe556aba6fe6036275ec1f87eda296be72c811bce", decimals: 18 },
    ],
  }),
  usd("344", "Yuzu USD", "YZUSD", "crypto-backed", "centralized-dependent", {
    collateral: "Overcollateralized by on-chain DeFi yield strategies; mint/redeem is 1:1 with USDC",
    pegMechanism: "1:1 USDC mint/redeem for KYC'd investors; overcollateralization with on-chain risk tranching",
    links: [
      { label: "Website", url: "https://yuzu.money/" },
      { label: "Twitter", url: "https://x.com/YuzuMoneyX" },
    ],
  }),
  usd("335", "JupUSD", "JUPUSD", "rwa-backed", "centralized-dependent", {
    rwa: true,
    collateral: "90% USDtb (BlackRock BUIDL tokenized Treasuries via Ethena/Securitize) and 10% USDC liquidity buffer",
    pegMechanism: "Solana-native mint/redeem backed by USDtb reserves; integrated across Jupiter DEX",
    links: [
      { label: "Website", url: "https://jupusd.money/" },
      { label: "Twitter", url: "https://x.com/JupiterExchange" },
    ],
  }),
  usd("342", "MegaUSD", "USDM", "rwa-backed", "centralized-dependent", {
    rwa: true, geckoId: "megausd",
    collateral: "USDtb (BlackRock BUIDL tokenized Treasuries via Ethena/Securitize) with liquid stablecoins for redemptions",
    pegMechanism: "Issued on Ethena's USDtb rails; reserve yield funds MegaETH sequencer costs",
    links: [
      { label: "Website", url: "https://www.megaeth.com/" },
      { label: "Twitter", url: "https://x.com/megaeth" },
    ],
  }),
  usd("343", "Tether USA-T", "USAT", "rwa-backed", "centralized", {
    collateral: "U.S. Treasury bills held by Anchorage Digital Bank under GENIUS Act federal regulation",
    pegMechanism: "Direct 1:1 redemption through Tether/Anchorage Digital Bank",
    proofOfReserves: { type: "independent-audit", url: "https://tether.to/en/transparency" },
    links: [
      { label: "Website", url: "https://usat.io/" },
      { label: "Twitter", url: "https://x.com/Tether_to" },
    ],
    jurisdiction: { country: "United States", regulator: "OCC", license: "Federal Bank Charter" },
    contracts: [
      { chain: "ethereum", address: "0x07041776f5007aca2a54844f50503a18a72a8b68", decimals: 6 },
    ],
  }),
  usd("24", "Celo Dollar", "cUSD", "algorithmic", "centralized-dependent", {
    collateral: "Mento reserve containing USDC, DAI, plus BTC, ETH, and CELO (110%+ overcollateralization)",
    pegMechanism: "Constant-product market maker arbitrage against reserve assets including centralized stablecoins",
    links: [
      { label: "Website", url: "https://celo.org/" },
      { label: "Twitter", url: "https://x.com/celoorg" },
      { label: "Docs", url: "https://docs.celo.org/learn/platform-native-stablecoins-summary" },
    ],
    jurisdiction: { country: "Germany" },
    contracts: [
      { chain: "celo", address: "0x765de816845861e75a25fca122bb6898b8b1282a", decimals: 18 },
    ],
  }),
  usd("20", "Alchemix USD", "ALUSD", "crypto-backed", "centralized-dependent", {
    collateral: "DAI, USDC, USDT, and their yield-bearing vault tokens (yvDAI, yvUSDC, yvUSDT) via Alchemix CDPs",
    pegMechanism: "Self-repaying loans: yield from deposited stablecoin collateral automatically repays debt; Transmuter guarantees 1:1 redemption",
    links: [
      { label: "Website", url: "https://alchemix.fi/" },
      { label: "Twitter", url: "https://x.com/alchemixfi" },
    ],
    jurisdiction: { country: "Saint Kitts and Nevis" },
    contracts: [
      { chain: "ethereum", address: "0xbc6da0fe9ad5f3b0d58160288917aa56653660e9", decimals: 18 },
    ],
  }),
  usd("251", "Felix feUSD", "FEUSD", "crypto-backed", "centralized-dependent", {
    collateral: "HYPE, WBTC, ETH, and liquid staking tokens via overcollateralized CDPs on Hyperliquid",
    pegMechanism: "Overcollateralized CDP with direct redemption for $1 of collateral; operates on Hyperliquid (not Ethereum or a Stage 1 L2)",
    links: [
      { label: "Twitter", url: "https://x.com/felixprotocol" },
    ],
  }),
  usd("348", "Fidelity Digital Dollar", "FIDD", "rwa-backed", "centralized", {
    collateral: "Cash, U.S. Treasury securities, and cash equivalents held at The Bank of New York Mellon",
    pegMechanism: "Direct 1:1 redemption through Fidelity Digital Assets platforms",
    proofOfReserves: { type: "independent-audit", url: "https://www.fidelitydigitalassets.com/stablecoin", provider: "PricewaterhouseCoopers" },
    links: [
      { label: "Website", url: "https://www.fidelitydigitalassets.com/stablecoin" },
    ],
    jurisdiction: { country: "United States", regulator: "OCC", license: "National Trust Bank Charter" },
    contracts: [
      { chain: "ethereum", address: "0x7c135549504245b5eae64fc0e99fa5ebabb8e35d", decimals: 18 },
    ],
  }),
  usd("347", "USDGO", "USDGO", "rwa-backed", "centralized", {
    collateral: "U.S. Treasuries and high-quality liquid assets held by Anchorage Digital Bank",
    pegMechanism: "1:1 USD redemption through Anchorage Digital Bank under U.S. federal oversight",
    links: [
      { label: "Website", url: "https://www.osl.com/hk-en/press-release/osl-group-unveils-usdgo-stablecoin-to-strengthen-global-compliant-payment-network" },
      { label: "Twitter", url: "https://x.com/osldotcom" },
    ],
    jurisdiction: { country: "United States", regulator: "OCC", license: "Federal Bank Charter" },
  }),
  usd("297", "Main Street USD", "MSUSD", "crypto-backed", "centralized-dependent", {
    collateral: "USDC deposits deployed into institutional-grade options volatility arbitrage strategies on centralized exchanges",
    pegMechanism: "Delta-neutral options strategy; always redeemable 1:1 for USDC",
    links: [
      { label: "Website", url: "https://mainstreet.finance/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xab5eb14c09d416f0ac63661e57edb7aecdb9befa", decimals: 18 },
    ],
  }),
  usd("215", "Moneta", "USDM", "rwa-backed", "centralized", {
    collateral: "1:1 USD reserves custodied by Norwegian Block Exchange (NBX)",
    pegMechanism: "Direct 1:1 redemption through Moneta",
    proofOfReserves: { type: "self-reported", url: "https://portal.charli3.io/dev/feeds/usdm-reserves?network=Mainnet", provider: "Charli3" },
    links: [
      { label: "Website", url: "https://moneta.global/" },
    ],
    jurisdiction: { country: "United States", regulator: "FinCEN" },
    contracts: [
      { chain: "ethereum", address: "0x59d9356e565ab3a36dd77763fc0d87feaf85508c", decimals: 18 },
    ],
  }),
  usd("312", "Hydrated Dollar", "HOLLAR", "crypto-backed", "centralized-dependent", {
    collateral: "Overcollateralized by DOT, ETH, WBTC, USDT, USDC, and liquid staking tokens on Hydration",
    pegMechanism: "Overcollateralized CDP with liquidation; accepts centralized stablecoins as collateral",
    links: [
      { label: "Website", url: "https://hydration.net/" },
    ],
  }),
  usd("245", "Anzens USDA", "USDA", "rwa-backed", "centralized", {
    collateral: "USD and dollar-equivalent reserves including U.S. Treasuries, custodied by BitGo Trust",
    pegMechanism: "Direct 1:1 redemption through Anzens (EMURGO/Cardano founding entity partnership)",
    links: [
      { label: "Website", url: "https://www.anzens.com/" },
    ],
  }),
  usd("75", "Youves uUSD", "UUSD", "crypto-backed", "centralized-dependent", {
    collateral: "XTZ (Tezos native token) at 300% minimum overcollateralization ratio",
    pegMechanism: "Overcollateralized CDP on Tezos; purely crypto-backed but on a chain outside the Ethereum/L2 ecosystem",
  }),
  usd("327", "Mu Digital AZND", "AZND", "rwa-backed", "centralized", {
    yieldBearing: true, rwa: true, navToken: true,
    collateral: "Senior-tranche Asian institutional credit instruments (bonds and credit) providing 6-7% native yield",
    pegMechanism: "Tokenized exposure to Asian credit markets; price appreciates as yield accrues",
    links: [
      { label: "Website", url: "https://mudigital.net/" },
    ],
  }),
  usd("266", "Plume USD", "pUSD", "rwa-backed", "centralized", {
    collateral: "USDC held 1:1 in a BoringVault on Plume Chain",
    pegMechanism: "Direct 1:1 redemption for USDC through Plume Network",
    links: [
      { label: "Website", url: "https://plume.org/pusd" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xdddd73f5df1f0dc31373357beac77545dc5a6f3f", decimals: 6 },
    ],
  }),
  usd("234", "Worldwide USD", "WUSD", "rwa-backed", "centralized", {
    collateral: "USD fiat reserves including cash equivalents and short-term treasury bills",
    pegMechanism: "Direct 1:1 redemption through WSPN",
    links: [
      { label: "Website", url: "https://wspn.io/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x7cd017ca5ddb86861fa983a34b5f495c6f898c41", decimals: 18 },
      { chain: "polygon", address: "0x7cd017ca5ddb86861fa983a34b5f495c6f898c41", decimals: 18 },
    ],
  }),
  usd("324", "Brale SBC", "SBC", "rwa-backed", "centralized", {
    collateral: "Cash, cash equivalents, and U.S. Treasuries held at regulated financial institutions",
    pegMechanism: "Direct 1:1 redemption through Brale (licensed money transmitter)",
    links: [
      { label: "Website", url: "https://brale.xyz/stablecoins/SBC" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xf9fb20b8e097904f0ab7d12e9dbee88f2dcd0f16", decimals: 18 },
      { chain: "polygon", address: "0xfdcc3dd6671eab0709a4c0f3f53de9a333d80798", decimals: 18 },
      { chain: "base", address: "0xfdcc3dd6671eab0709a4c0f3f53de9a333d80798", decimals: 18 },
    ],
  }),
  usd("23", "Origin Dollar", "OUSD", "crypto-backed", "centralized-dependent", {
    yieldBearing: true,
    collateral: "USDC, USDT, and USDS deployed into DeFi strategies (Morpho, Curve/Convex, Sky)",
    pegMechanism: "1:1 minting/redemption backed by stablecoins; yield distributed via rebasing",
    links: [
      { label: "Website", url: "https://www.ousd.com/" },
      { label: "Twitter", url: "https://x.com/OriginProtocol" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x2a8e1e676ec238d8a992307b495b45b3feaa5e86", decimals: 18 },
    ],
  }),
  usd("183", "Bitcoin USD", "BtcUSD", "crypto-backed", "centralized-dependent", {
    collateral: "Overcollateralized Bitcoin (WBTC, BTCB) via CDP vaults",
    pegMechanism: "Overcollateralized CDP with liquidation mechanisms",
    links: [
      { label: "Website", url: "https://www.btcfi.one/" },
    ],
    contracts: [
      { chain: "base", address: "0xe4b20925d9e9a62f1e492e15a81dc0de62804dd4", decimals: 18 },
    ],
  }),
  usd("253", "Bima USBD", "USBD", "crypto-backed", "centralized-dependent", {
    collateral: "Overcollateralized BTC derivatives (WBTC, iBTC, LBTC) at 160% minimum ratio",
    pegMechanism: "Overcollateralized CDP (Liquity-style TroveManager) with automated liquidation",
    links: [
      { label: "Website", url: "https://bima.money/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x6bede1c6009a78c222d9bdb7974bb67847fdb68c", decimals: 18 },
      { chain: "bsc", address: "0x6bede1c6009a78c222d9bdb7974bb67847fdb68c", decimals: 18 },
    ],
  }),
  usd("331", "PikuDAO USP", "USP", "crypto-backed", "centralized-dependent", {
    yieldBearing: true, navToken: true,
    collateral: "USDC and USDT deposits deployed into yield strategies (FX arbitrage, DeFi lending)",
    pegMechanism: "Backed 1:1 by stablecoins; token value appreciates as yield accrues",
    links: [
      { label: "Website", url: "https://piku.co/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0x098697ba3fee4ea76294c5d6a466a4e3b3e95fe6", decimals: 18 },
    ],
  }),
  usd("240", "StablR USD", "USDR", "rwa-backed", "centralized", {
    collateral: "Cash and short-term government bonds held with regulated European financial institutions",
    pegMechanism: "Direct 1:1 redemption through StablR (MFSA-supervised EMI)",
    proofOfReserves: { type: "independent-audit", url: "https://www.stablr.com/proof-of-reserve", provider: "Grant Thornton" },
    links: [
      { label: "Website", url: "https://www.stablr.com/usdr" },
      { label: "Twitter", url: "https://x.com/StablREuro" },
    ],
    jurisdiction: { country: "Malta", regulator: "MFSA", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x7b43e3875440b44613dc3bc08e7763e6da63c8f8", decimals: 6 },
    ],
  }),
  usd("304", "USDU Finance", "USDU", "crypto-backed", "centralized-dependent", {
    collateral: "Modular adapter system: Curve, Morpho, and TermMax vault assets as on-chain backing",
    pegMechanism: "Protocol-minted via DAO-approved adapters; convertible to USDC via Curve pools",
    links: [
      { label: "Website", url: "https://usdu.finance/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xdde3ec717f220fc6a29d6a4be73f91da5b718e55", decimals: 18 },
    ],
  }),

  // ── Additional non-USD pegs ────────────────────────────────────────
  other("289", "StraitsX XSGD", "XSGD", "rwa-backed", "centralized", "SGD", {
    geckoId: "xsgd",
    collateral: "Singapore dollar cash reserves held at DBS and Standard Chartered banks",
    pegMechanism: "Direct 1:1 redemption for SGD through StraitsX (MAS-licensed Major Payment Institution)",
    proofOfReserves: { type: "independent-audit", url: "https://www.straitsx.com/xsgd" },
    links: [
      { label: "Website", url: "https://www.straitsx.com/xsgd" },
      { label: "Twitter", url: "https://x.com/straitsx" },
    ],
    jurisdiction: { country: "Singapore", regulator: "MAS", license: "Major Payment Institution" },
    contracts: [
      { chain: "ethereum", address: "0x70e8de73ce538da2beed35d14187f6959a8eca96", decimals: 6 },
    ],
  }),
  other("122", "GYEN", "GYEN", "rwa-backed", "centralized", "JPY", {
    geckoId: "gyen",
    collateral: "Japanese yen reserves held at FDIC-insured banks",
    pegMechanism: "Direct 1:1 redemption for JPY through GMO Trust (NYDFS-chartered trust company)",
    proofOfReserves: { type: "independent-audit", url: "https://stablecoin.z.com/attestation/" },
    links: [
      { label: "Website", url: "https://stablecoin.z.com/" },
      { label: "Twitter", url: "https://x.com/GMOTrust" },
    ],
    jurisdiction: { country: "United States", regulator: "NYDFS", license: "Trust Charter" },
    contracts: [
      { chain: "ethereum", address: "0xc08512927d12348f6620a698105e1baac6ecd911", decimals: 6 },
    ],
  }),
  other("300", "BiLira", "TRYB", "rwa-backed", "centralized", "TRY", {
    geckoId: "bilira",
    collateral: "Turkish lira reserves held in Turkish bank accounts",
    pegMechanism: "Direct 1:1 redemption for TRY through BiLira",
    links: [
      { label: "Website", url: "https://www.bilira.co/en/product/tryb-stablecoin" },
      { label: "Twitter", url: "https://x.com/BiLira_Official" },
    ],
    jurisdiction: { country: "Turkey", regulator: "SPK/CMB" },
    contracts: [
      { chain: "ethereum", address: "0x2c537e5624e4af88a7ae4060c022609376c8d0eb", decimals: 6 },
    ],
  }),
  other("165", "AUDD", "AUDD", "rwa-backed", "centralized", "AUD", {
    geckoId: "novatti-australian-digital-dollar",
    collateral: "Australian dollar cash and cash equivalents held at Australian deposit-taking institutions",
    pegMechanism: "Direct 1:1 redemption for AUD through AUDC (Novatti subsidiary)",
    proofOfReserves: { type: "independent-audit", url: "https://www.audd.digital/", provider: "William Buck Audit" },
    links: [
      { label: "Website", url: "https://www.audd.digital/" },
      { label: "Twitter", url: "https://x.com/AUDD_digital" },
    ],
    jurisdiction: { country: "Australia", regulator: "ASIC", license: "AFSL" },
    contracts: [
      { chain: "ethereum", address: "0x4cce605ed955295432958d8951d0b176c10720d5", decimals: 6 },
    ],
  }),
  other("cg-jpyc", "JPY Coin", "JPYC", "rwa-backed", "centralized", "JPY", {
    geckoId: "jpy-coin",
    collateral: "Japanese yen deposits and Japanese government bonds (100% backed)",
    pegMechanism: "Direct 1:1 redemption for JPY through JPYC Inc. (FSA-registered Fund Transfer Service Provider)",
    links: [
      { label: "Website", url: "https://corporate.jpyc.co.jp/en" },
    ],
    jurisdiction: { country: "Japan", regulator: "FSA" },
    contracts: [
      { chain: "ethereum", address: "0x431d5dff03120afa4bdf332c61a6e1766ef37bdb", decimals: 18 },
    ],
  }),

  // ── Gold-Pegged (not in DefiLlama stablecoins API — data via DefiLlama coins/protocol APIs) ──
  // commodityOunces: troy ounces per token (used for peg deviation normalization)
  other("gold-xaut", "Tether Gold", "XAUT", "rwa-backed", "centralized", "GOLD", {
    rwa: true, commodityOunces: 1, geckoId: "tether-gold", protocolSlug: "tether-gold",
    collateral: "Physical gold bars held in Swiss vaults by Tether",
    pegMechanism: "Direct redemption for physical gold through Tether",
    proofOfReserves: { type: "independent-audit", url: "https://gold.tether.to/reports", provider: "BDO" },
    links: [
      { label: "Website", url: "https://gold.tether.to/" },
      { label: "Twitter", url: "https://x.com/tethergold" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
    contracts: [
      { chain: "ethereum", address: "0x68749665ff8d2d112fa859aa293f07a622782f38", decimals: 6 },
    ],
  }),
  other("gold-paxg", "PAX Gold", "PAXG", "rwa-backed", "centralized", "GOLD", {
    rwa: true, commodityOunces: 1, geckoId: "pax-gold", protocolSlug: "paxos-gold",
    collateral: "Physical gold bars held in London Brink's vaults by Paxos (NYDFS-regulated)",
    pegMechanism: "Direct redemption for physical gold through Paxos",
    proofOfReserves: { type: "independent-audit", url: "https://www.paxos.com/paxg-transparency", provider: "KPMG" },
    links: [
      { label: "Website", url: "https://www.paxos.com/pax-gold" },
      { label: "Twitter", url: "https://x.com/paxos" },
    ],
    jurisdiction: { country: "United States", regulator: "NYDFS", license: "Trust Charter" },
    contracts: [
      { chain: "ethereum", address: "0x45804880de22913dafe09f4980848ece6ecbaf78", decimals: 18 },
    ],
  }),
  other("gold-kau", "Kinesis Gold", "KAU", "rwa-backed", "centralized", "GOLD", {
    rwa: true, commodityOunces: 1 / 31.1035, geckoId: "kinesis-gold",
    collateral: "Investment-grade physical gold bullion (1 KAU = 1 gram)",
    pegMechanism: "Direct redemption for physical gold through Kinesis; yield via transaction fee sharing",
    proofOfReserves: { type: "independent-audit", url: "https://kinesis.money/trust-security/", provider: "Inspectorate International" },
    links: [
      { label: "Website", url: "https://kinesis.money/gold/" },
      { label: "Twitter", url: "https://x.com/KinesisMonetary" },
    ],
    jurisdiction: { country: "Cayman Islands", regulator: "CIMA", license: "VASP Registration" },
  }),
  other("gold-xaum", "Matrixdock Gold", "XAUm", "rwa-backed", "centralized", "GOLD", {
    rwa: true, commodityOunces: 1, geckoId: "matrixdock-gold",
    collateral: "LBMA-certified 99.99% pure gold bars held in Asian vaults",
    pegMechanism: "Direct redemption for physical gold through Matrixdock (Matrixport)",
    proofOfReserves: { type: "independent-audit", url: "https://www.matrixdock.com/blog/announcements/matrixdock-publishes-its-second-independent-audit-report-on-xaum-gold", provider: "Independent physical audit" },
    links: [
      { label: "Website", url: "https://www.matrixdock.com/xaum" },
      { label: "Twitter", url: "https://x.com/matrixdock" },
    ],
    jurisdiction: { country: "Singapore" },
    contracts: [
      { chain: "ethereum", address: "0x2103e845c5e135493bb6c2a4f0b8651956ea8682", decimals: 18 },
    ],
  }),
  other("gold-vro", "VeraOne", "VRO", "rwa-backed", "centralized", "GOLD", {
    rwa: true, commodityOunces: 1 / 31.1035, geckoId: "veraone",
    collateral: "Physical gold stored in secure zones in France (1 VRO = 1 gram of gold)",
    pegMechanism: "Direct redemption for physical gold through VeraCash",
    links: [
      { label: "Website", url: "https://music.veraone.net/" },
    ],
    jurisdiction: { country: "France" },
    contracts: [
      { chain: "ethereum", address: "0x10bc518c32fbae5e38ecb50a612160571bd81e44", decimals: 8 },
    ],
  }),
  other("gold-cgo", "Comtech Gold", "CGO", "rwa-backed", "centralized", "GOLD", {
    rwa: true, commodityOunces: 1 / 31.1035, geckoId: "comtech-gold",
    collateral: "Physical gold stored with Transguard in UAE (1 CGO = 1 gram of pure gold), Shariah-compliant",
    pegMechanism: "Direct redemption for physical gold through Comtech Gold (DMCC-endorsed)",
    links: [
      { label: "Website", url: "https://www.comtechgold.com/" },
    ],
    jurisdiction: { country: "United Arab Emirates" },
  }),
  other("gold-dgld", "DGLD Tokenized Gold", "DGLD", "rwa-backed", "centralized", "GOLD", {
    rwa: true, commodityOunces: 1, geckoId: "gold-token-sa-dgld-tokenized-gold",
    collateral: "LBMA-certified PAMP gold bars stored in Swiss vaults (1 DGLD = 1 troy ounce)",
    pegMechanism: "Direct redemption for physical gold through Gold Token SA (MKS PAMP subsidiary)",
    links: [
      { label: "Website", url: "https://dgld.ch/" },
    ],
    jurisdiction: { country: "Switzerland" },
    contracts: [
      { chain: "ethereum", address: "0xa9299c296d7830a99414d1e5546f5171fa01e9c8", decimals: 18 },
    ],
  }),

  // ── Silver-Pegged (data via DefiLlama coins API) ──────────────────────
  other("silver-kag", "Kinesis Silver", "KAG", "rwa-backed", "centralized", "SILVER", {
    rwa: true, commodityOunces: 1, geckoId: "kinesis-silver", // 1 troy ounce per token
    collateral: "Investment-grade physical silver bullion (1 KAG = 1 troy ounce)",
    pegMechanism: "Direct redemption for physical silver through Kinesis; yield via transaction fee sharing",
    proofOfReserves: { type: "independent-audit", url: "https://kinesis.money/trust-security/", provider: "Inspectorate International" },
    links: [
      { label: "Website", url: "https://kinesis.money/silver/" },
      { label: "Twitter", url: "https://x.com/KinesisMonetary" },
    ],
    jurisdiction: { country: "Cayman Islands", regulator: "CIMA", license: "VASP Registration" },
    contracts: [
      { chain: "ethereum", address: "0xf94d9b6dc4eacd89fe3235d9a3c2465fea405157", decimals: 9 },
    ],
  }),

  // ── Additional EUR-pegged ────────────────────────────────────────────
  // EURT removed — discontinued by Tether
  eur("52", "Celo Euro", "CEUR", "algorithmic", "centralized-dependent", {
    geckoId: "celo-euro",
    collateral: "Mento reserve containing USDC, DAI, USDT, plus BTC, ETH, and CELO (110%+ ratio)",
    pegMechanism: "Constant-product market maker arbitrage against reserve assets including centralized stablecoins",
    jurisdiction: { country: "Germany" },
    contracts: [
      { chain: "celo", address: "0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73", decimals: 18 },
    ],
  }),
  // PAR (id 56) removed — abandoned by Mimo Protocol, pivoted to KUMA (see cemetery)
  // IBEUR removed — liquidity drain Dec 2023 (see cemetery)
  eur("98", "EUROe", "EUROe", "rwa-backed", "centralized", {
    geckoId: "euroe-stablecoin",
    collateral: "Euro-denominated reserves held in regulated European institutions",
    pegMechanism: "Direct 1:1 redemption through Membrane Finance (now Paxos-backed)",
    proofOfReserves: { type: "independent-audit", url: "https://www.euroe.com/transparency-and-regulation", provider: "KPMG" },
    links: [
      { label: "Website", url: "https://www.euroe.com/" },
    ],
    jurisdiction: { country: "Finland", regulator: "FIN-FSA", license: "EMI" },
    contracts: [
      { chain: "ethereum", address: "0x820802fa8a99901f52e39acd21177b0be6ee2974", decimals: 6 },
    ],
  }),
  eur("158", "VNX EURO", "VEUR", "rwa-backed", "centralized", {
    geckoId: "vnx-euro",
    collateral: "Euro-denominated reserves",
    pegMechanism: "Direct 1:1 redemption through VNX",
    proofOfReserves: { type: "independent-audit", url: "https://vnx.li/transparency/" },
    links: [
      { label: "Website", url: "https://vnx.li/veur/" },
      { label: "Twitter", url: "https://x.com/VNX_Platform" },
    ],
    jurisdiction: { country: "Liechtenstein", regulator: "FMA", license: "Blockchain Act" },
    contracts: [
      { chain: "ethereum", address: "0x6ba75d640bebfe5da1197bb5a2aff3327789b5d3", decimals: 18 },
    ],
  }),
  eur("239", "StablR Euro", "EURR", "rwa-backed", "centralized", {
    geckoId: "stablr-euro",
    collateral: "Euro-denominated reserves",
    pegMechanism: "Direct 1:1 redemption through StablR",
    proofOfReserves: { type: "real-time", url: "https://www.stablr.com/proof-of-reserve", provider: "The Network Firm" },
    links: [
      { label: "Website", url: "https://www.stablr.com/eurr" },
      { label: "Twitter", url: "https://x.com/StablREuro" },
    ],
    jurisdiction: { country: "Malta", regulator: "MFSA", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x50753cfaf86c094925bf976f218d043f8791e408", decimals: 6 },
    ],
  }),
  eur("247", "Schuman EUROP", "EUROP", "rwa-backed", "centralized", {
    geckoId: "schuman-europ",
    collateral: "Euro-denominated reserves under French regulatory oversight",
    pegMechanism: "Direct 1:1 redemption through Schuman Financial",
    proofOfReserves: { type: "independent-audit", url: "https://schuman.io/reserve-audits/", provider: "KPMG" },
    links: [
      { label: "Website", url: "https://schuman.io/europ/" },
      { label: "Twitter", url: "https://x.com/Schuman_io" },
    ],
    jurisdiction: { country: "France", regulator: "ACPR", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51", decimals: 6 },
    ],
  }),
  eur("cg-eurq", "Quantoz EURQ", "EURQ", "rwa-backed", "centralized", {
    geckoId: "quantoz-eurq",
    collateral: "Euro-denominated reserves in bank accounts and liquid euro bonds (102% reserve ratio)",
    pegMechanism: "Direct 1:1 redemption through Quantoz Payments",
    links: [
      { label: "Website", url: "https://www.quantoz.com/products/eurq-usdq" },
    ],
    jurisdiction: { country: "Netherlands", regulator: "DNB", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x8df723295214ea6f21026eeeb4382d475f146f9f", decimals: 6 },
    ],
  }),
  eur("319", "AllUnity EUR", "EURAU", "rwa-backed", "centralized", {
    geckoId: "allunity-eur",
    collateral: "Euro-denominated reserves",
    pegMechanism: "Direct 1:1 redemption through AllUnity",
    links: [
      { label: "Website", url: "https://allunity.com/eurau/" },
      { label: "Twitter", url: "https://x.com/AllUnityStable" },
    ],
    jurisdiction: { country: "Germany", regulator: "BaFin", license: "EMI (MiCA)" },
    contracts: [
      { chain: "ethereum", address: "0x4933a85b5b5466fbaf179f72d3de273c287ec2c2", decimals: 6 },
    ],
  }),
  eur("cg-deuro", "Decentralized Euro", "DEURO", "crypto-backed", "decentralized", {
    geckoId: "decentralized-euro",
    collateral: "BTC, ETH, and other crypto assets in oracle-free overcollateralized positions",
    pegMechanism: "Overcollateralized CDP with automated liquidation; no oracle dependency (same architecture as Frankencoin ZCHF)",
    links: [
      { label: "Website", url: "https://www.deuro.com/" },
      { label: "Twitter", url: "https://x.com/dEURO_com" },
      { label: "Docs", url: "https://docs.deuro.com/" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea", decimals: 18 },
    ],
  }),

  // ── Additional CHF-pegged ────────────────────────────────────────────
  other("157", "VNX Swiss Franc", "VCHF", "rwa-backed", "centralized", "CHF", {
    geckoId: "vnx-swiss-franc",
    collateral: "CHF-denominated reserves",
    pegMechanism: "Direct 1:1 redemption through VNX",
    proofOfReserves: { type: "independent-audit", url: "https://vnx.li/transparency/" },
    links: [
      { label: "Website", url: "https://vnx.li/vchf/" },
      { label: "Twitter", url: "https://x.com/VNX_Platform" },
    ],
    jurisdiction: { country: "Liechtenstein", regulator: "FMA", license: "Blockchain Act" },
    contracts: [
      { chain: "ethereum", address: "0x79d4f0232a66c4c91b89c76362016a1707cfbf4f", decimals: 18 },
    ],
  }),

  // ── GBP-pegged ───────────────────────────────────────────────────────
  other("292", "VNX British Pound", "VGBP", "rwa-backed", "centralized", "GBP", {
    geckoId: "vnx-british-pound",
    collateral: "GBP-denominated reserves",
    pegMechanism: "Direct 1:1 redemption through VNX",
    proofOfReserves: { type: "independent-audit", url: "https://vnx.li/transparency/" },
    links: [
      { label: "Website", url: "https://vnx.li/vgbp/" },
      { label: "Twitter", url: "https://x.com/VNX_Platform" },
    ],
    jurisdiction: { country: "Liechtenstein", regulator: "FMA", license: "Blockchain Act" },
    contracts: [
      { chain: "ethereum", address: "0x34c9c643becd939c950bb9f141e35777559817cb", decimals: 18 },
    ],
  }),
  other("317", "Tokenised GBP", "tGBP", "rwa-backed", "centralized", "GBP", {
    geckoId: "tokenised-gbp",
    collateral: "GBP-denominated reserves",
    pegMechanism: "Direct 1:1 redemption through issuer",
    links: [
      { label: "Website", url: "https://www.tokenisedgbp.com/" },
    ],
    jurisdiction: { country: "United Kingdom", regulator: "FCA" },
    contracts: [
      { chain: "ethereum", address: "0x00000000441378008ea67f4284a57932b1c000a5", decimals: 18 },
    ],
  }),

  // ── Additional non-USD/non-EUR pegs ──────────────────────────────────
  other("cg-zarp", "ZARP Stablecoin", "ZARP", "rwa-backed", "centralized", "ZAR", {
    geckoId: "zarp-stablecoin",
    collateral: "South African rand reserves (treasury managed by Old Mutual Wealth)",
    pegMechanism: "Direct 1:1 redemption for ZAR through ZARP",
    links: [
      { label: "Website", url: "https://zarp.co.za/" },
    ],
    jurisdiction: { country: "South Africa" },
    contracts: [
      { chain: "ethereum", address: "0xb755506531786c8ac63b756bab1ac387bacb0c04", decimals: 18 },
    ],
  }),
  other("186", "International Stable Currency", "ISC", "rwa-backed", "centralized-dependent", "VAR", {
    geckoId: "international-stable-currency",
    navToken: true,
    collateral: "Basket of real-world assets (gold, bonds, T-bills, equity, cash)",
    pegMechanism: "RWA-indexed basket tracking purchasing power; price appreciates over time",
    links: [
      { label: "Website", url: "https://www.isc.money/" },
    ],
  }), // no EVM contract — Solana-only

  // ── CAD / CNY / PHP / MXN / UAH / ARS pegs ───────────────────────────
  other("145", "CAD Coin", "CADC", "rwa-backed", "centralized", "CAD", {
    geckoId: "cad-coin",
    collateral: "Canadian dollar reserves held 1:1 in a regulated Canadian bank account",
    pegMechanism: "Direct 1:1 redemption for CAD through PayTrie (FINTRAC-registered MSB)",
    links: [
      { label: "Website", url: "https://paytrie.com/cadc" },
    ],
    jurisdiction: { country: "Canada", regulator: "FINTRAC" },
  }),
  other("299", "PHT Stablecoin", "PHT", "crypto-backed", "centralized-dependent", "PHP", {
    geckoId: "pht-stablecoin",
    collateral: "Overcollateralized USDC/USDT vaults (MakerDAO MCD fork)",
    pegMechanism: "Overcollateralized crypto-backed PHP stablecoin for remittances and on-chain payments",
    links: [
      { label: "Website", url: "https://www.apacx.io/PHT" },
    ],
  }),
];

// --- Pre-computed lookups (static data, computed once at module level) ---

/** Map of stablecoin ID → metadata. Use instead of constructing in components. */
export const TRACKED_META_BY_ID = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));

/** Set of all tracked stablecoin IDs. */
export const TRACKED_IDS = new Set(TRACKED_STABLECOINS.map((s) => s.id));

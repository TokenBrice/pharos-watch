import type { StablecoinMeta } from "./types";

// Helper to reduce boilerplate
interface StablecoinOpts {
  yieldBearing?: boolean;
  rwa?: boolean;
  navToken?: boolean;
  collateral?: string;
  pegMechanism?: string;
  goldOunces?: number;
  proofOfReserves?: import("./types").ProofOfReserves;
  links?: import("./types").StablecoinLink[];
  jurisdiction?: import("./types").Jurisdiction;
}

function usd(id: string, name: string, symbol: string, backing: StablecoinMeta["flags"]["backing"], governance: StablecoinMeta["flags"]["governance"], opts?: StablecoinOpts): StablecoinMeta {
  return { id, name, symbol, flags: { backing, pegCurrency: "USD", governance, yieldBearing: opts?.yieldBearing ?? false, rwa: opts?.rwa ?? false, navToken: opts?.navToken ?? false }, collateral: opts?.collateral, pegMechanism: opts?.pegMechanism, proofOfReserves: opts?.proofOfReserves, links: opts?.links, jurisdiction: opts?.jurisdiction };
}
function eur(id: string, name: string, symbol: string, backing: StablecoinMeta["flags"]["backing"], governance: StablecoinMeta["flags"]["governance"], opts?: StablecoinOpts): StablecoinMeta {
  return { id, name, symbol, flags: { backing, pegCurrency: "EUR", governance, yieldBearing: opts?.yieldBearing ?? false, rwa: opts?.rwa ?? false, navToken: opts?.navToken ?? false }, collateral: opts?.collateral, pegMechanism: opts?.pegMechanism, proofOfReserves: opts?.proofOfReserves, links: opts?.links, jurisdiction: opts?.jurisdiction };
}
function other(id: string, name: string, symbol: string, backing: StablecoinMeta["flags"]["backing"], governance: StablecoinMeta["flags"]["governance"], pegCurrency: StablecoinMeta["flags"]["pegCurrency"], opts?: StablecoinOpts): StablecoinMeta {
  return { id, name, symbol, flags: { backing, pegCurrency, governance, yieldBearing: opts?.yieldBearing ?? false, rwa: opts?.rwa ?? false, navToken: opts?.navToken ?? false }, collateral: opts?.collateral, pegMechanism: opts?.pegMechanism, goldOunces: opts?.goldOunces, proofOfReserves: opts?.proofOfReserves, links: opts?.links, jurisdiction: opts?.jurisdiction };
}

/**
 * Tracked stablecoins by market cap (DefiLlama + CoinGecko).
 * IDs are DefiLlama numeric IDs (string).
 *
 * Classification flags:
 *   backing:      rwa-backed | crypto-backed | algorithmic
 *   pegCurrency:  USD | EUR | GBP | CHF | BRL | RUB | JPY | IDR | SGD | TRY | AUD | GOLD | VAR | OTHER
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
  }),
  usd("209", "Sky Dollar", "USDS", "crypto-backed", "centralized-dependent", {
    collateral: "Mix of crypto (ETH), RWA (U.S. Treasuries), and centralized stablecoins (USDC) via Sky vaults",
    pegMechanism: "Peg Stability Modules enabling 1:1 swaps with USDC and DAI",
    links: [
      { label: "Website", url: "https://sky.money/" },
      { label: "Twitter", url: "https://x.com/SkyEcosystem" },
    ],
    jurisdiction: { country: "Denmark" },
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
  }),
  usd("173", "BlackRock USD", "BUIDL", "rwa-backed", "centralized", {
    yieldBearing: true, rwa: true,
    collateral: "Tokenized U.S. Treasury securities managed by BlackRock",
    pegMechanism: "NAV-based pricing with institutional redemption through BlackRock/Securitize",
    links: [
      { label: "Website", url: "https://securitize.io/blackrock/buidl" },
    ],
    jurisdiction: { country: "British Virgin Islands", regulator: "SEC (Reg D)", license: "Regulation D Exemption" },
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
  }),
  usd("336", "United Stables", "U", "rwa-backed", "centralized", {
    collateral: "Cash, USDC, USDT, and USD1 held in segregated custodial accounts (BVI entity)",
    pegMechanism: "Direct 1:1 redemption for reserve assets through United Stables",
    links: [
      { label: "Website", url: "https://u.tech/" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
  }),
  usd("309", "USD.AI", "USDai", "rwa-backed", "centralized-dependent", {
    collateral: "U.S. Treasuries via M0 platform; minted by depositing USDC or USDT",
    pegMechanism: "1:1 mint/redeem against USDC/USDT with underlying T-bill backing via M0",
    links: [
      { label: "Website", url: "https://usd.ai/" },
      { label: "Twitter", url: "https://x.com/USDai_Official" },
      { label: "Docs", url: "https://docs.usd.ai" },
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
  }),

  // ── Rank 21-30 ───────────────────────────────────────────────────────
  other("258", "A7A5", "A7A5", "rwa-backed", "centralized", "RUB", {
    collateral: "Russian ruble-denominated reserves",
    pegMechanism: "Direct redemption for RUB through issuer",
    links: [
      { label: "Website", url: "https://www.a7a5.io/" },
    ],
    jurisdiction: { country: "Kyrgyzstan" },
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
  }),
  usd("296", "Cap cUSD", "CUSD", "rwa-backed", "centralized-dependent", {
    collateral: "Basket of regulated stablecoins: USDC, USDT, pyUSD, BUIDL, and BENJI (max 40% each)",
    pegMechanism: "Peg Stability Module enabling 1:1 minting/redemption against underlying stablecoin basket",
    links: [
      { label: "Website", url: "https://www.cap.app/" },
      { label: "Twitter", url: "https://x.com/capmoney_" },
      { label: "Docs", url: "https://docs.cap.app/" },
    ],
  }),
  // USDN (id 12) removed — algorithmic death spiral Apr 2022 (see cemetery)
  eur("50", "EURC", "EURC", "rwa-backed", "centralized", {
    collateral: "Euro-denominated reserves held in regulated financial institutions",
    pegMechanism: "Direct 1:1 redemption through Circle",
    proofOfReserves: { type: "independent-audit", url: "https://www.circle.com/transparency", provider: "Deloitte" },
    links: [
      { label: "Website", url: "https://www.circle.com/eurc" },
      { label: "Twitter", url: "https://x.com/circle" },
    ],
    jurisdiction: { country: "France", regulator: "ACPR", license: "EMI (MiCA)" },
  }),
  usd("197", "Resolv USD", "USR", "crypto-backed", "centralized-dependent", {
    collateral: "ETH, stETH, and BTC hedged with short perpetual futures",
    pegMechanism: "Delta-neutral hedging on centralized exchanges (Binance, Hyperliquid, Deribit) via Fireblocks/Ceffu",
    proofOfReserves: { type: "self-reported", url: "https://info.apostro.xyz/resolv-reserves", provider: "Apostro" },
    links: [
      { label: "Website", url: "https://resolv.xyz/" },
      { label: "Twitter", url: "https://x.com/ResolvLabs" },
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
  }),
  usd("310", "Solstice USX", "USX", "crypto-backed", "centralized-dependent", {
    collateral: "Delta-neutral positions in BTC, ETH, SOL plus USDC/USDT and tokenized treasuries",
    pegMechanism: "Delta-neutral hedging on centralized exchanges via Ceffu custody with Chainlink Proof of Reserve",
    links: [
      { label: "Website", url: "https://solstice.finance/usx" },
      { label: "Twitter", url: "https://x.com/solsticefi" },
    ],
    jurisdiction: { country: "Switzerland" },
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
  }),
  usd("15", "Dola", "DOLA", "crypto-backed", "centralized-dependent", {
    collateral: "Various crypto assets in Inverse Finance lending markets, including USDC",
    pegMechanism: "Fed contracts manage supply via lending markets; relies on USDC for stability mechanisms",
    links: [
      { label: "Website", url: "https://www.inverse.finance/" },
      { label: "Twitter", url: "https://x.com/InverseFinance" },
      { label: "Docs", url: "https://docs.inverse.finance/" },
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
  }),
  usd("298", "infiniFi USD", "IUSD", "crypto-backed", "centralized-dependent", {
    collateral: "USDC deposits allocated across Aave, Pendle, and Ethena yield strategies",
    pegMechanism: "1:1 mint/redeem against USDC; fractional reserve model with yield optimization",
    links: [
      { label: "Website", url: "https://infinifi.xyz/" },
      { label: "Twitter", url: "https://x.com/infiniFi" },
    ],
    jurisdiction: { country: "United States" },
  }),
  usd("219", "Astherus", "USDF", "crypto-backed", "centralized-dependent", {
    collateral: "USDT deposits deployed in delta-neutral strategies exclusively on Binance",
    pegMechanism: "1:1 USDT convertibility; yield from delta-neutral trading on Binance",
    links: [
      { label: "Website", url: "https://www.asterdex.com/en/usdf" },
      { label: "Twitter", url: "https://x.com/Aster_DEX" },
      { label: "Docs", url: "https://docs.asterdex.com/" },
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
    collateral: "Brazilian real-denominated reserves",
    pegMechanism: "Direct redemption for BRL through Transfero",
    links: [
      { label: "Website", url: "https://transfero.com/stablecoins/brz/" },
      { label: "Twitter", url: "https://x.com/BrzToken" },
    ],
    jurisdiction: { country: "Brazil", regulator: "Central Bank of Brazil" },
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
  }),
  usd("340", "rwaUSDi", "rwaUSDi", "crypto-backed", "centralized-dependent", {
    rwa: true,
    collateral: "Tokenized real-world assets (treasuries and fixed-income instruments)",
    pegMechanism: "NAV-based pricing with centralized RWA custodian backing",
    links: [
      { label: "Website", url: "https://afiprotocol.xyz/" },
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
  }),
  usd("341", "Pleasing USD", "PUSD", "rwa-backed", "centralized-dependent", {
    collateral: "USDT reserves and tokenized gold (PGOLD) exposure",
    pegMechanism: "1:1 redeemability into USDT",
    links: [
      { label: "Twitter", url: "https://x.com/PleasingGolden" },
    ],
  }),
  usd("339", "Re Protocol reUSD", "reUSD", "crypto-backed", "centralized-dependent", {
    collateral: "Crypto assets deposited in vaults managed via crvUSD and Curve ecosystem",
    pegMechanism: "Depends on crvUSD peg stability which itself relies on centralized stablecoin peg keepers",
    links: [
      { label: "Website", url: "https://re.xyz/" },
      { label: "Docs", url: "https://docs.re.xyz" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
  }),
  usd("332", "pmUSD", "pmUSD", "rwa-backed", "centralized-dependent", {
    collateral: "Tokenized precious metals (gold) via RAAC protocol with Chainlink proof-of-reserves",
    pegMechanism: "Overcollateralized CDP backed by tokenized gold held by centralized custodian (I-ON Digital)",
    links: [
      { label: "Website", url: "https://pmusd.raac.io/" },
      { label: "Twitter", url: "https://x.com/Raacfi" },
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
  }),
  usd("316", "CASH", "CASH", "rwa-backed", "centralized", {
    collateral: "Cash and cash equivalents",
    pegMechanism: "Direct 1:1 redemption through issuer",
    links: [
      { label: "Website", url: "https://stabl.fi/" },
      { label: "Twitter", url: "https://x.com/Stabl_Fi" },
    ],
    jurisdiction: { country: "United States" },
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
  }),
  other("66", "Frax Price Index", "FPI", "algorithmic", "centralized-dependent", "VAR", {
    navToken: true,
    collateral: "FRAX and algorithmic mechanisms via Frax Finance",
    pegMechanism: "Algorithmic adjustment tied to CPI; depends on FRAX which depends on USDC",
    links: [
      { label: "Website", url: "https://frax.com/" },
      { label: "Twitter", url: "https://x.com/fraxfinance" },
    ],
    jurisdiction: { country: "United States" },
  }),
  usd("283", "Unitas", "USDU", "crypto-backed", "centralized-dependent", {
    collateral: "USDC deposits routed into Jupiter LP tokens (JLP) and hedged via CEX perpetual shorts",
    pegMechanism: "Delta-neutral hedging on Binance via Ceffu/Copper custody; USDC mint/redeem",
    links: [
      { label: "Website", url: "https://unitas.so/" },
      { label: "Twitter", url: "https://x.com/UnitasLabs" },
      { label: "Docs", url: "https://docs.unitas.so/" },
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
  }),
  usd("166", "Cygnus Finance Global USD", "cgUSD", "rwa-backed", "centralized", {
    collateral: "U.S. dollar reserves via Cygnus Finance",
    pegMechanism: "Direct 1:1 redemption through Cygnus",
    links: [
      { label: "Website", url: "https://www.cygnus.finance/" },
      { label: "Twitter", url: "https://x.com/CygnusFi" },
    ],
  }),

  // ── Rank 61-70 ───────────────────────────────────────────────────────
  eur("254", "EUR CoinVertible", "EURCV", "rwa-backed", "centralized", {
    collateral: "Euro-denominated bank deposits at Societe Generale",
    pegMechanism: "Direct 1:1 redemption through SG-FORGE",
    proofOfReserves: { type: "self-reported", url: "https://www.sgforge.com/product/coinvertible/", provider: "SG-FORGE" },
    links: [
      { label: "Website", url: "https://www.sgforge.com/product/coinvertible/" },
      { label: "Twitter", url: "https://x.com/sgforge" },
    ],
    jurisdiction: { country: "France", regulator: "ACPR", license: "EMI (MiCA)" },
  }),
  // USP (id 97) removed — Platypus exploited in 2023, protocol defunct (see cemetery)
  eur("147", "Anchored Coins AEUR", "AEUR", "rwa-backed", "centralized", {
    collateral: "Euro-denominated reserves held in Swiss bank accounts",
    pegMechanism: "Direct 1:1 redemption through Anchored Coins",
    links: [
      { label: "Website", url: "https://www.anchoredcoins.com/en/landing/aeur" },
      { label: "Twitter", url: "https://x.com/AnchoredCoins" },
    ],
    jurisdiction: { country: "Switzerland", regulator: "FINMA (VQF)", license: "SRO Member" },
  }),
  // BUSD (id 4) removed — regulatory shutdown Feb 2023 (see cemetery)
  usd("275", "Quantoz USDQ", "USDQ", "rwa-backed", "centralized", {
    collateral: "Euro/USD reserves held in regulated accounts",
    pegMechanism: "Direct 1:1 redemption through Quantoz",
    links: [
      { label: "Website", url: "https://www.quantoz.com/products/eurq-usdq" },
    ],
    jurisdiction: { country: "Netherlands", regulator: "DNB", license: "EMI (MiCA)" },
  }),
  usd("256", "Resupply USD", "REUSD", "crypto-backed", "centralized-dependent", {
    collateral: "crvUSD lending positions and Curve LP tokens",
    pegMechanism: "Depends on crvUSD ecosystem which relies on centralized stablecoin peg keepers",
    links: [
      { label: "Website", url: "https://resupply.fi/" },
      { label: "Twitter", url: "https://x.com/ResupplyFi" },
      { label: "Docs", url: "https://docs.resupply.fi/" },
    ],
  }),
  eur("325", "Eurite", "EURI", "rwa-backed", "centralized", {
    collateral: "Euro-denominated reserves",
    pegMechanism: "Direct 1:1 redemption through Eurite (Binance)",
    proofOfReserves: { type: "independent-audit", url: "https://www.eurite.com/" },
    links: [
      { label: "Website", url: "https://www.eurite.com/" },
    ],
    jurisdiction: { country: "Luxembourg", regulator: "CSSF", license: "Credit Institution (MiCA)" },
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
  }),
  usd("263", "Hex Trust USDX", "USDX", "rwa-backed", "centralized", {
    collateral: "U.S. dollar reserves",
    pegMechanism: "Direct 1:1 redemption through Hex Trust",
    links: [
      { label: "Website", url: "https://www.htdigitalassets.com/" },
      { label: "Twitter", url: "https://x.com/Hex_Trust" },
    ],
    jurisdiction: { country: "Hong Kong", license: "TCSP License" },
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
  }),
  usd("313", "Metamask USD", "MUSD", "rwa-backed", "centralized", {
    collateral: "U.S. Treasury bills in bankruptcy-remote accounts via Bridge (Stripe) and Blackstone",
    pegMechanism: "Direct fiat on/off-ramp redemption through Bridge/Stripe",
    links: [
      { label: "Website", url: "https://metamask.io/news/introducing-metamask-usd-your-dollar-your-wallet" },
    ],
    jurisdiction: { country: "United States" },
  }),
  usd("255", "Aegis YUSD", "YUSD", "rwa-backed", "centralized", {
    collateral: "U.S. dollar reserves",
    pegMechanism: "Direct 1:1 redemption through Aegis",
    proofOfReserves: { type: "real-time", url: "https://aegis.accountable.capital/", provider: "Accountable" },
    links: [
      { label: "Website", url: "https://aegis.im/" },
      { label: "Twitter", url: "https://x.com/aegis_im" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
  }),
  usd("22", "sUSD", "SUSD", "crypto-backed", "centralized-dependent", {
    collateral: "SNX, ETH, and USDC/stataUSDC via Synthetix V3; V2 was SNX-only",
    pegMechanism: "Overcollateralization via C-ratio (200%+); V3 added USDC as core collateral on Base",
    links: [
      { label: "Website", url: "https://www.synthetix.io/" },
      { label: "Twitter", url: "https://x.com/synthetix_io" },
    ],
    jurisdiction: { country: "Australia" },
  }),
  usd("269", "Liquity BOLD", "BOLD", "crypto-backed", "decentralized", {
    collateral: "ETH and ETH liquid staking tokens (wstETH, rETH) only",
    pegMechanism: "Overcollateralized CDPs with on-chain redemption for $1 of ETH collateral",
    links: [
      { label: "Website", url: "https://www.liquity.org/bold" },
      { label: "Twitter", url: "https://x.com/LiquityProtocol" },
      { label: "Docs", url: "https://docs.liquity.org/" },
    ],
  }),
  usd("302", "Hylo HYUSD", "HYUSD", "crypto-backed", "centralized-dependent", {
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
  }),
  usd("168", "fxUSD", "fxUSD", "crypto-backed", "centralized-dependent", {
    collateral: "wstETH and WBTC split into stable (fxUSD) and leveraged components",
    pegMechanism: "Stability Pool uses USDC to buy fxUSD below peg and sell above; ETH collateral redemption",
    links: [
      { label: "Website", url: "https://fx.aladdin.club" },
      { label: "Twitter", url: "https://x.com/protocol_fx" },
    ],
  }),
  usd("67", "Bean", "BEAN", "algorithmic", "decentralized", {
    collateral: "None; purely credit-based algorithmic stablecoin using debt instruments (Pods)",
    pegMechanism: "Credit-based system with adjustable interest rates (Temperature); BEAN:ETH and BEAN:3CRV pools",
    links: [
      { label: "Website", url: "https://bean.money/" },
      { label: "Twitter", url: "https://x.com/beanstalkfarms" },
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
    collateral: "WBTC and ETH in oracle-free overcollateralized positions (~230%)",
    pegMechanism: "Auction-based collateral valuation with veto governance; no price oracle dependency",
    links: [
      { label: "Website", url: "https://www.frankencoin.com/" },
      { label: "Twitter", url: "https://x.com/frankencoinzchf" },
      { label: "Docs", url: "https://docs.frankencoin.com/" },
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
    collateral: "Euro-denominated bank deposits in licensed European institutions",
    pegMechanism: "Direct 1:1 redemption through Monerium",
    links: [
      { label: "Website", url: "https://monerium.com/" },
      { label: "Twitter", url: "https://x.com/monerium" },
    ],
    jurisdiction: { country: "Iceland", regulator: "Central Bank of Iceland", license: "EMI (MiCA)" },
  }),
  usd("230", "Noon USN", "USN", "crypto-backed", "centralized-dependent", {
    collateral: "USDC/USDT deposits and short-term U.S. Treasury bills via custodians (Ceffu, Alpaca)",
    pegMechanism: "1:1 mint/redeem against USDC/USDT; delta-neutral yield strategies on centralized exchanges",
  }),
  usd("185", "Gyroscope GYD", "GYD", "crypto-backed", "centralized-dependent", {
    collateral: "Diversified reserve of sDAI, USDC, LUSD, and crvUSD in yield-generating vaults",
    pegMechanism: "Primary-market AMM (PAMM) adjusts redemption prices based on reserve ratio",
    links: [
      { label: "Website", url: "https://www.gyro.finance/" },
      { label: "Twitter", url: "https://x.com/GyroStable" },
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
    collateral: "Crypto assets and over-collateralized positions via Angle Protocol",
    pegMechanism: "Hedging agents and standard LPs maintain EUR peg; depends on USDC/DAI liquidity",
    links: [
      { label: "Website", url: "https://www.angle.money/eura" },
      { label: "Twitter", url: "https://x.com/AngleProtocol" },
      { label: "Docs", url: "https://docs.angle.money/" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
  }),
  usd("303", "Mezo USD", "meUSD", "crypto-backed", "centralized-dependent", {
    collateral: "Bitcoin only; minimum 110% collateral ratio",
    pegMechanism: "BTC-only overcollateralized CDP with direct $1 BTC redemption; operates on Mezo (Bitcoin L2, not Ethereum or a Stage 1 L2)",
    links: [
      { label: "Website", url: "https://mezo.org/" },
      { label: "Twitter", url: "https://x.com/MezoNetwork" },
      { label: "Docs", url: "https://mezo.org/docs/users/musd" },
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
  }),
  eur("51", "Stasis Euro", "EURS", "rwa-backed", "centralized", {
    collateral: "Euro-denominated reserves verified by independent auditors",
    pegMechanism: "Direct 1:1 redemption through Stasis",
    proofOfReserves: { type: "independent-audit", url: "https://stasis.net/transparency", provider: "BDO Malta" },
    links: [
      { label: "Website", url: "https://stasis.net/" },
      { label: "Twitter", url: "https://x.com/stasisnet" },
    ],
    jurisdiction: { country: "Malta", regulator: "MFSA", license: "MiCA" },
  }),
  // USD+ (id 46) removed — protocol abandoned 2025 (see cemetery)
  usd("63", "Fantom USD", "FUSD", "crypto-backed", "centralized-dependent", {
    collateral: "Staked FTM tokens only; 300-500% overcollateralization ratio",
    pegMechanism: "Overcollateralized CDP with FTM-only collateral and liquidation auctions; operates on Fantom/Sonic (not Ethereum or a Stage 1 L2)",
  }),
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
    rwa: true,
    collateral: "USDtb (BlackRock BUIDL tokenized Treasuries via Ethena/Securitize) with liquid stablecoins for redemptions",
    pegMechanism: "Issued on Ethena's USDtb rails; reserve yield funds MegaETH sequencer costs",
    links: [
      { label: "Website", url: "https://www.megaeth.com/" },
      { label: "Twitter", url: "https://x.com/megaeth" },
    ],
  }),
  usd("268", "YU", "YU", "crypto-backed", "centralized-dependent", {
    collateral: "Overcollateralized by BTC (wrapped as YBTC) with minimum 200% collateral ratio",
    pegMechanism: "CDP-style overcollateralized minting with liquidations; PSM enables swaps with USDC for peg arbitrage",
    links: [
      { label: "Website", url: "https://yala.org/" },
      { label: "Twitter", url: "https://x.com/yalaorg" },
      { label: "Docs", url: "https://docs.yala.org/" },
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
  }),
  usd("20", "Alchemix USD", "ALUSD", "crypto-backed", "centralized-dependent", {
    collateral: "DAI, USDC, USDT, and their yield-bearing vault tokens (yvDAI, yvUSDC, yvUSDT) via Alchemix CDPs",
    pegMechanism: "Self-repaying loans: yield from deposited stablecoin collateral automatically repays debt; Transmuter guarantees 1:1 redemption",
    links: [
      { label: "Website", url: "https://alchemix.fi/" },
      { label: "Twitter", url: "https://x.com/alchemixfi" },
    ],
    jurisdiction: { country: "Saint Kitts and Nevis" },
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
  }),
  usd("215", "Moneta", "USDM", "rwa-backed", "centralized", {
    collateral: "1:1 USD reserves custodied by Norwegian Block Exchange (NBX)",
    pegMechanism: "Direct 1:1 redemption through Moneta",
    links: [
      { label: "Website", url: "https://moneta.global/" },
    ],
    jurisdiction: { country: "United States", regulator: "FinCEN" },
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

  // ── Additional non-USD pegs ────────────────────────────────────────
  other("289", "StraitsX XSGD", "XSGD", "rwa-backed", "centralized", "SGD", {
    collateral: "Singapore dollar cash reserves held at DBS and Standard Chartered banks",
    pegMechanism: "Direct 1:1 redemption for SGD through StraitsX (MAS-licensed Major Payment Institution)",
    proofOfReserves: { type: "independent-audit", url: "https://www.straitsx.com/xsgd" },
    links: [
      { label: "Website", url: "https://www.straitsx.com/xsgd" },
      { label: "Twitter", url: "https://x.com/straitsx" },
    ],
    jurisdiction: { country: "Singapore", regulator: "MAS", license: "Major Payment Institution" },
  }),
  other("122", "GYEN", "GYEN", "rwa-backed", "centralized", "JPY", {
    collateral: "Japanese yen reserves held at FDIC-insured banks",
    pegMechanism: "Direct 1:1 redemption for JPY through GMO Trust (NYDFS-chartered trust company)",
    proofOfReserves: { type: "independent-audit", url: "https://stablecoin.z.com/attestation/" },
    links: [
      { label: "Website", url: "https://stablecoin.z.com/" },
      { label: "Twitter", url: "https://x.com/GMOTrust" },
    ],
    jurisdiction: { country: "United States", regulator: "NYDFS", license: "Trust Charter" },
  }),
  other("300", "BiLira", "TRYB", "rwa-backed", "centralized", "TRY", {
    collateral: "Turkish lira reserves held in Turkish bank accounts",
    pegMechanism: "Direct 1:1 redemption for TRY through BiLira",
    links: [
      { label: "Website", url: "https://www.bilira.co/en/product/tryb-stablecoin" },
      { label: "Twitter", url: "https://x.com/BiLira_Official" },
    ],
    jurisdiction: { country: "Turkey", regulator: "SPK/CMB" },
  }),
  other("165", "AUDD", "AUDD", "rwa-backed", "centralized", "AUD", {
    collateral: "Australian dollar cash and cash equivalents held at Australian deposit-taking institutions",
    pegMechanism: "Direct 1:1 redemption for AUD through AUDC (Novatti subsidiary)",
    proofOfReserves: { type: "independent-audit", url: "https://www.audd.digital/", provider: "William Buck Audit" },
    links: [
      { label: "Website", url: "https://www.audd.digital/" },
      { label: "Twitter", url: "https://x.com/AUDD_digital" },
    ],
    jurisdiction: { country: "Australia", regulator: "ASIC", license: "AFSL" },
  }),
  other("cg-jpyc", "JPY Coin", "JPYC", "rwa-backed", "centralized", "JPY", {
    collateral: "Japanese yen deposits and Japanese government bonds (100% backed)",
    pegMechanism: "Direct 1:1 redemption for JPY through JPYC Inc. (FSA-registered Fund Transfer Service Provider)",
    links: [
      { label: "Website", url: "https://corporate.jpyc.co.jp/en" },
    ],
    jurisdiction: { country: "Japan", regulator: "FSA" },
  }),
  other("cg-idrt", "Rupiah Token", "IDRT", "rwa-backed", "centralized", "IDR", {
    collateral: "Indonesian rupiah reserves held 1:1 in Indonesian bank accounts",
    pegMechanism: "Direct 1:1 redemption for IDR through PT Rupiah Token Indonesia",
    links: [
      { label: "Website", url: "https://rupiahtoken.com/" },
    ],
    jurisdiction: { country: "Indonesia" },
  }),

  // ── Gold-Pegged (not in DefiLlama stablecoins API — data via DefiLlama coins/protocol APIs) ──
  // goldOunces: troy ounces of gold per token (used for peg deviation normalization)
  other("gold-xaut", "Tether Gold", "XAUT", "rwa-backed", "centralized", "GOLD", {
    rwa: true, goldOunces: 1,
    collateral: "Physical gold bars held in Swiss vaults by Tether",
    pegMechanism: "Direct redemption for physical gold through Tether",
    proofOfReserves: { type: "independent-audit", url: "https://gold.tether.to/reports", provider: "BDO" },
    links: [
      { label: "Website", url: "https://gold.tether.to/" },
      { label: "Twitter", url: "https://x.com/tethergold" },
    ],
    jurisdiction: { country: "British Virgin Islands" },
  }),
  other("gold-paxg", "PAX Gold", "PAXG", "rwa-backed", "centralized", "GOLD", {
    rwa: true, goldOunces: 1,
    collateral: "Physical gold bars held in London Brink's vaults by Paxos (NYDFS-regulated)",
    pegMechanism: "Direct redemption for physical gold through Paxos",
    proofOfReserves: { type: "independent-audit", url: "https://www.paxos.com/paxg-transparency", provider: "KPMG" },
    links: [
      { label: "Website", url: "https://www.paxos.com/pax-gold" },
      { label: "Twitter", url: "https://x.com/paxos" },
    ],
    jurisdiction: { country: "United States", regulator: "NYDFS", license: "Trust Charter" },
  }),
  other("gold-kau", "Kinesis Gold", "KAU", "rwa-backed", "centralized", "GOLD", {
    rwa: true, goldOunces: 1 / 31.1035,
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
    rwa: true, goldOunces: 1,
    collateral: "LBMA-certified 99.99% pure gold bars held in Asian vaults",
    pegMechanism: "Direct redemption for physical gold through Matrixdock (Matrixport)",
    proofOfReserves: { type: "independent-audit", url: "https://www.matrixdock.com/blog/announcements/matrixdock-publishes-its-second-independent-audit-report-on-xaum-gold", provider: "Independent physical audit" },
    links: [
      { label: "Website", url: "https://www.matrixdock.com/xaum" },
      { label: "Twitter", url: "https://x.com/matrixdock" },
    ],
    jurisdiction: { country: "Singapore" },
  }),
  other("gold-vro", "VeraOne", "VRO", "rwa-backed", "centralized", "GOLD", {
    rwa: true, goldOunces: 1 / 31.1035,
    collateral: "Physical gold stored in secure zones in France (1 VRO = 1 gram of gold)",
    pegMechanism: "Direct redemption for physical gold through VeraCash",
    links: [
      { label: "Website", url: "https://music.veraone.net/" },
    ],
    jurisdiction: { country: "France" },
  }),
  other("gold-cgo", "Comtech Gold", "CGO", "rwa-backed", "centralized", "GOLD", {
    rwa: true, goldOunces: 1 / 31.1035,
    collateral: "Physical gold stored with Transguard in UAE (1 CGO = 1 gram of pure gold), Shariah-compliant",
    pegMechanism: "Direct redemption for physical gold through Comtech Gold (DMCC-endorsed)",
    links: [
      { label: "Website", url: "https://www.comtechgold.com/" },
    ],
    jurisdiction: { country: "United Arab Emirates" },
  }),

  // ── Additional EUR-pegged ────────────────────────────────────────────
  // EURT removed — discontinued by Tether
  eur("52", "Celo Euro", "CEUR", "algorithmic", "centralized-dependent", {
    collateral: "Mento reserve containing USDC, DAI, USDT, plus BTC, ETH, and CELO (110%+ ratio)",
    pegMechanism: "Constant-product market maker arbitrage against reserve assets including centralized stablecoins",
    jurisdiction: { country: "Germany" },
  }),
  // PAR (id 56) removed — abandoned by Mimo Protocol, pivoted to KUMA (see cemetery)
  // IBEUR removed — liquidity drain Dec 2023 (see cemetery)
  eur("98", "EUROe", "EUROe", "rwa-backed", "centralized", {
    collateral: "Euro-denominated reserves held in regulated European institutions",
    pegMechanism: "Direct 1:1 redemption through Membrane Finance (now Paxos-backed)",
    proofOfReserves: { type: "independent-audit", url: "https://www.euroe.com/transparency-and-regulation", provider: "KPMG" },
    links: [
      { label: "Website", url: "https://www.euroe.com/" },
    ],
    jurisdiction: { country: "Finland", regulator: "FIN-FSA", license: "EMI" },
  }),
  eur("158", "VNX EURO", "VEUR", "rwa-backed", "centralized", {
    collateral: "Euro-denominated reserves",
    pegMechanism: "Direct 1:1 redemption through VNX",
    proofOfReserves: { type: "independent-audit", url: "https://vnx.li/transparency/" },
    links: [
      { label: "Website", url: "https://vnx.li/veur/" },
      { label: "Twitter", url: "https://x.com/VNX_Platform" },
    ],
    jurisdiction: { country: "Liechtenstein", regulator: "FMA", license: "Blockchain Act" },
  }),
  eur("239", "StablR Euro", "EURR", "rwa-backed", "centralized", {
    collateral: "Euro-denominated reserves",
    pegMechanism: "Direct 1:1 redemption through StablR",
    proofOfReserves: { type: "real-time", url: "https://www.stablr.com/proof-of-reserve", provider: "The Network Firm" },
    links: [
      { label: "Website", url: "https://www.stablr.com/eurr" },
      { label: "Twitter", url: "https://x.com/StablREuro" },
    ],
    jurisdiction: { country: "Malta", regulator: "MFSA", license: "EMI (MiCA)" },
  }),
  eur("247", "Schuman EUROP", "EUROP", "rwa-backed", "centralized", {
    collateral: "Euro-denominated reserves under French regulatory oversight",
    pegMechanism: "Direct 1:1 redemption through Schuman Financial",
    proofOfReserves: { type: "independent-audit", url: "https://schuman.io/reserve-audits/", provider: "KPMG" },
    links: [
      { label: "Website", url: "https://schuman.io/europ/" },
      { label: "Twitter", url: "https://x.com/Schuman_io" },
    ],
    jurisdiction: { country: "France", regulator: "ACPR", license: "EMI (MiCA)" },
  }),
  eur("319", "AllUnity EUR", "EURAU", "rwa-backed", "centralized", {
    collateral: "Euro-denominated reserves",
    pegMechanism: "Direct 1:1 redemption through AllUnity",
    links: [
      { label: "Website", url: "https://allunity.com/eurau/" },
      { label: "Twitter", url: "https://x.com/AllUnityStable" },
    ],
    jurisdiction: { country: "Germany", regulator: "BaFin", license: "EMI (MiCA)" },
  }),

  // ── Additional CHF-pegged ────────────────────────────────────────────
  other("157", "VNX Swiss Franc", "VCHF", "rwa-backed", "centralized", "CHF", {
    collateral: "CHF-denominated reserves",
    pegMechanism: "Direct 1:1 redemption through VNX",
    proofOfReserves: { type: "independent-audit", url: "https://vnx.li/transparency/" },
    links: [
      { label: "Website", url: "https://vnx.li/vchf/" },
      { label: "Twitter", url: "https://x.com/VNX_Platform" },
    ],
    jurisdiction: { country: "Liechtenstein", regulator: "FMA", license: "Blockchain Act" },
  }),

  // ── GBP-pegged ───────────────────────────────────────────────────────
  other("292", "VNX British Pound", "VGBP", "rwa-backed", "centralized", "GBP", {
    collateral: "GBP-denominated reserves",
    pegMechanism: "Direct 1:1 redemption through VNX",
    proofOfReserves: { type: "independent-audit", url: "https://vnx.li/transparency/" },
    links: [
      { label: "Website", url: "https://vnx.li/vgbp/" },
      { label: "Twitter", url: "https://x.com/VNX_Platform" },
    ],
    jurisdiction: { country: "Liechtenstein", regulator: "FMA", license: "Blockchain Act" },
  }),
  other("317", "Tokenised GBP", "tGBP", "rwa-backed", "centralized", "GBP", {
    collateral: "GBP-denominated reserves",
    pegMechanism: "Direct 1:1 redemption through issuer",
    links: [
      { label: "Website", url: "https://www.tokenisedgbp.com/" },
    ],
    jurisdiction: { country: "United Kingdom", regulator: "FCA" },
  }),
];

// --- Pre-computed lookups (static data, computed once at module level) ---

/** Map of stablecoin ID → metadata. Use instead of constructing in components. */
export const TRACKED_META_BY_ID = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));

/** Set of all tracked stablecoin IDs. */
export const TRACKED_IDS = new Set(TRACKED_STABLECOINS.map((s) => s.id));

export function findStablecoinMeta(id: string): StablecoinMeta | undefined {
  return TRACKED_META_BY_ID.get(id);
}

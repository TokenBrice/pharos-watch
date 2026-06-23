import type { YieldRiskConfigProtocol } from "./yield-source-risk-registry";

export interface YieldRiskConfigMetadata {
  rationale: string;
  evidence: string[];
}

export const YIELD_RISK_CONFIG_METADATA = {
  "aave-v3": {
    rationale:
      "Aave V3 is a mature, multi-billion-USD lending venue with repeated independent audits, formal verification, and an active governance + safety-module stake.",
    evidence: [
      "Trail of Bits audit (Aave V3, 2022)",
      "OpenZeppelin audit (Aave V3 core + periphery, 2022)",
      "Certora formal verification of core invariants",
      "Live since V1 in Jan 2020 and V3 since March 2022 across 10+ chains",
      "Multi-billion-USD TVL throughout 2024-2026",
    ],
  },
  "compound-v3": {
    rationale:
      "Compound III (Comet) is an isolated-asset lending market with a multi-year audit history, billions in TVL, and active COMP governance; the Comet codebase narrowed the protocol surface area relative to V2.",
    evidence: [
      "OpenZeppelin audit (Compound III, 2022)",
      "ChainSecurity audit (Compound III, 2022)",
      "Compound V1 in production since 2018; V3 since August 2022",
      "Sustained multi-billion-USD TVL across deployments",
    ],
  },
  sparklend: {
    rationale:
      "SparkLend is an Aave V3 fork operated by the Sky (formerly MakerDAO) ecosystem; it inherits the upstream Aave V3 audit surface, runs significant TVL, and is governed through the Sky framework.",
    evidence: [
      "Aave V3 upstream audits (Trail of Bits, OpenZeppelin, Certora) cover the shared codebase",
      "ChainSecurity audit (SparkLend customizations, 2023)",
      "Live since May 2023 with multi-hundred-million-USD to billion-USD TVL",
      "Operated through Sky / MakerDAO governance and the SubDAO framework",
    ],
  },
  "spark-savings": {
    rationale:
      "Spark Savings wrappers route yield through the Sky/Spark savings stack rather than an external credit venue; the reviewed surface inherits Sky governance, issuer-level rate setting, and Spark operational controls.",
    evidence: [
      "Sky / Maker governance controls the savings-rate policy and Spark Savings wrapper parameters",
      "Spark Savings yield is issuer/governance-set rather than borrower-market or strategy-vault yield",
      "SparkLend and Sky integrations share the mature Spark/Maker operational stack",
    ],
  },
  maple: {
    rationale:
      "Maple is an institutional credit venue whose lender pools depend on delegate underwriting, borrower performance, and loan recovery mechanics; that credit-underwriting surface is materially broader than low-risk money-market venues.",
    evidence: [
      "Maple pools expose lenders to borrower and pool-delegate credit underwriting risk",
      "The protocol has a post-2022 recovery and redesign history after credit-market defaults",
      "Stablecoin yield can vary by pool mandate, borrower concentration, and withdrawal queue conditions",
    ],
  },
  yearn: {
    rationale:
      "Yearn is a mature strategy-vault venue with long production history and repeated audits; vault strategy risk remains, but the reviewed stablecoin vault surface is operationally established.",
    evidence: [
      "Yearn vaults have operated across multiple market cycles since 2020",
      "Yearn strategy and vault code has repeated independent audit coverage",
      "Stablecoin vault yields are strategy-vault yields with visible vault-level accounting",
    ],
  },
  "yearn-finance": {
    rationale:
      "Yearn Finance maps to the same mature strategy-vault family as Yearn; stablecoin vault risk is reviewed as low after accounting for its production history, audit cadence, and vault-level accounting.",
    evidence: [
      "Yearn Finance is the DeFiLlama project slug for the Yearn vault family",
      "Yearn vaults have operated across multiple market cycles since 2020",
      "Stablecoin vault yields are strategy-vault yields with visible vault-level accounting",
    ],
  },
  morpho: {
    rationale:
      "Morpho sources are reviewed as medium to align with Morpho Blue where vault and market parameters shift risk to market creators and allocators despite the audited lending primitive.",
    evidence: [
      "Morpho Blue is the canonical reviewed medium-risk Morpho lending primitive",
      "Morpho vault and market exposure depends on market-creator parameters and allocator controls",
      "Immutable or semi-immutable market design can limit emergency remediation paths",
    ],
  },
  "morpho-v1": {
    rationale:
      "Morpho v1 belongs to the reviewed Morpho lending venue family and inherits allocator, market-parameter, and integration risk that is broader than mature canonical money markets.",
    evidence: [
      "Morpho v1 and Morpho Blue share the same venue family for Pharos source-risk attribution",
      "Morpho exposure depends on market-level and allocator-level controls",
      "Morpho Blue is already reviewed as medium because the venue is younger than Aave/Compound and has limited remediation paths",
    ],
  },
  "morpho-blue": {
    rationale:
      "Morpho Blue is an immutable singleton lending primitive launched in January 2024 with multiple audits; design choices reduce ongoing governance surface but limit remediation, and the product is still in its younger TVL cohort versus Aave/Compound.",
    evidence: [
      "Spearbit / Cantina audit (Morpho Blue, late 2023)",
      "OpenZeppelin audit (Morpho Blue, late 2023)",
      "Runtime Verification formal review (Morpho Blue, 2024)",
      "Live since January 2024; growing TVL but younger than Aave/Compound cohort",
      "Immutable singleton; market-creator-permissioned vaults inherit issuer risk",
    ],
  },
  pendle: {
    rationale:
      "Pendle is a mature yield-tokenization venue with isolated markets and a long audit trail; reviewed stablecoin principal/yield markets are low venue risk when market and maturity data remain observable.",
    evidence: [
      "Pendle has operated yield-tokenization markets across multiple market cycles",
      "Pendle markets isolate principal/yield-token exposure by asset and maturity",
      "Pendle deployments have repeated independent audit coverage",
    ],
  },
  beefy: {
    rationale:
      "Beefy is a multi-chain strategy-vault aggregator; reviewed yield rows inherit additional strategy, chain, bridge, and integration risk beyond canonical lending venues.",
    evidence: [
      "Beefy vaults aggregate external strategies rather than originating a single canonical money market",
      "Multi-chain vault deployment increases bridge, chain, and integration exposure",
      "Strategy-specific vault accounting and harvest mechanics can vary materially by source",
    ],
  },
  clearpool: {
    rationale:
      "Clearpool is uncollateralized institutional credit; a sub-4-signer multisig with no timelock and direct lender default exposure place it in the high venue-risk tier.",
    evidence: [
      "Hacken audits in docs; no top-tier (ToB/OZ/Certora) audit surfaced; live since 2022 with no exploit",
      "Risk review: multisig under 4 signers and no timelock — upgrades can execute instantly",
      "Uncollateralized loans to KYC'd institutions; minimal lender protection on borrower default",
      "Redemption depends on borrower repayment/utilization; TVL ~$28M, modest depth",
    ],
  },
  goldfinch: {
    rationale:
      "Goldfinch is uncollateralized RWA credit with realized multi-million-dollar loan losses; strong audits do not offset offchain borrower-default exposure.",
    evidence: [
      "CertiK (v1-v2) and Trail of Bits (v2+) audits, reports open-source; live 2021, no contract hack",
      "Multisig 4+ signers but no timelock documented; community DAO governs parameters",
      "Uncollateralized RWA trust-through-consensus; ~$7M Stratos loss + ~$20M soured loan (2023)",
      "Senior Pool 0.5% withdrawal fee; capital locked in illiquid real-world borrower pools",
    ],
  },
  "3jane-lending": {
    rationale:
      "3Jane is brand-new uncollateralized credit with no verifiable live audit, offchain legal recovery, and an unproven admin structure — the highest venue risk in the reviewed set.",
    evidence: [
      "USD3 Etherscan shows 'No Contract Security Audit Submitted'; Veridise prior work unverified on live contracts",
      "Multisig/timelock/veto only on roadmap, not verified on a days-old (Nov 2025) protocol",
      "Fully uncollateralized vs offchain cash flows (zkTLS/Plaid); offchain US legal recovery; sUSD3 first-loss 15%",
      "Deposits capped ~$50M, small TVL ~$17-35M; first-loss tranche illiquidity",
    ],
  },
  centrifuge: {
    rationale:
      "Centrifuge is mature, heavily-audited RWA tokenization; the medium tier reflects offchain asset-performance exposure and redemption/epoch gating rather than contract risk.",
    evidence: [
      "21 independent audits (15 in 2025) incl. Cantina/Spearbit; CertiK Skynet AA; live since 2017, bug bounty",
      "CP171 moved DAO to Foundation-led (CNF) governance; DAO can reassume; V3 multichain upgradeable",
      "Tokenized RWA private credit/CLOs/treasuries; offchain default exposure; ~$1.45B TVL",
      "RWA vaults have redemption/epoch constraints; capital tied to illiquid assets",
    ],
  },
  "flux-finance": {
    rationale:
      "Flux Finance is a Compound V2 fork lending against tokenized Treasuries; overcollateralized but admin-upgradeable with permissioned liquidations.",
    evidence: [
      "Code4rena audit (2024) on Compound V2 changes; built on ToB/OZ/Certora-audited base; $550k Immunefi bounty",
      "Team self-discloses more centralized than Compound V2; upgradeable admin functions; Ondo/Neptune DAO",
      "Stablecoins lent vs OUSG (tokenized US Treasuries); RWA dependency; permissioned liquidations",
      "Compound-style pool gated by utilization; KYC/whitelist required for OUSG liquidators",
    ],
  },
  cap: {
    rationale:
      "Cap routes a 1:1-reserve stablecoin into restaking-backed credit to whitelisted institutional operators; strong audits offset by youth and operator credit risk.",
    evidence: [
      "Sherlock (Jul 2025) + Certora (EigenLayer integration); Certora: no single critical centralized actor",
      "Delegators/operators initially whitelisted; restaking permissionless slashing, no veto; live Aug 2025",
      "cUSD 1:1 reserve-backed, idle to Aave V3; yield from operator credit; slashing covers default",
      "cUSD redeemable, ~$500M TVL with Aave buffer; operator credit-recovery delay",
    ],
  },
  avantis: {
    rationale:
      "Avantis is a perp-DEX LP vault where depositors backstop leveraged traders' PnL; single audit, upgradeable, and market (not credit) principal risk.",
    evidence: [
      "Zellic audit (tranche/withdrawal findings fixed); no top-tier multi-firm audit; live on Base Feb 2024, no exploit",
      "AVNT governance; upgradeable perp DEX admin/vault-manager functions; no timelock detail surfaced",
      "USDC vault is counterparty to leveraged perp traders; LP principal exposed to trader PnL across 80+ markets",
      "ERC-4626 avUSDC; withdrawals subject to vault solvency vs open positions",
    ],
  },
  "euler-v2": {
    rationale:
      "Euler v2 is a hardened modular relaunch with an exemplary post-2023 security program and full prior-exploit recovery; low venue risk.",
    evidence: [
      "60+ reviews by 16+ firms incl. Certora/ToB/OZ; $4M+ spend, formal verification; 2023 v1 exploit fully recovered (~$240M)",
      "EulerDAO on-chain governance with timelock; permissionless EVK/EVC vaults add per-vault surface; no EOA",
      "Overcollateralized onchain, provable vault NAV; curator-dependent vault quality; $2B+ TVL",
      "Deep aggregate liquidity, isolated vaults can be thin; proven 2023 incident response",
    ],
  },
  gearbox: {
    rationale:
      "Gearbox is a well-audited leverage/credit-account protocol; the leverage and curator-credit model lifts funds and liquidity risk above plain money markets.",
    evidence: [
      "V3 by ChainSecurity + ABDK, 10+ total audits; public security repo; zero exploits/bad debt",
      "Gearbox DAO via GEAR, 2-day timelock; guard multisigs 4+ signers veto-only; curators post first-loss stake",
      "Leveraged credit accounts (looping) increase complexity; curator-set leverage/liquidation params",
      "Withdrawals depend on pool utilization under leverage; TVL ~$330M concentrated in Lido pool",
    ],
  },
  "curve-llamalend": {
    rationale:
      "Curve LlamaLend is battle-tested but the complex LLAMMA soft-liquidation design and a 2025 bad-debt event keep funds/liquidity risk at low-medium.",
    evidence: [
      "MixBytes/ChainSecurity/StateMind audits; crvUSD criticals fixed pre-deploy; LLAMMA complexity flagged",
      "Curve DAO governance; v2 moves to LlamaRisk curation + ~7-day vote; no EOA owner",
      "Overcollateralized via LLAMMA bands; CRV-long market ~$700k bad debt Oct 2025; crvUSD-centric in v1",
      "Lending-vault liquidity depends on utilization; some markets thin; soft-liquidation slower in crashes",
    ],
  },
  "fluid-lending": {
    rationale:
      "Fluid's capital-efficient shared liquidity layer concentrates cross-module risk; Guardian pause powers and a recent bad-debt sweep put it at low-medium.",
    evidence: [
      "6 audits; Instadapp 6 years no protocol hack; shared liquidity layer is a single concentrated surface",
      "Guardian multisig can pause subprotocol credit lines; permissioned credit lines; IP moving to Cayman foundation",
      "Shared liquidity layer concentrates risk; absorbed Resolv upstream bad debt; overcollateralized vaults",
      "Deep shared layer generally instant; $1.8B+ TVL; multichain; solvent IR during Resolv cleanup",
    ],
  },
  dolomite: {
    rationale:
      "Dolomite is well-audited but a 2/3 (sub-4-signer) multisig with a sub-48h timelock and very broad asset support drive its centralization risk up to medium.",
    evidence: [
      "6 audits (Zeppelin/Bramah/SECBIT/Cyfrin/Zokyo/Guardian); 100% line/branch coverage; immutable core + upgradable modules",
      "Admin via 2/3 multisig (under 4 signers); timelock under 48h limits user exit window",
      "Virtual liquidity supports 1000+ assets — broader/newer collateral; dynamic collateral; no hacks since 2022",
      "Broad asset support means some thin/concentrated markets; multichain Arbitrum/Berachain/Ethereum",
    ],
  },
  exactly: {
    rationale:
      "Exactly is a multiply-audited fixed+variable-rate lender with timelocked governance; smaller scale and maturity-pool fragmentation keep it at low.",
    evidence: [
      "Coinspect 5x + ABDK 2x + ChainSafe + Cryptecon audits; Immunefi bounty; admin seize finding fixed via timelock",
      "Most EXA/admin behind Optimism timelock; EXA DAO via Snapshot; no EOA",
      "Overcollateralized variable + fixed-rate markets; live Nov 2022; utilization-based fixed pools",
      "Smaller TVL; fixed-rate maturity pools fragment liquidity; variable pool backstops fixed",
    ],
  },
  "fraxlend-v2": {
    rationale:
      "Fraxlend v2 is an audited isolated-pair lender; the FRAX-priced-at-$1 assumption and a 2025 WFRAX bad-debt event lift funds/liquidity risk to low-medium.",
    evidence: [
      "Trail of Bits Jan 2023; FrxGov ToB Jul 2023; public audit repo; FRAX-priced-at-$1 risk flagged",
      "veFXS frxGov dual-Governor; Omega 51% short-circuit allows immediate action; AMO modules peg-constrained",
      "Isolated pairs localize bad debt; FRAX treated as $1 can cause bad debt on depeg; WFRAX llamalend bad-debt event",
      "Isolated pairs can be thin/concentrated; fToken redemption depends on pair utilization",
    ],
  },
  "aave-v4": {
    rationale:
      "Aave v4 carries best-in-class audits but fresh Mar-2026 hub-and-spoke code plus a live Dec-2025 governance crisis raise centralization/operational risk; still low overall.",
    evidence: [
      "345-day review, $1.5M budget, no critical/high; formal verification + fuzzing; Sherlock contest 900+ no criticals",
      "Aave DAO but Dec 2025 governance crisis; BGD+ACI departed, Labs voting dispute; new v4 code live Mar 2026",
      "Hub-and-spoke isolates deposit from spoke borrow; hub bad-debt buffer; new architecture unproven",
      "Deep central liquidity hubs; $24B+ protocol TVL; spokes route from shared hub",
    ],
  },
  "compound-v2": {
    rationale:
      "Compound v2 is battle-tested with 2-day-timelock governance; legacy/deprecated status (superseded by Compound III) is the only material lift, keeping it low.",
    evidence: [
      "OpenZeppelin comprehensive + Certora formal verification; multi-year; prior fixBadAccruals was rewards not collateral",
      "Governor Bravo + 2-day Timelock controls cTokens/Comptroller; COMP holders; no EOA",
      "Overcollateralized blue-chip cTokens, provable shares; legacy/deprecated for Compound III",
      "Deep blue-chip pools but declining/legacy; reduced active maintenance vs v3",
    ],
  },
  "felix-cdp": {
    rationale:
      "Felix is an audited Liquity-v2 fork on Hyperliquid; youth, single-chain concentration, and HYPE/LST collateral with USDC oracle dependency place it at medium.",
    evidence: [
      "Dedaub + Coinspect + Three Sigma price-feed audits; Liquity v2 fork inherits audited base; oracle peg-dependency flagged",
      "Anthias Labs advisory sets LTV/caps; emergency pause, dynamic treasury params; young 2024/2025 protocol",
      "CDP overcollateralized (40% LTV) with Stability Pool; HYPE/LST collateral concentration; HYPE/USD assumes USDC=$1",
      "Hyperliquid-only single-ecosystem; Stability Pool + redemption; rapid $1B TVL but short history",
    ],
  },
  frankencoin: {
    rationale:
      "Frankencoin is an immutable, oracle-free CHF stablecoin with strong decentralization; slower auction-based liquidation of volatile collateral keeps funds/liquidity risk at low.",
    evidence: [
      "ChainSecurity Oct 2023 + Code4rena; separate ChainSecurity CCIP bridge audit; auction design reduces oracle surface",
      "Immutable non-upgradeable, no admin keys; veto-based FPS governance (2%); oracle-free minter additions",
      "~200% overcollateralized wrapped BTC/ETH; oracle-free auction liquidation slower for volatile; FPS first-loss",
      "Auction liquidation slower than instant; FPS bonding-curve mint/redeem; smaller TVL; multichain via audited bridge",
    ],
  },
  "kamino-lend": {
    rationale:
      "Kamino is the strongest-record Solana lender in the set; oracle and large-supplier concentration are the only soft risks, keeping it low.",
    evidence: [
      "9 audits (OtterSec/Halborn/Offside Labs) + Certora formal verification; precision bug fixed pre-exploit; $16B loans zero bad debt",
      "Multisig treasury with emergency pause/shutdown; KMNO governance 2024; Solana STRIDE program",
      "Overcollateralized blue-chip SOL/USDC/JLP; RWA markets $1.23B + Chainlink/Anchorage; Pyth oracle + supplier concentration",
      "Largest Solana protocol, multi-billion TVL, deep pools; instant withdrawals",
    ],
  },
  justlend: {
    rationale:
      "JustLend is a mature Tron lender with a timelocked DAO; concentrated voting power and Tron/USDD ecosystem exposure temper but do not lift it above low.",
    evidence: [
      "CertiK (Apr 2022) + SlowMist + PeckShield audits; no documented hack since 2020",
      "100% on-chain JST governance with 48hr+ timelock; flagged concentrated voting power",
      "Overcollateralized, Comptroller-managed collateral factors; $3.9B TVL; Tron/USDD exposure",
      "$3.9B TVL dominant Tron lender, deep; standard money-market withdrawals",
    ],
  },
  "benqi-lending": {
    rationale:
      "BENQI is an established Avalanche lender with a strong audit cadence and a QI safety module; multisig-only admin keeps it at low.",
    evidence: [
      "9+ audits, Halborn on retainer per release; no known historical exploit",
      "Multisig framework, multi-party approval for parameter changes; QI governance; threshold-signer residual risk",
      "Overcollateralized; QI safety module backstops shortfalls; no admin key can drain; AVAX blue-chip collateral",
      "Avalanche #1 DeFi by TVL, 38,000+ holders, deep; instant withdrawals",
    ],
  },
  "aries-markets": {
    rationale:
      "Aries Markets is the top Aptos lender but a sub-4-signer multisig with no timelock, anonymous team, and a ~90% TVL collapse place it in the high tier.",
    evidence: [
      "OtterSec audit (~2 audits); no documented hack since 2022",
      "Multisig under 4 signers, no timelock (instant malicious upgrade); no governance token, anonymous team",
      "Overcollateralized lending/margin on Aptos; TVL ~$830M peak to ~$92M late 2025; Move newer collateral",
      "Top Aptos lender but TVL down ~90%; thinner Aptos liquidity, concentration",
    ],
  },
  "scallop-lend": {
    rationale:
      "Scallop is a solid Sui lender with three reputable audits and a bounty; an undisclosed multisig config and thinner Sui liquidity keep it at low-medium.",
    evidence: [
      "Zellic + OtterSec + MoveBit audits, regular re-audits; bug bounty, open-source, no known exploit",
      "veSCA governance, decentralization in progress; multisig config not public (scored conservatively); team-led upgrades",
      "Overcollateralized money market on Sui; TVL ~$102M (peak $195M); Move collateral",
      "~$100M TVL leading Sui lender, moderate depth; thinner Sui chain",
    ],
  },
  "echelon-market": {
    rationale:
      "Echelon is a fast-growing Aptos lender with isolated markets and Chainlink oracles; a very young DAO and unitemized audits keep it at medium.",
    evidence: [
      "Multiple audits cited but firms not itemized (scored conservatively); no documented exploit since 2024",
      "ELON DAO launched Feb 2026 (very recent); no token most of 2025; multi-chain Aptos/Movement/Initia widens surface",
      "Isolated markets, Chainlink oracles, sUSDe/BTC collateral; $400M+ deposits; newer Move/long-tail collateral",
      "$200-400M TVL across emerging chains; thinner liquidity",
    ],
  },
  "blend-pools-v2": {
    rationale:
      "Blend is an immutable, governance-minimized Stellar lending primitive with backstop insurance; thin-chain liquidity is the main residual risk, keeping it at low.",
    evidence: [
      "Third-party audited (docs); Soroban immutable contracts; no documented exploit",
      "Immutable contracts, governance-minimized; permissionless pool creation, auto-rates; no DAO needed",
      "Overcollateralized isolated pools with backstop insurance module replacing supplier losses; USDC/XLM/EURC",
      "~$95M TVL, ~$39M loans, leading Stellar lender; thinner Stellar/Soroban depth",
    ],
  },
  "jupiter-lend": {
    rationale:
      "Jupiter Lend is a deep, well-audited Solana lender but young, with rehypothecation undercutting isolation claims; timelocked admin keeps it at low-medium.",
    evidence: [
      "6-7 audits (OtterSec/Offside Labs) + Certora formal verification; no exploit, avoided Oct 2025 crash bad debt",
      "Function-scoped multisigs, upgrade multisig timelocked; team owns underlying Fluid liquidity layer; launched Aug 2025",
      "Overcollateralized but rehypothecation shares collateral across vaults; team admitted isolation claims inaccurate; multi-oracle",
      "$1.6B+ TVL, #1 Solana by supply, deep instant liquidity; 99,000 positions",
    ],
  },
  "hyperlend-pooled": {
    rationale:
      "HyperLend is a well-audited but young Aave-fork on the thin, exploit-prone HyperEVM; admin opacity and kHYPE concentration place it at medium.",
    evidence: [
      "Ackee/Cantina/Pashov audits (46+ engineer-days); Ackee found critical collateral-theft bug fixed pre-deploy; bounty active",
      "HPL governance new (airdrop Jan 2026); admin/timelock not clearly documented; Aave/FraxLend fork on young HyperEVM",
      "Overcollateralized Core/Isolated/P2P pools, BlockAnalitica risk; ~$420M TVL kHYPE-concentrated; exploit-prone ecosystem",
      "$420M TVL heavily kHYPE-concentrated (~$183M); young chain concentration",
    ],
  },
  curvance: {
    rationale:
      "Curvance is a brand-new Monad lender with tiny TVL and unitemized audits; scored conservatively across the board for lack of track record, placing it high.",
    evidence: [
      "Audit firms/reports not itemized, funds earmarked for auditing; very new, no track record (scored conservatively)",
      "CVE/DAO governance, tokenomics unreleased; launched Monad (Nov 2025) upgradeable; unproven admin",
      "Isolated positions, dual-oracle, circuit breakers, MEV liquidations; low TVL; LST/LRT/Pendle-PT/LP on new chain",
      "Very small TVL (single-digit millions); brand-new Monad chain, thin/concentrated",
    ],
  },
  "sovryn-dex": {
    rationale:
      "Sovryn is a mature Bitcoin-DeFi lender, but a prior partially-unrecovered lending exploit and thin Rootstock liquidity place it at medium.",
    evidence: [
      "Heavily audited per team, active bounty; BUT Oct 2022 lend/borrow exploit ~$1.1M (flash-loan iToken manipulation), ~half recovered",
      "Bitocracy DAO/SOV on-chain voting; legacy lend/borrow carried exploited code; Rootstock federated peg",
      "Overcollateralized RBTC/XUSD/USDT; past undercollateralization from price manipulation; treasury reinjected loss",
      "Thin Rootstock/RSK liquidity, small relative TVL; Bitcoin-sidechain depth limited",
    ],
  },
  truefi: {
    rationale:
      "TrueFi is uncollateralized DeFi credit; trust-based borrower accounting and realized default history put it in the high tier despite a DAO-timelocked admin.",
    evidence: [
      "ChainSecurity audited TrueFi; no top-tier multi-firm coverage surfaced",
      "Ownership migrated multisig to DAO Timelock (TFIP-7/42); TRU governs borrowers/params",
      "Uncollateralized credit to whitelisted borrowers; defaults absorbed by SAFU + TRU slashing",
      "TVL collapsed from ~$1B peak to single-digit millions; redemption depends on loan maturity",
    ],
  },
  "radiant-v2": {
    rationale:
      "Radiant Capital suffered a ~$50M unrecovered Oct-2024 exploit and is in wind-down; it scores near-worst across audits, centralization, liquidity, and operational.",
    evidence: [
      "Oct-2024 ~$50M exploit (DPRK-attributed) unrecovered; Jan-2024 flash-loan drained ~$4.5M",
      "Exploit hijacked the multisig via malware-signed ownership transfer / proxy implementation swap",
      "Cross-chain Aave-fork; once >$300M deposits, now a ~$2.2M TVL husk in maintenance/exit mode",
      "18+ months of failed recovery; depositor remediation unresolved",
    ],
  },
  "wildcat-protocol": {
    rationale:
      "Wildcat is undercollateralized credit with borrower-defined terms; its low protocol-admin surface is outweighed by maximal funds/liquidity trust risk, placing it high.",
    evidence: [
      "Publicly audited + onchain monitoring + bug bounty; specific top-firm names not surfaced; V2 launched Feb 2025",
      "Settlement-layer design: protocol cannot freeze/liquidate; markets controlled by the borrower alone",
      "Undercollateralized credit on borrower reputation; ~$150M outstanding, no collateral backstop",
      "Borrower-defined withdrawal terms; funds locked at borrower discretion until repaid",
    ],
  },
  "gains-network": {
    rationale:
      "Gains Network (gTrade) is a leveraged-perps vault, not a money market; a 14-day timelock and overcollateralization buffer keep it at low-medium.",
    evidence: [
      "Multiple CertiK audits + Immunefi bounty; no major hack of Gains itself across heavy iteration",
      "gToken vault upgradeable behind a 14-day timelock; moving to GNS/veGNS governance",
      "ERC-4626 gToken vault backstops leveraged-trading PnL; can go undercollateralized in stress",
      "Epoch-based withdrawal queue (1-3 epochs) prevents PnL front-running",
    ],
  },
  "venus-core-pool": {
    rationale:
      "Venus Core Pool is an established overcollateralized BNB-chain money market; its 2025 $27M incident was user phishing (fully recovered), not a contract flaw — low venue risk.",
    evidence: [
      "Audited by Quantstamp, Code4rena, PeckShield, Hacken; active bounty; Sep-2025 $27M phishing loss recovered",
      "XVS governance with 48-hour timelock + tiered VIPs + AccessControlManager",
      "Overcollateralized onchain market with borrow/supply caps and fine-grained pause",
      "Compound-fork instant supply/withdraw subject to utilization; deep liquidity",
    ],
  },
  "moonwell-lending": {
    rationale:
      "Moonwell is an overcollateralized multichain Compound-fork; a Mar-2026 governance-attack vector lifts centralization to 3, keeping it at low.",
    evidence: [
      "Halborn + Code4rena audits + Immunefi bounty; Gauntlet/Warden risk management",
      "WELL DAO governance; Mar-2026 governance attack (MIP-R39) sought market/oracle admin, lacked circuit breakers",
      "Overcollateralized lending on Base/Optimism/Moonbeam with tiered collateral factors and caps",
      "Compound-fork instant supply/withdraw; deep multichain liquidity",
    ],
  },
  "silo-v2": {
    rationale:
      "Silo v2 is overcollateralized isolated-pair lending with immutable per-market silos; permissionless market creation and thin newer markets raise funds/liquidity risk to medium.",
    evidence: [
      "2025 audits: Sigma Prime, Certora (formal verification), Code4rena, Cantina; Immunefi bounty",
      "Immutable per-market silos; permissionless market creation; Silo Vaults add curator trust",
      "Overcollateralized isolated pairs contain risk; permissionless listing risks low-quality collateral",
      "Isolated-market depth varies sharply by pair; thin newer markets concentrate liquidity",
    ],
  },
  "sturdy-v2": {
    rationale:
      "Sturdy v2 is an overcollateralized two-tier silo + aggregator design; a v1 hack history, manager trust, and no bad-debt reserves keep it at medium.",
    evidence: [
      "ChainSecurity audited v2 ('high level of security'); v1 had a Jun-2023 ~$800K read-only reentrancy exploit",
      "STRDY governance; aggregator managers control allocation and silo whitelisting",
      "Overcollateralized but no bad-debt reserve accrual flagged; Bittensor-subnet allocation dependency",
      "Isolated pairs with shared-liquidity aggregation; smaller TVL, moderate depth",
    ],
  },
  vesper: {
    rationale:
      "Vesper is a yield aggregator (not a money market) routing into external protocols; composed strategy risk and a 2021 oracle-hack history put it at medium.",
    evidence: [
      "50+ audits across pools/strategies; Immunefi bounty; Nov-2021 ~$3.37M oracle attack on a Lend Beta pool",
      "vVSP DAO governance; strategy keepers/managers retain operational control",
      "Yield-aggregator vaults route into external lending/LP protocols, exposing underlying-protocol risk",
      "Grow/Earn vault shares generally redeemable; modest TVL vs 2021 peak",
    ],
  },
  "convex-finance": {
    rationale:
      "Convex is a Curve LP-boosting / veCRV staking layer (NOT a lending/credit venue); immutable contracts, never exploited, with blue-chip Curve LP underlying — low venue risk.",
    evidence: [
      "MixBytes + additional audits + bounty; 2022 bugs patched pre-exploit; never hacked; immutable since 2021",
      "Immutable contracts but vlCVX/multisig governance is concentrated (governance-capture risk)",
      "Stakes Curve LP into gauges; underlying assets are blue-chip Curve LP positions",
      "Curve LP staking generally instant withdrawal; deep TVL (peaked >$10B); cvxCRV exit only via secondary market",
    ],
  },
  liqwid: {
    rationale:
      "Liqwid is the mature Cardano lending leader with a no-admin DAO design; thin eUTXO liquidity and LQ-heavy collateral are the main residual risks, keeping it at low.",
    evidence: [
      "Tweag + MLabs Plutus audits; 1500+ liquidations, no protocol exploit; Immunefi bounty",
      "LQ-holder DAO via Agora; no privileged admin keys by design; upgrades gated through governance",
      "Overcollateralized non-custodial qToken market; ADA + LQ ~90% of deposits (concentration)",
      "Thin Cardano liquidity ~$70-100M TVL concentrated in two assets",
    ],
  },
  "lista-lending": {
    rationale:
      "Lista Lending is a well-audited Binance-adjacent BNB-chain CDP/isolated lender with a documented timelock and deep liquidity — the lowest-risk venue in the Wave 2 set.",
    evidence: [
      "PeckShield, SlowMist, CertiK, Veridise, BlockSec audits; Immunefi bounty + Risk Fund; no exploit",
      "veLISTA governance with a documented 24-hour timelock; YZi Labs (Binance) backed",
      "Overcollateralized MakerDAO-style CDP + isolated markets with per-market risk parameters",
      "Deep BNB Chain liquidity ~$1B+ lending TVL; isolated/P2P vaults can queue under high utilization",
    ],
  },
  loopscale: {
    rationale:
      "Loopscale recovered fully from an Apr-2025 ~$5.8M oracle exploit but remains young, tokenless, and team-controlled with exotic collateral — high tier.",
    evidence: [
      "OShield audit Jan-Feb 2025; Sec3 still underway at the hack; Apr-2025 ~$5.8M oracle exploit (fully recovered)",
      "No token/DAO; team-controlled admin with undisclosed multisig; pause/withdrawal-disable powers used in incident",
      "Overcollateralized fixed-rate isolated markets; exotic RateX PT collateral caused the exploit",
      "~$97M TVL recovered, single-chain Solana; withdrawals were halted during the incident",
    ],
  },
  "navi-lending": {
    rationale:
      "NAVI is the largest Sui lender with strong Move audits; team-retained mint/freeze controls and young-chain risk cap it at low.",
    evidence: [
      "OtterSec + MoveBit (Move-specialist, formal verification) audits; no reported exploit",
      "veToken governance launched 2025; mint/freeze controls reportedly remain with the team; MSafe multisig",
      "Overcollateralized SUI/USDC/USDT/wETH/wBTC with health-factor liquidations and isolated pools",
      "Largest Sui TVL ~$400M+; unified liquidity pool instant within utilization; young chain limits dispersion",
    ],
  },
  "zest-v2": {
    rationale:
      "Zest is the largest Stacks BTC lender with a timelocked multisig; novel unproven BitVM vaults and thin Bitcoin-L2 liquidity raise it to medium.",
    evidence: [
      "Least Authority (2023) + Coinfabrik (2024) audits; Immunefi bounty; no bad debt over 1500+ liquidations",
      "V2 multisig governance with timelock (threshold/delay undisclosed); ZEST governance token",
      "Overcollateralized BTC/sBTC/STX/USDC; new BitVM-verified Bitcoin Collateral Vaults are novel/unproven",
      "Thin Stacks/Bitcoin-L2 liquidity ~$100M peak; cross-chain borrow adds settlement latency",
    ],
  },
  resupply: {
    rationale:
      "Resupply (Convex/Yearn sub-DAO) recovered fully from a Jun-2025 ~$9.6M oracle exploit; composable stablecoin-CDP collateral and the preventable flaw keep it at medium.",
    evidence: [
      "Audited yet hit a Jun-2025 ~$9.6M donation/oracle exploit (empty-vault price flaw); bad debt fully repaid",
      "Convex/Yearn sub-DAO with RSUP governance; coordinated DAO crisis response; upgrade delay not documented",
      "reUSD backed by yield-bearing stablecoin CDP collateral (other protocols' LP/vault tokens — composability risk)",
      "reUSD liquidity declined post-exploit; ~$38M insurance pool backstopped the recovery",
    ],
  },
  termmax: {
    rationale:
      "TermMax is a well-audited 4-of-6-multisig fixed-rate isolated lender; tokenized-equity/RWA collateral and maturity lockups raise it to medium.",
    evidence: [
      "Multiple audit rounds (93% DeFiSafety); Immunefi + Cantina; Hypernative monitoring; no exploit since Apr-2025",
      "4-of-6 multisig with timelock on critical changes; TMX governance planned but not live",
      "Fixed-rate isolated markets with curator-managed vaults; exotic tokenized-equity (Ondo) collateral",
      "~$30-50M TVL multichain; fixed maturities create term lockups",
    ],
  },
  upshift: {
    rationale:
      "Upshift is an institutional credit-vault provider lending to KYC'd market makers via a prime broker; a sub-4-signer multisig, no timelock, and offchain counterparty exposure put it high.",
    evidence: [
      "Hacken, OtterSec, ChainSecurity, Sigma Prime, Zellic audits; hit by $292M Kelp/LayerZero bridge contagion freeze",
      "Multisig under 4 signers, no documented timelock; role-based operator sets APR/loans",
      "Credit lending to KYC'd market makers via August prime broker; offchain/CeFi strategies and custody exposure",
      "Loans have terms/durations with redemption queues; ~$550M peak TVL, strategy-dependent unwinds",
    ],
  },
  tectonic: {
    rationale:
      "Tectonic is a mature audited Compound-fork on Cronos; overcollateralized but single-chain concentration and an opaque admin threshold keep it at medium.",
    evidence: [
      "CertiK + SlowMist audits; Chainlink + Band oracles; no major exploit found; mature since 2021",
      "TONIC/xTONIC governance; isolated pools (Main/Veno/DeFi); Cronos-team-adjacent control, threshold undisclosed",
      "Overcollateralized Compound-style market with a community insurance pool for bad debt",
      "~$120M+ TVL concentrated on Cronos; smaller-cap isolated pools thinner",
    ],
  },
  "openeden-usdo": {
    rationale:
      "OpenEden USDO is a regulated T-bill-backed stablecoin venue; strong ratings/custody are offset by offchain RWA dependency and centralized issuer mint/redeem control — medium.",
    evidence: [
      "Chainlink CCIP + Proof-of-Reserve; S&P AA+f and Moody's A fund ratings; onchain PoR",
      "BMA-licensed issuer (OpenEden Digital); EDEN governance; issuer can pause/freeze and controls mint/redeem",
      "RWA-backed by tokenized US Treasuries with BNY custodian (offchain custody dependency)",
      "24/7 instant TBILL mint/redeem ~$277M TVL; T-bill settlement adds some latency",
    ],
  },
} satisfies Record<YieldRiskConfigProtocol, YieldRiskConfigMetadata>;

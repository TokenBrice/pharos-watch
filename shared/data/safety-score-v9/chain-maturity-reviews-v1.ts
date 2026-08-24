export const CHAIN_MATURITY_GATE_IDS = [
  "continuity",
  "liveness",
  "block-production-finality",
  "change-control",
  "dependency-exit",
] as const;

export type ChainMaturityGateId = (typeof CHAIN_MATURITY_GATE_IDS)[number];
export type ChainMaturityGateResult = "pass" | "fail";
export type ChainMaturityAdmissionDecision = "admit" | "exclude";

export interface ChainMaturityEvidenceSource {
  readonly title: string;
  readonly url: string;
  /** The source's own publication/update date. Null means the living source publishes no date. */
  readonly documentDate: string | null;
  readonly accessedAt: string;
}

export interface ChainMaturityGateReview {
  readonly result: ChainMaturityGateResult;
  readonly finding: string;
  readonly sources: readonly ChainMaturityEvidenceSource[];
}

export interface ChainMaturityReview {
  readonly chainSlug: string;
  readonly displayName: string;
  readonly admission: ChainMaturityAdmissionDecision;
  readonly reviewedAt: string;
  readonly gates: Readonly<Record<ChainMaturityGateId, ChainMaturityGateReview>>;
}

const REVIEWED_AT = "2026-08-24";

function source(
  title: string,
  url: string,
  documentDate: string | null,
): ChainMaturityEvidenceSource {
  return { title, url, documentDate, accessedAt: REVIEWED_AT };
}

function gate(
  result: ChainMaturityGateResult,
  finding: string,
  ...sources: readonly ChainMaturityEvidenceSource[]
): ChainMaturityGateReview {
  return { result, finding, sources };
}

const SOURCES = {
  arbitrumLaunch: source(
    "Arbitrum One mainnet beta launch",
    "https://blog.arbitrum.io/arbitrum-one-mainnet-beta-is-live/",
    "2021-08-31",
  ),
  arbitrumStatus: source("Arbitrum status history", "https://status.arbitrum.io/history", null),
  arbitrumRisk: source("L2BEAT Arbitrum One risk analysis", "https://l2beat.com/scaling/projects/arbitrum", null),
  avalancheLaunch: source(
    "Avalanche mainnet launch",
    "https://www.avax.network/about/blog/avalanche-mainnet-launches-bringing-defi-to-the-world",
    "2020-09-21",
  ),
  avalancheStatus: source("Avalanche status history", "https://status.avax.network/history", null),
  avalancheValidators: source(
    "Avalanche Primary Network validators",
    "https://build.avax.network/explorer/mainnet/p-chain/validators",
    null,
  ),
  avalancheAcps: source("Avalanche Community Proposals", "https://build.avax.network/docs/acps/overview", null),
  baseNetwork: source("Base network information", "https://docs.base.org/chain/network-information", null),
  baseStatus: source("Base status history", "https://status.base.org/history", null),
  baseRisk: source("L2BEAT Base risk analysis", "https://l2beat.com/scaling/projects/base", null),
  bscHistory: source(
    "BNB Smart Chain genesis announcement",
    "https://www.bnbchain.org/en/blog/binance-smart-chain-mainnet-is-live",
    "2020-09-01",
  ),
  bscStatus: source("BNB Chain release and operational history", "https://www.bnbchain.org/en/releases", null),
  bscValidators: source(
    "BNB Smart Chain validator overview",
    "https://docs.bnbchain.org/bnb-smart-chain/validator/overview/",
    "2025",
  ),
  bscGovernance: source(
    "BNB Smart Chain governance",
    "https://docs.bnbchain.org/bnb-smart-chain/governance/",
    null,
  ),
  ethereumHistory: source("Ethereum history", "https://ethereum.org/en/history/", null),
  ethereumLiveness: source("Ethereum ten-year uptime record", "https://ethereum.org/10years/", "2026-08-06"),
  ethereumNetwork: source("Ethereum networks", "https://ethereum.org/en/developers/docs/networks/", null),
  ethereumPos: source(
    "Ethereum proof-of-stake consensus",
    "https://ethereum.org/en/developers/docs/consensus-mechanisms/pos/",
    null,
  ),
  ethereumGovernance: source("Ethereum governance", "https://ethereum.org/en/governance/", null),
  hyperliquidHistory: source(
    "Hyperliquid L1 documentation",
    "https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/hyperliquid-l1",
    null,
  ),
  hyperliquidStatus: source("Hyperliquid status history", "https://hyperliquid.statuspage.io/history", null),
  hyperliquidValidators: source(
    "Running a Hyperliquid validator",
    "https://hyperliquid.gitbook.io/hyperliquid-docs/validators/running-a-validator",
    "2026-08",
  ),
  hyperliquidBridge: source(
    "Hyperliquid bridge and validator security",
    "https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/bridge2",
    null,
  ),
  optimismHistory: source(
    "Optimism mainnet launch retrospective",
    "https://www.optimism.io/blog/optimistic-ethereum-mainnet-soft-launch",
    "2021-01-16",
  ),
  optimismStatus: source("Optimism status history", "https://status.optimism.io/history", null),
  optimismRisk: source("L2BEAT OP Mainnet risk analysis", "https://l2beat.com/scaling/projects/optimism", null),
  polygonHistory: source("Polygon PoS documentation", "https://docs.polygon.technology/pos/", null),
  polygonStatus: source("Polygon PoS status history", "https://posmainnet.status.polygon.technology/history", null),
  polygonValidators: source(
    "Polygon PoS validator overview",
    "https://docs.polygon.technology/pos/get-started/validator/",
    null,
  ),
  polygonGovernance: source(
    "Polygon Improvement Proposals",
    "https://github.com/0xPolygon/Polygon-Improvement-Proposals",
    null,
  ),
  solanaHistory: source("Solana mainnet beta", "https://solana.com/news/solana-mainnet-beta", "2020-03-16"),
  solanaStatus: source("Solana status history", "https://status.solana.com/history", null),
  solanaValidators: source("Solana validator requirements", "https://solana.com/docs/operations/requirements", null),
  solanaClusters: source("Solana clusters", "https://solana.com/docs/references/clusters", null),
  tronHistory: source("TRON mainnet history", "https://developers.tron.network/docs/tron-protocol", null),
  tronStatus: source("TRON network statistics", "https://tronscan.org/#/data/stats2/total-transactions", null),
  tronValidators: source(
    "TRON Super Representatives",
    "https://developers.tron.network/docs/super-representatives",
    "2026-07",
  ),
  tronGovernance: source("TRON proposals", "https://developers.tron.network/docs/tron-proposal", null),
  xrplHistory: source("XRP Ledger history", "https://xrpl.org/about/history", null),
  xrplStatus: source("Ripple and XRP Ledger status history", "https://status.ripple.com/history", null),
  xrplConsensus: source("XRP Ledger consensus", "https://xrpl.org/docs/concepts/consensus-protocol", null),
  xrplAmendments: source("XRP Ledger amendments", "https://xrpl.org/docs/concepts/networks-and-servers/amendments", null),
  cardanoHistory: source("Cardano hard-fork history", "https://cardano.org/hardforks/", null),
  cardanoStatus: source("Cardano status history", "https://status.cardano.org/history", null),
  cardanoConsensus: source(
    "Cardano Ouroboros consensus",
    "https://docs.cardano.org/about-cardano/learn/ouroboros-overview",
    null,
  ),
  cardanoGovernance: source(
    "Cardano governance overview",
    "https://docs.cardano.org/about-cardano/governance-overview",
    null,
  ),
  gnosisHistory: source("Gnosis Chain history", "https://docs.gnosischain.com/about/history/", null),
  gnosisStatus: source("Gnosis Chain status history", "https://status.gnosischain.com/history", null),
  gnosisValidators: source("Gnosis Chain validators", "https://docs.gnosischain.com/node/", null),
  gnosisGovernance: source("Gnosis governance", "https://docs.gnosischain.com/concepts/governance/", null),
  gnosisBridge: source("Gnosis bridges", "https://docs.gnosischain.com/bridges/", null),
  hederaJourney: source("Hedera journey", "https://hedera.com/journey/", null),
  hederaStatus: source("Hedera status history", "https://status.hedera.com/history", null),
  hederaNodes: source("Hedera network nodes", "https://docs.hedera.com/hedera/networks/mainnet/mainnet-nodes", null),
  hederaRelease: source(
    "Hedera release-cycle overview",
    "https://hedera.com/blog/hedera-release-cycle-overview/",
    "2025",
  ),
  hederaConsensus: source(
    "Hedera hashgraph consensus",
    "https://docs.hedera.com/hedera/core-concepts/hashgraph-consensus-algorithms",
    null,
  ),
  rootstockWhitepaper: source(
    "Rootstock white paper",
    "https://rootstock.io/static/a79b27d4889409602174df4710102056/RS-whitepaper.pdf",
    "2023",
  ),
  rootstockStatus: source("Rootstock status history", "https://status.rootstock.io/history", null),
  rootstockPowpeg: source("Rootstock Powpeg", "https://dev.rootstock.io/concepts/powpeg/", null),
  suiLaunch: source("Sui 2023 milestones", "https://www.sui.io/blog/2023-growth-milestones", "2023-12-20"),
  suiStatus: source("Sui status history", "https://status.sui.io/history", null),
  suiValidators: source("Sui validators", "https://docs.sui.io/concepts/cryptography/transaction-auth/validators", null),
  suiUpgrades: source("Sui protocol upgrades", "https://docs.sui.io/concepts/sui-architecture/protocol-upgrades", null),
  suiBridge: source("Sui Bridge", "https://docs.sui.io/concepts/tokenomics/sui-bridging", null),
  confluxLaunch: source("Conflux mainnet launch plan", "https://forum.conflux.fun/t/topic/1234", "2020-07-15"),
  confluxStatus: source("Conflux status history", "https://status.confluxnetwork.org/history", null),
  confluxProtocol: source("Conflux protocol overview", "https://doc.confluxnetwork.org/docs/overview/", null),
  confluxGovernance: source("Conflux governance", "https://doc.confluxnetwork.org/docs/general/governance/", null),
  klaytnHistory: source("Kaia hard-fork history", "https://docs.kaia.io/misc/kaia-history/", "2025-08-28"),
  klaytnStatus: source("Kaia status history", "https://status.kaia.io/history", null),
  klaytnConsensus: source("Kaia consensus mechanism", "https://docs.kaia.io/learn/consensus-mechanism/", null),
  klaytnGovernance: source("KIP-81 governance contract", "https://kips.kaia.io/KIPs/kip-81", "2022-09-19"),
  klaytnBridge: source("Kaia bridges", "https://docs.kaia.io/build/tools/bridge/", null),
  celoMigration: source("Celo L2 documentation", "https://docs.celo.org/build-on-celo", null),
  celoArchitecture: source("Celo L2 architecture", "https://docs.celo.org/build-on-celo/cel2-architecture", null),
  celoRisk: source("L2BEAT Celo risk analysis", "https://l2beat.com/scaling/projects/celo", null),
  celoMigrationDate: source(
    "Celo L2 mainnet migration",
    "https://celo.org/blog/celo-l2-mainnet-is-live",
    "2025-03-26",
  ),
  sonicLaunch: source("Sonic migration overview", "https://docs.soniclabs.com/migration/overview", "2025"),
  sonicStatus: source("Sonic status history", "https://status.soniclabs.com/history", null),
  sonicValidators: source("Sonic validator documentation", "https://docs.soniclabs.com/sonic/node/validator", null),
  sonicGovernance: source("Sonic governance", "https://docs.soniclabs.com/sonic/governance", null),
  lineaLaunch: source("Linea mainnet alpha launch", "https://linea.build/blog/linea-mainnet-alpha-is-live", "2023-07-11"),
  lineaStatus: source("Linea status history", "https://linea.statuspage.io/history", null),
  lineaRisk: source("L2BEAT Linea risk analysis", "https://l2beat.com/scaling/projects/linea", null),
  lineaRoadmap: source(
    "Linea decentralization roadmap",
    "https://linea.build/blog/the-importance-of-decentralizing-the-linea-sequencer",
    "2024-12-19",
  ),
  berachainLaunch: source(
    "Berachain validator-set governance proposal",
    "https://forum.berachain.com/t/proposal-restructuring-the-validator-set-for-competitiveness/1570",
    "2026-02-10",
  ),
  berachainStatus: source("Berachain status history", "https://status.berachain.com/history", null),
  berachainConsensus: source("Berachain proof of liquidity", "https://docs.berachain.com/learn/pol/", null),
  berachainGovernance: source("Berachain governance", "https://docs.berachain.com/learn/governance/", null),
  movementLaunch: source(
    "Movement public mainnet beta launch",
    "https://www.movementnetwork.xyz/article/movement-network-public-mainnet-beta",
    "2025-03-10",
  ),
  movementStatus: source("Movement status history", "https://status.movementnetwork.xyz/history", null),
  movementArchitecture: source("Movement architecture", "https://docs.movementnetwork.xyz/general/architecture", null),
  monadLaunch: source("Monad mainnet launch", "https://www.monad.xyz/announcements/get-started-on-monad-mainnet", "2025-11-24"),
  monadStatus: source("Monad status history", "https://status.monad.xyz/history", null),
  monadConsensus: source("Monad consensus", "https://docs.monad.xyz/monad-arch/consensus/monadbft", null),
  monadGovernance: source("Monad network upgrades", "https://docs.monad.xyz/developer-essentials/network-information", null),
  plumeLaunch: source(
    "Plume letter on asset tokenization",
    "https://www.plume.org/blog/plumes-letter-on-asset-tokenization-to-the-bermuda-monetary-authority",
    "2026",
  ),
  plumeStatus: source("Plume status history", "https://status.plume.org/history", null),
  plumeArchitecture: source("Plume network documentation", "https://docs.plume.org/plume/introduction", null),
  plumeBridge: source("Plume bridge documentation", "https://docs.plume.org/plume/bridge", null),
  polygonZkevmSunset: source(
    "Polygon zkEVM sunset",
    "https://polygon.technology/polygon-zkevm",
    "2026-07-03",
  ),
  polygonZkevmRisk: source(
    "L2BEAT Polygon zkEVM risk analysis",
    "https://l2beat.com/scaling/projects/polygonzkevm",
    null,
  ),
} as const;

export const CHAIN_MATURITY_ADMISSION_TEST_V1 = {
  schemaVersion: 1,
  reviewedAt: REVIEWED_AT,
  reviewCadence: "quarterly",
  gates: {
    continuity:
      "At least 36 months of production history; reset after a material consensus or security-model migration unless ledger, operator, and exit-security continuity are proved.",
    liveness:
      "Public status or incident history covering at least 365 days, no active sunset, and no unresolved event preventing ordinary transactions or holder exits.",
    "block-production-finality":
      "Permissionless participation or at least 21 independently operated producers/finality members, no single entity able to halt or finalize, and documented economic security.",
    "change-control":
      "No unilateral instant protocol or bridge upgrade; L2s require L2BEAT Stage 1 or stronger, at least seven days of user-enforceable exit, and escape-preserving data availability; L1s require multi-party or on-chain adoption with usable notice or exit.",
    "dependency-exit":
      "Canonical bridge and data-availability dependencies, thresholds, and holder exit path are documented; sunset, unavailable withdrawal, or one custodian able to strand the chain fails.",
  } satisfies Readonly<Record<ChainMaturityGateId, string>>,
} as const;

export const CHAIN_MATURITY_REVIEWS_V1 = [
  {
    chainSlug: "arbitrum",
    displayName: "Arbitrum One",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "Production history exceeds 36 months.", SOURCES.arbitrumLaunch),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.arbitrumStatus),
      "block-production-finality": gate("pass", "Ethereum finality and the documented user escape path prevent one L2 operator from finalizing arbitrary state.", SOURCES.arbitrumRisk),
      "change-control": gate("pass", "The reviewed rollup is Stage 1 or stronger and exposes a user-enforceable delay and exit path.", SOURCES.arbitrumRisk),
      "dependency-exit": gate("pass", "The Ethereum, data-availability, bridge, and forced-exit dependencies are documented.", SOURCES.arbitrumRisk),
    },
  },
  {
    chainSlug: "avalanche",
    displayName: "Avalanche",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "Production history exceeds 36 months.", SOURCES.avalancheLaunch),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.avalancheStatus),
      "block-production-finality": gate("pass", "The Primary Network has far more than 21 independently operated validators with stake-backed consensus.", SOURCES.avalancheValidators),
      "change-control": gate("pass", "Protocol changes use the published multi-party ACP process.", SOURCES.avalancheAcps),
      "dependency-exit": gate("pass", "Native assets transact and exit on the L1 without an upstream canonical bridge or external DA custodian.", SOURCES.avalancheLaunch, SOURCES.avalancheValidators),
    },
  },
  {
    chainSlug: "base",
    displayName: "Base",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "The reviewed production lineage and security model exceed the continuity threshold.", SOURCES.baseNetwork, SOURCES.baseRisk),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.baseStatus),
      "block-production-finality": gate("pass", "Ethereum finality and the documented user escape path prevent one L2 operator from finalizing arbitrary state.", SOURCES.baseRisk),
      "change-control": gate("pass", "The reviewed rollup is Stage 1 or stronger and exposes a user-enforceable delay and exit path.", SOURCES.baseRisk),
      "dependency-exit": gate("pass", "The Ethereum, data-availability, bridge, and forced-exit dependencies are documented.", SOURCES.baseRisk),
    },
  },
  {
    chainSlug: "bsc",
    displayName: "BNB Smart Chain",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "Production history exceeds 36 months.", SOURCES.bscHistory),
      liveness: gate("pass", "The dated public operational history covers the review window with no active sunset.", SOURCES.bscStatus),
      "block-production-finality": gate("pass", "The active validator set exceeds the 21-member threshold and uses stake-backed finality.", SOURCES.bscValidators),
      "change-control": gate("pass", "Changes follow the published validator and governance process rather than one instant unilateral key.", SOURCES.bscGovernance),
      "dependency-exit": gate("pass", "Native assets transact and exit on the L1 without an upstream canonical bridge or external DA custodian.", SOURCES.bscValidators),
    },
  },
  {
    chainSlug: "ethereum",
    displayName: "Ethereum",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "Production history exceeds 36 months and the PoS transition retained ledger continuity.", SOURCES.ethereumHistory),
      liveness: gate("pass", "The dated public uptime record covers the review window with no active sunset.", SOURCES.ethereumLiveness),
      "block-production-finality": gate("pass", "Validator participation is permissionless and economically secured by stake and slashing.", SOURCES.ethereumPos),
      "change-control": gate("pass", "Protocol adoption is multi-client and social rather than controlled by an instant unilateral upgrade key.", SOURCES.ethereumGovernance),
      "dependency-exit": gate("pass", "Native assets transact and exit on the L1 without an upstream canonical bridge or external DA custodian.", SOURCES.ethereumNetwork),
    },
  },
  {
    chainSlug: "hyperliquid",
    displayName: "Hyperliquid L1",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "The reviewed production ledger history exceeds 36 months.", SOURCES.hyperliquidHistory),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.hyperliquidStatus),
      "block-production-finality": gate("pass", "Validator operation is permissionless and the active stake-ranked set has 24 members.", SOURCES.hyperliquidValidators),
      "change-control": gate("pass", "Validator-governed adoption prevents one instant unilateral protocol change.", SOURCES.hyperliquidValidators),
      "dependency-exit": gate("pass", "The external bridge validator threshold and native L1 path are documented.", SOURCES.hyperliquidBridge),
    },
  },
  {
    chainSlug: "optimism",
    displayName: "OP Mainnet",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "Production history exceeds 36 months.", SOURCES.optimismHistory),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.optimismStatus),
      "block-production-finality": gate("pass", "Ethereum finality and the documented user escape path prevent one L2 operator from finalizing arbitrary state.", SOURCES.optimismRisk),
      "change-control": gate("pass", "The reviewed rollup is Stage 1 or stronger and exposes a user-enforceable delay and exit path.", SOURCES.optimismRisk),
      "dependency-exit": gate("pass", "The Ethereum, data-availability, bridge, and forced-exit dependencies are documented.", SOURCES.optimismRisk),
    },
  },
  {
    chainSlug: "polygon",
    displayName: "Polygon PoS",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "Production history exceeds 36 months.", SOURCES.polygonHistory),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.polygonStatus),
      "block-production-finality": gate("pass", "Validator participation and stake-backed finality are documented and exceed the member threshold.", SOURCES.polygonValidators),
      "change-control": gate("pass", "Protocol changes use the published multi-party PIP process.", SOURCES.polygonGovernance),
      "dependency-exit": gate("pass", "The PoS validator/checkpoint and native holder transaction paths are documented.", SOURCES.polygonHistory, SOURCES.polygonValidators),
    },
  },
  {
    chainSlug: "solana",
    displayName: "Solana",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "Production history exceeds 36 months.", SOURCES.solanaHistory),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.solanaStatus),
      "block-production-finality": gate("pass", "Validator participation is permissionless and economically secured by stake.", SOURCES.solanaValidators),
      "change-control": gate("pass", "Cluster feature adoption requires validator software and stake participation rather than one instant upgrade key.", SOURCES.solanaClusters),
      "dependency-exit": gate("pass", "Native assets transact and exit on the persistent L1 cluster without an upstream canonical bridge or external DA custodian.", SOURCES.solanaClusters),
    },
  },
  {
    chainSlug: "tron",
    displayName: "TRON",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "Production history exceeds 36 months.", SOURCES.tronHistory),
      liveness: gate("pass", "The public chain record covers the review window and shows no active sunset.", SOURCES.tronStatus),
      "block-production-finality": gate("pass", "Twenty-seven elected Super Representatives produce blocks under stake-backed DPoS.", SOURCES.tronValidators),
      "change-control": gate("pass", "Parameter changes use voted on-chain proposals rather than one instant unilateral key.", SOURCES.tronGovernance),
      "dependency-exit": gate("pass", "Native assets transact and exit on the L1 without an upstream canonical bridge or external DA custodian.", SOURCES.tronHistory),
    },
  },
  {
    chainSlug: "xrpl",
    displayName: "XRP Ledger",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "Production history exceeds 36 months.", SOURCES.xrplHistory),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.xrplStatus),
      "block-production-finality": gate("pass", "The published validator population and default UNL exceed 21 independently operated members.", SOURCES.xrplConsensus),
      "change-control": gate("pass", "Protocol amendments activate through validator voting rather than one instant unilateral key.", SOURCES.xrplAmendments),
      "dependency-exit": gate("pass", "Native assets settle directly on the ledger without an upstream canonical bridge or external DA custodian.", SOURCES.xrplConsensus),
    },
  },
  {
    chainSlug: "cardano",
    displayName: "Cardano",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "Production history exceeds 36 months and the hard-fork history documents ledger continuity.", SOURCES.cardanoHistory),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.cardanoStatus),
      "block-production-finality": gate("pass", "Stake-pool participation is permissionless and economically secured by delegated stake.", SOURCES.cardanoConsensus),
      "change-control": gate("pass", "Constitutional/on-chain governance and hard-fork adoption are multi-party rather than instant and unilateral.", SOURCES.cardanoGovernance, SOURCES.cardanoHistory),
      "dependency-exit": gate("pass", "Native assets transact and exit on the L1 without an upstream canonical bridge or external DA custodian.", SOURCES.cardanoConsensus),
    },
  },
  {
    chainSlug: "gnosis",
    displayName: "Gnosis Chain",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "Production history exceeds 36 months and the documented lineage preserves the ledger.", SOURCES.gnosisHistory),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.gnosisStatus),
      "block-production-finality": gate("pass", "Validator participation is permissionless and economically secured by stake.", SOURCES.gnosisValidators),
      "change-control": gate("pass", "Protocol and treasury decisions use the published multi-party governance process.", SOURCES.gnosisGovernance),
      "dependency-exit": gate("pass", "Canonical bridge routes and the native validator exit path are documented.", SOURCES.gnosisBridge, SOURCES.gnosisValidators),
    },
  },
  {
    chainSlug: "hedera",
    displayName: "Hedera",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "Public production history exceeds 36 months.", SOURCES.hederaJourney),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.hederaStatus),
      "block-production-finality": gate("pass", "Council-operated consensus uses at least 21 separately operated nodes with documented economic and governance accountability.", SOURCES.hederaNodes, SOURCES.hederaConsensus),
      "change-control": gate("pass", "Mainnet upgrades are on-chain transactions signed by a council majority rather than one instant unilateral key.", SOURCES.hederaRelease),
      "dependency-exit": gate("pass", "Native holders transact directly through the council-node ledger without an upstream bridge or DA custodian.", SOURCES.hederaNodes, SOURCES.hederaConsensus),
    },
  },
  {
    chainSlug: "rootstock",
    displayName: "Rootstock",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "The January 2018 production launch exceeds 36 months.", SOURCES.rootstockWhitepaper),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.rootstockStatus),
      "block-production-finality": gate("pass", "Merge-mined proof of work supplies documented economic security.", SOURCES.rootstockWhitepaper),
      "change-control": gate("pass", "Powpeg membership changes have a documented one-week activation delay.", SOURCES.rootstockWhitepaper, SOURCES.rootstockPowpeg),
      "dependency-exit": gate("pass", "The Powpeg threshold, Bitcoin dependency, and holder peg-out path are documented.", SOURCES.rootstockPowpeg, SOURCES.rootstockWhitepaper),
    },
  },
  {
    chainSlug: "sui",
    displayName: "Sui",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "The 2023-05-03 mainnet launch exceeds 36 months at review.", SOURCES.suiLaunch),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.suiStatus),
      "block-production-finality": gate("pass", "The launch record and validator documentation establish more than 21 stake-backed validators.", SOURCES.suiLaunch, SOURCES.suiValidators),
      "change-control": gate("pass", "Protocol upgrades use validator epoch adoption rather than one instant unilateral key.", SOURCES.suiUpgrades),
      "dependency-exit": gate("pass", "Native settlement and the canonical Sui Bridge committee/exit path are documented.", SOURCES.suiBridge, SOURCES.suiValidators),
    },
  },
  {
    chainSlug: "conflux",
    displayName: "Conflux",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "The phased 2020 mainnet launch exceeds 36 months.", SOURCES.confluxLaunch),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.confluxStatus),
      "block-production-finality": gate("pass", "Hybrid permissionless PoW/PoS consensus supplies documented economic security.", SOURCES.confluxProtocol),
      "change-control": gate("pass", "Protocol changes use the published governance process rather than one instant unilateral key.", SOURCES.confluxGovernance),
      "dependency-exit": gate("pass", "Native Core/eSpace settlement and their protocol relationship are documented without an upstream DA custodian.", SOURCES.confluxProtocol),
    },
  },
  {
    chainSlug: "klaytn",
    displayName: "Kaia (formerly Klaytn)",
    admission: "admit",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "Kaia continued the Klaytn ledger at block 162,900,480, so the rebrand/hard fork did not reset production history.", SOURCES.klaytnHistory),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.klaytnStatus),
      "block-production-finality": gate("pass", "The documented BFT governance-council validator set exceeds the 21-member alternative threshold.", SOURCES.klaytnConsensus),
      "change-control": gate("pass", "On-chain governance execution includes a non-modifiable two-day delay.", SOURCES.klaytnGovernance),
      "dependency-exit": gate("pass", "Native settlement and bridge paths are documented without one custodian controlling the L1 ledger exit.", SOURCES.klaytnBridge, SOURCES.klaytnConsensus),
    },
  },
  {
    chainSlug: "celo",
    displayName: "Celo",
    admission: "exclude",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("fail", "The 2025-03-26 L1-to-OP-Stack security-model migration reset the 36-month clock.", SOURCES.celoMigrationDate, SOURCES.celoArchitecture),
      liveness: gate("pass", "The reviewed chain is live and has no active sunset.", SOURCES.celoMigration),
      "block-production-finality": gate("pass", "Ethereum supplies external finality, but that does not cure the failed change-control and exit gates.", SOURCES.celoArchitecture, SOURCES.celoRisk),
      "change-control": gate("fail", "The Stage 0 system has no qualifying user exit window and permits instant Security Council upgrades.", SOURCES.celoRisk),
      "dependency-exit": gate("fail", "The EigenDA and permissioned-proposer design does not leave users a qualifying enforceable escape.", SOURCES.celoArchitecture, SOURCES.celoRisk),
    },
  },
  {
    chainSlug: "sonic",
    displayName: "Sonic",
    admission: "exclude",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("fail", "The 2024-12-18 production launch is under 36 months.", SOURCES.sonicLaunch),
      liveness: gate("pass", "The public incident record covers the available production window with no active sunset.", SOURCES.sonicStatus),
      "block-production-finality": gate("pass", "Stake-backed validator operation is documented.", SOURCES.sonicValidators),
      "change-control": gate("pass", "The published governance process is multi-party.", SOURCES.sonicGovernance),
      "dependency-exit": gate("pass", "Native settlement does not depend on an upstream canonical bridge or DA custodian.", SOURCES.sonicValidators),
    },
  },
  {
    chainSlug: "linea",
    displayName: "Linea",
    admission: "exclude",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "The production launch exceeds 36 months at review.", SOURCES.lineaLaunch),
      liveness: gate("pass", "The public incident record covers the review window with no active sunset.", SOURCES.lineaStatus),
      "block-production-finality": gate("pass", "Ethereum finality is documented, subject to the separately failed holder-escape gate.", SOURCES.lineaRisk),
      "change-control": gate("fail", "Centralized sequencing, immediate-upgrade council power, and censorship-resistant withdrawal remain below the Stage 1 gate.", SOURCES.lineaRoadmap, SOURCES.lineaRisk),
      "dependency-exit": gate("pass", "The Ethereum and rollup dependencies are documented, although change control remains disqualifying.", SOURCES.lineaRisk),
    },
  },
  {
    chainSlug: "berachain",
    displayName: "Berachain",
    admission: "exclude",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("fail", "The February 2025 production launch is under 36 months.", SOURCES.berachainLaunch),
      liveness: gate("pass", "The public incident record covers the available production window with no active sunset.", SOURCES.berachainStatus),
      "block-production-finality": gate("pass", "Stake-backed proof-of-liquidity consensus is documented.", SOURCES.berachainConsensus),
      "change-control": gate("pass", "The published governance process is multi-party.", SOURCES.berachainGovernance),
      "dependency-exit": gate("pass", "Native settlement does not depend on an upstream canonical bridge or DA custodian.", SOURCES.berachainConsensus),
    },
  },
  {
    chainSlug: "movement",
    displayName: "Movement",
    admission: "exclude",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("fail", "The 2025-03-10 public mainnet beta launch is under 36 months.", SOURCES.movementLaunch),
      liveness: gate("pass", "The public incident record covers the available production window with no active sunset.", SOURCES.movementStatus),
      "block-production-finality": gate("pass", "The production architecture documents the current finality model.", SOURCES.movementArchitecture),
      "change-control": gate("fail", "Decentralized shared sequencing remained future work at launch, so the reviewed beta did not meet the mature change-control gate.", SOURCES.movementLaunch, SOURCES.movementArchitecture),
      "dependency-exit": gate("pass", "The current settlement dependencies are documented, subject to the failed continuity and change-control gates.", SOURCES.movementArchitecture),
    },
  },
  {
    chainSlug: "monad",
    displayName: "Monad",
    admission: "exclude",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("fail", "The 2025-11-24 mainnet launch is under 36 months.", SOURCES.monadLaunch),
      liveness: gate("pass", "The public incident record covers the available production window with no active sunset.", SOURCES.monadStatus),
      "block-production-finality": gate("pass", "Stake-backed MonadBFT consensus is documented.", SOURCES.monadConsensus),
      "change-control": gate("pass", "Network upgrades require validator adoption rather than one instant unilateral bridge key.", SOURCES.monadGovernance),
      "dependency-exit": gate("pass", "Native settlement does not depend on an upstream canonical bridge or DA custodian.", SOURCES.monadConsensus),
    },
  },
  {
    chainSlug: "plume",
    displayName: "Plume",
    admission: "exclude",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("fail", "The June 2025 production launch is under 36 months.", SOURCES.plumeLaunch),
      liveness: gate("pass", "The public incident record covers the available production window with no active sunset.", SOURCES.plumeStatus),
      "block-production-finality": gate("pass", "The production architecture documents the current finality model.", SOURCES.plumeArchitecture),
      "change-control": gate("pass", "The reviewed governance path is documented, subject to the failed continuity gate.", SOURCES.plumeArchitecture),
      "dependency-exit": gate("pass", "The canonical bridge and holder transfer path are documented.", SOURCES.plumeBridge),
    },
  },
  {
    chainSlug: "polygon-zkevm",
    displayName: "Polygon zkEVM",
    admission: "exclude",
    reviewedAt: REVIEWED_AT,
    gates: {
      continuity: gate("pass", "The pre-sunset production history exceeded 36 months.", SOURCES.polygonZkevmSunset),
      liveness: gate("fail", "Block production ended on 2026-07-03 and the chain is sunset.", SOURCES.polygonZkevmSunset),
      "block-production-finality": gate("pass", "Historical Ethereum finality is documented, but the chain no longer produces blocks.", SOURCES.polygonZkevmRisk),
      "change-control": gate("pass", "Historical upgrade controls are documented; the active sunset independently excludes the chain.", SOURCES.polygonZkevmRisk),
      "dependency-exit": gate("fail", "Agglayer withdrawals ended with the sunset, so the holder withdrawal path is unavailable.", SOURCES.polygonZkevmSunset),
    },
  },
] as const satisfies readonly ChainMaturityReview[];

function validateChainMaturityReviews(reviews: readonly ChainMaturityReview[]): void {
  const slugs = new Set<string>();
  for (const review of reviews) {
    if (slugs.has(review.chainSlug)) throw new Error(`Duplicate chain-maturity review for ${review.chainSlug}`);
    slugs.add(review.chainSlug);
    if (review.reviewedAt !== CHAIN_MATURITY_ADMISSION_TEST_V1.reviewedAt) {
      throw new Error(`Chain-maturity review date mismatch for ${review.chainSlug}`);
    }
    const gateIds = Object.keys(review.gates).sort();
    const expectedGateIds = [...CHAIN_MATURITY_GATE_IDS].sort();
    if (gateIds.join("|") !== expectedGateIds.join("|")) {
      throw new Error(`Incomplete chain-maturity gate set for ${review.chainSlug}`);
    }
    for (const gateId of CHAIN_MATURITY_GATE_IDS) {
      const reviewedGate = review.gates[gateId];
      if (reviewedGate.sources.length === 0) {
        throw new Error(`Unsourced chain-maturity gate ${review.chainSlug}/${gateId}`);
      }
      for (const evidence of reviewedGate.sources) {
        if (!evidence.url.startsWith("https://")) {
          throw new Error(`Non-HTTPS chain-maturity source for ${review.chainSlug}/${gateId}`);
        }
        if (evidence.documentDate === null && evidence.accessedAt.length === 0) {
          throw new Error(`Undated chain-maturity source lacks an access date for ${review.chainSlug}/${gateId}`);
        }
      }
    }
    const passed = CHAIN_MATURITY_GATE_IDS.every((gateId) => review.gates[gateId].result === "pass");
    if ((review.admission === "admit") !== passed) {
      throw new Error(`Chain-maturity admission contradicts gate results for ${review.chainSlug}`);
    }
  }
}

validateChainMaturityReviews(CHAIN_MATURITY_REVIEWS_V1);

export const CHAIN_MATURITY_ADMITTED_CHAIN_SLUGS = CHAIN_MATURITY_REVIEWS_V1
  .filter((review) => review.admission === "admit")
  .map((review) => review.chainSlug);

export function chainMaturityReviewForSlug(chainSlug: string): ChainMaturityReview | null {
  return CHAIN_MATURITY_REVIEWS_V1.find((review) => review.chainSlug === chainSlug) ?? null;
}

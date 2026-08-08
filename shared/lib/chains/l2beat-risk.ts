export const L2BEAT_CHAIN_RISK_SNAPSHOT_META = {
  source: "https://l2beat.com/api/scaling/summary",
  fetchedAt: "2026-06-12",
  notes:
    "Static Chain Health v1.4 snapshot of L2BEAT scaling summary stage and risk rosette fields. Runtime scoring does not fetch L2BEAT live.",
} as const;

export const L2BEAT_CHAIN_RISK_FIELDS = [
  "sequencerFailure",
  "stateValidation",
  "dataAvailability",
  "exitWindow",
  "proposerFailure",
] as const;

export const L2BEAT_CHAIN_RISK_FIELD_LABELS: Record<L2BeatRiskField, string> = {
  sequencerFailure: "Sequencer Failure",
  stateValidation: "State Validation",
  dataAvailability: "Data Availability",
  exitWindow: "Exit Window",
  proposerFailure: "Proposer Failure",
};

export type L2BeatRiskField = (typeof L2BEAT_CHAIN_RISK_FIELDS)[number];
// "UnderReview"/"neutral" retained for live L2BEAT API ingestion (forward-compat; some snapshots carry them).
export type L2BeatRiskSentiment = "good" | "warning" | "bad" | "UnderReview" | "neutral";
// "Under review" retained for live L2BEAT API ingestion (forward-compat).
export type L2BeatStage = "Stage 0" | "Stage 1" | "Stage 2" | "Not applicable" | "Under review";
export type L2BeatScalingLayer = "layer2" | "layer3";

export interface L2BeatRiskValue {
  value: string;
  sentiment: L2BeatRiskSentiment;
}

export interface L2BeatChainRiskSnapshot {
  slug: string;
  name: string;
  type: L2BeatScalingLayer;
  category: string;
  hostChain: string;
  stage: L2BeatStage;
  isUnderReview: boolean;
  risks: Record<L2BeatRiskField, L2BeatRiskValue>;
}

const r = (value: string, sentiment: L2BeatRiskSentiment): L2BeatRiskValue => ({
  value,
  sentiment,
});

export const L2BEAT_CHAIN_RISK_SNAPSHOT = {
  arbitrum: {
    slug: "arbitrum",
    name: "Arbitrum One",
    type: "layer2",
    category: "Optimistic Rollup",
    hostChain: "Ethereum",
    stage: "Stage 1",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (INT)", "good"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Self propose", "good"),
    },
  },
  base: {
    slug: "base",
    name: "Base Chain",
    type: "layer2",
    category: "Optimistic Rollup",
    hostChain: "Ethereum",
    stage: "Stage 1",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (1R, ZK)", "good"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Self propose", "good"),
    },
  },
  optimism: {
    slug: "op-mainnet",
    name: "OP Mainnet",
    type: "layer2",
    category: "Optimistic Rollup",
    hostChain: "Ethereum",
    stage: "Stage 1",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (INT)", "good"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Self propose", "good"),
    },
  },
  "polygon-pos": {
    slug: "polygon-pos",
    name: "Polygon PoS",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Not applicable",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Decentralized Sequencer Set", "warning"),
      stateValidation: r("None", "bad"),
      dataAvailability: r("PoS network", "warning"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "warning"),
    },
  },
  gnosis: {
    slug: "gnosis",
    name: "Gnosis Chain",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Not applicable",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Decentralized Sequencer Set", "good"),
      stateValidation: r("None", "bad"),
      dataAvailability: r("PoS network", "bad"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  celo: {
    slug: "celo",
    name: "Celo",
    type: "layer2",
    category: "Optimium",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: true,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (1R, ZK)", "warning"),
      dataAvailability: r("External", "warning"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  zksync2: {
    slug: "zksync-era",
    name: "ZKsync Era",
    type: "layer2",
    category: "ZK Rollup",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Enqueue via L1", "warning"),
      stateValidation: r("Validity proofs (ST, SN)", "good"),
      dataAvailability: r("Onchain (SD)", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Replace proposer", "warning"),
    },
  },
  worldchain: {
    slug: "world",
    name: "World Chain",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (INT)", "bad"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  unichain: {
    slug: "unichain",
    name: "Unichain",
    type: "layer2",
    category: "Optimistic Rollup",
    hostChain: "Ethereum",
    stage: "Stage 1",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (INT)", "good"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Self propose", "good"),
    },
  },
  ink: {
    slug: "ink",
    name: "Ink",
    type: "layer2",
    category: "Optimistic Rollup",
    hostChain: "Ethereum",
    stage: "Stage 1",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (INT)", "good"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Self propose", "good"),
    },
  },
  plumenetwork: {
    slug: "plumenetwork",
    name: "Plume Network",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (INT)", "bad"),
      dataAvailability: r("External (DAC)", "bad"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  megaeth: {
    slug: "megaeth",
    name: "MegaETH",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (1R, ZK)", "bad"),
      dataAvailability: r("External", "bad"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  mantle: {
    slug: "mantle",
    name: "Mantle",
    type: "layer2",
    category: "ZK Rollup",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Validity proofs (ST, SN)", "good"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  linea: {
    slug: "linea",
    name: "Linea",
    type: "layer2",
    category: "ZK Rollup",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("No mechanism", "bad"),
      stateValidation: r("Validity proofs (SN)", "good"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  scroll: {
    slug: "scroll",
    name: "Scroll",
    type: "layer2",
    category: "ZK Rollup",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Validity proofs (ST, SN)", "good"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Self propose", "good"),
    },
  },
  blast: {
    slug: "blast",
    name: "Blast",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("None", "bad"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  mode: {
    slug: "mode",
    name: "Mode Network",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (INT)", "bad"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  mantapacific: {
    slug: "mantapacific",
    name: "Manta Pacific",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("None", "bad"),
      dataAvailability: r("External", "bad"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  bob: {
    slug: "bob",
    name: "BOB",
    type: "layer2",
    category: "Optimistic Rollup",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: true,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (1R, ZK)", "good"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Self propose", "good"),
    },
  },
  fraxtal: {
    slug: "fraxtal",
    name: "Fraxtal",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("None", "bad"),
      dataAvailability: r("External", "bad"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  taiko: {
    slug: "taiko",
    name: "Taiko Alethia",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: true,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Multi-proofs", "bad"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Self propose", "good"),
    },
  },
  polygonzkevm: {
    slug: "polygonzkevm",
    name: "Polygon zkEVM",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Not applicable",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("No mechanism", "bad"),
      stateValidation: r("None", "bad"),
      dataAvailability: r("External", "bad"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  bobanetwork: {
    slug: "bobanetwork",
    name: "Boba Network",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: true,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (INT)", "bad"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  soneium: {
    slug: "soneium",
    name: "Soneium",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (INT)", "bad"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  zircuit: {
    slug: "zircuit",
    name: "Zircuit",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("No mechanism", "bad"),
      stateValidation: r("None", "bad"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Use escape hatch", "warning"),
    },
  },
  metis: {
    slug: "metis",
    name: "Metis Andromeda",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("No mechanism", "bad"),
      stateValidation: r("Fraud proofs (INT)", "bad"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Security Council minority", "warning"),
    },
  },
  morph: {
    slug: "morph",
    name: "Morph",
    type: "layer2",
    category: "Optimistic Rollup",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Force via L1", "good"),
      stateValidation: r("Fraud proofs (1R, ZK)", "warning"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Self propose", "good"),
    },
  },
  swell: {
    slug: "swell",
    name: "Swellchain",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (INT)", "bad"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  xlayer: {
    slug: "xlayer",
    name: "X Layer",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Not applicable",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("None", "bad"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  apechain: {
    slug: "apechain",
    name: "ApeChain",
    type: "layer3",
    category: "Other",
    hostChain: "Arbitrum One",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (INT)", "bad"),
      dataAvailability: r("External (DAC)", "bad"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Self propose", "good"),
    },
  },
  abstract: {
    slug: "abstract",
    name: "Abstract",
    type: "layer2",
    category: "ZK Rollup",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Enqueue via L1", "warning"),
      stateValidation: r("Validity proofs (ST, SN)", "good"),
      dataAvailability: r("Onchain (SD)", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Replace proposer", "warning"),
    },
  },
  corn: {
    slug: "corn",
    name: "Corn",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (INT)", "bad"),
      dataAvailability: r("External (DAC)", "bad"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  edgechain: {
    slug: "edgechain",
    name: "Edge Chain",
    type: "layer3",
    category: "Other",
    hostChain: "Arbitrum One",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Fraud proofs (INT)", "bad"),
      dataAvailability: r("External (DAC)", "bad"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Self propose", "good"),
    },
  },
  hemi: {
    slug: "hemi",
    name: "Hemi",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("None", "bad"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  immutablezkevm: {
    slug: "immutablezkevm",
    name: "Immutable zkEVM",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Not applicable",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("No mechanism", "bad"),
      stateValidation: r("None", "bad"),
      dataAvailability: r("External", "bad"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  katana: {
    slug: "katana",
    name: "Katana",
    type: "layer2",
    category: "ZK Rollup",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Self sequence", "good"),
      stateValidation: r("Validity proofs (ST, SN)", "good"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
  sophon: {
    slug: "sophon",
    name: "Sophon",
    type: "layer2",
    category: "Validium",
    hostChain: "Ethereum",
    stage: "Stage 0",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("No mechanism", "bad"),
      stateValidation: r("Validity proofs (ST, SN)", "good"),
      dataAvailability: r("External", "warning"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Replace proposer", "warning"),
    },
  },
  starknet: {
    slug: "starknet",
    name: "Starknet",
    type: "layer2",
    category: "ZK Rollup",
    hostChain: "Ethereum",
    stage: "Stage 1",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("Log via L1", "warning"),
      stateValidation: r("Validity proofs (ST)", "good"),
      dataAvailability: r("Onchain (SD)", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Security Council minority", "warning"),
    },
  },
  fluent: {
    slug: "fluent",
    name: "Fluent",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: "Not applicable",
    isUnderReview: false,
    risks: {
      sequencerFailure: r("No mechanism", "bad"),
      stateValidation: r("TEE attestations", "bad"),
      dataAvailability: r("Onchain", "good"),
      exitWindow: r("None", "bad"),
      proposerFailure: r("Cannot withdraw", "bad"),
    },
  },
} as const satisfies Record<string, L2BeatChainRiskSnapshot>;

export const L2BEAT_CHAIN_ALIASES = {
  arbitrum: "arbitrum",
  base: "base",
  optimism: "optimism",
  polygon: "polygon-pos",
  gnosis: "gnosis",
  celo: "celo",
  zksync: "zksync2",
  worldchain: "worldchain",
  unichain: "unichain",
  ink: "ink",
  plume: "plumenetwork",
  megaeth: "megaeth",
  mantle: "mantle",
  linea: "linea",
  scroll: "scroll",
  blast: "blast",
  mode: "mode",
  manta: "mantapacific",
  bob: "bob",
  fraxtal: "fraxtal",
  taiko: "taiko",
  "polygon-zkevm": "polygonzkevm",
  boba: "bobanetwork",
  soneium: "soneium",
  zircuit: "zircuit",
  metis: "metis",
  "morph-l2": "morph",
  swellchain: "swell",
  xlayer: "xlayer",
  apechain: "apechain",
  abstract: "abstract",
  corn: "corn",
  edgechain: "edgechain",
  hemi: "hemi",
  "immutable-zkevm": "immutablezkevm",
  katana: "katana",
  sophon: "sophon",
  starknet: "starknet",
  fluent: "fluent",
} as const satisfies Partial<Record<string, keyof typeof L2BEAT_CHAIN_RISK_SNAPSHOT>>;

export const L2BEAT_STAGE_SCORES: Record<L2BeatStage, number> = {
  "Stage 2": 100,
  "Stage 1": 80,
  "Stage 0": 55,
  "Not applicable": 50,
  // L2BEAT can publish projects before a stage verdict has settled; keep this neutral.
  "Under review": 50,
};

export const L2BEAT_RISK_SENTIMENT_SCORES: Record<L2BeatRiskSentiment, number> = {
  good: 100,
  warning: 60,
  bad: 20,
  // Forward-compatible L2BEAT ingestion guard: provisional/unknown sentiments are neutral, not bad.
  UnderReview: 50,
  neutral: 50,
};

export const L2BEAT_STAGE_WEIGHT = 0.4;
export const L2BEAT_RISK_WEIGHT = 0.6;

export interface L2BeatChainEnvironmentAssessment {
  source: "l2beat";
  chainId: string;
  projectId: string;
  slug: string;
  name: string;
  stage: L2BeatStage;
  isUnderReview: boolean;
  stageScore: number;
  riskScore: number;
  score: number;
  risks: Record<L2BeatRiskField, L2BeatRiskValue>;
}

export function resolveL2BeatProjectId(chainId: string): keyof typeof L2BEAT_CHAIN_RISK_SNAPSHOT | null {
  if (chainId in L2BEAT_CHAIN_RISK_SNAPSHOT) {
    return chainId as keyof typeof L2BEAT_CHAIN_RISK_SNAPSHOT;
  }
  return (L2BEAT_CHAIN_ALIASES as Partial<Record<string, keyof typeof L2BEAT_CHAIN_RISK_SNAPSHOT>>)[chainId] ?? null;
}

function resolveL2BeatSnapshot(
  chainId: string,
): { projectId: keyof typeof L2BEAT_CHAIN_RISK_SNAPSHOT; snapshot: L2BeatChainRiskSnapshot } | null {
  const projectId = resolveL2BeatProjectId(chainId);
  if (!projectId) return null;
  return { projectId, snapshot: L2BEAT_CHAIN_RISK_SNAPSHOT[projectId] };
}

export function computeL2BeatRiskScore(snapshot: L2BeatChainRiskSnapshot): number {
  const total = L2BEAT_CHAIN_RISK_FIELDS.reduce((sum, field) => {
    return sum + L2BEAT_RISK_SENTIMENT_SCORES[snapshot.risks[field].sentiment];
  }, 0);
  return Math.round(total / L2BEAT_CHAIN_RISK_FIELDS.length);
}

export function computeL2BeatChainEnvironmentScore(snapshot: L2BeatChainRiskSnapshot): number {
  const stageScore = L2BEAT_STAGE_SCORES[snapshot.stage];
  const riskScore = computeL2BeatRiskScore(snapshot);
  return Math.round(stageScore * L2BEAT_STAGE_WEIGHT + riskScore * L2BEAT_RISK_WEIGHT);
}

export function getL2BeatChainEnvironmentAssessment(chainId: string): L2BeatChainEnvironmentAssessment | null {
  const resolved = resolveL2BeatSnapshot(chainId);
  if (!resolved) return null;

  const { projectId, snapshot } = resolved;
  const stageScore = L2BEAT_STAGE_SCORES[snapshot.stage];
  const riskScore = computeL2BeatRiskScore(snapshot);
  const score = computeL2BeatChainEnvironmentScore(snapshot);

  return {
    source: "l2beat",
    chainId,
    projectId,
    slug: snapshot.slug,
    name: snapshot.name,
    stage: snapshot.stage,
    isUnderReview: snapshot.isUnderReview,
    stageScore,
    riskScore,
    score,
    risks: snapshot.risks,
  };
}

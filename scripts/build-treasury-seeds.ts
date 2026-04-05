import { mkdirSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { CHAIN_META, resolveChainId } from "../shared/lib/chains";
import type { TreasurySeed, TreasurySeedExtractionMode } from "../shared/types";

interface TreasurySeedManifestEntry {
  protocolId: string;
  slug: string;
  name: string;
  category: string | null;
  launchEligible: boolean;
  launchPriority?: number;
  adapterFile: string;
  extractionMode?: TreasurySeedExtractionMode;
  notes?: string[];
}

const MANIFEST: TreasurySeedManifestEntry[] = [
  {
    protocolId: "maker",
    slug: "maker",
    name: "Sky / Maker",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 10,
    adapterFile: "maker.js",
  },
  {
    protocolId: "liquity",
    slug: "liquity",
    name: "Liquity Treasury",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 20,
    adapterFile: "liquity-treasury.js",
  },
  {
    protocolId: "frax",
    slug: "frax",
    name: "Frax",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 30,
    adapterFile: "frax.js",
  },
  {
    protocolId: "uniswap",
    slug: "uniswap",
    name: "Uniswap",
    category: "Protocol treasury",
    launchEligible: true,
    launchPriority: 40,
    adapterFile: "uniswap.js",
  },
  {
    protocolId: "curve",
    slug: "curve",
    name: "Curve DAO",
    category: "Protocol treasury",
    launchEligible: true,
    launchPriority: 50,
    adapterFile: "curve.js",
  },
  {
    protocolId: "compound",
    slug: "compound",
    name: "Compound",
    category: "Protocol treasury",
    launchEligible: true,
    launchPriority: 60,
    adapterFile: "compound.js",
  },
  {
    protocolId: "dydx",
    slug: "dydx",
    name: "dYdX",
    category: "Protocol treasury",
    launchEligible: true,
    launchPriority: 70,
    adapterFile: "dydx.js",
  },
  {
    protocolId: "frankencoin",
    slug: "frankencoin",
    name: "Frankencoin",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 80,
    adapterFile: "frankencoin.js",
  },
  {
    protocolId: "euler",
    slug: "euler",
    name: "Euler",
    category: "Protocol treasury",
    launchEligible: true,
    launchPriority: 90,
    adapterFile: "euler.js",
  },
  {
    protocolId: "aura",
    slug: "aura",
    name: "Aura",
    category: "Protocol treasury",
    launchEligible: true,
    launchPriority: 100,
    adapterFile: "aura.js",
  },
  {
    protocolId: "lido",
    slug: "lido",
    name: "Lido DAO",
    category: "Protocol treasury",
    launchEligible: true,
    launchPriority: 110,
    adapterFile: "lido.js",
    notes: ["Non-EVM treasury owners are intentionally excluded from the EVM-first launch set."],
  },
  {
    protocolId: "balancer",
    slug: "balancer",
    name: "Balancer DAO",
    category: "Protocol treasury",
    launchEligible: true,
    launchPriority: 120,
    adapterFile: "balancer.js",
  },
  {
    protocolId: "arbitrum-dao",
    slug: "arbitrum-dao",
    name: "Arbitrum DAO",
    category: "DAO treasury",
    launchEligible: true,
    launchPriority: 130,
    adapterFile: "arbitrum-dao.js",
  },
  {
    protocolId: "aave",
    slug: "aave",
    name: "Aave",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 135,
    adapterFile: "aave.js",
  },
  {
    protocolId: "usual",
    slug: "usual",
    name: "Usual",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 140,
    adapterFile: "usual.js",
  },
  {
    protocolId: "synthetix",
    slug: "synthetix",
    name: "Synthetix",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 150,
    adapterFile: "synthetix.js",
  },
  {
    protocolId: "abracadabra",
    slug: "abracadabra",
    name: "Abracadabra",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 160,
    adapterFile: "abracadabra.js",
  },
  {
    protocolId: "alchemix",
    slug: "alchemix",
    name: "Alchemix",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 170,
    adapterFile: "alchemix.js",
  },
  {
    protocolId: "inverse-finance",
    slug: "inverse-finance",
    name: "Inverse Finance",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 180,
    adapterFile: "inverse.js",
  },
  {
    protocolId: "resupply",
    slug: "resupply",
    name: "Resupply",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 190,
    adapterFile: "resupply.js",
  },
  {
    protocolId: "gyroscope",
    slug: "gyroscope",
    name: "Gyroscope",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 200,
    adapterFile: "gyro.js",
  },
  {
    protocolId: "flying-tulip",
    slug: "flying-tulip",
    name: "Flying Tulip",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 210,
    adapterFile: "flying-tulip.js",
  },
  {
    protocolId: "jupiter",
    slug: "jupiter",
    name: "Jupiter",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 220,
    adapterFile: "jupiter.js",
    notes: ["Solana-native protocol. Adapter may contain only non-EVM addresses, resulting in zero EVM owners."],
  },
  {
    protocolId: "maple",
    slug: "maple",
    name: "Maple",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 230,
    adapterFile: "maple.js",
  },
  {
    protocolId: "metronome",
    slug: "metronome",
    name: "Metronome",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 240,
    adapterFile: "metronome.js",
  },
  {
    protocolId: "unitas",
    slug: "unitas",
    name: "Unitas",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 250,
    adapterFile: "unitas.js",
  },
  {
    protocolId: "alto",
    slug: "alto",
    name: "Alto",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 260,
    adapterFile: "alto.js",
  },
];

const OUTPUT_URL = new URL("../shared/data/treasury-seeds.json", import.meta.url);
const RAW_BASE_URL = "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/treasury";

const EXTRA_CHAIN_ALIASES: Record<string, string | null> = {
  avax: "avalanche",
  xdai: "gnosis",
  polygon_zkevm: "polygon-zkevm",
  arbitrum_nova: null,
};

function createAddressProxy(path = "ADDRESSES"): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === Symbol.toPrimitive) return () => `__${path}__`;
        if (prop === "toString") return () => `__${path}__`;
        return createAddressProxy(`${path}.${String(prop)}`);
      },
    },
  );
}

function mergeExports(values: unknown[]): unknown {
  const merged: Record<string, unknown> = {};
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [key, entry] of Object.entries(value)) {
      if (
        entry
        && typeof entry === "object"
        && !Array.isArray(entry)
        && merged[key]
        && typeof merged[key] === "object"
        && !Array.isArray(merged[key])
      ) {
        merged[key] = {
          ...(merged[key] as Record<string, unknown>),
          ...(entry as Record<string, unknown>),
        };
      } else {
        merged[key] = entry;
      }
    }
  }
  return merged;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function resolveTreasuryChain(rawChain: string): string | null {
  const aliased = EXTRA_CHAIN_ALIASES[rawChain] ?? rawChain;
  if (aliased === null) return null;
  const resolved = resolveChainId(aliased);
  if (!resolved) return null;
  return CHAIN_META[resolved]?.type === "evm" ? resolved : null;
}

function extractAdapterConfig(source: string, adapterFile: string): Record<string, unknown> {
  const sandbox = {
    module: { exports: {} as unknown },
    exports: {} as unknown,
    require: (request: string) => {
      if (request.endsWith("/helper/treasury")) {
        return {
          nullAddress: "0x0000000000000000000000000000000000000000",
          treasuryExports: (config: unknown) => config,
        };
      }
      if (request.endsWith("/helper/coreAssets.json")) {
        return createAddressProxy();
      }
      if (request.endsWith("/helper/karpatkey")) {
        return {
          karpatKeyTvl: async () => ({}),
        };
      }
      if (request.endsWith("/helper/utils")) {
        return {
          mergeExports,
        };
      }
      if (request === "@defillama/sdk") {
        return {
          util: {
            sumChainTvls: (..._fns: unknown[]) => async () => ({}),
          },
        };
      }
      if (request.includes("/fira/")) {
        return {
          addFiraTreasuryPositions: async () => ({}),
        };
      }
      throw new Error(`Unsupported adapter dependency in ${adapterFile}: ${request}`);
    },
  };

  vm.runInNewContext(source, sandbox, {
    filename: adapterFile,
    timeout: 1_000,
  });

  if (!sandbox.module.exports || typeof sandbox.module.exports !== "object") {
    throw new Error(`Adapter ${adapterFile} did not export an object treasury config`);
  }

  return sandbox.module.exports as Record<string, unknown>;
}

async function fetchAdapterSource(adapterFile: string): Promise<string> {
  const response = await fetch(`${RAW_BASE_URL}/${adapterFile}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${adapterFile}: ${response.status}`);
  }
  return response.text();
}

function normalizeSeed(
  manifestEntry: TreasurySeedManifestEntry,
  config: Record<string, unknown>,
): TreasurySeed {
  const notes = new Set(manifestEntry.notes ?? []);
  const owners: TreasurySeed["owners"] = [];
  const chains = new Set<string>();

  for (const [rawChain, rawEntry] of Object.entries(config)) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const normalizedChain = resolveTreasuryChain(rawChain);
    if (!normalizedChain) {
      notes.add(`Skipped unsupported or non-EVM chain "${rawChain}" from ${manifestEntry.adapterFile}.`);
      continue;
    }

    const entry = rawEntry as Record<string, unknown>;
    const chainOwners = [
      ...asStringArray(entry.owners),
      ...asStringArray(entry.owner),
      ...asStringArray(entry.ownTokenOwners),
    ];
    if (chainOwners.length === 0) continue;

    chains.add(normalizedChain);
    for (const address of chainOwners) {
      owners.push({ chain: normalizedChain, address });
    }
  }

  const dedupedOwners = Array.from(
    new Map(owners.map((owner) => [`${owner.chain}:${owner.address.toLowerCase()}`, owner])).values(),
  ).sort((a, b) => a.chain.localeCompare(b.chain) || a.address.localeCompare(b.address));

  return {
    protocolId: manifestEntry.protocolId,
    slug: manifestEntry.slug,
    name: manifestEntry.name,
    category: manifestEntry.category,
    launchEligible: manifestEntry.launchEligible,
    launchPriority: manifestEntry.launchPriority,
    source: "defillama-github",
    adapterFile: manifestEntry.adapterFile,
    extractionMode: manifestEntry.extractionMode ?? "static-seeded",
    chains: [...chains].sort(),
    owners: dedupedOwners,
    notes: notes.size > 0 ? [...notes] : undefined,
  };
}

async function main() {
  const seeds: TreasurySeed[] = [];
  for (const manifestEntry of MANIFEST) {
    const source = await fetchAdapterSource(manifestEntry.adapterFile);
    const config = extractAdapterConfig(source, manifestEntry.adapterFile);
    seeds.push(normalizeSeed(manifestEntry, config));
  }

  const output = [...seeds].sort(
    (a, b) =>
      (a.launchPriority ?? Number.MAX_SAFE_INTEGER) - (b.launchPriority ?? Number.MAX_SAFE_INTEGER)
      || a.name.localeCompare(b.name),
  );

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(new URL("../shared/data/", import.meta.url), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(OUTPUT_URL, `${JSON.stringify(output, null, 2)}\n`);

  const ownerChainTuples = output.reduce((sum, seed) => sum + seed.owners.length, 0);
  const launchOwnerChainTuples = output
    .filter((seed) => seed.launchEligible)
    .reduce((sum, seed) => sum + seed.owners.length, 0);

  console.log(
    `[treasury-seeds] Wrote ${output.length} seeds to ${OUTPUT_URL.pathname} `
      + `(${ownerChainTuples} owner-chain tuples; ${launchOwnerChainTuples} launch tuples)`,
  );
}

main().catch((error) => {
  console.error("[treasury-seeds] Build failed:", error);
  process.exitCode = 1;
});

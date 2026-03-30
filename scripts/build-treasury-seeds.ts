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
    category: "Protocol treasury",
    launchEligible: false,
    adapterFile: "aave.js",
    notes: ["Valid static treasury adapter, but held out of the launch allowlist due to a larger owner-chain surface."],
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

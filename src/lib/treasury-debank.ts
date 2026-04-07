import treasurySeeds from "@shared/data/treasury-seeds.json";

type TreasurySeedOwnerLike = {
  address: string;
  chain: string;
  label?: string;
};

type TreasurySeedLike = {
  slug: string;
  owners?: TreasurySeedOwnerLike[];
};

export type TreasuryDebankProfile = {
  address: string;
  chainLabel: string;
  displayAddress: string;
  href: string;
};

const CHAIN_LABELS: Record<string, string> = {
  arbitrum: "Arbitrum",
  avalanche: "Avalanche",
  base: "Base",
  bsc: "BSC",
  ethereum: "Ethereum",
  fantom: "Fantom",
  gnosis: "Gnosis",
  optimism: "Optimism",
  polygon: "Polygon",
  "polygon-zkevm": "Polygon zkEVM",
  sonic: "Sonic",
};

function formatChainLabel(chain: string): string {
  return CHAIN_LABELS[chain] ?? chain;
}

function shortenAddress(address: string): string {
  if (address.length <= 12) {
    return address;
  }

  return `${address.slice(0, 6)}...${address.slice(-5)}`;
}

function buildTreasuryDebankProfiles(seed: TreasurySeedLike): TreasuryDebankProfile[] {
  const owners = seed.owners ?? [];
  const profilesByAddress = new Map<
    string,
    {
      address: string;
      chains: string[];
      labels: string[];
    }
  >();

  for (const owner of owners) {
    const address = owner.address?.trim();
    if (!address) {
      continue;
    }

    const key = address.toLowerCase();
    const existing = profilesByAddress.get(key);
    const chainLabel = formatChainLabel(owner.chain);
    const ownerLabel = owner.label?.trim();

    if (existing) {
      if (!existing.chains.includes(chainLabel)) {
        existing.chains.push(chainLabel);
      }

      if (ownerLabel && !existing.labels.includes(ownerLabel)) {
        existing.labels.push(ownerLabel);
      }

      continue;
    }

    profilesByAddress.set(key, {
      address,
      chains: chainLabel ? [chainLabel] : [],
      labels: ownerLabel ? [ownerLabel] : [],
    });
  }

  return Array.from(profilesByAddress.values()).map((profile) => ({
    address: profile.address,
    chainLabel:
      profile.labels.join(" / ") ||
      profile.chains.join(" / ") ||
      "Wallet",
    displayAddress: shortenAddress(profile.address),
    href: `https://debank.com/profile/${profile.address}`,
  }));
}

const TREASURY_DEBANK_PROFILES_BY_SLUG = new Map(
  (treasurySeeds as TreasurySeedLike[]).map((seed) => [seed.slug, buildTreasuryDebankProfiles(seed)]),
);

export function getTreasuryDebankProfiles(slug: string): TreasuryDebankProfile[] {
  return TREASURY_DEBANK_PROFILES_BY_SLUG.get(slug) ?? [];
}

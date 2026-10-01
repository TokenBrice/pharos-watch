import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DONOR_KEY_QUALIFYING_STABLECOINS, resolveDonorKeyQualifyingStablecoin } from "../donor-eligibility";
import type { FundingChain } from "../schema";

const COIN_SOURCE_DIR = join(process.cwd(), "shared/data/stablecoins/coins");
const FUNDING_CHAINS: readonly FundingChain[] = ["ethereum", "base", "optimism", "arbitrum", "polygon", "gnosis"];

interface CoinSource {
  id: string;
  contracts?: Array<{ chain: string; address: string }>;
}

/**
 * Catalog contracts on funding chains that the allowlist deliberately leaves
 * out. Owner policy: USDC, USDT, DAI, crvUSD and USDGLO keep every catalog
 * funding-chain contract; the other coins count only on deployments the issuer
 * documents, so a bridged or third-party representation stays excluded here.
 */
const REVIEWED_EXCLUSIONS: Readonly<Record<string, Partial<Record<FundingChain, { address: string; reason: string }>>>> = {
  "eurc-circle": {
    polygon: {
      address: "0x8a037dbca8134ffc72c362e394e35e0cad618f85",
      reason: "EUROC Polygon PoS bridge token; Circle's EURC contract list has no Polygon deployment.",
    },
  },
  "pyusd-paypal": {
    optimism: {
      address: "0xa0c9b923f4551f1ec1a49665943160b18704ce06",
      reason: "PYUSD0 LayerZero representation; not on Paxos's PYUSD mainnet list.",
    },
  },
  "lusd-liquity": {
    polygon: {
      address: "0x23001f892c0c82b79303edc9b9033cd190bb21c7",
      reason: "Polygon PoS bridged LUSD; Liquity's v1 contract list has no Polygon deployment.",
    },
  },
};

function readCoin(id: string): CoinSource | null {
  const path = join(COIN_SOURCE_DIR, `${id}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as CoinSource : null;
}

function fundingChainEntries(coin: CoinSource): Array<[FundingChain, string]> {
  return (coin.contracts ?? [])
    .filter((contract) => (FUNDING_CHAINS as readonly string[]).includes(contract.chain))
    .map((contract) => [contract.chain as FundingChain, contract.address.toLowerCase()]);
}

describe("donor key qualifying stablecoins", () => {
  it("uses unique ledger symbols and labels", () => {
    const symbols = DONOR_KEY_QUALIFYING_STABLECOINS.map((coin) => coin.symbol);
    const labels = DONOR_KEY_QUALIFYING_STABLECOINS.map((coin) => coin.label);
    expect(new Set(symbols).size).toBe(symbols.length);
    expect(new Set(labels).size).toBe(labels.length);
    for (const symbol of symbols) expect(symbol).toBe(symbol.toUpperCase());
  });

  it.each(DONOR_KEY_QUALIFYING_STABLECOINS.map((coin) => [coin.stablecoinId, coin] as const))(
    "%s matches its catalog funding-chain contracts minus reviewed exclusions",
    (stablecoinId, coin) => {
      const catalog = readCoin(stablecoinId);
      expect(catalog, `${stablecoinId} is missing from the catalog`).not.toBeNull();
      const catalogKeys = fundingChainEntries(catalog!).map(([chain, address]) => `${chain}:${address}`);
      const excludedKeys = Object.entries(REVIEWED_EXCLUSIONS[stablecoinId] ?? {}).map(([chain, exclusion]) => {
        expect(exclusion.reason.length).toBeGreaterThan(0);
        return `${chain}:${exclusion.address}`;
      });

      // A stale exclusion (catalog moved or dropped the contract) must be re-reviewed.
      for (const key of excludedKeys) expect(catalogKeys, `${stablecoinId} exclusion ${key}`).toContain(key);

      const allowlistKeys = Object.entries(coin.contracts).map(([chain, address]) => `${chain}:${address}`);
      expect(allowlistKeys.sort()).toEqual(catalogKeys.filter((key) => !excludedKeys.includes(key)).sort());
      for (const address of Object.values(coin.contracts)) expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    },
  );

  it.each(["base", "optimism"] as const)("qualifies issuer-listed RLUSD on %s without granting cross-chain identity", (chain) => {
    const deployment = "0x8d58c0c60b8d6b88fa98b291a646db34d0f98258";
    expect(resolveDonorKeyQualifyingStablecoin(chain, deployment.toUpperCase())?.stablecoinId).toBe("rlusd-ripple");
    expect(resolveDonorKeyQualifyingStablecoin("ethereum", deployment)).toBeNull();
    expect(resolveDonorKeyQualifyingStablecoin(chain, "0x8292bb45bf1ee4d140127049757c2e0ff06317ed")).toBeNull();
  });

  it("never lists a contract that another catalog coin claims on the same chain", () => {
    const allowlisted = new Map<string, string>();
    for (const coin of DONOR_KEY_QUALIFYING_STABLECOINS) {
      for (const [chain, address] of Object.entries(coin.contracts)) {
        allowlisted.set(`${chain}:${address}`, coin.stablecoinId);
      }
    }
    const collisions: string[] = [];
    for (const fileName of readdirSync(COIN_SOURCE_DIR).filter((name) => name.endsWith(".json"))) {
      const coin = JSON.parse(readFileSync(join(COIN_SOURCE_DIR, fileName), "utf8")) as CoinSource;
      for (const [chain, address] of fundingChainEntries(coin)) {
        const owner = allowlisted.get(`${chain}:${address}`);
        if (owner && owner !== coin.id) collisions.push(`${chain}:${address} is ${owner} and ${coin.id}`);
      }
    }
    expect(collisions).toEqual([]);
  });
});

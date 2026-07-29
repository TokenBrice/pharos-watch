import { CHAIN_META } from "./chains";
import type { StablecoinMeta } from "../types";

export type OnchainSupplyContract = NonNullable<StablecoinMeta["contracts"]>[number];

export interface CuratedOnchainSupplyContractConfig {
  chain: string;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  /**
   * Some reviewed native deployments are live with zero supply. Keep this
   * opt-in so ordinary aggregate paths still fail closed on empty reads.
   */
  allowZeroSupply?: boolean;
}

export interface CuratedAggregateOnchainSupplyContract {
  config: CuratedOnchainSupplyContractConfig;
  contract: OnchainSupplyContract;
}

export const ZEPHYR_ZSD_ASSET_ID = "zsd-zephyr-protocol";
export const ZEPHYR_ZYS_ASSET_ID = "zys-zephyr-protocol";

const ZEPHYR_SCANNER_SUPPLY_IDS = new Set([ZEPHYR_ZSD_ASSET_ID, ZEPHYR_ZYS_ASSET_ID]);
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const CURATED_ONCHAIN_SUPPLY_CONTRACTS: Record<string, CuratedOnchainSupplyContractConfig> = {
  // No upstream market row exists for Spark Savings USDC yet, but the Ethereum
  // vault supply plus the guarded protocol-redeem price keeps the asset visible.
  "susdc-spark": { chain: "ethereum" },
};

const CURATED_AGGREGATE_ONCHAIN_SUPPLY_CONTRACTS: Record<
  string,
  readonly CuratedOnchainSupplyContractConfig[]
> = {
  // DefiLlama currently lists these active assets but intermittently reports a
  // zero supply row. Use only verified live deployments and fail closed if any
  // configured chain cannot be read, so this cannot silently undercount.
  "cadd-cad-digital": [{ chain: "ethereum" }, { chain: "base" }],
  // AllUnity lists CHFAU as issuer-native on Ethereum, Polygon, Base, and Tempo.
  // DefiLlama does not list it and CoinGecko exposes no usable market cap, so
  // aggregate the reviewed deployments and allow live zero-supply legs.
  "chfau-allunity": [
    { chain: "ethereum", allowZeroSupply: true },
    { chain: "polygon", allowZeroSupply: true },
    { chain: "base", allowZeroSupply: true },
    { chain: "tempo", allowZeroSupply: true },
  ],
  // CoinGecko only exposes an Ethereum market-cap row for ftUSD and currently
  // leaves it stale; aggregate the verified native Ethereum + Sonic supplies.
  "ftusd-flying-tulip": [{ chain: "ethereum" }, { chain: "sonic" }],
  // apyUSD is issued through a CCIP burn/mint pair on Ethereum and Base.
  // CoinGecko supplies the aggregate NAV market cap but no per-chain split, so
  // read both reviewed deployments and conserve their combined live supply.
  "apyusd-apyx": [{ chain: "ethereum" }, { chain: "base" }],
  // DUSD is a Makina Machine share issued canonically on Ethereum and mirrored
  // to Ink through Wormhole NTT locking. Ethereum totalSupply already includes
  // the tokens escrowed for Ink, so the aggregate path must reallocate rather
  // than sum the two deployments.
  "dusd-dialectic": [
    { chain: "ethereum" },
    { chain: "ink", rpcUrl: "https://rpc-gel.inkonchain.com" },
  ],
  "jpym-mento": [{ chain: "celo" }],
  "zarm-mento": [{ chain: "celo" }],
  "xofm-mento": [{ chain: "celo" }],
  // sUSDS and sDAI are Sky savings NAV wrappers with no DefiLlama market row
  // (llamaId null), so upstream supplies no per-chain breakdown and the
  // CoinGecko intake lanes leave chainCirculating empty. Aggregate the verified
  // native + canonical-bridge deployments (contracts sourced from the coin JSONs)
  // so the V9 supply review reconciles real per-chain rows instead of capping on
  // runtime-bridge-materiality-unavailable.
  "susds-sky": [{ chain: "ethereum" }, { chain: "base" }, { chain: "optimism" }, { chain: "arbitrum" }],
  "sdai-sky": [{ chain: "ethereum" }, { chain: "base" }, { chain: "optimism" }],
  // sUSDe has the same shape (llamaId null, CoinGecko detail provider), but its
  // representations are LayerZero OFTs minted against the Ethereum OFT adapter
  // 0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2, which escrows canonical sUSDe.
  // Ethereum totalSupply() is therefore the conserved global total and every
  // reviewed representation is reallocated out of it. Legs outside
  // buildChainRpcs() carry a verified public endpoint. The TON jetton and the
  // Aptos fungible asset have no supported supply probe, so they stay
  // unconfigured and their balances remain inside the Ethereum bucket rather
  // than failing the whole aggregate closed.
  "susde-ethena": [
    { chain: "ethereum" },
    { chain: "plasma", rpcUrl: "https://rpc.plasma.to" },
    { chain: "linea", rpcUrl: "https://rpc.linea.build", fallbackRpcUrl: "https://linea-rpc.publicnode.com" },
    { chain: "fraxtal", rpcUrl: "https://rpc.frax.com", fallbackRpcUrl: "https://fraxtal.drpc.org" },
    { chain: "hyperevm", rpcUrl: "https://rpc.hyperliquid.xyz/evm" },
    { chain: "berachain", rpcUrl: "https://rpc.berachain.com", fallbackRpcUrl: "https://berachain-rpc.publicnode.com" },
    { chain: "zircuit", rpcUrl: "https://mainnet.zircuit.com" },
    { chain: "metis", rpcUrl: "https://andromeda.metis.io/?owner=1088", fallbackRpcUrl: "https://metis-rpc.publicnode.com" },
    // The X Layer OFT is deployed and reviewed but currently holds no supply.
    { chain: "xlayer", rpcUrl: "https://rpc.xlayer.tech", allowZeroSupply: true },
    { chain: "base" },
    { chain: "bsc" },
    { chain: "morph-l2", rpcUrl: "https://rpc.morphl2.io", fallbackRpcUrl: "https://morph.drpc.org" },
    { chain: "scroll", rpcUrl: "https://rpc.scroll.io", fallbackRpcUrl: "https://scroll-rpc.publicnode.com" },
    { chain: "kava", rpcUrl: "https://evm.kava.io", fallbackRpcUrl: "https://kava-evm-rpc.publicnode.com" },
    { chain: "swellchain", rpcUrl: "https://rpc.ankr.com/swell", fallbackRpcUrl: "https://swell.drpc.org" },
    { chain: "mode", rpcUrl: "https://mainnet.mode.network", fallbackRpcUrl: "https://mode.drpc.org" },
    { chain: "mantle", rpcUrl: "https://rpc.mantle.xyz", fallbackRpcUrl: "https://mantle-rpc.publicnode.com" },
    { chain: "arbitrum" },
    { chain: "manta", rpcUrl: "https://pacific-rpc.manta.network/http", fallbackRpcUrl: "https://manta-pacific.drpc.org" },
    { chain: "blast", rpcUrl: "https://rpc.blast.io", fallbackRpcUrl: "https://blast-rpc.publicnode.com" },
    { chain: "optimism" },
    { chain: "zksync", rpcUrl: "https://mainnet.era.zksync.io", fallbackRpcUrl: "https://zksync.drpc.org" },
    { chain: "avalanche" },
    { chain: "solana" },
  ],
  // wsrUSD is an ERC-4626 NAV wrapper with no DefiLlama pegged-asset row
  // (llamaId null), so the CoinGecko fiat-cg lane leaves chainCirculating empty
  // and the V9 supply review caps on runtime-bridge-materiality-unavailable.
  // Reservoir issues every remote deployment through a LayerZero OFT whose
  // Ethereum peer is the OFT Adapter lockbox
  // 0xbb431abd156b960e5b77cc45c75f107e3991258a, so Ethereum totalSupply already
  // escrows them and the canonical reallocation below applies. Chains absent
  // from the worker RPC registry carry an explicit public endpoint; any
  // unreadable leg fails the whole probe closed.
  "wsrusd-reservoir": [
    { chain: "ethereum" },
    { chain: "base" },
    { chain: "berachain", rpcUrl: "https://rpc.berachain.com" },
    { chain: "sonic", rpcUrl: "https://rpc.soniclabs.com" },
    { chain: "arbitrum" },
    { chain: "bsc" },
    { chain: "avalanche" },
    { chain: "unichain", rpcUrl: "https://mainnet.unichain.org" },
    { chain: "plume", rpcUrl: "https://rpc.plume.org" },
    { chain: "sei", rpcUrl: "https://evm-rpc.sei-apis.com" },
    { chain: "worldchain", rpcUrl: "https://worldchain-mainnet.g.alchemy.com/public" },
    { chain: "katana", rpcUrl: "https://rpc.katana.network" },
    { chain: "hyperevm", rpcUrl: "https://rpc.hyperliquid.xyz/evm" },
    { chain: "linea", rpcUrl: "https://rpc.linea.build" },
    { chain: "monad", rpcUrl: "https://rpc.monad.xyz" },
    { chain: "pharos", rpcUrl: "https://api.zan.top/public/pharos-mainnet" },
    { chain: "solana" },
  ],
  // yUSD is native on Ethereum with LayerZero OFT burn/mint representations on
  // nine chains, so no leg escrows another and the reviewed deployments sum.
  // Verified 2026-07-29: CoinGecko circulating 10,877,090.58638517 is the exact
  // sum of the seven deployments it indexes, and the three it omits (BSC,
  // Avalanche, Plasma) add 35,462.36 more. Sonic, Plume, Katana and Plasma have
  // no chain-registry RPC, so pin reviewed public endpoints; any unreadable leg
  // still fails the whole aggregate closed.
  "yusd-yieldfi": [
    { chain: "ethereum" },
    { chain: "arbitrum" },
    { chain: "base" },
    { chain: "optimism" },
    { chain: "sonic", rpcUrl: "https://rpc.soniclabs.com", fallbackRpcUrl: "https://sonic-rpc.publicnode.com" },
    { chain: "plume", rpcUrl: "https://rpc.plume.org" },
    { chain: "katana", rpcUrl: "https://rpc.katana.network", fallbackRpcUrl: "https://rpc.katanarpc.com" },
    { chain: "bsc" },
    { chain: "avalanche" },
    { chain: "plasma", rpcUrl: "https://rpc.plasma.to", fallbackRpcUrl: "https://plasma.drpc.org" },
  ],
  // savUSD is Avant's Avalanche-native staking vault mirrored by Chainlink CCIP
  // BurnMint pools. Verified 2026-07-29: the Avalanche CCIP LockRelease pool
  // 0x8FcC42c414E29e8e3dBFa1628CF45E8ed80C999D escrows 52,769,640.25 savUSD
  // against 52,761,208.00 minted on the destination chains, so the canonical
  // Avalanche totalSupply already contains them and is reallocated below rather
  // than summed. Katana currently reads exactly zero and BSC/MegaETH hold
  // reviewed dust, so those legs may contribute zero.
  "savusd-avant": [
    { chain: "avalanche" },
    { chain: "ethereum" },
    { chain: "linea", rpcUrl: "https://rpc.linea.build", fallbackRpcUrl: "https://linea-rpc.publicnode.com" },
    { chain: "plasma", rpcUrl: "https://rpc.plasma.to", fallbackRpcUrl: "https://plasma.drpc.org" },
    { chain: "berachain", rpcUrl: "https://rpc.berachain.com", fallbackRpcUrl: "https://berachain-rpc.publicnode.com" },
    { chain: "bsc", allowZeroSupply: true },
    { chain: "monad", rpcUrl: "https://rpc.monad.xyz", fallbackRpcUrl: "https://monad.drpc.org" },
    { chain: "katana", rpcUrl: "https://rpc.katana.network", fallbackRpcUrl: "https://rpc.katanarpc.com", allowZeroSupply: true },
    { chain: "megaeth", rpcUrl: "https://mainnet.megaeth.com/rpc", fallbackRpcUrl: "https://megaeth.drpc.org", allowZeroSupply: true },
    { chain: "sei", rpcUrl: "https://evm-rpc.sei-apis.com", fallbackRpcUrl: "https://sei-evm-rpc.publicnode.com" },
  ],
};

// These canonical-chain totalSupply values already include tokens escrowed for
// the listed lock/mint representations. Reallocate that supply across chains
// instead of adding representation supplies to the canonical total.
export const CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS: Readonly<Record<string, string>> = {
  "dusd-dialectic": "ethereum",
  "susds-sky": "ethereum",
  "sdai-sky": "ethereum",
  "susde-ethena": "ethereum",
  "wsrusd-reservoir": "ethereum",
  "savusd-avant": "avalanche",
};

export function isZephyrScannerSupplyId(id: string): boolean {
  return ZEPHYR_SCANNER_SUPPLY_IDS.has(id);
}

export function supportsOnchainSupplyProbe(contract: OnchainSupplyContract): boolean {
  if (contract.chain === "solana") return contract.address.length > 0;
  return CHAIN_META[contract.chain]?.type === "evm" && EVM_ADDRESS_RE.test(contract.address);
}

export function selectSingleOnchainSupplyProbeContract(meta: StablecoinMeta): OnchainSupplyContract | null {
  const contracts = meta.contracts ?? [];
  if (contracts.length !== 1) return null;
  const [contract] = contracts;
  return contract && supportsOnchainSupplyProbe(contract) ? contract : null;
}

export function selectSupplementalOnchainSupplyProbeContract(meta: StablecoinMeta): OnchainSupplyContract | null {
  const curated = CURATED_ONCHAIN_SUPPLY_CONTRACTS[meta.id];
  if (curated) {
    const contract = meta.contracts?.find((entry) => entry.chain === curated.chain);
    return contract && supportsOnchainSupplyProbe(contract) ? contract : null;
  }

  return selectSingleOnchainSupplyProbeContract(meta);
}

export function selectCuratedAggregateOnchainSupplyProbeContracts(
  meta: StablecoinMeta,
): readonly CuratedAggregateOnchainSupplyContract[] | null {
  const curatedContracts = CURATED_AGGREGATE_ONCHAIN_SUPPLY_CONTRACTS[meta.id];
  if (!curatedContracts || curatedContracts.length === 0) return null;

  const selected: CuratedAggregateOnchainSupplyContract[] = [];
  for (const config of curatedContracts) {
    const contract = meta.contracts?.find((entry) => entry.chain === config.chain);
    if (!contract || !supportsOnchainSupplyProbe(contract)) return null;
    selected.push({ config, contract });
  }

  return selected;
}

export function hasRuntimeOnchainSupplyPath(meta: StablecoinMeta): boolean {
  return (
    isZephyrScannerSupplyId(meta.id) ||
    selectSupplementalOnchainSupplyProbeContract(meta) != null ||
    selectCuratedAggregateOnchainSupplyProbeContracts(meta) != null
  );
}

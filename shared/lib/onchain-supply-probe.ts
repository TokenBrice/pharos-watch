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
// Starknet contract addresses are felts: hex, up to 252 bits, usually written
// zero-padded to 64 nibbles.
const STARKNET_ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;
// ICP canister ids are 10-byte principals in base32-with-CRC text form, i.e.
// four groups of five characters plus a three-character tail. Longer
// self-authenticating (user) principals are deliberately rejected.
// eslint-disable-next-line security/detect-unsafe-regex -- anchored fixed-width principal pattern; finite quantifiers, no backtracking risk.
const ICP_CANISTER_ID_RE = /^[a-z2-7]{5}(-[a-z2-7]{5}){3}-[a-z2-7]{3}$/;

/**
 * Supply-read families the probe lanes can dispatch. EVM and Solana are the
 * original two; Starknet and ICP were added so non-EVM legs can join
 * fail-closed curated aggregates instead of poisoning them.
 */
export type OnchainSupplyProbeFamily = "evm" | "solana" | "starknet" | "icp";

const NON_EVM_PROBE_FAMILY_BY_CHAIN: Readonly<Record<string, OnchainSupplyProbeFamily>> = {
  solana: "solana",
  starknet: "starknet",
  icp: "icp",
};

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
  // ACRDX is a Centrifuge V3 share token bridged burn-and-mint through the
  // source-chain Spoke, so the reviewed deployments sum: Ethereum holds only
  // 378,869.49 of 42.6M shares and is structurally incapable of escrowing the
  // others. Verified 2026-07-29: Ethereum 378,869.49 + Plume 32,320,262.97 +
  // Monad 9,837,361.46 + Optimism 97,931.995 + Base 0 + Solana 0 =
  // 42,634,425.93, a -14.95% restatement of CoinGecko's 50,014,229.92, which has
  // been frozen at a constant share count for 30 days and reconciles to no
  // on-chain combination (ftUSD/CHFAU stale-upstream precedent; owner-ratified
  // 2026-07-29). Base and the Solana mint are reviewed live deployments that
  // currently read exactly zero.
  "acrdx-anemoy-apollo": [
    { chain: "ethereum" },
    { chain: "plume", rpcUrl: "https://rpc.plume.org", fallbackRpcUrl: "https://plume.drpc.org" },
    { chain: "monad", rpcUrl: "https://rpc.monad.xyz", fallbackRpcUrl: "https://rpc-mainnet.monadinfra.com" },
    { chain: "optimism" },
    { chain: "base", allowZeroSupply: true },
    { chain: "solana", allowZeroSupply: true },
  ],
  // GLDT is native on the Internet Computer and reaches Ethereum, Base and
  // Arbitrum through Omnity's ICP-custody lock/mint bridge, so the ICP ledger
  // total already contains the EVM float and is reallocated rather than summed.
  // Verified 2026-07-29: icrc1_total_supply 594,500.00000000 (the ic0.app
  // replica query and the DFINITY ICRC REST indexer agree to the unit, and
  // CoinGecko publishes exactly that figure) against Base 5,345.40392636 +
  // Ethereum 7.64444464 + Arbitrum 0, so every bridge leg is far below the 10%
  // deployment floor.
  "gldt-gold-dao": [
    { chain: "icp" },
    { chain: "ethereum" },
    { chain: "base" },
    { chain: "arbitrum", allowZeroSupply: true },
  ],
  // mRe7YIELD is Ethereum-native with independent Midas burn/mint deployments on
  // Etherlink and Starknet, so the reviewed legs sum. Verified 2026-07-29:
  // Ethereum 6,792,507.39 + Etherlink 1,041,331.43 + Starknet 175,676.21.
  // Etherlink is 13.00% of that total, above the 10% deployment floor, so this
  // aggregate publishes a genuine material bridge leg instead of a cap. Known
  // gap: CoinGecko also indexes a TAC deployment
  // (0x0a72ed3c34352ab2dd912b30f2252638c873d6f0, symbol mRe7YIELD, 630,603.35
  // read 2026-07-29) that Pharos neither tracks nor reviews; TAC has no chain
  // registry entry, so that leg stays outside this aggregate and Etherlink
  // publishes at 13.00% rather than its true 12.05%.
  "mre7yield-midas": [
    { chain: "ethereum" },
    { chain: "etherlink", rpcUrl: "https://node.mainnet.etherlink.com" },
    { chain: "starknet" },
  ],
  // sUSN is Ethereum-native with Noon-operated Hyperlane warp representations on
  // zkSync, Sophon and Starknet. Verified 2026-07-29: a 200-holder sweep that
  // accounts for the entire Ethereum supply finds no warp-collateral escrow
  // holding the 2,027,155 remote total, so the legs sum rather than reallocate.
  // Ethereum 23,976,706.12 + Starknet 1,904,518.96 + zkSync 120,966.89 + Sophon
  // 1,669.17. Same known gap as mRe7YIELD: an untracked TAC deployment
  // (0x5ced7f73b76a555ccb372cc0f0137bec5665f81e, 161,475.02 sUSN) is 0.62% of
  // the true total and stays outside this aggregate.
  "susn-noon": [
    { chain: "ethereum" },
    { chain: "zksync", rpcUrl: "https://mainnet.era.zksync.io", fallbackRpcUrl: "https://zksync.drpc.org" },
    { chain: "sophon", rpcUrl: "https://rpc.sophon.xyz" },
    { chain: "starknet" },
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
  // cUSDO runs an independent ERC-4626 wrapper on each chain over that chain's
  // own USDO, so nothing escrows anything. Verified 2026-07-29: every remote
  // vault's asset() is the local USDO and its totalAssets() equals its own USDO
  // balance, Ethereum cUSDO balanceOf(self) is 0, and CoinGecko's circulating
  // supply reproduces the Ethereum+Base+BSC sum exactly. The Solana mint adds
  // 817,113.90 cUSDO (+5.3%) that CoinGecko never indexes.
  "cusdo-openeden": [{ chain: "ethereum" }, { chain: "base" }, { chain: "bsc" }, { chain: "solana" }],
  // sUSDai is an Arbitrum-native ERC-4626 vault carried to Ethereum, Base and
  // Plasma as LayerZero OFT satellites. Verified 2026-07-29: the OAdapter
  // 0xffb20098fd7b8e84762eea4609f299d101427f24 holds zero sUSDai on every chain
  // (it burns rather than escrows), and the Arbitrum vault's totalAssets() only
  // reconciles to the quoted NAV against GLOBAL shares, so the four legs sum.
  "susdai-usd-ai": [
    { chain: "arbitrum" },
    { chain: "ethereum" },
    { chain: "base" },
    { chain: "plasma", rpcUrl: "https://rpc.plasma.to", fallbackRpcUrl: "https://plasma.drpc.org" },
  ],
  // sYUSD stakes each chain's own YUSD in a local ERC-4626 vault. Verified
  // 2026-07-29: the BSC vault's asset() is BSC YUSD and its totalAssets()
  // equals its own YUSD balance, so it is locally backed rather than escrowed
  // against Ethereum. BSC holds 0.0094% of supply, so allow it to read zero.
  "syusd-aegis": [{ chain: "ethereum" }, { chain: "bsc", allowZeroSupply: true }],
  // USDK and XO are single-deployment Solana assets that already resolve
  // through the single-contract probe. They are configured here only so the
  // aggregate lane publishes a per-chain row: the reviewed M0 Portal lock/mint
  // escrows the underlying $M, never USDK or XO, so the mint totalSupply is the
  // whole global supply and the published aggregate is unchanged.
  "usdk-kast": [{ chain: "solana" }],
  "xo-exodus": [{ chain: "solana" }],
  // IAUon and SLVon are Ondo tokenized-commodity shares with no canonical-chain
  // escrow: verified 2026-07-29 that the Ethereum holder set contains no bridge
  // or adapter contract near the remote supplies, and CoinGecko's total supply
  // is the exact four-chain sum for IAUon. The HyperEVM legs are reviewed live
  // deployments holding zero (IAUon) and dust (SLVon), so they may read zero.
  "iauon-ondo": [
    { chain: "ethereum" },
    { chain: "bsc" },
    { chain: "solana" },
    { chain: "hyperevm", rpcUrl: "https://rpc.hyperliquid.xyz/evm", fallbackRpcUrl: "https://rpc.hypurrscan.io", allowZeroSupply: true },
  ],
  "slvon-ondo": [
    { chain: "ethereum" },
    { chain: "bsc" },
    { chain: "solana" },
    { chain: "hyperevm", rpcUrl: "https://rpc.hyperliquid.xyz/evm", fallbackRpcUrl: "https://rpc.hypurrscan.io", allowZeroSupply: true },
  ],
  // mHYPER's four deployments are independent EIP-1967 proxies with different
  // implementations and no shared adapter. Verified 2026-07-29: the only
  // Ethereum holder near the 570,380.39 remote sum is Midas' own
  // MHyperRedemptionVaultWithSwapper (592,828.73), a redemption buffer rather
  // than a bridge lockbox, so the reviewed deployments sum. Katana holds dust.
  "mhyper-midas": [
    { chain: "ethereum" },
    { chain: "monad", rpcUrl: "https://rpc.monad.xyz", fallbackRpcUrl: "https://rpc-mainnet.monadinfra.com" },
    { chain: "plasma", rpcUrl: "https://rpc.plasma.to", fallbackRpcUrl: "https://plasma.drpc.org" },
    { chain: "katana", rpcUrl: "https://rpc.katana.network", fallbackRpcUrl: "https://rpc.katanarpc.com", allowZeroSupply: true },
  ],
  // sDOLA's four remote deployments share byte-identical owner-minted ERC-20
  // bytecode with no token()/l1Token()/bridge() surface and no Ethereum escrow,
  // so they sum. Every one of them carries deployment seed dust (Base 0.0212,
  // the rest wei-level), so all four legs must tolerate a zero read.
  "sdola-inverse-finance": [
    { chain: "ethereum" },
    { chain: "base", allowZeroSupply: true },
    { chain: "optimism", allowZeroSupply: true },
    { chain: "arbitrum", allowZeroSupply: true },
    { chain: "berachain", rpcUrl: "https://rpc.berachain.com", fallbackRpcUrl: "https://berachain-rpc.publicnode.com", allowZeroSupply: true },
  ],
  // thBILL is a LayerZero OFT mesh whose Ethereum leg is the MyOFTAdapter
  // lockbox 0xfDD22Ce6D1F66bc0Ec89b20BF16CcB6670F55A5a. Verified 2026-07-29:
  // it escrows 37,999,100.42 thBILL against 37,998,884.22 minted on Arbitrum,
  // Base, HyperEVM and Stable, so Ethereum totalSupply() is the conserved
  // global total and is reallocated below. The Stable-chain representation is
  // now a tracked deployment (chainId 988, 35,612,981.743756 thBILL read
  // 2026-07-29 on two independent endpoints), so it reallocates out of the
  // Ethereum bucket and the per-chain split is finally true.
  "thbill-theo": [
    { chain: "ethereum" },
    { chain: "arbitrum" },
    { chain: "base", allowZeroSupply: true },
    { chain: "hyperevm", rpcUrl: "https://rpc.hyperliquid.xyz/evm", fallbackRpcUrl: "https://rpc.hypurrscan.io" },
    { chain: "stable", rpcUrl: "https://rpc.stable.xyz", fallbackRpcUrl: "https://stable.drpc.org" },
  ],
  // wiTRY's Ethereum escrow 0x698b7518711bDe4832fDc19F5262DF705c713006 holds
  // 346,349,590.501584 wiTRY, bit-for-bit the MegaETH totalSupply(), so 94% of
  // the Ethereum total is really MegaETH float and must be reallocated. The
  // published aggregate is unchanged; only the per-chain split moves.
  "witry-brix": [
    { chain: "ethereum" },
    { chain: "megaeth", rpcUrl: "https://mainnet.megaeth.com/rpc", fallbackRpcUrl: "https://megaeth.drpc.org" },
  ],
  // KRWQ's five spokes are self-referencing LayerZero OFTs that all resolve
  // peers(30101) to the Ethereum OFT Adapter 0xbdc82654f3574a113cdbd62f39cbe02e5b522d57
  // (approvalRequired() === true). Verified 2026-07-29: that adapter escrows
  // 790,548,884.86 KRWQ against a 790,537,884.86 spoke total, so summing would
  // double count. Note: this drops the published supply from CoinGecko's
  // Ethereum+Base double count to the conserved 1,069,438,010.15 KRWQ. The
  // Codex leg is a 5 KRWQ seed mint, so allow it to read zero.
  "krwq-iq": [
    { chain: "ethereum" },
    { chain: "base" },
    { chain: "polygon" },
    { chain: "fraxtal", rpcUrl: "https://rpc.frax.com", fallbackRpcUrl: "https://fraxtal.drpc.org" },
    { chain: "codex", rpcUrl: "https://rpc.codex.xyz", fallbackRpcUrl: "https://81224.rpc.thirdweb.com", allowZeroSupply: true },
    { chain: "morph-l2", rpcUrl: "https://rpc.morphl2.io", fallbackRpcUrl: "https://morph.drpc.org" },
  ],
  // syrupUSDT is an Ethereum ERC-4626 vault mirrored by Chainlink CCIP BurnMint
  // spokes. Verified 2026-07-29: the Ethereum LockReleaseTokenPool
  // 0xDE76A096C5eadDdf97Af3fE15ee49d32AEDa9822 escrows 280,871,803.77
  // syrupUSDT against a 280,871,803.67 spoke total, and the vault's 406.1M USDT
  // only reconciles to the quoted 1.14 NAV against Ethereum shares alone, so
  // the canonical total is reallocated rather than summed.
  "syrupusdt-maple": [
    { chain: "ethereum" },
    { chain: "plasma", rpcUrl: "https://rpc.plasma.to", fallbackRpcUrl: "https://plasma.drpc.org" },
    { chain: "bsc" },
    { chain: "mantle", rpcUrl: "https://rpc.mantle.xyz", fallbackRpcUrl: "https://mantle-rpc.publicnode.com" },
    { chain: "ink", rpcUrl: "https://rpc-gel.inkonchain.com", fallbackRpcUrl: "https://ink.drpc.org" },
  ],
  // srUSD has the same Reservoir shape as wsrUSD but a different adapter:
  // 0x316cd39632Cac4F4CdfC21757c4500FE12f64514 (SrusdOftAdapter). Verified
  // 2026-07-29: it escrows 6,882.636512 srUSD, exactly the Berachain
  // totalSupply(), so Ethereum is the conserved total and is reallocated.
  "srusd-reservoir": [
    { chain: "ethereum" },
    { chain: "berachain", rpcUrl: "https://rpc.berachain.com", fallbackRpcUrl: "https://berachain-rpc.publicnode.com" },
  ],
  // PGOLD is issuer-native on Arbitrum, which is the conserved global total:
  // its Chainlink CCIP LockRelease pool 0x5b5CE779709360A6B6906b79CAc5029A5B7CCdc4
  // escrows exactly the Ethereum + Pharos burn/mint supply (1,110.0 verified
  // 2026-07-29), and the LayerZero OFTAdapter 0xbfd47e6098017c04957ba218dade65e23f661793
  // escrows the ApeChain OFT representation. Reallocate rather than sum.
  // ApeChain and Pharos are absent from buildChainRpcs(), so pin reviewed
  // public endpoints; any unreadable leg still fails the aggregate closed.
  "pgold-pleasing": [
    { chain: "arbitrum" },
    { chain: "ethereum" },
    { chain: "apechain", rpcUrl: "https://rpc.apechain.com/http", fallbackRpcUrl: "https://apechain.calderachain.xyz/http" },
    { chain: "pharos", rpcUrl: "https://api.zan.top/public/pharos-mainnet", fallbackRpcUrl: "https://pharos.drpc.org" },
  ],
};

// These canonical-chain totalSupply values already include tokens escrowed for
// the listed lock/mint representations. Reallocate that supply across chains
// instead of adding representation supplies to the canonical total.
export const CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS: Readonly<Record<string, string>> = {
  "dusd-dialectic": "ethereum",
  "gldt-gold-dao": "icp",
  "susds-sky": "ethereum",
  "sdai-sky": "ethereum",
  "susde-ethena": "ethereum",
  "wsrusd-reservoir": "ethereum",
  "savusd-avant": "avalanche",
  "thbill-theo": "ethereum",
  "witry-brix": "ethereum",
  "krwq-iq": "ethereum",
  "syrupusdt-maple": "ethereum",
  "srusd-reservoir": "ethereum",
  "pgold-pleasing": "arbitrum",
};

export interface CuratedAggregateEscrowResidualConfig {
  /** Canonical-chain lockbox that escrows every representation's supply. */
  escrowAddress: string;
  /**
   * Deliberately non-canonical `chainCirculating` label for escrowed supply
   * that no configured representation leg claims. `resolveChainId()` must
   * return null for it so V9 pools it under the unmatched-chain-label route
   * instead of silently crediting it to the canonical chain.
   */
  unattributedChainLabel: string;
}

/**
 * Canonical-chain escrow reads that split a reallocating aggregate's canonical
 * row into free float and an explicit unattributed remainder. Without this the
 * remainder (untracked representations plus any escrow that matches no route)
 * hides inside the canonical chain's published supply and grows unobserved.
 */
export const CURATED_AGGREGATE_ESCROW_RESIDUALS: Readonly<
  Record<string, CuratedAggregateEscrowResidualConfig>
> = {
  // The Ethereum OFT Adapter escrows every sUSDe representation, including the
  // TON jetton and Aptos fungible asset that have no supply probe. Verified
  // 2026-07-29 against canonical Ethereum totalSupply 1,240,195,620.187629:
  // TON 2,397,958.18 (0.1934%) + Aptos 1,074,420.00 (0.0866%) + 13,587,459.52
  // of escrow matching no reviewed route (1.0956%) were all being published as
  // Ethereum float while the TON and Aptos controls reported a hard 0 share.
  "susde-ethena": {
    escrowAddress: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2",
    unattributedChainLabel: "sUSDe unattributed OFT escrow",
  },
};

export function isZephyrScannerSupplyId(id: string): boolean {
  return ZEPHYR_SCANNER_SUPPLY_IDS.has(id);
}

/**
 * Resolve which supply reader can read a tracked deployment, or null when no
 * reader exists for that chain family or the address shape is wrong.
 */
export function onchainSupplyProbeFamily(contract: OnchainSupplyContract): OnchainSupplyProbeFamily | null {
  switch (NON_EVM_PROBE_FAMILY_BY_CHAIN[contract.chain]) {
    case "solana":
      return contract.address.length > 0 ? "solana" : null;
    case "starknet":
      return STARKNET_ADDRESS_RE.test(contract.address) ? "starknet" : null;
    case "icp":
      return ICP_CANISTER_ID_RE.test(contract.address) ? "icp" : null;
    default:
      break;
  }

  return CHAIN_META[contract.chain]?.type === "evm" && EVM_ADDRESS_RE.test(contract.address) ? "evm" : null;
}

export function supportsOnchainSupplyProbe(contract: OnchainSupplyContract): boolean {
  return onchainSupplyProbeFamily(contract) !== null;
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

// Data-only endpoint authority. Keep consumer profiles separate: consolidation must
// not add providers or change the order of an existing resolved route.
/** Reviewed public Aptos-framework REST endpoint for fungible-asset reads. */
export const APTOS_PUBLIC_REST_URL = "https://api.mainnet.aptoslabs.com/v1";

export const PUBLIC_RPC_URLS: Readonly<Record<string, string>> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  base: "https://mainnet.base.org",
  optimism: "https://mainnet.optimism.io",
  // polygon-rpc.com was verified returning well-formed but zero-valued
  // eth_call results on 2026-07-09 (silent bad data, worse than an error);
  // publicnode returned correct values in the same probes.
  polygon: "https://polygon-bor-rpc.publicnode.com",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
  bsc: "https://bsc-dataseed.binance.org",
  gnosis: "https://rpc.gnosischain.com",
  // rpc.ftm.tools now requires a key; this public endpoint is listed by Fantom.
  fantom: "https://fantom.drpc.org",
  sonic: "https://rpc.soniclabs.com",
  celo: "https://forno.celo.org",
  tron: "https://api.trongrid.io",
  blast: "https://rpc.blast.io",
  manta: "https://pacific-rpc.manta.network/http",
  // Plasma Finance L2 — only public RPC; required for syzusd-yuzu ERC-4626 NAV fetch
  plasma: "https://rpc.plasma.to",
  // Required for usdnr-nerona's m0-wrapper-underlying additional-deployment aggregation
  fluent: "https://rpc.fluent.xyz",
  // Required for reviewed CHFAU native supply aggregation.
  tempo: "https://rpc.tempo.xyz",
  // Reviewed synchronous ERC-4626 simulation; exact hash-bound override supported.
  robinhood: "https://rpc.mainnet.chain.robinhood.com",
  movement: "https://mainnet.movementnetwork.xyz/v1",
  aptos: APTOS_PUBLIC_REST_URL,
  // Required for usd1-bundle-oracle multichain totalSupply() supply aggregation.
  plume: "https://rpc.plume.org",
  monad: "https://rpc.monad.xyz",
  mantle: "https://rpc.mantle.xyz",
  "morph-l2": "https://rpc.morphl2.io",
  abcore: "https://rpc.core.ab.org",
  xlayer: "https://rpc.xlayer.tech",
  etherlink: "https://node.mainnet.etherlink.com",
  // Hedera's public read surface is the mirror node REST API (contracts/call
  // for EVM-equivalent view calls, blocks, tokens) — not a JSON-RPC endpoint.
  // Consumed by the hliquity-hedera reserve adapter family.
  hedera: "https://mainnet-public.mirrornode.hedera.com/api/v1",
  // Cardano's public query surface is the Koios REST API (tip, address_info,
  // asset_info) — not a JSON-RPC endpoint. Consumed by the djed-cardano
  // reserve adapter through the koios.ts bounded reader.
  cardano: "https://api.koios.rest/api/v1",
  // Tezos's public query surface is the TzKT indexer REST API (head, contract
  // storage, bigmap keys at a pinned level) — not a JSON-RPC endpoint.
  // Consumed by the youves-tezos reserve adapter through the tzkt.ts bounded
  // reader.
  tezos: "https://api.tzkt.io",
  // Arc (Circle's L1) — required by the Dwellir provider-parity observation
  // lane, which reads the chain's first registry operator as its baseline.
  arc: "https://rpc.mainnet.arc.io",
  // Hemi — required by vcred-vcred's reviewed on-chain circulating-supply probe
  // (its only tracked deployment). Same reviewed public endpoint as the coin's
  // liveReservesConfig; dRPC serves as an independent second operator below.
  hemi: "https://rpc.hemi.network/rpc",
};

export const EXTRA_FALLBACK_RPC_URLS: Readonly<Record<string, readonly string[]>> = {
  ethereum: ["https://eth.llamarpc.com"],
  base: ["https://base-rpc.publicnode.com"],
  optimism: ["https://optimism-rpc.publicnode.com"],
  blast: ["https://blast.blockpi.network/v1/rpc/public"],
  manta: ["https://manta-pacific.drpc.org"],
  sonic: ["https://sonic-rpc.publicnode.com"],
  // dRPC as an independent second operator behind publicnode; polygon-rpc.com
  // is deliberately absent (it served zero-valued eth_call results 2026-07-09).
  polygon: ["https://polygon.drpc.org"],
  // dRPC as an independent second operator behind rpc.mainnet.arc.io.
  arc: ["https://arc.drpc.org"],
  // dRPC as an independent second operator behind rpc.hemi.network; verified
  // 2026-09-24 returning the same VCRED totalSupply and Safe balanceOf reads.
  hemi: ["https://hemi.drpc.org"],
};

// Reviewed supply profile. These fallbacks intentionally differ from the Worker
// profile (notably Monad and Blast); neither profile implicitly expands the other.
export const SUPPLY_RPC_DEFAULTS = {
  "aptos": { rpcUrl: APTOS_PUBLIC_REST_URL },
  // 0G mainnet (16661 / 0x4115), eth_chainId and PYUSDx totalSupply verified
  // 2026-10-03. Supply-only guard profile; 0G is not a registered product chain.
  "0g": { rpcUrl: "https://evmrpc.0g.ai" },
  "plume": { rpcUrl: PUBLIC_RPC_URLS["plume"], fallbackRpcUrl: "https://plume.drpc.org" },
  "plasma": { rpcUrl: PUBLIC_RPC_URLS["plasma"], fallbackRpcUrl: "https://plasma.drpc.org" },
  "monad": { rpcUrl: PUBLIC_RPC_URLS["monad"], fallbackRpcUrl: "https://rpc-mainnet.monadinfra.com" },
  "etherlink": { rpcUrl: PUBLIC_RPC_URLS["etherlink"] },
  "berachain": { rpcUrl: "https://rpc.berachain.com", fallbackRpcUrl: "https://berachain-rpc.publicnode.com" },
  "linea": { rpcUrl: "https://rpc.linea.build", fallbackRpcUrl: "https://linea-rpc.publicnode.com" },
  "katana": { rpcUrl: "https://rpc.katana.network", fallbackRpcUrl: "https://rpc.katanarpc.com" },
  "fraxtal": { rpcUrl: "https://rpc.frax.com", fallbackRpcUrl: "https://fraxtal.drpc.org" },
  "hyperevm": { rpcUrl: "https://rpc.hyperliquid.xyz/evm", fallbackRpcUrl: "https://rpc.hypurrscan.io" },
  "ink": { rpcUrl: "https://rpc-gel.inkonchain.com", fallbackRpcUrl: "https://ink.drpc.org" },
  "tac": { rpcUrl: "https://rpc.tac.build" },
  "zksync": { rpcUrl: "https://mainnet.era.zksync.io", fallbackRpcUrl: "https://zksync.drpc.org" },
  "sophon": { rpcUrl: "https://rpc.sophon.xyz" },
  "zircuit": { rpcUrl: "https://mainnet.zircuit.com" },
  "metis": { rpcUrl: "https://andromeda.metis.io/?owner=1088", fallbackRpcUrl: "https://metis-rpc.publicnode.com" },
  "xlayer": { rpcUrl: PUBLIC_RPC_URLS["xlayer"] },
  "morph-l2": { rpcUrl: PUBLIC_RPC_URLS["morph-l2"], fallbackRpcUrl: "https://morph.drpc.org" },
  "scroll": { rpcUrl: "https://rpc.scroll.io", fallbackRpcUrl: "https://scroll-rpc.publicnode.com" },
  "kava": { rpcUrl: "https://evm.kava.io", fallbackRpcUrl: "https://kava-evm-rpc.publicnode.com" },
  "swellchain": { rpcUrl: "https://rpc.ankr.com/swell", fallbackRpcUrl: "https://swell.drpc.org" },
  "mode": { rpcUrl: "https://mainnet.mode.network", fallbackRpcUrl: "https://mode.drpc.org" },
  "mantle": { rpcUrl: PUBLIC_RPC_URLS["mantle"], fallbackRpcUrl: "https://mantle-rpc.publicnode.com" },
  "manta": { rpcUrl: PUBLIC_RPC_URLS["manta"], fallbackRpcUrl: EXTRA_FALLBACK_RPC_URLS["manta"][0] },
  "blast": { rpcUrl: PUBLIC_RPC_URLS["blast"], fallbackRpcUrl: "https://blast-rpc.publicnode.com" },
  "sonic": { rpcUrl: PUBLIC_RPC_URLS["sonic"], fallbackRpcUrl: EXTRA_FALLBACK_RPC_URLS["sonic"][0] },
  "unichain": { rpcUrl: "https://mainnet.unichain.org" },
  "sei": { rpcUrl: "https://evm-rpc.sei-apis.com", fallbackRpcUrl: "https://sei-evm-rpc.publicnode.com" },
  "worldchain": { rpcUrl: "https://worldchain-mainnet.g.alchemy.com/public" },
  "pharos": { rpcUrl: "https://api.zan.top/public/pharos-mainnet", fallbackRpcUrl: "https://pharos.drpc.org" },
  "megaeth": { rpcUrl: "https://mainnet.megaeth.com/rpc", fallbackRpcUrl: "https://megaeth.drpc.org" },
  "klaytn": { rpcUrl: "https://public-en.node.kaia.io" },
  "stable": { rpcUrl: "https://rpc.stable.xyz", fallbackRpcUrl: "https://stable.drpc.org" },
  "codex": { rpcUrl: "https://rpc.codex.xyz", fallbackRpcUrl: "https://81224.rpc.thirdweb.com" },
  "robinhood": { rpcUrl: PUBLIC_RPC_URLS["robinhood"] },
  "tempo": { rpcUrl: PUBLIC_RPC_URLS["tempo"] },
  // Official keyless endpoints, eth_chainId/totalSupply/decimals verified
  // 2026-10-03. Keep these latest-state supply profiles out of PUBLIC_RPC_URLS:
  // Worker registry and transfer-materiality fallback readers currently treat
  // that map's endpoints as archive-capable, which was not verified here.
  "rise": { rpcUrl: "https://rpc.risechain.com" },
  "somnia": { rpcUrl: "https://api.infra.mainnet.somnia.network" },
  "filecoin": { rpcUrl: "https://api.node.glif.io/rpc/v1" },
  "apechain": { rpcUrl: "https://rpc.apechain.com/http", fallbackRpcUrl: "https://apechain.calderachain.xyz/http" },
  "rootstock": { rpcUrl: "https://public-node.rsk.co" },
  "conflux": { rpcUrl: "https://evm.confluxrpc.com", fallbackRpcUrl: "https://evm.confluxrpc.org" },
  "harmony": { rpcUrl: "https://api.harmony.one", fallbackRpcUrl: "https://api.s0.t.hmny.io" },
} as const;

// V9 reviewed Centrifuge reads use rpc1, not the supply profile's monadinfra.
export const SUPPLY_ATTRIBUTION_RPC_URLS = {
  plume: [PUBLIC_RPC_URLS.plume],
  monad: [PUBLIC_RPC_URLS.monad, "https://rpc1.monad.xyz"],
} as const;

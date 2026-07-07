# Contract Chain Mappings Reference

Shared by `contract-enrich` and `contract-populate` (which symlinks this file). Use it when translating external chain names, applying supply thresholds, or mapping CoinGecko platforms.

- Prefer existing IDs from `shared/lib/chains/index.ts` whenever the repo already supports the chain.
- This file is a curated translation map, not an exhaustive inventory of every current chain in the repo.
- DefiLlama list endpoint values are already USD-denominated.

## Supply Thresholds

```text
USDT (llamaId 1)   -> >= 10,000,000 USD per chain
USDC (llamaId 2)   -> >= 10,000,000 USD per chain
All other coins    -> >=  1,000,000 USD per chain
```

## DefiLlama Chain Name -> Chain ID

```text
Ethereum                 -> ethereum
Arbitrum                 -> arbitrum
Base                     -> base
OP Mainnet               -> optimism
Polygon                  -> polygon
Avalanche                -> avalanche
BSC                      -> bsc
Gnosis                   -> gnosis
Fantom                   -> fantom
Celo                     -> celo
ZKsync Era               -> zksync
Sonic                    -> sonic
Sei                      -> sei
World Chain              -> worldchain
Unichain                 -> unichain
Ink                      -> ink
Moonriver                -> moonriver
Kaia                     -> klaytn
Plume Mainnet            -> plume
Hyperliquid L1           -> hyperevm
Monad                    -> monad
XDC                      -> xdc
Mantle                   -> mantle
Linea                    -> linea
Scroll                   -> scroll
Blast                    -> blast
Mode                     -> mode
Manta                    -> manta
Berachain                -> berachain
Bob                      -> bob
Fraxtal                  -> fraxtal
Taiko                    -> taiko
Polygon zkEVM            -> polygon-zkevm
Aurora                   -> aurora
Moonbeam                 -> moonbeam
Boba                     -> boba
Soneium                  -> soneium
Zircuit                  -> zircuit
Metis                    -> metis
Astar                    -> astar
Plasma                   -> plasma
Morph                    -> morph-l2
Swellchain               -> swellchain
X Layer                  -> xlayer
Apechain                 -> apechain
Bittorrent               -> bittorrent
Viction                  -> viction
Flare                    -> flare
Songbird                 -> songbird
Bitlayer                 -> bitlayer
Tron                     -> tron
Aptos                    -> aptos
Sui                      -> sui
Solana                   -> solana
TON                      -> ton
Near                     -> near
Algorand                 -> algorand
Stellar                  -> stellar
StarkNet                 -> starknet
Hedera                   -> hedera
Polkadot                 -> polkadot
XRPL                     -> xrpl
Kava                     -> kava
Tezos                    -> tezos
Cardano                  -> cardano
ICP                      -> icp
Noble                    -> noble
Osmosis                  -> osmosis
Mantra                   -> mantra
Provenance               -> provenance
Hydradx                  -> hydration
Ronin                    -> ronin
Corn                     -> corn
Cronos                   -> cronos
Lisk                     -> lisk
Rootstock                -> rootstock
EOS                      -> eos
Stacks                   -> stacks
Flow                     -> flow
IoTeX                    -> iotex
MultiversX               -> multiversx
Injective                -> injective
Zilliqa                  -> zilliqa
Conflux                  -> conflux
PulseChain               -> pulsechain
Etherlink                -> etherlink
MegaETH                  -> megaeth
Immutable zkEVM          -> immutable-zkevm
Heco                     -> heco
OKExChain                -> okxchain
Fogo                     -> fogo
Movement                 -> movement
Sophon                   -> sophon
Story                    -> story
VeChain                  -> vechain
Abstract                 -> abstract
EDU Chain                -> educhain
Hemi                     -> hemi
Mezo                     -> mezo
```

## DefiLlama Chains to Skip

```text
Harmony
Evmos
Terra Classic
EthereumPoW
EthereumClassic
DefiChain
Waves
smartBCH
Everscale
Dogechain
Canto
Karura
Q
REINetwork
SXnetwork
Wanchain
```

## CoinGecko Platform -> Chain ID

```text
ethereum                 -> ethereum
arbitrum-one             -> arbitrum
base                     -> base
optimistic-ethereum      -> optimism
polygon-pos              -> polygon
avalanche                -> avalanche
binance-smart-chain      -> bsc
gnosis                   -> gnosis
fantom                   -> fantom
celo                     -> celo
tron                     -> tron
aptos                    -> aptos
sui                      -> sui
solana                   -> solana
the-open-network         -> ton
zksync                   -> zksync
near-protocol            -> near
algorand                 -> algorand
stellar                  -> stellar
starknet                 -> starknet
hedera-hashgraph         -> hedera
sonic                    -> sonic
xdc-network              -> xdc
sei-v2                   -> sei
world-chain              -> worldchain
unichain                 -> unichain
ink                      -> ink
polkadot                 -> polkadot
xrp                      -> xrpl
moonriver                -> moonriver
klay-token               -> klaytn
plume-network            -> plume
hyperevm                 -> hyperevm
monad                    -> monad
mantle                   -> mantle
linea                    -> linea
scroll                   -> scroll
blast                    -> blast
mode-network             -> mode
manta-pacific            -> manta
ronin                    -> ronin
bob-network              -> bob
corn-network             -> corn
berachain                -> berachain
kava                     -> kava
fraxtal                  -> fraxtal
taiko                    -> taiko
polygon-zkevm            -> polygon-zkevm
aurora                   -> aurora
moonbeam                 -> moonbeam
boba                     -> boba
soneium                  -> soneium
zircuit                  -> zircuit
metis-andromeda          -> metis
astar                    -> astar
plasma                   -> plasma
morph-l2                 -> morph-l2
swellchain               -> swellchain
x-layer                  -> xlayer
apechain                 -> apechain
bittorrent               -> bittorrent
tomochain                -> viction
flare-network            -> flare
songbird                 -> songbird
bitlayer                 -> bitlayer
tezos                    -> tezos
cardano                  -> cardano
internet-computer        -> icp
noble                    -> noble
osmosis                  -> osmosis
mantra                   -> mantra
provenance               -> provenance
hydration                -> hydration
xdai                     -> gnosis
cronos                   -> cronos
lisk                     -> lisk
rootstock                -> rootstock
eos                      -> eos
flow                     -> flow
iotex                    -> iotex
multiversx               -> multiversx
injective                -> injective
zilliqa                  -> zilliqa
conflux                  -> conflux
pulsechain               -> pulsechain
```

## CoinGecko Platforms to Skip

```text
harmony-shard-0
evmos
terra
terra-2
q-mainnet
binancecoin
```

## New Chain Checklist

When a verified platform maps to a chain ID that is not yet in `shared/lib/chains/index.ts`, add:

- `name`
- `explorerUrl`
- `evmChainId` or `null`
- `type`
- `logoPath`

Maintain the existing ordering and alignment style in `CHAIN_META`.

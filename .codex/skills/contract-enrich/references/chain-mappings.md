# Contract Chain Mappings Reference

Shared by `contract-enrich` and `contract-populate` (which symlinks this file). Use it when translating external chain names, applying supply thresholds, or mapping CoinGecko platforms.

- Prefer existing IDs from `shared/lib/chains/index.ts` whenever the repo already supports the chain. `CHAIN_META` and `CHAIN_ALIASES` there are the source of truth — when this file and the registry disagree, the registry wins; check `CHAIN_ALIASES` before assuming a name is unmapped.
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
Hyperliquid L1           -> hyperliquid
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
Corn                     -> corn
Cronos                   -> cronos
Rootstock                -> rootstock
Stacks                   -> stacks
Flow                     -> flow
Injective                -> injective
Conflux                  -> conflux
PulseChain               -> pulsechain
Etherlink                -> etherlink
MegaETH                  -> megaeth
Immutable zkEVM          -> immutable-zkevm
Movement                 -> movement
Sophon                   -> sophon
Abstract                 -> abstract
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
rootstock                -> rootstock
flow                     -> flow
injective                -> injective
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

## Known External Chains Without Registry Support

These names appear in DefiLlama / CoinGecko data but have **no** `CHAIN_META` entry. Report them as unsupported and skip — do not invent a chain ID or write one of these names into a coin's `contracts`:

```text
Ronin / ronin
Lisk / lisk
EOS / eos
IoTeX / iotex
MultiversX / multiversx
Zilliqa / zilliqa
Heco
OKExChain
Fogo
Story
VeChain
EDU Chain
```

(Names, not ids — no id exists until the chain is added to the registry.)

## New Chain Checklist (escalation path — not part of a normal enrich run)

Adding a chain is a separate, deliberate chain-support task that needs an explicit user/owner decision — enrich/populate runs report unsupported chains and stop. Note: `shared/lib/chains/index.ts` is a Safety Score V9 identity-bound surface (edits rotate the evaluation-build identity), so chain additions must land as reviewed, standalone changes.

When that task is authorized: add a `CHAIN_META` entry mirroring the fields and alignment style of a comparable existing entry (the registry file wins on required fields), plus an alias in `CHAIN_ALIASES` if external sources use a different name, then remove the chain from the unsupported list above.

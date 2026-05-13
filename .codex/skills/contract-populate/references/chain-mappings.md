# Contract Populate Reference

Use this file only when translating CoinGecko platform names to repo chain IDs.

- Prefer the current `shared/lib/chains.ts` inventory when a chain already exists there.
- Use the mapping below for external-name translation only.
- Skip listed dead or legacy platforms silently.

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

## Platforms to Skip

```text
harmony-shard-0
evmos
terra
terra-2
q-mainnet
binancecoin
```

## New Chain Checklist

When a verified platform maps to a chain ID that is not yet in `shared/lib/chains.ts`, add:

- `name`
- `explorerUrl`
- `evmChainId` or `null`
- `type`
- `logoPath`

Maintain the existing ordering and alignment style in `CHAIN_META`.

# TODO: Missing Contract Addresses

~29 of 135 tracked stablecoins still need contract addresses in `src/lib/stablecoins.ts`.
Addresses enable on-chain `totalSupply()` verification via `sync-onchain-supply.ts`.

**Completed:** 84 contracts added on 2026-02-19. 109 stablecoins now have on-chain addresses.

**Rules:**
- Only add addresses you can verify on a block explorer
- Lowercase all EVM hex addresses
- Tron addresses stay base58 (T...)
- Supported chains: ethereum, arbitrum, base, optimism, polygon, avalanche, bsc, gnosis, fantom, celo, tron

---

## Non-USD Stables (highest priority — 25 coins)

### EUR (11)

- [x] **EURCV** (id=254) — ethereum `0x5f7827fdeb7c20b443265fc2f40845b715385ff2` 18 dec
- [x] **AEUR** (id=147) — ethereum `0xa40640458fbc27b6eefedea1e9c9e17d4cee7a21` 18 dec
- [x] **EURI** (id=325) — ethereum `0x9d1a7a3191102e9f900faa10540837ba84dcbae7` 18 dec
- [x] **CEUR** (id=52) — celo `0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73` 18 dec
- [x] **EUROe** (id=98) — ethereum `0x820802fa8a99901f52e39acd21177b0be6ee2974` 6 dec
- [x] **VEUR** (id=158) — ethereum `0x6ba75d640bebfe5da1197bb5a2aff3327789b5d3` 18 dec
- [x] **EURR** (id=239) — ethereum `0x50753cfaf86c094925bf976f218d043f8791e408` 6 dec
- [x] **EUROP** (id=247) — ethereum `0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51` 6 dec
- [x] **EURQ** (id=cg-eurq) — ethereum `0x8df723295214ea6f21026eeeb4382d475f146f9f` 6 dec
- [x] **EURAU** (id=319) — ethereum `0x4933a85b5b5466fbaf179f72d3de273c287ec2c2` 6 dec
- [x] **DEURO** (id=cg-deuro) — ethereum `0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea` 18 dec

### GBP (2)

- [x] **VGBP** (id=292) — ethereum `0x34c9c643becd939c950bb9f141e35777559817cb` 18 dec
- [x] **tGBP** (id=317) — ethereum `0x00000000441378008ea67f4284a57932b1c000a5` 18 dec

### CHF (1)

- [x] **VCHF** (id=157) — ethereum `0x79d4f0232a66c4c91b89c76362016a1707cfbf4f` 18 dec

### JPY (2)

- [x] **GYEN** (id=122) — ethereum `0xc08512927d12348f6620a698105e1baac6ecd911` 6 dec
- [x] **JPYC** (id=cg-jpyc) — ethereum `0x431d5dff03120afa4bdf332c61a6e1766ef37bdb` 18 dec

### SGD (1)

- [x] **XSGD** (id=289) — ethereum `0x70e8de73ce538da2beed35d14187f6959a8eca96` 6 dec

### TRY (1)

- [x] **TRYB** (id=300) — ethereum `0x2c537e5624e4af88a7ae4060c022609376c8d0eb` 6 dec

### AUD (1)

- [x] **AUDD** (id=165) — ethereum `0x4cce605ed955295432958d8951d0b176c10720d5` 6 dec

### IDR (1)

- [x] **IDRT** (id=cg-idrt) — ethereum `0x998ffe1e43facffb941dc337dd0468d52ba5b48a` 2 dec

### RUB (1)

- [x] **A7A5** (id=258) — ethereum `0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9` 6 dec

### ZAR (1)

- [x] **ZARP** (id=cg-zarp) — ethereum `0xb755506531786c8ac63b756bab1ac387bacb0c04` 18 dec

### VAR / Other (2)

- [x] **FPI** (id=66) — ethereum `0x5ca135cb8527d76e932f34b5145575f9d8cbe08e` 18 dec
- [ ] **ISC** (id=186) — ⚠️ Solana-only, no EVM deployment

### GOLD (5)

- [ ] **KAU** (id=gold-kau) — ⚠️ Kinesis blockchain (Stellar fork), no EVM deployment
- [x] **XAUm** (id=gold-xaum) — ethereum `0x2103e845c5e135493bb6c2a4f0b8651956ea8682` 18 dec
- [x] **VRO** (id=gold-vro) — ethereum `0x10bc518c32fbae5e38ecb50a612160571bd81e44` 8 dec
- [ ] **CGO** (id=gold-cgo) — ⚠️ XDC Network only (not supported)
- [x] **DGLD** (id=gold-dgld) — ethereum `0xa9299c296d7830a99414d1e5546f5171fa01e9c8` 18 dec

### SILVER (1)

- [x] **KAG** (id=silver-kag) — ethereum `0xf94d9b6dc4eacd89fe3235d9a3c2465fea405157` 9 dec

---

## USD Stables — Major / Well-Known (30 coins)

- [x] **USD1** (id=262) — ethereum `0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d` 18 dec
- [x] **RLUSD** (id=250) — ethereum `0x8292bb45bf1ee4d140127049757c2e0ff06317ed` 18 dec
- [x] **USDD** (id=14) — tron `TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz` 18 dec (USDD 2.0)
- [x] **BUIDL** (id=173) — ethereum `0x7712c34205737192402172409a8f7ccef8aa2aec` 6 dec
- [x] **M** (id=213) — ethereum `0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b` 6 dec
- [x] **USYC** (id=237) — ethereum `0x136471a34f6ef19fe571effc1ca711fdb8e49f2b` 6 dec
- [x] **USDTB** (id=221) — ethereum `0xc139190f447e929f090edeb554d95abb8b18ac1c` 18 dec
- [x] **FDUSD** (id=152) — already had contracts
- [x] **GUSD** (id=19) — ethereum `0x056fd409e1d7a124bd7017459dfea2f387b6d5cd` 2 dec
- [x] **FRXUSD** (id=235) — ethereum `0xcacd6fd266af91b8aed52accc382b4e165586e29` 18 dec
- [x] **BOLD** (id=269) — ethereum `0x6440f144b7e50d6a8439336510312d2f54beb01d` 18 dec
- [x] **DOLA** (id=15) — ethereum `0x865377367054516e17014ccded1e7d814edc9ce4` 18 dec
- [x] **AUSD** (id=205) — ethereum `0x00000000efe302beaa2b3e6e1b18d08d69a9012a` 6 dec
- [ ] **USDN** (id=282) — ⚠️ Cosmos-native (Noble appchain), no EVM deployment
- [ ] **HONEY** (id=231) — ⚠️ Berachain only (not in supported chains)
- [x] **USD0** (id=233) — already had contracts
- [x] **USDf** (id=246) — ethereum `0xfa2b947eec368f42195f24f36d2af29f7c24cec2` 18 dec
- [x] **USDG** (id=286) — ethereum `0xe343167631d89b6ffc58b88d6b7fb0228795491d` 6 dec
- [x] **U** (id=336) — ethereum `0xce24439f2d9c6a2289f741120fe202248b666666` 18 dec
- [x] **USDai** (id=309) — ethereum `0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef` 18 dec
- [x] **CUSD** (id=296) — ethereum `0xcccc62962d17b8914c62d74ffb843d73b2a3cccc` 18 dec
- [x] **USR** (id=197) — ethereum `0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110` 18 dec
- [ ] **YLDS** (id=272) — ⚠️ Provenance Blockchain (Cosmos), no EVM deployment
- [x] **USX** (id=310) — ethereum `0x0a5e677a6a24b2f1a2bf4f3bffc443231d2fdec8` 18 dec
- [x] **USDA** (id=220) — ethereum `0x0000206329b97db379d5e1bf586bbdb969c63274` 18 dec
- [x] **USDQ** (id=275) — ethereum `0xc83e27f270cce0a3a3a29521173a83f402c1768b` 6 dec
- [x] **ALUSD** (id=20) — ethereum `0xbc6da0fe9ad5f3b0d58160288917aa56653660e9` 18 dec
- [x] **EUSD** (id=106) — ethereum `0xdf3ac4f479375802a821f7b7b46cd7eb5e4262cc` 18 dec (V2)
- [x] **GYD** (id=185) — ethereum `0xe07f9d810a48ab5c3c914ba3ca53af14e4491e8a` 18 dec
- [x] **LISUSD** (id=79) — bsc `0x0782b6d8c4551b9760e74c0545a9bcd90bdc41e5` 18 dec

---

## USD Stables — Smaller / Newer (50 coins)

- [x] **IUSD** (id=298) — ethereum `0x48f9e38f3070ad8945dfeae3fa70987722e3d89c` 18 dec
- [x] **USDF** (id=219) — bsc `0x5a110fc00474038f6c02e89c707d638602ea44b5` 18 dec
- [x] **DUSD** (id=252) — ethereum `0xa48f322f8b3edff967629af79e027628b9dd1298` 18 dec
- [ ] **satUSD** (id=218) — ⚠️ Address not verifiable (multi-chain, needs manual lookup)
- [ ] **GUSD** (id=306) — ⚠️ Gate USD — may be exchange-internal, no verified ERC-20
- [ ] **rwaUSDi** (id=340) — ⚠️ Not publicly indexed on block explorers
- [x] **avUSD** (id=271) — avalanche `0x24de8771bc5ddb3362db529fc3358f2df3a0e346` 18 dec
- [x] **PUSD** (id=341) — ethereum `0xdddd73f5df1f0dc31373357beac77545dc5a6f3f` 6 dec
- [x] **reUSD** (id=339) — ethereum `0x5086bf358635b81d8c47c66d1c8b9e567db70c72` 18 dec
- [ ] **pmUSD** (id=332) — ⚠️ Contract not found via search
- [x] **USDz** (id=202) — ethereum `0xa469b7ee9ee773642b3e93e842e5d9b5baa10067` 18 dec
- [x] **CASH** (id=316) — polygon `0x5d066d022ede10efa2717ed3d79f22f949f8c175` 18 dec
- [x] **MNEE** (id=284) — ethereum `0x8ccedbae4916b79da7f3f612efb2eb93a2bfd6cf` 18 dec
- [x] **TBILL** (id=257) — ethereum `0xdd50c053c096cb04a3e3362e2b622529ec5f2e8a` 6 dec
- [x] **USDU** (id=283) — bsc `0xea953ea6634d55dac6697c436b1e81a679db5882` 18 dec
- [ ] **USDH** (id=321) — ⚠️ Hyperliquid only (not supported)
- [x] **USDO** (id=241) — ethereum `0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe` 18 dec
- [x] **cgUSD** (id=166) — base `0xca72827a3d211cfd8f6b00ac98824872b72cab49` 6 dec
- [x] **REUSD** (id=256) — ethereum `0x57ab1e0003f623289cd798b1824be09a793e4bec` 18 dec
- [x] **USDX** (id=263) — ethereum `0xf8750b54d86be7ae9e32b4a0c826811198d63313` 18 dec
- [x] **XUSD** (id=290) — ethereum `0xc08e7e23c235073c6807c2efe7021304cb7c2815` 6 dec
- [x] **MUSD** (id=313) — ethereum `0xaca92e438df0b2401ff60da7e4337b687a2435da` 6 dec
- [x] **YUSD** (id=255) — ethereum `0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a` 18 dec
- [ ] **HYUSD** (id=302) — ⚠️ Solana-native only
- [x] **fxUSD** (id=168) — ethereum `0x085780639cc2cacd35e474e71f4d000e2405d8f6` 18 dec
- [x] **BEAN** (id=67) — arbitrum `0xbea0005b8599265d41256905a9b3073d397812e4` 6 dec
- [x] **USDCV** (id=307) — ethereum `0x5422374b27757da72d5265cc745ea906e0446634` 18 dec
- [ ] **USDB** (id=172) — ⚠️ Blast L2 only (not supported)
- [ ] **ZeUSD** (id=225) — ⚠️ Address not surfaceable via search
- [x] **USN** (id=230) — ethereum `0xda67b4284609d2d48e5d10cfac411572727dc1ed` 18 dec
- [ ] **NECT** (id=329) — ⚠️ Berachain only (not supported)
- [ ] **BUCK** (id=154) — ⚠️ Sui chain (not EVM)
- [x] **meUSD** (id=303) — ethereum `0xdd468a1ddc392dcdbef6db6e34e89aa338f9f186` 18 dec
- [x] **UTY** (id=305) — avalanche `0xdbc5192a6b6ffee7451301bb4ec312f844f02b4a` 18 dec
- [x] **FUSD** (id=63) — fantom `0xad84341756bf337f5a0164515b1f6f993d194e1f` 18 dec
- [ ] **MSUSD** (id=326) — ⚠️ MetaStreet does not issue a stablecoin
- [x] **NUSD** (id=346) — ethereum `0xe556aba6fe6036275ec1f87eda296be72c811bce` 18 dec
- [ ] **YZUSD** (id=344) — ⚠️ Plasma chain only (not supported)
- [ ] **JUPUSD** (id=335) — ⚠️ Solana only (not EVM)
- [ ] **USDM** (id=342) — ⚠️ MegaETH only (not supported)
- [x] **YU** (id=268) — ethereum `0xe868084cf08f3c3db11f4b73a95473762d9463f7` 18 dec
- [x] **USAT** (id=343) — ethereum `0x07041776f5007aca2a54844f50503a18a72a8b68` 6 dec
- [x] **cUSD** (id=24) — celo `0x765de816845861e75a25fca122bb6898b8b1282a` 18 dec
- [ ] **FEUSD** (id=251) — ⚠️ Hyperliquid only (not supported)
- [x] **FIDD** (id=348) — ethereum `0x7c135549504245b5eae64fc0e99fa5ebabb8e35d` 18 dec
- [ ] **USDGO** (id=347) — ⚠️ Solana only (not supported)
- [x] **MSUSD** (id=297) — ethereum `0xab5eb14c09d416f0ac63661e57edb7aecdb9befa` 18 dec
- [x] **USDM** (id=215) — ethereum `0x59d9356e565ab3a36dd77763fc0d87feaf85508c` 18 dec
- [ ] **HOLLAR** (id=312) — ⚠️ Polkadot only (not supported)
- [ ] **USDA** (id=245) — ⚠️ Bitcoin L2 / Stacks (not EVM)
- [ ] **UUSD** (id=75) — ⚠️ Tezos only (not EVM)
- [ ] **AZND** (id=327) — ⚠️ Address not found

---

## Remaining (26 coins without contracts)

### Non-EVM / unsupported chains (18)
ISC (Solana), KAU (Kinesis), CGO (XDC), USDN (Cosmos), HONEY (Berachain), YLDS (Provenance),
HYUSD (Solana), USDB (Blast), NECT (Berachain), BUCK (Sui), YZUSD (Plasma), JUPUSD (Solana),
USDM/MegaUSD (MegaETH), FEUSD (Hyperliquid), USDGO (Solana), HOLLAR (Polkadot),
USDA/Hermetica (Stacks), UUSD (Tezos)

### USDH (Hyperliquid — may get Ethereum ERC-20)

### Address not found / needs manual lookup (7)
satUSD, GUSD/Gate, rwaUSDi, pmUSD, ZeUSD, MSUSD/MetaStreet (326), AZND

---

## Notes

- Coins with **CoinGecko synthetic IDs** (`cg-*`) and **gold/silver synthetic IDs** (`gold-*`, `silver-*`) are defined in special config arrays in `sync-stablecoins.ts`, not in `TRACKED_STABLECOINS`. Their `contracts` field still works but they need to be added to the respective config objects
- `ADDRESS_OVERRIDES` in `sync-stablecoins.ts` for M and BEAN still needed for DL sync pipeline (separate from contracts field)

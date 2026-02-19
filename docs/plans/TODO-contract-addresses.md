# TODO: Missing Contract Addresses

110 of 135 tracked stablecoins still need contract addresses in `src/lib/stablecoins.ts`.
Addresses enable on-chain `totalSupply()` verification via `sync-onchain-supply.ts`.

**Priority:** Non-USD stables first (data from DefiLlama/CoinGecko is least reliable for these).

**Rules:**
- Only add addresses you can verify on a block explorer
- Lowercase all EVM hex addresses
- Tron addresses stay base58 (T...)
- Supported chains: ethereum, arbitrum, base, optimism, polygon, avalanche, bsc, gnosis, fantom, celo, tron

---

## Non-USD Stables (highest priority — 25 coins)

### EUR (11)

- [ ] **EURCV** (id=254) — Societe Generale EUR stablecoin
- [ ] **AEUR** (id=147) — Anchored Coins EUR
- [ ] **EURI** (id=325) — EUR stablecoin
- [ ] **CEUR** (id=52) — Celo EUR
- [ ] **EUROe** (id=98) — Membrane Finance EUR
- [ ] **VEUR** (id=158) — VNX Euro
- [ ] **EURR** (id=239) — EUR stablecoin
- [ ] **EUROP** (id=247) — EUR stablecoin
- [ ] **EURQ** (id=cg-eurq) — Quantoz EURQ (CoinGecko source)
- [ ] **EURAU** (id=319) — EUR stablecoin
- [ ] **DEURO** (id=cg-deuro) — Decentralized EUR (CoinGecko source)

### GBP (2)

- [ ] **VGBP** (id=292) — VNX GBP
- [ ] **tGBP** (id=317) — TrueGBP

### CHF (1)

- [ ] **VCHF** (id=157) — VNX CHF

### JPY (2)

- [ ] **GYEN** (id=122) — GMO JPY stablecoin
- [ ] **JPYC** (id=cg-jpyc) — JPY Coin (CoinGecko source)

### SGD (1)

- [ ] **XSGD** (id=289) — StraitsX SGD

### TRY (1)

- [ ] **TRYB** (id=300) — BiLira TRY

### AUD (1)

- [ ] **AUDD** (id=165) — Novatti AUD

### IDR (1)

- [ ] **IDRT** (id=cg-idrt) — Rupiah Token (CoinGecko source)

### RUB (1)

- [ ] **A7A5** (id=258) — RUB stablecoin

### ZAR (1)

- [ ] **ZARP** (id=cg-zarp) — ZARP Stablecoin (CoinGecko source)

### VAR / Other (2)

- [ ] **FPI** (id=66) — Frax CPI-indexed
- [ ] **ISC** (id=186) — International Stable Currency

### GOLD (5)

- [ ] **KAU** (id=gold-kau) — Kinesis Gold (1 gram)
- [ ] **XAUm** (id=gold-xaum) — Matrixdock Gold
- [ ] **VRO** (id=gold-vro) — VeraOne Gold (1 gram)
- [ ] **CGO** (id=gold-cgo) — Comtech Gold (1 gram)
- [ ] **DGLD** (id=gold-dgld) — DGLD Tokenized Gold

### SILVER (1)

- [ ] **KAG** (id=silver-kag) — Kinesis Silver

---

## USD Stables — Major / Well-Known (30 coins)

- [ ] **USD1** (id=262) — World Liberty Financial USD
- [ ] **RLUSD** (id=250) — Ripple USD
- [ ] **USDD** (id=14) — USDD (Tron)
- [ ] **BUIDL** (id=173) — BlackRock USD Institutional
- [ ] **M** (id=213) — M by M0 (known: `0x866A2BF4E572CbcF37D5071A7a58503Bfb36be1b`)
- [ ] **USYC** (id=237) — Hashnote USYC
- [ ] **USDTB** (id=221) — Ethena USDtb
- [ ] **FDUSD** (id=152) — First Digital USD (`0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409` on Ethereum, 18 dec)
- [ ] **GUSD** (id=19) — Gemini Dollar
- [ ] **FRXUSD** (id=235) — Frax USD (new)
- [ ] **BOLD** (id=269) — Liquity V2 BOLD
- [ ] **DOLA** (id=15) — Inverse Finance DOLA
- [ ] **AUSD** (id=205) — Agora USD
- [ ] **USDN** (id=282) — Noon USD
- [ ] **HONEY** (id=231) — Berachain Honey
- [ ] **USD0** (id=233) — Usual USD (`0x73A15FeD60Bf67631dC6cd7Bc5B6e8da8190aCF5` on Ethereum, 18 dec)
- [ ] **USDf** (id=246) — Falcon USD
- [ ] **USDG** (id=286) — Paxos Global Dollar
- [ ] **U** (id=336) — Resolv U
- [ ] **USDai** (id=309) — Spark USDai
- [ ] **CUSD** (id=296) — Cap cUSD
- [ ] **USR** (id=197) — Resolv USR
- [ ] **YLDS** (id=272) — Figure Markets YLDS
- [ ] **USX** (id=310) — dForce USX
- [ ] **USDA** (id=220) — Angle USDA
- [ ] **USDQ** (id=275) — Quantoz USDQ
- [ ] **ALUSD** (id=20) — Alchemix alUSD
- [ ] **EUSD** (id=106) — Lybra eUSD
- [ ] **GYD** (id=185) — Gyroscope Dollar
- [ ] **LISUSD** (id=79) — Lista DAO lisUSD

---

## USD Stables — Smaller / Newer (50 coins)

- [ ] **IUSD** (id=298) — iUSD
- [ ] **USDF** (id=219) — Forge USD
- [ ] **DUSD** (id=252) — Davos Protocol DUSD
- [ ] **satUSD** (id=218) — River satUSD
- [ ] **GUSD** (id=306) — Gravity USD
- [ ] **rwaUSDi** (id=340) — rwaUSDi
- [ ] **avUSD** (id=271) — Avant USD
- [ ] **PUSD** (id=341) — PUSD
- [ ] **reUSD** (id=339) — Resolv reUSD
- [ ] **pmUSD** (id=332) — Parrot Miles USD
- [ ] **USDz** (id=202) — Anzen USDz
- [ ] **CASH** (id=316) — Stackcoin CASH
- [ ] **MNEE** (id=284) — eMoney
- [ ] **TBILL** (id=257) — OpenEden TBILL
- [ ] **USDU** (id=283) — USDU
- [ ] **USDH** (id=321) — Hatom USDH
- [ ] **USDO** (id=241) — US Dollar Online
- [ ] **cgUSD** (id=166) — Cygnus Global USD
- [ ] **REUSD** (id=256) — Reservoir reUSD
- [ ] **USDX** (id=263) — Stables Labs USDX
- [ ] **XUSD** (id=290) — xUSD
- [ ] **MUSD** (id=313) — Mezo musd
- [ ] **YUSD** (id=255) — Aegis YUSD
- [ ] **HYUSD** (id=302) — High Yield USD
- [ ] **fxUSD** (id=168) — f(x) Protocol fxUSD
- [ ] **BEAN** (id=67) — Beanstalk BEAN (known: `arbitrum:0xBEA0005B8599265D41256905A9B3073D397812E4`)
- [ ] **USDCV** (id=307) — USDCV
- [ ] **USDB** (id=172) — USD Balance
- [ ] **ZeUSD** (id=225) — Zerolend ZeUSD
- [ ] **USN** (id=230) — USN
- [ ] **NECT** (id=329) — Nectar NECT
- [ ] **BUCK** (id=154) — Bucket BUCK (Sui chain — not EVM)
- [ ] **meUSD** (id=303) — Morpho meUSD
- [ ] **UTY** (id=305) — XSY UTY
- [ ] **FUSD** (id=63) — Fantom fUSD
- [ ] **MSUSD** (id=326) — MetaStreet msUSD
- [ ] **NUSD** (id=346) — Noble nUSD
- [ ] **YZUSD** (id=344) — YieldZard yzUSD
- [ ] **JUPUSD** (id=335) — Jupiter jupUSD (Solana — not EVM)
- [ ] **USDM** (id=342) — MegaUSD
- [ ] **YU** (id=268) — Yei USD
- [ ] **USAT** (id=343) — USAT
- [ ] **cUSD** (id=24) — Celo Dollar (Celo chain)
- [ ] **FEUSD** (id=251) — FeUSD
- [ ] **FIDD** (id=348) — FIDD
- [ ] **USDGO** (id=347) — USDGO
- [ ] **MSUSD** (id=297) — msUSD (other)
- [ ] **USDM** (id=215) — Mountain Protocol USDM
- [ ] **HOLLAR** (id=312) — Hollar
- [ ] **USDA** (id=245) — Hermetica USDA (Bitcoin L2 — not EVM)
- [ ] **UUSD** (id=75) — Unit Protocol UUSD
- [ ] **AZND** (id=327) — Azena USD

---

## Notes

- Coins on **non-EVM chains only** (Sui, Solana, Bitcoin L2) cannot be verified yet — marked above
- Coins with **CoinGecko synthetic IDs** (`cg-*`) and **gold/silver synthetic IDs** (`gold-*`, `silver-*`) are defined in special config arrays in `sync-stablecoins.ts`, not in `TRACKED_STABLECOINS`. Their `contracts` field still works but they need to be added to the respective config objects
- Some addresses are already known from `ADDRESS_OVERRIDES` in `sync-stablecoins.ts` (M, BEAN) — these should be moved into the `contracts` field

export const YIELD_POOL_MAP: Record<string, string> = {
  // USD3 - 3Jane senior credit tranche, Ethereum, native NAV appreciation
  "usd3-3jane": "f8cd444e-d99f-4132-b234-fd3482bf8806",
  // sUSDe - ethena-usde native staking, Ethereum, $3.5B TVL, ~3.6% APY
  "susde-ethena": "66985a81-9c51-46ca-9977-42b4fe7bc6df",
  // USYC - ondo-yield-assets (listed as USDYC), Ethereum, $602M TVL, ~3.6% APY
  "usyc-hashnote": "ee457473-3b5f-4b53-8c8a-fde6b2e16c8a",
  // USDY - ondo-yield-assets native, Ethereum, $149M TVL, ~3.6% APY
  "usdy-ondo-finance": "ac61ee82-2fe4-4f9b-a9cd-7fb33f598859",
  // BUIDL (173) - no DL pool; Blackrock/Securitize fund not tracked by DL Yields
  // YLDS (272) - no DL pool; Figure Markets not tracked by DL Yields
  // reUSD -> stUSR - resolv native staking, Ethereum, $109M TVL, ~0.6% APY
  "reusd-re-protocol": "0aedb3f6-9298-49de-8bb0-2f611a4df784",
  // TBILL - openeden-tbill native, Ethereum, $27M TVL, ~3.0% APY
  "tbill-openeden": "e140f3b2-0327-46ea-93f5-88b17b0a0a16",
  // YUSD - aegis native, Ethereum, $36M TVL, ~5.7% APY
  "yusd-aegis": "f91b2168-c279-475c-a98a-673220f4fee7",
  // USDB (172) - no native DL pool; Blast native yield is not tracked by DL Yields
  // AZND -> loAZND - mu-digital native, Monad, $7.4M TVL, ~6.7% APY
  "aznd-mu-digital": "0a05f2ee-e182-476a-9cdc-2fed86fcd765",
  // OUSD - origin-dollar native, Ethereum, $7M TVL, ~5.4% APY
  "ousd-origin-protocol": "529258ee-9b27-4fcf-a32c-b82abb3fda68",
  // syrupUSDC - maple native USDC pool, Ethereum, $3.2B TVL, ~4.6% APY
  //             (syrupUSDC is the yield wrapper for USDC deposits into Maple)
  "syrupusdc-maple": "43641cf5-a92e-416b-bce9-27113d3c0db6",
  // syrupUSDT - maple native USDT pool, Ethereum, $1.4B TVL, ~4.4% APY
  //             (syrupUSDT is the yield wrapper for USDT deposits into Maple)
  "syrupusdt-maple": "8edfdf02-cdbb-43f7-bca6-954e5fe56813",
  // yoUSD - pendle SY yield token, Base, $1.3M TVL, ~8.0% APY
  "yousd-yield-optimizer": "c7c9e2c5-a3ea-4e6e-80d7-090fd2d604c5",
  // bUSD0 - usual-usd0 liquid bond, Ethereum, $500M+ TVL, ~3.3% APY
  "busd0-usual": "55b0893b-1dbb-47fd-9912-5e439cd3d511",
  // ── Wave 1: Native yield coins (C+ or above) ─────────────────────
  // sUSDS - sky-lending, Ethereum, $5.3B TVL, ~4.0% APY
  "susds-sky": "d8c4eff5-c8a9-46fc-a888-057c4c668e72",
  // sDAI - sdai native, Gnosis, $86M TVL, ~5.5% APY
  "sdai-sky": "13392973-be6e-4b2f-bce9-4f7dd53d1c3a",
  // scrvUSD - curve native savings, Ethereum, $40M TVL, ~6.7% APY
  "scrvusd-curve": "5fd328af-4203-471b-bd16-1705c726d926",
  // sfrxUSD - frax native staking, Ethereum, $26M TVL, ~4.3% APY
  "sfrxusd-frax": "42523cca-14b0-44f6-95fb-4781069520a5",
  // BOLD -> yBOLD - yearn-finance vault, Ethereum, $4.5M TVL, ~9.8% APY
  "bold-liquity": "4c29f645-12db-461f-a1d7-16900d624271",
  // ZCHF - frankencoin native savings (no wrapper), Ethereum, $7.1M TVL, ~3.8% APY
  "zchf-frankencoin": "8b427366-7bfb-4c61-88be-8dc004fdc3da",
  // fxUSD - fx-protocol Stability Pool, Ethereum, $33.9M TVL, ~4.0% APY
  //         (DL symbol is FXUSDSTABILITYPOOLV2.0, not fxUSD — must use static map)
  "fxusd-f-x-protocol": "abd6c9e1-3b52-459a-a31b-9022a4dcf7e2",
  // ── Stablewatch Wave 1: New wrapper pools ─────────────────────────
  // infiniFi USD -> siUSD - infinifi native savings, Ethereum, $121M TVL, ~4.8% APY
  "iusd-infinifi": "8fa2e60e-365a-41fc-8d50-fadde5041f94",
  // Falcon USD -> sUSDf - falcon-finance native savings, Ethereum, $87M TVL, ~5.9% APY
  "usdf-falcon": "0f67a08c-3f24-4a4b-963e-541f5a5c0364",
  // Unitas -> sUSDu - unitas native savings, Solana, $49M TVL, ~12.9% APY
  "usdu-unitas": "7f980c43-5b87-4690-a11a-b0e8a5e37a63",
  // GAIB sAID - gaib native savings, Ethereum, $15M TVL, ~10.5% APY
  "said-gaib": "e575606e-5642-4f87-b9ad-3e53d6f83c82",
  // OUSG - ondo-yield-assets native, Ethereum, $519M TVL, ~3.1% APY
  "ousg-ondo-finance": "7436db9b-2872-46c8-81a2-da6baff902b7",
  // sUSDai - usd-ai native savings, Arbitrum, $217M TVL, ~7.7% APY
  "susdai-usd-ai": "712ce948-bd9e-4f4a-8916-b72c447f7578",
  // wsrUSD - reservoir-protocol native, Ethereum, $159M TVL, ~4.8% APY
  "wsrusd-reservoir": "d646f32f-d5af-4e34-a29f-8ebeea6a8520",
  // savUSD - Avant native savings, Avalanche, $62M TVL, APY via savUSD/avUSD exchange-rate growth
  "savusd-avant": "c74227a1-e738-4021-bbe1-13363815aecb",
  // Neutrl USD -> sNUSD - pendle PT-buying pool, Ethereum, $41M TVL, ~7.5% APY
  "nusd-neutrl": "0f38d9a4-8e34-4abc-b9ba-25f326ef7828",
  // Yuzu USD -> syzUSD - yuzu-money native savings, Plasma, $28M TVL, ~7.3% APY
  "yzusd-yuzu": "6174b1d6-8212-4964-95bf-ca9c539864ba",
  // Staked Yuzu USD (syzUSD) - shares the yuzu-money Plasma savings pool with parent yzusd-yuzu (DefiLlama tracks only the SYZUSD wrapper)
  "syzusd-yuzu": "6174b1d6-8212-4964-95bf-ca9c539864ba",
  // Noon USN -> sUSN - morpho-v1 collateral, Ethereum, $10M TVL, APY via on-chain rate
  "usn-noon": "a18a761b-49cd-416d-8342-839cac722094",
  // Cap stcUSD - cap native staking, Ethereum, $90M+ TVL, ~5.9% APY
  "stcusd-cap": "bf6ca887-e357-49ec-8031-0d1a6141c455",
  // SMARDEX USDN - native rebasing vault, Ethereum, $1M+ TVL
  "usdn-smardex": "f51bb9f9-0a01-4aa2-9c62-b9ef6b55d109",
  // HedgeCore sUSD - HedgeCore routes USDC collateral through Venus on BSC
  "susd-hedgecore": "89eba1e5-1b1b-47b6-958b-38138a04c244",
  // gtUSDC - morpho-blue Gauntlet USDC vault, Ethereum, $147M TVL, ~3.58% APY
  "gtusdc-gauntlet": "a306885c-001e-4479-9ae8-459a56527bc1",
  // bbqUSDC - morpho-blue Smokehouse USDC vault, Ethereum, $18M TVL, ~4.3% APY
  "bbqusdc-steakhouse": "36977448-9ad9-43ea-85f2-60ee1b92ecd0",
  // spUSDC - spark-savings USDC vault, Ethereum, $946M TVL, ~3.65% APY
  "susdc-spark": "c5c74dd1-995c-4445-9d84-3e710bad7d52",
  // spUSDT - spark-savings USDT vault, Ethereum, $1.18B TVL, ~2.50% APY
  "susdt-spark": "a5d67f7e-5b51-4a9d-969d-caf051a7f5a4",
  // sGHO - aave-v3 Safety Module staked GHO, Ethereum, $264M TVL, ~5.49% APY
  "sgho-aave": "ff2a68af-030c-4697-b0a1-b62a738eaef0",
  // yBOLD - yearn-finance Liquity wrapper, Ethereum, $5.5M TVL, ~10.36% APY
  //         (variant-map entry on `bold-liquity` remains; skipped automatically
  //          since the wrapper is tracked separately)
  "ybold-yearn": "4c29f645-12db-461f-a1d7-16900d624271",
  // yvUSDC - yearn-finance USDC vault, Ethereum, $29M TVL, ~3.43% APY
  "yvusdc-yearn": "7d89af7a-24c9-4292-aa38-7c71b05fbd6d",
};

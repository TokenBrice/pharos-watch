import { SUPPLY_PERIMETER_CHANGES } from "@shared/lib/supply-perimeter-changes";

// Vetted DefiLlama per-chain daily points at 2026-10-08T00:00Z, captured 2026-10-09.
// USDG X Layer/Ink cross-checked against issuer-native on-chain totalSupply.
// Incident bootstrap only: never supersedes a successfully loaded persisted baseline.
export const CHAIN_DROPOUT_SEED_OBSERVED_AT = Date.parse("2026-10-08T00:00:00Z") / 1000;
export const CHAIN_DROPOUT_SEED_VALID_UNTIL = Date.parse("2026-11-09T00:00:00Z") / 1000;
export const CHAIN_DROPOUT_SEED = [
  {
    "assetId": "usdg-paxos",
    "llamaId": "286",
    "chainLabel": "X Layer",
    "chainId": "xlayer",
    "baselineUsd": 1427912807
  },
  {
    "assetId": "usdy-ondo-finance",
    "llamaId": "129",
    "chainLabel": "Sei",
    "chainId": "sei",
    "baselineUsd": 259265031
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "Sonic",
    "chainId": "sonic",
    "baselineUsd": 159557271
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "Cronos",
    "chainId": "cronos",
    "baselineUsd": 138295823
  },
  {
    "assetId": "usdt-tether",
    "llamaId": "1",
    "chainLabel": "X Layer",
    "chainId": "xlayer",
    "baselineUsd": 110783406
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "Tempo",
    "chainId": "tempo",
    "baselineUsd": 94886012
  },
  {
    "assetId": "usdt-tether",
    "llamaId": "1",
    "chainLabel": "Hyperliquid L1",
    "chainId": "hyperliquid",
    "baselineUsd": 67319517
  },
  {
    "assetId": "usdg-paxos",
    "llamaId": "286",
    "chainLabel": "Ink",
    "chainId": "ink",
    "baselineUsd": 63630836
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "XDC",
    "chainId": null,
    "baselineUsd": 57345551
  },
  {
    "assetId": "usdt-tether",
    "llamaId": "1",
    "chainLabel": "Ink",
    "chainId": "ink",
    "baselineUsd": 56736668
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "Ink",
    "chainId": "ink",
    "baselineUsd": 49071164
  },
  {
    "assetId": "usdt-tether",
    "llamaId": "1",
    "chainLabel": "Berachain",
    "chainId": "berachain",
    "baselineUsd": 30179561
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "RISE",
    "chainId": "rise",
    "baselineUsd": 25490794
  },
  {
    "assetId": "usdt-tether",
    "llamaId": "1",
    "chainLabel": "Flare",
    "chainId": "flare",
    "baselineUsd": 24381846
  },
  {
    "assetId": "usdt-tether",
    "llamaId": "1",
    "chainLabel": "Stable",
    "chainId": "stable",
    "baselineUsd": 20594894
  },
  {
    "assetId": "satusd-river",
    "llamaId": "218",
    "chainLabel": "BOB",
    "chainId": "bob",
    "baselineUsd": 20250721
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "X Layer",
    "chainId": "xlayer",
    "baselineUsd": 17902196
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "World Chain",
    "chainId": "worldchain",
    "baselineUsd": 17041348
  },
  {
    "assetId": "usde-ethena",
    "llamaId": "146",
    "chainLabel": "Berachain",
    "chainId": "berachain",
    "baselineUsd": 13380529
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "Etherlink",
    "chainId": "etherlink",
    "baselineUsd": 12759751
  },
  {
    "assetId": "usdt-tether",
    "llamaId": "1",
    "chainLabel": "Tempo",
    "chainId": "tempo",
    "baselineUsd": 11156522
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "Katana",
    "chainId": "katana",
    "baselineUsd": 8030433
  },
  {
    "assetId": "usde-ethena",
    "llamaId": "146",
    "chainLabel": "Hyperliquid L1",
    "chainId": "hyperliquid",
    "baselineUsd": 7488532
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "Berachain",
    "chainId": "berachain",
    "baselineUsd": 5077289
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "Codex",
    "chainId": "codex",
    "baselineUsd": 4959211
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "Plume Mainnet",
    "chainId": null,
    "baselineUsd": 4861133
  },
  {
    "assetId": "satusd-river",
    "llamaId": "218",
    "chainLabel": "BSquared",
    "chainId": null,
    "baselineUsd": 4927482
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "Abstract",
    "chainId": "abstract",
    "baselineUsd": 4049309
  },
  {
    "assetId": "frxusd-frax",
    "llamaId": "235",
    "chainLabel": "Stable",
    "chainId": "stable",
    "baselineUsd": 3931658
  },
  {
    "assetId": "rwausdi-multipli",
    "llamaId": "340",
    "chainLabel": "X Layer",
    "chainId": "xlayer",
    "baselineUsd": 3715612
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "Flare",
    "chainId": "flare",
    "baselineUsd": 3371354
  },
  {
    "assetId": "usda-avalon",
    "llamaId": "220",
    "chainLabel": "Berachain",
    "chainId": "berachain",
    "baselineUsd": 2692580
  },
  {
    "assetId": "usdt-tether",
    "llamaId": "1",
    "chainLabel": "Katana",
    "chainId": "katana",
    "baselineUsd": 2636976
  },
  {
    "assetId": "usdt-tether",
    "llamaId": "1",
    "chainLabel": "Sei",
    "chainId": "sei",
    "baselineUsd": 2080963
  },
  {
    "assetId": "pyusd-paypal",
    "llamaId": "120",
    "chainLabel": "Sei",
    "chainId": "sei",
    "baselineUsd": 2088625
  },
  {
    "assetId": "eurc-circle",
    "llamaId": "50",
    "chainLabel": "Tempo",
    "chainId": "tempo",
    "baselineUsd": 1653927
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "Doma",
    "chainId": null,
    "baselineUsd": 1287180
  },
  {
    "assetId": "usdg-paxos",
    "llamaId": "286",
    "chainLabel": "Hyperliquid L1",
    "chainId": "hyperliquid",
    "baselineUsd": 1193158
  },
  {
    "assetId": "usdc-circle",
    "llamaId": "2",
    "chainLabel": "Hyperliquid L1",
    "chainId": "hyperliquid",
    "baselineUsd": 7265728606
  }
] as const;

type ReviewedChainSupplyCollapse = {
  assetId: string; chainId: string; reviewedAt: number; evidenceUrl: string;
} & (
  | {
    policy: "accept-observed-collapse"; excludeOmittedUntil?: never;
  }
  | { policy: "exclude-omitted"; excludeOmittedUntil: number }
  // From `reviewedAt`, the guard removes the pair only while it holds exactly this reviewed baseline: the same
  // observation clock and the same stored value. A different clock or value keeps its guard.
  | { policy: "retire-baseline"; baselineObservedAt: number; baselineUsd: number; excludeOmittedUntil?: never }
);

export const REVIEWED_CHAIN_SUPPLY_COLLAPSES: readonly ReviewedChainSupplyCollapse[] = [
  // 2026-10-16 06:18 UTC: Arbitrum block 515293481 confirms 1,155,833.488355934
  // satUSD, matching the lower list/history stock after the October 11 reduction.
  {
    assetId: "satusd-river", chainId: "arbitrum",
    policy: "accept-observed-collapse",
    reviewedAt: Date.parse("2026-10-16T06:18:46Z") / 1000,
    evidenceUrl: "https://arbiscan.io/token/0xb4818bb69478730ef4e33cc068dd94278e2766cb",
  },
  // Polygon block 95617466: 533,719.13 EURS total minus 100,000 issuer inventory
  // equals the list's 433,719.13 EUR. Ethereum gains the corresponding bridge unwind;
  // accepting the observed lower chain stock avoids adding it back a second time.
  {
    assetId: "eurs-stasis", chainId: "polygon",
    policy: "accept-observed-collapse",
    reviewedAt: Date.parse("2026-10-16T06:18:46Z") / 1000,
    evidenceUrl: "https://polygonscan.com/token/0xe111178a87a3bff0c8d18decba5798827539ae99",
  },
  // 2026-11-06: Polygon block 96823850 confirms 363,068.694747281274675608 SBC
  // at the held baseline's own clock. Block 96856472 has 463,068.694747281274675608;
  // both disprove the held $1.846M level. Accept the provider's lower observation unchanged.
  {
    assetId: "sbc-brale", chainId: "polygon",
    policy: "accept-observed-collapse",
    reviewedAt: Date.parse("2026-11-06T18:42:00Z") / 1000,
    evidenceUrl: "https://polygonscan.com/token/0xfdcc3dd6671eab0709a4c0f3f53de9a333d80798",
  },
  // Finalized Solana slot 466634085 confirms 7,808,083.761641852 SBC, matching
  // the price-adjusted list's $7.798M rather than the held $15.916M baseline.
  {
    assetId: "sbc-brale", chainId: "solana",
    policy: "accept-observed-collapse",
    reviewedAt: Date.parse("2026-11-07T19:45:46Z") / 1000,
    evidenceUrl: "https://solscan.io/token/DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA",
  },
  // Ethereum block 26365071: 1,001,981.18 GBPA total; Etherscan holders confirms
  // the detail feed's 1,001,879.18 unreleased balance, leaving 102 circulating.
  {
    assetId: "gbpa-agant", chainId: "ethereum",
    policy: "accept-observed-collapse",
    reviewedAt: Date.parse("2026-11-07T19:45:46Z") / 1000,
    evidenceUrl: "https://etherscan.io/token/0xbbe6aab0ed76e90aea0d1cd978ec231c8adcdf8b#balances",
  },
  // Finalized Solana slot 466212454 confirms 2,153,029.477071 EUROP, matching
  // detail native supply. Ethereum block 26357578 has 9,824,599.672717 tokens;
  // the lower Solana stock is real, without claiming a matched cross-chain migration.
  {
    assetId: "europ-schuman", chainId: "solana",
    policy: "accept-observed-collapse",
    reviewedAt: Date.parse("2026-11-06T18:42:00Z") / 1000,
    evidenceUrl: "https://solscan.io/token/euro5sNHrZC2wu2RoLvy6xxoVMc3Qnd1vjxoWf4MftA",
  },
  // 2026-11-03 10:09 UTC: BOB block 40419289 (rpc.gobob.xyz) confirms
  // 1,322,822.22 satUSD, matching the lower list level after River's BOB
  // redemption; the persisted $15.26M baseline is a disproven pre-collapse level.
  {
    assetId: "satusd-river", chainId: "bob",
    policy: "accept-observed-collapse",
    reviewedAt: Date.parse("2026-11-03T10:09:25Z") / 1000,
    evidenceUrl: "https://explorer.gobob.xyz/token/0xecf21b335b41f9d5a89f6186a99c19a3c467871f",
  },
  // 2026-11-03 10:09 UTC: Base block 53455609 (mainnet.base.org) confirms
  // 239,013.52 satUSD, exactly the observed list current.
  {
    assetId: "satusd-river", chainId: "base",
    policy: "accept-observed-collapse",
    reviewedAt: Date.parse("2026-11-03T10:09:25Z") / 1000,
    evidenceUrl: "https://basescan.org/token/0x70654aad8b7734dc319d0c3608ec7b32e03fa162",
  },
  // 2026-11-03 10:09 UTC: Ethereum block 26333581 (ethereum-rpc.publicnode.com)
  // confirms 932,368.82 satUSD, exactly the observed list current.
  {
    assetId: "satusd-river", chainId: "ethereum",
    policy: "accept-observed-collapse",
    reviewedAt: Date.parse("2026-11-03T10:09:23Z") / 1000,
    evidenceUrl: "https://etherscan.io/token/0x1958853a8be062dc4f401750eb233f5850f0d0d2",
  },
  // 2026-11-03 10:16 UTC: Solana slot 464859942 (api.mainnet-beta.solana.com)
  // confirms 794,463.996947 DUSD, matching the lower list level after StandX's
  // Solana contraction from $3.01M.
  {
    assetId: "dusd-standx", chainId: "solana",
    policy: "accept-observed-collapse",
    reviewedAt: Date.parse("2026-11-03T10:16:00Z") / 1000,
    evidenceUrl: "https://solscan.io/token/DUSDt4AeLZHWYmcXnVGYdgAzjtzU5mXUVnTMdnSzAttM",
  },
  // 2026-11-04 00:05 UTC: Plasma block 36808012 (rpc.plasma.to) confirms
  // 13,372,760.551335 TRYB, matching the lower list level after BiLira's Plasma
  // burns (blocks 35221462 and 36085454); the $1.42M baseline is pre-burn.
  {
    assetId: "tryb-bilira", chainId: "plasma",
    policy: "accept-observed-collapse",
    reviewedAt: Date.parse("2026-11-04T00:05:26Z") / 1000,
    evidenceUrl: "https://plasmascan.to/token/0x90729a45948c3078890bc80f2a4e7870a2ea4c5e",
  },
  // 2026-11-04 09:03 UTC: finalized Ethereum block 26340352 confirms 2,000,000 USDQ,
  // matching list/detail after the reduction from the frozen 7M baseline.
  {
    assetId: "usdq-quantoz", chainId: "ethereum",
    policy: "accept-observed-collapse",
    reviewedAt: Date.parse("2026-11-04T09:03:51Z") / 1000,
    evidenceUrl: "https://etherscan.io/token/0xc83e27f270cce0a3a3a29521173a83f402c1768b",
  },
  // Finalized Base block 53496375 confirms 91,362.381965885876828965 USDGLO,
  // matching native detail and price-adjusted list stock, down from the $1.018M baseline.
  {
    assetId: "usdglo-glo", chainId: "base",
    policy: "accept-observed-collapse",
    reviewedAt: Date.parse("2026-11-04T09:03:51Z") / 1000,
    evidenceUrl: "https://basescan.org/token/0x4f604735c1cf31399c6e711d5962b2b3e0225ad3",
  },
  // 2026-11-12: Tempo is still absent from provider list/detail. Finalized block
  // 48710775 confirms 17,177,908.27 BUIDL shares; native aggregate publication
  // includes this stock independently. Retain provider omission, never par-NAV valuation.
  {
    assetId: "buidl-blackrock", chainId: "tempo",
    policy: "exclude-omitted",
    reviewedAt: Date.parse("2026-11-12T19:35:00Z") / 1000,
    excludeOmittedUntil: Date.parse("2026-11-26T19:35:00Z") / 1000,
    evidenceUrl: "https://explorer.tempo.xyz/token/0xb5ff12bd8010baef823d1bfa2ce6bdc0109cbb24",
  },
  // Tempo block 48741970 (2026-11-13): 1,000,000 fxUSD exist, also omitted by list/detail, and
  // 999,996 of them sit in the Tempo OFT adapter 0xd87bbc92431f2908fbba780ce902f309a171335c.
  // Its Ethereum peer 0x06013F99661B59e5A5BFD62AFEEd6fe7C10bdDE9 locks 8 fxUSD (block 26402372).
  // Only 4 fxUSD are outside the Tempo adapter; its balance may be inventory or bridge custody.
  // Ethereum's 8 are not exactly reconciled. Retain the omitted-chain exclusion.
  // Renewal requires token(), reciprocal peers, totalSupply() and both adapter balance reads.
  {
    assetId: "fxusd-f-x-protocol", chainId: "tempo",
    policy: "exclude-omitted",
    reviewedAt: Date.parse("2026-11-13T00:12:36Z") / 1000,
    excludeOmittedUntil: Date.parse("2026-11-27T00:12:36Z") / 1000,
    evidenceUrl: "https://explorer.tempo.xyz/token/0x20c000000000000000000000850e533bd762b72c",
  },
  // HyperEVM block 50654180 reads 43,067.502661 frxUSD, already included under
  // the provider's Hyperliquid L1 row; exclude the omitted old $3.749M identity.
  {
    assetId: "frxusd-frax", chainId: "hyperevm",
    policy: "exclude-omitted",
    reviewedAt: Date.parse("2026-11-07T19:45:46Z") / 1000,
    excludeOmittedUntil: Date.parse("2026-11-21T19:45:46Z") / 1000,
    evidenceUrl: "https://purrsec.com/token/0x80eede496655fb9047dd39d9f418d5483ed600df",
  },
  // BSC block 133360128 (2026-11-13 13:31 UTC): the registry iUSD token has zero total supply, as
  // at block 133295638. DefiLlama id 298 has no BSC key in its detail chain balances and an empty
  // BSC chart. The retired $3,926,614 baseline dated 2026-11-12 19:15:10 UTC was therefore never a
  // provider observation; that it was a CoinGecko gap-fill remainder is inferred, not captured.
  {
    assetId: "iusd-infinifi", chainId: "bsc",
    policy: "retire-baseline",
    reviewedAt: Date.parse("2026-11-13T13:31:00Z") / 1000,
    baselineObservedAt: 1794510910, baselineUsd: 3926614.153173417,
    evidenceUrl: "https://bscscan.com/token/0x60b14ec49874af1ba471685cb11132101aebdf09",
  },
  // Finalized Solana slot 468944023 (2026-11-13 13:31 UTC): the registry apxUSD mint holds
  // 6,273,500.906527 apxUSD. DefiLlama id 354 has no Solana key in its detail chain balances and an
  // empty Solana chart. The retired $17,992,714 baseline dated 2026-10-15 was therefore never a
  // provider observation; that it was a CoinGecko gap-fill remainder is inferred, not captured.
  {
    assetId: "apxusd-apyx", chainId: "solana",
    policy: "retire-baseline",
    reviewedAt: Date.parse("2026-11-13T13:31:00Z") / 1000,
    baselineObservedAt: 1792070050, baselineUsd: 17992713.995119274,
    evidenceUrl: "https://solscan.io/token/HAYQtfJEQ9DbDbaHEhxfGsWbSZ3ywthdsVB3PuB72DYe",
  },
  // Finalized Solana slot 468944023 (2026-11-13 13:31 UTC): the registry USDf mint has zero supply.
  // DefiLlama id 246 has no Solana key in its detail chain balances and an empty Solana chart. The
  // retired $163,746,470 baseline dated 2026-11-06 was therefore never a provider observation; that
  // it was a CoinGecko gap-fill remainder is inferred, not captured.
  {
    assetId: "usdf-falcon", chainId: "solana",
    policy: "retire-baseline",
    reviewedAt: Date.parse("2026-11-13T13:31:00Z") / 1000,
    baselineObservedAt: 1793946610, baselineUsd: 163746469.69199657,
    evidenceUrl: "https://solscan.io/token/9ksrtYx1vnRxr4X5YqmGxqRMRBhgsc6FfQwWjB1KZq2x",
  },
  // GHO, 2026-11-13: not a dropout. DefiLlama peggedassets-server PR #987 (merged 2026-11-12
  // 08:05 UTC) reports GHO pre-minted into Aave's GhoReserve contracts and unborrowed
  // GhoDirectMinter liquidity as unreleased. Recomputed from chain state at Ethereum block 26404723,
  // Arbitrum 523807208, Monad 121833574 and Plasma 37613621: reserves hold 278,748,901 /
  // 28,642,003 / 15,640,791 / 6,804,874 GHO, direct minters 100,524,608 idle; circulating is
  // 268,638,822 GHO of 699,000,000 minted, against the provider's 268,653,633.
  // Quantoz USDQ and EURQ, 2026-11-13: not dropouts either. DefiLlama commit 110fb5b87e (01:30 UTC)
  // reports the issuer's XRPL treasury account rsTXamYqHPDaNQPKejfRavmwPevuAkPQeT as unreleased.
  // Validated XRPL ledger 108302298: it holds 1,000,000 USDQ and 999,977.5 EURQ; issuer obligations
  // outside it are 0 USDQ and 22.5 EURQ. USDQ's XRPL row is an observed 0, accepted at changedAt.
  // EURQ has a CoinGecko detail provider, so the guard never evaluates its chains and the acceptance
  // generated below goes unused; the guard's perimeter loop still withholds its earlier anchors.
  ...SUPPLY_PERIMETER_CHANGES.flatMap((change) => change.chainIds.map((chainId) => ({
    assetId: change.stablecoinId, chainId,
    policy: "accept-observed-collapse" as const,
    reviewedAt: change.changedAt,
    evidenceUrl: change.evidenceUrl,
  }))),
];

/**
 * Happy-path corpus for the adapter replay gate.
 *
 * One entry per adapter key: the coin it replays, the upstream payload fixture
 * (`network`; provenance is noted per entry), and one shape-drift mutation. The gate in
 * `adapter-corpus.test.ts` asserts the happy path validates under the adapter's
 * own descriptor policy and that the mutation surfaces as an adapter error or a
 * `degraded` warning — never as a silently wrong snapshot.
 *
 * Adapter keys with no entry MUST appear in `CORPUS_EXEMPT` with a reason; the
 * gate fails on any key that is in neither map.
 */
import { resolveAdapterCoin, type AdapterNetworkSpec, type AdapterRpcValue } from "./reserve-adapter.test-support";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { BTCFI_HANDLER_ROWS, BTCFI_MARKET_ROWS } from "./reserve-adapter-payloads.test-support";
import { MAKINA_ALLOCATIONS_FIXTURE, makinaNetworkSpec } from "./makina-strategy.test-support";

export interface AdapterCorpusDrift {
  /** What the upstream changed, in the words of the failure it must produce. */
  label: string;
  /** The mutated payload table, replacing the happy-path one. */
  network: AdapterNetworkSpec;
  /**
   * `error`: the adapter must throw. `degraded`: it must publish with a
   * degrading warning. Anything else is the E3 silent-constant defect class.
   */
  outcome: "error" | "degraded";
}

export interface AdapterCorpusCase {
  coinId: string;
  network: AdapterNetworkSpec;
  /** Replay clock, normally just after the capture's own publication instant. */
  nowSec?: number;
  drift: AdapterCorpusDrift;
}

export const CORPUS_EXEMPT: Record<string, string> = {
  "money-llamma":
    "On-chain LLAMMA census; the adapter test mocks fetchOnchainMulticall3/fetchDefiLlamaPrices/pinnedBlockPlan directly and no wire capture is committed yet (owner: P4HedgecoreMoneySpusd).",
  "hylo-solana":
    "No bound catalog coin yet (retired, parked, staged or newly declared key), so there is nothing to replay; parser behaviour stays owned by its adapter test file.",
  "3jane-usd3":
    "No committed wire capture yet; the happy path and its failure modes are owned by 3jane-usd3.test.ts.",
  "abracadabra":
    "No bound catalog coin yet (retired, parked, staged or newly declared key), so there is nothing to replay; parser behaviour stays owned by abracadabra.test.ts.",
  "anchorage-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by anchorage-independent-assurance.test.ts.",
  "accountable":
    "No committed wire capture yet; the happy path and its failure modes are owned by accountable.test.ts.",
  "agora-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by agora-independent-assurance.test.ts.",
  "anzen-usdz":
    "No committed wire capture yet; the happy path and its failure modes are owned by anzen-usdz.test.ts.",
  "moc-doc":
    "No committed wire capture yet; the happy path and its failure modes are owned by moc-doc.test.ts.",
  "moc-v3-buckets":
    "No committed wire capture yet; the happy path and its failure modes are owned by its adapter test file.",
  "astherus-earn-wrapper":
    "No committed wire capture yet; the happy path and its failure modes are owned by astherus-earn-wrapper.test.ts.",
  "attestation-pdf-index":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by attestation-pdf-index.test.ts.",
  "audd-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by audd-independent-assurance.test.ts.",
  "audx-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by its adapter test file.",
  "blast-usdb-yield-manager":
    "No committed wire capture yet; the happy path and its failure modes are owned by blast-usdb-yield-manager.test.ts.",
  "brla-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by brla-independent-assurance.test.ts.",
  "cadd-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by cadd-independent-assurance.test.ts.",
  "bridge-transparency":
    "No committed wire capture yet; the happy path and its failure modes are owned by bridge-transparency.test.ts.",
  "cap-vault":
    "No committed wire capture yet; the happy path and its failure modes are owned by cap-vault.test.ts.",
  "chainlink-nav":
    "No committed wire capture yet; the happy path and its failure modes are owned by chainlink-nav.test.ts.",
  "chronicle-nav":
    "No committed wire capture yet; the happy path and its failure modes are owned by chronicle-nav.test.ts.",
  "chainlink-por":
    "No committed wire capture yet; the happy path and its failure modes are owned by chainlink-por.test.ts.",
  "circle-transparency":
    "No committed wire capture yet; the happy path and its failure modes are owned by circle-transparency.test.ts.",
  "collateral-positions-api":
    "No committed wire capture yet; the happy path and its failure modes are owned by collateral-positions-api.test.ts.",
  "crvusd":
    "No committed wire capture yet; the happy path and its failure modes are owned by crvusd.test.ts.",
  "curated-validated":
    "No committed wire capture yet; the happy path and its failure modes are owned by curated-validated.test.ts.",
  "usdai-hub":
    "No committed wire capture yet; the happy path and its failure modes are owned by usdai-hub.test.ts.",
  "dola-inverse":
    "No committed wire capture yet; the happy path and its failure modes are owned by dola-inverse.test.ts.",
  "erc4626-single-asset":
    "No committed wire capture yet; the happy path and its failure modes are owned by erc4626-single-asset.test.ts.",
  "escrow-balance":
    "No committed wire capture yet; the happy path and its failure modes are owned by escrow-balance.test.ts.",
  "evm-branch-balances":
    "No committed wire capture yet; the happy path and its failure modes are owned by evm-branch-balances.test.ts.",
  "parallelizer-balances":
    "No committed wire capture yet; the happy path and its failure modes are owned by parallelizer-balances.test.ts.",
  "europ-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by its adapter test file.",
  "xdai-bridge":
    "No committed wire capture yet; the happy path and its failure modes are owned by xdai-bridge.test.ts.",
  "xpr-account-balances":
    "No committed wire capture yet; the happy path and its failure modes are owned by xpr-account-balances.test.ts.",
  "fdusd-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by fdusd-independent-assurance.test.ts.",
  "fdusd-transparency":
    "No bound catalog coin yet (retired, parked, staged or newly declared key), so there is nothing to replay; parser behaviour stays owned by fdusd-transparency.test.ts.",
  "fidd-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by fidd-independent-assurance.test.ts.",
  "flying-tulip-ftusd":
    "No committed wire capture yet; the happy path and its failure modes are owned by flying-tulip-ftusd.test.ts.",
  "frax-balance-sheet":
    "No committed wire capture yet; the happy path and its failure modes are owned by its adapter test file.",
  "frax-fpi-collateral":
    "No committed wire capture yet; the happy path and its failure modes are owned by its adapter test file.",
  "fx":
    "No committed wire capture yet; the happy path and its failure modes are owned by fx.test.ts.",
  "gemini-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by gemini-independent-assurance.test.ts.",
  "sodax-sonic":
    "No committed wire capture yet; the happy path and its failure modes are owned by its adapter test file.",
  "gho":
    "No committed wire capture yet; the happy path and its failure modes are owned by gho.test.ts.",
  "hive-hbd-protocol":
    "No committed wire capture yet; the happy path and its failure modes are owned by hive-hbd-protocol.test.ts.",
  "idle-cdo-epoch-variant":
    "No committed wire capture yet; the happy path and its failure modes are owned by idle-cdo-epoch-variant.test.ts.",
  "infinifi":
    "No committed wire capture yet; the happy path and its failure modes are owned by infinifi.test.ts.",
  "initia-wrapper-vault":
    "No committed wire capture yet; the happy path and its failure modes are owned by initia-wrapper-vault.test.ts.",
  "issuer-attested-report":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by issuer-attested-report.test.ts.",
  "kava-cdp":
    "No committed wire capture yet; the happy path and its failure modes are owned by kava-cdp.test.ts.",
  "hliquity-hedera":
    "No committed wire capture yet; the happy path and its failure modes are owned by hliquity-hedera.test.ts.",
  "krwq-custodian":
    "No committed wire capture yet; the happy path and its failure modes are owned by krwq-custodian.test.ts.",
  "liquity-v1":
    "No committed wire capture yet; the happy path and its failure modes are owned by liquity-v1.test.ts.",
  "liquity-native-active-pool":
    "No committed wire capture yet; the happy path and its failure modes are owned by liquity-native-active-pool.test.ts.",
  "liquity-v2-branches":
    "No committed wire capture yet; the happy path and its failure modes are owned by liquity-v2-branches.test.ts.",
  "m0":
    "No committed wire capture yet; the happy path and its failure modes are owned by m0.test.ts.",
  "m0-wrapper-underlying":
    "No committed wire capture yet; the happy path and its failure modes are owned by m0-wrapper-underlying.test.ts.",
  "megausd-custody":
    "No committed wire capture yet; the happy path and its failure modes are owned by megausd-custody.test.ts.",
  "mento":
    "No committed wire capture yet; the happy path and its failure modes are owned by mento.test.ts.",
  "nest-vault-positions":
    "No committed wire capture yet; the happy path and its failure modes are owned by nest-vault-positions.test.ts.",
  "openeden-usdo":
    "No bound catalog coin yet (retired, parked, staged or newly declared key), so there is nothing to replay; parser behaviour stays owned by its adapter test file.",
  "origin-vault-balances":
    "No committed wire capture yet; the happy path and its failure modes are owned by origin-vault-balances.test.ts.",
  "quantoz-transparency":
    "No committed wire capture yet; the happy path and its failure modes are owned by quantoz-transparency.test.ts.",
  "re-metrics":
    "No committed wire capture yet; the happy path and its failure modes are owned by re-metrics.test.ts.",
  "reserve-protocol-dtf":
    "No committed wire capture yet; the happy path and its failure modes are owned by reserve-protocol-dtf.test.ts.",
  "ripple-transparency":
    "No committed wire capture yet; the happy path and its failure modes are owned by ripple-transparency.test.ts.",
  "sgforge-coinvertible":
    "No committed wire capture yet; the happy path and its failure modes are owned by sgforge-coinvertible.test.ts.",
  "saturn-pyusdx":
    "No committed wire capture yet; the happy path and its failure modes are owned by saturn-pyusdx.test.ts.",
  "sbc-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by sbc-independent-assurance.test.ts.",
  "straitsx-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by independent-assurance.test.ts.",
  "solstice-attestation":
    "No committed wire capture yet; the happy path and its failure modes are owned by solstice-attestation.test.ts.",
  "solomon-protocol":
    "No committed wire capture yet; the happy path and its failure modes are owned by solomon-protocol.test.ts.",
  "stoneyield-router-pool":
    "No bound catalog coin yet (retired, parked, staged or newly declared key), so there is nothing to replay; parser behaviour stays owned by stoneyield-router-pool.test.ts.",
  "superstate-liquidity":
    "No committed wire capture yet; the happy path and its failure modes are owned by superstate-liquidity.test.ts.",
  "paxos-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by paxos-independent-assurance.test.ts.",
  "united-por":
    "No committed wire capture yet; the happy path and its failure modes are owned by united-por.test.ts.",
  "usdgo-transparency":
    "No committed wire capture yet; the happy path and its failure modes are owned by usdgo-transparency.test.ts.",
  "usdh-native-markets":
    "No bound catalog coin yet (retired, parked, staged or newly declared key), so there is nothing to replay; parser behaviour stays owned by usdh-native-markets.test.ts.",
  "usdai-proof-of-reserves":
    "No committed wire capture yet; the happy path and its failure modes are owned by usdai-proof-of-reserves.test.ts.",
  "usd1-bundle-oracle":
    "No committed wire capture yet; the happy path and its failure modes are owned by usd1-bundle-oracle.test.ts.",
  "yamato":
    "No committed wire capture yet; the happy path and its failure modes are owned by yamato.test.ts.",
  "youves-tezos":
    "No committed wire capture yet; the happy path and its failure modes are owned by youves-tezos.test.ts.",
  "zephyr-scanner":
    "No committed wire capture yet; the happy path and its failure modes are owned by zephyr-scanner.test.ts.",
  "usdy-holdings-report":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by usdy-holdings-report.test.ts.",
  "djed-cardano":
    "No committed wire capture yet; the happy path and its failure modes are owned by its adapter test file.",
  "dgld-gold-mapper":
    "No committed wire capture yet; the happy path and its failure modes are owned by dgld-gold-mapper.test.ts.",
  "matrixdock-frs":
    "No committed wire capture yet; the happy path and its failure modes are owned by matrixdock-frs.test.ts.",
  "icp-gldt":
    "On-chain ICP canister reads; the adapter test mocks queryIcpCanister/fetchIcrcLedgerTotalSupply directly and no CBOR/candid wire capture is committed yet (owner: P4GldtFinish).",
  "onre-holdings-csv":
    "No committed wire capture yet; the happy path and its failure modes are owned by its adapter test file.",
  "avant-reserves-api":
    "No committed wire capture yet; the happy path and its failure modes are owned by its adapter test file.",
  "afi-proof":
    "No committed wire capture yet; the happy path and its failure modes are owned by its adapter test file.",
  "kerne-signed-por":
    "Pre-launch kUSD adapter; the signed payload is synthetic test data rather than a committed wire capture, so replay remains owned by kerne-signed-por.test.ts.",
};

const TETHER_ENDPOINT = "https://app.tether.to/transparency.json";
// Captured 2026-07-09 from GET https://app.tether.to/transparency.json, trimmed
// to the fields the adapter reads for the USDT entry.
const TETHER_CAPTURE = {
  data_formatted: [
    {
      iso: "usdt",
      id: 1_783_555_140,
      total_assets: "189761994736.8062",
      total_liabilities: "184211219230.290086",
      chains: [{ name: "Ethereum", value: 100_000_000, quarantined: 0 }],
    },
  ],
};

export const CORPUS_CASES: Record<string, AdapterCorpusCase> = {
  "tether-transparency": {
    coinId: "usdt-tether",
    nowSec: 1_783_555_140 + 3_600,
    network: { json: { [TETHER_ENDPOINT]: TETHER_CAPTURE } },
    drift: {
      label: "total_assets becomes a non-numeric string",
      network: {
        json: {
          [TETHER_ENDPOINT]: {
            data_formatted: [{ ...TETHER_CAPTURE.data_formatted[0], total_assets: "not-a-number" }],
          },
        },
      },
      outcome: "error",
    },
  },
};

const WHITELABEL_ENDPOINT = "https://whitelabel.ethena.fi/api/transparency";
const USDTB_ENDPOINT = "https://usdtb.money/api/transparency/backing-and-supply/current";
const WHITELABEL_CAPTURE = {
  data: [{
    stablecoin: "suiUSDe",
    totalSupply: 100,
    lastUpdated: 1_757_000_000_000,
    custodians: [
      { network: "sui", asset: "USDC", amount: 20 },
      { network: "ethereum", asset: "USDe", amount: 80 },
    ],
  }],
};
const USDTB_CAPTURE = {
  assetsInMotion: 10,
  backingAssets: { BUIDL: [{ amount: 90 }] },
  lastUpdatedAt: "1757000000000",
  supply: 100,
};

CORPUS_CASES["ethena-whitelabel"] = {
  coinId: "suiusde-sui",
  nowSec: 1_757_003_600,
  network: { json: { [WHITELABEL_ENDPOINT]: WHITELABEL_CAPTURE } },
  drift: {
    label: "the stablecoin row renames totalSupply",
    network: {
      json: {
        [WHITELABEL_ENDPOINT]: {
          data: [{ ...WHITELABEL_CAPTURE.data[0], totalSupply: undefined, supply: 100 }],
        },
      },
    },
    outcome: "error",
  },
};

CORPUS_CASES["usdtb-transparency"] = {
  coinId: "usdtb-ethena",
  nowSec: 1_757_003_600,
  network: { json: { [USDTB_ENDPOINT]: USDTB_CAPTURE } },
  drift: {
    label: "the BUIDL backing key is renamed upstream",
    network: {
      json: { [USDTB_ENDPOINT]: { ...USDTB_CAPTURE, backingAssets: { BUIDLX: [{ amount: 90 }] } } },
    },
    outcome: "degraded",
  },
};

// Trimmed happy-path fixtures from the six adapter tests (not new live captures).
// Each drift removes a denominator field while leaving plausible holdings intact.
const ETHENA_ENDPOINT = "https://app.ethena.fi/api/positions/current/collateral";
const SKY_ENDPOINT = "https://info-sky.blockanalitica.com/groups/?days_ago=1&order=-debt";
const FALCON_ENDPOINT = "https://api.falcon.finance/api/v1/transparency";
const JUPUSD_ENDPOINT = "https://api.jupusd.money/api/data";
const ETHENA_FIXTURE = {
  totalBackingAssetsInUsd: 100,
  collateral: [
    { asset: "Liquid Cash", exchange: "Binance", timestamp: 1_757_000_000, usdAmount: 35 },
    { asset: "BTC", exchange: "Binance", timestamp: 1_757_000_000, usdAmount: 20 },
    { asset: "ETH", exchange: "Binance", timestamp: 1_757_000_000, usdAmount: 45 },
  ],
};
const SKY_FIXTURE = {
  count: 2,
  results: [
    { group: "stablecoins", group_name: "Stablecoins", debt: "400", collateral: "400", datetime: "1757000000000" },
    { group: "spark", group_name: "Spark", debt: "300", collateral: "300", datetime: "1757000000000" },
  ],
};
const FALCON_FIXTURE = {
  snapshot_date: 1_757_000_000,
  usdf: {
    supply: "100",
    insurance_fund: "5",
    breakdown: { assets: [{ label: "USDC", ceffu: "30" }, { label: "BTC", multisig: "65" }] },
  },
};
const JUPUSD_FIXTURE = {
  totalSupply: "100000000",
  holdings: [
    { name: "USDC", amount: "60000000", decimals: 6, type: "program" },
    { name: "USDtb", amount: "40000000", decimals: 6, type: "anchorage" },
  ],
};
const JUPUSD_AUXILIARY = {
  "https://api.jupusd.money/api/snapshots": { snapshots: [{ timestamp: 1_757_000_000 }] },
  "https://api.jupusd.money/api/oracle": { ripcord: false },
};
const abiWord = (value: bigint) => value.toString(16).padStart(64, "0");
const ETHENA_RPC = {
  "0x0fd761e0": "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
  "0xa7c1abe0": `0x${abiWord(200_000_000n * 10n ** 18n)}${abiWord(10_000_000n * 10n ** 18n)}`,
  "0xfe136c4e": `0x${abiWord(0n)}${abiWord(1n)}${abiWord(200_000_000n * 10n ** 18n)}${abiWord(10_000_000n * 10n ** 18n)}`,
  "balanceOf(address)": 1_000_000_000n,
};
const SKY_RPC = {
  "0x7bd2bea7": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0xcccef9e2": "0x37305b1cd40574e4c5ce33f8e8306be057fd7341",
  "balanceOf(address)": 123_456_000000n,
};

CORPUS_CASES.ethena = {
  coinId: "usde-ethena",
  nowSec: 1_757_003_600,
  network: { json: { [ETHENA_ENDPOINT]: ETHENA_FIXTURE }, rpc: ETHENA_RPC },
  drift: {
    label: "totalBackingAssetsInUsd is dropped",
    network: { json: { [ETHENA_ENDPOINT]: { ...ETHENA_FIXTURE, totalBackingAssetsInUsd: undefined } }, rpc: ETHENA_RPC },
    outcome: "error",
  },
};
CORPUS_CASES["sky-makercore"] = {
  coinId: "usds-sky",
  nowSec: 1_757_003_600,
  network: { json: { [SKY_ENDPOINT]: SKY_FIXTURE }, rpc: SKY_RPC },
  drift: {
    label: "stablecoins.collateral is dropped",
    network: {
      json: { [SKY_ENDPOINT]: {
        ...SKY_FIXTURE,
        results: [{ ...SKY_FIXTURE.results[0], collateral: undefined }, SKY_FIXTURE.results[1]],
      } },
      rpc: SKY_RPC,
    },
    outcome: "error",
  },
};
CORPUS_CASES.falcon = {
  coinId: "usdf-falcon",
  nowSec: 1_757_003_600,
  network: { json: { [FALCON_ENDPOINT]: FALCON_FIXTURE } },
  drift: {
    label: "usdf.supply is dropped",
    network: { json: { [FALCON_ENDPOINT]: { ...FALCON_FIXTURE, usdf: { ...FALCON_FIXTURE.usdf, supply: undefined } } } },
    outcome: "error",
  },
};
CORPUS_CASES.jupusd = {
  coinId: "jupusd-jupiter",
  nowSec: 1_757_003_600,
  network: { json: { [JUPUSD_ENDPOINT]: JUPUSD_FIXTURE, ...JUPUSD_AUXILIARY } },
  drift: {
    label: "totalSupply is dropped",
    network: { json: { [JUPUSD_ENDPOINT]: { ...JUPUSD_FIXTURE, totalSupply: undefined }, ...JUPUSD_AUXILIARY } },
    outcome: "error",
  },
};

const SINGLE_ASSET_ENDPOINT = "https://api.sdc.stablecorp.ca/reports/balances?type=unformatted_json";
// Trimmed happy path from single-asset.test.ts; only fields read by the QCAD
// catalog configuration are retained.
const SINGLE_ASSET_FIXTURE = {
  totalFiatReserves: "105000000",
  totalSupply: "100000000",
  chains: [{ lastSyncedAt: "2026-03-20T12:00:00Z" }],
};
CORPUS_CASES["single-asset"] = {
  coinId: "qcad-stablecorp",
  nowSec: Date.parse("2026-03-20T12:01:00Z") / 1000,
  network: { json: { [SINGLE_ASSET_ENDPOINT]: SINGLE_ASSET_FIXTURE } },
  drift: {
    label: "the source timestamp is dropped",
    network: {
      json: {
        [SINGLE_ASSET_ENDPOINT]: {
          ...SINGLE_ASSET_FIXTURE,
          chains: [{ lastSyncedAt: undefined }],
        },
      },
    },
    outcome: "error",
  },
};

const SPIKO_ENDPOINT = "https://public-api.spiko.io/share-classes/SAFO/totals";
// Trimmed happy path from spiko-api.test.ts; only fields read by the SAFO
// catalog configuration are retained.
const SPIKO_FIXTURE = {
  totalShares: "1000000",
  totalAssets: { value: "1010000", currency: "USD" },
  netAssetValue: {
    amount: { value: "1.0", currency: "USD" },
    updatedAt: "2026-07-09T12:00:00.000Z",
  },
};
CORPUS_CASES["spiko-api"] = {
  coinId: "safo-spiko-usd",
  nowSec: Date.parse("2026-07-09T12:01:00Z") / 1000,
  network: { json: { [SPIKO_ENDPOINT]: SPIKO_FIXTURE } },
  drift: {
    label: "netAssetValue.updatedAt is dropped",
    network: {
      json: {
        [SPIKO_ENDPOINT]: {
          ...SPIKO_FIXTURE,
          netAssetValue: { ...SPIKO_FIXTURE.netAssetValue, updatedAt: undefined },
        },
      },
    },
    outcome: "error",
  },
};
const BTCFI_MARKET_ENDPOINT = "https://www.btcfi.one/api/getBtcfiMarket?isTestnet=false";
const BTCFI_HANDLERS_ENDPOINT = "https://www.btcfi.one/api/getAvailableBtcfiHandlers?isTestnet=false";
CORPUS_CASES.btcfi = {
  coinId: "btcusd-btcfi",
  network: { json: { [BTCFI_MARKET_ENDPOINT]: BTCFI_MARKET_ROWS, [BTCFI_HANDLERS_ENDPOINT]: BTCFI_HANDLER_ROWS } },
  drift: {
    label: "a collateral row deposit_value is dropped",
    network: { json: {
      [BTCFI_MARKET_ENDPOINT]: BTCFI_MARKET_ROWS.map((row, index) => index === 0 ? { ...row, deposit_value: undefined } : row),
      [BTCFI_HANDLERS_ENDPOINT]: BTCFI_HANDLER_ROWS,
    } },
    outcome: "error",
  },
};

// Trimmed happy path from usdd-data-platform.test.ts (USDD data-platform capture
// values). The coin's real config is the chain=tron feed, so the replay also
// answers the same-run TronGrid PSM probe from the adapter test's pinned words.
const USDD_LATEST_ENDPOINT = "https://app-api.usdd.io/data-platform/latest-collateral?chain=tron";
const USDD_HISTORY_ENDPOINT = "https://app-api.usdd.io/data-platform/collateral-history?interval=WEEKLY&chain=tron";
const USDD_TRON_GRID_ENDPOINT = "https://api.trongrid.io/wallet/triggerconstantcontract";
const USDD_LATEST_ITEMS = [
  { vaultType: "TRX-A", lockedValue: 201_173_223.24 },
  { vaultType: "TRX-B", lockedValue: 100_178_816.93 },
  { vaultType: "TRX-C", lockedValue: 108_374_409.0 },
  { vaultType: "USDT-A", lockedValue: 672_966.59 },
  { vaultType: "STRX-A", lockedValue: 18_896_312.13 },
  { vaultType: "PSM-USDT-A", lockedValue: 82_309_862.43 },
  { vaultType: "SA001-A", lockedValue: 519_698_996.0 },
];
const USDD_HISTORY_CAPTURE = { code: 0, data: { items: [{ statisticTime: 1_774_281_600_000 }] } };
const USDD_PSM_GEM_JOIN_WORD = "000000000000000000000000b50eb419ebeba06c80df5e9aaec494cef4297879";
const USDD_PSM_USDD_WORD = "000000000000000000000000e91a7411e56ce79e83570570f49b9fc35b7727c5";
const USDD_PSM_WORD = (value: bigint): string => value.toString(16).padStart(64, "0");
const USDD_PSM_WORDS: Record<string, string> = {
  "gemJoin()": USDD_PSM_GEM_JOIN_WORD,
  "usdd()": USDD_PSM_USDD_WORD,
  "buyEnabled()": USDD_PSM_WORD(1n),
  "tout()": USDD_PSM_WORD(0n),
  "balanceOf(address)": USDD_PSM_WORD(33_195_883_987_282n),
};
const respondToUsddTronGrid = async (request: Request) => {
  const body = await request.clone().json() as { function_selector?: string };
  const word = USDD_PSM_WORDS[body.function_selector ?? ""];
  return word == null
    ? { result: { result: false } }
    : { result: { result: true }, constant_result: [word] };
};

CORPUS_CASES["usdd-data-platform"] = {
  coinId: "usdd-tron-dao-reserve",
  nowSec: 1_774_281_600 + 3_600,
  network: {
    json: {
      [USDD_LATEST_ENDPOINT]: { code: 0, data: { items: USDD_LATEST_ITEMS } },
      [USDD_HISTORY_ENDPOINT]: USDD_HISTORY_CAPTURE,
      [USDD_TRON_GRID_ENDPOINT]: respondToUsddTronGrid,
    },
  },
  drift: {
    label: "a TRX-C vault row's lockedValue arrives as a formatted string",
    network: {
      json: {
        [USDD_LATEST_ENDPOINT]: {
          code: 0,
          data: {
            items: USDD_LATEST_ITEMS.map((row, index) =>
              index === 2 ? { vaultType: row.vaultType, lockedValue: "108,374,409.00" } : row),
          },
        },
        [USDD_HISTORY_ENDPOINT]: USDD_HISTORY_CAPTURE,
        [USDD_TRON_GRID_ENDPOINT]: respondToUsddTronGrid,
      },
    },
    outcome: "error",
  },
};

const MAKINA_ALLOCATIONS_DRIFTED = structuredClone(MAKINA_ALLOCATIONS_FIXTURE);
delete MAKINA_ALLOCATIONS_DRIFTED.data.positions[0].updated_at;

CORPUS_CASES["makina-strategy"] = {
  coinId: "dusd-dialectic",
  // Just after the oldest captured position update, which bounds the result's
  // freshness below both envelope generated_at instants.
  nowSec: 1_785_265_103 + 600,
  network: makinaNetworkSpec(),
  drift: {
    label: "a position's updated_at timestamp is dropped",
    network: makinaNetworkSpec({ allocations: MAKINA_ALLOCATIONS_DRIFTED }),
    outcome: "degraded",
  },
};

// Trimmed happy-path fixture from reservoir.test.ts plus the same-run PSM
// reads (underlying()/underlyingBalance()/paused() at the reviewed PSM).
const RESERVOIR_ENDPOINT = "https://app.reservoir.xyz/api/reserves/raw";
const RESERVOIR_CAPTURE = {
  assets: [
    { label: "Dolomite - USD1", totalBalanceValue: "30" },
    { label: "Morpho - Sentora PYUSD Main V2", totalBalanceValue: "30" },
    { label: "USDC", totalBalanceValue: "40" },
  ],
  liabilities: [],
  totalAssets: "100",
  totalLiabilities: "95",
  equity: "5",
};
const RESERVOIR_RPC: Record<string, AdapterRpcValue> = {
  "0x4809010926aec940b550d34a46a52739f996d75d:0x6f307dc3": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0x4809010926aec940b550d34a46a52739f996d75d:0x59356c5c": 4_000000n,
  "0x4809010926aec940b550d34a46a52739f996d75d:0x5c975abb": false,
};
CORPUS_CASES.reservoir = {
  coinId: "rusd-reservoir",
  network: { json: { [RESERVOIR_ENDPOINT]: RESERVOIR_CAPTURE }, rpc: RESERVOIR_RPC },
  drift: {
    label: "the balance-sheet assets array is dropped",
    network: { json: { [RESERVOIR_ENDPOINT]: { ...RESERVOIR_CAPTURE, assets: undefined } }, rpc: RESERVOIR_RPC },
    outcome: "error",
  },
};

// Trimmed happy path from resupply-pairs.test.ts replayed against the coin's
// real 11-pair catalog config; every pair's collateral vault is answered
// synthetically with asset() round-tripping to the reviewed underlying.
const RESUPPLY_HANDLER = "0x5eeb063d0abefbbc78f576e28d762a16b637a025";
const RESUPPLY_CRVUSD = "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e";
const RESUPPLY_FRXUSD = "0xcacd6fd266af91b8aed52accc382b4e165586e29";
const resupplyCorpusWord = (value: bigint) => value.toString(16).padStart(64, "0");
const resupplyCorpusRpc = (mismatchedVault = false): Record<string, AdapterRpcValue> => {
  const rpc: Record<string, AdapterRpcValue> = {
    [`${RESUPPLY_HANDLER}:0x901654fc`]: true,
    [`${RESUPPLY_HANDLER}:0x0e3d9f3c`]: 985_000_000_000_000_000n,
    [`${RESUPPLY_HANDLER}:0xc6af1dda`]: 970_000_000_000_000_000n,
    [`${RESUPPLY_HANDLER}:0x43bad45b`]: 0n,
    [`${RESUPPLY_CRVUSD}:0x313ce567`]: 18n,
    [`${RESUPPLY_FRXUSD}:0x313ce567`]: 18n,
  };
  const { config } = resolveAdapterCoin("resupply-pairs", "reusd-resupply");
  const pairs = parseLiveReserveAdapterParams("resupply-pairs", config.params).pairs ?? [];
  pairs.forEach((pair, index) => {
    const underlying = pair.key.startsWith("PAIR_CURVELEND") ? RESUPPLY_CRVUSD : RESUPPLY_FRXUSD;
    const collateral = `0x${(index + 1).toString(16).padStart(40, "0")}`;
    const borrow = BigInt(index + 1) * 10n ** 23n;
    const shares = 10n ** 24n;
    rpc[`${pair.address}:0x6f307dc3`] = underlying;
    rpc[`${pair.address}:0xd8dfeb45`] = collateral;
    rpc[`${pair.address}:0xcdd72d52`] =
      `0x${resupplyCorpusWord(0n)}${resupplyCorpusWord(borrow)}${resupplyCorpusWord(borrow)}${resupplyCorpusWord(shares)}`;
    rpc[`${collateral}:0x07a2d13a`] = borrow;
    rpc[`${collateral}:0x38d52e0f`] = mismatchedVault && index === 0 ? RESUPPLY_FRXUSD : underlying;
  });
  return rpc;
};
CORPUS_CASES["resupply-pairs"] = {
  coinId: "reusd-resupply",
  network: { rpc: resupplyCorpusRpc() },
  drift: {
    label: "a Curve-Lend collateral vault reports the wrong asset()",
    network: { rpc: resupplyCorpusRpc(true) },
    outcome: "error",
  },
};

// Trimmed happy path from river-protocol-info.test.ts: the protocol-info JSON
// payload plus same-run Satoshi app and branch reads for every pinned chain.
const RIVER_ENDPOINT = "https://api.riverai.inc/protocol-info";
const RIVER_CAPTURE = {
  tvl: 250_000_000,
  circulatingSupply: 159_000_000,
  tvlData: [{ timestamp: 1_776_290_400, value: 250_000_000 }],
  circulatingData: [{ timestamp: 1_776_290_400, value: 159_000_000 }],
};
const RIVER_WORD = (value: bigint) => value.toString(16).padStart(64, "0");
const RIVER_APP_BY_CHAIN: Record<string, string> = {
  ethereum: "0xb8374e4dff99202292da2fe34425e1de665b67e6",
  arbitrum: "0x07bbc5a83b83a5c440d1caedbf1081426d0aa4ec",
  base: "0x9a3c724ee9603a7550499be73dc743b371811dd3",
  bsc: "0x07bbc5a83b83a5c440d1caedbf1081426d0aa4ec",
};
const riverCorpusRpc = (): Record<string, AdapterRpcValue> => {
  const { coin } = resolveAdapterCoin("river-protocol-info", "satusd-river");
  const rpc: Record<string, AdapterRpcValue> = {};
  Object.entries(RIVER_APP_BY_CHAIN).forEach(([chain, app], index) => {
    const satUsd = coin.contracts?.find((contract) => contract.chain === chain)?.address.toLowerCase() ?? "";
    const manager = `0x${(index + 1).toString(16).padStart(40, "0")}`;
    const debt = (chain === "ethereum" ? 100_000n : 50_000n) * 10n ** 18n;
    rpc[`${app}:0xf8d89898`] = satUsd;
    rpc[`${app}:0x716c53c2`] = `0x${RIVER_WORD(10n ** 18n)}${RIVER_WORD(debt)}`;
    rpc[`${app}:0xb620115d`] = 3n * 10n ** 18n;
    rpc[`${app}:0x679df0d9`] = 1n;
    rpc[`${app}:0x3b707478`] = ({ data }) => (Number(BigInt(`0x${data.slice(10)}`)) === 0 ? manager : null);
    rpc[`${manager}:0xf8d89898`] = satUsd;
    rpc[`${manager}:0xc52861f2`] = 10n ** 18n / 200n;
    rpc[`${manager}:0x794e5724`] = 11n * 10n ** 17n;
    rpc[`${manager}:0x9484fb8e`] = false;
  });
  return rpc;
};
CORPUS_CASES["river-protocol-info"] = {
  coinId: "satusd-river",
  nowSec: 1_776_290_400 + 3_600,
  network: { json: { [RIVER_ENDPOINT]: RIVER_CAPTURE }, rpc: riverCorpusRpc() },
  drift: {
    label: "the payload tvl field is dropped",
    network: { json: { [RIVER_ENDPOINT]: { ...RIVER_CAPTURE, tvl: undefined } }, rpc: riverCorpusRpc() },
    outcome: "error",
  },
};

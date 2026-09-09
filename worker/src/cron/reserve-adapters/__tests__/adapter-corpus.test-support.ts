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
import type { AdapterNetworkSpec } from "./reserve-adapter.test-support";
import { BTCFI_HANDLER_ROWS, BTCFI_MARKET_ROWS } from "./reserve-adapter-payloads.test-support";

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
  "lista":
    "No bound catalog coin yet (retired, parked, staged or newly declared key), so there is nothing to replay; parser behaviour stays owned by lista.test.ts.",
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
  "makina-strategy":
    "No committed wire capture yet; the happy path and its failure modes are owned by makina-strategy.test.ts.",
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
  "pusd-vault":
    "No committed wire capture yet; the happy path and its failure modes are owned by pusd-vault.test.ts.",
  "quantoz-transparency":
    "No committed wire capture yet; the happy path and its failure modes are owned by quantoz-transparency.test.ts.",
  "re-metrics":
    "No committed wire capture yet; the happy path and its failure modes are owned by re-metrics.test.ts.",
  "resupply-pairs":
    "No committed wire capture yet; the happy path and its failure modes are owned by resupply-pairs.test.ts.",
  "reserve-protocol-dtf":
    "No committed wire capture yet; the happy path and its failure modes are owned by reserve-protocol-dtf.test.ts.",
  "reservoir":
    "No committed wire capture yet; the happy path and its failure modes are owned by reservoir.test.ts.",
  "ripple-transparency":
    "No committed wire capture yet; the happy path and its failure modes are owned by ripple-transparency.test.ts.",
  "sgforge-coinvertible":
    "No committed wire capture yet; the happy path and its failure modes are owned by sgforge-coinvertible.test.ts.",
  "saturn-pyusdx":
    "No committed wire capture yet; the happy path and its failure modes are owned by saturn-pyusdx.test.ts.",
  "sbc-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by sbc-independent-assurance.test.ts.",
  "solstice-attestation":
    "No committed wire capture yet; the happy path and its failure modes are owned by solstice-attestation.test.ts.",
  "single-asset":
    "No committed wire capture yet; the happy path and its failure modes are owned by single-asset.test.ts.",
  "solomon-protocol":
    "No committed wire capture yet; the happy path and its failure modes are owned by solomon-protocol.test.ts.",
  "spiko-api":
    "No committed wire capture yet; the happy path and its failure modes are owned by spiko-api.test.ts.",
  "stoneyield-router-pool":
    "No bound catalog coin yet (retired, parked, staged or newly declared key), so there is nothing to replay; parser behaviour stays owned by stoneyield-router-pool.test.ts.",
  "superstate-liquidity":
    "No committed wire capture yet; the happy path and its failure modes are owned by superstate-liquidity.test.ts.",
  "paxos-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by paxos-independent-assurance.test.ts.",
  "straitsx-independent-assurance":
    "Hash-pinned issuer report: the replayable capture is the byte-pinned PDF plus its discovery index, not a JSON/HTML wire payload; owned by its adapter test file.",
  "river-protocol-info":
    "No committed wire capture yet; the happy path and its failure modes are owned by river-protocol-info.test.ts.",
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
  "usdd-data-platform":
    "No committed wire capture yet; the happy path and its failure modes are owned by usdd-data-platform.test.ts.",
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
    "Pre-launch kUSD adapter; covered by kerne-signed-por.test.ts (legacy mock seam). Signature-verify + on-chain cross-check needs the installAdapterNetwork migration.",
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
const SGHO_SUPPLY = 1000n * 10n ** 18n;

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
  "sgho-wrapper": {
    coinId: "sgho-aave",
    network: { rpc: { "totalSupply()": SGHO_SUPPLY, "0x4cdad506": 1005n * 10n ** 18n } },
    drift: {
      label: "previewRedeem(totalSupply) stops answering",
      network: { rpc: { "totalSupply()": SGHO_SUPPLY, "0x4cdad506": null } },
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
const ASYMMETRY_ENDPOINT = "https://app.asymmetry.finance/api/stats";
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
const ASYMMETRY_FIXTURE = {
  timestamp: 1_757_000_000_000,
  usdaf: {
    total_bold_supply: "100",
    branch: { ysyBOLD: { coll_value: "60" }, scrvUSD: { coll_value: "40" } },
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
CORPUS_CASES.asymmetry = {
  coinId: "usdaf-asymmetry",
  nowSec: 1_757_003_600,
  network: { json: { [ASYMMETRY_ENDPOINT]: ASYMMETRY_FIXTURE } },
  drift: {
    label: "usdaf.total_bold_supply is dropped",
    network: { json: { [ASYMMETRY_ENDPOINT]: {
      ...ASYMMETRY_FIXTURE, usdaf: { ...ASYMMETRY_FIXTURE.usdaf, total_bold_supply: undefined },
    } } },
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

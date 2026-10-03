import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import type { ChainRpcConfig } from "../chain-registry";
import { logWorkerEventArgs } from "../structured-log";
import { recordOutcomeSafe, shouldAttemptFetch } from "../circuit-breaker";
import { readVaultRateCache, writeVaultRateCache } from "./rate-cache";
import { CIRCUIT_SOURCE } from "../constants";
import {
  buildCachedRateLiveOverride,
  buildParentDerivedLiveOverride,
  defineRegistryErc4626NavVault,
  ETHEREUM_CHAIN,
  fetchVaultAssetsPerShareViaSelector,
  PROTOCOL_REDEEM_SOURCE,
  resolveTrustedOverrideParent,
  resolveVaultAssetsPerShareWithCache,
  USDC_CIRCLE_ID,
  type CurrentPriceOverride,
  type Erc4626NavVaultConfig,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const ERC4626_CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a"; // convertToAssets(uint256)
const PREVIEW_REDEEM_SELECTOR = "0x4cdad506"; // previewRedeem(uint256)

const USDT_TETHER_ID = "usdt-tether";
const USDS_SKY_ID = "usds-sky";
const USDE_ETHENA_ID = "usde-ethena";
const AVUSD_AVANT_ID = "avusd-avant";
const GHO_AAVE_ID = "gho-aave";
const USN_NOON_ID = "usn-noon";
const YZUSD_YUZU_ID = "yzusd-yuzu";
const YUSD_AEGIS_ID = "yusd-aegis";
const AID_GAIB_ID = "aid-gaib";

// ERC-4626 vaults that should be priced from `convertToAssets(1 share)` * parent.price.
// Each entry must have a single tracked parent that already prices through normal consensus.
const ERC4626_NAV_VAULTS: readonly Erc4626NavVaultConfig[] = [
  defineRegistryErc4626NavVault({
    id: "said-gaib",
    parentId: AID_GAIB_ID,
    chain: ETHEREUM_CHAIN,
    allowFreshNonReplaySafeParent: true,
    allowFreshReplaySafeSingleSourceParent: true,
  }),
  {
    id: "susdt-spark",
    parentId: USDT_TETHER_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xe2e7a17dff93280dec073c995595155283e3c372",
    vaultDecimals: 6,
    assetDecimals: 6,
  },
  {
    id: "susdc-spark",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x28b3a8fb53b741a8fd78c0fb9a6b2393d896a43d",
    vaultDecimals: 6,
    assetDecimals: 6,
  },
  {
    id: "steakusdt-steakhouse",
    parentId: USDT_TETHER_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xbeef003c68896c7d2c3c60d363e8d71a49ab2bf9",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "steakusdc-steakhouse",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xbeef088055857739c12cd3765f20b7679def0f51",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "bbqusdc-steakhouse",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xbeefff209270748ddd194831b3fa287a5386f5bc",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  defineRegistryErc4626NavVault({
    id: "susds-sky",
    parentId: USDS_SKY_ID,
    chain: ETHEREUM_CHAIN,
  }),
  defineRegistryErc4626NavVault({
    id: "susde-ethena",
    parentId: USDE_ETHENA_ID,
    chain: ETHEREUM_CHAIN,
  }),
  {
    id: "srusde-strata",
    parentId: USDE_ETHENA_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "gtusdc-gauntlet",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xdd0f28e19c1780eb6396170735d45153d261490d",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "gtusdcp-gauntlet",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x8c106eedad96553e64287a5a6839c3cc78afa3d0",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "yvusdc-yearn",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xbe53a109b494e5c9f97b9cd39fe969be68bf6204",
    vaultDecimals: 6,
    assetDecimals: 6,
  },
  {
    id: "autousd-auto-finance",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xa7569a44f348d3d70d8ad5889e50f78e33d80d35",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "eearn-ember",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x9be9294722f8aad37b11a9792be2c782182cafa2",
    vaultDecimals: 6,
    assetDecimals: 6,
  },
  {
    id: "savusd-avant",
    parentId: AVUSD_AVANT_ID,
    chain: "avalanche",
    vault: "0x06d47f3fb376649c3a9dafe069b3d6e35572219e",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "susn-noon",
    parentId: USN_NOON_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xe24a3dc889621612422a64e6388927901608b91d",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "syzusd-yuzu",
    parentId: YZUSD_YUZU_ID,
    chain: "plasma",
    vault: "0xc8a8df9b210243c55d31c73090f06787ad0a1bf6",
    vaultDecimals: 18,
    assetDecimals: 18,
    // RPC resolved via public-rpc-registry ("plasma" entry) — no inline override needed
  },
  {
    id: "stkgho-umbrella-aave",
    parentId: GHO_AAVE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x4f827a63755855cdf3e8f3bcd20265c833f15033",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "syusd-aegis",
    parentId: YUSD_AEGIS_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xfe0ccc9942e98c963fe6b4e5194eb6e3baa4cb64",
    vaultDecimals: 18,
    assetDecimals: 18,
    allowFreshNonReplaySafeParent: true,
    allowFreshReplaySafeSingleSourceParent: true,
  },
  {
    id: "sbold-k3-capital",
    parentId: "bold-liquity",
    chain: ETHEREUM_CHAIN,
    vault: "0x50bd66d59911f5e086ec87ae43c811e0d059dd11",
    vaultDecimals: 18,
    assetDecimals: 18,
    allowFreshNonReplaySafeParent: true,
  },
  {
    id: "ybold-yearn",
    parentId: "bold-liquity",
    chain: ETHEREUM_CHAIN,
    vault: "0x9f4330700a36b29952869fac9b33f45eedd8a3d8",
    vaultDecimals: 18,
    assetDecimals: 18,
    allowFreshNonReplaySafeParent: true,
  },
  {
    id: "sirloinusdc-steakhouse",
    parentId: USDC_CIRCLE_ID,
    chain: "base",
    vault: "0xbeeff2490feffa212fac2f6553682c219e6a8845",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "susdf-falcon",
    parentId: "usdf-falcon",
    chain: ETHEREUM_CHAIN,
    vault: "0xc8cf6d7991f15525488b2a83df53468d682ba4b0",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "sreusd-resupply",
    parentId: "reusd-resupply",
    chain: ETHEREUM_CHAIN,
    vault: "0x557ab1e003951a73c12d16f0fea8490e39c33c35",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "sfrax-frax",
    parentId: "frax-frax",
    chain: ETHEREUM_CHAIN,
    vault: "0xa663b02cf0a4b149d2ad41910cb81e23e1c41c32",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "sparkusdtbc-spark",
    parentId: USDT_TETHER_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xb0c424116172b55cbb6dd3136f5989f7959e5b91",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "pendleusdc-pendle",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x55c1b6e461a6334b567baf0feb5d728715446f05",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "skymoneyusdsflagship-sky",
    parentId: USDS_SKY_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xe15fcc81118895b67b6647bbd393182df44e11e0",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "senpathusd-sentora",
    parentId: "pathusd-bridge",
    chain: "tempo",
    vault: "0x9a044ae05e5e6290dcf56afd69548565e957a626",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "skymoneyusdtsavings-sky",
    parentId: USDT_TETHER_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "krusdc-keyrock",
    parentId: USDC_CIRCLE_ID,
    chain: "arc",
    vault: "0x5befab92a5a3d60f578cb51eeb4e4fd50a1e3123",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "senpyusdpst-sentora",
    parentId: "pyusd-paypal",
    chain: ETHEREUM_CHAIN,
    vault: "0x8381a156958711e230f325428b5eb4b6555c75d9",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "senpyusdmwin-sentora",
    parentId: "pyusd-paypal",
    chain: ETHEREUM_CHAIN,
    vault: "0x7cbcfc4f64be199ede6db1d916ddcdb69f666b57",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "senrlusdv2-sentora",
    parentId: "rlusd-ripple",
    chain: ETHEREUM_CHAIN,
    vault: "0x6dc58a0fdfc8d694e571dc59b9a52eeea780e6bf",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "steakeurcv-steakhouse",
    parentId: "eurcv-societe-generale-forge",
    chain: ETHEREUM_CHAIN,
    vault: "0xbeef0c075da5d01112ae5cf34d257074fb5ddb2f",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "senpyusdmain-sentora",
    parentId: "pyusd-paypal",
    chain: ETHEREUM_CHAIN,
    vault: "0xb576765fb15505433af24fee2c0325895c559fb2",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "sparkusdc-spark",
    parentId: USDC_CIRCLE_ID,
    chain: "base",
    vault: "0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "steakusdg-steakhouse",
    parentId: "usdg-paxos",
    chain: "robinhood",
    vault: "0xbeeff033f34c046626b8d0a041844c5d1a5409dd",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "sxsrlusd-sentora",
    parentId: "rlusd-ripple",
    chain: ETHEREUM_CHAIN,
    vault: "0xfc8c624b6080a0a780583799f2a862de936f6e22",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "senpyusdprimev2-sentora",
    parentId: "pyusd-paypal",
    chain: ETHEREUM_CHAIN,
    vault: "0xc21b08c16458202593d4d9b26b9984ee67b38bbd",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "armusdcs-wintermute",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xa2eaad0d586cf9fd73bb2c09cf6a7e3e187d68cd",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "arcusdc-galaxy",
    parentId: USDC_CIRCLE_ID,
    chain: "arc",
    vault: "0x8e357432cc12ff425c36432f312968aeb16112af",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "susdc-spark-v1",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xbc65ad17c5c0a2a4d159fa5a503f4992c7b545fe",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "cscbusdc-clearstar",
    parentId: USDC_CIRCLE_ID,
    chain: "base",
    vault: "0x91c056b6d4311a743614fbc03ac32d4e6a2d3a3c",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "bbqusdc-steakhouse-v2",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xbeeff2c5bf38f90e3482a8b19f12e5a6d2fca757",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "hyperusdca-hyperithm",
    parentId: USDC_CIRCLE_ID,
    chain: "monad",
    vault: "0x78999cc96d2ba0341588c60ccb0e91c6c33cf371",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "ethenausdc-steakhouse",
    parentId: USDC_CIRCLE_ID,
    chain: "base",
    vault: "0xbeeff0be997cca5b1c13a7433c2004637975739e",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
];

const ERC4626_NAV_VAULTS_BY_ID = new Map<string, Erc4626NavVaultConfig>(
  ERC4626_NAV_VAULTS.map((entry) => [entry.id, entry]),
);

const PREVIEW_REDEEM_VAULTS_BY_ID = new Map<string, Erc4626NavVaultConfig>([
  defineRegistryErc4626NavVault({
    id: "sgho-aave",
    parentId: GHO_AAVE_ID,
    chain: ETHEREUM_CHAIN,
  }),
].map((entry) => [entry.id, entry]));

function createVaultNavProvider(input: {
  vaultsById: ReadonlyMap<string, Erc4626NavVaultConfig>;
  selector: string;
  methodLabel: string;
  logLabel: string;
  livePriority?: number;
}): PriceSourceProvider {
  return {
    source: PROTOCOL_REDEEM_SOURCE,
    liveCircuitSource: CIRCUIT_SOURCE.PROTOCOL_REDEEM,
    ...(input.livePriority != null ? { livePriority: input.livePriority } : {}),
    liveParentByAssetId: Object.fromEntries([...input.vaultsById].map(([stablecoinId, config]) => [stablecoinId, config.parentId])),
    matches(stablecoinId: string): boolean {
      return input.vaultsById.has(stablecoinId);
    },
    async fetchLivePrice(
      asset: PeggedAsset,
      context: LivePriceContext,
      signal?: AbortSignal,
    ): Promise<CurrentPriceOverride | null> {
      const config = input.vaultsById.get(asset.id);
      if (!config) return null;
      const parent = resolveTrustedOverrideParent(
        context,
        config.parentId,
        () =>
          `[authoritative-price-sources] ${asset.id}: skipped ${input.logLabel} price because parent ${config.parentId} provenance is not trusted`,
        {
          allowFreshNonReplaySafeParent: config.allowFreshNonReplaySafeParent,
          allowFreshReplaySafeSingleSourceParent: config.allowFreshReplaySafeSingleSourceParent,
        },
      );
      if (!parent) return null;
      const resolved = await resolveVaultAssetsPerShareWithCache(asset, context, () =>
        fetchVaultAssetsPerShareViaSelector(
          config,
          input.selector,
          input.methodLabel,
          "latest",
          signal,
          { throwOnNullQuote: true, chainRpcs: context.chainRpcs },
        ),
      );
      if (!resolved) return null;
      return resolved.cachedObservedAt == null
        ? buildParentDerivedLiveOverride(parent, resolved.rate)
        : buildCachedRateLiveOverride(parent, resolved.rate, resolved.cachedObservedAt);
    },
  };
}

export const erc4626NavProvider = createVaultNavProvider({
  vaultsById: ERC4626_NAV_VAULTS_BY_ID,
  selector: ERC4626_CONVERT_TO_ASSETS_SELECTOR,
  methodLabel: "convertToAssets",
  logLabel: "ERC-4626 NAV",
  livePriority: 1,
});

export const previewRedeemProvider = createVaultNavProvider({
  vaultsById: PREVIEW_REDEEM_VAULTS_BY_ID,
  selector: PREVIEW_REDEEM_SELECTOR,
  methodLabel: "previewRedeem",
  logLabel: "previewRedeem",
});

/**
 * Pre-intake supply-valuation NAV price for a tracked supplemental vault token
 * whose market price sources are gone (e.g. a CoinGecko delisting). The fiat-cg
 * supply lane needs an observed price to admit on-chain supply, but intake runs
 * before this run's enrichment prices exist, so the parent row comes from the
 * previous published payload. This reuses the exact protocol-redeem route —
 * parent-trust gate (incl. its 30-minute synced-at ceiling), live
 * convertToAssets read, and the bounded cached-rate degradation lane — so no
 * freshness policy is bypassed. The result values supply only; the live
 * override stage re-prices the published row in the same run.
 */
export async function resolveVaultNavSupplyPrice(
  stablecoinId: string,
  previousAssetsById: ReadonlyMap<string, PeggedAsset>,
  db?: D1Database,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<CurrentPriceOverride | null> {
  const config = ERC4626_NAV_VAULTS_BY_ID.get(stablecoinId);
  if (!config) return null;
  const parentAsset = previousAssetsById.get(config.parentId);
  if (!parentAsset) return null;
  if (db && !(await shouldAttemptFetch(db, CIRCUIT_SOURCE.PROTOCOL_REDEEM))) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const context: LivePriceContext = {
    assetsById: new Map([[config.parentId, { ...parentAsset }]]),
    chainRpcs,
    vaultRateCache: db ? await readVaultRateCache(db, nowSec) : undefined,
    vaultRateWrites: new Map(),
  };
  const stub: PeggedAsset = { id: stablecoinId, name: stablecoinId, symbol: stablecoinId };
  try {
    const override = await erc4626NavProvider.fetchLivePrice!(stub, context, signal);
    if (db) {
      if (override) await recordOutcomeSafe(db, CIRCUIT_SOURCE.PROTOCOL_REDEEM, true);
      if (context.vaultRateWrites!.size > 0) {
        await writeVaultRateCache(db, context.vaultRateWrites!, nowSec);
      }
    }
    return override && "price" in override ? override : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.PROTOCOL_REDEEM, false);
    logWorkerEventArgs(
      "lib",
      "warn",
      `[authoritative-price-sources] ${stablecoinId} NAV supply-price fallback failed:`,
      error,
    );
    return null;
  }
}

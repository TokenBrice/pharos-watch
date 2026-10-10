import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import type { ChainRpcConfig } from "../chain-registry";
import { logWorkerEventArgs } from "../structured-log";
import { recordOutcomeSafe, shouldAttemptFetch } from "../circuit-breaker";
import { readVaultRateCache, writeVaultRateCache } from "./rate-cache";
import { CIRCUIT_SOURCE } from "../constants";
import {
  buildCachedRateLiveOverride,
  buildParentDerivedLiveOverride,
  CACHED_VAULT_RATE_SOURCE,
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
  defineRegistryErc4626NavVault({ id: "said-gaib", parentId: AID_GAIB_ID, chain: ETHEREUM_CHAIN, allowFreshNonReplaySafeParent: true, allowFreshReplaySafeSingleSourceParent: true }),
  defineRegistryErc4626NavVault({ id: "susdt-spark", parentId: USDT_TETHER_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "susdc-spark", parentId: USDC_CIRCLE_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "steakusdt-steakhouse", parentId: USDT_TETHER_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "steakusdc-steakhouse", parentId: USDC_CIRCLE_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "bbqusdc-steakhouse", parentId: USDC_CIRCLE_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "susds-sky", parentId: USDS_SKY_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "susde-ethena", parentId: USDE_ETHENA_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "srusde-strata", parentId: USDE_ETHENA_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "gtusdc-gauntlet", parentId: USDC_CIRCLE_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "gtusdcp-gauntlet", parentId: USDC_CIRCLE_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "yvusdc-yearn", parentId: USDC_CIRCLE_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "autousd-auto-finance", parentId: USDC_CIRCLE_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "eearn-ember", parentId: USDC_CIRCLE_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "savusd-avant", parentId: AVUSD_AVANT_ID, chain: "avalanche" }),
  defineRegistryErc4626NavVault({ id: "susn-noon", parentId: USN_NOON_ID, chain: ETHEREUM_CHAIN }),
  // RPC resolved via public-rpc-registry ("plasma" entry) — no inline override needed
  defineRegistryErc4626NavVault({ id: "syzusd-yuzu", parentId: YZUSD_YUZU_ID, chain: "plasma" }),
  defineRegistryErc4626NavVault({ id: "stkgho-umbrella-aave", parentId: GHO_AAVE_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "syusd-aegis", parentId: YUSD_AEGIS_ID, chain: ETHEREUM_CHAIN, allowFreshNonReplaySafeParent: true, allowFreshReplaySafeSingleSourceParent: true }),
  defineRegistryErc4626NavVault({ id: "sbold-k3-capital", parentId: "bold-liquity", chain: ETHEREUM_CHAIN, allowFreshNonReplaySafeParent: true }),
  defineRegistryErc4626NavVault({ id: "ybold-yearn", parentId: "bold-liquity", chain: ETHEREUM_CHAIN, allowFreshNonReplaySafeParent: true }),
  defineRegistryErc4626NavVault({ id: "sirloinusdc-steakhouse", parentId: USDC_CIRCLE_ID, chain: "base" }),
  defineRegistryErc4626NavVault({ id: "susdf-falcon", parentId: "usdf-falcon", chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "sreusd-resupply", parentId: "reusd-resupply", chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "sfrax-frax", parentId: "frax-frax", chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "sparkusdtbc-spark", parentId: USDT_TETHER_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "pendleusdc-pendle", parentId: USDC_CIRCLE_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "skymoneyusdsflagship-sky", parentId: USDS_SKY_ID, chain: ETHEREUM_CHAIN }),
  // Fresh pathUSD currently has one replay-safe market leg. Inherit that
  // leg's source, single-source confidence and clock instead of upgrading it.
  defineRegistryErc4626NavVault({ id: "senpathusd-sentora", parentId: "pathusd-bridge", chain: "tempo", allowFreshReplaySafeSingleSourceParent: true }),
  defineRegistryErc4626NavVault({ id: "skymoneyusdtsavings-sky", parentId: USDT_TETHER_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "krusdc-keyrock", parentId: USDC_CIRCLE_ID, chain: "arc" }),
  defineRegistryErc4626NavVault({ id: "senpyusdpst-sentora", parentId: "pyusd-paypal", chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "senpyusdmwin-sentora", parentId: "pyusd-paypal", chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "senrlusdv2-sentora", parentId: "rlusd-ripple", chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "steakeurcv-steakhouse", parentId: "eurcv-societe-generale-forge", chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "senpyusdmain-sentora", parentId: "pyusd-paypal", chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "sparkusdc-spark", parentId: USDC_CIRCLE_ID, chain: "base" }),
  defineRegistryErc4626NavVault({ id: "steakusdg-steakhouse", parentId: "usdg-paxos", chain: "robinhood" }),
  defineRegistryErc4626NavVault({ id: "sxsrlusd-sentora", parentId: "rlusd-ripple", chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "senpyusdprimev2-sentora", parentId: "pyusd-paypal", chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "armusdcs-wintermute", parentId: USDC_CIRCLE_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "arcusdc-galaxy", parentId: USDC_CIRCLE_ID, chain: "arc" }),
  defineRegistryErc4626NavVault({ id: "susdc-spark-v1", parentId: USDC_CIRCLE_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "cscbusdc-clearstar", parentId: USDC_CIRCLE_ID, chain: "base" }),
  defineRegistryErc4626NavVault({ id: "bbqusdc-steakhouse-v2", parentId: USDC_CIRCLE_ID, chain: ETHEREUM_CHAIN }),
  defineRegistryErc4626NavVault({ id: "hyperusdca-hyperithm", parentId: USDC_CIRCLE_ID, chain: "monad" }),
  defineRegistryErc4626NavVault({ id: "ethenausdc-steakhouse", parentId: USDC_CIRCLE_ID, chain: "base" }),
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
    supportsCachedVaultRate: true,
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
  const liveAllowed = !db || await shouldAttemptFetch(db, CIRCUIT_SOURCE.PROTOCOL_REDEEM);

  const nowSec = Math.floor(Date.now() / 1000);
  const context: LivePriceContext = {
    assetsById: new Map([[config.parentId, { ...parentAsset }]]),
    chainRpcs,
    vaultRateCache: db ? await readVaultRateCache(db, nowSec) : undefined,
    vaultRateWrites: new Map(),
    vaultRateCacheOnly: !liveAllowed,
  };
  const stub: PeggedAsset = { id: stablecoinId, name: stablecoinId, symbol: stablecoinId };
  try {
    const override = await erc4626NavProvider.fetchLivePrice!(stub, context, signal);
    if (db) {
      if (liveAllowed && override) {
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.PROTOCOL_REDEEM, "source" in override && override.source !== CACHED_VAULT_RATE_SOURCE);
      }
      if (context.vaultRateWrites!.size > 0) {
        await writeVaultRateCache(db, context.vaultRateWrites!, nowSec);
      }
    }
    return override && "price" in override ? override : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (db && liveAllowed) await recordOutcomeSafe(db, CIRCUIT_SOURCE.PROTOCOL_REDEEM, false);
    logWorkerEventArgs(
      "lib",
      "warn",
      `[authoritative-price-sources] ${stablecoinId} NAV supply-price fallback failed:`,
      error,
    );
    return null;
  }
}

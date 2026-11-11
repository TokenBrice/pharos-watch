import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { decodeWhirlpool, ORCA_WHIRLPOOL_PROGRAM_ID } from "../../cron/dex-liquidity/solana/whirlpool-quote";
import { fetchSolanaAccounts, solanaPublicKey, SOLANA_TOKEN_PROGRAM } from "../chain-observation";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import { DEXSCREENER_MIN_LIQUIDITY_USD } from "../dex-liquidity/dex-cron-constants";
import { hasPublishableCurrentPrice } from "../pricing/price-publication-state";
import { validateCompositePricingSourceFreshness } from "../pricing/pricing-source-freshness";
import { resolveTrustedOverrideParent, USDC_CIRCLE_ID, type LivePriceContext, type PriceSourceProvider } from "./helpers";

const SOURCE = "orca-exact";
const POOL = "63DFX4pkJkDs4LV5s1x1Z1658rkx8yvt7MY9XXGsBMUh";
const MOVEUSD = "3AdhVEX6k85yNivHVXDEiY3WyP2WgFQTUZCahGaeC2qm";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const VAULT_A = "D9FfbH2aPw1jWX2kNhsbcsvzWGy28HfeSxLAnVuzYB1R";
const VAULT_B = "CMZGBm5ZB4dE9rGhnhWhjFJxwiAmr17mGRMuyouKpjks";
const ADDRESSES = [POOL, MOVEUSD, USDC, VAULT_A, VAULT_B];

async function fetchMoveusdOrcaPrice(context: LivePriceContext, signal?: AbortSignal) {
  const reject = (reason: string): null => { context.lastRejectionReason = `${SOURCE}:${reason}`; return null; };
  const parent = resolveTrustedOverrideParent(context, USDC_CIRCLE_ID, () => "MOVEUSD: trusted USDC unavailable",
    { allowFreshReplaySafeSingleSourceParent: true });
  if (!parent) return reject("parent-unavailable");
  try {
    const { accounts, observedBlock } = await fetchSolanaAccounts(ADDRESSES, signal ?? AbortSignal.timeout(6_000), context);
    throwIfAborted(signal);
    const poolAccount = accounts.get(POOL);
    if (!poolAccount || poolAccount.executable || poolAccount.owner !== ORCA_WHIRLPOOL_PROGRAM_ID) return reject("pool-identity");
    const pool = decodeWhirlpool(poolAccount.data, observedBlock.number);
    if (pool.tokenMintA !== MOVEUSD || pool.tokenMintB !== USDC || pool.liquidity <= 0n
      || solanaPublicKey(poolAccount.data.subarray(133, 165)) !== VAULT_A
      || solanaPublicKey(poolAccount.data.subarray(213, 245)) !== VAULT_B) return reject("pool-identity");
    const balances: number[] = [];
    for (const [mintAddress, vaultAddress] of [[MOVEUSD, VAULT_A], [USDC, VAULT_B]]) {
      const mint = accounts.get(mintAddress), vault = accounts.get(vaultAddress);
      if (!mint || mint.executable || mint.owner !== SOLANA_TOKEN_PROGRAM || mint.data.length !== 82
        || mint.data[44] !== 6 || mint.data[45] !== 1
        || !vault || vault.executable || vault.owner !== SOLANA_TOKEN_PROGRAM || vault.data.length !== 165
        || vault.data[108] !== 1 || solanaPublicKey(vault.data.subarray(0, 32)) !== mintAddress
        || solanaPublicKey(vault.data.subarray(32, 64)) !== POOL) return reject("token-identity");
      balances.push(Number(new DataView(vault.data.buffer, vault.data.byteOffset, vault.data.byteLength).getBigUint64(64, true)) / 1e6);
    }
    // Both reviewed mints have six decimals; sqrtPrice is the B/A Q64.64 mark.
    const ratio = (Number(pool.sqrtPrice) / 2 ** 64) ** 2;
    const price = ratio * parent.trustedParent.price;
    const inventoryUsd = balances[0] * price + balances[1] * parent.trustedParent.price;
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(inventoryUsd)
      || balances.some((balance) => balance <= 0) || inventoryUsd < DEXSCREENER_MIN_LIQUIDITY_USD) return reject("inventory");
    const observedAt = Math.min(observedBlock.timestamp, parent.trustedParent.observedAt);
    const now = Math.floor(Date.now() / 1000);
    const maxAge = getPricingSourceRegistryEntry(SOURCE)?.maxTrustedAgeSec ?? null;
    if (maxAge == null) return reject("dependency-age");
    if (!validateCompositePricingSourceFreshness({ ...parent.trustedParent, nowSec: now, requireObservedAt: true }).accepted
      || ![observedBlock.timestamp, parent.trustedParent.observedAt].every((time) =>
      Number.isSafeInteger(time) && time > 0 && time <= now && now - time < maxAge)) return reject("dependency-age");
    const observedAtMode = parent.trustedParent.observedAt < observedBlock.timestamp
      ? parent.trustedParent.observedAtMode ?? "upstream" : "upstream";
    return { price, source: SOURCE, confidence: "fallback" as const, observedAt, observedAtMode };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return reject("state-unavailable");
  }
}

export const moveusdOrcaProvider: PriceSourceProvider = {
  source: SOURCE, liveMissingOnly: true, livePriority: 1, liveTimeoutMs: 6_000,
  liveParentByAssetId: { "moveusd-cfx": USDC_CIRCLE_ID },
  matches: (id) => id === "moveusd-cfx",
  async fetchLivePrice(asset, context, signal) {
    return hasPublishableCurrentPrice(asset) ? null : fetchMoveusdOrcaPrice(context, signal);
  },
};

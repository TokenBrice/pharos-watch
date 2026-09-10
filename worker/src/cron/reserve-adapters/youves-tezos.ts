import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import {
  fetchDefiLlamaPrices,
  notApplicableFreshnessMetadata,
  requireJsonInput,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromValues,
} from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchTzktBigmapKeys,
  fetchTzktBigmapValue,
  fetchTzktContractStorage,
  fetchTzktHead,
} from "./tzkt";

const ADAPTER_KEY = "youves-tezos";

// Reviewed Youves mainnet identity set (2026-09-09): the uUSD token and the
// four collateral branches' engine generations. Every branch keeps its
// v1/v2 predecessors active because their vaults still mint and back uUSD;
// the census therefore enumerates all eight engines rather than the four
// latest addresses (matches the reviewed reserve sidecar's full-composition
// basis, which spans current and legacy vault contexts).
const UUSD_TOKEN = "KT1XRPEPXbZK25r3Htzp2o1x7xdMMmfocKNW";
const USDT_TOKEN = "KT1XnTn74bUtxHfDtBmm2bGZAQfhPbvKWR8o";
const TZBTC_TOKEN = "KT1PWx2mnDueood7fEmfbBDKx1D9BAnnXitn";
const SIRS_TOKEN = "KT1AafHA1C1vk959wvHWBispY9Y2f3fxBUUo";
const SIRS_LP_ORACLE = "KT1GqQqgLji2T5QMfzoAXgDt9T7ur1LhqfpD";

const UUSD_DECIMALS = 12;

const YOUVES_PROOF_KIND = "youves-tezos-vault-census";

interface YouvesEngineConfig {
  /** Slice asset key: one of `xtz`, `tzbtc`, `sirs`, `usdt`. */
  assetKey: "xtz" | "tzbtc" | "sirs" | "usdt";
  address: string;
  /** Collateral base-unit decimals (XTZ balances are mutez). */
  decimals: number;
  generation: "current" | "legacy";
}

// XTZ: KT1DHndgk8ah1MLfciDnCV2zPJrVbnnAH9fd (v2, 160% target ratio) and the
// original v1 engine. tzBTC: v2 engine, v1 engine, and the pre-v1 engine
// whose vaults the reviewed sidecar already counts. SIRS: v2 and v1 LP
// engines. USDt: the single v3 engine. XTZ vault-context balances are held
// physically by the per-vault KT1 contracts the contexts reference, not by
// the engine itself; the context balance reconciles exactly with that
// contract's XTZ balance (verified 2026-09-09).
const UUSD_ENGINES: YouvesEngineConfig[] = [
  { assetKey: "xtz", address: "KT1DHndgk8ah1MLfciDnCV2zPJrVbnnAH9fd", decimals: 6, generation: "current" },
  { assetKey: "xtz", address: "KT1FFE2LC5JpVakVjHm5mM36QVp2p3ZzH4hH", decimals: 6, generation: "legacy" },
  { assetKey: "tzbtc", address: "KT1V9Rsc4ES3eeQTr4gEfJmNhVbeHrAZmMgC", decimals: 8, generation: "current" },
  { assetKey: "tzbtc", address: "KT1HxgqnVjGy7KsSUTEsQ6LgpD5iKSGu7QpA", decimals: 8, generation: "legacy" },
  { assetKey: "tzbtc", address: "KT1XH5rKSd6Ae3DAMYi26gEZP1gxAoQRYRfS", decimals: 8, generation: "legacy" },
  { assetKey: "sirs", address: "KT1F1JMgh6SfqBCK6T6o7ggRTdeTLw91KKks", decimals: 0, generation: "current" },
  { assetKey: "sirs", address: "KT1FzcHaNhmpdYPNTgfb8frYXx7B5pvVyowu", decimals: 0, generation: "legacy" },
  { assetKey: "usdt", address: "KT1JmfujyCYTw5krfu9bSn7YbLYuz2VbNaje", decimals: 6, generation: "current" },
];

// Slice identity matches the reviewed reserve sidecar rows (the sourceKey is
// the stable join the reviewed metadata uses); risks follow the shared
// canonical reserve-asset taxonomy.
const SLICE_META: Record<YouvesEngineConfig["assetKey"], {
  name: string;
  risk: ReserveSlice["risk"];
  defillama: { chain: string; address: string };
}> = {
  xtz: { name: "XTZ (Tezos)", risk: "high", defillama: { chain: "tezos", address: "Tezos" } },
  tzbtc: { name: "tzBTC (wrapped Bitcoin)", risk: "medium", defillama: { chain: "tezos", address: TZBTC_TOKEN } },
  sirs: { name: "SIRS (XTZ/tzBTC LP tokens)", risk: "high", defillama: { chain: "tezos", address: SIRS_TOKEN } },
  usdt: { name: "USDt (Tether on Tezos)", risk: "low", defillama: { chain: "tezos", address: USDT_TOKEN } },
};

function parseBigmapPointer(storage: Record<string, unknown>, field: string): number {
  const value = storage[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${ADAPTER_KEY}: engine storage field ${field} is not a non-negative bigmap pointer`);
  }
  return value;
}

function parseUnsignedIntegerString(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(`${ADAPTER_KEY}: ${label} is not a non-negative integer string: ${String(value).slice(0, 32)}`);
  }
  return BigInt(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${ADAPTER_KEY}: ${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function toTokens(raw: bigint, decimals: number): number {
  const tokens = Number(raw) / 10 ** decimals;
  if (!Number.isFinite(tokens)) {
    throw new Error(`${ADAPTER_KEY}: token amount overflows the number range`);
  }
  return tokens;
}

export interface YouvesEngineCensusRow {
  address: string;
  generation: "current" | "legacy";
  vaultCount: number;
  collateralRaw: string;
  mintedRaw: string;
}

export interface YouvesTezosState {
  head: { level: number; timestamp: string };
  supplyTokens: number;
  /** Sum of all engines' storage total_supply (vault-originated uUSD). */
  engineMintedTokens: number;
  engineRows: YouvesEngineCensusRow[];
  collateralTokens: Record<YouvesEngineConfig["assetKey"], number>;
  sirsTzbtcRatio: number;
  prices: Record<"xtz" | "tzbtc" | "usdt" | "uusd", number>;
}

/** Adapts a complete pinned census into the adapter result; exported for tests. */
export function adaptYouvesTezosState(state: YouvesTezosState): AdapterResult {
  const warnings: LiveReserveWarning[] = [];

  const values: Record<YouvesEngineConfig["assetKey"], number> = {
    xtz: state.collateralTokens.xtz * state.prices.xtz,
    tzbtc: state.collateralTokens.tzbtc * state.prices.tzbtc,
    usdt: state.collateralTokens.usdt * state.prices.usdt,
    // SIRS is valued through the reviewed on-chain LP path: the SIRS LP
    // reserve ratio (tzBTC atomic units per SIRS) times the tzBTC price.
    sirs: state.collateralTokens.sirs * (state.sirsTzbtcRatio / 10 ** 8) * state.prices.tzbtc,
  };
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${ADAPTER_KEY}: ${key} collateral valuation is not finite and non-negative`);
    }
  }

  const totalReserveUsd = Object.values(values).reduce((sum, value) => sum + value, 0);
  if (!(totalReserveUsd > 0)) {
    throw new Error(`${ADAPTER_KEY}: no priced collateral value could be measured`);
  }

  const totalLiabilitiesUsd = state.supplyTokens * state.prices.uusd;
  const collateralizationRatio = totalLiabilitiesUsd > 0 ? totalReserveUsd / totalLiabilitiesUsd : undefined;
  if (collateralizationRatio != null && collateralizationRatio < 1) {
    warnings.push(reserveDegradedWarning(
      "reserve-undercollateralized",
      `${ADAPTER_KEY}: engine collateral covers ${(collateralizationRatio * 100).toFixed(2)}% of market-valued uUSD supply`,
    ));
  }

  warnings.push(reserveInfoWarning(
    "xtz-vault-contract-custody",
    `${ADAPTER_KEY}: XTZ vault collateral is recorded in engine vault contexts and physically held by the per-vault KT1 contracts those contexts reference (engine contracts hold no XTZ); the context balance reconciles exactly with the vault contract's XTZ balance`,
  ));

  const slices = slicesFromValues(
    (Object.keys(SLICE_META) as YouvesEngineConfig["assetKey"][]).map((assetKey) => ({
      sourceKey: `${ADAPTER_KEY}:${assetKey}`,
      name: SLICE_META[assetKey].name,
      value: values[assetKey],
      risk: SLICE_META[assetKey].risk,
    })),
    4,
  );

  const details = {
    proofKind: YOUVES_PROOF_KIND,
    chainId: "tezos",
    level: state.head.level,
    levelTimestampIso: state.head.timestamp,
    engines: state.engineRows,
    uusdSupply: {
      supplyTokens: state.supplyTokens,
      engineMintedTokens: state.engineMintedTokens,
      nonVaultOriginatedSupplyTokens: Math.max(0, state.supplyTokens - state.engineMintedTokens),
    },
    sirsLpRatio: state.sirsTzbtcRatio,
    prices: state.prices,
  };

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata(details),
      observedBlock: {
        chain: "tezos",
        number: state.head.level,
        timestamp: Math.floor(Date.parse(state.head.timestamp) / 1_000),
      },
      totalReserveUsd,
      totalLiabilitiesUsd,
      supplyTokens: state.supplyTokens,
      supplyUsd: totalLiabilitiesUsd,
      ...(collateralizationRatio !== undefined ? { collateralizationRatio } : {}),
    },
  };
}

/**
 * Reads the Youves uUSD (uusd-youves) collateral census directly off TzKT at
 * one pinned Tezos level: the uUSD token's total supply, the eight engines'
 * vault-context collateral sums (XTZ, tzBTC, SIRS, USDt), and the on-chain
 * SIRS LP reserve ratio. Collateral and the uUSD liability are valued with
 * DefiLlama quotes; the adapter fails closed when any of the four collateral
 * assets or uUSD lacks a qualified quote, so an `independent` snapshot only
 * publishes when every material collateral has a supported valuation path.
 */
export async function fetchYouvesTezosReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, ADAPTER_KEY);
  const baseUrl = new URL(input.url).origin;

  // Pin the level once; every storage/bigmap read below is at that level.
  const head = await fetchTzktHead(baseUrl, signal, ctx);

  // uUSD supply: the token contract keeps a per-token-id total_supply bigmap.
  const tokenStorage = requireRecord(
    await fetchTzktContractStorage(baseUrl, UUSD_TOKEN, head.level, signal, ctx),
    "uUSD token storage",
  );
  const supplyBigmapId = parseBigmapPointer(tokenStorage, "total_supply");
  const supplyRaw = await fetchTzktBigmapValue(baseUrl, supplyBigmapId, "0", head.level, signal, ctx);
  const supplyTokens = toTokens(parseUnsignedIntegerString(supplyRaw, "uUSD total supply"), UUSD_DECIMALS);
  if (!(supplyTokens > 0)) {
    throw new Error(`${ADAPTER_KEY}: uUSD total supply must be positive`);
  }

  // Engine census: storage identity + vault-context collateral per engine.
  const collateralRaw = new Map<YouvesEngineConfig["assetKey"], bigint>();
  const engineRows: YouvesEngineCensusRow[] = [];
  let engineMintedRaw = 0n;
  for (const engine of UUSD_ENGINES) {
    const storage = requireRecord(
      await fetchTzktContractStorage(baseUrl, engine.address, head.level, signal, ctx),
      `engine storage (${engine.address})`,
    );
    if (storage.token_contract !== UUSD_TOKEN) {
      throw new Error(
        `${ADAPTER_KEY}: engine ${engine.address} token_contract is ${String(storage.token_contract)}, expected the uUSD token ${UUSD_TOKEN}`,
      );
    }
    const mintedRaw = parseUnsignedIntegerString(storage.total_supply, `engine total_supply (${engine.address})`);
    const bigmapId = parseBigmapPointer(storage, "vault_contexts");
    const keys = await fetchTzktBigmapKeys(baseUrl, bigmapId, head.level, signal, ctx);
    let balanceRaw = 0n;
    for (const entry of keys) {
      balanceRaw += parseUnsignedIntegerString(entry.value.balance, `vault balance (${engine.address}, ${entry.key})`);
    }
    collateralRaw.set(engine.assetKey, (collateralRaw.get(engine.assetKey) ?? 0n) + balanceRaw);
    engineMintedRaw += mintedRaw;
    engineRows.push({
      address: engine.address,
      generation: engine.generation,
      vaultCount: keys.length,
      collateralRaw: balanceRaw.toString(),
      mintedRaw: mintedRaw.toString(),
    });
  }

  const engineMintedTokens = toTokens(engineMintedRaw, UUSD_DECIMALS);
  if (supplyTokens < engineMintedTokens) {
    throw new Error(
      `${ADAPTER_KEY}: uUSD token supply (${supplyTokens}) is below the sum of engine total_supply (${engineMintedTokens})`,
    );
  }

  // SIRS valuation path: the reviewed SIRS LP oracle exposes the tzBTC
  // reserve per SIRS token at the pinned level.
  const oracle = requireRecord(
    await fetchTzktContractStorage(baseUrl, SIRS_LP_ORACLE, head.level, signal, ctx),
    "SIRS LP oracle storage",
  );
  if (oracle.lp_token_address !== SIRS_TOKEN || oracle.value_token_address !== TZBTC_TOKEN) {
    throw new Error(`${ADAPTER_KEY}: SIRS LP oracle token addresses do not match the reviewed SIRS/tzBTC pair`);
  }
  const valueTokenBalance = parseUnsignedIntegerString(oracle.value_token_balance_of, "SIRS LP value_token_balance_of");
  const lptTotalSupply = parseUnsignedIntegerString(oracle.lpt_total_supply, "SIRS LP lpt_total_supply");
  if (lptTotalSupply === 0n) {
    throw new Error(`${ADAPTER_KEY}: SIRS LP total supply is zero`);
  }
  const sirsTzbtcRatio = Number(valueTokenBalance) / Number(lptTotalSupply);
  if (!Number.isFinite(sirsTzbtcRatio) || sirsTzbtcRatio <= 0) {
    throw new Error(`${ADAPTER_KEY}: SIRS LP ratio is not finite and positive`);
  }

  // DefiLlama valuation for every material asset plus the uUSD liability.
  const warnings: LiveReserveWarning[] = [];
  const priceMap = await fetchDefiLlamaPrices(
    [
      { key: "xtz", ...SLICE_META.xtz.defillama },
      { key: "tzbtc", ...SLICE_META.tzbtc.defillama },
      { key: "usdt", ...SLICE_META.usdt.defillama },
      { key: "uusd", chain: "tezos", address: UUSD_TOKEN },
    ],
    signal,
    ctx,
    warnings,
  );
  const requirePrice = (key: string): number => {
    const price = priceMap.get(key);
    if (price == null || !Number.isFinite(price) || price <= 0) {
      throw new Error(`${ADAPTER_KEY}: no qualified DefiLlama price for ${key}; cannot value every material collateral`);
    }
    return price;
  };

  const collateralTokens = {
    xtz: toTokens(collateralRaw.get("xtz") ?? 0n, 6),
    tzbtc: toTokens(collateralRaw.get("tzbtc") ?? 0n, 8),
    sirs: toTokens(collateralRaw.get("sirs") ?? 0n, 0),
    usdt: toTokens(collateralRaw.get("usdt") ?? 0n, 6),
  };

  return adaptYouvesTezosState({
    head,
    supplyTokens,
    engineMintedTokens,
    engineRows,
    collateralTokens,
    sirsTzbtcRatio,
    prices: {
      xtz: requirePrice("xtz"),
      tzbtc: requirePrice("tzbtc"),
      usdt: requirePrice("usdt"),
      uusd: requirePrice("uusd"),
    },
  });
}

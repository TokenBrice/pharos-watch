import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import { getCirculatingRaw } from "@shared/lib/supply";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../../lib/stablecoins-cache";
import {
  fetchDefiLlamaPrices,
  notApplicableFreshnessMetadata,
  requireJsonInput,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromValues,
} from "./helpers";
import { createKoiosReader, type KoiosAddressView, type KoiosUtxo } from "./koios";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "djed-cardano";
const DJED_PROOF_KIND = "djed-cardano-bank-utxo";
const ADA_DECIMALS = 6;

// The Djed bank UTxO is the single script output holding the ADA reserve, the
// unissued DJED/SHEN stock, and exactly one DjedStableCoinNFT marker minted
// under the same policy as DJED (per the open-djed registry and the pinned
// Djed reserve script address in the reviewed sidecar).
const DJED_POOL_NFT_NAME_HEX = "446a6564537461626c65436f696e4e4654";

type DjedCardanoParams = LiveReserveAdapterParamsByKey[typeof ADAPTER_KEY];

interface DjedReadState {
  bank: KoiosAddressView;
  djedMinted: bigint;
  shenMinted: bigint | null;
  adaPriceUsd: number | undefined;
  djedPriceUsd: number | undefined;
  listCirculating: number | undefined;
}

function unitOf(unit: { policyId: string; assetNameHex: string }): [string, string] {
  return [unit.policyId, unit.assetNameHex];
}

function unitMatches(asset: { policyId: string; assetNameHex: string }, unit: {
  policyId: string;
  assetNameHex: string;
}): boolean {
  return asset.policyId === unit.policyId && asset.assetNameHex === unit.assetNameHex;
}

function sumUnitQuantity(utxos: KoiosUtxo[], unit: { policyId: string; assetNameHex: string }): bigint {
  let total = 0n;
  for (const utxo of utxos) {
    for (const asset of utxo.assets) {
      if (unitMatches(asset, unit)) total += asset.quantity;
    }
  }
  return total;
}

function decimalUnits(raw: bigint, decimals: number): number {
  const units = Number(raw) / 10 ** decimals;
  if (!Number.isFinite(units) || units < 0) {
    throw new Error(`${ADAPTER_KEY}: unit conversion overflow for ${raw.toString()}`);
  }
  return units;
}

function findPoolNftUtxo(utxos: KoiosUtxo[], djedPolicyId: string): KoiosUtxo {
  const holders = utxos.filter((utxo) =>
    utxo.assets.some(
      (asset) =>
        asset.policyId === djedPolicyId &&
        asset.assetNameHex === DJED_POOL_NFT_NAME_HEX &&
        asset.quantity === 1n,
    ),
  );
  if (holders.length !== 1) {
    throw new Error(
      `${ADAPTER_KEY}: bank address must hold exactly one DjedStableCoinNFT marker UTxO (found ${holders.length})`,
    );
  }
  return holders[0]!;
}

function adaptDjedCardanoState(
  state: DjedReadState,
  params: DjedCardanoParams,
): AdapterResult {
  const warnings: LiveReserveWarning[] = [];
  const poolNftUtxo = findPoolNftUtxo(state.bank.utxos, params.djedUnit.policyId);

  // ── ADA reserve (whole address balance; the bank UTxO carries the bulk) ──
  const reserveAda = decimalUnits(state.bank.balanceLovelace, ADA_DECIMALS);
  if (!(reserveAda > 0)) {
    throw new Error(`${ADAPTER_KEY}: bank address holds no ADA`);
  }
  const bankAda = decimalUnits(poolNftUtxo.lovelace, ADA_DECIMALS);

  // ── DJED liabilities: minted stock minus unissued stock in the bank ──────
  const djedBankStock = sumUnitQuantity(state.bank.utxos, params.djedUnit);
  if (djedBankStock > state.djedMinted) {
    throw new Error(
      `${ADAPTER_KEY}: bank DJED stock ${djedBankStock} exceeds minted supply ${state.djedMinted}`,
    );
  }
  const djedCirculatingRaw = state.djedMinted - djedBankStock;
  const djedCirculating = decimalUnits(djedCirculatingRaw, params.djedUnit.decimals);
  if (!(djedCirculating > 0)) {
    throw new Error(`${ADAPTER_KEY}: DJED circulating supply is not positive`);
  }

  // ── Supply reconciliation (diagnostic; never replaces the on-chain liability) ──
  // The bank census is a mint/burn liability; the DefiLlama list `circulating`
  // is the market-cap denominator. They may legitimately diverge (e.g. DJED
  // held in non-bank wallets), so drift is flagged, not reconciled.
  const listCirculating = state.listCirculating;
  const supplyDivergence = listCirculating != null && listCirculating > 0
    ? {
        listCirculatingUnits: listCirculating,
        supplyDivergencePct: (Math.abs(djedCirculating - listCirculating) / listCirculating) * 100,
        supplyDerivation: `${ADAPTER_KEY}: on-chain liability = djedMinted − djedBankStock; list = DefiLlama list circulating via getCirculatingRaw`,
      }
    : undefined;
  if (supplyDivergence && supplyDivergence.supplyDivergencePct > 10) {
    warnings.push(reserveDegradedWarning(
      "djed-supply-divergence",
      `${ADAPTER_KEY}: on-chain circulating ${djedCirculating.toFixed(2)} DJED diverges ${supplyDivergence.supplyDivergencePct.toFixed(2)}% from the DefiLlama list circulating ${supplyDivergence.listCirculatingUnits.toFixed(2)} DJED`,
    ));
  }

  // ── SHEN stock (junior equity diagnostic; not required for the slice) ────
  let shenCirculating: number | null = null;
  if (params.shenUnit && state.shenMinted != null) {
    const shenBankStock = sumUnitQuantity(state.bank.utxos, params.shenUnit);
    if (shenBankStock > state.shenMinted) {
      throw new Error(
        `${ADAPTER_KEY}: bank SHEN stock ${shenBankStock} exceeds minted supply ${state.shenMinted}`,
      );
    }
    shenCirculating = decimalUnits(state.shenMinted - shenBankStock, params.shenUnit.decimals);
  }

  // ── Extraneous assets: anything not ADA/DJED/SHEN/pool NFT ───────────────
  const extraneous: string[] = [];
  for (const utxo of state.bank.utxos) {
    for (const asset of utxo.assets) {
      const isPoolNft =
        asset.policyId === params.djedUnit.policyId &&
        asset.assetNameHex === DJED_POOL_NFT_NAME_HEX;
      const isDjed = unitMatches(asset, params.djedUnit);
      const isShen = params.shenUnit ? unitMatches(asset, params.shenUnit) : false;
      if (!isPoolNft && !isDjed && !isShen) {
        extraneous.push(`${asset.policyId}.${asset.assetNameHex}:${asset.quantity}`);
      }
    }
  }
  if (extraneous.length > 0) {
    warnings.push(reserveInfoWarning(
      "extraneous-bank-assets",
      `${ADAPTER_KEY}: the Djed bank address also holds ${extraneous.join(", ")}; these are not protocol reserve assets and are excluded from valuation`,
    ));
  }

  // ── Valuation ─────────────────────────────────────────────────────────────
  if (state.adaPriceUsd == null) {
    throw new Error(`${ADAPTER_KEY}: no live ADA/USD price could be fetched`);
  }
  if (state.djedPriceUsd == null) {
    throw new Error(`${ADAPTER_KEY}: no live DJED/USD price could be fetched`);
  }
  const djedPriceUsd = state.djedPriceUsd;
  const totalReserveUsd = reserveAda * state.adaPriceUsd;
  const totalLiabilitiesUsd = djedCirculating * djedPriceUsd;
  const collateralizationRatio = totalLiabilitiesUsd > 0 ? totalReserveUsd / totalLiabilitiesUsd : undefined;

  if (collateralizationRatio != null && collateralizationRatio < 1) {
    warnings.push(reserveDegradedWarning(
      "reserve-undercollateralized",
      `${ADAPTER_KEY}: the bank ADA reserve covers ${(collateralizationRatio * 100).toFixed(2)}% of circulating DJED at the live market price`,
    ));
  }

  const shareholderEquityUsd = Math.max(0, totalReserveUsd - totalLiabilitiesUsd);

  const slices = slicesFromValues([
    {
      sourceKey: `${ADAPTER_KEY}:ada`,
      name: "ADA reserves in the Cardano Djed contract",
      value: totalReserveUsd,
      risk: "high" as const,
      assetClass: "cryptoasset" as const,
    },
  ]);

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: DJED_PROOF_KIND,
        bankAddress: state.bank.address,
      }),
      totalReserveUsd,
      totalReserveQuantity: reserveAda,
      totalLiabilitiesUsd,
      supplyTokens: djedCirculating,
      supplyUsd: totalLiabilitiesUsd,
      ...(collateralizationRatio !== undefined ? { collateralizationRatio } : {}),
      ...(shareholderEquityUsd > 0 ? { shareholderEquityUsd } : {}),
      details: {
        proofKind: DJED_PROOF_KIND,
        bankAddress: state.bank.address,
        reserveAda,
        bankUtxoAda: bankAda,
        adaPriceUsd: state.adaPriceUsd,
        djedPriceUsd,
        djedMintedUnits: decimalUnits(state.djedMinted, params.djedUnit.decimals),
        djedBankStockUnits: decimalUnits(djedBankStock, params.djedUnit.decimals),
        djedCirculatingUnits: djedCirculating,
        ...(supplyDivergence ?? {}),
        ...(shenCirculating != null ? { shenCirculatingUnits: shenCirculating } : {}),
        extraneousAssets: extraneous,
      },
    },
  };
}

export async function fetchDjedCardanoReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, ADAPTER_KEY);
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const baseUrls = [
    input.url,
    ...(config.inputs.fallbacks ?? []).filter((fallback) => fallback.kind === "http-json").map(
      (fallback) => fallback.url,
    ),
  ];

  const listCirculating = await loadDjedListCirculating(coin, ctx);

  let lastError: unknown = null;
  for (const baseUrl of baseUrls) {
    try {
      return await readDjedAttempt(baseUrl, params, signal, ctx, listCirculating);
    } catch (error) {
      lastError = error;
      if (signal.aborted) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function loadDjedListCirculating(
  coin: StablecoinMeta,
  ctx: AdapterContext | undefined,
): Promise<number | undefined> {
  if (!ctx?.db) return undefined;
  try {
    const cached = await loadStablecoinsCache(ctx.db, { mode: "lenient", contract: "critical-fields" });
    const supplyCoin = hasUsableStablecoinsPayload(cached)
      && cached.updatedAt != null
      && (ctx.nowSec ?? Math.floor(Date.now() / 1000)) - cached.updatedAt <= 7200
      ? cached.payload.peggedAssets.find((asset) => asset.id === coin.id)
      : undefined;
    const circulating = supplyCoin ? getCirculatingRaw(supplyCoin) : 0;
    return Number.isFinite(circulating) && circulating > 0 ? circulating : undefined;
  } catch {
    return undefined;
  }
}

async function readDjedAttempt(
  baseUrl: string,
  params: DjedCardanoParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  listCirculating: number | undefined,
): Promise<AdapterResult> {
  const reader = await createKoiosReader(baseUrl, signal, ctx);
  const units: Array<[string, string]> = [unitOf(params.djedUnit)];
  if (params.shenUnit) units.push(unitOf(params.shenUnit));

  const [bankRows, assetRows] = await Promise.all([
    reader.addressInfo([params.bankAddress]),
    reader.assetInfo(units),
  ]);
  const bank = bankRows[0]!;
  const assetsByUnit = new Map<string, (typeof assetRows)[number]>(
    assetRows.map((row) => [`${row.policyId}${row.assetNameHex}`, row]),
  );
  const djedRow = assetsByUnit.get(`${params.djedUnit.policyId}${params.djedUnit.assetNameHex}`);
  if (!djedRow) {
    throw new Error(`${ADAPTER_KEY}: DJED unit is missing from the asset_info response`);
  }
  const shenRow = params.shenUnit
    ? assetsByUnit.get(`${params.shenUnit.policyId}${params.shenUnit.assetNameHex}`) ?? null
    : null;

  const priceMap = await fetchDefiLlamaPrices(
    [
      { key: "ADA", chain: "coingecko", address: "cardano" },
      { key: "DJED", chain: "coingecko", address: "djed" },
    ],
    signal,
    ctx,
    [],
  );

  const result = adaptDjedCardanoState(
    {
      bank,
      djedMinted: djedRow.totalSupply,
      shenMinted: shenRow?.totalSupply ?? null,
      adaPriceUsd: priceMap.get("ADA"),
      djedPriceUsd: priceMap.get("DJED"),
      listCirculating,
    },
    params,
  );

  // Stamp the pinned tip into the returned metadata (the reader wrote it to
  // the attempt context, but the adapter owns the snapshot's own copy).
  return {
    ...result,
    metadata: {
      ...result.metadata,
      observedBlock: { chain: "cardano", number: reader.tip.blockNo, timestamp: reader.tip.blockTimeSec },
      details: {
        ...(result.metadata?.details ?? {}),
        tipBlockNo: reader.tip.blockNo,
        tipBlockTimeSec: reader.tip.blockTimeSec,
      },
    },
  };
}

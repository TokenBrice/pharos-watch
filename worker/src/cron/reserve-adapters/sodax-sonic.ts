import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { CHAIN_META } from "@shared/lib/chains";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { keccak256, toFunctionSelector } from "viem/utils";
import { encodeAddress } from "../../lib/evm-selectors";
import { mapWithConcurrency } from "../../lib/concurrency";
import { rethrowIfAborted } from "../../lib/abort";
import { fetchEvmCodeAtBlock } from "../../lib/evm-rpc";
import { runAdapterIo } from "./concurrency";
import { decodeAbiWordAt, decodeStrictAddressArrayWord, decodeStrictAddressWord, decodeUint256Word } from "./abi-decode";
import { pinnedBlockPlan } from "./evm-observation-plan";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildUnknownExposureWarning, decimalNumberFromBigInt, fetchDefiLlamaPrices, fetchErc20TotalSupply,
  fetchJsonWithRetry, fetchOnchainMulticall3, fetchTronErc20TotalSupply,
  notApplicableFreshnessMetadata, requireOnchainInput, reserveDegradedWarning,
  reserveInfoWarning, slicesFromValues, type OnchainMulticall3Call,
} from "./helpers";

const KEY = "sodax-sonic";
const POOL = "0x553434896d39f867761859d0fe7189d2af70514e";
const PROVIDER = "0x036ade0abaa4c82445cb7597f2d6d6130c118c7b";
const DEBT_RESERVE = "0x94dc79ce9c515ba4ae4d195da8e6ab86c69bfc38";
const BORROWERS_URL = `https://api.sodax.com/v1/be/moneymarket/asset/${DEBT_RESERVE}/borrowers`;
const ZERO = `0x${"0".repeat(40)}`;
// At most 128 active borrowers × 40 reserves plus timestamps: eight 650-call
// pages, four two-operation waves. Discovery uses two preceding batches.
const MAX_BORROWERS = 128;
const MAX_RESERVES = 40;
const PAGE_SIZE = 650;
const MAX_ORACLE_AGE = 3600;

// Verified immutable deployments. RedemptionOracle.latestTimestamp() reverts
// because its fixed USD leg has no timestamp; its immutable rate-feed address
// supplies the only changing input. Runtime hashes include those addresses.
const FIXED_USD_SOURCE = "0x79fa150c700adeaf618475e8cb17933e7a9c3214";
const REVIEWED_ORACLES: Record<string, { codeHash: string; timestampSource?: string }> = {
  [FIXED_USD_SOURCE]: { codeHash: "0x3f722a77e8764527b3b6da1448fd137c51d6a96904ef1a141ceafb7bf48cd77a" },
  "0xaa782030432ca2e00c2db56f357343910da553e2": { codeHash: "0xb80d402ab3d543729be462895b0fcf2d9959954d8542bb37421375b4193a881d" },
  "0x703a296d260f02c412c401bdfdc2848ed57de5ee": { codeHash: "0x94706370817fad4f3a2edfa2b9b926207efdd0fdcc3b539cdb3d21ab6a808b3d" },
  "0x270e3677f93709ba67411b4273a1dfddf9aa689b": {
    codeHash: "0xdff0a2a8377b53f48672c4940d52e73f9fc1a79ac091a6197c23a532bf1f9353",
    timestampSource: "0x68c63bde21d281cc1aa7cedfd6aa1c5aea7f22c8",
  },
  "0x7c97cd6bf7fa9e4a21ba23ef0d8202e5409df6f2": {
    codeHash: "0x178a7f2ad4a153136c4ceb41f2b79b46ef8d19ef2ba66d4301859c50dbe6a6c5",
    timestampSource: "0xf3d83b7271df2d63368c8b5824a5fd39bfb3041d",
  },
};

// Address identities, not a fixed reserve census: every pool reserve is read.
// Unknown new reserves remain visible and quantified without a guessed coinId.
const IDENTITIES: Record<string, { symbol: string; risk: ReserveSlice["risk"]; coinId?: string }> = {
  "0x0902b2bc326ab373be4fe20605690b0422998685": { symbol: "sodasftUSD", risk: "medium", coinId: "ftusd-flying-tulip" },
  "0xabbb91c0617090f0028bdc27597cd0d038f3a833": { symbol: "sodaUSDC", risk: "low", coinId: "usdc-circle" },
  "0xbdf1f453fcb61424011bbddcb96cfdb30f3fe876": { symbol: "sodaUSDT", risk: "low", coinId: "usdt-tether" },
  "0xd806e60e3929c7f62ce22f9b132801ae98dd1cd8": { symbol: "sodahyTB", risk: "medium" },
  "0x7a1a5555842ad2d0ed274d09b5c4406a95799d5d": { symbol: "sodaBTC", risk: "medium" },
  "0x40cd41b35db9e5109ae7e54b44de8625db320e6b": { symbol: "sodaBNB", risk: "high" },
  "0x14238d267557e9d799016ad635b53cd15935d290": { symbol: "sodaAVAX", risk: "high" },
  "0xdc5b4b00f98347e95b9f94911213dab4c687e1e3": { symbol: "sodaSUI", risk: "high" },
  "0x4effb5813271699683c25c734f4dabc45b363709": { symbol: "sodaETH", risk: "very-low" },
  "0x21685e341de7844135329914be6bd8d16982d834": { symbol: "sodaSODA", risk: "very-high" },
  "0xcb6b152d3a943f25157381afca7fefcd2ef5a357": { symbol: "sodaWEETH", risk: "low" },
  "0x6e81124fc5d2bf666b16a0a5d90066ebf35c7411": { symbol: "sodaHYPE", risk: "high" },
  "0xdea692287e2ce8cb08fa52917be0f16b1dacdc87": { symbol: "sodaSOL", risk: "high" },
  "0x58b0538d7eeaee69ef32f9f1de5cbf32a10a977b": { symbol: "sodaWSTETH", risk: "low" },
};

function query(label: string, contract: string, signature: string, address?: string): OnchainMulticall3Call {
  return { label, contract, data: toFunctionSelector(signature) + (address ? encodeAddress(address) : ""), allowFailure: true };
}
function uint(raw: string | undefined, label: string): bigint {
  const value = decodeUint256Word(raw);
  if (value == null) throw new Error(`${KEY}: unreadable ${label}`);
  return value;
}
function address(raw: string | null | undefined, label: string): string {
  const value = decodeStrictAddressWord(raw);
  if (!value || value === ZERO) throw new Error(`${KEY}: unreadable ${label}`);
  return value.toLowerCase();
}

/**
 * Resolve DefiLlama quotes for the fixed-constant oracle legs (immutable
 * MockAggregator, constant 1e8) keyed by reserve address. Legs without a
 * tracked coin/geckoId are skipped and fall back to the reviewed constant.
 */
async function fetchFixedConstantLegPrices(
  reserves: Array<{ reserve: string }>,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  warnings: LiveReserveWarning[],
): Promise<Map<string, number>> {
  const lookups: Array<{ key: string; chain: string; address: string }> = [];
  for (const { reserve } of reserves) {
    const coinId = IDENTITIES[reserve]?.coinId;
    const geckoId = coinId ? TRACKED_META_BY_ID.get(coinId)?.geckoId : undefined;
    if (!geckoId) continue;
    lookups.push({ key: reserve, chain: "coingecko", address: geckoId });
  }
  if (lookups.length === 0) return new Map();
  return fetchDefiLlamaPrices(lookups, signal, ctx, warnings);
}

export async function fetchSodaxSonicReserves(
  coin: StablecoinMeta, config: LiveReservesConfig, signal: AbortSignal, ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, KEY);
  if (input.chain !== "sonic") throw new Error(`${KEY}: only Sonic is supported`);
  const baseCtx = ctx;
  const plan = await pinnedBlockPlan({ chain: input.chain, signal, ctx });
  ctx = plan.ctx;
  const batch = async (calls: OnchainMulticall3Call[]): Promise<Map<string, string>> => {
    const pages: OnchainMulticall3Call[][] = [];
    for (let i = 0; i < calls.length; i += PAGE_SIZE) pages.push(calls.slice(i, i + PAGE_SIZE));
    if (pages.length > 8) throw new Error(`${KEY}: observation budget exceeded`);
    const results = await mapWithConcurrency(pages, 2, async (page) => {
      const result = await fetchOnchainMulticall3({ calls: page, chain: input.chain, signal, ctx, multicallBatchSize: PAGE_SIZE });
      if (!result || result.length !== page.length) throw new Error(`${KEY}: incomplete Multicall3 page`);
      return result;
    }, { signal });
    return new Map(results.flat().filter((r) => r.success).map((r) => [r.label, r.returnData]));
  };
  const [head, candidates] = await Promise.all([
    batch([
      query("reserves", POOL, "getReservesList()"),
      query("debtReserve", POOL, "getReserveData(address)", DEBT_RESERVE),
      query("oracle", PROVIDER, "getPriceOracle()"),
      query("sonicSupply", DEBT_RESERVE, "totalSupply()"),
    ]),
    fetchJsonWithRetry<{ borrowers: string[]; total: number }>(`${BORROWERS_URL}?offset=0&limit=${MAX_BORROWERS}`, signal, 10_000, ctx),
  ]);
  if (!Array.isArray(candidates.borrowers) || !Number.isInteger(candidates.total)
      || candidates.total !== candidates.borrowers.length || candidates.total < 1 || candidates.total > MAX_BORROWERS
      || candidates.borrowers.some((b) => typeof b !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(b) || b.toLowerCase() === ZERO)) {
    throw new Error(`${KEY}: incomplete or oversized borrower candidate page`);
  }
  const borrowers = candidates.borrowers.map((b) => b.toLowerCase());
  if (new Set(borrowers).size !== borrowers.length) throw new Error(`${KEY}: duplicate borrower candidates`);
  const reserves = decodeStrictAddressArrayWord(head.get("reserves"), { maxItems: MAX_RESERVES })?.map((r) => r.toLowerCase());
  if (!reserves?.length || new Set(reserves).size !== reserves.length || reserves.includes(ZERO) || !reserves.includes(DEBT_RESERVE)) {
    throw new Error(`${KEY}: invalid pool reserve census`);
  }
  if (decodeStrictAddressWord(decodeAbiWordAt(head.get("debtReserve"), 9)) !== ZERO) {
    throw new Error(`${KEY}: stable-debt issuance would invalidate the variable-debt-only census`);
  }
  const debtToken = address(decodeAbiWordAt(head.get("debtReserve"), 10), "variable debt token");
  const oracle = address(head.get("oracle"), "pool oracle");
  const discovery = await batch([
    query("scaledTotal", debtToken, "scaledTotalSupply()"),
    query("baseUnit", oracle, "BASE_CURRENCY_UNIT()"),
    ...borrowers.map((b) => query(`debt:${b}`, debtToken, "scaledBalanceOf(address)", b)),
    ...reserves.flatMap((r) => [
      query(`reserve:${r}`, POOL, "getReserveData(address)", r),
      query(`price:${r}`, oracle, "getAssetPrice(address)", r),
      query(`source:${r}`, oracle, "getSourceOfAsset(address)", r),
    ]),
  ]);
  const debts = borrowers.map((b) => uint(discovery.get(`debt:${b}`), `scaled debt ${b}`));
  const scaledTotal = uint(discovery.get("scaledTotal"), "scaled debt supply");
  // Aave variable debt is non-transferable and scaled accounting has no interest
  // rounding drift. Exact conservation proves the API omitted no positive holder.
  if (scaledTotal <= 0n || debts.reduce((sum, debt) => sum + debt, 0n) !== scaledTotal) {
    throw new Error(`${KEY}: borrower census incomplete: scaled debt does not reconcile`);
  }
  const activeBorrowers = borrowers.filter((_, i) => debts[i] > 0n);
  const baseUnit = uint(discovery.get("baseUnit"), "oracle base unit");
  if (baseUnit !== 100_000_000n) throw new Error(`${KEY}: unexpected USD oracle base unit`);
  const reserveData = reserves.map((r) => {
    const raw = discovery.get(`reserve:${r}`);
    const configuration = uint(decodeAbiWordAt(raw, 0) ?? undefined, `reserve configuration ${r}`);
    const decimals = Number((configuration >> 48n) & 255n);
    if (decimals > 36) throw new Error(`${KEY}: invalid reserve decimals ${r}`);
    return {
      reserve: r, decimals, aToken: address(decodeAbiWordAt(raw, 8), `aToken ${r}`),
      source: decodeStrictAddressWord(discovery.get(`source:${r}`))?.toLowerCase() ?? ZERO,
      price: uint(discovery.get(`price:${r}`), `oracle price ${r}`),
    };
  });
  const sourceAddresses = [...new Set(reserveData.map((r) => r.source).filter((s) => s !== ZERO))];
  const reviewedSources = sourceAddresses.filter((s) => REVIEWED_ORACLES[s]);
  if (reviewedSources.some((s) => REVIEWED_ORACLES[s].timestampSource) && !reviewedSources.includes(FIXED_USD_SOURCE)) reviewedSources.push(FIXED_USD_SOURCE);
  await mapWithConcurrency(reviewedSources, 2, async (source) => {
    const code = await runAdapterIo(ctx, `sodax-oracle-code:${source}`, () =>
      fetchEvmCodeAtBlock(input.chain, source, plan.observedBlock.number, { signal, chainRpcs: ctx?.chainRpcs }));
    if (!code || keccak256(code) !== REVIEWED_ORACLES[source].codeHash) throw new Error(`${KEY}: reviewed oracle code drift ${source}`);
  }, { signal });
  const observations = await batch([
    ...sourceAddresses.filter((s) => !REVIEWED_ORACLES[s] || REVIEWED_ORACLES[s].timestampSource)
      .map((s) => query(`timestamp:${s}`, REVIEWED_ORACLES[s]?.timestampSource ?? s, "latestTimestamp()")),
    ...reserveData.flatMap((r) => activeBorrowers.map((b) => query(`balance:${r.reserve}:${b}`, r.aToken, "balanceOf(address)", b))),
  ]);
  const warnings: LiveReserveWarning[] = [];

  // Immutable MockAggregator legs (constant 1e8) never track market price;
  // value them with the live DefiLlama quote and keep the reviewed constant
  // only as a flagged fallback.
  const fixedConstantReserves = reserveData.filter((r) => r.source === FIXED_USD_SOURCE);
  const fixedConstantPrices = await fetchFixedConstantLegPrices(fixedConstantReserves, signal, ctx, warnings);

  let unknownUsd = 0;
  const priceSources: Array<{ reserve: string; symbol?: string; kind: "defillama" | "oracle"; priceInsensitive: boolean }> = [];
  const values = reserveData.map((r) => {
    const balance = activeBorrowers.reduce((sum, b) => sum + uint(observations.get(`balance:${r.reserve}:${b}`), `collateral ${r.reserve}/${b}`), 0n);
    if (balance === 0n) return null;
    const reviewed = REVIEWED_ORACLES[r.source];
    if (!reviewed || reviewed.timestampSource) {
      const timestamp = uint(observations.get(`timestamp:${r.source}`), `oracle timestamp ${r.reserve}`);
      if (timestamp <= 0n || timestamp > BigInt(plan.observedBlock.timestamp + 600)) throw new Error(`${KEY}: invalid oracle timestamp ${r.reserve}`);
      if (BigInt(plan.observedBlock.timestamp) - timestamp > BigInt(MAX_ORACLE_AGE)) {
        warnings.push(reserveDegradedWarning("sodax-oracle-stale", `Oracle price for ${r.reserve} is older than one hour`));
      }
    }
    const identity = IDENTITIES[r.reserve];

    // Prefer a live DefiLlama quote for fixed-constant legs; the immutable
    // constant remains only as a flagged, reviewed fallback. A zero/unreadable
    // oracle price with no quote still fails closed (missing USD denominator).
    const defiLlamaPrice = r.source === FIXED_USD_SOURCE ? fixedConstantPrices.get(r.reserve) : undefined;
    let value: number;
    let priceInsensitive = false;
    if (defiLlamaPrice != null) {
      value = decimalNumberFromBigInt(balance, r.decimals) * defiLlamaPrice;
    } else if (r.price > 0n) {
      value = decimalNumberFromBigInt(balance * r.price, r.decimals + 8);
      priceInsensitive = r.source === FIXED_USD_SOURCE;
    } else {
      throw new Error(`${KEY}: unpriced positive reserve ${r.reserve}`);
    }
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${KEY}: invalid reserve valuation ${r.reserve}`);
    priceSources.push({
      reserve: r.reserve,
      ...(identity ? { symbol: identity.symbol } : {}),
      kind: defiLlamaPrice != null ? "defillama" : "oracle",
      priceInsensitive,
    });
    if (!identity) unknownUsd += value;
    return {
      value, sourceKey: `${KEY}:${r.reserve}`,
      name: identity ? `${identity.symbol} borrower collateral` : `Unmapped SODAX reserve ${r.reserve}`,
      risk: identity?.risk ?? "high" as const,
      ...(identity?.coinId ? { coinId: identity.coinId, depType: "collateral" as const } : {}),
    };
  }).filter((v) => v !== null);
  const totalReserveUsd = values.reduce((sum, v) => sum + v.value, 0);
  if (totalReserveUsd <= 0) throw new Error(`${KEY}: no positive borrower collateral`);
  const unknownExposurePct = unknownUsd / totalReserveUsd * 100;
  if (unknownExposurePct > 0) warnings.push(buildUnknownExposureWarning({ adapterKey: KEY, code: "sodax-unmapped-reserve", message: "Unmapped SODAX reserve exposure", unknownExposurePct }));

  // Cross-chain supplies are diagnostics until every registered deployment is
  // readable. Never turn the partial EVM sum into an authoritative denominator.
  const contracts = coin.contracts ?? [];
  const supplyReads = await mapWithConcurrency(contracts, 2, async (contract) => {
    if ((CHAIN_META[contract.chain]?.type !== "evm" && contract.chain !== "tron") || contract.decimals == null) {
      return { contract, raw: null, omitted: true };
    }
    try {
      const raw = contract.chain === "tron"
        ? await fetchTronErc20TotalSupply(contract.address, signal, baseCtx)
        : await fetchErc20TotalSupply({ ...input, chain: contract.chain }, contract.address, signal, { ...baseCtx, observedBlock: undefined });
      return { contract, raw, omitted: false };
    } catch (error) {
      rethrowIfAborted(error, signal);
      return { contract, raw: null, omitted: false };
    }
  }, { signal });
  for (const entry of supplyReads.filter((s) => s.raw == null)) {
    warnings.push(entry.omitted
      ? reserveInfoWarning("por-supply-chain-omitted", `Supply on ${entry.contract.chain} is not covered; no collateralization ratio is published`)
      : reserveDegradedWarning("sodax-supply-read-failed", `Supply read failed on ${entry.contract.chain}`));
  }
  warnings.push(reserveInfoWarning("supply-inventory-unverified", "The coin's Balanced v1 transition notice identifies a historical v1 contract inventory; Sonic v2 liabilities remain unverified"));
  const observedSupply = supplyReads.reduce((sum, s) => sum + (s.raw == null ? 0 : decimalNumberFromBigInt(s.raw, s.contract.decimals!)), 0);
  return {
    slices: slicesFromValues(values, 6), warnings,
    metadata: {
      ...notApplicableFreshnessMetadata({ proofKind: "sodax-scaled-debt-reconciled-collateral" }),
      observedBlock: plan.observedBlock, totalReserveUsd, unknownExposurePct,
      supplyCoverageComplete: false,
      details: {
        borrowerCensusComplete: true, borrowerCandidateCount: borrowers.length,
        activeBorrowerCount: activeBorrowers.length, reserveCount: reserves.length,
        scaledDebtSupply: scaledTotal.toString(), observedSupply,
        sonicFacilitatorSupply: decimalNumberFromBigInt(uint(head.get("sonicSupply"), "Sonic facilitator supply"), 18),
        omittedSupplyChains: supplyReads.filter((s) => s.raw == null).map((s) => s.contract.chain),
        supplyInventory: "Historical v1 deployments; Sonic v2 global issuance inventory has not been reviewed",
        borrowerDiscovery: "API candidates reconciled exactly to pinned non-transferable scaled debt supply",
        priceSources,
      },
    },
  };
}

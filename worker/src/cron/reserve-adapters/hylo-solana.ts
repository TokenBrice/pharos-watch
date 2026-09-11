import type { StablecoinMeta, ReserveSlice } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import { fetchSolanaAccounts, solanaPublicKey, type SolanaAccount } from "./solana";
import { fetchDefiLlamaPrices, notApplicableFreshnessMetadata, reserveDegradedWarning, slicesFromValues } from "./helpers";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const LUT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
// Anchor exchange IDL v2.0.5: fixed Borsh layouts, including reserved tails.
const LAYOUTS = {
  hylo: { size: 511, discriminator: [114, 161, 169, 210, 204, 175, 149, 174] },
  lst: { size: 211, discriminator: [125, 135, 217, 151, 122, 202, 138, 59] },
  exo: { size: 405, discriminator: [251, 244, 72, 181, 40, 119, 232, 48] },
  usdc: { size: 173, discriminator: [130, 97, 194, 78, 22, 254, 137, 107] },
};
function view(data: Uint8Array) { return new DataView(data.buffer, data.byteOffset, data.byteLength); }
function key(data: Uint8Array, offset: number) { return solanaPublicKey(data.subarray(offset, offset + 32)); }
function fixed(data: Uint8Array, offset: number): number {
  const v = view(data);
  const exp = v.getInt8(offset + 8);
  if (exp < -18 || exp > 18) throw new Error("Hylo invalid fixed-point exponent");
  const value = Number(v.getBigUint64(offset, true)) * 10 ** exp;
  if (!Number.isFinite(value)) throw new Error("Hylo nonfinite accounting value");
  return value;
}
function paused(data: Uint8Array, offset: number): boolean {
  if (data[offset] !== 0 && data[offset] !== 1) throw new Error("Hylo invalid pause flag");
  return data[offset] === 1;
}
function account(accounts: Map<string, SolanaAccount | null>, address: string, owner: string): Uint8Array {
  const value = accounts.get(address);
  if (!value || value.owner !== owner) throw new Error(`Hylo missing account or owner mismatch: ${address}`);
  return value.data;
}
function anchor(accounts: Map<string, SolanaAccount | null>, address: string, owner: string, kind: keyof typeof LAYOUTS) {
  const data = account(accounts, address, owner);
  const layout = LAYOUTS[kind];
  if (data.length !== layout.size || !layout.discriminator.every((byte, i) => data[i] === byte)) throw new Error(`Hylo ${kind} discriminator/layout mismatch`);
  return data;
}
function registry(data: Uint8Array) {
  if (data.length < 56 + 16 * 32 || (data.length - 56 - 16 * 32) % 128 !== 0 || data.length > 56 + 80 * 32 || view(data).getUint32(0, true) !== 1 || view(data).getBigUint64(4, true) !== 0xffffffffffffffffn) throw new Error("Hylo invalid/deactivated LST registry LUT");
  const blocks: Array<{ header: string; mint: string; vault: string; poolState: string }> = [];
  for (let offset = 56 + 16 * 32; offset < data.length; offset += 128) blocks.push({ header: key(data, offset), mint: key(data, offset + 32), vault: key(data, offset + 64), poolState: key(data, offset + 96) });
  if (!blocks.length || new Set(blocks.map((b) => b.mint)).size !== blocks.length) throw new Error("Hylo empty/duplicate LST registry");
  return blocks;
}
function mintDecimals(accounts: Map<string, SolanaAccount | null>, mint: string): number {
  const data = account(accounts, mint, TOKEN_PROGRAM);
  if (data.length !== 82 || data[45] !== 1 || data[44] > 18) throw new Error("Hylo invalid SPL mint");
  return data[44];
}
function balance(accounts: Map<string, SolanaAccount | null>, vault: string, mint: string): number {
  const data = account(accounts, vault, TOKEN_PROGRAM);
  if (data.length !== 165 || key(data, 0) !== mint || (data[108] !== 1 && data[108] !== 2)) throw new Error("Hylo invalid SPL vault/mint identity");
  return Number(view(data).getBigUint64(64, true)) / 10 ** mintDecimals(accounts, mint);
}

export async function fetchHyloSolanaReserves(_coin: StablecoinMeta, config: LiveReservesConfig, signal: AbortSignal, ctx?: AdapterContext): Promise<AdapterResult> {
  if (config.inputs.primary.kind !== "onchain-solana") throw new Error("hylo-solana requires onchain-solana input");
  const p = parseLiveReserveAdapterParams("hylo-solana", config.params);
  const discovery = await fetchSolanaAccounts([p.registry], signal, ctx);
  const discoveredRegistry = account(discovery.accounts, p.registry, LUT_PROGRAM);
  const blocks = registry(discoveredRegistry);
  const lsts = blocks.map((block) => {
    const mapping = p.lsts.find((lst) => lst.mint === block.mint);
    if (!mapping) throw new Error(`Hylo unknown LST mint: ${block.mint}`);
    return { ...block, ...mapping };
  });
  const addresses = [...new Set([p.state, p.registry, p.hyusdMint, p.usdcPair, p.usdcVault, p.usdcMint, ...p.inactiveExoPairs, ...p.exoPairs.flatMap((pair) => [pair.pair, pair.vault, pair.mint]), ...lsts.flatMap((lst) => [lst.header, lst.mint, lst.vault])])];
  const census = await fetchSolanaAccounts(addresses, signal, ctx, discovery.observedBlock.number);
  const accounts = census.accounts;
  const currentRegistry = account(accounts, p.registry, LUT_PROGRAM);
  if (currentRegistry.length !== discoveredRegistry.length || !currentRegistry.every((byte, i) => byte === discoveredRegistry[i])) throw new Error("Hylo registry changed during discovery");
  const state = anchor(accounts, p.state, p.program, "hylo");
  if (key(state, 72) !== p.registry || key(state, 104) !== p.hyusdMint || key(state, 392) !== p.solOracle) throw new Error("Hylo state identity mismatch");
  for (const address of p.inactiveExoPairs) if (accounts.get(address) !== null) throw new Error("Hylo unreviewed exogenous pair activated");
  const warnings: LiveReserveWarning[] = [];
  let isPaused = paused(state, 478) || paused(state, 479);
  const prices = await fetchDefiLlamaPrices([
    ...lsts.map((lst) => ({ key: lst.mint, chain: lst.priceChain, address: lst.priceAddress })),
    ...p.exoPairs.map((pair) => ({ key: pair.mint, chain: "coingecko", address: pair.priceAddress })),
    { key: p.usdcMint, chain: "coingecko", address: "usd-coin" },
  ], signal, ctx, warnings);
  const price = (mint: string) => { const value = prices.get(mint); if (value === undefined || !Number.isFinite(value) || value <= 0) throw new Error(`Hylo missing collateral price: ${mint}`); return value; };
  const lstBreakdown = lsts.map((lst) => {
    const header = anchor(accounts, lst.header, p.program, "lst");
    if (key(header, 8) !== lst.mint || key(header, 40) !== lst.vault || key(header, 72) !== lst.poolState) throw new Error("Hylo LST header identity mismatch");
    const amount = balance(accounts, lst.vault, lst.mint);
    const priceSol = fixed(header, 122);
    if (priceSol <= 0) throw new Error("Hylo invalid LST SOL conversion");
    return { mint: lst.mint, name: lst.name, amount, priceSol, valueUsd: amount * price(lst.mint) };
  });
  let liabilities = fixed(state, 433);
  const values: Array<Omit<ReserveSlice, "pct"> & { value: number }> = [{ sourceKey: "hylo-solana:lst-pool", name: "SOL LST pool collateral", risk: "high", value: lstBreakdown.reduce((sum, lst) => sum + lst.valueUsd, 0) }];
  for (const pair of p.exoPairs) {
    const data = anchor(accounts, pair.pair, p.program, "exo");
    const feedId = Array.from(data.subarray(76, 108), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (key(data, 8) !== pair.mint || key(data, 44) !== pair.oracle || feedId !== pair.feedId) throw new Error("Hylo exogenous pair mint/oracle identity mismatch");
    isPaused = paused(data, 286) || isPaused;
    liabilities += fixed(data, 134);
    values.push({ sourceKey: `hylo-solana:${pair.pool}`, name: pair.name, risk: "high", value: balance(accounts, pair.vault, pair.mint) * price(pair.mint) });
  }
  const usdc = anchor(accounts, p.usdcPair, p.program, "usdc");
  isPaused = paused(usdc, 45) || isPaused;
  liabilities += fixed(usdc, 36);
  const usdcValue = balance(accounts, p.usdcVault, p.usdcMint) * price(p.usdcMint);
  values.push({ sourceKey: "hylo-solana:usdc-pool", name: "USDC pool collateral", risk: "low", coinId: "usdc-circle", depType: "collateral", value: usdcValue });
  const decimals = mintDecimals(accounts, p.hyusdMint);
  const supply = Number(view(account(accounts, p.hyusdMint, TOKEN_PROGRAM)).getBigUint64(36, true)) / 10 ** decimals;
  const total = values.reduce((sum, row) => sum + row.value, 0);
  if (!(total > 0) || !Number.isFinite(total)) throw new Error("Hylo no measurable collateral");
  if (isPaused) warnings.push(reserveDegradedWarning("route-paused", "Hylo protocol or isolated pool is paused"));
  if (supply <= 0) warnings.push(reserveDegradedWarning("non-positive-liabilities", "Hylo reports zero hyUSD supply"));
  else {
    if (total < supply) warnings.push(reserveDegradedWarning("reserve-undercollateralized", "Hylo collateral value is below hyUSD supply"));
    if (Math.abs(liabilities - supply) > Math.max(1, supply * 0.000001)) throw new Error("Hylo pool liabilities do not reconcile to hyUSD mint supply");
  }
  const slices = slicesFromValues(values, 4).filter((slice) => slice.pct > 0);
  return { slices, warnings, metadata: {
    ...notApplicableFreshnessMetadata({ proofKind: "hylo-solana-atomic-account-census", lstBreakdown, poolLiabilities: liabilities, hyusdSupply: supply, liabilityReconciliationDelta: liabilities - supply, usdcDustExcludedUsd: slices.some((slice) => slice.sourceKey === "hylo-solana:usdc-pool") ? 0 : usdcValue, exoInventoryScope: "SDK reviewed cbBTC/HYPE plus four inactive candidates; unknown activation fails closed" }),
    observedBlock: census.observedBlock, totalCollateralUsd: total, ...(supply > 0 ? { collateralizationRatio: total / supply } : {}),
  } };
}

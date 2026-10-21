import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { programAddress, publicKeyBytes } from "../dex-liquidity/solana/program-address";
import { buildCoverageShortfallWarnings, notApplicableFreshnessMetadata, reserveInfoWarning } from "./helpers";
import { fetchSolanaAccountsWithPrograms, readSolanaMint, scaledSolanaRawAmount, solanaPublicKey, SOLANA_TOKEN_2022_PROGRAM } from "./solana";
import type { AdapterContext, AdapterResult } from "./types";

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const M_MINT = "mzerojk9tg56ebsrEAhfkyc9VgKjTW2zDqp6C5mhjzH";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const GLOBAL_DISCRIMINATOR = [116, 209, 219, 83, 70, 143, 55, 127]; // account:ExtGlobalV2

/** Exact Borsh ExtGlobalV2 NoYield layout, including variable pending-admin option. */
export function decodeM0SolanaGlobal(data: Uint8Array) {
  if (data.length < 145 || !GLOBAL_DISCRIMINATOR.every((byte, i) => data[i] === byte)) throw new Error("M0 Solana global discriminator/layout mismatch");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pending = data[40];
  if (pending !== 0 && pending !== 1) throw new Error("M0 Solana pending-admin option invalid");
  let cursor = 41 + pending * 32;
  const wrapperMint = solanaPublicKey(data.subarray(cursor, cursor + 32)); cursor += 32;
  const underlyingMint = solanaPublicKey(data.subarray(cursor, cursor + 32)); cursor += 32;
  cursor += 32; // m_earn_global_account, not a separately observed asset
  if (cursor + 8 > data.length) throw new Error("M0 Solana global truncated");
  cursor += 3; // stored PDA bumps; the actual PDA addresses are rederived below
  if (data[cursor++] !== 0) throw new Error("M0 Solana only reviewed NoYield accounting is supported");
  const authorities = view.getUint32(cursor, true); cursor += 4;
  if (authorities > 1024 || cursor + authorities * 32 > data.length) throw new Error("M0 Solana wrap-authority census incomplete");
  cursor += authorities * 32;
  // ExtGlobalV2 allocates space for Some even while pending_admin is None.
  if (data.length - cursor > (pending === 0 ? 32 : 0)) throw new Error("M0 Solana global trailing layout mismatch");
  for (; cursor < data.length; cursor++) if (data[cursor] !== 0) throw new Error("M0 Solana global nonempty padding");
  return { wrapperMint, underlyingMint, authorities };
}

export async function fetchM0SolanaWrapperReserves(coin: ReserveAdapterCoin, config: LiveReservesConfig, signal: AbortSignal, ctx?: AdapterContext): Promise<AdapterResult> {
  if (config.inputs.primary.kind !== "onchain-solana") throw new Error("m0-solana-wrapper requires onchain-solana input");
  const p = parseLiveReserveAdapterParams("m0-solana-wrapper", config.params);
  if (p.underlyingMint !== M_MINT) throw new Error("M0 Solana underlying mint is not the reviewed native M identity");
  const contracts = coin.contracts?.filter((contract) => contract.chain === "solana") ?? [];
  if (contracts.length !== 1 || coin.contracts?.length !== 1 || contracts[0].address !== p.wrapperMint || contracts[0].decimals !== 6) throw new Error("M0 Solana exact local mint/deployment identity mismatch");
  const encoder = new TextEncoder();
  const [globalAddress, vaultAuthority, mintAuthority, programData] = await Promise.all([
    programAddress(p.program, [encoder.encode("global")]),
    programAddress(p.program, [encoder.encode("m_vault")]),
    programAddress(p.program, [encoder.encode("mint_authority")]),
    programAddress(LOADER, [publicKeyBytes(p.program)]),
  ]);
  const vaultAddress = await programAddress(ASSOCIATED_TOKEN_PROGRAM, [publicKeyBytes(vaultAuthority), publicKeyBytes(SOLANA_TOKEN_2022_PROGRAM), publicKeyBytes(p.underlyingMint)]);
  if (globalAddress !== p.globalAccount || vaultAddress !== p.underlyingVault) throw new Error("M0 Solana configured PDA/vault identity mismatch");
  const addresses = [p.program, globalAddress, p.wrapperMint, p.underlyingMint, vaultAddress];
  const census = await fetchSolanaAccountsWithPrograms(addresses, [p.program], signal, ctx);
  const now = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
  const observedAt = census.observedBlock.timestamp;
  if (observedAt > now || now - observedAt > 2 * CRON_INTERVALS["sync-stablecoins"]) throw new Error("M0 Solana finalized bank observation is stale or future");
  const program = census.accounts.get(p.program);
  if (!program?.executable || program.owner !== LOADER || program.data.length !== 36 || new DataView(program.data.buffer, program.data.byteOffset, program.data.byteLength).getUint32(0, true) !== 2 || solanaPublicKey(program.data.subarray(4)) !== programData) throw new Error("M0 Solana executable program/loader identity mismatch");
  const state = census.accounts.get(globalAddress);
  if (!state || state.owner !== p.program) throw new Error("M0 Solana global owner mismatch");
  const global = decodeM0SolanaGlobal(state.data);
  if (global.wrapperMint !== p.wrapperMint || global.underlyingMint !== p.underlyingMint) throw new Error("M0 Solana global mint binding mismatch");
  const wrapperAccount = census.accounts.get(p.wrapperMint);
  const underlyingAccount = census.accounts.get(p.underlyingMint);
  if (wrapperAccount?.owner !== SOLANA_TOKEN_2022_PROGRAM || underlyingAccount?.owner !== SOLANA_TOKEN_2022_PROGRAM) throw new Error("M0 Solana Token-2022 mint owner mismatch");
  const wrapper = readSolanaMint(wrapperAccount, observedAt);
  const underlying = readSolanaMint(underlyingAccount, observedAt);
  if (wrapper.mintAuthority !== mintAuthority || wrapper.decimals !== 6 || underlying.decimals !== 6 || wrapper.multiplier !== 1 || !underlying.scaledUi) throw new Error("M0 Solana mint authority/unit accounting mismatch");
  const vault = census.accounts.get(vaultAddress);
  if (!vault || vault.owner !== SOLANA_TOKEN_2022_PROGRAM || vault.data.length < 166 || vault.data[165] !== 2 || solanaPublicKey(vault.data.subarray(0, 32)) !== p.underlyingMint || solanaPublicKey(vault.data.subarray(32, 64)) !== vaultAuthority || (vault.data[108] !== 1 && vault.data[108] !== 2)) throw new Error("M0 Solana custody account identity/state mismatch");
  const principal = new DataView(vault.data.buffer, vault.data.byteOffset, vault.data.byteLength).getBigUint64(64, true);
  const backing = scaledSolanaRawAmount(principal, underlying.multiplier);
  const liabilities = wrapper.rawSupply;
  if (liabilities <= 0n || backing <= 0n) throw new Error("M0 Solana local backing or minted liabilities nonpositive");
  const coverage = Number(backing) / Number(liabilities);
  const warnings = buildCoverageShortfallWarnings({ code: "reserve-undercollateralized", message: (pct) => `M0 Solana indexed local M custody covers ${pct}% of the local wrapper mint`, coverageRatio: coverage });
  warnings.push(reserveInfoWarning("m0-local-wrapper-scope", "Local finalized mint and M-vault observation only; no upstream bridge escrow, global in-flight liabilities, executable redemption, program source equivalence or financial assurance is established."));
  return {
    slices: [{ sourceKey: "m0-solana-wrapper:m-vault", name: p.assetLabel, pct: 100, risk: "low", coinId: "m-m0", depType: "wrapper", assetClass: "stablecoin" }],
    warnings,
    metadata: {
      ...notApplicableFreshnessMetadata({ proofKind: "m0-solana-finalized-local-wrapper", program: p.program, programData, globalAccount: globalAddress, vaultAuthority, mintAuthority, underlyingVault: vaultAddress, underlyingMint: p.underlyingMint, programSourceEquivalence: "unverified", upstreamLiabilityScope: "not-observed" }),
      observedBlock: census.observedBlock,
      totalSupplyRaw: liabilities.toString(), wrapperDecimals: 6,
      underlyingBalanceRaw: principal.toString(), indexedUnderlyingBalanceRaw: backing.toString(), underlyingDecimals: 6,
      underlyingMultiplier: underlying.multiplier,
      collateralizationRatio: coverage,
      unknownExposurePct: 0,
    },
  };
}

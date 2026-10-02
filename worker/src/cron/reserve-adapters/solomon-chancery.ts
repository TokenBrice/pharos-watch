import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonAdapterInput,
  parseDigitString,
  parseFiniteNumber,
  parseTimestampLikeToUnixSeconds,
  requireRecord,
  reserveInfoWarning,
  slicesFromValues,
  verifiedFreshnessMetadata,
} from "./helpers";

const USDV_MINT = "USDvUSpnhCr9yBgj3UyVrD239HRUv4RsHwH2FxsWuMk";
const RESERVE_AUTHORITY = "8anxfyoftY9hPwxdvReet2beFS2HXjcXraPEamo4nGyB";
const VALUATION = "Known stablecoins valued at USD 1 per token";
const RESERVE_ASSETS: Record<string, { symbol: string; vault: string; coinId: string }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    symbol: "USDC", vault: "DsqFVh7MTDpj5P7pv95zyBMihVhctUh7o76E46M3bsr2", coinId: "usdc-circle",
  },
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": {
    symbol: "USDG", vault: "6gXnsjMkrgC7zKsniUFPasEnPRVSecH3AwoKWjUTdXHg", coinId: "usdg-paxos",
  },
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": {
    symbol: "PYUSD", vault: "BPjKgsrV45B2QXgarVHc7oEE39oBqTcdYU8BK2EFNMde", coinId: "pyusd-paypal",
  },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: {
    symbol: "USDT", vault: "7Dv22TUWgaeTJcXtW8KNhrXkSBVaT8Cvrg3yr2cb1kRC", coinId: "usdt-tether",
  },
};

/** Selected Chancery PDA account mix only; never whole-book financial assurance. */
export function adaptSolomonChanceryBacking(payload: unknown): AdapterResult {
  const envelope = requireRecord(payload, "solomon-chancery invalid envelope");
  if (envelope.status !== "available") throw new Error("solomon-chancery backing unavailable");
  const data = requireRecord(envelope.data, "solomon-chancery missing data");
  if (data.mint !== USDV_MINT || data.reserveAuthority !== RESERVE_AUTHORITY) {
    throw new Error("solomon-chancery replacement mint or reserve authority identity mismatch");
  }
  if (data.valuation !== VALUATION) throw new Error("solomon-chancery valuation basis changed");
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(data.asOf);
  if (sourceTimestamp == null || data.asOf !== envelope.sourceAt) {
    throw new Error("solomon-chancery missing or inconsistent reserve source timestamp");
  }
  if (!Array.isArray(data.holdings) || data.holdings.length !== Object.keys(RESERVE_ASSETS).length) {
    throw new Error("solomon-chancery reserve inventory changed");
  }
  const seen = new Set<string>();
  const values: Array<{ value: number } & Omit<ReserveSlice, "pct">> = [];
  let total = 0;
  for (const item of data.holdings) {
    const row = requireRecord(item, "solomon-chancery invalid holding");
    const mint = typeof row.mint === "string" ? row.mint : "";
    const asset = Object.prototype.hasOwnProperty.call(RESERVE_ASSETS, mint) ? RESERVE_ASSETS[mint] : undefined;
    if (!asset || seen.has(mint) || row.symbol !== asset.symbol || row.vaultAddress !== asset.vault) {
      throw new Error("solomon-chancery reserve asset identity mismatch or duplicate");
    }
    seen.add(mint);
    const amount = parseFiniteNumber(row.amount, { label: "solomon-chancery amount", min: 0 });
    const amountUsd = parseFiniteNumber(row.amountUsd, { label: "solomon-chancery amountUsd", min: 0 });
    const raw = parseDigitString(row.amountRaw, "solomon-chancery invalid raw amount");
    if (raw > BigInt(Number.MAX_SAFE_INTEGER) || amount !== amountUsd || (raw === 0n ? amount !== 0 : row.decimals !== 6 || Math.abs(Number(raw) / 1e6 - amount) > 1e-6)) {
      throw new Error("solomon-chancery raw amount or par valuation mismatch");
    }
    total += amountUsd;
    if (amountUsd === 0) continue;
    values.push({
      sourceKey: `chancery:reserve:${asset.symbol.toLowerCase()}`,
      name: `${asset.symbol} in the Chancery reserve-authority token account`,
      value: amountUsd,
      risk: "low",
      coinId: asset.coinId,
      depType: "collateral",
      blacklistable: true,
    });
  }
  const sourceTotal = parseFiniteNumber(data.totalUsd, { label: "solomon-chancery totalUsd", min: 0 });
  if (!(sourceTotal > 0) || Math.abs(total - sourceTotal) > 1e-6) {
    throw new Error("solomon-chancery reserve total does not reconcile");
  }
  return {
    slices: slicesFromValues(values, null),
    warnings: [reserveInfoWarning(
      "selected-reserve-scope",
      "Issuer-reported Chancery PDA accounts only; off-account assets, liabilities and encumbrances are not reconciled. Stablecoins are valued at nominal USD 1, not market prices.",
    )],
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      totalReserveUsd: sourceTotal,
      details: {
        mint: USDV_MINT,
        reserveAuthority: RESERVE_AUTHORITY,
        scope: "selected-reserve-authority-accounts",
        valuation: VALUATION,
        financialAssurance: false,
      },
    },
  };
}

export async function fetchSolomonChanceryReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  if (!coin.contracts?.some((contract) => contract.chain === "solana" && contract.address === USDV_MINT && contract.decimals === 6)) {
    throw new Error("solomon-chancery configured coin is not the replacement mint");
  }
  const payload = await fetchJsonAdapterInput<unknown>(config, "solomon-chancery", signal, 12_000, ctx);
  return adaptSolomonChanceryBacking(payload);
}

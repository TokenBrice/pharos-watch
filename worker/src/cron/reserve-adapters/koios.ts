import { z } from "zod";
import { fetchJsonPostWithRetry, fetchJsonWithRetry } from "./helpers";
import type { AdapterContext } from "./types";

/**
 * Bounded Koios (Cardano public query API) transport for reserve adapters.
 *
 * Every reader pins the chain tip first (`GET /tip`) and stamps the attempt
 * context with `observedBlock = { chain: "cardano", number, timestamp }`, so
 * address/UTxO reads made through the reader carry a same-run latest-state
 * anchor even though Koios cannot replay a historical block. Read shapes are
 * strict-validated; an address with an unexpectedly large UTxO set or a
 * missing requested asset row fails closed rather than truncating a census.
 */

const TIP_MAX_AGE_SEC = 20 * 60;
const TIP_MAX_FUTURE_SKEW_SEC = 2 * 60;
const MAX_READ_REQUESTS = 12;
const MAX_UTXOS_PER_ADDRESS = 500;
const MAX_ASSETS_PER_UTXO = 100;
const MAX_ASSET_INFO_UNITS = 16;

const hexString = z.string().regex(/^[0-9a-f]+$/i);
const bigintString = z
  .string()
  .regex(/^[0-9]+$/)
  .transform((value, ctxRef) => {
    try {
      return BigInt(value);
    } catch {
      ctxRef.addIssue({ code: "custom", message: "quantity is not a valid integer string" });
      return z.NEVER;
    }
  });

const koiosTipSchema = z.object({
  hash: z.string().trim().min(1),
  block_no: z.number().int().nonnegative().safe(),
  block_time: z.number().int().nonnegative().safe(),
});

const koiosAssetEntrySchema = z.object({
  policy_id: hexString.min(1),
  asset_name: hexString.min(1),
  quantity: bigintString,
});

const koiosUtxoSchema = z.object({
  tx_hash: hexString.min(1),
  tx_index: z.number().int().nonnegative(),
  value: bigintString,
  block_height: z.number().int().nonnegative().safe(),
  block_time: z.number().int().nonnegative().safe(),
  asset_list: z.array(koiosAssetEntrySchema).max(MAX_ASSETS_PER_UTXO).optional(),
});

const koiosAddressInfoRowSchema = z.object({
  address: z.string().trim().min(1),
  balance: bigintString,
  script_address: z.boolean(),
  utxo_set: z.array(koiosUtxoSchema).max(MAX_UTXOS_PER_ADDRESS),
});

const koiosAssetInfoRowSchema = z.object({
  policy_id: hexString.min(1),
  asset_name: hexString.min(1),
  total_supply: bigintString,
  mint_cnt: z.number().int().nonnegative(),
  burn_cnt: z.number().int().nonnegative(),
});

export interface KoiosTip {
  hash: string;
  blockNo: number;
  blockTimeSec: number;
}

export interface KoiosUtxoAsset {
  policyId: string;
  assetNameHex: string;
  quantity: bigint;
}

export interface KoiosUtxo {
  txHash: string;
  txIndex: number;
  lovelace: bigint;
  blockHeight: number;
  blockTimeSec: number;
  assets: KoiosUtxoAsset[];
}

export interface KoiosAddressView {
  address: string;
  balanceLovelace: bigint;
  scriptAddress: boolean;
  utxos: KoiosUtxo[];
}

export interface KoiosAssetView {
  policyId: string;
  assetNameHex: string;
  totalSupply: bigint;
  mintCount: number;
  burnCount: number;
}

export interface KoiosReader {
  tip: KoiosTip;
  addressInfo(addresses: string[]): Promise<KoiosAddressView[]>;
  assetInfo(units: Array<[string, string]>): Promise<KoiosAssetView[]>;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export async function createKoiosReader(
  baseUrl: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<KoiosReader> {
  let requests = 0;
  const budget = (label: string) => {
    requests += 1;
    if (requests > MAX_READ_REQUESTS) {
      throw new Error(`Koios read budget exceeded (${MAX_READ_REQUESTS} requests) at ${label}`);
    }
  };

  // The Koios /tip endpoint wraps its single row in a one-element array.
  const tipRows = z.array(koiosTipSchema).min(1).parse(
    await fetchJsonWithRetry<unknown>(endpoint(baseUrl, "/tip"), signal, 10_000, ctx),
  );
  const tipRow = tipRows[0]!;
  const tip: KoiosTip = {
    hash: tipRow.hash,
    blockNo: tipRow.block_no,
    blockTimeSec: tipRow.block_time,
  };
  const now = ctx?.nowSec ?? Math.floor(Date.now() / 1_000);
  if (tip.blockTimeSec < now - TIP_MAX_AGE_SEC || tip.blockTimeSec > now + TIP_MAX_FUTURE_SKEW_SEC) {
    throw new Error(`Koios tip block ${tip.blockNo} is stale or future-dated (${tip.blockTimeSec} vs now ${now})`);
  }
  if (ctx) ctx.observedBlock = { chain: "cardano", number: tip.blockNo, timestamp: tip.blockTimeSec };

  return {
    tip,
    async addressInfo(addresses: string[]): Promise<KoiosAddressView[]> {
      budget("address_info");
      if (addresses.length === 0 || addresses.length > 32) {
        throw new Error("Koios address_info requires between 1 and 32 addresses");
      }
      const rows = z.array(koiosAddressInfoRowSchema).parse(
        await fetchJsonPostWithRetry<unknown>(
          endpoint(baseUrl, "/address_info"),
          { _addresses: addresses },
          signal,
          15_000,
          ctx,
        ),
      );
      const requested = new Set(addresses);
      const seen = new Set<string>();
      for (const row of rows) {
        if (!requested.has(row.address)) {
          throw new Error(`Koios address_info returned an unrequested address ${row.address}`);
        }
        if (seen.has(row.address)) {
          throw new Error(`Koios address_info returned duplicate rows for ${row.address}`);
        }
        seen.add(row.address);
      }
      if (seen.size !== requested.size) {
        throw new Error(
          `Koios address_info returned ${seen.size} of ${requested.size} requested addresses`,
        );
      }
      return rows.map((row) => ({
        address: row.address,
        balanceLovelace: row.balance,
        scriptAddress: row.script_address,
        utxos: row.utxo_set.map((utxo) => ({
          txHash: utxo.tx_hash,
          txIndex: utxo.tx_index,
          lovelace: utxo.value,
          blockHeight: utxo.block_height,
          blockTimeSec: utxo.block_time,
          assets: (utxo.asset_list ?? []).map((asset) => ({
            policyId: asset.policy_id,
            assetNameHex: asset.asset_name,
            quantity: asset.quantity,
          })),
        })),
      }));
    },
    async assetInfo(units: Array<[string, string]>): Promise<KoiosAssetView[]> {
      budget("asset_info");
      if (units.length === 0 || units.length > MAX_ASSET_INFO_UNITS) {
        throw new Error(`Koios asset_info requires between 1 and ${MAX_ASSET_INFO_UNITS} units`);
      }
      const rows = z.array(koiosAssetInfoRowSchema).parse(
        await fetchJsonPostWithRetry<unknown>(
          endpoint(baseUrl, "/asset_info"),
          { _asset_list: units },
          signal,
          15_000,
          ctx,
        ),
      );
      const requested = new Set(units.map(([policyId, assetNameHex]) => `${policyId}${assetNameHex}`));
      const seen = new Set<string>();
      for (const row of rows) {
        const key = `${row.policy_id}${row.asset_name}`;
        if (!requested.has(key)) {
          throw new Error(`Koios asset_info returned an unrequested unit ${key}`);
        }
        if (seen.has(key)) {
          throw new Error(`Koios asset_info returned duplicate rows for ${key}`);
        }
        seen.add(key);
      }
      if (seen.size !== requested.size) {
        throw new Error(`Koios asset_info returned ${seen.size} of ${requested.size} requested units`);
      }
      return rows.map((row) => ({
        policyId: row.policy_id,
        assetNameHex: row.asset_name,
        totalSupply: row.total_supply,
        mintCount: row.mint_cnt,
        burnCount: row.burn_cnt,
      }));
    },
  };
}

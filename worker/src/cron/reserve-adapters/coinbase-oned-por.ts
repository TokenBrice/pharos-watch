import { z } from "zod";
import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { DASHBOARD_SOURCE_MAX_AGE_SEC } from "@shared/types/live-reserve-adapter-policy";
import { toErrorMessage } from "@shared/lib/error-utils";
import { fetchJsonWithRetry, requireJsonInput, verifiedFreshnessMetadata } from "./helpers";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "./validate";
import type { AdapterContext, AdapterResult } from "./types";

const KEY = "coinbase-oned-por";
const OPERATION = "ProofOfReservesPageQuery";
const HASH = "f26fac8fa11e1fcab64476e3dc605758082acc19b13353841bd78fb57a0ba34a";
const ONED_CONTRACT = "0x10ed0050b7a5d5e1e9cc164f77a71d0bf69f64bd";
const USDC_CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const queryUrl = new URL("https://www.coinbase.com/graphql/query");
queryUrl.searchParams.set("operationName", OPERATION);
queryUrl.searchParams.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: HASH } }));
queryUrl.searchParams.set("variables", JSON.stringify({ reserveAssetTicker: "USDC", wrappedAssetTicker: "ONED", nativeCurrency: "USD" }));
export const COINBASE_ONED_POR_URL = queryUrl.href;

const AmountSchema = z.string().refine((value) => {
  const [whole, fraction, ...rest] = value.split(".");
  return rest.length === 0 && /^\d+$/.test(whole ?? "") && (fraction === undefined || /^\d{1,6}$/.test(fraction));
});
const AddressSchema = z.string().regex(/^0x[a-fA-F\d]{40}$/);
const PayloadSchema = z.object({
  data: z.object({
    proofOfReserves: z.object({
      lastUpdatedAt: z.string().datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
      reservesTotal: z.object({ currency: z.literal("USDC"), amount: AmountSchema }),
      wrappedAssetsTotal: z.object({ amount: AmountSchema }),
      wrappedAssetsByNetwork: z.array(z.object({
        network: z.literal("base"), currency: z.literal("ONED"),
        contractAddress: AddressSchema, amount: AmountSchema,
      })).length(1),
      reserveAddresses: z.array(z.object({
        address: AddressSchema,
        balance: z.object({ network: z.literal("base"), currency: z.literal("USDC"), amount: AmountSchema }),
      })).min(1).max(32),
    }),
  }),
});

function fail(reason: string, detail: string): never {
  // The stable prefix survives the sync runner's persisted/truncated error text.
  throw new Error(`${KEY}:${reason} ${detail}`);
}

function units(amount: string): bigint {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function parseCoinbaseOnedPor(payload: unknown, nowSec: number): AdapterResult {
  if (payload && typeof payload === "object" && "errors" in payload && payload.errors != null) {
    const errors = JSON.stringify(payload.errors);
    fail(/persisted.?query|sha256|hash/i.test(errors) ? "persisted-query-drift" : "graphql-error", "upstream GraphQL errors; no partial data admitted");
  }
  const parsed = PayloadSchema.safeParse(payload);
  if (!parsed.success) fail("schema-drift", "required ONED reserve schema changed");
  const por = parsed.data.data.proofOfReserves;
  const sourceTimestamp = Date.parse(por.lastUpdatedAt) / 1000;
  if (new Date(sourceTimestamp * 1000).toISOString().replace(".000Z", "Z") !== por.lastUpdatedAt) {
    fail("schema-drift", "invalid source calendar date");
  }
  if (sourceTimestamp > nowSec + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) fail("future-source", "source timestamp is in the future");
  if (nowSec - sourceTimestamp > DASHBOARD_SOURCE_MAX_AGE_SEC) fail("stale-source", "source timestamp exceeds dashboard age budget");
  const stock = units(por.wrappedAssetsTotal.amount);
  const reserves = units(por.reservesTotal.amount);
  const deployment = por.wrappedAssetsByNetwork[0];
  if (deployment.contractAddress.toLowerCase() !== ONED_CONTRACT || units(deployment.amount) !== stock || stock <= 0n || reserves <= 0n) {
    fail("deployment-mismatch", "native Base deployment does not reconcile to total stock");
  }
  const addresses = new Set<string>();
  let walletTotal = 0n;
  for (const wallet of por.reserveAddresses) {
    const address = wallet.address.toLowerCase();
    if (addresses.has(address)) fail("wallet-census-mismatch", "duplicate reserve wallet");
    addresses.add(address);
    walletTotal += units(wallet.balance.amount);
  }
  if (walletTotal !== reserves) fail("wallet-census-mismatch", "complete wallet balances do not reconcile to reserve total");
  const totalReserveUsdc = Number(reserves) / 1_000_000;
  const supplyTokens = Number(stock) / 1_000_000;
  if (!Number.isFinite(totalReserveUsdc) || !Number.isFinite(supplyTokens)) fail("schema-drift", "amount exceeds numeric observation range");
  return {
    slices: [{ sourceKey: `${KEY}:base:${USDC_CONTRACT}`, name: "USDC in Coinbase published ONED reserve wallets", pct: 100, risk: "low", coinId: "usdc-circle", depType: "wrapper" }],
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      supplyTokens,
      collateralizationRatio: totalReserveUsdc / supplyTokens,
      details: {
        sourceUrl: COINBASE_ONED_POR_URL, persistedQueryHash: HASH,
        reportedReserveUsdc: totalReserveUsdc, publishedReserveWalletCount: addresses.size,
        scope: "Issuer-published Base ONED stock and complete USDC wallet census. Exclusive allocation, encumbrance and independent financial assurance are unverified; no actionable redemption capacity is emitted.",
      },
    },
  };
}

export async function fetchCoinbaseOnedPorReserves(
  _coin: ReserveAdapterCoin, config: LiveReservesConfig, signal: AbortSignal, ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primary = requireJsonInput(config.inputs.primary, KEY);
  if (primary.url !== COINBASE_ONED_POR_URL) fail("persisted-query-drift", "configured query identity differs from reviewed endpoint");
  let payload: unknown;
  try {
    payload = await fetchJsonWithRetry<unknown>(primary.url, signal, 12_000, ctx, {
      headers: { "x-apollo-operation-name": OPERATION }, maxRetries: 0,
    });
  } catch (error) {
    const detail = toErrorMessage(error);
    fail(/json|parse/i.test(detail) ? "schema-drift" : /HTTP\s*\d{3}/i.test(detail) ? "http-error" : "transport-error", detail);
  }
  return parseCoinbaseOnedPor(payload, ctx?.nowSec ?? Math.floor(Date.now() / 1000));
}

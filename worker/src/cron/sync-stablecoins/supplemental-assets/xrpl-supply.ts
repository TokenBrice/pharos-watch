import { z } from "zod";
import { parseXrplIssuedCurrencyAmount } from "@shared/lib/deployment-amounts";
import { XrplIssuedCurrencyAmountSchema } from "@shared/types/deployment-amounts";
import { NAV_SUPPLY_LEDGER_FRESHNESS } from "@shared/lib/onchain-supply-probe";
import { SUPPLY_RPC_DEFAULTS } from "@shared/lib/chain-rpc-registry";
import { throwIfAborted } from "../../../lib/abort";
import { fetchJsonPostWithRetry } from "../../reserve-adapters/request";

const BOUNDED_READ = { maxRetries: 0, maxResponseBytes: 64 * 1024 };
const RIPPLE_EPOCH_SEC = 946684800;
export class XrplSupplyValidationError extends Error {}
const HashSchema = z.string().regex(/^[A-F0-9]{64}$/);
const LedgerIdentitySchema = z.object({
  status: z.literal("success"), validated: z.literal(true),
  ledger_hash: HashSchema, ledger_index: z.number().int().positive().safe(),
  ledger_current_index: z.never().optional(), error: z.never().optional(),
});
const HolderAmountsSchema = z.record(z.string(), z.array(z.object({ currency: z.string(), value: z.string() })));
const GatewaySchema = z.object({ result: LedgerIdentitySchema.extend({
  account: z.string(), obligations: z.record(z.string(), z.string()),
  frozen_balances: HolderAmountsSchema.optional(), locked: z.record(z.string(), z.string()).optional(),
}), error: z.never().optional() });
const LedgerSchema = z.object({ result: LedgerIdentitySchema.extend({ ledger: z.object({
  ledger_hash: HashSchema, ledger_index: z.string().regex(/^[1-9]\d{0,15}$/),
  closed: z.literal(true), close_flags: z.literal(0), close_time: z.number().int().positive().safe(),
}) }), error: z.never().optional() });

/** Gateway obligations omit issuer inventory and the reviewed operational holders. */
export async function fetchXrplSupply(
  address: string,
  signal: AbortSignal,
  rpcUrl: string = SUPPLY_RPC_DEFAULTS.xrpl.rpcUrl,
  fallbackRpcUrl: string = SUPPLY_RPC_DEFAULTS.xrpl.fallbackRpcUrl,
  hotwallet?: readonly string[],
): Promise<{ supply: number; observedAt: number }> {
  const [currency, issuer, extra] = address.split(".");
  if (extra !== undefined) throw new Error("xrpl-invalid-supply-identity");
  const identity = XrplIssuedCurrencyAmountSchema.parse({ currency, issuer, value: "0" });
  for (const holder of hotwallet ?? []) XrplIssuedCurrencyAmountSchema.shape.issuer.parse(holder);
  let lastError: unknown;
  for (const url of new Set([rpcUrl, fallbackRpcUrl])) {
    throwIfAborted(signal);
    try {
      const gateway = GatewaySchema.parse(await fetchJsonPostWithRetry<unknown>(url, {
        method: "gateway_balances", params: [{ account: issuer, strict: true, ledger_index: "validated",
          ...(hotwallet?.length ? { hotwallet } : {}),
        }],
      }, signal, 10_000, undefined, BOUNDED_READ)).result;
      if (gateway.account !== issuer || !Object.prototype.hasOwnProperty.call(gateway.obligations, currency)) {
        throw new XrplSupplyValidationError("xrpl-supply-identity-mismatch");
      }
      // shortcut: frozen/escrow stock is not reconciled, require a reviewed bucket policy before admitting it.
      if (Object.values(gateway.frozen_balances ?? {}).some(amounts => amounts.some(amount => amount.currency === currency))
        || Object.prototype.hasOwnProperty.call(gateway.locked ?? {}, currency)) throw new XrplSupplyValidationError("xrpl-unreconciled-supply-buckets");
      let amount;
      try {
        amount = parseXrplIssuedCurrencyAmount({ ...identity, value: gateway.obligations[currency] }, identity);
      } catch {
        throw new XrplSupplyValidationError("xrpl-invalid-supply-amount");
      }
      const supply = Number(`${amount.coefficient}e${amount.exponent}`);
      if (!Number.isFinite(supply) || supply < 0) throw new XrplSupplyValidationError("xrpl-invalid-supply-amount");
      // The hash pins the close clock to the exact gateway observation; never use the node's current head.
      const ledger = LedgerSchema.parse(await fetchJsonPostWithRetry<unknown>(url, {
        method: "ledger", params: [{ ledger_hash: gateway.ledger_hash, transactions: false, expand: false }],
      }, signal, 10_000, undefined, BOUNDED_READ)).result;
      if (ledger.ledger_hash !== gateway.ledger_hash || ledger.ledger_index !== gateway.ledger_index
        || ledger.ledger.ledger_hash !== gateway.ledger_hash || Number(ledger.ledger.ledger_index) !== gateway.ledger_index) {
        throw new XrplSupplyValidationError("xrpl-ledger-identity-mismatch");
      }
      const observedAt = ledger.ledger.close_time + RIPPLE_EPOCH_SEC;
      const age = Date.now() / 1000 - observedAt;
      if (age > NAV_SUPPLY_LEDGER_FRESHNESS.maxAgeSec || age < -NAV_SUPPLY_LEDGER_FRESHNESS.maxFutureSkewSec) {
        throw new XrplSupplyValidationError("xrpl-ledger-stale-or-future");
      }
      return { supply, observedAt };
    } catch (error) {
      throwIfAborted(signal);
      if (!(lastError instanceof XrplSupplyValidationError)) {
        lastError = error instanceof z.ZodError ? new XrplSupplyValidationError("xrpl-invalid-rpc-shape") : error;
      }
    }
  }
  throw lastError;
}

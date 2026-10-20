import { parseXrplIssuedCurrencyAmount } from "@shared/lib/deployment-amounts";
import { sha256HexFromUtf8Chunks } from "@shared/lib/sha256";
import type { EconomicSupplyObservation, ReviewedEconomicSupplyPlan } from "@shared/types/safety-score-v9-supply-attribution";
import { getRpcAuthHeaders } from "../chain-registry";
import { cancelResponseBodyQuietly, readResponseTextWithinLimitWithSignal, type BodyReadObserver } from "../response-body";

/** One validated ledger and its true close clock; never infer time from receipt. */
export async function readEconomicXrplHolding(input: {
  row: ReviewedEconomicSupplyPlan["deployments"][number]; url: string;
  bodyCaps: { xrplGatewayBalances: number; xrplLedger: number };
  signal?: AbortSignal; onBodyRead?: BodyReadObserver;
  onBodyMethod: (method: "gateway_balances" | "ledger") => void;
}): Promise<EconomicSupplyObservation | null> {
  const { row, url, signal } = input;
  if (row.read.kind !== "xrpl-issued-currency" || row.chainId !== "xrpl") return null;
  const source = row.read;
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...getRpcAuthHeaders(url) }, body: JSON.stringify({ method: "gateway_balances", params: [{ account: source.issuer, ledger_index: "validated", strict: true }] }), signal });
  if (!response.ok) { await cancelResponseBodyQuietly(response); return null; }
  input.onBodyMethod("gateway_balances");
  const text = await readResponseTextWithinLimitWithSignal(response, input.bodyCaps.xrplGatewayBalances, signal, input.onBodyRead);
  const body = JSON.parse(text) as { result?: { validated?: boolean; ledger_index?: number; ledger_hash?: string; obligations?: Record<string, string> } };
  const result = body.result, value = result?.obligations?.[source.currency];
  if (result?.validated !== true || !Number.isSafeInteger(result.ledger_index) || typeof result.ledger_hash !== "string" || !/^[A-Fa-f0-9]{64}$/.test(result.ledger_hash) || typeof value !== "string") return null;
  const amount = parseXrplIssuedCurrencyAmount({ issuer: source.issuer, currency: source.currency, value }, source);
  if (amount.coefficient.startsWith("-")) return null;
  const coefficient = amount.coefficient, exponent = amount.exponent;
  const decimal = exponent >= 0 ? coefficient + "0".repeat(exponent) : coefficient.length + exponent > 0 ? `${coefficient.slice(0, coefficient.length + exponent)}.${coefficient.slice(coefficient.length + exponent)}` : `0.${"0".repeat(-exponent - coefficient.length)}${coefficient}`;
  const ledgerResponse = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...getRpcAuthHeaders(url) }, body: JSON.stringify({ method: "ledger", params: [{ ledger_hash: result.ledger_hash }] }), signal });
  if (!ledgerResponse.ok) { await cancelResponseBodyQuietly(ledgerResponse); return null; }
  input.onBodyMethod("ledger");
  const ledgerText = await readResponseTextWithinLimitWithSignal(ledgerResponse, input.bodyCaps.xrplLedger, signal, input.onBodyRead);
  const ledger = JSON.parse(ledgerText) as { result?: { ledger?: { close_time?: number; ledger_hash?: string } } };
  const close = ledger.result?.ledger?.close_time;
  if (ledger.result?.ledger?.ledger_hash !== result.ledger_hash || !Number.isInteger(close)) return null;
  return { id: row.deploymentKey, deploymentKey: row.deploymentKey,
    amount: decimal.includes(".") ? decimal.replace(/0+$/, "").replace(/\.$/, "") : decimal,
    observedAtSec: close! + 946684800, anchor: String(result.ledger_index), anchorHash: result.ledger_hash.toLowerCase(),
    responseSha256: sha256HexFromUtf8Chunks([text, ledgerText]) };
}

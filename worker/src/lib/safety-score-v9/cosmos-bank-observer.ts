import { CHAIN_META } from "@shared/types/chain-identity";
import { CosmosBankSupplyReadSchema, type CosmosBankSupplyRead } from "@shared/types/safety-score-v9-supply-attribution";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { rethrowIfAborted } from "../abort";
import { fetchTextWithRetry } from "../fetch-retry";

const COSMOS_BANK_REQUEST_TIMEOUT_MS = 10_000;
const COSMOS_BANK_MAX_RESPONSE_BYTES = 128 * 1024;

export interface CosmosBankPin { height: string; blockHash: string; observedAtSec: number }

async function readJson(source: CosmosBankSupplyRead, path: string, height?: string, signal?: AbortSignal) {
  const result = await fetchTextWithRetry(new URL(path, source.restUrl).href, {
    headers: height === undefined ? undefined : { "x-cosmos-block-height": height }, signal,
  }, 0, { timeoutMs: COSMOS_BANK_REQUEST_TIMEOUT_MS, maxResponseBytes: COSMOS_BANK_MAX_RESPONSE_BYTES });
  if (!result?.response.ok) return null;
  const { response, body: text } = result;
  if (height !== undefined) {
    // grpc-gateway commonly prefixes the metadata; require at least one echo,
    // and reject conflicting echoes instead of trusting the request header.
    const echoes = [response.headers.get("x-cosmos-block-height"), response.headers.get("grpc-metadata-x-cosmos-block-height")].filter(value => value !== null);
    if (echoes.length === 0 || echoes.some(value => value !== height)) return null;
  }
  return { body: JSON.parse(text) as unknown, text };
}

function blockPin(body: unknown, ledgerChainId: string): CosmosBankPin | null {
  const block = body as { block_id?: { hash?: unknown }; block?: { header?: { chain_id?: unknown; height?: unknown; time?: unknown } } };
  const header = block?.block?.header, hash = block?.block_id?.hash;
  if (header?.chain_id !== ledgerChainId || typeof header.height !== "string" || !/^[1-9][0-9]*$/.test(header.height) ||
    !Number.isSafeInteger(Number(header.height)) || typeof header.time !== "string" || typeof hash !== "string") return null;
  const time = header.time;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(time.slice(0, 19)) || !time.endsWith("Z") ||
    (time.length !== 20 && (time.length < 22 || time.length > 30 || time[19] !== "." || !/^[0-9]+$/.test(time.slice(20, -1))))) return null;
  const timestamp = Date.parse(header.time);
  if (!Number.isFinite(timestamp)) return null;
  let blockHash: string;
  if (/^[0-9a-fA-F]{64}$/.test(hash)) blockHash = hash.toLowerCase();
  else {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(hash)) return null;
    const bytes = atob(hash);
    if (bytes.length !== 32 || btoa(bytes) !== hash) return null;
    blockHash = Array.from(bytes, byte => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  }
  return { height: header.height, blockHash, observedAtSec: Math.floor(timestamp / 1000) };
}

/** Cosmos commits are finalized; every bank read must echo this exact height. */
export async function pinEconomicCosmosBank(input: {
  source: CosmosBankSupplyRead; chainId: string; clockSec: number; signal?: AbortSignal;
}): Promise<CosmosBankPin | null> {
  try {
    if (!CosmosBankSupplyReadSchema.safeParse(input.source).success ||
      CHAIN_META[input.chainId]?.nativeDenomRail?.ledgerChainId !== input.source.ledgerChainId) return null;
    const latest = await readJson(input.source, "/cosmos/base/tendermint/v1beta1/blocks/latest", undefined, input.signal);
    const head = latest && blockPin(latest.body, input.source.ledgerChainId);
    if (!head || Number(head.height) <= input.source.safeBlockLag) return null;
    const height = String(Number(head.height) - input.source.safeBlockLag);
    const result = await readJson(input.source, `/cosmos/base/tendermint/v1beta1/blocks/${height}`, height, input.signal);
    const pin = result && blockPin(result.body, input.source.ledgerChainId);
    const budget = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.observationMaxAgeSec;
    return pin && pin.height === height && pin.observedAtSec <= input.clockSec && input.clockSec - pin.observedAtSec <= budget ? pin : null;
  } catch (error) { rethrowIfAborted(error, input.signal); return null; }
}

/** Supply and IBC escrow balance use the same pin, never latest or receipt time. */
export async function observeEconomicCosmosBank(input: {
  source: CosmosBankSupplyRead; chainId: string; pin: CosmosBankPin; clockSec: number; account?: string; signal?: AbortSignal;
}): Promise<{ amount: string; anchor: string; anchorHash: string; observedAtSec: number; responseSha256: string } | null> {
  try {
    const { source, pin } = input;
    const rail = CHAIN_META[input.chainId]?.nativeDenomRail;
    const budget = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.observationMaxAgeSec;
    if (!CosmosBankSupplyReadSchema.safeParse(source).success || !rail || rail.ledgerChainId !== source.ledgerChainId ||
      !/^[1-9][0-9]*$/.test(pin.height) || !Number.isSafeInteger(Number(pin.height)) || !/^[0-9a-f]{64}$/.test(pin.blockHash) ||
      !Number.isSafeInteger(pin.observedAtSec) || pin.observedAtSec > input.clockSec || input.clockSec - pin.observedAtSec > budget ||
      (input.account !== undefined && (!input.account.startsWith(`${rail.bech32Prefix}1`) || !/^[a-z0-9]{1,90}$/.test(input.account)))) return null;
    const path = input.account === undefined ? "/cosmos/bank/v1beta1/supply/by_denom" : `/cosmos/bank/v1beta1/balances/${encodeURIComponent(input.account)}/by_denom`;
    const result = await readJson(source, `${path}?denom=${encodeURIComponent(source.denom)}`, pin.height, input.signal);
    const body = result?.body as { amount?: { denom?: unknown; amount?: unknown }; balance?: { denom?: unknown; amount?: unknown } } | undefined;
    const coin = input.account === undefined ? body?.amount : body?.balance;
    if (!coin || coin.denom !== source.denom || typeof coin.amount !== "string" || coin.amount.length > 128 || !/^(0|[1-9][0-9]*)$/.test(coin.amount)) return null;
    const header = await readJson(source, `/cosmos/base/tendermint/v1beta1/blocks/${pin.height}`, pin.height, input.signal);
    const rechecked = header && blockPin(header.body, source.ledgerChainId);
    if (!rechecked || rechecked.height !== pin.height || rechecked.blockHash !== pin.blockHash || rechecked.observedAtSec !== pin.observedAtSec) return null;
    return { amount: coin.amount, anchor: pin.height, anchorHash: pin.blockHash, observedAtSec: pin.observedAtSec,
      responseSha256: sha256Hex(stableJsonStringifyV1({ source, account: input.account ?? null, pin, amountResponse: result!.text, blockResponse: header!.text })) };
  } catch (error) { rethrowIfAborted(error, input.signal); return null; }
}

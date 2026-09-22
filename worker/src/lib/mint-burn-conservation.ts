import type { MintBurnConservationRecord } from "@shared/types/status";
import type { MintBurnContractConfig, MintBurnEventDef } from "./mint-burn-contracts";
import type { AlchemyLogEntry } from "./alchemy-logs";
import type { SubrequestBudget } from "./evm-logs";
import type { MintBurnRow } from "./mint-burn-pipeline/types";
import { mintBurnConfigKey } from "./mint-burn-pipeline/sync-state";
import { decimalNumberFromBigInt } from "./bigint";
import { fetchEvmRpcBatchDetailed, type EvmRpcBatchCall } from "./evm-rpc";
import { getCaches } from "./db-cache";
import { buildInClause, D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "./d1-primitives";
import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./d1-overload-retry";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = `0x${"0".repeat(64)}`;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_WORD = /^0x0{24}[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
// Reviewed non-rebasing Ethereum Transfer/totalSupply identities. Expansion requires a raw-log audit.
const REVIEWED: ReadonlyArray<readonly [string, string, number]> = [
  ["usds-sky", "0xdc035d45d973e3ec169d2276ddab16f1e407384f", 18],
  ["usde-ethena", "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", 18],
  ["usd1-world-liberty-financial", "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", 18],
  ["usdg-paxos", "0xe343167631d89b6ffc58b88d6b7fb0228795491d", 6],
  ["usdat-saturn", "0x23238f20b894f29041f48d88ee91131c395aaa71", 6],
  ["musd-metamask", "0xaca92e438df0b2401ff60da7e4337b687a2435da", 6],
  ["gusd-gemini", "0x056fd409e1d7a124bd7017459dfea2f387b6d5cd", 2],
  ["eure-monerium", "0x39b8b6385416f4ca36a20319f70d28621895279d", 18],
  ["bold-liquity", "0x6440f144b7e50d6a8439336510312d2f54beb01d", 18],
  ["ftusd-flying-tulip", "0xf7d85ec4e7710f71992752eac2111312e73e9c9c", 6],
  ["lusd-liquity", "0x5f98805a4e8be255a32880fdec7f6728c6568ba0", 18],
  ["dusd-alto", "0x63d74d22e689c715a04f2c13962b1f77f443d35b", 18],
  ["usdaf-asymmetry", "0x9cf12ccd6020b6888e4d4c4e4c7aca33c1eb91f8", 18],
  ["buidl-blackrock", "0x7712c34205737192402172409a8f7ccef8aa2aec", 6],
  ["buidl-blackrock", "0x6a9da2d710bb9b700acde7cb81f10f1ff8c89041", 6],
];

export function getMintBurnConservationEligibility(config: MintBurnContractConfig): { supported: boolean; reason?: string } {
  const identity = config.chain.chainId === "ethereum" && REVIEWED.some(([id, address, decimals]) =>
    id === config.stablecoinId && address === config.contractAddress.toLowerCase() && decimals === config.decimals);
  const events = config.events.length === 2 && ["mint", "burn"].every((direction) =>
    config.events.filter((event) => event.direction === direction &&
      event.signature === "Transfer(address,address,uint256)" && event.topicHash.toLowerCase() === TRANSFER &&
      event.amountEncoding === "transfer-value" && event.dataSlot == null && event.counterpartyEncoding == null &&
      event.filterTopic?.index === (direction === "mint" ? 1 : 2) && event.filterTopic.value.toLowerCase() === ZERO).length === 1);
  return identity && events && config.adapterKind === "transfer-zero-address"
    ? { supported: true } : { supported: false, reason: "unreviewed-contract-or-event-semantics" };
}

export function mintBurnConservationCacheKey(config: MintBurnContractConfig): string {
  return `mint-burn:conservation:${mintBurnConfigKey(config)}`;
}

export function mintBurnConservationFingerprint(config: MintBurnContractConfig): string {
  return JSON.stringify([1, config.stablecoinId, config.chain.chainId, config.contractAddress.toLowerCase(),
    config.decimals, config.adapterKind, config.startBlock, config.dustThreshold,
    config.events.map((event) => [event.signature, event.topicHash.toLowerCase(), event.direction,
      event.amountEncoding, event.dataSlot ?? null, event.filterTopic?.index ?? null,
      event.filterTopic?.value.toLowerCase() ?? null, event.counterpartyEncoding ?? null])]);
}

export async function readMintBurnConservationRecords(db: D1Database, configs: MintBurnContractConfig[]): Promise<Map<string, unknown>> {
  const values = new Map<string, unknown>();
  const keys = [...new Set(configs.map(mintBurnConservationCacheKey))];
  for (let offset = 0; offset < keys.length; offset += D1_SAFE_IN_CLAUSE_BIND_LIMIT) {
    const rows = await getCaches(db, keys.slice(offset, offset + D1_SAFE_IN_CLAUSE_BIND_LIMIT));
    for (const [key, row] of rows) {
      try { values.set(key, JSON.parse(row.value)); } catch { /* Invalid records remain unverified. */ }
    }
  }
  return values;
}

type ConfigLogs = Array<{ eventDef: MintBurnEventDef; logs: AlchemyLogEntry[] }>;
function quantity(value: unknown): number {
  if (typeof value !== "string" || !QUANTITY.test(value)) throw new Error("invalid-rpc-quantity");
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed)) throw new Error("unsafe-rpc-quantity");
  return parsed;
}

export function collectConservationRawEvents(config: MintBurnContractConfig, batches: ConfigLogs, fromBlock: number, toBlock: number) {
  const seen = new Map<string, string>();
  const blockHashes = new Map<number, string>();
  const events: Array<{ log: AlchemyLogEntry; direction: "mint" | "burn"; raw: bigint }> = [];
  for (const { eventDef, logs } of batches) {
    for (const log of logs) {
      const block = quantity(log.blockNumber);
      quantity(log.transactionIndex);
      const index = quantity(log.logIndex);
      if (log.removed !== false || log.address.toLowerCase() !== config.contractAddress.toLowerCase() ||
        block <= fromBlock || block > toBlock || !WORD.test(log.blockHash) || log.blockHash === ZERO ||
        !WORD.test(log.transactionHash) || log.transactionHash === ZERO || !WORD.test(log.data) ||
        log.topics.length !== 3 || log.topics[0].toLowerCase() !== TRANSFER ||
        !ADDRESS_WORD.test(log.topics[1]) || !ADDRESS_WORD.test(log.topics[2]) ||
        log.topics[eventDef.direction === "mint" ? 1 : 2].toLowerCase() !== ZERO) throw new Error("invalid-raw-log");
      const hash = log.blockHash.toLowerCase();
      if (blockHashes.has(block) && blockHashes.get(block) !== hash) throw new Error("inconsistent-log-block-hash");
      blockHashes.set(block, hash);
      const key = `${log.transactionHash.toLowerCase()}:${index}`;
      const identity = JSON.stringify([block, hash, quantity(log.transactionIndex), log.topics.map((topic) => topic.toLowerCase()), log.data.toLowerCase()]);
      if (seen.has(key)) {
        if (seen.get(key) !== identity) throw new Error("conflicting-duplicate-log");
        continue;
      }
      seen.set(key, identity);
      const raw = BigInt(log.data);
      if (raw === 0n) continue;
      // A positive zero-to-zero transfer is ambiguous to the persisted row identity.
      if (log.topics[1].toLowerCase() === ZERO && log.topics[2].toLowerCase() === ZERO) throw new Error("ambiguous-zero-transfer");
      events.push({ log, direction: eventDef.direction, raw });
    }
  }
  return { events, blockHashes };
}

export function validateMintBurnParsedConservation(config: MintBurnContractConfig, batches: ConfigLogs,
  fromBlock: number, toBlock: number, rows: MintBurnRow[]): void {
  const expected = collectConservationRawEvents(config, batches, fromBlock - 1, toBlock).events
    .filter(({ raw }) => decimalNumberFromBigInt(raw, config.decimals) >= config.dustThreshold);
  if (rows.length !== expected.length) throw new Error("parsed-event-count-mismatch");
  const actual = new Map(rows.map((row) => [row.id, row]));
  if (actual.size !== rows.length) throw new Error("duplicate-parsed-event");
  for (const { log, direction, raw } of expected) {
    const row = actual.get(`${config.chain.chainId}-${log.transactionHash}-${quantity(log.logIndex)}`);
    if (!row || row.direction !== direction || row.amount !== decimalNumberFromBigInt(raw, config.decimals)) {
      throw new Error("parsed-event-amount-or-identity-mismatch");
    }
  }
}

export const MINT_BURN_CONSERVATION_RPC_BATCH_MAX = 100;
export const MINT_BURN_CONSERVATION_CHUNK_TIMEOUT_MS = 15_000;
export const MINT_BURN_CONSERVATION_PREPASS_MAX_MS = 45_000;

export interface ConservationBoundaryRequest {
  key: string;
  config: MintBurnContractConfig;
  fromBlock: number;
  toBlock: number;
}

export type ConservationBoundaryEvidence =
  | { status: "ready"; fromBlockHash: string; toBlockHash: string; fromTimestamp: number; toTimestamp: number;
      fromSupplyRaw: string; toSupplyRaw: string }
  | { status: "unavailable"; reason: string };

const AUDIT_REASONS: Readonly<Record<string, true>> = {
  "invalid-rpc-quantity": true, "unsafe-rpc-quantity": true, "invalid-raw-log": true, "inconsistent-log-block-hash": true,
  "conflicting-duplicate-log": true, "ambiguous-zero-transfer": true, "audit-budget-or-deadline": true, "audit-rpc-unavailable": true,
  "incomplete-log-range": true, "invalid-audit-range": true, "invalid-boundary-header": true, "invalid-boundary-time": true,
  "closing-log-hash-mismatch": true, "invalid-total-supply-word": true, "boundary-reorg": true, "boundary-evidence-missing": true,
};

function auditReason(error: unknown): string {
  return error instanceof Error && AUDIT_REASONS[error.message] === true ? error.message : "audit-unavailable";
}

function validAuditRange(fromBlock: number, toBlock: number): boolean {
  return Number.isSafeInteger(fromBlock) && fromBlock >= 1 && Number.isSafeInteger(toBlock) && toBlock >= fromBlock;
}

export async function fetchConservationBoundaries(input: {
  requests: ConservationBoundaryRequest[];
  rpcUrlByChain: ReadonlyMap<string, string>;
  budget: SubrequestBudget;
  checkedAt: number;
  signal?: AbortSignal;
  deadlineMs?: number;
  maxBatchCalls?: number;
}): Promise<Map<string, ConservationBoundaryEvidence>> {
  const { budget, signal, deadlineMs } = input;
  const maxBatchCalls = input.maxBatchCalls ?? MINT_BURN_CONSERVATION_RPC_BATCH_MAX;
  if (!Number.isSafeInteger(maxBatchCalls) || maxBatchCalls < 1) throw new Error("invalid-conservation-batch-size");
  throwIfAborted(signal);
  const evidence = new Map<string, ConservationBoundaryEvidence>();
  const groups = new Map<string, ConservationBoundaryRequest[]>();
  for (const request of input.requests) {
    if (!getMintBurnConservationEligibility(request.config).supported) continue;
    if (!validAuditRange(request.fromBlock, request.toBlock)) {
      evidence.set(request.key, { status: "unavailable", reason: "invalid-audit-range" });
      continue;
    }
    const chainId = request.config.chain.chainId;
    const group = groups.get(chainId);
    if (group) group.push(request);
    else groups.set(chainId, [request]);
  }

  type BoundaryCall = { call: EvmRpcBatchCall; keys: string[]; accept: (value: unknown) => void };
  const fail = (keys: string[], reason: string) => {
    for (const key of keys) {
      if (!evidence.has(key)) evidence.set(key, { status: "unavailable", reason });
    }
  };
  async function phase(rpcUrl: string, calls: BoundaryCall[]): Promise<void> {
    const pending = calls.filter(({ keys }) => keys.some((key) => !evidence.has(key)));
    for (let offset = 0; offset < pending.length; offset += maxBatchCalls) {
      throwIfAborted(signal);
      const chunk = pending.slice(offset, offset + maxBatchCalls)
        .filter(({ keys }) => keys.some((key) => !evidence.has(key)));
      if (chunk.length === 0) continue;
      const now = Date.now();
      if (budget.count >= budget.limit || (deadlineMs != null && now >= deadlineMs)) {
        for (const { keys } of chunk) fail(keys, "audit-budget-or-deadline");
        continue;
      }
      budget.count++;
      let result;
      try {
        result = await fetchEvmRpcBatchDetailed(undefined, chunk.map(({ call }) => call), {
          extraRpcUrls: [rpcUrl], signal, maxRetries: 0,
          timeoutMs: Math.max(1, Math.min(MINT_BURN_CONSERVATION_CHUNK_TIMEOUT_MS, (deadlineMs ?? Infinity) - now)),
        });
      } catch {
        throwIfAborted(signal);
        result = null;
      }
      throwIfAborted(signal);
      const errors = new Set(result?.errors.map(({ index }) => index));
      for (let index = 0; index < chunk.length; index++) {
        const { keys, accept } = chunk[index];
        if (!result || errors.has(index)) {
          fail(keys, "audit-rpc-unavailable");
          continue;
        }
        try { accept(result.results[index]); } catch (error) { fail(keys, auditReason(error)); }
      }
    }
  }

  for (const [chainId, requests] of groups) {
    throwIfAborted(signal);
    const rpcUrl = input.rpcUrlByChain.get(chainId);
    if (!rpcUrl) {
      fail(requests.map(({ key }) => key), "audit-rpc-unavailable");
      continue;
    }
    const dependents = new Map<number, string[]>();
    for (const request of requests) {
      for (const block of [request.fromBlock - 1, request.toBlock]) {
        const keys = dependents.get(block);
        if (keys) keys.push(request.key);
        else dependents.set(block, [request.key]);
      }
    }
    const headers = new Map<number, { hash: string; timestamp: number }>();
    const headerCalls = [...dependents].map(([block, keys]) => ({
      block,
      call: { method: "eth_getBlockByNumber", params: [`0x${block.toString(16)}`, false] },
      keys,
      accept(value: unknown) {
        const header = value as { number?: unknown; hash?: unknown; timestamp?: unknown } | null;
        if (!header || quantity(header.number) !== block || typeof header.hash !== "string" ||
          !WORD.test(header.hash) || header.hash === ZERO) throw new Error("invalid-boundary-header");
        headers.set(block, { hash: header.hash.toLowerCase(), timestamp: quantity(header.timestamp) });
      },
    }));
    await phase(rpcUrl, headerCalls);
    const supplies = new Map<string, string[]>();
    const supplyCalls: BoundaryCall[] = [];
    for (const request of requests) {
      if (evidence.has(request.key)) continue;
      const from = headers.get(request.fromBlock - 1)!;
      const to = headers.get(request.toBlock)!;
      if (from.hash === to.hash || from.timestamp <= 0 || from.timestamp > to.timestamp || to.timestamp > input.checkedAt) {
        fail([request.key], "invalid-boundary-time");
        continue;
      }
      const values: string[] = [];
      supplies.set(request.key, values);
      for (const [index, header] of [from, to].entries()) {
        supplyCalls.push({
          call: { method: "eth_call", params: [
            { to: request.config.contractAddress, data: "0x18160ddd" },
            { blockHash: header.hash, requireCanonical: true },
          ] },
          keys: [request.key],
          accept(value) {
            if (typeof value !== "string" || !WORD.test(value)) throw new Error("invalid-total-supply-word");
            values[index] = BigInt(value).toString();
          },
        });
      }
    }
    await phase(rpcUrl, supplyCalls);
    await phase(rpcUrl, headerCalls.map(({ block, call, keys }) => ({
      call, keys,
      accept(value) {
        const original = headers.get(block)!;
        const header = value as { hash?: string; number?: unknown; timestamp?: unknown } | null;
        try {
          if (!header || header.hash?.toLowerCase() !== original.hash || quantity(header.number) !== block ||
            quantity(header.timestamp) !== original.timestamp) throw new Error("boundary-reorg");
        } catch { throw new Error("boundary-reorg"); }
      },
    })));
    for (const request of requests) {
      if (evidence.has(request.key)) continue;
      const from = headers.get(request.fromBlock - 1)!;
      const to = headers.get(request.toBlock)!;
      const values = supplies.get(request.key)!;
      evidence.set(request.key, { status: "ready", fromBlockHash: from.hash, toBlockHash: to.hash,
        fromTimestamp: from.timestamp, toTimestamp: to.timestamp, fromSupplyRaw: values[0], toSupplyRaw: values[1] });
    }
  }
  return evidence;
}

export function completeMintBurnConservationAudit(input: {
  config: MintBurnContractConfig; logs: ConfigLogs; fromBlock: number; toBlock: number; checkedAt: number;
  complete: boolean; boundary: ConservationBoundaryEvidence | undefined;
}): MintBurnConservationRecord {
  const { config, fromBlock, toBlock, checkedAt, boundary } = input;
  const eligibility = getMintBurnConservationEligibility(config);
  const record: MintBurnConservationRecord = {
    version: 1, key: mintBurnConservationCacheKey(config), configFingerprint: mintBurnConservationFingerprint(config),
    stablecoinId: config.stablecoinId, chainId: config.chain.chainId, address: config.contractAddress.toLowerCase(),
    decimals: config.decimals, checkedAt, status: eligibility.supported ? "unavailable" : "unsupported",
    fromBlock: fromBlock - 1, toBlock,
  };
  if (!eligibility.supported) return { ...record, reason: eligibility.reason };
  try {
    if (!input.complete) throw new Error("incomplete-log-range");
    if (!validAuditRange(fromBlock, toBlock)) throw new Error("invalid-audit-range");
    if (!boundary) throw new Error("boundary-evidence-missing");
    if (boundary.status === "unavailable") return { ...record, reason: boundary.reason };
    const raw = collectConservationRawEvents(config, input.logs, fromBlock - 1, toBlock);
    if (raw.blockHashes.has(toBlock) && raw.blockHashes.get(toBlock) !== boundary.toBlockHash) throw new Error("closing-log-hash-mismatch");
    let mint = 0n;
    let burn = 0n;
    for (const event of raw.events) { if (event.direction === "mint") mint += event.raw; else burn += event.raw; }
    const delta = BigInt(boundary.toSupplyRaw) - BigInt(boundary.fromSupplyRaw);
    const residual = mint - burn - delta;
    return { ...record, status: residual === 0n ? "ok" : "mismatch", fromBlockHash: boundary.fromBlockHash,
      toBlockHash: boundary.toBlockHash, fromTimestamp: boundary.fromTimestamp, toTimestamp: boundary.toTimestamp,
      mintRaw: mint.toString(), burnRaw: burn.toString(), supplyDeltaRaw: delta.toString(), residualRaw: residual.toString(),
      logCount: raw.events.length, ...(residual !== 0n ? { reason: "raw-transfer-supply-mismatch" } : {}) };
  } catch (error) {
    return { ...record, reason: auditReason(error) };
  }
}

export async function verifyPersistedMintBurnConservation(db: D1Database, rows: MintBurnRow[],
  signal?: AbortSignal, deadlineMs?: number): Promise<"ok" | "deadline" | "mismatch"> {
  const fields = ["id", "stablecoin_id", "chain_id", "direction", "amount", "block_number", "timestamp"] as const;
  for (let offset = 0; offset < rows.length; offset += D1_SAFE_IN_CLAUSE_BIND_LIMIT) {
    throwIfAborted(signal);
    if (deadlineMs != null && Date.now() >= deadlineMs) return "deadline";
    const expected = rows.slice(offset, offset + D1_SAFE_IN_CLAUSE_BIND_LIMIT);
    const clause = buildInClause(expected.map((row) => row.id));
    const result = await db.prepare(`SELECT id, stablecoin_id, chain_id, direction, amount, block_number, timestamp
      FROM mint_burn_events WHERE id IN (${clause.sql})`).bind(...clause.binds).all<MintBurnRow>();
    throwIfAborted(signal);
    const actual = new Map((result.results ?? []).map((row) => [row.id, row]));
    if (actual.size !== expected.length || expected.some((row) => fields.some((field) => actual.get(row.id)?.[field] !== row[field]))) return "mismatch";
  }
  if (deadlineMs != null && Date.now() >= deadlineMs) return "deadline";
  return "ok";
}

export async function persistMintBurnConservation(db: D1Database, record: MintBurnConservationRecord, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  // Atomic monotonic write: an unavailable retry cannot erase an unresolved verified mismatch.
  await runWithOverloadRetry(() => db.prepare(`INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE cache.updated_at <= excluded.updated_at AND NOT COALESCE((
      json_extract(CASE WHEN json_valid(cache.value) THEN cache.value ELSE '{}' END, '$.status') = 'mismatch'
      AND json_extract(CASE WHEN json_valid(cache.value) THEN cache.value ELSE '{}' END, '$.configFingerprint') = json_extract(excluded.value, '$.configFingerprint')
      AND (json_extract(excluded.value, '$.status') IN ('unavailable', 'unsupported')
        OR (json_extract(excluded.value, '$.status') IN ('ok', 'mismatch') AND NOT (
          json_extract(excluded.value, '$.fromBlock') <= json_extract(CASE WHEN json_valid(cache.value) THEN cache.value ELSE '{}' END, '$.fromBlock')
          AND json_extract(excluded.value, '$.toBlock') >= json_extract(CASE WHEN json_valid(cache.value) THEN cache.value ELSE '{}' END, '$.toBlock'))))
    ), 0)`)
    .bind(record.key, JSON.stringify(record), record.checkedAt).run(), 3, signal);
  throwIfAborted(signal);
}

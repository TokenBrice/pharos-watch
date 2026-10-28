import { decodeAddressWord, readDataWord, type RateLimitedFetch } from "../../lib/evm-logs";
import type { ContractEventConfig } from "../../lib/blacklist-contracts";
import type { BlacklistRow, TronScanTelemetry } from "../../lib/blacklist/shared";
import type { BlacklistRunBudget } from "../../lib/blacklist/run-budget";
import { TronJsonRpcReader, TronRpcError, type TronRpcLog } from "../../lib/tron-jsonrpc";
import { throwIfAborted } from "../../lib/abort";
import { TRON_RPC_MAX_BLOCK_SPAN } from "@shared/lib/tron-jsonrpc";
import { fetchTronEventsIncremental, parseTronEvent, TRON_INDEXING_SAFETY_MS,
  type FetchTronEventsIncrementalResult } from "./tron-source";

const MAX_TRON_RPC_WINDOWS_PER_SCAN = 3;

export function parseTronRpcEvent(
  config: ContractEventConfig, log: TronRpcLog, timestamp: number, transactionLogIndex: number,
): BlacklistRow {
  const event = config.events.find((event) => event.topicHash.toLowerCase() === log.topics[0]);
  if (!event) throw new TronRpcError("tron-rpc-unknown-event");
  const addressWord = log.topics[event.addressTopicIndex ?? 1];
  if (!/^0x0{24}[0-9a-f]{40}$/i.test(addressWord ?? "")) throw new TronRpcError("tron-rpc-invalid-event-address");
  const address = decodeAddressWord(addressWord)!;
  const amountWord = event.hasAmount ? readDataWord(log.data, event.amountDataIndex ?? 0) : null;
  if (event.hasAmount && (amountWord == null || !/^0x[0-9a-f]{64}$/i.test(amountWord))) {
    throw new TronRpcError("tron-rpc-invalid-event-amount");
  }
  const row = parseTronEvent(config, {
    block_number: log.blockNumber, block_timestamp: timestamp * 1000,
    transaction_id: log.transactionHash.slice(2), event_index: transactionLogIndex,
    event_name: event.signature.split("(")[0],
    result: { [event.tronResultKey ?? "_blackListedUser"]: address,
      ...(amountWord ? { _balance: BigInt(amountWord).toString() } : {}) },
  });
  if (!row) throw new TronRpcError("tron-rpc-unknown-event");
  row.transaction_index = log.transactionIndex;
  row.event_topic0 = log.topics[0];
  return row;
}

export async function fetchTronEventsWithRpc(options: {
  config: ContractEventConfig;
  apiKey: string | null;
  lastTimestampMs: number;
  runBudget: BlacklistRunBudget;
  rateLimit: RateLimitedFetch;
  signal?: AbortSignal;
  db?: D1Database;
  reader: TronJsonRpcReader;
  eventApiAllowed: boolean;
}): Promise<FetchTronEventsIncrementalResult> {
  const { config, reader, lastTimestampMs, runBudget, signal } = options;
  const before = { ...reader.calls };
  const successfulBefore = { ...reader.successfulCalls };
  const failureOffset = reader.failures.length;
  let safeHead = Math.max(0, Date.now() - TRON_INDEXING_SAFETY_MS);
  let reason: string | null = null;
  let scannedToTimestamp: number | null = null;
  let maxSplitDepth = 0;
  const rows: BlacklistRow[] = [];
  let complete = false;
  let solidHeadValidated = false;
  try {
    // The event API retains the existing unbounded-history bootstrap semantics.
    if (lastTimestampMs === 0) throw new TronRpcError("tron-rpc-bootstrap-event-api");
    safeHead = Math.min(safeHead, (await reader.getSolidHead()).timestamp * 1000);
    solidHeadValidated = true;
    if (lastTimestampMs > safeHead) throw new TronRpcError("tron-rpc-cursor-ahead");
    const from = await reader.findBlockAtTimestamp(lastTimestampMs);
    const targetTo = Math.min((await reader.getSolidHead()).number, await reader.findBlockAtTimestamp(safeHead + 1) - 1);
    // Hydrate this bounded interval before another config consumes the shared request budget.
    const to = Math.min(targetTo, from + MAX_TRON_RPC_WINDOWS_PER_SCAN * TRON_RPC_MAX_BLOCK_SPAN - 1);
    if (from > to) {
      complete = true;
      scannedToTimestamp = safeHead;
    } else {
      const result = await reader.getLogs(config.contractAddress, config.events.map((event) => event.topicHash), from, to);
      reason = result.reason;
      maxSplitDepth = result.maxSplitDepth;
      let verifiedTo = result.scannedToBlock;
      const byBlock = new Map<number, TronRpcLog[]>();
      for (const log of result.logs) {
        const group = byBlock.get(log.blockNumber) ?? [];
        group.push(log);
        byBlock.set(log.blockNumber, group);
      }
      for (const [number, logs] of byBlock) {
        try {
          const block = await reader.getBlock(number);
          if (block.timestamp * 1000 < lastTimestampMs || block.timestamp * 1000 > safeHead) {
            throw new TronRpcError("tron-rpc-timestamp-outside-window");
          }
          const indices = await reader.getTransactionLogIndices(number, logs);
          const blockRows = logs.map((log) => {
            const local = indices.get(log.logIndex);
            if (log.blockHash !== block.hash || local == null) throw new TronRpcError("tron-rpc-block-context-mismatch");
            return parseTronRpcEvent(config, log, block.timestamp, local);
          });
          rows.push(...blockRows);
        } catch (error) {
          throwIfAborted(signal);
          verifiedTo = number - 1;
          reason = error instanceof TronRpcError ? error.reason : "tron-rpc-decode-failed";
          break;
        }
      }
      complete = result.complete && verifiedTo === targetTo;
      if (result.complete && verifiedTo === to && to < targetTo) reason = "tron-rpc-range-budget";
      if (complete) scannedToTimestamp = safeHead;
      else if (verifiedTo >= from) scannedToTimestamp = (await reader.getBlock(verifiedTo)).timestamp * 1000;
    }
    if (complete) await reader.getSolidHead();
  } catch (error) {
    throwIfAborted(signal);
    complete = false;
    scannedToTimestamp = null;
    reason = error instanceof TronRpcError ? error.reason : "tron-rpc-read-failed";
    if (!solidHeadValidated) {
      reason = ["tron-rpc-stale-solid-head", "tron-rpc-future-solid-head"]
        .find((headReason) => reader.failures.some((failure) => failure.endsWith(`:${headReason}`))) ?? reason;
    }
  }
  const telemetry: TronScanTelemetry = {
    source: "unavailable", dwellirCalls: reader.calls.dwellir - before.dwellir,
    trongridRpcCalls: reader.calls.trongrid - before.trongrid, eventApiCalls: 0,
    fallbackReason: reason ?? reader.failures[failureOffset] ?? null,
    trongridFailureReason: reader.failures.slice(failureOffset).find((failure) => failure.startsWith("trongrid:")) ?? null,
    orderRepairSkippedRows: rows.length, orderRepairSkipReason: rows.length ? "rpc-transaction-index-observed" : null,
    amountRepairSkippedRows: rows.filter((row) => row.amount_source === "event").length,
    amountRepairSkipReason: rows.some((row) => row.amount_source === "event") ? "rpc-event-amount-observed" : null,
  };
  const dwellir = reader.successfulCalls.dwellir > successfulBefore.dwellir;
  const trongrid = reader.successfulCalls.trongrid > successfulBefore.trongrid;
  telemetry.source = dwellir && trongrid ? "mixed-jsonrpc" : dwellir ? "dwellir-jsonrpc" : trongrid ? "trongrid-jsonrpc" : "unavailable";
  const rpcCalls = telemetry.dwellirCalls + telemetry.trongridRpcCalls;
  if (!complete && options.eventApiAllowed && reason !== "tron-rpc-cursor-ahead"
    && reason !== "tron-rpc-stale-solid-head"
    && reason !== "tron-rpc-future-solid-head"
    && reason !== "tron-rpc-range-budget"
    && Date.now() < runBudget.deadlineMs && runBudget.subrequestBudget.count < runBudget.subrequestBudget.limit) {
    const fallback = await fetchTronEventsIncremental(config, options.apiKey, lastTimestampMs,
      runBudget, options.rateLimit, signal, options.db, safeHead);
    telemetry.eventApiCalls = fallback.providerCalls;
    if (fallback.apiError) telemetry.trongridFailureReason = "trongrid-event-api-failed";
    if (!fallback.incomplete || scannedToTimestamp == null) {
      return { ...fallback, providerCalls: rpcCalls + fallback.providerCalls,
        maxSplitDepth, failureSamples: reason ? [reason] : [], tronRpc: { ...telemetry,
          source: "trongrid-events", orderRepairSkippedRows: 0, orderRepairSkipReason: null,
          amountRepairSkippedRows: 0, amountRepairSkipReason: null } };
    }
  }
  return {
    rows, maxBlock: scannedToTimestamp ?? lastTimestampMs, scannedToTimestamp, safeHead,
    incomplete: !complete, apiError: !complete && reason !== "tron-rpc-budget-exhausted" && reason !== "tron-rpc-range-budget",
    topicCount: config.events.length, coveredTopicCount: scannedToTimestamp != null ? config.events.length : 0,
    providerCalls: rpcCalls + telemetry.eventApiCalls, usedRpcLogs: true, maxSplitDepth,
    failureSamples: reason ? [reason] : [], tronRpc: telemetry,
  };
}

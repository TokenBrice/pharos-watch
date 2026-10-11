import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { register } from "tsx/esm/api";
import {
  CliUsageError,
  assertCliUsage,
  parseStrictCliArgs,
  requireCliString,
  runDirectCli,
  writeCliHelpIfRequested,
  writeFileResolved,
} from "../lib/cli-args.mjs";
import { resolvePinnedProvider } from "../lib/pinned-rpc-providers.mjs";

const USAGE = `Pinned supplemental Dwellir evidence reads (no provider-priority changes).
Usage: node scripts/maintenance/dwellir-rpc.mjs --chain <Pharos id> --method <method> --params <json> --block <number|hash> [--provider dwellir|alchemy|drpc|public] [--out <file>]
EVM: eth_call, eth_getBalance, eth_getStorageAt, eth_getCode, eth_getTransactionCount,
     eth_getLogs, eth_getBlockByNumber, eth_getBlockByHash,
     eth_getTransactionReceipt, eth_getTransactionByHash (one 32-byte tx hash; returned block must match --block).
     batch accepts [{method,params}] (1–100), excluding logs and transaction reads.
Move: --method 'GET /accounts/<address>/resource/<type>' --block <ledger_version>
Starknet: --method starknet_call --params '{"request":{...}}' --block <number>
Solana: getBlock/getTransaction/getBlocks; Alchemy paid getAccountInfo with exact slot.
Sui: public GraphQL sui_getObject/suix_getBalance (checkpoint-scoped state);
     Dwellir legacy sui_getCheckpoint/sui_getTransactionBlock (execution only).
Auth: provider's canonical *_API_KEY environment variable, then repo-root .env.local.
Requests are serialized with at least 100 ms between response members (10 responses/s).
JSON states: ok, empty (not proof of absence), error, unsupported. Usage exits 2; non-ok failures exit 1.`;
const STATE_INDEX = new Map([
  ["eth_call", 1], ["eth_getBalance", 1], ["eth_getStorageAt", 2], ["eth_getCode", 1], ["eth_getTransactionCount", 1],
]);
const TRANSACTION_METHODS = new Set(["eth_getTransactionReceipt", "eth_getTransactionByHash"]);
const EVM_METHODS = new Set([...STATE_INDEX.keys(), "eth_getLogs", "eth_getBlockByNumber", "eth_getBlockByHash", ...TRANSACTION_METHODS]);

class EvidenceError extends Error {
  constructor(reason, message, details) {
    super(message);
    this.reason = reason;
    this.details = details;
  }
}

class UnsupportedError extends EvidenceError {
  constructor(reason, message) {
    super(reason, message);
    this.state = "unsupported";
  }
}

function integer(value, name) {
  assertCliUsage(
    (typeof value === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value))
      || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0),
    `${name} must be a non-negative numeric pin, never latest/pending/safe/finalized`,
  );
  return BigInt(value);
}

function pin(value) {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value)
    ? { hash: value.toLowerCase() }
    : { number: integer(value, "--block") };
}

function hex(value) {
  return `0x${value.toString(16)}`;
}

function timestamp(value, divisor = 1n) {
  const seconds = integer(value, "block timestamp") / divisor;
  const milliseconds = Number(seconds * 1000n);
  if (!Number.isSafeInteger(milliseconds)) throw new EvidenceError("invalid-block-header", "Block timestamp is out of range");
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) throw new EvidenceError("invalid-block-header", "Invalid block timestamp");
  return date.toISOString();
}

async function apiKey(variable) {
  if (!variable) return undefined;
  if (process.env[variable]?.trim()) return process.env[variable].trim();
  let contents;
  try {
    contents = await readFile(new URL("../../.env.local", import.meta.url), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw new EvidenceError("credentials-unreadable", "Cannot read repo-root .env.local");
  }
  const key = contents === undefined ? undefined : parseEnv(contents)[variable]?.trim();
  if (!key) throw new EvidenceError("missing-api-key", `Set ${variable} in the environment or repo-root .env.local; see .env.example for the canonical variable name`);
  return key;
}

function transport(endpoint, headers) {
  let nextAt = 0;
  let id = 0;
  async function request(url, body, members = 1) {
    await sleep(Math.max(0, nextAt - Date.now()));
    nextAt = Date.now() + 100 * members;
    let response;
    let text;
    try {
      response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      text = await response.text();
    } catch {
      throw new EvidenceError("transport-error", "Provider request or response body failed");
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      if (response.ok) throw new EvidenceError("invalid-json", "Provider returned invalid JSON");
    }
    if (!response.ok) {
      // Providers can encode entitlement/history errors as JSON-RPC over HTTP 400.
      // Preserve their diagnosis, but never accept a result on an unsuccessful HTTP status.
      if (body?.id !== undefined && payload?.id === body.id && payload.jsonrpc === "2.0" && payload.error) {
        const rpcMessage = typeof payload.error.message === "string" ? payload.error.message : null;
        throw new EvidenceError("rpc-error", rpcMessage ?? "Provider returned a JSON-RPC error", {
          httpStatus: response.status, rpcCode: payload.error.code, rpcMessage,
        });
      }
      throw new EvidenceError("http-error", `Provider returned HTTP ${response.status}`, { httpStatus: response.status });
    }
    return payload;
  }
  function unwrap(payload, expectedId) {
    if (!payload || payload.id !== expectedId || payload.jsonrpc !== "2.0") {
      throw new EvidenceError("invalid-rpc-response", "RPC response identity does not match the request");
    }
    if (payload.error) {
      const rpcMessage = typeof payload.error.message === "string" ? payload.error.message : null;
      throw new EvidenceError("rpc-error", rpcMessage ?? "Provider returned a JSON-RPC error", {
        rpcCode: payload.error.code,
        rpcMessage,
      });
    }
    if (!Object.hasOwn(payload, "result")) throw new EvidenceError("missing-result", "RPC response has no result");
    return payload.result;
  }
  return {
    request,
    async rpc(method, params) {
      const requestId = ++id;
      return unwrap(await request(endpoint, { jsonrpc: "2.0", id: requestId, method, params }), requestId);
    },
    async batch(calls) {
      const requests = calls.map(({ method, params }) => ({ jsonrpc: "2.0", id: ++id, method, params }));
      const payload = await request(endpoint, requests, requests.length);
      if (!Array.isArray(payload) || payload.length !== requests.length) {
        throw new EvidenceError("invalid-batch-response", "RPC batch is incomplete");
      }
      const byId = new Map(payload.map((item) => [item?.id, item]));
      if (byId.size !== requests.length) throw new EvidenceError("invalid-batch-response", "RPC batch has duplicate response ids");
      return requests.map((item) => unwrap(byId.get(item.id), item.id));
    },
  };
}

function evmHeader(raw, requested) {
  if (!raw || !/^0x[0-9a-f]{64}$/i.test(raw.hash ?? "")) {
    throw new EvidenceError("missing-block-header", "Pinned EVM block header is unavailable");
  }
  const number = integer(raw.number, "block number");
  if ((requested.number !== undefined && number !== requested.number)
    || (requested.hash !== undefined && raw.hash.toLowerCase() !== requested.hash)) {
    throw new EvidenceError("block-pin-mismatch", "EVM block header does not match the requested pin");
  }
  return { number: number.toString(), hash: raw.hash.toLowerCase(), timestamp: timestamp(raw.timestamp) };
}

async function readEvmHeader(rpc, requested) {
  return evmHeader(await rpc(
    requested.hash ? "eth_getBlockByHash" : "eth_getBlockByNumber",
    [requested.hash ?? hex(requested.number), false],
  ), requested);
}

function sameHeader(before, after) {
  if (before.number !== after.number || before.hash !== after.hash || before.timestamp !== after.timestamp) {
    throw new EvidenceError("block-changed", "Pinned block changed during the read; result withheld");
  }
}

function normalizeEvm(method, params, block) {
  assertCliUsage(EVM_METHODS.has(method), `Unsupported evidence method: ${method}`);
  assertCliUsage(Array.isArray(params), `${method} --params must be an array`);
  const normalized = [...params];
  const index = STATE_INDEX.get(method);
  if (index !== undefined) {
    assertCliUsage(params.length === index || params.length === index + 1
      || (method === "eth_call" && params.length === 3), `${method} has an invalid parameter count`);
    if (method === "eth_call" && params.length === 3) {
      assertCliUsage(params[2] && typeof params[2] === "object" && !Array.isArray(params[2]), "eth_call state overrides must be an object");
    }
    if (params.length > index) {
      const supplied = pin(params[index]);
      assertCliUsage(supplied.hash ? supplied.hash === block.hash : supplied.number === BigInt(block.number), "Parameter block must match --block");
    }
    normalized[index] = hex(BigInt(block.number));
  } else if (method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") {
    assertCliUsage(params.length <= 2 && (params[1] === undefined || typeof params[1] === "boolean"), "Block parameters must be [pin, boolean]");
    if (params[0] !== undefined) {
      const supplied = pin(params[0]);
      assertCliUsage(supplied.hash ? supplied.hash === block.hash : supplied.number === BigInt(block.number), "Parameter block must match --block");
    }
    normalized[0] = method === "eth_getBlockByHash" ? block.hash : hex(BigInt(block.number));
    normalized[1] = params[1] ?? false;
  } else if (TRANSACTION_METHODS.has(method)) {
    assertCliUsage(params.length === 1 && typeof params[0] === "string" && /^0x[0-9a-f]{64}$/i.test(params[0]),
      `${method} requires exactly one 32-byte transaction hash`);
  } else {
    assertCliUsage(params.length === 1 && params[0] && typeof params[0] === "object" && !Array.isArray(params[0]), "eth_getLogs requires one filter object");
    const filter = { ...params[0] };
    if (filter.blockHash !== undefined) {
      assertCliUsage(filter.fromBlock === undefined && filter.toBlock === undefined, "blockHash conflicts with log range");
      assertCliUsage(typeof filter.blockHash === "string" && filter.blockHash.toLowerCase() === block.hash, "Log blockHash must match --block");
    } else {
      const from = integer(filter.fromBlock, "fromBlock");
      const to = integer(filter.toBlock, "toBlock");
      assertCliUsage(from <= to && to === BigInt(block.number), "Log range must be ascending and toBlock must match --block");
      filter.fromBlock = hex(from);
      filter.toBlock = hex(to);
    }
    normalized[0] = filter;
  }
  return { method, params: normalized };
}

async function evmRead(transport, method, params, requested, record, maxLogBlockSpan) {
  const block = await readEvmHeader(transport.rpc, requested);
  record.block = block;
  if (method === "batch") {
    assertCliUsage(Array.isArray(params) && params.length > 0 && params.length <= 100, "batch requires 1–100 {method,params} entries");
    const calls = params.map((item) => {
      assertCliUsage(item && typeof item === "object" && item.method !== "eth_getLogs", "Batch log reads must use standalone eth_getLogs for chunk provenance");
      assertCliUsage(!TRANSACTION_METHODS.has(item.method), "Batch transaction reads must use standalone methods for block-pin validation");
      return normalizeEvm(item.method, item.params, block);
    });
    record.params = calls.map(({ method: callMethod, params: callParams }) => ({ method: callMethod, params: callParams }));
    if (calls.some((call) => call.method === "eth_call" && call.params.length === 3)) record.simulation = true;
    const result = [];
    for (let index = 0; index < calls.length; index += 10) {
      result.push(...await transport.batch(calls.slice(index, index + 10)));
    }
    sameHeader(block, await readEvmHeader(transport.rpc, { number: BigInt(block.number) }));
    return result.map((value, index) => ({
      method: calls[index].method,
      params: calls[index].params,
      ...(calls[index].method === "eth_call" && calls[index].params.length === 3 ? { simulation: true } : {}),
      result: value,
      state: empty(value) ? "empty" : "ok",
      reason: empty(value) ? "empty-result-not-proof-of-absence" : null,
    }));
  }
  const call = normalizeEvm(method, params, block);
  record.params = call.params;
  if (method === "eth_call" && call.params.length === 3) record.simulation = true;
  let result;
  if (method === "eth_getLogs") {
    const filter = call.params[0];
    record.chunks = [];
    result = [];
    const from = filter.blockHash ? BigInt(block.number) : BigInt(filter.fromBlock);
    const to = filter.blockHash ? from : BigInt(filter.toBlock);
    record.range = { fromBlock: from.toString(), toBlock: to.toString() };
    record.rangeStartBlock = await readEvmHeader(transport.rpc, { number: from });
    async function readChunk(start, end) {
      const chunkParams = [filter.blockHash ? filter : { ...filter, fromBlock: hex(start), toBlock: hex(end) }];
      let chunk;
      try {
        chunk = await transport.rpc(method, chunkParams);
      } catch (error) {
        if (error.reason !== "rpc-error" || error.details?.rpcCode !== -32602
          || !/exceeds max results/i.test(error.details.rpcMessage ?? "")) throw error;
        if (start === end) {
          record.chunks.push({ params: chunkParams, state: "error", reason: "result-cap", error: error.details });
          throw new EvidenceError("result-cap", error.message, error.details);
        }
        const suggested = /retry with the range\s+(\d+)\s*-\s*(\d+)/i.exec(error.details.rpcMessage);
        const suggestedEnd = suggested ? BigInt(suggested[2]) : null;
        const splitAt = suggested && BigInt(suggested[1]) === start
          && suggestedEnd >= start && suggestedEnd < end
          ? suggestedEnd
          : start + (end - start) / 2n;
        record.chunks.push({
          params: chunkParams, state: "split", reason: "result-cap", error: error.details,
          splitAt: splitAt.toString(),
        });
        await readChunk(start, splitAt);
        await readChunk(splitAt + 1n, end);
        return;
      }
      if (!Array.isArray(chunk)) throw new EvidenceError("invalid-log-result", "Log response is not an array");
      for (const log of chunk) {
        const logBlock = integer(log?.blockNumber, "log block number");
        if (logBlock < start || logBlock > end || log.removed === true
          || (filter.blockHash && log.blockHash?.toLowerCase() !== block.hash)) {
          throw new EvidenceError("invalid-log-result", "Log response falls outside the pinned canonical range");
        }
      }
      record.chunks.push({ params: chunkParams, state: chunk.length === 0 ? "empty" : "ok", count: chunk.length });
      result.push(...chunk);
    }
    const chunkSpan = BigInt(maxLogBlockSpan ?? 500);
    for (let start = from; start <= to; start += chunkSpan) {
      const end = start + chunkSpan - 1n < to ? start + chunkSpan - 1n : to;
      await readChunk(start, end);
    }
    sameHeader(record.rangeStartBlock, await readEvmHeader(transport.rpc, { number: from }));
  } else {
    result = await transport.rpc(method, call.params);
    if (method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") {
      sameHeader(block, evmHeader(result, { number: BigInt(block.number) }));
    }
  }
  const after = await readEvmHeader(transport.rpc, { number: BigInt(block.number) });
  sameHeader(block, after);
  if (TRANSACTION_METHODS.has(method) && result !== null) {
    if (integer(result?.blockNumber, "transaction block number") !== BigInt(after.number)
      || typeof result?.blockHash !== "string" || result.blockHash.toLowerCase() !== after.hash) {
      throw new EvidenceError("block-pin-mismatch", "Transaction result does not match the pinned canonical block; result withheld");
    }
  }
  return result;
}

async function moveRead(transport, endpoint, method, params, requested, record) {
  assertCliUsage(requested.number !== undefined, "Move --block is a numeric ledger_version, not a block hash");
  assertCliUsage(params && typeof params === "object" && !Array.isArray(params), "Move --params must be a query object");
  const path = method.replace(/^GET\s+/, "");
  const segments = path.split("/");
  const accountPath = segments[0] === "" && segments[1] === "accounts" && segments[2]?.length > 0;
  const accountEndpoint = segments.length === 3;
  const collectionEndpoint = segments.length === 4 && ["resources", "modules"].includes(segments[3]);
  const namedEndpoint = segments.length >= 5 && ["resource", "module"].includes(segments[3])
    && (segments.length > 5 || segments[4].length > 0);
  assertCliUsage(accountPath && !path.includes("?") && !path.includes("#")
    && (accountEndpoint || collectionEndpoint || namedEndpoint),
  "Move method must be a ledger-pinnable GET /accounts/... path without a query string");
  if (params.ledger_version !== undefined) {
    assertCliUsage(integer(params.ledger_version, "ledger_version") === requested.number, "ledger_version must match --block");
  }
  const base = `${endpoint.replace(/\/$/, "")}/`;
  const headerUrl = new URL(`blocks/by_version/${requested.number}?with_transactions=false`, base);
  async function header() {
    const raw = await transport.request(headerUrl);
    if (!raw || !/^0x[0-9a-f]{64}$/i.test(raw.block_hash ?? "")
      || integer(raw.first_version, "first_version") > requested.number
      || integer(raw.last_version, "last_version") < requested.number) {
      throw new EvidenceError("missing-block-header", "Ledger version has no matching block header");
    }
    return {
      number: integer(raw.block_height, "block_height").toString(),
      hash: raw.block_hash.toLowerCase(),
      timestamp: timestamp(raw.block_timestamp, 1_000_000n),
    };
  }
  record.ledgerVersion = requested.number.toString();
  record.block = await header();
  record.params = { ...params, ledger_version: record.ledgerVersion };
  const url = new URL(path.slice(1), base);
  for (const [name, value] of Object.entries(record.params)) {
    assertCliUsage(typeof value === "string" || typeof value === "number" || typeof value === "boolean", "Move query values must be scalars");
    assertCliUsage(["ledger_version", "start", "limit"].includes(name), "Move query supports ledger_version, start, and limit only");
    url.searchParams.set(name, String(value));
  }
  record.requestUrl = url.href;
  const result = await transport.request(url);
  if (result?.error_code) throw new EvidenceError("native-api-error", "Move endpoint returned an API error");
  sameHeader(record.block, await header());
  return result;
}

async function starknetRead(transport, method, params, requested, record) {
  assertCliUsage(method === "starknet_call", "Starknet evidence supports starknet_call only");
  assertCliUsage(requested.number !== undefined && requested.number <= BigInt(Number.MAX_SAFE_INTEGER), "Starknet requires a safe numeric --block");
  assertCliUsage(params && typeof params === "object" && !Array.isArray(params) && params.request, "starknet_call --params requires a request object");
  if (params.block_id !== undefined) {
    assertCliUsage(params.block_id && typeof params.block_id === "object"
      && integer(params.block_id.block_number, "block_id.block_number") === requested.number,
    "Starknet block_id must be numeric and match --block");
  }
  const blockId = { block_number: Number(requested.number) };
  async function header() {
    const raw = await transport.rpc("starknet_getBlockWithTxHashes", { block_id: blockId });
    if (!raw || !/^0x[0-9a-f]{1,64}$/i.test(raw.block_hash ?? "")
      || integer(raw.block_number, "block_number") !== requested.number) {
      throw new EvidenceError("missing-block-header", "Starknet pinned header is unavailable");
    }
    return { number: requested.number.toString(), hash: raw.block_hash.toLowerCase(), timestamp: timestamp(raw.timestamp) };
  }
  record.block = await header();
  record.params = { ...params, block_id: blockId };
  const result = await transport.rpc(method, record.params);
  sameHeader(record.block, await header());
  return result;
}

async function hederaRead(transport, endpoint, method, params, requested, record) {
  assertCliUsage(["eth_call", "POST /contracts/call"].includes(method), "Hedera mirror evidence supports eth_call or POST /contracts/call");
  assertCliUsage(requested.number !== undefined, "Hedera mirror evidence requires a numeric block pin");
  const number = requested.number.toString();
  const base = `${endpoint.replace(/\/$/, "")}/`;
  async function header() {
    const raw = await transport.request(new URL(`blocks/${number}`, base));
    if (!raw || integer(raw.number, "Hedera block number") !== requested.number
      || !/^0x(?:[0-9a-f]{64}|[0-9a-f]{96})$/i.test(raw.hash ?? "")
      || !/^[0-9]+\.[0-9]{1,9}$/.test(raw.timestamp?.to ?? "")) {
      throw new EvidenceError("missing-block-header", "Hedera mirror block number/hash/consensus timestamp is unavailable");
    }
    record.consensusTimestamp = raw.timestamp.to;
    return { number, hash: raw.hash.toLowerCase(), timestamp: timestamp(raw.timestamp.to.split(".")[0]) };
  }
  let call;
  if (method === "eth_call") {
    assertCliUsage(Array.isArray(params) && params.length >= 1 && params.length <= 2, "Hedera eth_call requires [call, optional matching block]");
    call = params[0];
    if (params[1] !== undefined) assertCliUsage(integer(params[1], "parameter block") === requested.number, "Parameter block must match --block");
  } else {
    call = params;
  }
  assertCliUsage(call && typeof call === "object" && !Array.isArray(call), "Hedera call must be an object");
  if (call.block !== undefined) assertCliUsage(integer(call.block, "call block") === requested.number, "Call block must match --block");
  assertCliUsage(call.estimate === undefined || call.estimate === false, "Evidence calls cannot estimate gas");
  record.block = await header();
  record.params = { ...call, block: hex(requested.number), estimate: false };
  const url = new URL("contracts/call", base);
  record.requestUrl = url.href;
  const raw = await transport.request(url, record.params);
  if (!raw || typeof raw.result !== "string" || !/^0x[0-9a-f]*$/i.test(raw.result)) {
    throw new EvidenceError("native-api-error", "Hedera mirror did not return contract-call bytes");
  }
  sameHeader(record.block, await header());
  return raw.result;
}

function safeNativePin(requested, name) {
  assertCliUsage(requested.number !== undefined && requested.number <= BigInt(Number.MAX_SAFE_INTEGER), `${name} requires a safe numeric --block`);
  return Number(requested.number);
}

function solanaHeader(raw, slot) {
  if (!raw || typeof raw.blockhash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw.blockhash)
    || raw.blockTime === null || raw.blockTime === undefined) {
    throw new EvidenceError("missing-block-header", "Finalized Solana block hash/time is unavailable; skipped/pruned slots are not evidence");
  }
  return { number: String(slot), hash: raw.blockhash, timestamp: timestamp(raw.blockTime) };
}

function solanaConfig(value = {}) {
  assertCliUsage(value && typeof value === "object" && !Array.isArray(value), "Solana config must be an object");
  assertCliUsage(value.commitment === undefined || value.commitment === "finalized", "Solana evidence requires finalized commitment");
  assertCliUsage(value.minContextSlot === undefined, "minContextSlot is a lower bound, not a historical state pin");
  return { ...value, commitment: "finalized" };
}

async function solanaRead(transport, method, params, requested, record) {
  const slot = safeNativePin(requested, "Solana slot");
  assertCliUsage(Array.isArray(params), "Solana --params must be an array");
  const headerParams = [slot, { commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }];
  async function header() {
    return solanaHeader(await transport.rpc("getBlock", headerParams), slot);
  }
  record.block = await header();
  record.slot = String(slot);
  let result;
  if (method === "getBlock") {
    assertCliUsage(params.length <= 2, "getBlock requires [slot, config]");
    if (params[0] !== undefined) assertCliUsage(integer(params[0], "slot") === requested.number, "getBlock slot must match --block");
    record.params = [slot, solanaConfig(params[1])];
    result = await transport.rpc(method, record.params);
    sameHeader(record.block, solanaHeader(result, slot));
  } else if (method === "getTransaction") {
    assertCliUsage(params.length >= 1 && params.length <= 2 && typeof params[0] === "string", "getTransaction requires [signature, config]");
    record.params = [params[0], solanaConfig(params[1])];
    result = await transport.rpc(method, record.params);
    if (result !== null && integer(result?.slot, "transaction slot") !== requested.number) {
      throw new EvidenceError("block-pin-mismatch", "Solana transaction does not belong to --block slot");
    }
  } else if (method === "getAccountInfo") {
    // Alchemy's paid Account Archive explicitly defines slot as state-as-of,
    // unlike the standard lower-bound minContextSlot parameter.
    assertCliUsage(params.length >= 1 && params.length <= 2 && typeof params[0] === "string", "getAccountInfo requires [pubkey, config]");
    if (params[0].startsWith("Sysvar")) throw new UnsupportedError("unsupported-account-class", "Sysvar accounts are excluded conservatively from historical account evidence");
    const config = solanaConfig(params[1]);
    assertCliUsage(config.lastUpdateBeforeSlot === undefined && config.firstUpdateAfterSlot === undefined, "History cursors are not an exact state-as-of slot");
    if (config.slot !== undefined) assertCliUsage(integer(config.slot, "account slot") === requested.number, "Account slot must match --block");
    record.params = [params[0], { ...config, slot }];
    result = await transport.rpc(method, record.params);
    if (!result || !Object.hasOwn(result, "value") || integer(result.context?.slot, "account context slot") !== requested.number) {
      throw new EvidenceError("block-pin-mismatch", "Alchemy account archive did not return the exact requested slot");
    }
    if (result.value?.owner === "Vote111111111111111111111111111111111111111") {
      throw new UnsupportedError("unsupported-account-class", "Vote accounts are excluded from Alchemy historical account coverage");
    }
  } else {
    assertCliUsage(params.length >= 1 && params.length <= 3, "getBlocks requires [startSlot, endSlot, config]");
    const start = integer(params[0], "startSlot");
    assertCliUsage(start <= requested.number, "getBlocks range must be ascending");
    if (params[1] !== undefined) assertCliUsage(integer(params[1], "endSlot") === requested.number, "getBlocks endSlot must match --block");
    const config = solanaConfig(params[2]);
    record.params = [Number(start), slot, config];
    record.range = { fromSlot: start.toString(), toSlot: String(slot) };
    record.chunks = [];
    result = [];
    for (let from = start; from <= requested.number; from += 500n) {
      const to = from + 499n < requested.number ? from + 499n : requested.number;
      const chunkParams = [Number(from), Number(to), config];
      const chunk = await transport.rpc(method, chunkParams);
      if (!Array.isArray(chunk) || chunk.some((value, index) => !Number.isSafeInteger(value)
        || BigInt(value) < from || BigInt(value) > to || (index > 0 && value <= chunk[index - 1]))) {
        throw new EvidenceError("invalid-slot-result", "Solana produced slots are not ordered within the requested range");
      }
      record.chunks.push({ params: chunkParams, state: chunk.length ? "ok" : "empty", count: chunk.length });
      result.push(...chunk);
    }
  }
  sameHeader(record.block, await header());
  return result;
}

async function suiRead(transport, method, params, requested, record) {
  const checkpoint = safeNativePin(requested, "Sui checkpoint");
  assertCliUsage(Array.isArray(params), "Sui --params must be an array");
  async function header() {
    const raw = await transport.rpc("sui_getCheckpoint", [String(checkpoint)]);
    if (!raw || integer(raw.sequenceNumber, "checkpoint sequenceNumber") !== requested.number
      || typeof raw.digest !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw.digest)) {
      throw new EvidenceError("missing-block-header", "Sui checkpoint digest is unavailable or mismatched");
    }
    return { raw, block: { number: String(checkpoint), hash: raw.digest, timestamp: timestamp(raw.timestampMs, 1000n) } };
  }
  const before = await header();
  record.block = before.block;
  record.checkpoint = String(checkpoint);
  let result;
  if (method === "sui_getCheckpoint") {
    assertCliUsage(params.length <= 1, "sui_getCheckpoint accepts one matching checkpoint");
    if (params[0] !== undefined) assertCliUsage(integer(params[0], "checkpoint") === requested.number, "Checkpoint parameter must match --block");
    record.params = [String(checkpoint)];
    result = before.raw;
  } else {
    assertCliUsage(params.length >= 1 && params.length <= 2 && typeof params[0] === "string", "sui_getTransactionBlock requires [digest, options]");
    record.params = params;
    result = await transport.rpc(method, params);
    if (result !== null && (integer(result?.checkpoint, "transaction checkpoint") !== requested.number
      || result.digest !== params[0] || !Array.isArray(before.raw.transactions)
      || !before.raw.transactions.includes(result.digest))) {
      throw new EvidenceError("block-pin-mismatch", "Sui transaction is not included in the pinned checkpoint");
    }
  }
  sameHeader(record.block, (await header()).block);
  return result;
}

async function suiGraphqlRead(transport, endpoint, method, params, requested, record) {
  const checkpoint = safeNativePin(requested, "Sui checkpoint");
  assertCliUsage(Array.isArray(params), "Sui GraphQL --params must be an array");
  async function query(text, variables) {
    const raw = await transport.request(endpoint, { query: text, variables });
    if (!raw || raw.errors?.length || !raw.data) {
      throw new EvidenceError("graphql-error", "Sui GraphQL returned errors or no data; partial data withheld");
    }
    return raw.data.checkpoint;
  }
  const fields = "sequenceNumber digest timestamp";
  async function header() {
    const raw = await query(`query($cp: UInt53!) { checkpoint(sequenceNumber: $cp) { ${fields} } }`, { cp: checkpoint });
    const milliseconds = typeof raw?.timestamp === "string" ? Date.parse(raw.timestamp) : NaN;
    if (!raw || integer(raw.sequenceNumber, "checkpoint") !== requested.number
      || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw.digest ?? "") || !Number.isFinite(milliseconds)) {
      throw new EvidenceError("missing-block-header", "Sui GraphQL checkpoint number/digest/time is unavailable");
    }
    return { number: String(checkpoint), hash: raw.digest, timestamp: new Date(milliseconds).toISOString() };
  }
  record.block = await header();
  record.checkpoint = String(checkpoint);
  assertCliUsage(typeof params[0] === "string" && /^0x[0-9a-f]{1,64}$/i.test(params[0]), "Sui GraphQL requires an object/owner address");
  const isObject = method === "sui_getObject";
  assertCliUsage(params.length === (isObject ? 1 : 2), isObject ? "sui_getObject requires [objectId]" : "suix_getBalance requires [owner, coinType]");
  if (!isObject) assertCliUsage(typeof params[1] === "string" && params[1].length > 0, "coinType is required");
  const selection = isObject
    ? "object(address: $address) { address version digest asMoveObject { contents { json bcs type { repr } } } }"
    : "address(address: $address) { balance(coinType: $coinType) { coinType { repr } totalBalance } }";
  const variables = { cp: checkpoint, address: params[0], ...(!isObject ? { coinType: params[1] } : {}) };
  record.params = params;
  record.request = { query: `query($cp: UInt53!, $address: SuiAddress!${isObject ? "" : ", $coinType: String!"}) { checkpoint(sequenceNumber: $cp) { ${fields} query { ${selection} } } }`, variables };
  const raw = await query(record.request.query, variables);
  if (!raw || integer(raw.sequenceNumber, "checkpoint") !== requested.number || raw.digest !== record.block.hash) {
    throw new EvidenceError("block-pin-mismatch", "Sui GraphQL state is not scoped to the requested checkpoint");
  }
  const result = isObject ? raw.query?.object : raw.query?.address?.balance;
  if (result === undefined) throw new EvidenceError("missing-result", "Sui GraphQL omitted the scoped result");
  sameHeader(record.block, await header());
  return result;
}

function assertPinnedCapability(protocol, method, provider) {
  if (protocol === "hedera-rest" && !["eth_call", "POST /contracts/call"].includes(method)) {
    throw new UnsupportedError("unsupported-pinned-state", "Hedera mirror historical evidence supports contract calls only; this endpoint does not provide pinned eth_getCode/account/storage RPC parity");
  }
  if (protocol === "sui-graphql" && !["sui_getObject", "suix_getBalance"].includes(method)) {
    throw new UnsupportedError("unsupported-pinned-state", "The public Sui GraphQL helper supports checkpoint-scoped object and single-coin balance reads only");
  }
  if (protocol === "tron-http") {
    throw new UnsupportedError("unsupported-pinned-state", "TRON constant calls execute current state, not a historical pin; no evidence read was sent");
  }
  if (protocol === "solana-jsonrpc" && !["getBlock", "getTransaction", "getBlocks", ...(provider === "alchemy" ? ["getAccountInfo"] : [])].includes(method)) {
    throw new UnsupportedError("unsupported-pinned-state", "Solana account/token/program state and address signature pagination do not accept an exact historical slot; minContextSlot is not a pin. Use finalized block/transaction execution records instead");
  }
  if (protocol === "sui-jsonrpc" && !["sui_getCheckpoint", "sui_getTransactionBlock"].includes(method)) {
    throw new UnsupportedError("unsupported-pinned-state", "Sui current object/balance/dynamic-field reads do not accept a checkpoint; object version reads alone do not prove the object's state at that checkpoint");
  }
}

function empty(result) {
  return result === null || result === "0x" || (Array.isArray(result) && (result.length === 0
    || result.every((item) => item?.state === "empty")));
}

export async function main(argv = process.argv.slice(2)) {
  let values = {};
  let key;
  const record = { chain: null, provider: null, endpoint: null, method: null, params: null, requestedBlock: null, block: null, result: null, state: "error", reason: null, observedAt: null };
  try {
    ({ values } = parseStrictCliArgs(argv, {
      options: { chain: { type: "string" }, provider: { type: "string" }, method: { type: "string" }, params: { type: "string" }, block: { type: "string" }, out: { type: "string" } },
    }));
    if (writeCliHelpIfRequested(values, USAGE)) return;
    record.chain = requireCliString(values.chain, "--chain");
    record.method = requireCliString(values.method, "--method");
    try {
      record.params = JSON.parse(requireCliString(values.params, "--params"));
    } catch (error) {
      if (error instanceof CliUsageError) throw error;
      throw new CliUsageError("--params must be valid JSON");
    }
    record.requestedBlock = requireCliString(values.block, "--block (pinned evidence)");
    const requested = pin(record.requestedBlock);
    register();
    record.provider = values.provider ?? "dwellir";
    assertCliUsage(["dwellir", "alchemy", "drpc", "public"].includes(record.provider), "--provider must be dwellir, alchemy, drpc, or public");
    const target = await resolvePinnedProvider(record.chain, record.provider);
    if (!target) throw new UnsupportedError("unsupported-chain-provider", "No registered pin-capable read surface for this chain/provider; no request was sent");
    record.endpoint = target.endpoint;
    const url = new URL(record.endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.hash
      || [...url.searchParams.keys()].some((name) => !["network", "owner"].includes(name))) {
      throw new EvidenceError("unsafe-endpoint", "Registry endpoint must be a keyless HTTPS URL");
    }
    assertPinnedCapability(target.protocol, record.method, record.provider);
    key = await apiKey(target.credential);
    const headers = target.credential === "DWELLIR_API_KEY" ? { "X-Api-Key": key }
      : target.credential === "ALCHEMY_API_KEY" ? { Authorization: `Bearer ${key}` }
        : target.credential === "DRPC_API_KEY" ? { "Drpc-Key": key } : {};
    const client = transport(record.endpoint, headers);
    const result = target.protocol === "evm"
      ? await evmRead(client, record.method, record.params, requested, record, target.maxLogBlockSpan)
      : target.protocol === "aptos-rest"
        ? await moveRead(client, record.endpoint, record.method, record.params, requested, record)
        : target.protocol === "hedera-rest"
          ? await hederaRead(client, record.endpoint, record.method, record.params, requested, record)
          : target.protocol === "starknet-jsonrpc"
            ? await starknetRead(client, record.method, record.params, requested, record)
            : target.protocol === "solana-jsonrpc"
              ? await solanaRead(client, record.method, record.params, requested, record)
              : target.protocol === "sui-graphql"
                ? await suiGraphqlRead(client, record.endpoint, record.method, record.params, requested, record)
                : await suiRead(client, record.method, record.params, requested, record);
    record.result = result;
    record.state = empty(result) || (record.method === "getAccountInfo" && result.value === null) ? "empty" : "ok";
    record.reason = record.state === "empty" ? "empty-result-not-proof-of-absence" : null;
  } catch (error) {
    record.result = null;
    record.state = error instanceof UnsupportedError ? "unsupported" : "error";
    record.reason = error instanceof CliUsageError ? "invalid-arguments" : error.reason ?? "helper-error";
    record.error = { message: error instanceof CliUsageError || error instanceof EvidenceError ? error.message : "Evidence helper failed", ...error.details };
    process.exitCode = error instanceof CliUsageError ? 2 : 1;
  }
  record.observedAt = new Date().toISOString();
  let output = `${JSON.stringify(record, null, 2)}\n`;
  // Even a provider echo or a malformed caller-supplied parameter cannot persist the credential.
  if (key) output = output.split(key).join("[REDACTED]");
  if (values.out) {
    try {
      writeFileResolved(values.out, output);
    } catch {
      record.state = "error";
      record.reason = "output-write-failed";
      record.result = null;
      record.error = { message: "Cannot write --out provenance file" };
      output = `${JSON.stringify(record, null, 2)}\n`;
      if (key) output = output.split(key).join("[REDACTED]");
      process.exitCode = 1;
    }
  }
  process.stdout.write(output);
}

runDirectCli(import.meta.url, main);

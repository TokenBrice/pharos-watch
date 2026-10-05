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

const USAGE = `Pinned supplemental Dwellir evidence reads (no provider-priority changes).
Usage: node scripts/maintenance/dwellir-rpc.mjs --chain <Pharos id> --method <method> --params <json> --block <number|hash> [--out <file>]
EVM: eth_call, eth_getBalance, eth_getStorageAt, eth_getCode, eth_getLogs,
     eth_getBlockByNumber, eth_getBlockByHash; batch accepts [{method,params}] (1–100).
Move: --method 'GET /accounts/<address>/resource/<type>' --block <ledger_version>
Starknet: --method starknet_call --params '{"request":{...}}' --block <number>
TRON: triggerconstantcontract cannot pin historical state and fails closed.
Auth: DWELLIR_API_KEY environment variable, then repo-root .env.local.
Requests are serialized with at least 100 ms between response members (10 responses/s).
JSON states: ok, empty (not proof of absence), error. Usage exits 2; failures exit 1.`;
const STATE_INDEX = new Map([
  ["eth_call", 1], ["eth_getBalance", 1], ["eth_getStorageAt", 2], ["eth_getCode", 1],
]);
const EVM_METHODS = new Set([...STATE_INDEX.keys(), "eth_getLogs", "eth_getBlockByNumber", "eth_getBlockByHash"]);

class EvidenceError extends Error {
  constructor(reason, message, details) {
    super(message);
    this.reason = reason;
    this.details = details;
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

async function apiKey() {
  if (process.env.DWELLIR_API_KEY?.trim()) return process.env.DWELLIR_API_KEY.trim();
  let contents;
  try {
    contents = await readFile(new URL("../../.env.local", import.meta.url), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw new EvidenceError("credentials-unreadable", "Cannot read repo-root .env.local");
  }
  const key = contents === undefined ? undefined : parseEnv(contents).DWELLIR_API_KEY?.trim();
  if (!key) throw new EvidenceError("missing-api-key", "Set DWELLIR_API_KEY in the environment or repo-root .env.local; see .env.example for the canonical variable name");
  return key;
}

function transport(endpoint, key) {
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
        headers: { "X-Api-Key": key, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      text = await response.text();
    } catch {
      throw new EvidenceError("transport-error", "Dwellir request or response body failed");
    }
    if (!response.ok) throw new EvidenceError("http-error", `Dwellir returned HTTP ${response.status}`, { httpStatus: response.status });
    try {
      return JSON.parse(text);
    } catch {
      throw new EvidenceError("invalid-json", "Dwellir returned invalid JSON");
    }
  }
  function unwrap(payload, expectedId) {
    if (!payload || payload.id !== expectedId || payload.jsonrpc !== "2.0") {
      throw new EvidenceError("invalid-rpc-response", "RPC response identity does not match the request");
    }
    if (payload.error) {
      const rpcMessage = typeof payload.error.message === "string" ? payload.error.message : null;
      throw new EvidenceError("rpc-error", rpcMessage ?? "Dwellir returned a JSON-RPC error", {
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
    assertCliUsage(params.length === index || params.length === index + 1, `${method} has an invalid parameter count`);
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

async function evmRead(transport, method, params, requested, record) {
  const block = await readEvmHeader(transport.rpc, requested);
  record.block = block;
  if (method === "batch") {
    assertCliUsage(Array.isArray(params) && params.length > 0 && params.length <= 100, "batch requires 1–100 {method,params} entries");
    const calls = params.map((item) => {
      assertCliUsage(item && typeof item === "object" && item.method !== "eth_getLogs", "Batch log reads must use standalone eth_getLogs for chunk provenance");
      return normalizeEvm(item.method, item.params, block);
    });
    record.params = calls.map(({ method: callMethod, params: callParams }) => ({ method: callMethod, params: callParams }));
    const result = [];
    for (let index = 0; index < calls.length; index += 10) {
      result.push(...await transport.batch(calls.slice(index, index + 10)));
    }
    sameHeader(block, await readEvmHeader(transport.rpc, { number: BigInt(block.number) }));
    return result.map((value, index) => ({
      method: calls[index].method,
      params: calls[index].params,
      result: value,
      state: empty(value) ? "empty" : "ok",
      reason: empty(value) ? "empty-result-not-proof-of-absence" : null,
    }));
  }
  const call = normalizeEvm(method, params, block);
  record.params = call.params;
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
    for (let start = from; start <= to; start += 500n) {
      const end = start + 499n < to ? start + 499n : to;
      await readChunk(start, end);
    }
    sameHeader(record.rangeStartBlock, await readEvmHeader(transport.rpc, { number: from }));
  } else {
    result = await transport.rpc(method, call.params);
    if (method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") {
      sameHeader(block, evmHeader(result, { number: BigInt(block.number) }));
    }
  }
  sameHeader(block, await readEvmHeader(transport.rpc, { number: BigInt(block.number) }));
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

function empty(result) {
  return result === null || result === "0x" || (Array.isArray(result) && (result.length === 0
    || result.every((item) => item?.state === "empty")));
}

export async function main(argv = process.argv.slice(2)) {
  let values = {};
  let key;
  const record = { chain: null, endpoint: null, method: null, params: null, requestedBlock: null, block: null, result: null, state: "error", reason: null, observedAt: null };
  try {
    ({ values } = parseStrictCliArgs(argv, {
      options: { chain: { type: "string" }, method: { type: "string" }, params: { type: "string" }, block: { type: "string" }, out: { type: "string" } },
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
    const { DWELLIR_CHAINS, dwellirRpcUrl, DWELLIR_HOST_SUFFIX } = await import("../../shared/lib/dwellir-chains.ts");
    const { DWELLIR_NATIVE_ENDPOINTS } = await import("../../shared/lib/dwellir-native-endpoints.ts");
    const evm = DWELLIR_CHAINS.find((entry) => entry.chainId === record.chain);
    const native = DWELLIR_NATIVE_ENDPOINTS.find((entry) => entry.network === record.chain);
    assertCliUsage(evm || native, "Chain has no registered supplemental Dwellir endpoint");
    record.endpoint = evm ? dwellirRpcUrl(evm) : native.baseUrl;
    const url = new URL(record.endpoint);
    if (url.protocol !== "https:" || !url.hostname.endsWith(DWELLIR_HOST_SUFFIX)
      || url.username || url.password || url.search || url.hash) {
      throw new EvidenceError("unsafe-endpoint", "Registry endpoint must be a keyless Dwellir HTTPS URL");
    }
    if (native?.protocol === "tron-http") {
      assertCliUsage(record.method === "triggerconstantcontract" || record.method === "/wallet/triggerconstantcontract", "Only triggerconstantcontract is recognized for TRON");
      throw new EvidenceError("unsupported-pinned-state", "TRON triggerconstantcontract executes current state, not a historical pin; no evidence read was sent");
    }
    key = await apiKey();
    const client = transport(record.endpoint, key);
    const result = evm
      ? await evmRead(client, record.method, record.params, requested, record)
      : native.protocol === "aptos-rest"
        ? await moveRead(client, record.endpoint, record.method, record.params, requested, record)
        : await starknetRead(client, record.method, record.params, requested, record);
    record.result = result;
    record.state = empty(result) ? "empty" : "ok";
    record.reason = record.state === "empty" ? "empty-result-not-proof-of-absence" : null;
  } catch (error) {
    record.result = null;
    record.state = "error";
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

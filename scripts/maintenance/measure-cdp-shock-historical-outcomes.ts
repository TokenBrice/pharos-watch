import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

const BLAST_RPC = "https://eth-mainnet.public.blastapi.io";
const BLOCKSCOUT_RPC = "https://eth.blockscout.com/api/eth-rpc";
const OUTPUT_PATH = "agents/safety-score-v9/results/shock-coverage-2026-07-17/historical-ground-truth.json";

const CONTRACTS = {
  troveManager: "0xa39739ef8b0231dbfa0dcda07d7e29faabcf4bb2",
  stabilityPool: "0x66017d22b0f8556afdd19fc67041899eb65a21bb",
  defaultPool: "0x896a3f03176f05cfbb4f006bfcd8723f2b0d741c",
  priceFeed: "0x4c517d4e2c851ca76d7ec94b805269df0f2201de",
} as const;

const ABI = {
  fetchPrice: {
    signature: "fetchPrice()",
    selector: "0x0fdb11cf",
  },
  liquidation: {
    signature: "Liquidation(uint256,uint256,uint256,uint256)",
    topic: "0x4152c73dd2614c4f9fc35e8c9cf16013cd588c75b49a4c1673ecffdcbcda9403",
  },
  defaultPoolDebt: {
    signature: "DefaultPoolLUSDDebtUpdated(uint256)",
    topic: "0x7735d8b9c0814a13884384c73ec31633f708b4b920b2158764c6b30654134125",
  },
  stabilityPoolBalance: {
    signature: "StabilityPoolLUSDBalanceUpdated(uint256)",
    topic: "0xa8e886449d8f7e765877b4a4f54632da3943ae454d5a272bdccb1781f086ff29",
  },
} as const;

const ANCHORS = {
  may: {
    preBlock: 12_464_949,
    preBlockHash: "0xce057a164a6fbde19bf43f459d41d2ff977ee4b3e10ecf67b77d8a1bf3da138b",
    transactionHash: "0xde034e82c2a957f3a19634bd074a6d760eb764435fd92d6599645c44672c5ebb",
    eventBlock: 12_464_950,
    eventBlockHash: "0xc901c82d2b76087d0072ae72f9a4407553f1a7a8632e876af8d897a5df702207",
    expectedLiquidatedDebtRaw: 858_636_160_262_747_062_160_999n,
  },
  january: {
    preBlock: 14_039_102,
    preBlockHash: "0x365a975bba2fced2f86c659962b441f9ee9a815385d4cb372f0b2d2ea538d29b",
    fromBlock: 14_039_103,
    toBlock: 14_071_445,
    endBlockHash: "0xf1824fd318692cb67e635abbf4411e2fc71298a736253e497c0340879f333fdf",
    expectedLiquidationCount: 31,
    expectedLiquidatedDebtRaw: 25_422_930_967_118_659_278_149_054n,
    expectedPrePriceRaw: 3_089_980_000_000_000_000_000n,
    expectedMinimumPriceRaw: 2_174_766_785_180_000_000_000n,
    expectedMinimumPriceBlock: 14_068_774,
  },
  june: {
    preBlock: 14_986_729,
    preBlockHash: "0x3583253f98a405a17b8b8546feb87766b3eb62e6fe98ad778883a2bacf8ea390",
    transactionHash: "0x078a6b3b82b9e66d1bb07f289675180e7093342b7c35266eac59d24a212c2ca2",
    eventBlock: 14_986_730,
    eventBlockHash: "0x15c0806a4cda80c03c54d3d24269428dbb9ca09d7b06bffed5df7bb7b4d05c9d",
    expectedLiquidatedDebtRaw: 60_755_688_687_028_357_533_664_764n,
  },
} as const;

const USAGE = `Usage: npx tsx scripts/maintenance/measure-cdp-shock-historical-outcomes.ts [options]

Captures fixed Liquity V1 stress-event outcomes from archive RPCs and writes a
deterministic ground-truth artifact for the shock-coverage validation packet.

Options:
  --check    Compare a fresh capture with the saved artifact without writing
  -h, --help Show this help`;

interface JsonRpcEnvelope {
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

interface RawBlock {
  number?: unknown;
  hash?: unknown;
  timestamp?: unknown;
}

interface RawLog {
  address?: unknown;
  topics?: unknown;
  data?: unknown;
  blockNumber?: unknown;
  blockHash?: unknown;
  transactionHash?: unknown;
  transactionIndex?: unknown;
  logIndex?: unknown;
  removed?: unknown;
}

interface RawReceipt {
  transactionHash?: unknown;
  blockNumber?: unknown;
  blockHash?: unknown;
  transactionIndex?: unknown;
  status?: unknown;
  logs?: unknown;
}

interface BlockEvidence {
  number: number;
  hash: string;
  timestampUnix: number;
  timestampIso: string;
}

interface NormalizedLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  removed: false;
}

interface DecodedLiquidationLog extends NormalizedLog {
  decoded: {
    liquidatedDebtRaw: string;
    liquidatedCollateralRaw: string;
    collateralGasCompensationRaw: string;
    lusdGasCompensationRaw: string;
  };
}

interface DecodedUintLog extends NormalizedLog {
  decoded: {
    valueRaw: string;
  };
}

interface PriceEvidence {
  call: {
    endpoint: typeof BLAST_RPC;
    method: "eth_call";
    to: typeof CONTRACTS.priceFeed;
    signature: typeof ABI.fetchPrice.signature;
    callData: typeof ABI.fetchPrice.selector;
    blockHashSelector: { blockHash: string; requireCanonical: true };
    returnData: string;
  };
  priceRaw: string;
}

interface ReceiptEvidence {
  query: {
    endpoint: typeof BLOCKSCOUT_RPC;
    method: "eth_getTransactionReceipt";
    transactionHash: string;
  };
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  transactionIndex: number;
  status: "success";
  liquidationLogs: DecodedLiquidationLog[];
  defaultPoolDebtUpdates: DecodedUintLog[];
  stabilityPoolBalanceUpdates: DecodedUintLog[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isLowerHex(value: string): boolean {
  for (const character of value) {
    if (!(character >= "0" && character <= "9") && !(character >= "a" && character <= "f")) return false;
  }
  return true;
}

function normalizeFixedHex(value: unknown, bytes: number, label: string): string {
  assert(typeof value === "string", `${label}: expected hex string`);
  const normalized = value.toLowerCase();
  const body = normalized.startsWith("0x") ? normalized.slice(2) : "";
  assert(body.length === bytes * 2 && isLowerHex(body), `${label}: malformed ${bytes}-byte hex`);
  return normalized;
}

function normalizeHexBytes(value: unknown, label: string): string {
  assert(typeof value === "string", `${label}: expected hex bytes`);
  const normalized = value.toLowerCase();
  const body = normalized.startsWith("0x") ? normalized.slice(2) : "";
  assert(body.length % 2 === 0 && isLowerHex(body), `${label}: malformed hex bytes`);
  return normalized;
}

function parseHexInteger(value: unknown, label: string): number {
  assert(typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value), `${label}: malformed hex integer`);
  const parsed = Number(BigInt(value));
  assert(Number.isSafeInteger(parsed) && parsed >= 0, `${label}: integer is outside the safe range`);
  return parsed;
}

function decodeWords(data: string, count: number, label: string): bigint[] {
  const normalized = normalizeHexBytes(data, label);
  const body = normalized.slice(2);
  assert(body.length === count * 64, `${label}: expected ${count} ABI words, received ${body.length / 64}`);
  return Array.from({ length: count }, (_, index) => BigInt(`0x${body.slice(index * 64, (index + 1) * 64)}`));
}

function formatRatio(numerator: bigint, denominator: bigint, decimalPlaces: number): string {
  assert(numerator >= 0n && denominator > 0n, "Cannot format an invalid ratio");
  const scale = 10n ** BigInt(decimalPlaces);
  const scaled = (numerator * scale) / denominator;
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(decimalPlaces, "0");
  return decimalPlaces === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function priceFall(startPrice: bigint, endPrice: bigint) {
  const decrease = startPrice > endPrice ? startPrice - endPrice : 0n;
  return {
    decreaseRaw: decrease.toString(),
    denominatorRaw: startPrice.toString(),
    fractionFloor18: formatRatio(decrease, startPrice, 18),
    percentFloor10: formatRatio(decrease * 100n, startPrice, 10),
  };
}

function shouldRetry(message: string): boolean {
  return /(429|rate|capacity|compute units|temporar|timeout|HTTP 5\d\d|network|fetch failed)/i.test(message);
}

async function rpcRequest(rpcUrl: string, method: string, params: readonly unknown[]): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    try {
      if (attempt > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, 400 * 2 ** (attempt - 1)));
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
      const payload = (await response.json()) as JsonRpcEnvelope;
      if (payload.error) {
        const detail =
          typeof payload.error.message === "string" ? payload.error.message : JSON.stringify(payload.error);
        throw new Error(`${method} failed: ${detail}`);
      }
      assert(payload.result !== undefined, `${method} returned no result`);
      return payload.result;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!shouldRetry(message)) throw error;
    }
  }
  throw new Error(
    `${method} failed after bounded retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function fetchBlock(blockNumber: number): Promise<BlockEvidence> {
  const raw = (await rpcRequest(BLAST_RPC, "eth_getBlockByNumber", [
    `0x${blockNumber.toString(16)}`,
    false,
  ])) as RawBlock;
  assert(raw && typeof raw === "object", `block ${blockNumber}: malformed response`);
  const number = parseHexInteger(raw.number, `block ${blockNumber} number`);
  assert(number === blockNumber, `block ${blockNumber}: provider returned block ${number}`);
  const timestampUnix = parseHexInteger(raw.timestamp, `block ${blockNumber} timestamp`);
  return {
    number,
    hash: normalizeFixedHex(raw.hash, 32, `block ${blockNumber} hash`),
    timestampUnix,
    timestampIso: new Date(timestampUnix * 1000).toISOString(),
  };
}

async function fetchPrice(block: BlockEvidence): Promise<PriceEvidence> {
  const blockHashSelector = { blockHash: block.hash, requireCanonical: true } as const;
  const returnData = normalizeHexBytes(
    await rpcRequest(BLAST_RPC, "eth_call", [
      { to: CONTRACTS.priceFeed, data: ABI.fetchPrice.selector },
      blockHashSelector,
    ]),
    `fetchPrice at block ${block.number}`,
  );
  const [price] = decodeWords(returnData, 1, `fetchPrice at block ${block.number}`);
  assert(price !== undefined && price > 0n, `fetchPrice at block ${block.number}: non-positive price`);
  return {
    call: {
      endpoint: BLAST_RPC,
      method: "eth_call",
      to: CONTRACTS.priceFeed,
      signature: ABI.fetchPrice.signature,
      callData: ABI.fetchPrice.selector,
      blockHashSelector,
      returnData,
    },
    priceRaw: price.toString(),
  };
}

function normalizeLog(value: unknown, label: string): NormalizedLog {
  assert(value && typeof value === "object", `${label}: expected log object`);
  const raw = value as RawLog;
  assert(Array.isArray(raw.topics), `${label}: topics must be an array`);
  assert(raw.removed === false, `${label}: removed or missing removed flag`);
  return {
    address: normalizeFixedHex(raw.address, 20, `${label} address`),
    topics: raw.topics.map((topic, index) => normalizeFixedHex(topic, 32, `${label} topic ${index}`)),
    data: normalizeHexBytes(raw.data, `${label} data`),
    blockNumber: parseHexInteger(raw.blockNumber, `${label} blockNumber`),
    blockHash: normalizeFixedHex(raw.blockHash, 32, `${label} blockHash`),
    transactionHash: normalizeFixedHex(raw.transactionHash, 32, `${label} transactionHash`),
    transactionIndex: parseHexInteger(raw.transactionIndex, `${label} transactionIndex`),
    logIndex: parseHexInteger(raw.logIndex, `${label} logIndex`),
    removed: false,
  };
}

function compareLogs(left: NormalizedLog, right: NormalizedLog): number {
  return (
    left.blockNumber - right.blockNumber ||
    left.transactionIndex - right.transactionIndex ||
    left.logIndex - right.logIndex
  );
}

function decodeLiquidationLog(log: NormalizedLog, label: string): DecodedLiquidationLog {
  assert(log.address === CONTRACTS.troveManager, `${label}: unexpected emitter ${log.address}`);
  assert(log.topics.length === 1 && log.topics[0] === ABI.liquidation.topic, `${label}: unexpected topics`);
  const [debt, collateral, collateralGas, lusdGas] = decodeWords(log.data, 4, label);
  assert(
    debt !== undefined && collateral !== undefined && collateralGas !== undefined && lusdGas !== undefined,
    `${label}: incomplete decode`,
  );
  return {
    ...log,
    decoded: {
      liquidatedDebtRaw: debt.toString(),
      liquidatedCollateralRaw: collateral.toString(),
      collateralGasCompensationRaw: collateralGas.toString(),
      lusdGasCompensationRaw: lusdGas.toString(),
    },
  };
}

function decodeUintLog(
  log: NormalizedLog,
  expectedAddress: string,
  expectedTopic: string,
  label: string,
): DecodedUintLog {
  assert(log.address === expectedAddress, `${label}: unexpected emitter ${log.address}`);
  assert(log.topics.length === 1 && log.topics[0] === expectedTopic, `${label}: unexpected topics`);
  const [value] = decodeWords(log.data, 1, label);
  assert(value !== undefined, `${label}: incomplete decode`);
  return { ...log, decoded: { valueRaw: value.toString() } };
}

async function queryLiquidationLogs(fromBlock: number, toBlock: number): Promise<DecodedLiquidationLog[]> {
  const raw = await rpcRequest(BLOCKSCOUT_RPC, "eth_getLogs", [
    {
      address: CONTRACTS.troveManager,
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      topics: [ABI.liquidation.topic],
    },
  ]);
  assert(Array.isArray(raw), "liquidation range query returned a non-array result");
  return raw
    .map((entry, index) =>
      decodeLiquidationLog(normalizeLog(entry, `range liquidation log ${index}`), `range liquidation log ${index}`),
    )
    .sort(compareLogs);
}

async function fetchReceipt(transactionHash: string): Promise<ReceiptEvidence> {
  const raw = (await rpcRequest(BLOCKSCOUT_RPC, "eth_getTransactionReceipt", [transactionHash])) as RawReceipt;
  assert(raw && typeof raw === "object", `receipt ${transactionHash}: malformed response`);
  const normalizedTransactionHash = normalizeFixedHex(raw.transactionHash, 32, `receipt ${transactionHash} hash`);
  assert(
    normalizedTransactionHash === transactionHash,
    `receipt ${transactionHash}: provider returned a different hash`,
  );
  assert(raw.status === "0x1", `receipt ${transactionHash}: transaction did not succeed`);
  assert(Array.isArray(raw.logs), `receipt ${transactionHash}: logs must be an array`);

  const logs = raw.logs.map((entry, index) => normalizeLog(entry, `receipt ${transactionHash} log ${index}`));
  const liquidationLogs = logs
    .filter((log) => log.address === CONTRACTS.troveManager && log.topics[0] === ABI.liquidation.topic)
    .map((log, index) => decodeLiquidationLog(log, `receipt ${transactionHash} liquidation ${index}`));
  const defaultPoolDebtUpdates = logs
    .filter((log) => log.address === CONTRACTS.defaultPool && log.topics[0] === ABI.defaultPoolDebt.topic)
    .map((log, index) =>
      decodeUintLog(
        log,
        CONTRACTS.defaultPool,
        ABI.defaultPoolDebt.topic,
        `receipt ${transactionHash} DefaultPool update ${index}`,
      ),
    );
  const stabilityPoolBalanceUpdates = logs
    .filter((log) => log.address === CONTRACTS.stabilityPool && log.topics[0] === ABI.stabilityPoolBalance.topic)
    .map((log, index) =>
      decodeUintLog(
        log,
        CONTRACTS.stabilityPool,
        ABI.stabilityPoolBalance.topic,
        `receipt ${transactionHash} StabilityPool update ${index}`,
      ),
    );

  assert(liquidationLogs.length > 0, `receipt ${transactionHash}: missing Liquidation event`);
  assert(defaultPoolDebtUpdates.length > 0, `receipt ${transactionHash}: missing DefaultPool debt update`);
  assert(stabilityPoolBalanceUpdates.length > 0, `receipt ${transactionHash}: missing StabilityPool balance update`);
  assert(
    defaultPoolDebtUpdates.every((entry) => entry.decoded.valueRaw === "0"),
    `receipt ${transactionHash}: nonzero DefaultPool debt update invalidates the expected uncovered-debt result`,
  );

  return {
    query: {
      endpoint: BLOCKSCOUT_RPC,
      method: "eth_getTransactionReceipt",
      transactionHash,
    },
    transactionHash,
    blockNumber: parseHexInteger(raw.blockNumber, `receipt ${transactionHash} blockNumber`),
    blockHash: normalizeFixedHex(raw.blockHash, 32, `receipt ${transactionHash} blockHash`),
    transactionIndex: parseHexInteger(raw.transactionIndex, `receipt ${transactionHash} transactionIndex`),
    status: "success",
    liquidationLogs,
    defaultPoolDebtUpdates,
    stabilityPoolBalanceUpdates,
  };
}

function totalLiquidatedDebt(receipts: readonly ReceiptEvidence[]): bigint {
  return receipts.reduce(
    (receiptTotal, receipt) =>
      receiptTotal +
      receipt.liquidationLogs.reduce((logTotal, log) => logTotal + BigInt(log.decoded.liquidatedDebtRaw), 0n),
    0n,
  );
}

function assertBlock(block: BlockEvidence, expectedHash: string, label: string): void {
  assert(block.hash === expectedHash, `${label}: expected ${expectedHash}, received ${block.hash}`);
}

function assertRangeLogsMatchReceipts(
  rangeLogs: readonly DecodedLiquidationLog[],
  receipts: readonly ReceiptEvidence[],
): void {
  const receiptLogs = receipts.flatMap((receipt) => receipt.liquidationLogs).sort(compareLogs);
  assert(
    rangeLogs.length === receiptLogs.length,
    `range/receipt Liquidation count mismatch: ${rangeLogs.length}/${receiptLogs.length}`,
  );
  assert(JSON.stringify(rangeLogs) === JSON.stringify(receiptLogs), "range Liquidation logs differ from receipt logs");
}

async function captureExactTransactionEvent(config: typeof ANCHORS.may | typeof ANCHORS.june) {
  const [preBlock, eventBlock, receipt] = await Promise.all([
    fetchBlock(config.preBlock),
    fetchBlock(config.eventBlock),
    fetchReceipt(config.transactionHash),
  ]);
  assertBlock(preBlock, config.preBlockHash, `pre-event block ${config.preBlock}`);
  assertBlock(eventBlock, config.eventBlockHash, `event block ${config.eventBlock}`);
  assert(receipt.blockNumber === eventBlock.number, `${config.transactionHash}: receipt block number mismatch`);
  assert(receipt.blockHash === eventBlock.hash, `${config.transactionHash}: receipt block hash mismatch`);

  const [prePrice, eventPrice] = await Promise.all([fetchPrice(preBlock), fetchPrice(eventBlock)]);
  const debt = totalLiquidatedDebt([receipt]);
  assert(
    debt === config.expectedLiquidatedDebtRaw,
    `${config.transactionHash}: expected liquidated debt ${config.expectedLiquidatedDebtRaw}, received ${debt}`,
  );
  return {
    preEventBlock: preBlock,
    eventBlock,
    preEventPrice: prePrice,
    eventPrice,
    priceFallFromPreEvent: priceFall(BigInt(prePrice.priceRaw), BigInt(eventPrice.priceRaw)),
    receipts: [receipt],
    outcome: {
      liquidationCount: receipt.liquidationLogs.length,
      totalLiquidatedDebtRaw: debt.toString(),
      actualUncoveredDebtRaw: "0",
      poolOffsetDebtRaw: debt.toString(),
      uncoveredDebtDerivation:
        "Every relevant DefaultPoolLUSDDebtUpdated value in the successful receipt is zero; all liquidated debt was offset by the Stability Pool.",
    },
  };
}

async function captureJanuaryEvent() {
  const [preBlock, endBlock, rangeLogs] = await Promise.all([
    fetchBlock(ANCHORS.january.preBlock),
    fetchBlock(ANCHORS.january.toBlock),
    queryLiquidationLogs(ANCHORS.january.fromBlock, ANCHORS.january.toBlock),
  ]);
  assertBlock(preBlock, ANCHORS.january.preBlockHash, "January pre-event block");
  assertBlock(endBlock, ANCHORS.january.endBlockHash, "January range end block");
  assert(
    rangeLogs.length === ANCHORS.january.expectedLiquidationCount,
    `January: expected ${ANCHORS.january.expectedLiquidationCount} Liquidation logs, received ${rangeLogs.length}`,
  );

  const transactionHashes = [...new Set(rangeLogs.map((log) => log.transactionHash))];
  const receipts: ReceiptEvidence[] = [];
  for (const transactionHash of transactionHashes) receipts.push(await fetchReceipt(transactionHash));
  receipts.sort(
    (left, right) => left.blockNumber - right.blockNumber || left.transactionIndex - right.transactionIndex,
  );
  assertRangeLogsMatchReceipts(rangeLogs, receipts);

  const uniqueBlockNumbers = [...new Set(rangeLogs.map((log) => log.blockNumber))].sort((left, right) => left - right);
  const blocks: BlockEvidence[] = [];
  for (const blockNumber of uniqueBlockNumbers) blocks.push(await fetchBlock(blockNumber));
  for (const log of rangeLogs) {
    const block = blocks.find((candidate) => candidate.number === log.blockNumber);
    assert(block?.hash === log.blockHash, `January block ${log.blockNumber}: range log hash mismatch`);
  }

  const preEventPrice = await fetchPrice(preBlock);
  assert(
    BigInt(preEventPrice.priceRaw) === ANCHORS.january.expectedPrePriceRaw,
    `January: unexpected pre-event price ${preEventPrice.priceRaw}`,
  );
  const eventBlockPrices: Array<{ block: BlockEvidence; price: PriceEvidence }> = [];
  for (const block of blocks) eventBlockPrices.push({ block, price: await fetchPrice(block) });
  const endPrice = await fetchPrice(endBlock);

  const minimum = eventBlockPrices.reduce((current, candidate) =>
    BigInt(candidate.price.priceRaw) < BigInt(current.price.priceRaw) ? candidate : current,
  );
  assert(
    minimum.block.number === ANCHORS.january.expectedMinimumPriceBlock,
    `January: expected minimum event price block ${ANCHORS.january.expectedMinimumPriceBlock}, received ${minimum.block.number}`,
  );
  assert(
    BigInt(minimum.price.priceRaw) === ANCHORS.january.expectedMinimumPriceRaw,
    `January: unexpected minimum event price ${minimum.price.priceRaw}`,
  );

  const debt = totalLiquidatedDebt(receipts);
  assert(
    debt === ANCHORS.january.expectedLiquidatedDebtRaw,
    `January: expected liquidated debt ${ANCHORS.january.expectedLiquidatedDebtRaw}, received ${debt}`,
  );

  return {
    preEventBlock: preBlock,
    rangeEndBlock: endBlock,
    preEventPrice,
    rangeEndPrice: endPrice,
    liquidationRangeQuery: {
      endpoint: BLOCKSCOUT_RPC,
      method: "eth_getLogs" as const,
      address: CONTRACTS.troveManager,
      fromBlock: ANCHORS.january.fromBlock,
      toBlock: ANCHORS.january.toBlock,
      topics: [ABI.liquidation.topic],
    },
    liquidationLogs: rangeLogs,
    eventBlockPrices,
    minimumEventBlockPrice: minimum,
    priceFallFromPreEventToMinimumEventBlock: priceFall(BigInt(preEventPrice.priceRaw), BigInt(minimum.price.priceRaw)),
    receipts,
    outcome: {
      liquidationCount: rangeLogs.length,
      liquidationTransactionCount: receipts.length,
      totalLiquidatedDebtRaw: debt.toString(),
      actualUncoveredDebtRaw: "0",
      poolOffsetDebtRaw: debt.toString(),
      uncoveredDebtDerivation:
        "Every relevant DefaultPoolLUSDDebtUpdated value in every successful liquidation receipt is zero; all liquidated debt was offset by the Stability Pool.",
    },
  };
}

async function captureArtifact() {
  const [may, january, june] = await Promise.all([
    captureExactTransactionEvent(ANCHORS.may),
    captureJanuaryEvent(),
    captureExactTransactionEvent(ANCHORS.june),
  ]);
  return {
    schemaVersion: "liquity-v1-historical-outcomes-v1",
    determinism:
      "Fixed contracts, blocks, hashes, transactions, queries, normalized ordering, and integer-only derivations; no wall-clock field is emitted.",
    sources: {
      canonicalStateRpc: BLAST_RPC,
      logsAndReceiptsRpc: BLOCKSCOUT_RPC,
      stateCallBlockSelector: "EIP-1898 { blockHash, requireCanonical: true }",
    },
    contracts: CONTRACTS,
    abi: ABI,
    events: {
      may2021: {
        label: "2021-05-19 exact liquidation transaction",
        transactionHash: ANCHORS.may.transactionHash,
        ...may,
      },
      january2022: {
        label: "2022-01-20 through 2022-01-24 liquidation window",
        ...january,
      },
      june2022: {
        label: "2022-06-18 exact liquidation transaction",
        transactionHash: ANCHORS.june.transactionHash,
        ...june,
      },
    },
  };
}

void runCliEntrypoint(
  async () => {
    const { values } = parseStrictCliArgs(process.argv.slice(2), {
      options: { check: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    });
    if (writeCliHelpIfRequested(values, USAGE)) return;

    const artifact = await captureArtifact();
    const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
    const outputPath = resolve(OUTPUT_PATH);
    if (values.check === true) {
      const existing = readFileSync(outputPath, "utf8");
      assert(existing === serialized, `${OUTPUT_PATH} differs from a fresh deterministic capture`);
      console.log(`[shock-history] deterministic check passed: ${OUTPUT_PATH}`);
      return;
    }

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serialized);
    console.log(
      `[shock-history] captured May/January/June outcomes (${artifact.events.january2022.outcome.liquidationCount} January liquidations) -> ${OUTPUT_PATH}`,
    );
  },
  { label: "measure-cdp-shock-historical-outcomes", usage: USAGE },
);

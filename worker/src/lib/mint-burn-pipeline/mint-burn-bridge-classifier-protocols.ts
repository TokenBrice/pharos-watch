/** Receipt-bound bridge proofs. No selector or transaction-wide topic authorizes an exclusion. */
import { decodeAbiParameters, decodeEventLog, encodePacked, keccak256, parseAbiItem, parseAbiParameters, toEventSelector } from "viem/utils";
import type { MintBurnCcipBridgeDetectionConfig, MintBurnCctpBridgeDetectionConfig, MintBurnLayerZeroOftBridgeDetectionConfig } from "./mint-burn-contracts";
import type { MintBurnBridgeClassifiableRow, MintBurnTxContext } from "./mint-burn-bridge-classifier-types";

type Log = NonNullable<MintBurnTxContext["receiptLogs"]>[number];
const ZERO = `0x${"0".repeat(64)}`;
const ADDRESS_WORD = /^0x0{24}[0-9a-f]{40}$/;
const topic = toEventSelector;
// Canonical Circle, Chainlink TokenPool and LayerZero IOFT/EndpointV2 signatures.
export const BRIDGE_TOPICS = {
  transfer: topic("Transfer(address,address,uint256)"),
  mint: topic("Mint(address,address,uint256)"),
  burn: topic("Burn(address,uint256)"),
  messageSent: topic("MessageSent(bytes)"),
  cctpV1Received: topic("MessageReceived(address,uint32,uint64,bytes32,bytes)"),
  cctpV2Received: topic("MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)"),
  cctpV1Mint: topic("MintAndWithdraw(address,uint256,address)"),
  cctpV2Mint: topic("MintAndWithdraw(address,uint256,address,uint256)"),
  ccipBurned: topic("Burned(address,uint256)"),
  ccipMinted: topic("Minted(address,address,uint256)"),
  ccipLocked: topic("LockedOrBurned(uint64,address,address,uint256)"),
  ccipReleased: topic("ReleasedOrMinted(uint64,address,address,address,uint256)"),
  ccipUsdoMinted: topic("Minted(address,uint256,uint256,uint256,uint256)"),
  oftSent: topic("OFTSent(bytes32,uint32,address,uint256,uint256)"),
  oftReceived: topic("OFTReceived(bytes32,uint32,address,uint256)"),
  packetSent: topic("PacketSent(bytes,bytes,address)"),
  packetDelivered: topic("PacketDelivered((uint32,bytes32,uint64),address)"),
};
const CCTP_DEPOSITS = {
  1: parseAbiItem("event DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller)"),
  2: parseAbiItem("event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)"),
};
const CCTP_RECEIVED = {
  1: parseAbiItem("event MessageReceived(address indexed caller, uint32 sourceDomain, uint64 indexed nonce, bytes32 sender, bytes messageBody)"),
  2: parseAbiItem("event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)"),
};
const MESSAGE_SENT_DATA = parseAbiParameters("bytes message");
const PACKET_SENT_DATA = parseAbiParameters("bytes payload, bytes options, address sendLibrary");
const PACKET_DELIVERED_DATA = parseAbiParameters("(uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver");
const address = (word: string | undefined): string | null => word && ADDRESS_WORD.test(word) ? `0x${word.slice(-40)}` : null;
const addressWord = (value: string): `0x${string}` => `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
function words(log: Log): string[] { return log.data.slice(2).match(/.{64}/g)?.map((word) => `0x${word}`) ?? []; }
function isEvent(log: Log, emitter: string, signature: string, topics: number, dataWords?: number): boolean {
  return log.address === emitter && log.topics[0] === signature && log.topics.length === topics
    && (dataWords == null || log.data.length === 2 + dataWords * 64);
}

function receiptLogs(ctx: MintBurnTxContext | null): Log[] | null {
  const logs = ctx?.receiptLogs;
  if (!logs) return null;
  const normalized = logs.map((log) => ({ address: log.address.toLowerCase(), topics: log.topics.map((value) => value.toLowerCase()),
    data: log.data.toLowerCase(), logIndex: log.logIndex }));
  if (normalized.some((log) => !/^0x[0-9a-f]{40}$/.test(log.address)
    || !log.topics.every((value) => /^0x[0-9a-f]{64}$/.test(value))
    || (!/^0x[0-9a-f]*$/.test(log.data) || log.data.length % 2 !== 0) || !/^0x[0-9a-f]+$/i.test(log.logIndex ?? "")
    || !Number.isSafeInteger(Number(log.logIndex)))
    || new Set(normalized.map((log) => Number(log.logIndex))).size !== normalized.length) return null;
  return normalized.sort((a, b) => Number(a.logIndex) - Number(b.logIndex));
}
// An unresolved mint is stored like an unresolved burn (standard flow, burn_type
// 'review_required'): the hourly writer counts it as classification debt, not issuance.
function markContextUnavailable(rows: MintBurnBridgeClassifiableRow[]): void {
  for (const row of rows) {
    row.bridge_review_reason = "tx-context-unavailable";
    row.burn_type = "review_required"; row.burn_review_reason = "tx-context-unavailable";
  }
}

export function setDefaultClassification(row: MintBurnBridgeClassifiableRow): void {
  row.burn_type = row.direction === "burn" ? "effective_burn" : null;
  row.burn_review_reason = null;
  row.bridge_review_reason = null;
  if (row.flow_type === "bridge_transfer") row.flow_type = "standard";
}
function markBridgeTransfer(row: MintBurnBridgeClassifiableRow): void {
  row.flow_type = "bridge_transfer";
  row.burn_type = row.direction === "burn" ? "bridge_burn" : null;
  row.burn_review_reason = null;
  row.bridge_review_reason = null;
}
function groupRowsByTx(rows: MintBurnBridgeClassifiableRow[]): Map<string, MintBurnBridgeClassifiableRow[]> {
  const grouped = new Map<string, MintBurnBridgeClassifiableRow[]>();
  for (const row of rows) { const group = grouped.get(row.tx_hash) ?? []; group.push(row); grouped.set(row.tx_hash, group); }
  return grouped;
}

/** A proof consumes exactly one canonical token Transfer, even below the parser's display cutoff. */
function matchTransfer(logs: Log[], used: Set<Log>, tokenAddress: string, before: Log, from: string, to: string, amount: string): Log | undefined {
  return [...logs].reverse().find((log) => Number(log.logIndex) < Number(before.logIndex) && !used.has(log)
    && isEvent(log, tokenAddress, BRIDGE_TOPICS.transfer, 3, 1)
    && log.topics[1] === from && log.topics[2] === to && log.data === amount);
}
function transferRows(rows: MintBurnBridgeClassifiableRow[], transfer: Log): MintBurnBridgeClassifiableRow[] {
  const direction = transfer.topics[1] === ZERO ? "mint" : "burn";
  const account = address(transfer.topics[direction === "mint" ? 2 : 1]);
  return rows.filter((row) => row.direction === direction && row.counterparty?.toLowerCase() === account
    && row.id.endsWith(`-${row.tx_hash}-${Number(transfer.logIndex)}`));
}
function markTransfer(rows: MintBurnBridgeClassifiableRow[], transfer: Log, used: Set<Log>): void {
  used.add(transfer);
  for (const row of transferRows(rows, transfer)) markBridgeTransfer(row);
}

function classifyCctp(rows: MintBurnBridgeClassifiableRow[], logs: Log[], detection: MintBurnCctpBridgeDetectionConfig, used: Set<Log>): void {
  const tokenAddress = detection.tokenAddress.toLowerCase();
  for (const deployment of detection.deployments) {
    const messenger = deployment.tokenMessenger.toLowerCase(), minter = deployment.tokenMinter.toLowerCase();
    const transmitter = deployment.messageTransmitter.toLowerCase(), version = deployment.version;
    const receives = logs.filter((log) => {
      if (!isEvent(log, transmitter, version === 1 ? BRIDGE_TOPICS.cctpV1Received : BRIDGE_TOPICS.cctpV2Received, version === 1 ? 3 : 4)) return false;
      try {
        decodeEventLog({ abi: [CCTP_RECEIVED[version]], topics: log.topics as [`0x${string}`, ...`0x${string}`[]], data: log.data as `0x${string}` });
        return true;
      } catch { return false; }
    });
    for (const event of logs) {
      if (event.address !== messenger) continue;
      try {
        const { args } = decodeEventLog({ abi: [CCTP_DEPOSITS[version]], topics: event.topics as [`0x${string}`, ...`0x${string}`[]], data: event.data as `0x${string}` });
        if (args.burnToken.toLowerCase() === tokenAddress) {
          const amount = `0x${args.amount.toString(16).padStart(64, "0")}`;
          const burn = matchTransfer(logs, used, tokenAddress, event, addressWord(minter), ZERO, amount);
          const funding = burn && matchTransfer(logs, used, tokenAddress, burn, addressWord(args.depositor), addressWord(minter), amount);
          if (burn && funding && logs.some((log) => isEvent(log, tokenAddress, BRIDGE_TOPICS.burn, 2, 1)
            && log.topics[1] === addressWord(minter) && log.data === amount && Number(log.logIndex) + 1 === Number(burn.logIndex))
            && logs.some((log) => {
              if (!isEvent(log, transmitter, BRIDGE_TOPICS.messageSent, 1)
                || Number(log.logIndex) <= Number(burn.logIndex) || Number(log.logIndex) >= Number(event.logIndex)) return false;
              try { decodeAbiParameters(MESSAGE_SENT_DATA, log.data as `0x${string}`); return true; } catch { return false; }
            })) {
            used.add(funding); markTransfer(rows, burn, used);
          }
        }
      } catch { /* A different event or malformed deposit cannot prove a bridge burn. */ }
      if (!isEvent(event, messenger, version === 1 ? BRIDGE_TOPICS.cctpV1Mint : BRIDGE_TOPICS.cctpV2Mint, 3, version === 1 ? 1 : 2)
        || address(event.topics[2]) !== tokenAddress || !address(event.topics[1])) continue;
      // The next receive from this deployment terminates this mint operation.
      const received = receives.find((log) => Number(log.logIndex) > Number(event.logIndex));
      if (!received) continue;
      const amounts = words(event);
      const previousReceive = [...receives].reverse().find((log) => Number(log.logIndex) < Number(event.logIndex));
      const mintProof = (transfer: Log) => logs.some((log) => isEvent(log, tokenAddress, BRIDGE_TOPICS.mint, 3, 1)
        && log.topics[1] === addressWord(minter) && log.topics[2] === transfer.topics[2] && log.data === transfer.data
        && Number(log.logIndex) + 1 === Number(transfer.logIndex));
      const hasFee = version === 2 && BigInt(amounts[1]) > 0n;
      // Principal then fee are the last minter-authorized pairs in this operation,
      // even when the two recipients and amounts are identical.
      const transfers = logs.filter((log) => !used.has(log) && isEvent(log, tokenAddress, BRIDGE_TOPICS.transfer, 3, 1)
        && log.topics[1] === ZERO && address(log.topics[2]) != null
        && Number(log.logIndex) > Number(previousReceive?.logIndex ?? -1) && Number(log.logIndex) < Number(event.logIndex))
        .slice(hasFee ? -2 : -1);
      const principal = transfers[0], fee = transfers[1];
      if (!principal || !mintProof(principal) || principal.topics[2] !== event.topics[1] || principal.data !== amounts[0]
        || (hasFee && !fee)) continue;
      markTransfer(rows, principal, used);
      if (fee && fee.data === amounts[1] && mintProof(fee)) markTransfer(rows, fee, used);
    }
  }
}

function classifyCcip(rows: MintBurnBridgeClassifiableRow[], logs: Log[], detection: MintBurnCcipBridgeDetectionConfig, used: Set<Log>): void {
  const tokenAddress = detection.tokenAddress.toLowerCase();
  for (const event of logs) {
    if (!detection.knownBridgePoolAddresses.some((pool) => pool.toLowerCase() === event.address)) continue;
    const data = words(event), pool = addressWord(event.address);
    let burn = false, account: string | undefined, amount: string | undefined;
    if (isEvent(event, event.address, BRIDGE_TOPICS.ccipBurned, 2, 1) && address(event.topics[1])) {
      burn = true; account = pool; amount = data[0];
    } else if (isEvent(event, event.address, BRIDGE_TOPICS.ccipMinted, 3, 1) && address(event.topics[1]) && address(event.topics[2])) {
      account = event.topics[2]; amount = data[0];
    } else if (isEvent(event, event.address, BRIDGE_TOPICS.ccipLocked, 2, 3) && address(data[0]) === tokenAddress && address(data[1])) {
      burn = true; account = pool; amount = data[2];
    } else if (isEvent(event, event.address, BRIDGE_TOPICS.ccipReleased, 2, 4) && address(data[0]) === tokenAddress && address(data[1]) && address(data[2])) {
      account = data[2]; amount = data[3];
    } else if (detection.poolKind === "usdo" && isEvent(event, event.address, BRIDGE_TOPICS.ccipUsdoMinted, 1, 5)
      && address(data[0]) && BigInt(data[3]) > 0n && BigInt(data[4]) > 0n) {
      // Pool balance-delta destAmount can round one unit below the token mint request.
      const sourceAmount = BigInt(data[1]), sourceMultiplier = BigInt(data[3]), destinationMultiplier = BigInt(data[4]);
      if (sourceMultiplier !== destinationMultiplier && sourceAmount * destinationMultiplier >= 2n ** 256n) continue;
      account = data[0]; amount = `0x${(sourceMultiplier === destinationMultiplier ? sourceAmount
        : sourceAmount * destinationMultiplier / sourceMultiplier).toString(16).padStart(64, "0")}`;
    }
    if (!account || !amount) continue;
    const holder = detection.externalMinterAddress ? addressWord(detection.externalMinterAddress) : account;
    const transfer = matchTransfer(logs, used, tokenAddress, event, burn ? holder : ZERO, burn ? ZERO : holder, amount);
    if (!transfer) continue;
    if (detection.externalMinterAddress) {
      const routeTransfer = burn
        ? matchTransfer(logs, used, tokenAddress, transfer, pool, holder, amount)
        : matchTransfer(logs, used, tokenAddress, event, holder, account, amount);
      if (!routeTransfer || (!burn && Number(routeTransfer.logIndex) <= Number(transfer.logIndex))) continue;
      used.add(routeTransfer);
    }
    markTransfer(rows, transfer, used);
  }
}

export function classifyLayerZeroOft(rows: MintBurnBridgeClassifiableRow[], detection: MintBurnLayerZeroOftBridgeDetectionConfig, contexts: Map<string, MintBurnTxContext | null>): void {
  const tokenAddress = detection.tokenAddress.toLowerCase(), endpoint = detection.endpointAddress.toLowerCase();
  for (const [hash, txRows] of groupRowsByTx(rows)) {
    const logs = receiptLogs(contexts.get(hash) ?? null), used = new Set<Log>();
    if (!logs) { markContextUnavailable(txRows); continue; }
    for (const event of logs) {
      if (!detection.knownBridgeContractAddresses.some((entry) => entry.toLowerCase() === event.address) || !address(event.topics[2])) continue;
      const send = isEvent(event, event.address, BRIDGE_TOPICS.oftSent, 3, 3);
      if (!send && !isEvent(event, event.address, BRIDGE_TOPICS.oftReceived, 3, 2)) continue;
      const data = words(event);
      const packet = logs.some((log) => {
        try {
          if (send && isEvent(log, endpoint, BRIDGE_TOPICS.packetSent, 1)) {
            const [payload] = decodeAbiParameters(PACKET_SENT_DATA, log.data as `0x${string}`);
            return payload.slice(0, 4) === "0x01" && payload.length >= 228
              && payload.slice(20, 28) === detection.endpointId.toString(16).padStart(8, "0")
              && payload.slice(28, 92) === addressWord(detection.oappAddress).slice(2)
              && payload.slice(92, 100) === BigInt(data[0]).toString(16).padStart(8, "0")
              && `0x${payload.slice(164, 228)}` === event.topics[1]
              && keccak256(`0x${payload.slice(4, 164)}`) === event.topics[1]
              && Number(log.logIndex) < Number(event.logIndex);
          }
          if (!send && isEvent(log, endpoint, BRIDGE_TOPICS.packetDelivered, 1, 4)) {
            const [origin, receiver] = decodeAbiParameters(PACKET_DELIVERED_DATA, log.data as `0x${string}`);
            return receiver.toLowerCase() === detection.oappAddress.toLowerCase() && BigInt(origin.srcEid) === BigInt(data[0])
              && keccak256(encodePacked(["uint64", "uint32", "bytes32", "uint32", "bytes32"],
                [origin.nonce, origin.srcEid, origin.sender, detection.endpointId, addressWord(receiver)])) === event.topics[1]
              && Number(log.logIndex) > Number(event.logIndex);
          }
        } catch { /* Malformed endpoint evidence is not a route proof. */ }
        return false;
      });
      // OFT amounts are local-decimal integers; source debit can differ from remote credit (fees/dust).
      const recipient = !send && event.topics[2] === ZERO && detection.zeroRecipientAddress
        ? addressWord(detection.zeroRecipientAddress) : event.topics[2];
      const transfer = matchTransfer(logs, used, tokenAddress, event, send ? event.topics[2] : ZERO, send ? ZERO : recipient, data[1]);
      if (!transfer) continue;
      if (packet) markTransfer(txRows, transfer, used);
      else for (const row of transferRows(txRows, transfer)) {
        row.bridge_review_reason = "known-bridge-pool-without-bridge-signal";
        row.burn_type = "review_required"; row.burn_review_reason = row.bridge_review_reason;
      }
    }
    markUnresolved(txRows, logs, contexts.get(hash) ?? null, detection.knownBridgeContractAddresses, tokenAddress);
  }
}

function markUnresolved(rows: MintBurnBridgeClassifiableRow[], logs: Log[], ctx: MintBurnTxContext | null, pools: string[], tokenAddress: string): void {
  const known = new Set(pools.map((pool) => pool.toLowerCase()));
  for (const row of rows) {
    if (row.flow_type !== "standard") continue;
    const knownMinter = row.direction === "mint" && logs.some((log) => isEvent(log, tokenAddress, BRIDGE_TOPICS.mint, 3, 1)
      && known.has(address(log.topics[1]) ?? "") && address(log.topics[2]) === row.counterparty?.toLowerCase()
      && logs.some((transfer) => isEvent(transfer, tokenAddress, BRIDGE_TOPICS.transfer, 3, 1) && transfer.topics[1] === ZERO
        && transfer.topics[2] === log.topics[2] && transfer.data === log.data && Number(transfer.logIndex) === Number(log.logIndex) + 1
        && row.id.endsWith(`-${row.tx_hash}-${Number(transfer.logIndex)}`)));
    if (!known.has(row.counterparty?.toLowerCase() ?? "") && !knownMinter) continue;
    const reason = !ctx || !ctx.receiptLogs ? "tx-context-unavailable" : "known-bridge-pool-without-bridge-signal";
    row.bridge_review_reason = reason;
    row.burn_type = "review_required"; row.burn_review_reason = reason;
  }
}

export function classifyPoolBridge(rows: MintBurnBridgeClassifiableRow[], detection: MintBurnCcipBridgeDetectionConfig | MintBurnCctpBridgeDetectionConfig, contexts: Map<string, MintBurnTxContext | null>): void {
  for (const [hash, txRows] of groupRowsByTx(rows)) {
    const ctx = contexts.get(hash) ?? null, logs = receiptLogs(ctx), used = new Set<Log>();
    if (!logs) { markContextUnavailable(txRows); continue; }
    if (detection.protocol === "cctp") classifyCctp(txRows, logs, detection, used);
    else classifyCcip(txRows, logs, detection, used);
    markUnresolved(txRows, logs, ctx, [...detection.knownBridgePoolAddresses,
      ...(detection.protocol === "ccip" && detection.externalMinterAddress ? [detection.externalMinterAddress] : [])], detection.tokenAddress.toLowerCase());
  }
}

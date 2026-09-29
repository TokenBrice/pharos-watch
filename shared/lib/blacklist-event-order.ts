type OrderedEvent = {
  id: string;
  timestamp: number;
  blockNumber?: number;
  block_number?: number;
  chainId?: string;
  chain_id?: string;
  txHash?: string;
  tx_hash?: string;
  transactionIndex?: number | null;
  transaction_index?: number | null;
};

function position(event: OrderedEvent): [number, number] {
  const chain = event.chainId ?? event.chain_id ?? "";
  const tx = event.txHash ?? event.tx_hash ?? "";
  const prefix = `${chain}-${tx}-`;
  if (!tx || !event.id.startsWith(prefix)) return [0, 0];
  const [index, suffix = "0"] = event.id.slice(prefix.length).split("-");
  return [Number(index) || 0, Number(suffix) || 0];
}

/** Tron log indices are transaction-local. Only observed block transaction
 * positions may break a cross-transaction tie between two Tron events with
 * differing hashes; hashes never imply order, and a transaction-local index is
 * never compared across chains. */
export function compareBlacklistEvents(left: OrderedEvent, right: OrderedEvent): number {
  const time = left.timestamp - right.timestamp;
  if (time) return time;
  const block = (left.blockNumber ?? left.block_number ?? 0) - (right.blockNumber ?? right.block_number ?? 0);
  if (block) return block;
  if ((left.chainId ?? left.chain_id) === "tron" && (right.chainId ?? right.chain_id) === "tron"
    && (left.txHash ?? left.tx_hash) !== (right.txHash ?? right.tx_hash)) {
    const a = left.transactionIndex ?? left.transaction_index;
    const b = right.transactionIndex ?? right.transaction_index;
    return a != null && b != null ? a - b : 0;
  }
  const a = position(left);
  const b = position(right);
  return a[0] - b[0] || a[1] - b[1];
}

/** SQLite numeric key for EVM and transaction-local Tron order. SQL callers
 * must retain ALL Tron rows: across transactions this is only presentation
 * order, and the shared fold explicitly quarantines ambiguous state. */
export function blacklistEventOrderSql(direction: "ASC" | "DESC"): string {
  const tail = "substr(id, length(chain_id) + length(tx_hash) + 3)";
  const index = `CASE WHEN instr(${tail}, '-') > 0 THEN substr(${tail}, 1, instr(${tail}, '-') - 1) ELSE ${tail} END`;
  const numeric = `CASE WHEN lower(substr((${index}), 1, 2)) = '0x' THEN substr('0000000000000000' || lower(substr((${index}), 3)), -16) ELSE printf('%016x', CAST((${index}) AS INTEGER)) END`;
  const suffix = `CASE WHEN instr(${tail}, '-') > 0 THEN CAST(substr(${tail}, instr(${tail}, '-') + 1) AS INTEGER) ELSE 0 END`;
  return `timestamp ${direction}, block_number ${direction}, ${numeric} ${direction}, ${suffix} ${direction}`;
}

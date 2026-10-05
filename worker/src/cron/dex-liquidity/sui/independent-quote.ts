import { bytesToBase64 } from "@shared/lib/base64";
import { isRecord } from "@shared/lib/type-guards";
import { suiClmmDirectionalPriceLimit } from "./clmm-quote";
import { SUI_CLMM_DEPLOYMENTS, suiObjectId } from "./identity";
import { suiObject, suiUint, type SuiClmmSnapshot, type SuiRpc } from "./state-reader";

export interface SuiClmmInspectRequest { aToB: boolean; amountIn: bigint }
export interface SuiClmmIndependentQuote {
  amountIn: bigint; amountOut: bigint; feeAmount: bigint; sqrtPriceAfter: bigint;
  exceeded: boolean;
  /** JSON-RPC devInspect selects an epoch, NOT a historical checkpoint. */
  checkpointBound: false;
  stationaryReadSet: true;
}

/** Narrow BCS encoder for read-only pool quote calls. No SDK/dependency graph in the Worker. */
export function buildSuiClmmInspectTransaction(snapshot: SuiClmmSnapshot, requests: readonly SuiClmmInspectRequest[]): string {
  if (requests.length < 1 || requests.length > 10) throw new Error("sui-inspect-request-grid-overflow");
  const bytes: number[] = [];
  const textEncoder = new TextEncoder();
  function uleb(value: number) {
    do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
  }
  function integer(value: bigint, size: number) {
    if (value < 0n || value >= 1n << BigInt(size * 8)) throw new Error("sui-inspect-integer-overflow");
    for (let i = 0; i < size; i++) { bytes.push(Number(value & 255n)); value >>= 8n; }
  }
  function address(value: string) {
    const id = suiObjectId(value);
    if (!id) throw new Error("sui-inspect-invalid-address");
    for (let i = 2; i < id.length; i += 2) bytes.push(Number.parseInt(id.slice(i, i + 2), 16));
  }
  function identifier(value: string) {
    const encoded = textEncoder.encode(value);
    uleb(encoded.length); bytes.push(...encoded);
  }
  function typeTag(value: string) {
    const parts = value.split("::");
    if (parts.length !== 3) throw new Error("sui-inspect-unsupported-coin-type");
    uleb(7); address(parts[0]); identifier(parts[1]); identifier(parts[2]); uleb(0);
  }
  const bluefin = snapshot.pool.family === "bluefin";
  const inputWidth = bluefin ? 4 : 3;
  uleb(0); // TransactionKind::ProgrammableTransaction
  uleb(1 + requests.length * inputWidth);
  uleb(1); uleb(1); // CallArg::Object(ObjectArg::SharedObject)
  address(snapshot.pool.poolId); integer(BigInt(snapshot.pool.initialSharedVersion), 8); bytes.push(0); // immutable
  for (const request of requests) {
    uleb(0); uleb(1); bytes.push(Number(request.aToB));
    uleb(0); uleb(1); bytes.push(1); // exact input
    uleb(0); uleb(8); integer(request.amountIn, 8);
    if (bluefin) { uleb(0); uleb(16); integer(suiClmmDirectionalPriceLimit(snapshot, request.aToB), 16); }
  }
  uleb(requests.length);
  const deployment = SUI_CLMM_DEPLOYMENTS[snapshot.pool.family];
  for (let i = 0; i < requests.length; i++) {
    uleb(0); // Command::MoveCall
    address(deployment.quotePackage); identifier("pool"); identifier(deployment.quoteFunction);
    uleb(2); typeTag(snapshot.pool.coinA); typeTag(snapshot.pool.coinB);
    uleb(1 + inputWidth);
    uleb(1); integer(0n, 2); // Argument::Input(pool)
    for (let j = 0; j < inputWidth; j++) { uleb(1); integer(BigInt(1 + i * inputWidth + j), 2); }
  }
  return bytesToBase64(Uint8Array.from(bytes));
}

export function decodeSuiClmmInspectResults(result: unknown, snapshot: SuiClmmSnapshot, requests: readonly SuiClmmInspectRequest[]): Omit<SuiClmmIndependentQuote, "stationaryReadSet">[] {
  if (!isRecord(result) || result.error != null || !isRecord(result.effects) || !isRecord(result.effects.status) || result.effects.status.status !== "success" || !Array.isArray(result.results) || result.results.length !== requests.length) throw new Error("sui-inspect-execution-failed");
  const expectedPool = snapshot.references.find((object) => object.objectId === snapshot.pool.poolId);
  const sharedPool = Array.isArray(result.effects.sharedObjects)
    ? result.effects.sharedObjects.find((object) => isRecord(object) && object.objectId === snapshot.pool.poolId)
    : null;
  if (!expectedPool || !isRecord(sharedPool) || suiUint(sharedPool.version).toString() !== expectedPool.version || sharedPool.digest !== expectedPool.digest) throw new Error("sui-inspect-state-changed");
  return result.results.map((item, index) => {
    if (!isRecord(item) || !Array.isArray(item.returnValues) || item.returnValues.length !== 1 || !Array.isArray(item.returnValues[0])) throw new Error("sui-inspect-return-missing");
    const [raw, type] = item.returnValues[0];
    const expectedType = `${SUI_CLMM_DEPLOYMENTS[snapshot.pool.family].typePackage}::pool::${snapshot.pool.family === "cetus" ? "CalculatedSwapResult" : "SwapResult"}`;
    if (type !== expectedType || !Array.isArray(raw) || raw.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error("sui-inspect-return-identity-mismatch");
    function unsigned(offset: number, size: number): bigint {
      if (offset + size > raw.length) throw new Error("sui-inspect-truncated-result");
      let value = 0n;
      for (let i = offset + size - 1; i >= offset; i--) value = value << 8n | BigInt(raw[i]);
      return value;
    }
    let amountIn: bigint;
    let amountOut: bigint;
    let feeAmount: bigint;
    let sqrtPriceAfter: bigint;
    let exceeded: boolean;
    if (snapshot.pool.family === "cetus") {
      amountIn = unsigned(0, 8) + unsigned(16, 8);
      amountOut = unsigned(8, 8);
      feeAmount = unsigned(16, 8);
      if (unsigned(24, 8) !== BigInt(snapshot.pool.feePips)) throw new Error("sui-inspect-fee-mismatch");
      sqrtPriceAfter = unsigned(32, 16);
      const tag = unsigned(48, 1);
      if (tag > 1n) throw new Error("sui-inspect-invalid-bool");
      exceeded = tag === 1n;
    } else {
      if (unsigned(0, 1) !== BigInt(Number(requests[index].aToB)) || unsigned(1, 1) !== 1n || unsigned(2, 8) !== requests[index].amountIn || unsigned(58, 16) !== snapshot.pool.sqrtPrice) throw new Error("sui-inspect-request-mismatch");
      amountIn = unsigned(2, 8) - unsigned(10, 8);
      amountOut = unsigned(18, 8);
      feeAmount = unsigned(42, 8) + unsigned(50, 8);
      sqrtPriceAfter = unsigned(74, 16);
      const tag = unsigned(94, 1);
      if (tag > 1n) throw new Error("sui-inspect-invalid-bool");
      exceeded = tag === 1n;
    }
    if (!exceeded && amountIn !== requests[index].amountIn) throw new Error("sui-inspect-partial-input");
    return { amountIn, amountOut, feeAmount, sqrtPriceAfter, exceeded, checkpointBound: false as const };
  });
}

/** State-stationary cross-check only. Never relabel an epoch-only devInspect as
 * same-checkpoint fork equivalence; the latter remains an explicit activation gate. */
export async function inspectSuiClmmQuotes(rpc: SuiRpc, snapshot: SuiClmmSnapshot, requests: readonly SuiClmmInspectRequest[]): Promise<{ raw: unknown; quotes: SuiClmmIndependentQuote[] }> {
  if (requests.length < 1 || requests.length > 10) throw new Error("sui-inspect-request-grid-overflow");
  async function assertUnchanged() {
    for (let i = 0; i < snapshot.references.length; i += 50) {
      const expected = snapshot.references.slice(i, i + 50);
      const batch = await rpc("sui_multiGetObjects", [expected.map((object) => object.objectId), { showPreviousTransaction: true }]);
      if (!Array.isArray(batch) || batch.length !== expected.length) throw new Error("sui-inspect-object-census-incomplete");
      for (let j = 0; j < expected.length; j++) {
        const actual = suiObject(batch[j]);
        if (actual.objectId !== expected[j].objectId || suiUint(actual.version).toString() !== expected[j].version || actual.digest !== expected[j].digest) throw new Error("sui-inspect-state-changed");
      }
    }
  }
  await assertUnchanged();
  const raw: unknown[] = [];
  const decoded: Omit<SuiClmmIndependentQuote, "stationaryReadSet">[] = [];
  // Large Bluefin quotes traverse empty bitmap words. One transaction per
  // request keeps the gas bound per quote rather than exhausting it mid-grid.
  for (const request of requests) {
    const result = await rpc("sui_devInspectTransactionBlock", ["0x0000000000000000000000000000000000000000000000000000000000000000", buildSuiClmmInspectTransaction(snapshot, [request]), null, null, { skipChecks: true }]);
    raw.push(result);
    decoded.push(...decodeSuiClmmInspectResults(result, snapshot, [request]));
  }
  await assertUnchanged();
  const quotes = decoded.map((quote) => ({ ...quote, stationaryReadSet: true as const }));
  return { raw, quotes };
}

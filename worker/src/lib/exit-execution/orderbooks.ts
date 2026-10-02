import { z } from "zod";
import type { ExitExecutionCertificate, ExitExecutionModelReview, ExitExecutionRequestPoint } from "@shared/types/exit-route";
import { decimalToExitUnits, exitNumberToDecimal, exitRawUsd, requestedExitRawInput } from "@shared/lib/safety-score-v9/exit-execution-units";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { sha256Hex } from "@shared/lib/sha256";
import { DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES } from "../fetch-retry";
import { readResponseTextWithinLimitWithSignal } from "../response-body";

// eslint-disable-next-line security/detect-unsafe-regex -- anchored linear unsigned-decimal book levels; groups cannot overlap.
const BookLevelSchema = z.tuple([z.string().regex(/^\d+(?:\.\d+)?$/), z.string().regex(/^\d+(?:\.\d+)?$/), z.number().finite().nonnegative()]);
const KrakenBookSchema = z.object({ asks: z.array(BookLevelSchema), bids: z.array(BookLevelSchema) });

export function walkExitBidBook(args: {
  bids: readonly (readonly [string, string, number])[];
  requestedRawInput: bigint;
  requestedNotionalUsd: number;
  maxCostBps: number;
  inputReference: ExitExecutionCertificate["inputReference"];
  outputReference: ExitExecutionCertificate["inputReference"];
  takerFeeBps: number;
  lotRaw: bigint;
  minimumRaw: bigint;
  minimumOutputRaw: bigint;
  exhaustive: boolean;
}): ExitExecutionRequestPoint {
  if (args.requestedRawInput <= 0n || args.lotRaw <= 0n || args.minimumRaw < 0n || !Number.isFinite(args.takerFeeBps) || args.takerFeeBps < 0 || args.takerFeeBps >= 10_000) throw new Error("invalid-book-request");
  const feePpm = decimalToExitUnits(exitNumberToDecimal(args.takerFeeBps), 2, true);
  let executed = 0n, grossOutput = 0n, accepted = 0n, netOutput = 0n, acceptedGross = 0n;
  let previousPrice: bigint | null = null;
  let executionCostBps = 0, allInCostBps = 0;
  for (const [priceText, amountText] of args.bids) {
    const price = decimalToExitUnits(priceText, 18);
    const amount = decimalToExitUnits(amountText, args.inputReference.decimals);
    if (price <= 0n || amount <= 0n || (previousPrice !== null && price > previousPrice)) throw new Error("invalid-book-level-order");
    previousPrice = price;
    const remaining = args.requestedRawInput - executed;
    const fill = (amount < remaining ? amount : remaining) / args.lotRaw * args.lotRaw;
    if (fill === 0n) continue;
    const output = fill * price * 10n ** BigInt(args.outputReference.decimals) / (10n ** BigInt(args.inputReference.decimals) * 10n ** 18n);
    executed += fill;
    grossOutput += output;
    const fee = (grossOutput * feePpm + 999_999n) / 1_000_000n;
    const net = grossOutput - fee;
    const inputUsd = exitRawUsd(executed, args.inputReference.decimals, args.inputReference.unitValueUsd);
    const actualUsd = exitRawUsd(net, args.outputReference.decimals, args.outputReference.unitValueUsd);
    const expectedUsd = exitRawUsd(net, args.outputReference.decimals, args.outputReference.expectedUnitValueUsd);
    const actualCost = Number(((inputUsd > actualUsd ? inputUsd - actualUsd : 0n) * 1_000_000n + inputUsd - 1n) / inputUsd) / 100;
    const executionCost = Number(((inputUsd > expectedUsd ? inputUsd - expectedUsd : 0n) * 1_000_000n + inputUsd - 1n) / inputUsd) / 100;
    if (actualCost <= args.maxCostBps && executed >= args.minimumRaw && grossOutput >= args.minimumOutputRaw) {
      accepted = executed; netOutput = net; acceptedGross = grossOutput;
      executionCostBps = executionCost; allInCostBps = actualCost;
    }
    if (executed === args.requestedRawInput) break;
  }
  const executableUsd = Number(accepted * 1_000_000_000n / args.requestedRawInput) / 1_000_000_000 * args.requestedNotionalUsd;
  return {
    requestedNotionalUsd: args.requestedNotionalUsd, maxCostBps: args.maxCostBps,
    requestedRawInput: args.requestedRawInput.toString(), executedRawInput: accepted.toString(), executableUsd,
    executionCostBps, allInCostBps,
    fees: [{ kind: "taker", rawUnits: (acceptedGross - netOutput).toString(), assetKey: args.outputReference.assetKey }],
    outputs: [{ ...args.outputReference, rawUnits: netOutput.toString() }],
    certification: accepted === args.requestedRawInput && args.exhaustive ? "exact-complete" : "exact-lower-bound",
    reason: accepted === 0n ? "observed-no-passing-bids" : null,
  };
}

/** Fetches real sell-side depth. Public books do not prove account/deposit/withdrawal gates. */
export async function observeKrakenExitBooks(args: {
  review: ExitExecutionModelReview;
  inputReference: ExitExecutionCertificate["inputReference"];
  outputReference: ExitExecutionCertificate["inputReference"];
  requests: readonly { requestedNotionalUsd: number; maxCostBps: number }[];
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}) {
  if (args.review.producer.kind !== "kraken") throw new Error("wrong-orderbook-model");
  const config = args.review.producer;
  const fetcher = args.fetcher ?? fetch;
  async function readApi(path: string) {
    const response = await fetcher(`https://api.kraken.com/0/public/${path}`, { signal: args.signal });
    const body = await readResponseTextWithinLimitWithSignal(response, DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES, args.signal);
    if (!response.ok) throw new Error(`kraken-http-${response.status}`);
    const parsed = z.object({ error: z.array(z.string()), result: z.record(z.string(), z.unknown()) }).parse(JSON.parse(body));
    if (parsed.error.length > 0) throw new Error(`kraken-api:${parsed.error.join(",")}`);
    return { result: parsed.result, digest: domainDigest("exit-kraken-response.v1", body) };
  }
  const before = await readApi("Time");
  const metadata = await readApi(`AssetPairs?pair=${encodeURIComponent(config.market)}`);
  const meta = z.object({ base: z.string(), quote: z.string(), lot_decimals: z.number().int(), ordermin: z.string(), costmin: z.string(), status: z.string(), fees: z.array(z.tuple([z.number(), z.number()])) }).parse(metadata.result[config.market]);
  if (meta.base !== config.base || meta.quote !== config.quote || meta.lot_decimals > config.inputDecimals) throw new Error("kraken-market-identity-mismatch");
  const depth = await readApi(`Depth?pair=${encodeURIComponent(config.market)}&count=500`);
  const after = await readApi("Time");
  const firstTime = z.number().int().parse(before.result.unixtime);
  const lastTime = z.number().int().parse(after.result.unixtime);
  if (lastTime < firstTime) throw new Error("kraken-clock-regressed");
  const book = KrakenBookSchema.parse(depth.result[config.market]);
  if (book.bids.some((level) => level[2] > lastTime) || book.asks.some((level) => level[2] > lastTime)) throw new Error("kraken-future-book-level");
  if (book.bids.length > 0 && book.asks.length > 0 && decimalToExitUnits(book.bids[0]![0], 18) >= decimalToExitUnits(book.asks[0]![0], 18)) throw new Error("kraken-crossed-book");
  let feeBps: number;
  if (meta.fees.length > 0) {
    feeBps = Math.max(...meta.fees.map((tier) => tier[1])) * 100;
  } else {
    if (!config.feeSchedule) throw new Error("kraken-applicable-fee-unavailable");
    const response = await fetcher(config.feeSchedule.url, { signal: args.signal });
    const text = await readResponseTextWithinLimitWithSignal(response, DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES, args.signal);
    if (!response.ok || sha256Hex(text) !== config.feeSchedule.contentSha256) throw new Error("kraken-fee-schedule-changed");
    feeBps = config.feeSchedule.applicableTakerFeeBps;
  }
  const points = args.requests.map((request) => walkExitBidBook({
    ...request, requestedRawInput: requestedExitRawInput(request.requestedNotionalUsd, args.inputReference.unitValueUsd, config.inputDecimals),
    bids: meta.status === "online" ? book.bids : [], inputReference: args.inputReference, outputReference: args.outputReference,
    takerFeeBps: feeBps, lotRaw: 10n ** BigInt(config.inputDecimals - meta.lot_decimals),
    minimumRaw: decimalToExitUnits(meta.ordermin, config.inputDecimals, true),
    minimumOutputRaw: decimalToExitUnits(meta.costmin, config.outputDecimals, true), exhaustive: false,
  }));
  // REST depth has neither an exhaustive guarantee nor an order-book sequence: always an observed prefix.
  return { points, source: { kind: "venue" as const, timestamp: firstTime, sequence: depth.digest, complete: false, truncated: true },
    marketOpen: meta.status === "online", responseHashes: [before.digest, metadata.digest, depth.digest, after.digest], feeBps };
}

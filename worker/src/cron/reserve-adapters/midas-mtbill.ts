import { z } from "zod";
import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters } from "viem/utils";
import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS } from "@shared/types/live-reserve-adapter-declarations";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC, resolveLiveReserveSourceAgeBudget } from "@shared/lib/live-reserve-freshness";
import { sha256HexFromBytes, sha256HexFromUtf8Chunks } from "@shared/lib/sha256";
import { stableJsonStringifyChunksV1 } from "@shared/lib/stable-json";
import { base64ToBytes, bytesToBase64 } from "@shared/lib/base64";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { fetchEvmBlockHeader, fetchEvmBlockNumber, type EvmBlockHeader } from "../../lib/evm-rpc";
import { throwIfAborted } from "../../lib/abort";
import { gunzipBytesBounded } from "../../lib/canonical-json-gzip";
import { getCache, setCache } from "../../lib/db-cache";
import type { AdapterContext, AdapterResult } from "./types";
import { verifiedFreshnessMetadata } from "./helpers";
import { fetchBinaryWithRetry, fetchJsonWithRetry } from "./request";
import { runAdapterIo } from "./concurrency";
import { fetchOnchainMulticall3 } from "./onchain";

// Reviewed publisher identities, not caller-injectable proof/URL parameters.
const REGISTRY = "0x2d6e9f608807436de5d9603b00abe3fed1bc809d";
const PROOF_ID = "0xf65e876f459439e78365c92eb3d47ff358d41b7bec69c9ffb9e624010fb47805";
const TOKEN = "0xdd629e5241cbc5919847783e6c96b2de4754e438";
const ORACLE = "0x056339c044055819e8db84e71f5f2e1f536b2e5b";
// Filebase leads: Pinata's public gateway is the most rate-limited from Workers egress.
const IPFS_GATEWAYS = [
  "https://ipfs.filebase.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
] as const;
const IPFS_GATEWAY_TIMEOUT_MS = 5_000;
// One D1 row holding the last root-verified checkpoint file. A CID's bytes are
// immutable, so a hit is re-verified against this run's registry root, never trusted.
const CHECKPOINT_FILE_CACHE_KEY = "midas-mtbill:save-checkpoint-file";
const CheckpointFileCacheSchema = z.object({ cid: z.string(), gzipBase64: z.string() }).strict();
const HISTORICAL_URL = "https://api-prod.midas.app/api/transparency/by-timestamp";
const COMPRESSED_CAP = 128 * 1024;
const DECOMPRESSED_CAP = 1024 * 1024;
const MILLION = 1_000_000;
const HOUR_MS = 3_600_000;
const exactBook = z.object({ wallet: z.number().finite().positive(), total: z.number().finite().positive() }).strict();
const ReportSchema = z.object({
  // Historical responses deliberately omit updatedAt; a latest packet is not this source.
  updatedAt: z.never().optional(),
  reports: z.object({
    main_positions: z.object({
      pv_usd: z.record(z.string(), z.number().finite().nonnegative()),
      delta_usd: z.record(z.string(), z.number().finite().nonnegative()),
    }),
    assets_by_protocol: z.object({
      assets: exactBook, equity: exactBook,
      protocol_type: z.object({ wallet: z.literal("custody"), total: z.null() }).strict(),
    }),
    assets_by_protocol_chain: z.object({ equity: z.object({
      "('wallet', 'ethereum')": z.number().finite().positive(),
      "('wallet', 'base')": z.number().finite().nonnegative(),
      "('total', '')": z.number().finite().positive(),
    }).strict() }),
    asset_values: z.object({ pv_usd: z.object({
      ethereum: z.number().finite().positive(), base: z.number().finite().nonnegative(),
      total: z.number().finite().positive(),
    }).strict() }),
  }),
});
// USTB and BUIDL are required; the operating USDC wallet row (first seen
// 2026-10-23) is a reviewed optional position. Any other tuple fails closed.
const HOLDINGS = [
  { tuple: "('USTB', 'CASH', 'wallet', 'ethereum', 'USTB')", sourceKey: "midas-mtbill:ustb", name: "Superstate Short Duration US Government Securities Fund (USTB)", coinId: "ustb-superstate", optional: false },
  { tuple: "('BUIDL', 'CASH', 'wallet', 'ethereum', 'BUIDL')", sourceKey: "midas-mtbill:buidl", name: "BlackRock USD Institutional Digital Liquidity Fund (BUIDL)", coinId: "buidl-blackrock", optional: false },
  { tuple: "('USDC', 'CASH', 'wallet', 'ethereum', 'USDC')", sourceKey: "midas-mtbill:usdc", name: "USDC (Circle)", coinId: "usdc-circle", optional: true },
] as const;
const CLAIM_IDS = ["ops_claim", "oracle_price", "oracle_price_usd", "overcollateralization", "overcollateralization_ratio", "onetoken_report", "onetoken_total_nav"] as const;
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const publicKey = z.string().regex(/^0x(?:02|03)[0-9a-fA-F]{64}$/);
const SaveSchema = z.object({
  metadata: z.object({
    schema: z.literal("save-v0"), version: z.literal("0.1.0"), proofId: z.literal(PROOF_ID),
    attestationId: z.string().uuid(), createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
    issuer: z.object({ name: z.literal("Midas"), identity: publicKey, publicKey }).strict(),
  }).strict(),
  // Retain all signed fields for canonical hashing, including diagnostic claims we do not consume.
  claims: z.array(z.object({ id: z.enum(CLAIM_IDS) }).passthrough()).length(CLAIM_IDS.length),
  signature: z.object({
    algorithm: z.literal("ECDSA_secp256k1"), publicKey,
    publicKeySource: z.literal("https://midas.app/public/attestation-engine/pubkeys.json"),
    signature: z.string().regex(/^0x[0-9a-fA-F]{128}$/), signedData: hex32,
  }).strict(),
}).strict();
const inlineObject = z.object({ claimType: z.literal("inline"), dataType: z.literal("object"), format: z.literal("json"), data: z.unknown() }).passthrough();
const OpsSchema = z.object({
  token: z.literal("mTBILL"), oracleAddress: z.string(), oracleChainSelectorName: z.literal("ethereum-mainnet"),
  priceUpdateChainId: z.literal(1), createdAt: z.string().datetime(),
}).passthrough();
const OracleSchema = z.object({ oracleAddress: z.string(), chainSelectorName: z.literal("ethereum-mainnet") }).passthrough();
const SignedBookSchema = z.object({
  _metadata: z.object({
    token: z.literal("mTBILL"), source: z.literal("1token"), timestamp: z.string(),
    anchorISO: z.string().datetime(), anchorRule: z.literal("ops_created_at_minus_3h"),
  }).strict(),
  assets: exactBook, equity: exactBook, liabilities: z.object({}).strict(),
}).strict();

function fail(reason: string): never {
  throw new Error(`midas-mtbill:${reason}`);
}

export class MidasIpfsGatewayError extends Error {
  readonly code = "save-ipfs-gateways-exhausted";

  constructor(readonly failures: readonly { gateway: string; detail: string }[]) {
    super(`midas-mtbill:save-ipfs-gateways-exhausted: ${failures.map(({ gateway, detail }) => `${gateway}: ${detail}`).join("; ")}`);
    this.name = "MidasIpfsGatewayError";
  }
}

function active(signal: AbortSignal, ctx?: AdapterContext): void {
  throwIfAborted(signal);
  if (ctx?.attemptDeadlineMs != null && Date.now() >= ctx.attemptDeadlineMs) fail("save-deadline-exceeded");
}

function canonicalDigest(value: unknown): string {
  return `0x${sha256HexFromUtf8Chunks(stableJsonStringifyChunksV1(value))}`;
}

function cidForDigest(digest: string): string {
  // CIDv0 multihash: sha2-256 code 0x12, 32-byte length 0x20, DAG-PB root digest.
  let value = BigInt(`0x1220${digest.slice(2)}`);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  return encoded;
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte | (value > 0 ? 128 : 0));
  } while (value > 0);
  return bytes;
}

function singleLeafRoot(file: Uint8Array): string {
  // Reviewed UnixFS File: Type=2, Data=file, filesize=file.length; no links,
  // mode, mtime or multiblock DAG. Hashing decoded gateway file bytes is WRONG.
  const size = varint(file.length);
  const unixfsLength = 2 + 1 + size.length + file.length + 1 + size.length;
  const prefix = [0x0a, ...varint(unixfsLength), 0x08, 0x02, 0x12, ...size];
  const node = new Uint8Array(prefix.length + file.length + 1 + size.length);
  node.set(prefix);
  node.set(file, prefix.length);
  node.set([0x18, ...size], prefix.length + file.length);
  return `0x${sha256HexFromBytes(node)}`;
}

function isVerifiedCheckpointFile(file: Uint8Array, hash: string): boolean {
  // Both digests are public IPFS/onchain commitments, not secrets.
  return file.length <= COMPRESSED_CAP && singleLeafRoot(file) === hash;
}

async function readCachedCheckpointFile(cid: string, hash: string, signal: AbortSignal, ctx?: AdapterContext): Promise<Uint8Array | null> {
  if (!ctx?.db) return null;
  let file: Uint8Array;
  try {
    const row = await getCache(ctx.db, CHECKPOINT_FILE_CACHE_KEY, signal);
    const cached = row ? CheckpointFileCacheSchema.safeParse(JSON.parse(row.value)) : null;
    if (!cached?.success || cached.data.cid !== cid) return null;
    file = base64ToBytes(cached.data.gzipBase64);
  } catch {
    // An unreadable or malformed cache row is a miss, never a failed attempt.
    active(signal, ctx);
    return null;
  }
  active(signal, ctx);
  return isVerifiedCheckpointFile(file, hash) ? file : null;
}

async function cacheCheckpointFile(cid: string, file: Uint8Array, signal: AbortSignal, ctx?: AdapterContext): Promise<void> {
  if (!ctx?.db) return;
  try {
    await setCache(ctx.db, CHECKPOINT_FILE_CACHE_KEY, JSON.stringify({ cid, gzipBase64: bytesToBase64(file) }), signal);
  } catch {
    // Best effort: an unwritten cache only costs the next run a gateway read.
  }
  active(signal, ctx);
}

async function readCheckpointFile(
  cid: string, hash: string, signal: AbortSignal, ctx?: AdapterContext,
): Promise<{ file: Uint8Array; source: string }> {
  const cached = await readCachedCheckpointFile(cid, hash, signal, ctx);
  if (cached) return { file: cached, source: "verified-d1-cache" };
  const failures: { gateway: string; detail: string }[] = [];
  // One bounded physical request per gateway; never spend the attempt on
  // same-host Retry-After/backoff. Each body settles before opening the next.
  for (const gateway of IPFS_GATEWAYS) {
    active(signal, ctx);
    const timeoutMs = Math.min(IPFS_GATEWAY_TIMEOUT_MS,
      ctx?.attemptDeadlineMs == null ? IPFS_GATEWAY_TIMEOUT_MS : ctx.attemptDeadlineMs - Date.now());
    const timeout = createTimeoutSignal({ timeoutMs, parentSignal: signal, timeoutReason: "midas-mtbill:save-ipfs-gateway-timeout" });
    try {
      const file = await fetchBinaryWithRetry(`${gateway}${cid}`, timeout.signal, timeoutMs, ctx, {
        maxResponseBytes: COMPRESSED_CAP, maxRetries: 0,
      });
      active(signal, ctx);
      if (file.length > COMPRESSED_CAP) fail("save-compressed-size");
      if (!isVerifiedCheckpointFile(file, hash)) fail("save-cid-layout-or-content-mismatch");
      await cacheCheckpointFile(cid, file, signal, ctx);
      return { file, source: gateway };
    } catch (error) {
      // Cancellation/deadline is not gateway exhaustion and must not admit a fallback.
      active(signal, ctx);
      failures.push({ gateway, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      timeout.dispose();
    }
  }
  throw new MidasIpfsGatewayError(failures);
}

async function readMidasMtbillCheckpoint(signal: AbortSignal, ctx?: AdapterContext): Promise<RegistryCheckpoint> {
  active(signal, ctx);
  const rpcOptions = { signal, chainRpcs: ctx?.chainRpcs, timeoutMs: 5_000 };
  const pin = await runAdapterIo(ctx, "midas-save-pin", async () => {
    const number = ctx?.observedBlock?.chain === "ethereum" ? ctx.observedBlock.number : await fetchEvmBlockNumber("ethereum", rpcOptions);
    if (number == null) fail("save-pin-unavailable");
    active(signal, ctx);
    const header = await fetchEvmBlockHeader("ethereum", number, rpcOptions);
    if (!header || header.number !== number || /^0x0+$/.test(header.hash)) fail("save-pin-unavailable");
    return header;
  });
  active(signal, ctx);
  const selectors = ["0xd4252bc2", "0x4a94a399", "0x3d503569", "0xd938d202"] as const;
  const responses = await fetchOnchainMulticall3({
    chain: "ethereum", signal, ctx, timeoutMs: 5_000, blockNumberOrTag: pin.number,
    calls: selectors.map((selector) => ({ label: selector, contract: REGISTRY, data: `${selector}${PROOF_ID.slice(2)}`, allowFailure: false })),
  });
  if (!responses || responses.length !== selectors.length || responses.some((response, i) => !response.success || response.label !== selectors[i])) fail("save-registry-unavailable");
  const latestAbi = parseAbiParameters("bytes32, address, uint48");
  const addressAbi = parseAbiParameters("address");
  const nameAbi = parseAbiParameters("string");
  const existsAbi = parseAbiParameters("bool");
  const decoded = (() => {
    try {
      const latest = decodeAbiParameters(latestAbi, responses[0].returnData);
      const authorized = decodeAbiParameters(addressAbi, responses[1].returnData);
      const name = decodeAbiParameters(nameAbi, responses[2].returnData);
      const exists = decodeAbiParameters(existsAbi, responses[3].returnData);
      const encodings = [encodeAbiParameters(latestAbi, latest), encodeAbiParameters(addressAbi, authorized), encodeAbiParameters(nameAbi, name), encodeAbiParameters(existsAbi, exists)];
      if (encodings.some((encoding, i) => encoding.toLowerCase() !== responses[i].returnData.toLowerCase())) fail("save-registry-malformed");
      return { hash: latest[0].toLowerCase(), publisher: latest[1].toLowerCase(), publishedAt: Number(latest[2]), authorized: authorized[0].toLowerCase(), name: name[0], exists: exists[0] };
    } catch {
      fail("save-registry-malformed");
    }
  })();
  if (!decoded.exists || decoded.name !== "mtbill-por") fail("save-proof-identity");
  if (/^0x0+$/.test(decoded.hash)) fail("save-zero-hash");
  if (/^0x0+$/.test(decoded.publisher) || decoded.publisher !== decoded.authorized) fail("save-unauthorized-publisher");
  if (decoded.publishedAt <= 0 || decoded.publishedAt > pin.timestamp) fail("save-publication-clock");
  active(signal, ctx);
  const cid = cidForDigest(decoded.hash);
  const { file, source: fileSource } = await readCheckpointFile(cid, decoded.hash, signal, ctx);
  active(signal, ctx);
  if (file[0] !== 0x1f || file[1] !== 0x8b || file[2] !== 8) fail("save-unsupported-compression");
  let payload: unknown;
  let jsonDigest: string;
  try {
    const bytes = await gunzipBytesBounded(file, {
      label: "midas-mtbill:save-document", maximumCompressedBytes: COMPRESSED_CAP,
      maximumUncompressedBytes: DECOMPRESSED_CAP, signal,
    });
    active(signal, ctx);
    jsonDigest = `0x${sha256HexFromBytes(bytes)}`;
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (error) {
    active(signal, ctx);
    throw new Error(`midas-mtbill:save-decompression-or-document-invalid: ${error instanceof Error ? error.message : "invalid payload"}`);
  }
  return { ...decoded, cid, pin, payload, jsonDigest, compressedBytes: file.length, fileSource };
}

interface RegistryCheckpoint {
  hash: string;
  publisher: string;
  publishedAt: number;
  authorized: string;
  name: string;
  exists: boolean;
  cid: string;
  pin: EvmBlockHeader;
  payload: unknown;
  jsonDigest: string;
  compressedBytes: number;
  fileSource: string;
}

function decodeMidasMtbillCheckpoint(registry: RegistryCheckpoint, nowSec: number, maxAgeSec: number): AuthenticatedCheckpoint {
  const parsed = SaveSchema.safeParse(registry.payload);
  if (!parsed.success) fail("save-document-schema");
  const doc = parsed.data;
  if (new Set(doc.claims.map(({ id }) => id)).size !== CLAIM_IDS.length) fail("save-duplicate-claim");
  if (doc.metadata.issuer.publicKey !== doc.signature.publicKey || doc.metadata.issuer.identity !== doc.signature.publicKey) fail("save-key-identity");
  // Authorized registry publication authenticates the bytes. This checks the
  // declared signed-content digest, not external key-list or financial assurance.
  if (canonicalDigest({ metadata: doc.metadata, claims: doc.claims }) !== doc.signature.signedData) fail("save-signed-content-digest");
  const claim = (id: typeof CLAIM_IDS[number]) => doc.claims.find((row) => row.id === id)!;
  const objectData = (id: typeof CLAIM_IDS[number]) => {
    const row = inlineObject.safeParse(claim(id));
    if (!row.success) fail("save-claim-schema");
    return row.data.data;
  };
  const ops = OpsSchema.safeParse(objectData("ops_claim"));
  const oracle = OracleSchema.safeParse(objectData("oracle_price"));
  const signed = SignedBookSchema.safeParse(objectData("onetoken_report"));
  if (!ops.success || !oracle.success || !signed.success) fail("save-token-or-book-identity");
  if (ops.data.oracleAddress.toLowerCase() !== ORACLE || oracle.data.oracleAddress.toLowerCase() !== ORACLE) fail("save-oracle-identity");
  for (const [id, pointer] of [["oracle_price_usd", "oracle_price#/priceRaw"], ["overcollateralization_ratio", "overcollateralization#/ratio"], ["onetoken_total_nav", "onetoken_report#/equity/total"]] as const) {
    const row = claim(id);
    if (row.claimType !== "source-backed" || row.dataType !== "numeric" || row.pointer !== pointer || typeof row.resolvedValue !== "number" || !Number.isFinite(row.resolvedValue)) fail("save-claim-schema");
  }
  objectData("overcollateralization"); // Diagnostic only; never emit its ratio or supply.
  if (claim("onetoken_total_nav").resolvedValue !== signed.data.equity.total) fail("save-signed-total-mismatch");
  const meta = signed.data._metadata;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(meta.timestamp)) fail("save-checkpoint-clock");
  const checkpointMs = Date.parse(`${meta.timestamp}:00Z`);
  if (!Number.isFinite(checkpointMs) || new Date(checkpointMs).toISOString().slice(0, 16) !== meta.timestamp) fail("save-checkpoint-clock");
  const sourceTimestamp = checkpointMs / 1000;
  const ageSec = nowSec - sourceTimestamp;
  if (sourceTimestamp <= 0 || sourceTimestamp > nowSec + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) fail("future-save-checkpoint");
  if (ageSec > maxAgeSec) throw new Error(`midas-mtbill:stale-save-checkpoint sourceTimestamp=${sourceTimestamp} nowSec=${nowSec} ageSec=${ageSec} maxAgeSec=${maxAgeSec}`);
  const anchorMs = Date.parse(meta.anchorISO);
  const opsMs = Date.parse(ops.data.createdAt);
  const createdMs = Date.parse(doc.metadata.createdAt);
  const expiresMs = Date.parse(doc.metadata.expiresAt);
  if (anchorMs !== opsMs - 3 * HOUR_MS || Math.floor(anchorMs / HOUR_MS) * HOUR_MS !== checkpointMs
    || createdMs < opsMs || createdMs > registry.publishedAt * 1000
    || registry.pin.timestamp > nowSec + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC
    || expiresMs <= createdMs) fail("save-anchor-chronology");
  if (expiresMs <= nowSec * 1000) fail("save-document-expired");
  return { sourceTimestamp, timestamp: meta.timestamp, anchorISO: meta.anchorISO, opsCreatedAt: ops.data.createdAt,
    createdAt: doc.metadata.createdAt, expiresAt: doc.metadata.expiresAt, attestationId: doc.metadata.attestationId,
    signedData: doc.signature.signedData, book: signed.data };
}

interface AuthenticatedCheckpoint {
  sourceTimestamp: number;
  timestamp: string;
  anchorISO: string;
  opsCreatedAt: string;
  createdAt: string;
  expiresAt: string;
  attestationId: string;
  signedData: string;
  book: z.infer<typeof SignedBookSchema>;
}

function adaptMidasMtbillPortfolio(payload: unknown, checkpoint: AuthenticatedCheckpoint): AdapterResult {
  const parsed = ReportSchema.safeParse(payload);
  if (!parsed.success) fail("save-historical-scope");
  const { reports } = parsed.data;
  const { pv_usd: positions, delta_usd: deltas } = reports.main_positions;
  const held = HOLDINGS.filter(({ tuple }) => positions[tuple] != null);
  if (Object.keys(positions).length !== held.length || Object.keys(deltas).length !== held.length
    || HOLDINGS.some(({ tuple, optional }) => !optional && positions[tuple] == null)
    || held.some(({ tuple }) => positions[tuple] <= 0 || positions[tuple] !== deltas[tuple])) fail("save-position-scope");
  const totalMillions = reports.assets_by_protocol.equity.total;
  const exactTotals = [
    reports.assets_by_protocol.assets.total, reports.assets_by_protocol.assets.wallet,
    reports.assets_by_protocol.equity.wallet, reports.assets_by_protocol_chain.equity["('total', '')"],
    checkpoint.book.assets.total, checkpoint.book.assets.wallet, checkpoint.book.equity.total, checkpoint.book.equity.wallet,
  ];
  if (exactTotals.some((value) => Math.abs(value - totalMillions) * MILLION > 0.01)) fail("save-exact-totals-mismatch");
  const eth = reports.assets_by_protocol_chain.equity["('wallet', 'ethereum')"];
  const base = reports.assets_by_protocol_chain.equity["('wallet', 'base')"];
  const roundedPairs = [[eth, reports.asset_values.pv_usd.ethereum], [base, reports.asset_values.pv_usd.base], [reports.asset_values.pv_usd.total, totalMillions]];
  if (roundedPairs.some(([rounded, exact]) => Math.abs(rounded - exact) * MILLION > 1_000)) fail("save-rounded-totals-mismatch");
  const totalReserveUsd = totalMillions * MILLION;
  const namedTotalUsd = held.reduce((sum, holding) => sum + positions[holding.tuple] * MILLION, 0);
  const residualUsd = totalReserveUsd - namedTotalUsd;
  const chainGapUsd = (totalMillions - eth - base) * MILLION;
  // Chain gaps and Base are contained ONCE in the full named-position remainder.
  // Rounded named Ethereum positions may straddle their exact chain amount by $1k.
  if (!Number.isFinite(residualUsd) || residualUsd < 0 || chainGapUsd < 0 || chainGapUsd > residualUsd
    || namedTotalUsd - eth * MILLION > 1_000 || base * MILLION > residualUsd) fail("save-residual-scope");
  return {
    slices: [
      ...held.map((holding) => ({
        sourceKey: holding.sourceKey, name: holding.name,
        pct: positions[holding.tuple] * MILLION / totalReserveUsd * 100,
        risk: "low" as const, coinId: holding.coinId, depType: "collateral" as const,
      })),
      ...(residualUsd > 0 ? [{ sourceKey: "midas-mtbill:unclassified-residual", name: "Unclassified portfolio residual and position rounding",
        pct: residualUsd / totalReserveUsd * 100, risk: "high" as const,
        unclassifiedResidual: true as const, residualReason: "insufficient-evidence" as const }] : []),
    ],
    metadata: {
      ...verifiedFreshnessMetadata(checkpoint.sourceTimestamp), totalReserveUsd,
      unknownExposurePct: residualUsd / totalReserveUsd * 100,
      details: {
        compositionEvidence: "issuer-reported-portfolio-with-registry-checkpoint",
        portfolioScope: "mTBILL unleveraged Ethereum and Base wallet portfolio",
        signedCheckpoint: checkpoint.timestamp, anchorISO: checkpoint.anchorISO,
        opsCreatedAt: checkpoint.opsCreatedAt, documentCreatedAt: checkpoint.createdAt, documentExpiresAt: checkpoint.expiresAt,
        attestationId: checkpoint.attestationId, signedData: checkpoint.signedData,
        sourceAmountUnit: "USD millions", positionPrecisionUsd: 1_000, mainPositionDisplayCutoffUsd: 100_000,
        signedExactTotalUsd: checkpoint.book.equity.total * MILLION, historicalExactTotalUsd: totalReserveUsd,
        namedTotalUsd, residualUsd, ethereumWalletUsd: eth * MILLION, baseWalletUsd: base * MILLION, chainGapUsd,
        residualDescription: "Complete named-position remainder includes chain gaps and rounding; no asset or custody identity inferred",
        evidenceBoundary: "Authorized issuer registry publication commits checkpoint and aggregate; historical API composition rows are not signed. No independent financial assurance, custody allocation, liability census or redemption capacity.",
      },
    },
  };
}

export async function fetchMidasMtbillReserves(
  coin: ReserveAdapterCoin, config: LiveReservesConfig, signal: AbortSignal, ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = config.inputs.primary;
  if (coin.id !== "mtbill-midas" || config.version !== 2 || input.kind !== "onchain-evm" || input.chain !== "ethereum"
    || input.rpcMode !== "public-rpc" || (config.params != null && Object.keys(config.params).length > 0)
    || !coin.contracts?.some(({ chain, address }) => chain === "ethereum" && address.toLowerCase() === TOKEN)) fail("save-config-identity");
  const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
  const { sourceAgeBudgetSec } = resolveLiveReserveSourceAgeBudget(config.scoring?.maxSourceAgeSec,
    LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS["midas-mtbill"].validation.maxSourceAgeSec, 172_800);
  const registry = await readMidasMtbillCheckpoint(signal, ctx);
  active(signal, ctx);
  const checkpoint = decodeMidasMtbillCheckpoint(registry, nowSec, sourceAgeBudgetSec);
  const url = `${HISTORICAL_URL}?token=mTBILL&timestamp=${encodeURIComponent(checkpoint.timestamp)}`;
  const historical = await fetchJsonWithRetry<unknown>(url, signal, 5_000, ctx, { maxResponseBytes: DECOMPRESSED_CAP, redirect: "manual" });
  active(signal, ctx);
  const result = adaptMidasMtbillPortfolio(historical, checkpoint);
  const recheck = await runAdapterIo(ctx, "midas-save-pin-recheck", () => fetchEvmBlockHeader("ethereum", registry.pin.number, { signal, chainRpcs: ctx?.chainRpcs, timeoutMs: 5_000 }));
  active(signal, ctx);
  if (!recheck || recheck.hash !== registry.pin.hash || recheck.timestamp !== registry.pin.timestamp) fail("save-pin-changed");
  return { ...result, metadata: { ...result.metadata, details: {
    ...result.metadata?.details,
    registryChain: "ethereum", registryAddress: REGISTRY, proofId: PROOF_ID, tokenAddress: TOKEN,
    pinNumber: registry.pin.number, pinHash: registry.pin.hash, pinTimestamp: registry.pin.timestamp,
    authorizedPublisher: registry.authorized, attestationHash: registry.hash, attestationCid: registry.cid,
    registryPublishedAt: registry.publishedAt, documentJsonSha256: registry.jsonDigest, compressedBytes: registry.compressedBytes,
    attestationFileSource: registry.fileSource,
    historicalUrl: url, historicalResponseCanonicalSha256: canonicalDigest(historical),
    publisherAuthentication: "authorized-registry-publication", signatureValidation: "canonical-signed-content-digest",
  } } };
}
